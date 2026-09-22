import { ActionRuntime } from './actions.js';
import { AgentError, candidateSnapshot, defaultId, jsonCopy, positive, sameScope, selectionKey } from './common.js';
import { EvidenceLedger } from './evidence.js';
import { ChannelRuntime } from './channels.js';
import type { ChannelEvent } from './channels.js';
import { ObservationStore } from './observations.js';
import type { ObservationFrame } from './observations.js';
import { ResourceArbiter } from './resources.js';
import { ModelSlot, RequestBudget } from './scheduler.js';
import { Telemetry } from './telemetry.js';
import type { TimingSample } from './telemetry.js';
import type { ActionReceipt, AgentEnvironment, AgentEvent, AgentPolicies, ConversationContext, DecisionContext, DecisionPolicy, DecisionResult, GroundingClaim, ProposalRecord, Scope, SlowThinker, Turn } from './types.js';

export interface AgentOptions<C> {
  environment: AgentEnvironment<C>;
  fast: DecisionPolicy;
  slow?: SlowThinker;
  policies?: AgentPolicies;
  epoch?: string;
  now?: () => number;
  id?: () => string;
  decisionIntervalMs?: number;
  idleIntervalMs?: number;
  thoughtIntervalMs?: number;
  thoughtTimeoutMs?: number;
  proposalTtlMs?: number;
  maxExecutionSeconds?: number;
  monotonicNow?: () => number;
  decisionTimeoutMs?: number;
  maxDecisionsPerMinute?: number;
  resources?: ResourceArbiter;
  /** Legacy body holds while hearing by default; device/game hosts may keep compatible local control running. */
  holdBodyWhileHearing?: boolean;
}

/** Host-driven time, one decision slot and one thought slot, shared by every input channel. */
export class Agent<C> {
  readonly actions: ActionRuntime<C>;
  readonly outputs: ActionRuntime<C>;
  readonly channels: ChannelRuntime<C>;
  readonly observations: ObservationStore;
  readonly telemetry = new Telemetry();
  private evidence: EvidenceLedger;
  private listeners = new Set<(event: AgentEvent) => void>();
  private now: () => number;
  private id: () => string;
  private epoch: string;
  private revision = 0;
  private generation = 0;
  private turn: Turn | null = null;
  private turns: Turn[] = [];
  private proposal: ProposalRecord | null = null;
  private proposalExpiresAt = -Infinity;
  private fastController: AbortController | null = null;
  private slowController: AbortController | null = null;
  private lastDecisionAt = -Infinity;
  private lastThoughtAt = -Infinity;
  private retryAt = 0;
  private failures = 0;
  private observeAt = 0;
  private dirty = true;
  private paused = false;
  private hearing = false;
  private awaitingDecision = false;
  private disposed = false;
  private error: { code: string; message: string } | null = null;
  private decisionInterval: number;
  private idleInterval: number;
  private thoughtInterval: number;
  private thoughtTimeout: number;
  private proposalTtl: number;
  private environmentVersion: string | number | undefined;
  private clock: () => number;
  private queuedAt: number;
  private budget: RequestBudget;
  private fastSlot = new ModelSlot();
  private slowSlot = new ModelSlot();
  private decisionTimeout: number;
  private executionClocks = new Map<string, number>();

  constructor(private options: AgentOptions<C>) {
    this.now = options.now ?? Date.now; this.id = options.id ?? defaultId; this.epoch = options.epoch ?? this.id();
    this.clock = options.monotonicNow ?? options.now ?? (() => performance.now()); this.queuedAt = this.clock();
    this.decisionInterval = positive(options.decisionIntervalMs ?? 1000, 'decisionIntervalMs');
    this.idleInterval = positive(options.idleIntervalMs ?? 5000, 'idleIntervalMs');
    this.thoughtInterval = positive(options.thoughtIntervalMs ?? 15000, 'thoughtIntervalMs');
    this.thoughtTimeout = positive(options.thoughtTimeoutMs ?? 35000, 'thoughtTimeoutMs');
    this.proposalTtl = positive(options.proposalTtlMs ?? 60000, 'proposalTtlMs');
    this.decisionTimeout = positive(options.decisionTimeoutMs ?? 10000, 'decisionTimeoutMs');
    this.budget = new RequestBudget({ intervalMs: this.decisionInterval, maxPerMinute: options.maxDecisionsPerMinute });
    const arbiter = options.resources ?? new ResourceArbiter();
    this.actions = new ActionRuntime({ capabilities: options.environment.capabilities, now: this.now, id: this.id,
      maxExecutionSeconds: options.maxExecutionSeconds, arbiter });
    this.outputs = new ActionRuntime({ capabilities: options.environment.output?.capabilities ?? [], now: this.now, id: this.id, maxExecutionSeconds: options.maxExecutionSeconds, arbiter });
    this.observations = new ObservationStore({ now: this.now, monotonicNow: this.clock });
    this.channels = new ChannelRuntime({ definitions: options.environment.channels ?? [], arbiter, now: this.now,
      monotonicNow: this.clock, id: this.id, currentScope: () => this.scope, onChange: event => this.channelChanged(event) });
    this.evidence = new EvidenceLedger({ now: this.now, id: this.id });
    this.adoptEnvironmentVersion();
  }

  get scope(): Scope { return { epoch: this.epoch, turnId: this.turn?.id ?? null, revision: this.revision }; }
  private executionScope(): Scope { return { ...this.scope, turnId: this.turn && !this.turn.completed ? this.turn.id : null }; }
  snapshot() {
    const budget = this.budget.snapshot(this.clock()), nextDecisionAt = this.now() + budget.nextInMs;
    return structuredClone({ scope: this.scope, turn: this.turn, previousTurns: this.turns, proposal: this.proposal,
      action: this.actions.current, receipts: this.actions.history, output: this.outputs.current, outputReceipts: this.outputs.history, paused: this.paused, hearing: this.hearing,
      attending: this.hearing || this.awaitingDecision, pending: this.dirty,
      deciding: !!this.fastController && !this.fastController.signal.aborted, thinking: !!this.slowController && !this.slowController.signal.aborted,
      decisionBusy: this.fastController !== null || this.fastSlot.busy, thoughtBusy: this.slowController !== null || this.slowSlot.busy, disposed: this.disposed,
      error: this.error, retryAt: budget.retryInMs > 0 ? this.now() + budget.retryInMs : null,
      lastDecisionAt: Number.isFinite(this.lastDecisionAt) ? this.lastDecisionAt : null,
      nextDecisionAt: Number.isFinite(nextDecisionAt) ? nextDecisionAt : null,
      channels: this.channels.snapshot(), observations: this.observations.snapshot(), budget });
  }
  subscribe(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: AgentEvent) {
    for (const listener of this.listeners) {
      // Observability failures must not turn committed world effects into a second execution.
      try { listener(structuredClone(event)); } catch { /* The host owns logging/persistence failures. */ }
    }
  }
  private assertOpen() { if (this.disposed) throw new AgentError('disposed', 'This Agent has been disposed.'); }
  private cancelRequests() { this.generation++; this.fastController?.abort(); this.slowController?.abort(); this.fastSlot.cancel(); this.slowSlot.cancel(); }
  private markDirty() { if (!this.dirty) this.queuedAt = this.clock(); this.dirty = true; }
  private changed() { this.revision++; this.markDirty(); this.evidence.clear(); }
  private timing(sample: TimingSample) { this.telemetry.record(sample); this.emit({ type: 'timing', sample }); }
  private executionTiming(receipt: ActionReceipt, stage: 'execution' | 'output', outcome: 'started' | 'completed' | 'failed' | 'cancelled') {
    const clock = this.clock();
    if (outcome === 'started') this.executionClocks.set(receipt.id, clock);
    const started = this.executionClocks.get(receipt.id);
    if (outcome !== 'started') this.executionClocks.delete(receipt.id);
    this.timing({ scope: receipt.scope, stage, at: this.now(), executionId: receipt.id, outcome,
      ...(outcome !== 'started' && started !== undefined ? { durationMs: Math.max(0, clock - started) } : {}) });
  }
  private channelChanged(event: ChannelEvent) {
    const definition = this.options.environment.channels?.find(channel => channel.id === event.channel);
    if (event.terminal && definition?.blocksCompletion !== false) this.changed();
    if (event.terminal || event.receipt.status === 'dispatched' || event.receipt.status === 'unknown') this.timing({
      scope: event.receipt.scope, stage: 'execution', at: this.now(), executionId: event.receipt.id,
      outcome: event.terminal ? event.receipt.status as 'completed' | 'failed' | 'cancelled' : event.receipt.status === 'unknown' ? 'unknown' : 'started',
      ...(event.terminal && 'operationId' in event.receipt ? { durationMs: event.receipt.elapsedSeconds * 1000 } : {}),
    });
    this.emit({ type: 'channel-progress', ...event }); this.notify();
  }
  observe(frame: ObservationFrame, options: { wake?: boolean } = {}): boolean {
    this.assertOpen();
    if (!this.observations.ingest(frame)) return false;
    if (options.wake !== false) this.markDirty();
    const observed = this.observations.snapshot().find(item => item.id === frame.id)!;
    this.timing({ scope: this.scope, stage: 'observation', at: this.now(), outcome: 'received',
      ...(observed.ageMs === null ? {} : { observationAgeMs: observed.ageMs }) });
    this.notify(); return true;
  }
  react(channel: string, candidateId: string): void {
    this.assertOpen();
    if (this.paused) return;
    this.channels.react(channel, candidateId, this.scope, this.options.environment.context());
  }
  stop(): void {
    this.assertOpen(); this.cancelRequests(); this.proposal = null;
    this.paused = true;
    try { this.cancelExecutions('stopped'); }
    finally { this.changed(); this.notify(); }
  }
  private cancelExecutions(reason: string): void {
    let failure: unknown;
    for (const cancel of [() => this.cancelOutput(reason), () => {
      const ended = this.actions.cancel(this.options.environment.context(), reason);
      if (ended) this.executionTiming(ended, 'execution', 'cancelled');
    }, () => this.channels.cancel(this.options.environment.context(), reason)]) {
      try { cancel(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  private notify() { this.emit({ type: 'changed', scope: this.scope }); }
  private adoptEnvironmentVersion() { this.environmentVersion = this.options.environment.revision?.(this.options.environment.context()); }
  private syncEnvironment() {
    const version = this.options.environment.revision?.(this.options.environment.context());
    if (version !== this.environmentVersion) { this.environmentVersion = version; this.fastController?.abort(); this.fastSlot.cancel(); this.changed(); }
  }
  /** Request a fresh decision without cancelling a compatible in-flight thought. */
  wake(): void { this.assertOpen(); this.markDirty(); this.emit({ type: 'wake', scope: this.scope }); }
  receive(text: string): Turn {
    this.assertOpen();
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new AgentError('invalid_input', 'Input must contain 1–8000 characters.');
    this.queuedAt = this.clock();
    this.actions.hold();
    this.cancelRequests(); this.cancelOutput('new-input');
    this.channels.input(this.options.environment.context());
    if (this.turn) this.turns = [...this.turns, this.turn].slice(-16);
    this.turn = { id: this.id(), text: text.trim(), receivedAt: this.now(), completed: false };
    this.proposal = null; this.error = null; this.hearing = false; this.awaitingDecision = true; this.lastThoughtAt = -Infinity;
    this.actions.hold(); this.changed(); this.adoptEnvironmentVersion(); this.notify();
    this.timing({ scope: this.scope, stage: 'input', at: this.now(), outcome: 'received' });
    return structuredClone(this.turn);
  }
  holdInput(): void { this.assertOpen(); this.cancelRequests(); this.cancelOutput('speech-start'); this.hearing = true;
    if (this.options.holdBodyWhileHearing !== false) this.actions.hold(); this.changed(); this.notify(); }
  releaseInput(): void { this.assertOpen(); this.hearing = false; this.changed(); this.notify(); }
  invalidate(): void { this.assertOpen(); this.fastController?.abort(); this.fastSlot.cancel(); this.changed(); this.notify(); }
  /** Reconfigure a conversation channel without cancelling an accepted physical activity. */
  cancelReasoning(): void {
    this.assertOpen(); this.cancelRequests(); this.proposal = null; this.hearing = false; this.awaitingDecision = false;
    this.cancelOutput('channel-changed'); this.actions.hold();
    this.changed(); this.notify();
  }
  interruptReply(epoch: string, turnId: string): boolean {
    this.assertOpen();
    if (epoch !== this.epoch || turnId !== this.turn?.id) return false;
    if (this.turn.replySuppressed) return true;
    this.turn.replySuppressed = true; this.cancelRequests(); this.cancelOutput('interrupted'); this.proposal = null; this.changed(); this.notify(); return true;
  }
  markReplyDelivered(epoch: string, turnId: string): boolean {
    this.assertOpen();
    if (epoch !== this.epoch || turnId !== this.turn?.id || this.turn.replySuppressed || this.hearing) return false;
    this.turn.replyDelivered = true; this.changed(); this.notify(); return true;
  }
  forgetTurns(ids: ReadonlySet<string>): void {
    this.assertOpen(); this.cancelRequests(); this.cancelOutput('forgotten'); this.proposal = null;
    this.turns = this.turns.filter(turn => !ids.has(turn.id));
    if (this.turn && ids.has(this.turn.id)) this.turn = null;
    this.awaitingDecision = false; this.changed(); this.notify();
  }
  pause(value = true): void {
    this.assertOpen();
    if (this.paused === value) return;
    this.cancelRequests(); if (value) this.cancelOutput('paused'); this.paused = value; this.actions.hold(); this.changed(); this.notify();
    if (value) this.channels.cancel(this.options.environment.context(), 'paused');
  }
  reset(): void {
    this.assertOpen(); this.cancelRequests(); this.paused = true;
    try {
      this.cancelExecutions('reset');
      this.channels.reset(this.options.environment.context());
      this.outputs.reset(this.options.environment.context()); this.actions.reset(this.options.environment.context());
    } catch (error) { this.changed(); this.notify(); throw error; }
    this.epoch = this.id(); this.revision = 0; this.turn = null; this.turns = []; this.proposal = null;
    this.hearing = false; this.awaitingDecision = false; this.paused = false; this.dirty = true; this.error = null; this.observeAt = 0;
    this.lastThoughtAt = -Infinity; this.queuedAt = this.clock(); this.executionClocks.clear();
    this.evidence.clear(); this.observations.clear(); this.telemetry.clear(); this.adoptEnvironmentVersion(); this.notify();
    // Provider start spacing and Retry-After survive resets.
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.paused = true; this.cancelRequests();
    try { this.cancelExecutions('disposed'); }
    finally { this.evidence.clear(); this.notify(); this.listeners.clear(); }
  }
  cancelOutput(reason = 'cancelled'): void {
    const ended = this.outputs.cancel(this.options.environment.context(), reason);
    if (ended) { this.executionTiming(ended, 'output', 'cancelled'); this.changed(); this.emit({ type: 'output-ended', receipt: ended, at: this.now() }); this.notify(); }
  }
  tick(seconds: number): void {
    this.assertOpen(); this.syncEnvironment();
    if (!Number.isFinite(seconds) || seconds < 0) throw new AgentError('invalid_delta', 'seconds must be finite and nonnegative.');
    this.channels.tick(this.options.environment.context(), seconds, this.paused, this.hearing);
    if (this.paused || this.hearing && this.options.holdBodyWhileHearing !== false) return;
    if (seconds > 0 && this.actions.current?.status === 'running') this.evidence.clear();
    const output = this.outputs.tick(this.options.environment.context(), seconds);
    if (output) { this.executionTiming(output, 'output', output.status as 'completed' | 'failed'); this.changed(); this.emit({ type: 'output-ended', receipt: output, at: this.now() }); this.adoptEnvironmentVersion(); this.notify(); }
    const ended = this.actions.tick(this.options.environment.context(), seconds);
    if (ended) {
      this.executionTiming(ended, 'execution', ended.status as 'completed' | 'failed');
      if (ended.status === 'failed') this.error = { code: ended.reason ?? 'execution_failed', message: 'The action could not be completed.' };
      this.changed(); this.emit({ type: 'action-ended', receipt: ended, at: this.now() }); this.adoptEnvironmentVersion(); this.notify();
    }
  }
  private context(): DecisionContext {
    const environment = this.options.environment, context = environment.context();
    return { scope: this.scope, input: this.turn && structuredClone(this.turn), previousTurns: structuredClone(this.turns),
      observation: jsonCopy(environment.observe(context)), candidates: candidateSnapshot(environment.candidates(context)),
      currentAction: this.actions.current, receipts: this.actions.history,
      outputCandidates: environment.output ? candidateSnapshot(environment.output.candidates(context)) : [], currentOutput: this.outputs.current, outputReceipts: this.outputs.history, proposal: structuredClone(this.proposal),
      thinking: this.slowController !== null || this.slowSlot.busy, slowThinkingAvailable: !!this.options.slow,
      channels: this.channels.context(context), observations: this.observations.snapshot() };
  }
  private validateDecision(result: DecisionResult, evaluated: DecisionContext): void {
    const environment = this.options.environment, state = environment.context();
    this.channels.validate(result.channels ?? {}, evaluated.channels ?? {}, state);
    const key = selectionKey(result.selection);
    if (!evaluated.candidates.some(candidate => selectionKey(candidate.selection) === key)
      || !candidateSnapshot(environment.candidates(state)).some(candidate => selectionKey(candidate.selection) === key)) {
      throw new AgentError('stale_candidate', 'The selected action is no longer available.', 0);
    }
    const checked = [evaluated.candidates.find(candidate => selectionKey(candidate.selection) === key),
      ...(result.output ? [evaluated.outputCandidates?.find(candidate => selectionKey(candidate.selection) === selectionKey(result.output!))] : []),
      ...Object.entries(result.channels ?? {}).map(([name, selection]) => evaluated.channels?.[name]?.candidates.find(candidate => selectionKey(candidate.selection) === selectionKey(selection)))];
    if (checked.some(candidate => candidate?.observations?.some(reference => !this.observations.current(reference)))) {
      throw new AgentError('stale_observation', 'The selected action depends on stale sensor evidence.', 0);
    }
    if (result.output) {
      const outputKey = selectionKey(result.output);
      const outputs = environment.output ? candidateSnapshot(environment.output.candidates(state)) : [];
      if (!evaluated.outputCandidates?.some(c => selectionKey(c.selection) === outputKey) || !outputs.some(c => selectionKey(c.selection) === outputKey)) {
        throw new AgentError('stale_output_candidate', 'The selected output action is no longer available.', 0);
      }
    }
  }
  async decide(): Promise<boolean> {
    this.assertOpen(); this.syncEnvironment();
    const now = this.now(), started = this.clock();
    if (this.paused || this.hearing || this.fastController || this.fastSlot.busy || started < this.budget.next(started)) return false;
    if (this.proposal && started >= this.proposalExpiresAt) {
      const proposal = this.proposal; this.proposal = null; this.changed(); this.emit({ type: 'proposal-expired', proposal, at: now });
    }
    if (!this.dirty && (this.actions.current || this.outputs.current || this.channels.blocking || this.slowController || this.slowSlot.busy || started < this.observeAt)) return false;
    if (!this.budget.start(started)) return false;
    const queued = this.dirty ? Math.max(0, started - this.queuedAt) : 0;
    const controller = new AbortController(); this.fastController = controller; this.lastDecisionAt = now; this.dirty = false;
    const scope = this.scope;
    const discarded = () => {
      this.timing({ scope, stage: 'decision', at: this.now(), durationMs: Math.max(0, this.clock() - started), queueMs: queued, outcome: 'discarded' });
      this.emit({ type: 'discarded', stage: 'decision', scope });
    };
    try {
      const context = this.context(), environmentRevision = this.environmentVersion;
      this.emit({ type: 'decision-started', context, at: now });
      if (controller.signal.aborted || !sameScope(context.scope, this.scope)) { discarded(); return false; }
      const result = await this.fastSlot.run(signal => this.options.fast.decide(structuredClone(context), signal), this.decisionTimeout, () => {
        if (this.fastController !== controller && !this.disposed) { this.markDirty(); this.notify(); }
      });
      if (controller.signal.aborted || this.disposed || this.paused || !sameScope(context.scope, this.scope)
        || environmentRevision !== this.options.environment.revision?.(this.options.environment.context())) {
        this.dirty = true; discarded(); return false;
      }
      for (const flag of [result.interrupt, result.think, result.acceptProposal, result.complete]) {
        if (typeof flag !== 'boolean') throw new AgentError('invalid_decision', 'Decision flags must be booleans.');
      }
      const detached = jsonCopy(result);
      this.validateDecision(detached, context);
      this.awaitingDecision = false;
      this.emit({ type: 'decision-resolved', context, result: detached, at: this.now() });
      if (controller.signal.aborted || !sameScope(scope, this.scope) || this.disposed || this.paused) {
        this.dirty = true; discarded(); return false;
      }
      this.apply(detached, context); this.error = null; this.retryAt = 0; this.failures = 0; this.budget.success(); this.adoptEnvironmentVersion();
      this.timing({ scope, stage: 'decision', at: this.now(), durationMs: Math.max(0, this.clock() - started), queueMs: queued, outcome: 'completed' }); return true;
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        const safe = error instanceof AgentError ? error : new AgentError('decision_failed', 'Decision service unavailable.');
        this.error = { code: safe.code, message: safe.message };
        const changedScene = ['resource_busy', 'resource_conflict', 'operation_busy', 'stale_observation', 'stale_candidate', 'stale_channel_candidate', 'stale_output_candidate', 'prepare_failed', 'superseded'].includes(safe.code);
        if (!changedScene) { this.failures++; this.retryAt = this.now() + this.budget.fail(this.clock(), safe.retryAfterMs); }
        this.timing({ scope, stage: 'decision', at: this.now(), durationMs: Math.max(0, this.clock() - started), queueMs: queued,
          outcome: safe.code === 'model_deadline' ? 'deadline' : 'failed' });
        this.emit({ type: 'error', stage: 'decision', scope, code: safe.code, message: safe.message, at: this.now() });
      } else discarded();
      this.dirty = true; return false;
    } finally {
      if (this.fastController === controller) this.fastController = null;
      this.emit({ type: 'settled', stage: 'decision', scope }); this.notify();
    }
  }
  private apply(result: DecisionResult, evaluated: DecisionContext): void {
    const applyingScope = evaluated.scope;
    this.syncEnvironment();
    if (!sameScope(applyingScope, this.scope) || this.disposed || this.paused) throw new AgentError('superseded', 'Decision was superseded during review.', 0);
    // Proposals are accepted by policy, not executed as a queue. The host may validate evidence here.
    if (result.acceptProposal && this.proposal && !this.proposal.accepted && this.proposal.scope.epoch === this.epoch && this.proposal.scope.turnId === this.scope.turnId) {
      const proposal = this.proposal;
      if (this.options.policies?.acceptProposal?.(structuredClone(proposal), this.context()) !== false) {
        proposal.accepted = true; this.emit({ type: 'proposal-accepted', proposal, at: this.now() });
      } else { this.proposal = null; this.emit({ type: 'proposal-rejected', proposal, at: this.now() }); }
    }
    if (!sameScope(applyingScope, this.scope) || this.disposed || this.paused) throw new AgentError('superseded', 'Decision was superseded during review.');
    // Host review and lifecycle observers can update sensor state without changing
    // the entire semantic revision. Recheck candidate dependencies at execution.
    this.validateDecision(result, evaluated);
    this.channels.prepare(result.channels ?? {}, this.options.environment.context());
    if (!sameScope(applyingScope, this.scope) || this.disposed || this.paused) throw new AgentError('superseded', 'Decision was superseded during preparation.', 0);
    const current = this.actions.current, context = this.options.environment.context(), selection = result.selection;
    if (current?.status === 'failed') throw new AgentError('cancel_failed', 'The environment has not confirmed cancellation.');
    const sameAction = selection.kind === 'execute' && current && selectionKey(selection) === selectionKey({ kind: 'execute', call: current.call });
    let applied = true;
    if (selection.kind === 'continue' || sameAction) this.actions.continue(this.turn && !this.turn.completed ? this.executionScope() : current?.scope ?? this.executionScope());
    else if (current && !result.interrupt) { this.actions.continue(current.scope); applied = false; }
    else if (selection.kind === 'execute') {
      try {
        const started = this.actions.start(selection.call, this.executionScope(), context);
        if (started) this.executionTiming(started, 'execution', 'started');
      }
      catch (error) { if (this.actions.current?.id === current?.id && current) this.actions.continue(current.scope); throw error; }
      finally {
        if (current) {
          const ended = this.actions.history.find(receipt => receipt.id === current.id);
          if (ended) this.executionTiming(ended, 'execution', 'cancelled');
        }
      }
    } else {
      const ended = this.actions.cancel(context, 'stopped');
      if (ended) this.executionTiming(ended, 'execution', 'cancelled');
      this.observeAt = this.clock() + this.idleInterval;
    }
    this.emit({ type: 'decision-applied', context: evaluated, result, previous: current, current: this.actions.current, applied, at: this.now() });
    if (!sameScope(applyingScope, this.scope) || this.disposed || this.paused) return;
    if (result.output) {
      const previous = this.outputs.current, selection = result.output;
      if (selection.kind === 'continue' || selection.kind === 'execute' && previous && selectionKey(selection) === selectionKey({ kind: 'execute', call: previous.call })) {
        if (previous) this.outputs.continue(previous.scope);
      } else if (selection.kind === 'execute') {
        try {
          const started = this.outputs.start(selection.call, this.executionScope(), context);
          if (started) this.executionTiming(started, 'output', 'started');
        } finally {
          if (previous) { const ended = this.outputs.history.find(r => r.id === previous.id); if (ended) { this.executionTiming(ended, 'output', 'cancelled'); this.emit({ type: 'output-ended', receipt: ended, at: this.now() }); } }
        }
      } else this.cancelOutput('decision');
      this.emit({ type: 'output-applied', selection, previous, current: this.outputs.current, at: this.now() });
    }
    if (!sameScope(applyingScope, this.scope) || this.disposed || this.paused) return;
    if (result.channels) this.channels.apply(result.channels, applyingScope, context);
    if (!sameScope(applyingScope, this.scope) || this.disposed || this.paused) return;
    const completionContext = this.context();
    const supported = this.actions.history.some(receipt => receipt.scope.epoch === this.epoch && receipt.scope.turnId === this.turn?.id && receipt.status === 'completed')
      || this.outputs.history.some(receipt => receipt.scope.epoch === this.epoch && receipt.scope.turnId === this.turn?.id && receipt.status === 'completed') || !!this.turn?.replyDelivered;
    const verified = this.options.policies?.verifyCompletion?.(completionContext, result) ?? supported;
    if (result.complete && selection.kind === 'wait' && this.turn && !this.turn.completed && !this.actions.current && !this.outputs.current && !this.channels.blocking && verified) {
      this.turn.completed = true; this.emit({ type: 'turn-completed', turn: this.turn, at: this.now() });
    }
    if (result.think && this.options.slow && !this.slowController && !this.slowSlot.busy && (!this.proposal || this.proposal.accepted)
      && (!this.turn?.replySuppressed || this.turn.completed) && this.clock() >= this.lastThoughtAt + this.thoughtInterval
      && this.options.policies?.canThink?.(this.context()) !== false) void this.think();
  }
  private async think(): Promise<void> {
    const context = this.context(), controller = new AbortController(); this.slowController = controller; this.lastThoughtAt = this.clock();
    const generation = this.generation, scope = this.scope, started = this.now();
    const startedClock = this.clock();
    const discarded = () => {
      this.timing({ scope, stage: 'thought', at: this.now(), durationMs: Math.max(0, this.clock() - startedClock), outcome: 'discarded' });
      this.emit({ type: 'discarded', stage: 'thought', scope });
    };
    this.emit({ type: 'thought-started', context, at: started });
    try {
      if (controller.signal.aborted || generation !== this.generation || this.disposed || this.paused) { discarded(); return; }
      const value = await this.slowSlot.run(signal => this.options.slow!.think(context, signal), this.thoughtTimeout, () => {
        if (this.slowController !== controller && !this.disposed) { this.markDirty(); this.notify(); }
      });
      if (controller.signal.aborted || this.disposed || this.paused || generation !== this.generation
        || scope.epoch !== this.epoch || scope.turnId !== this.scope.turnId || this.clock() - startedClock > this.thoughtTimeout) {
        discarded(); return;
      }
      if (!value || typeof value.summary !== 'string' || !Array.isArray(value.suggestions)
        || (value.reply !== undefined && typeof value.reply !== 'string')) throw new AgentError('invalid_proposal', 'Invalid slow-thinking proposal.');
      value.suggestions.forEach(call => selectionKey({ kind: 'execute', call }));
      this.proposal = { id: this.id(), scope, createdAt: this.now(), accepted: false, value: jsonCopy(value) };
      this.proposalExpiresAt = this.clock() + this.proposalTtl;
      this.changed(); this.emit({ type: 'proposal-created', proposal: this.proposal, at: this.now() }); this.adoptEnvironmentVersion();
      this.timing({ scope, stage: 'thought', at: this.now(), durationMs: Math.max(0, this.clock() - startedClock), outcome: 'completed' });
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed && generation === this.generation) {
        const safe = error instanceof AgentError ? error : new AgentError('thinking_failed', 'The slow-thinking proposal was not available.');
        this.error = { code: safe.code, message: safe.message };
        this.timing({ scope, stage: 'thought', at: this.now(), durationMs: Math.max(0, this.clock() - startedClock), outcome: safe.code === 'model_deadline' ? 'deadline' : 'failed' });
        this.emit({ type: 'error', stage: 'thought', scope, code: safe.code, message: safe.message, at: this.now() });
      } else discarded();
    } finally {
      if (this.slowController === controller) this.slowController = null;
      if (controller.signal.aborted && generation !== this.generation && !this.disposed) this.dirty = true;
      this.emit({ type: 'settled', stage: 'thought', scope }); this.notify();
    }
  }
  conversation(): ConversationContext {
    this.assertOpen(); this.syncEnvironment();
    return { scope: this.scope, currentAction: this.actions.current, receipts: this.actions.history,
      observation: this.evidence.observe(this.scope, (this.options.environment.perceive ?? this.options.environment.observe)(this.options.environment.context())) };
  }
  checkClaims(claims: readonly GroundingClaim[]): boolean {
    this.assertOpen(); this.syncEnvironment();
    return this.evidence.checkClaims(this.scope, claims, [...this.actions.history, ...(this.actions.current ? [this.actions.current] : [])]);
  }
}
