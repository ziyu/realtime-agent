import { ActionRuntime } from './actions.js';
import { AgentError, candidateSnapshot, defaultId, jsonCopy, positive, sameScope, selectionKey } from './common.js';
import { EvidenceLedger } from './evidence.js';
import type { AgentEnvironment, AgentEvent, AgentPolicies, ConversationContext, DecisionContext, DecisionPolicy, DecisionResult, GroundingClaim, ProposalRecord, Scope, SlowThinker, Turn } from './types.js';

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
}

/** Host-driven time, one decision slot and one thought slot, shared by every input channel. */
export class Agent<C> {
  readonly actions: ActionRuntime<C>;
  readonly outputs: ActionRuntime<C>;
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

  constructor(private options: AgentOptions<C>) {
    this.now = options.now ?? Date.now; this.id = options.id ?? defaultId; this.epoch = options.epoch ?? this.id();
    this.decisionInterval = positive(options.decisionIntervalMs ?? 1000, 'decisionIntervalMs');
    this.idleInterval = positive(options.idleIntervalMs ?? 5000, 'idleIntervalMs');
    this.thoughtInterval = positive(options.thoughtIntervalMs ?? 15000, 'thoughtIntervalMs');
    this.thoughtTimeout = positive(options.thoughtTimeoutMs ?? 35000, 'thoughtTimeoutMs');
    this.proposalTtl = positive(options.proposalTtlMs ?? 60000, 'proposalTtlMs');
    this.actions = new ActionRuntime({ capabilities: options.environment.capabilities, now: this.now, id: this.id,
      maxExecutionSeconds: options.maxExecutionSeconds });
    this.outputs = new ActionRuntime({ capabilities: options.environment.output?.capabilities ?? [], now: this.now, id: this.id, maxExecutionSeconds: options.maxExecutionSeconds });
    this.evidence = new EvidenceLedger({ now: this.now, id: this.id });
    this.adoptEnvironmentVersion();
  }

  get scope(): Scope { return { epoch: this.epoch, turnId: this.turn?.id ?? null, revision: this.revision }; }
  private executionScope(): Scope { return { ...this.scope, turnId: this.turn && !this.turn.completed ? this.turn.id : null }; }
  snapshot() {
    const nextDecisionAt = Math.max(this.retryAt, this.lastDecisionAt + this.decisionInterval);
    return structuredClone({ scope: this.scope, turn: this.turn, previousTurns: this.turns, proposal: this.proposal,
      action: this.actions.current, receipts: this.actions.history, output: this.outputs.current, outputReceipts: this.outputs.history, paused: this.paused, hearing: this.hearing,
      attending: this.hearing || this.awaitingDecision, pending: this.dirty,
      deciding: !!this.fastController && !this.fastController.signal.aborted, thinking: !!this.slowController && !this.slowController.signal.aborted,
      decisionBusy: this.fastController !== null, thoughtBusy: this.slowController !== null, disposed: this.disposed,
      error: this.error, retryAt: this.retryAt > this.now() ? this.retryAt : null,
      lastDecisionAt: Number.isFinite(this.lastDecisionAt) ? this.lastDecisionAt : null,
      nextDecisionAt: Number.isFinite(nextDecisionAt) ? nextDecisionAt : null });
  }
  subscribe(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: AgentEvent) {
    for (const listener of this.listeners) {
      // Observability failures must not turn committed world effects into a second execution.
      try { listener(structuredClone(event)); } catch { /* The host owns logging/persistence failures. */ }
    }
  }
  private assertOpen() { if (this.disposed) throw new AgentError('disposed', 'This Agent has been disposed.'); }
  private cancelRequests() { this.generation++; this.fastController?.abort(); this.slowController?.abort(); }
  private changed() { this.revision++; this.dirty = true; this.evidence.clear(); }
  private notify() { this.emit({ type: 'changed', scope: this.scope }); }
  private adoptEnvironmentVersion() { this.environmentVersion = this.options.environment.revision?.(this.options.environment.context()); }
  private syncEnvironment() {
    const version = this.options.environment.revision?.(this.options.environment.context());
    if (version !== this.environmentVersion) { this.environmentVersion = version; this.fastController?.abort(); this.changed(); }
  }
  /** Request a fresh decision without cancelling a compatible in-flight thought. */
  wake(): void { this.assertOpen(); this.dirty = true; this.emit({ type: 'wake', scope: this.scope }); }
  receive(text: string): Turn {
    this.assertOpen();
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new AgentError('invalid_input', 'Input must contain 1–8000 characters.');
    this.cancelRequests(); this.cancelOutput('new-input');
    if (this.turn) this.turns = [...this.turns, this.turn].slice(-16);
    this.turn = { id: this.id(), text: text.trim(), receivedAt: this.now(), completed: false };
    this.proposal = null; this.error = null; this.hearing = false; this.awaitingDecision = true; this.lastThoughtAt = -Infinity;
    this.actions.hold(); this.changed(); this.adoptEnvironmentVersion(); this.notify();
    return structuredClone(this.turn);
  }
  holdInput(): void { this.assertOpen(); this.cancelRequests(); this.cancelOutput('speech-start'); this.hearing = true; this.actions.hold(); this.changed(); this.notify(); }
  releaseInput(): void { this.assertOpen(); this.hearing = false; this.changed(); this.notify(); }
  invalidate(): void { this.assertOpen(); this.fastController?.abort(); this.changed(); this.notify(); }
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
  }
  reset(): void {
    this.assertOpen(); this.cancelRequests(); this.cancelOutput('reset'); this.outputs.reset(this.options.environment.context()); this.actions.reset(this.options.environment.context());
    this.epoch = this.id(); this.revision = 0; this.turn = null; this.turns = []; this.proposal = null;
    this.hearing = false; this.awaitingDecision = false; this.paused = false; this.dirty = true; this.error = null; this.observeAt = 0;
    this.lastThoughtAt = -Infinity; this.evidence.clear(); this.adoptEnvironmentVersion(); this.notify();
    // Provider start spacing and Retry-After survive resets.
  }
  dispose(): void {
    if (this.disposed) return;
    this.cancelRequests(); this.cancelOutput('disposed'); this.actions.cancel(this.options.environment.context(), 'disposed');
    this.disposed = true; this.evidence.clear(); this.notify(); this.listeners.clear();
  }
  cancelOutput(reason = 'cancelled'): void {
    const ended = this.outputs.cancel(this.options.environment.context(), reason);
    if (ended) { this.changed(); this.emit({ type: 'output-ended', receipt: ended, at: this.now() }); this.notify(); }
  }
  tick(seconds: number): void {
    this.assertOpen(); this.syncEnvironment();
    if (this.paused || this.hearing) return;
    if (seconds > 0 && this.actions.current?.status === 'running') this.evidence.clear();
    const output = this.outputs.tick(this.options.environment.context(), seconds);
    if (output) { this.changed(); this.emit({ type: 'output-ended', receipt: output, at: this.now() }); this.adoptEnvironmentVersion(); this.notify(); }
    const ended = this.actions.tick(this.options.environment.context(), seconds);
    if (ended) {
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
      thinking: this.slowController !== null, slowThinkingAvailable: !!this.options.slow };
  }
  async decide(): Promise<boolean> {
    this.assertOpen(); this.syncEnvironment();
    const now = this.now();
    if (this.paused || this.hearing || this.fastController || now < this.lastDecisionAt + this.decisionInterval || now < this.retryAt) return false;
    if (this.proposal && now - this.proposal.createdAt > this.proposalTtl) {
      const proposal = this.proposal; this.proposal = null; this.changed(); this.emit({ type: 'proposal-expired', proposal, at: now });
    }
    if (!this.dirty && (this.actions.current || this.outputs.current || this.slowController || now < this.observeAt)) return false;
    const controller = new AbortController(); this.fastController = controller; this.lastDecisionAt = now; this.dirty = false;
    const scope = this.scope;
    try {
      const context = this.context(), environmentRevision = this.environmentVersion;
      this.emit({ type: 'decision-started', context, at: now });
      const result = await this.options.fast.decide(structuredClone(context), controller.signal);
      if (controller.signal.aborted || this.disposed || this.paused || !sameScope(context.scope, this.scope)
        || environmentRevision !== this.options.environment.revision?.(this.options.environment.context())) {
        this.dirty = true; this.emit({ type: 'discarded', stage: 'decision', scope }); return false;
      }
      for (const flag of [result.interrupt, result.think, result.acceptProposal, result.complete]) {
        if (typeof flag !== 'boolean') throw new AgentError('invalid_decision', 'Decision flags must be booleans.');
      }
      const detached = jsonCopy(result), key = selectionKey(detached.selection);
      const stillAvailable = candidateSnapshot(this.options.environment.candidates(this.options.environment.context()));
      if (!context.candidates.some(candidate => selectionKey(candidate.selection) === key)
        || !stillAvailable.some(candidate => selectionKey(candidate.selection) === key)) throw new AgentError('stale_candidate', 'The selected action is no longer available.');
      if (detached.output) {
        const outputKey = selectionKey(detached.output);
        const outputs = this.options.environment.output ? candidateSnapshot(this.options.environment.output.candidates(this.options.environment.context())) : [];
        if (!context.outputCandidates?.some(c => selectionKey(c.selection) === outputKey) || !outputs.some(c => selectionKey(c.selection) === outputKey))
          throw new AgentError('stale_output_candidate', 'The selected output action is no longer available.');
      }
      this.awaitingDecision = false;
      this.emit({ type: 'decision-resolved', context, result: detached, at: this.now() });
      if (controller.signal.aborted || !sameScope(scope, this.scope) || this.disposed || this.paused) {
        this.dirty = true; this.emit({ type: 'discarded', stage: 'decision', scope }); return false;
      }
      this.apply(detached, context); this.error = null; this.retryAt = 0; this.failures = 0; this.adoptEnvironmentVersion(); return true;
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        const safe = error instanceof AgentError ? error : new AgentError('decision_failed', 'Decision service unavailable.');
        this.error = { code: safe.code, message: safe.message }; this.failures++;
        this.retryAt = this.now() + Math.max(safe.retryAfterMs, Math.min(60000, 2000 * 2 ** Math.min(this.failures, 5)));
        this.emit({ type: 'error', stage: 'decision', scope, code: safe.code, message: safe.message, at: this.now() });
      } else this.emit({ type: 'discarded', stage: 'decision', scope });
      this.dirty = true; return false;
    } finally {
      if (this.fastController === controller) this.fastController = null;
      this.emit({ type: 'settled', stage: 'decision', scope }); this.notify();
    }
  }
  private apply(result: DecisionResult, evaluated: DecisionContext): void {
    const applyingScope = this.scope;
    // Proposals are accepted by policy, not executed as a queue. The host may validate evidence here.
    if (result.acceptProposal && this.proposal && !this.proposal.accepted && this.proposal.scope.epoch === this.epoch && this.proposal.scope.turnId === this.scope.turnId) {
      const proposal = this.proposal;
      if (this.options.policies?.acceptProposal?.(structuredClone(proposal), this.context()) !== false) {
        proposal.accepted = true; this.emit({ type: 'proposal-accepted', proposal, at: this.now() });
      } else { this.proposal = null; this.emit({ type: 'proposal-rejected', proposal, at: this.now() }); }
    }
    if (!sameScope(applyingScope, this.scope) || this.disposed || this.paused) throw new AgentError('superseded', 'Decision was superseded during review.');
    const current = this.actions.current, context = this.options.environment.context(), selection = result.selection;
    if (current?.status === 'failed') throw new AgentError('cancel_failed', 'The environment has not confirmed cancellation.');
    const sameAction = selection.kind === 'execute' && current && selectionKey(selection) === selectionKey({ kind: 'execute', call: current.call });
    let applied = true;
    if (selection.kind === 'continue' || sameAction) this.actions.continue(this.turn && !this.turn.completed ? this.executionScope() : current?.scope ?? this.executionScope());
    else if (current && !result.interrupt) { this.actions.continue(current.scope); applied = false; }
    else if (selection.kind === 'execute') {
      try { this.actions.start(selection.call, this.executionScope(), context); }
      catch (error) { if (this.actions.current?.id === current?.id && current) this.actions.continue(current.scope); throw error; }
    } else { this.actions.cancel(context, 'stopped'); this.observeAt = this.now() + this.idleInterval; }
    this.emit({ type: 'decision-applied', context: evaluated, result, previous: current, current: this.actions.current, applied, at: this.now() });
    if (!sameScope(applyingScope, this.scope) || this.disposed || this.paused) return;
    if (result.output) {
      const previous = this.outputs.current, selection = result.output;
      if (selection.kind === 'continue' || selection.kind === 'execute' && previous && selectionKey(selection) === selectionKey({ kind: 'execute', call: previous.call })) {
        if (previous) this.outputs.continue(previous.scope);
      } else if (selection.kind === 'execute') {
        this.outputs.start(selection.call, this.executionScope(), context);
        if (previous) { const ended = this.outputs.history.find(r => r.id === previous.id); if (ended) this.emit({ type: 'output-ended', receipt: ended, at: this.now() }); }
      } else this.cancelOutput('decision');
      this.emit({ type: 'output-applied', selection, previous, current: this.outputs.current, at: this.now() });
    }
    if (!sameScope(applyingScope, this.scope) || this.disposed || this.paused) return;
    const completionContext = this.context();
    const supported = this.actions.history.some(receipt => receipt.scope.epoch === this.epoch && receipt.scope.turnId === this.turn?.id && receipt.status === 'completed')
      || this.outputs.history.some(receipt => receipt.scope.epoch === this.epoch && receipt.scope.turnId === this.turn?.id && receipt.status === 'completed') || !!this.turn?.replyDelivered;
    const verified = this.options.policies?.verifyCompletion?.(completionContext, result) ?? supported;
    if (result.complete && selection.kind === 'wait' && this.turn && !this.turn.completed && !this.actions.current && !this.outputs.current && verified) {
      this.turn.completed = true; this.emit({ type: 'turn-completed', turn: this.turn, at: this.now() });
    }
    if (result.think && this.options.slow && !this.slowController && (!this.proposal || this.proposal.accepted)
      && (!this.turn?.replySuppressed || this.turn.completed) && this.now() >= this.lastThoughtAt + this.thoughtInterval
      && this.options.policies?.canThink?.(this.context()) !== false) void this.think();
  }
  private async think(): Promise<void> {
    const context = this.context(), controller = new AbortController(); this.slowController = controller; this.lastThoughtAt = this.now();
    const generation = this.generation, scope = this.scope, started = this.now();
    this.emit({ type: 'thought-started', context, at: started });
    try {
      const value = await this.options.slow!.think(context, controller.signal);
      if (controller.signal.aborted || this.disposed || this.paused || generation !== this.generation
        || scope.epoch !== this.epoch || scope.turnId !== this.scope.turnId || this.now() - started > this.thoughtTimeout) {
        this.emit({ type: 'discarded', stage: 'thought', scope }); return;
      }
      if (!value || typeof value.summary !== 'string' || !Array.isArray(value.suggestions)
        || (value.reply !== undefined && typeof value.reply !== 'string')) throw new AgentError('invalid_proposal', 'Invalid slow-thinking proposal.');
      value.suggestions.forEach(call => selectionKey({ kind: 'execute', call }));
      this.proposal = { id: this.id(), scope, createdAt: this.now(), accepted: false, value: jsonCopy(value) };
      this.changed(); this.emit({ type: 'proposal-created', proposal: this.proposal, at: this.now() }); this.adoptEnvironmentVersion();
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed && generation === this.generation) {
        const safe = error instanceof AgentError ? error : new AgentError('thinking_failed', 'The slow-thinking proposal was not available.');
        this.error = { code: safe.code, message: safe.message };
        this.emit({ type: 'error', stage: 'thought', scope, code: safe.code, message: safe.message, at: this.now() });
      } else this.emit({ type: 'discarded', stage: 'thought', scope });
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
