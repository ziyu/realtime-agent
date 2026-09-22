import { AgentError, copyCall, defaultId, jsonCopy, positive, sameScope, selectionKey } from './common.js';
import type { ActionCall, JsonValue, Scope } from './types.js';

export interface TaskReference { id: string; version: number }
export interface PlanStep { id: string; call: ActionCall; after: string[] }
export interface PlanRecord { id: string; task: TaskReference; createdAt: number; expiresAt: number; expired: boolean; accepted: boolean; steps: PlanStep[]; completedSteps: string[] }
export interface TaskRecord extends TaskReference {
  scope: Scope;
  goal: JsonValue;
  status: 'active' | 'completed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  plan: PlanRecord | null;
  evidenceIds: string[];
}
interface Binding { task: TaskReference; planId: string; stepId: string; scope: Scope; call: ActionCall }
interface TaskReceipt { id: string; scope: Scope; call: ActionCall; status: string }

/** Bounded short plans. Accepting a plan never executes it; the Agent still selects each offered step. */
export class TaskLedger {
  private active: TaskRecord | null = null;
  private bindings = new Map<string, Binding>();
  private settled = new Set<string>();
  private now: () => number;
  private clock: () => number;
  private id: () => string;
  private planDeadline = -Infinity;
  constructor(options: { now?: () => number; monotonicNow?: () => number; id?: () => string } = {}) {
    this.now = options.now ?? Date.now; this.clock = options.monotonicNow ?? options.now ?? (() => performance.now()); this.id = options.id ?? defaultId;
  }
  snapshot(): TaskRecord | null {
    const task = structuredClone(this.active);
    if (task?.plan) task.plan.expired = this.clock() >= this.planDeadline;
    return task;
  }
  current(reference: TaskReference): boolean { return !!this.active && this.active.id === reference.id && this.active.version === reference.version && this.active.status === 'active'; }
  begin(goal: JsonValue, scope: Scope): TaskRecord {
    const copy = jsonCopy(goal), now = this.now();
    this.active = { id: this.id(), version: 1, scope: { ...scope }, goal: copy, status: 'active', createdAt: now, updatedAt: now, plan: null, evidenceIds: [] };
    // Bindings are retained so a superseded execution cannot be rebound to this new task.
    return this.snapshot()!;
  }
  revise(reference: TaskReference, goal: JsonValue, scope: Scope): TaskRecord {
    if (!this.current(reference)) throw new AgentError('stale_task', 'This goal has been superseded.');
    const copy = jsonCopy(goal);
    this.active = { ...this.active!, version: reference.version + 1, goal: copy, scope: { ...scope }, status: 'active', updatedAt: this.now(), plan: null, evidenceIds: [] };
    return this.snapshot()!;
  }
  propose(reference: TaskReference, steps: readonly PlanStep[], ttlMs = 60000): PlanRecord {
    if (!this.current(reference)) throw new AgentError('stale_task', 'This goal has been superseded.');
    positive(ttlMs, 'planTtlMs');
    if (!Array.isArray(steps) || !steps.length || steps.length > 16) throw new AgentError('invalid_plan', 'A short plan needs between 1 and 16 steps.');
    const known = new Set<string>();
    const copied: PlanStep[] = steps.map((step: PlanStep) => {
      if (!step.id || step.id.length > 160 || known.has(step.id) || !Array.isArray(step.after) || step.after.some(id => !known.has(id))) {
        throw new AgentError('invalid_plan', 'Steps must have unique IDs and refer only to earlier dependencies.');
      }
      known.add(step.id); return { id: step.id, call: copyCall(step.call), after: [...new Set<string>(step.after)] };
    });
    const now = this.now(), plan = { id: this.id(), task: { id: reference.id, version: reference.version }, createdAt: now,
      expiresAt: now + ttlMs, expired: false, accepted: false, steps: copied, completedSteps: [] };
    this.planDeadline = this.clock() + ttlMs;
    this.active!.plan = plan; return structuredClone(plan);
  }
  accept(reference: TaskReference, planId: string, validate: (call: ActionCall) => boolean): boolean {
    const plan = this.active?.plan;
    if (!this.current(reference) || !plan || plan.id !== planId || this.clock() >= this.planDeadline) return false;
    if (!plan.steps.every(step => validate(copyCall(step.call)))) return false;
    // The host validator may synchronously replace the goal; never adopt into a different task.
    if (!this.current(reference) || this.active?.plan !== plan || this.clock() >= this.planDeadline) return false;
    plan.accepted = true; return true;
  }
  next(reference: TaskReference): PlanStep[] {
    const plan = this.active?.plan;
    if (!this.current(reference) || !plan?.accepted || this.clock() >= this.planDeadline) return [];
    return structuredClone(plan.steps.filter(step => !plan.completedSteps.includes(step.id) && step.after.every(id => plan.completedSteps.includes(id))));
  }
  bind(reference: TaskReference, stepId: string, executionId: string, scope: Scope): boolean {
    if (!this.current(reference) || this.active!.scope.epoch !== scope.epoch || this.bindings.has(executionId)) return false;
    const step = this.next(reference).find(step => step.id === stepId);
    if (!step) return false;
    if (this.bindings.size >= 512) {
      const removable = [...this.bindings.keys()].find(id => this.settled.has(id));
      if (!removable) throw new AgentError('task_capacity', 'Too many unaccounted task executions.');
      this.bindings.delete(removable); this.settled.delete(removable);
    }
    this.bindings.set(executionId, { task: { id: reference.id, version: reference.version }, planId: this.active!.plan!.id, stepId, scope: { ...scope }, call: copyCall(step.call) }); return true;
  }
  record(receipt: TaskReceipt): boolean {
    const binding = this.bindings.get(receipt.id);
    if (!binding || this.settled.has(receipt.id) || !['completed', 'failed', 'cancelled'].includes(receipt.status)
      || !sameScope(binding.scope, receipt.scope) || selectionKey({ kind: 'execute', call: binding.call }) !== selectionKey({ kind: 'execute', call: receipt.call })) return false;
    this.settled.add(receipt.id);
    if (!this.current(binding.task) || receipt.status !== 'completed') return false;
    const plan = this.active!.plan;
    if (!plan?.accepted || plan.id !== binding.planId || !plan.steps.some(step => step.id === binding.stepId && selectionKey({ kind: 'execute', call: step.call }) === selectionKey({ kind: 'execute', call: binding.call }))) return false;
    if (!plan.completedSteps.includes(binding.stepId)) plan.completedSteps.push(binding.stepId);
    this.active!.evidenceIds = [...this.active!.evidenceIds, receipt.id].slice(-64); this.active!.updatedAt = this.now(); return true;
  }
  verify(reference: TaskReference, verifier: (task: TaskRecord) => { satisfied: boolean; evidenceIds: string[] }): boolean {
    if (!this.current(reference)) return false;
    const task = this.active!, result = verifier(structuredClone(task));
    if (!this.current(reference) || this.active !== task || !result.satisfied || !Array.isArray(result.evidenceIds) || !result.evidenceIds.length
      || result.evidenceIds.length > 64 || result.evidenceIds.some(id => typeof id !== 'string' || !id || id.length > 240)) return false;
    task.status = 'completed'; task.evidenceIds = [...new Set(result.evidenceIds)]; task.updatedAt = this.now(); return true;
  }
  cancel(): void { if (this.active?.status === 'active') { this.active.status = 'cancelled'; this.active.updatedAt = this.now(); } }
}
