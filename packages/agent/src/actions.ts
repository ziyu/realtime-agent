import { AgentError, copyCall, defaultId, jsonCopy, positive } from './common.js';
import type { ActionCall, ActionReceipt, Capability, ExecutionContext, PreparedAction, Scope } from './types.js';

interface Active<C> { receipt: ActionReceipt; prepared: PreparedAction<C>; controller: AbortController }
export interface ActionRuntimeOptions<C> {
  capabilities: readonly Capability<C>[];
  now?: () => number;
  id?: () => string;
  maxExecutionSeconds?: number;
  historyLimit?: number;
}

/** Environment-owned effects, with a single authoritative execution lifecycle. */
export class ActionRuntime<C> {
  private capabilities = new Map<string, Capability<C>>();
  private active: Active<C> | null = null;
  private records: ActionReceipt[] = [];
  private now: () => number;
  private id: () => string;
  private maxSeconds: number;
  private limit: number;

  constructor(options: ActionRuntimeOptions<C>) {
    this.now = options.now ?? Date.now; this.id = options.id ?? defaultId;
    this.maxSeconds = positive(options.maxExecutionSeconds ?? 120, 'maxExecutionSeconds');
    this.limit = Math.floor(positive(options.historyLimit ?? 64, 'historyLimit'));
    if (this.limit < 1 || this.limit > 10000) throw new AgentError('configuration', 'historyLimit must be between 1 and 10000.');
    for (const capability of options.capabilities) {
      if (!capability.id || this.capabilities.has(capability.id)) throw new AgentError('duplicate_capability', 'Capability IDs must be unique.');
      this.capabilities.set(capability.id, capability);
    }
  }

  get current(): ActionReceipt | null { return this.active ? structuredClone(this.active.receipt) : null; }
  get history(): ActionReceipt[] { return structuredClone(this.records); }
  private execution(active: Active<C>): ExecutionContext {
    return { id: active.receipt.id, scope: { ...active.receipt.scope }, signal: active.controller.signal };
  }

  start(call: ActionCall, scope: Scope, context: C): ActionReceipt {
    const detached = copyCall(call);
    const capability = this.capabilities.get(detached.capability);
    if (!capability) throw new AgentError('unknown_capability', 'This capability is not registered.');
    if (this.active?.receipt.status === 'failed') throw new AgentError('cancel_failed', 'Reset the environment after a failed cancellation before executing again.');
    // Do all target, precondition and path checks before touching the running action.
    let prepared: PreparedAction<C>;
    try { prepared = capability.prepare(detached, context); }
    catch { throw new AgentError('prepare_failed', 'The requested action is no longer available.'); }
    if (!prepared || typeof prepared.step !== 'function') throw new AgentError('invalid_capability', 'A capability must return a step executor.');
    this.cancel(context, 'replaced');
    const now = this.now();
    const active: Active<C> = { prepared, controller: new AbortController(), receipt: {
      id: this.id(), scope: { ...scope }, call: detached, status: 'running', phase: prepared.phase ?? 'executing',
      progress: 0, elapsedSeconds: 0, startedAt: now, updatedAt: now,
    } };
    this.active = active;
    try { prepared.start?.(context, this.execution(active)); }
    catch { this.fail(context, 'start_failed'); throw new AgentError('start_failed', 'The environment could not start this action.'); }
    return this.current!;
  }

  hold(): void {
    if (this.active?.receipt.status === 'running') {
      this.active.receipt.status = 'held'; this.active.receipt.updatedAt = this.now();
    }
  }

  /** Only call after the decision maker has explicitly adopted the existing action. */
  continue(scope: Scope): ActionReceipt | null {
    const active = this.active;
    if (!active || active.receipt.status === 'failed') return null;
    if (active.receipt.scope.epoch !== scope.epoch) throw new AgentError('stale_execution', 'Cannot adopt an execution from another epoch.');
    active.receipt.scope = { ...scope }; active.receipt.status = 'running'; active.receipt.updatedAt = this.now();
    return this.current;
  }

  private finish(status: 'completed' | 'cancelled' | 'failed', reason?: string): ActionReceipt {
    const active = this.active!;
    active.receipt.status = status; active.receipt.updatedAt = this.now(); active.receipt.endedAt = this.now();
    if (reason) active.receipt.reason = reason;
    const receipt = structuredClone(active.receipt);
    this.records.push(receipt); this.records = this.records.slice(-this.limit);
    this.active = null;
    return structuredClone(receipt);
  }

  cancel(context: C, reason = 'cancelled'): ActionReceipt | null {
    const active = this.active;
    if (!active) return null;
    active.controller.abort();
    try { active.prepared.cancel?.(context, this.execution(active)); }
    catch {
      active.receipt.status = 'failed'; active.receipt.reason = 'cancel_failed'; active.receipt.updatedAt = this.now();
      throw new AgentError('cancel_failed', 'The environment did not confirm cancellation.');
    }
    return this.finish('cancelled', reason);
  }

  private fail(context: C, reason: string): ActionReceipt {
    const active = this.active!;
    active.controller.abort();
    try { active.prepared.cancel?.(context, this.execution(active)); }
    catch {
      active.receipt.status = 'failed'; active.receipt.reason = 'cancel_failed'; active.receipt.updatedAt = this.now();
      return this.current!;
    }
    return this.finish('failed', reason);
  }

  /** Returns a terminal receipt once. Progress is available through current. */
  tick(context: C, seconds: number): ActionReceipt | null {
    if (!Number.isFinite(seconds) || seconds < 0) throw new AgentError('invalid_delta', 'seconds must be finite and nonnegative.');
    const active = this.active;
    if (!active || active.receipt.status !== 'running' || seconds === 0) return null;
    active.receipt.elapsedSeconds += seconds;
    if (active.receipt.elapsedSeconds > this.maxSeconds) return this.fail(context, 'execution_timeout');
    try {
      const step = active.prepared.step(context, seconds, this.execution(active));
      if (step.status === 'completed') {
        active.receipt.result = jsonCopy(step.result); active.receipt.progress = 1;
        return this.finish('completed');
      }
      if (step.status !== 'running' || (step.progress !== undefined && (!Number.isFinite(step.progress) || step.progress < 0 || step.progress > 1))) {
        return this.fail(context, 'invalid_progress');
      }
      if (step.phase !== undefined) active.receipt.phase = step.phase;
      if (step.progress !== undefined) active.receipt.progress = step.progress;
      active.receipt.updatedAt = this.now();
      return null;
    } catch { return this.fail(context, 'execution_failed'); }
  }

  /** The host must reset its actual environment too; historical effects are not undone. */
  reset(context: C): void { this.cancel(context, 'reset'); this.records = []; }
}
