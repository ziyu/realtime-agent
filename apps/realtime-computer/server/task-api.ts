import { isDeepStrictEqual } from 'node:util';
import { AgentError } from '@realtime-agent/agent';
import type { CuaComputerRuntime } from './cua-runtime.js';

export const TASK_RETENTION = 32;
type RuntimeState = ReturnType<CuaComputerRuntime['taskState']>;
type TaskTrace = ReturnType<CuaComputerRuntime['taskTrace']>;

export interface ComputerTaskRecord {
  id: string;
  goal: string;
  status: 'active' | 'completed' | 'blocked' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  steps: number;
  progress: RuntimeState['progress'];
  error: string | null;
  pendingOperation: Omit<NonNullable<RuntimeState['pendingOperation']>, 'turnId'> | null;
  result: { summary: string; verification: 'observed-data' | 'model-visual' | null; evidenceIds: string[] } | null;
  resumedFrom: string | null;
  supersededBy: string | null;
}

export class ComputerApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message); this.name = 'ComputerApiError';
  }
}

interface Entry { task: ComputerTaskRecord; turnId: string; trace: TaskTrace; truncated: boolean }

/** Bounded task projections for all callers, including the existing web UI.
 * Execution, cancellation and evidence verification remain in the shared runtime.
 * These records live for this server process only; they are not a durable queue.
 */
export class ComputerTaskApi {
  private records = new Map<string, Entry>();
  private requests = new Map<string, { goal: string; taskId: string }>();
  private currentId: string | null = null;
  private mutating = false;
  private unsubscribe: () => void;

  constructor(private runtime: CuaComputerRuntime) {
    this.unsubscribe = runtime.subscribeTasks(() => this.sync());
    this.sync();
  }

  close(): void { this.unsubscribe(); }

  private sync(): void {
    const state = this.runtime.taskState(), current = state.task;
    if (current && !this.records.has(current.id)) {
      const previous = this.currentId ? this.records.get(this.currentId) : undefined;
      if (previous?.task.status === 'active') {
        previous.task.status = 'cancelled'; previous.task.supersededBy = current.id;
        previous.task.updatedAt = Date.now(); previous.task.error = null;
        previous.task.progress = { phase: 'cancelled', message: '任务已被新的目标替代。', updatedAt: Date.now() };
      }
      this.records.set(current.id, { turnId: current.turnId, trace: { actions: [], evidence: [], history: [] }, truncated: false,
        task: { id: current.id, goal: current.text, status: current.status, createdAt: current.startedAt,
          updatedAt: current.startedAt, steps: current.steps, progress: { ...state.progress }, error: null,
          pendingOperation: null, result: null, resumedFrom: null, supersededBy: null } });
      this.currentId = current.id;
    }
    for (const [id, entry] of this.records) {
      const before = structuredClone(entry.task);
      const pending = state.pendingOperation;
      entry.task.pendingOperation = pending?.turnId === entry.turnId
        ? { id: pending.id, status: pending.status, tool: pending.tool } : null;
      if (current?.id === id) {
        entry.task.status = current.status; entry.task.steps = current.steps;
        // Manual input and Stop may change the global UI phase after a task ends.
        // They must not rewrite a completed task's result or cancellation reason.
        if (current.status === 'active' || current.status === 'blocked'
          || current.status === 'completed' && state.progress.phase === 'completed'
          || current.status === 'cancelled' && state.progress.phase === 'cancelled') entry.task.progress = { ...state.progress };
        entry.task.error = current.status === 'active' || current.status === 'blocked' ? state.error : null;
        if (current.status === 'completed' && !entry.task.result) {
          entry.task.result = { summary: entry.task.progress.message, verification: current.verification ?? null,
            evidenceIds: [...current.evidenceIds] };
        }
      }
      const incoming = this.runtime.taskTrace(id);
      const merge = <T extends { id: string }>(previous: T[], additions: T[], limit: number): T[] => {
        const merged = new Map(previous.map(item => [item.id, item]));
        for (const item of additions) merged.set(item.id, item);
        if (merged.size > limit) entry.truncated = true;
        return [...merged.values()].slice(-limit);
      };
      entry.trace.actions = merge(entry.trace.actions, incoming.actions, 180);
      entry.trace.evidence = merge(entry.trace.evidence, incoming.evidence, 24);
      entry.trace.history = merge(entry.trace.history, incoming.history, 150);
      if (!isDeepStrictEqual(before, entry.task)) entry.task.updatedAt = Date.now();
    }
    while (this.records.size > TASK_RETENTION) {
      const oldest = [...this.records].find(([id, entry]) => id !== current?.id && !entry.task.pendingOperation);
      if (!oldest) break;
      this.records.delete(oldest[0]);
      for (const [key, request] of this.requests) if (request.taskId === oldest[0]) this.requests.delete(key);
    }
  }

  list(): ComputerTaskRecord[] {
    this.sync(); return [...this.records.values()].reverse().map(entry => structuredClone(entry.task));
  }
  get(id: string): ComputerTaskRecord {
    this.sync();
    const entry = this.records.get(id);
    if (!entry) throw new ComputerApiError('task_not_found', '此任务不存在，或已超出当前服务进程的保留范围。', 404);
    return structuredClone(entry.task);
  }
  result(id: string) {
    const task = this.get(id);
    return { taskId: id, status: task.status, result: task.result, pendingOperation: task.pendingOperation };
  }
  trace(id: string) {
    const task = this.get(id), entry = this.records.get(id)!;
    return { task, ...structuredClone(entry.trace), truncated: entry.truncated,
      limits: { actions: 180, evidence: 24, history: 150 } };
  }

  private assertIdle(exceptTaskId?: string): void {
    const state = this.runtime.taskState();
    const ownPending = exceptTaskId && state.task?.id === exceptTaskId
      && state.pendingOperation?.turnId === this.records.get(exceptTaskId)?.turnId;
    if (state.task?.status === 'active' || state.manualPending
      || state.pendingOperation && !ownPending) {
      throw new ComputerApiError('computer_busy', '当前桌面已有任务或未结束的输入；请查询或停止该任务后再提交。');
    }
  }
  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    if (this.mutating) throw new ComputerApiError('computer_busy', '另一个任务控制请求尚未结束。');
    this.mutating = true;
    try { return await fn(); } finally { this.mutating = false; this.sync(); }
  }

  async create(goal: string, options: { requestId?: string; replace?: boolean } = {}): Promise<{ task: ComputerTaskRecord; replayed: boolean }> {
    const text = goal.trim();
    if (!text || text.length > 8000) throw new ComputerApiError('invalid_input', 'goal 应为 1–8000 个字符。', 400);
    const key = options.requestId;
    if (key !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new ComputerApiError('invalid_request_id', 'Idempotency-Key 必须是 1–128 个字母、数字或 . _ : -。', 400);
    return this.mutate(async () => {
      const previous = key ? this.requests.get(key) : undefined;
      if (previous) {
        if (previous.goal !== text) throw new ComputerApiError('idempotency_conflict', '相同 Idempotency-Key 不能用于不同的目标。');
        return { task: this.get(previous.taskId), replayed: true };
      }
      if (!options.replace) this.assertIdle();
      // submit admits the task synchronously; native discovery runs asynchronously.
      // Capture its identity before another request can change the current task.
      const submitted = this.runtime.submit(text);
      const id = this.runtime.taskState().task?.id;
      await submitted;
      if (!id) throw new AgentError('task_admission', '任务没有建立有效标识。');
      if (key) this.requests.set(key, { goal: text, taskId: id });
      return { task: this.get(id), replayed: false };
    });
  }

  async stop(id: string): Promise<ComputerTaskRecord> {
    const task = this.get(id), state = this.runtime.taskState();
    // A delayed stop for A must never stop a later task B. Repeated stops are safe.
    if (state.task?.id === id && (task.status !== 'completed' || task.pendingOperation)) {
      await this.runtime.stop();
    } else if (task.status === 'blocked') {
      const stored = this.records.get(id)!.task;
      stored.status = 'cancelled'; stored.error = null; stored.updatedAt = Date.now();
      stored.progress = { phase: 'cancelled', message: '任务已停止。', updatedAt: stored.updatedAt };
    }
    return this.get(id);
  }
  async stopCurrent(): Promise<void> { await this.runtime.stop(); this.sync(); }

  async resume(id: string): Promise<ComputerTaskRecord> {
    return this.mutate(async () => {
      const previous = this.get(id);
      if (!['blocked', 'cancelled'].includes(previous.status)) throw new ComputerApiError('task_not_resumable', '只有受阻或已停止的任务可以继续。');
      this.assertIdle(id);
      if (this.runtime.taskState().task?.id === id) await this.runtime.resume();
      else await this.runtime.submit(previous.goal);
      const current = this.runtime.taskState().task;
      if (!current || current.id === id) throw new ComputerApiError('task_admission', '继续操作没有建立新的执行轮次。');
      this.sync(); this.records.get(current.id)!.task.resumedFrom = id;
      return this.get(current.id);
    });
  }
}
