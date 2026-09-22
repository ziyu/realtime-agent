import { AgentError, copyCall, defaultId, jsonCopy, positive } from './common.js';
import { ResourceArbiter } from './resources.js';
import type { ResourceLease } from './resources.js';
import type { ActionCall, ActionReceipt, Scope } from './types.js';

export type OperationStatus = 'dispatched' | 'running' | 'cancel-requested' | 'unknown' | 'completed' | 'cancelled' | 'failed';
export type OperationEffect = 'none' | 'partial' | 'committed' | 'unknown';
export interface OperationReceipt extends Omit<ActionReceipt, 'status'> {
  status: OperationStatus;
  /** Real monotonic time since dispatch, including device/transport waits. */
  elapsedSeconds: number;
  operationId: string;
  deviceSessionId: string;
  sourceSequence: number;
  effect: OperationEffect;
  evidenceIds: string[];
  deadlineAt: number;
  cancelRequestedAt?: number;
}
export interface OperationContext {
  operationId: string;
  deviceSessionId: string;
  scope: Scope;
  signal: AbortSignal;
}
export interface OperationUpdate {
  sequence: number;
  status: 'running' | 'unknown' | 'completed' | 'cancelled' | 'failed';
  effect: OperationEffect;
  phase?: string;
  progress?: number;
  result?: import('./types.js').JsonValue;
  evidenceIds?: string[];
}
export interface OperationEvent extends OperationUpdate { operationId: string; deviceSessionId: string }
export type ReportOperation = (update: OperationUpdate) => boolean;
export interface PreparedOperation<C> {
  maxDurationMs: number;
  interruptibility: 'immediate' | 'checkpoint' | 'noninterruptible';
  /** Settling this Promise acknowledges transport only. A terminal report must confirm the actual outcome. */
  dispatch(context: C, operation: OperationContext, report: ReportOperation): void | Promise<void>;
  cancel?(context: C, operation: OperationContext, report: ReportOperation): void | Promise<void>;
  reconcile?(context: C, operation: OperationContext, report: ReportOperation): void | Promise<void>;
}
export interface AsyncCapability<C> { id: string; prepare(call: ActionCall, context: C): PreparedOperation<C> }
interface ActiveOperation<C> {
  receipt: OperationReceipt;
  prepared: PreparedOperation<C>;
  controller: AbortController;
  lease: ResourceLease;
  startedClock: number;
  deadline: number;
  dispatched: boolean;
  cancelSent: boolean;
  reconciling: boolean;
}
export interface OperationRuntimeOptions<C> {
  capabilities: readonly AsyncCapability<C>[];
  deviceSessionId: string;
  resources: readonly string[];
  arbiter?: ResourceArbiter;
  now?: () => number;
  monotonicNow?: () => number;
  id?: () => string;
  historyLimit?: number;
  onChange?(receipt: OperationReceipt, terminal: boolean): void;
}

const terminal = (status: OperationStatus) => ['completed', 'cancelled', 'failed'].includes(status);

/** In-memory execution accounting. Unknown outcomes retain the device lease until an actual terminal report. */
export class OperationRuntime<C> {
  private active: ActiveOperation<C> | null = null;
  private records: OperationReceipt[] = [];
  private capabilities = new Map<string, AsyncCapability<C>>();
  private arbiter: ResourceArbiter;
  private now: () => number;
  private clock: () => number;
  private id: () => string;
  private limit: number;

  constructor(private options: OperationRuntimeOptions<C>) {
    if (!options.deviceSessionId || options.deviceSessionId.length > 240) throw new AgentError('configuration', 'A device session ID is required.');
    this.now = options.now ?? Date.now;
    this.clock = options.monotonicNow ?? options.now ?? (() => performance.now());
    this.id = options.id ?? defaultId; this.arbiter = options.arbiter ?? new ResourceArbiter();
    this.limit = positive(options.historyLimit ?? 64, 'historyLimit');
    if (!Number.isSafeInteger(this.limit) || this.limit > 10000) throw new AgentError('configuration', 'Invalid operation history limit.');
    this.arbiter.available(options.resources);
    for (const capability of options.capabilities) {
      if (!capability.id || this.capabilities.has(capability.id)) throw new AgentError('duplicate_capability', 'Capability IDs must be unique.');
      this.capabilities.set(capability.id, capability);
    }
  }

  get current(): OperationReceipt | null { return this.active ? structuredClone(this.active.receipt) : null; }
  get history(): OperationReceipt[] { return structuredClone(this.records); }
  available(): boolean { return this.arbiter.available(this.options.resources, this.active?.lease); }

  validate(call: ActionCall, context: C): void { this.prepare(call, context); }
  private prepare(call: ActionCall, context: C): PreparedOperation<C> {
    const detached = copyCall(call), capability = this.capabilities.get(detached.capability);
    if (!capability) throw new AgentError('unknown_capability', 'This device capability is not registered.');
    let prepared: PreparedOperation<C>;
    try { prepared = capability.prepare(detached, context); }
    catch { throw new AgentError('prepare_failed', 'The device action is no longer available.'); }
    if (!prepared || typeof prepared.dispatch !== 'function' || !['immediate', 'checkpoint', 'noninterruptible'].includes(prepared.interruptibility)) {
      throw new AgentError('invalid_capability', 'Expected a bounded asynchronous execution port.');
    }
    positive(prepared.maxDurationMs, 'maxDurationMs');
    return prepared;
  }

  start(call: ActionCall, scope: Scope, context: C): OperationReceipt {
    const detached = copyCall(call), prepared = this.prepare(detached, context);
    if (this.active) throw new AgentError('operation_busy', 'The previous device operation has not settled.', 0);
    const id = this.id();
    if (!id || this.records.some(r => r.id === id)) throw new AgentError('duplicate_execution', 'Execution IDs must be unique.');
    const lease = this.arbiter.acquire(id, this.options.resources), now = this.now(), startedClock = this.clock();
    const active: ActiveOperation<C> = { prepared, lease, controller: new AbortController(),
      startedClock, deadline: startedClock + prepared.maxDurationMs, dispatched: false, cancelSent: false, reconciling: false,
      receipt: { id, operationId: id, deviceSessionId: this.options.deviceSessionId, scope: { ...scope }, call: detached,
        status: 'dispatched', phase: 'dispatched', progress: 0, elapsedSeconds: 0, startedAt: now, updatedAt: now,
        deadlineAt: now + prepared.maxDurationMs, sourceSequence: 0, effect: 'unknown', evidenceIds: [] } };
    this.active = active; this.notify(active.receipt, false);
    // A listener may already have cancelled or settled this intent. Never dispatch
    // after its lease has been released or replaced by another operation.
    if (this.active === active && !active.controller.signal.aborted) {
      active.dispatched = true; this.invoke(active, 'dispatch', context);
    }
    return structuredClone(active.receipt);
  }

  private operation(active: ActiveOperation<C>): OperationContext {
    return { operationId: active.receipt.operationId, deviceSessionId: active.receipt.deviceSessionId,
      scope: { ...active.receipt.scope }, signal: active.controller.signal };
  }
  private notify(receipt: OperationReceipt, ended: boolean): void {
    try { this.options.onChange?.(structuredClone(receipt), ended); } catch { /* Projection failures cannot replay an effect. */ }
  }
  private elapsed(active: ActiveOperation<C>): void {
    active.receipt.elapsedSeconds = Math.max(active.receipt.elapsedSeconds, (this.clock() - active.startedClock) / 1000);
  }
  private unknown(active: ActiveOperation<C>, reason: string): void {
    if (this.active !== active) return;
    this.elapsed(active);
    active.receipt.status = 'unknown'; active.receipt.reason = reason; active.receipt.updatedAt = this.now();
    this.notify(active.receipt, false);
  }
  private invoke(active: ActiveOperation<C>, method: 'dispatch' | 'cancel' | 'reconcile', context: C): void {
    const hook = active.prepared[method];
    if (!hook) { if (method !== 'dispatch') this.unknown(active, `${method}_unavailable`); return; }
    const report: ReportOperation = update => this.report({ ...update, operationId: active.receipt.operationId, deviceSessionId: active.receipt.deviceSessionId });
    try {
      const pending = hook(context, this.operation(active), report);
      if (pending && typeof pending.then === 'function') {
        void pending.then(() => { if (method === 'reconcile') active.reconciling = false; }, () => {
          if (method === 'reconcile') active.reconciling = false;
          this.unknown(active, `${method}_unconfirmed`);
        });
      } else if (method === 'reconcile') active.reconciling = false;
    } catch {
      if (method === 'reconcile') active.reconciling = false;
      this.unknown(active, `${method}_unconfirmed`);
    }
  }

  /** Late results still account for the original scope, even after new input or cancellation. */
  report(event: OperationEvent): boolean {
    const active = this.active;
    if (!active || !event || event.operationId !== active.receipt.operationId || event.deviceSessionId !== active.receipt.deviceSessionId) return false;
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= active.receipt.sourceSequence) return false;
    if (!['running', 'unknown', 'completed', 'cancelled', 'failed'].includes(event.status)
      || !['none', 'partial', 'committed', 'unknown'].includes(event.effect)
      || (event.progress !== undefined && (!Number.isFinite(event.progress) || event.progress < 0 || event.progress > 1))
      || (event.phase !== undefined && (typeof event.phase !== 'string' || event.phase.length > 160))
      || (event.status === 'completed' && (event.result === undefined || event.effect === 'unknown'))
      || (event.evidenceIds !== undefined && (!Array.isArray(event.evidenceIds) || event.evidenceIds.length > 64 || event.evidenceIds.some(id => typeof id !== 'string' || !id || id.length > 240)))) {
      throw new AgentError('invalid_operation_event', 'The device report is invalid.');
    }
    const data = jsonCopy(event), ended = terminal(event.status), receipt = active.receipt;
    this.elapsed(active);
    receipt.sourceSequence = data.sequence; receipt.updatedAt = this.now(); receipt.effect = data.effect;
    receipt.status = data.status === 'running' && active.cancelSent ? 'cancel-requested' : data.status;
    receipt.phase = data.phase ?? receipt.status;
    if (data.progress !== undefined) receipt.progress = data.progress;
    if (data.result !== undefined) receipt.result = data.result;
    if (data.evidenceIds) receipt.evidenceIds = data.evidenceIds;
    if (ended) {
      if (data.status === 'completed') receipt.progress = 1;
      receipt.endedAt = this.now();
      this.records.push(structuredClone(receipt)); this.records = this.records.slice(-this.limit);
      this.active = null; this.arbiter.release(active.lease);
    }
    this.notify(receipt, ended);
    return true;
  }

  cancel(context: C, reason = 'cancelled'): OperationReceipt | null {
    const active = this.active;
    if (!active || active.cancelSent) return this.current;
    active.cancelSent = true; active.receipt.cancelRequestedAt = this.now(); active.receipt.updatedAt = this.now();
    active.receipt.status = 'cancel-requested'; active.receipt.reason = reason;
    this.elapsed(active); active.controller.abort();
    // An abort listener may deliver the actual outcome synchronously.
    if (this.active !== active) return this.current;
    if (!active.dispatched) {
      this.report({ operationId: active.receipt.operationId, deviceSessionId: active.receipt.deviceSessionId,
        sequence: active.receipt.sourceSequence + 1, status: 'cancelled', effect: 'none' });
      return this.current;
    }
    this.notify(active.receipt, false);
    if (this.active === active) {
      if (active.prepared.interruptibility === 'noninterruptible') this.unknown(active, 'noninterruptible');
      else this.invoke(active, 'cancel', context);
    }
    return this.current;
  }

  reconcile(context: C): boolean {
    const active = this.active;
    if (!active || active.reconciling || !active.prepared.reconcile) return false;
    active.reconciling = true; this.invoke(active, 'reconcile', context); return true;
  }
  tick(context: C): void {
    const active = this.active;
    if (!active) return;
    this.elapsed(active);
    if (active.cancelSent || this.clock() < active.deadline) return;
    this.cancel(context, 'execution_deadline');
    if (this.active === active) this.unknown(active, 'execution_deadline');
  }
  reset(context: C): void {
    this.cancel(context, 'reset');
    if (this.active) throw new AgentError('unsettled_operation', 'Reconcile the device before resetting its execution history.');
    this.records = [];
  }
}
