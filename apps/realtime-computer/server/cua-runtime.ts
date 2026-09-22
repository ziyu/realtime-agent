import { randomUUID, createHash } from 'node:crypto';
import { open as openFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Agent, AgentError } from '@realtime-agent/agent';
import type { ActionCall, AgentEvent, Candidate, DecisionResult, PreparedOperation, ProposalRecord } from '@realtime-agent/agent';
import { z } from 'zod';
import type { CuaResult } from './cua-transport.js';
import type { ComputerProviders } from './cua-models.js';
import { ComputerTools, checkCompletion, compactData, computerPlanSchema, fileVerificationTool, observationTools, record, windowsFrom } from './cua-policy.js';
import type { CuaConnection, ComputerEvidence, ComputerPlan, ComputerStep, ComputerWindow } from './cua-policy.js';

interface Task { id: string; text: string; status: 'active' | 'completed' | 'blocked' | 'cancelled'; steps: number; startedAt: number; turnId: string; evidenceIds: string[]; verification?: 'observed-data' | 'model-visual' }
interface Segment { id: string; plan: ComputerPlan; index: number }
interface Frame { id: string; bytes: Buffer; mimeType: string; width: number; height: number; capturedAt: number;
  windowId: string | null; target: Record<string, unknown>; captureId?: string; evidenceId: string }
interface World { id: string; capturedAt: number; windows: ComputerWindow[]; applications: unknown; activeWindowId: string | null; summary: string }
const control: Candidate[] = [{ id: 'wait', description: 'Wait', selection: { kind: 'wait' } }, { id: 'continue', description: 'Await the admitted Cua operation', selection: { kind: 'continue' } }];
const idle = (): DecisionResult => ({ selection: { kind: 'wait' }, channels: { computer: { kind: 'continue' } },
  interrupt: false, think: false, acceptProposal: false, complete: false });
const bindingSchema = z.object({ segment: z.string(), index: z.number().int().nonnegative(), step: z.object({
  tool: z.string(), arguments: z.record(z.string(), z.unknown()), purpose: z.string(),
}).strict() }).strict();

export interface ComputerRuntimeOptions { decisionIntervalMs?: number; taskTimeoutMs?: number; maxSteps?: number; progressTimeoutMs?: number }

/** A desktop goal owns a task, not a preselected HWND. All Cua effects share one Agent channel. */
export class CuaComputerRuntime {
  readonly agent: Agent<World>;
  readonly tools: ComputerTools;
  private world: World = { id: randomUUID(), capturedAt: 0, windows: [], applications: [], activeWindowId: null, summary: '' };
  private task: Task | null = null;
  private segment: Segment | null = null;
  private manual: ComputerStep | null = null;
  private route = '';
  private error: string | null = null;
  private connected = false;
  private closed = false;
  private preparing = false;
  private ioBusy = false;
  private inputPending = false;
  private generation = 0;
  private controller = new AbortController();
  private viewWindowId: string | null = null;
  private frames = new Map<string, Frame>();
  private evidence: ComputerEvidence[] = [];
  private history: { id: string; taskId: string | null; type: string; at: number; detail: string }[] = [];
  private taskListeners = new Set<() => void>();
  private trace: { id: string; taskId: string | null; tool: string; arguments: Record<string, unknown>; at: number; durationMs: number; isError: boolean; evidenceId: string }[] = [];
  private progress = { phase: 'idle', message: '输入目标，Agent 会自行发现并打开需要的应用。', updatedAt: Date.now() };
  private progressAt = performance.now();
  private taskClock = performance.now();
  private rejected = 0;
  private malformedPlans = 0;
  private repeated = 0;
  private previousFingerprint = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pending = new Set<Promise<unknown>>();
  private providers: ComputerProviders | null;
  private taskTimeout: number;
  private progressTimeout: number;
  private maxSteps: number;

  constructor(readonly driver: CuaConnection, providers: ComputerProviders | ((runtime: CuaComputerRuntime) => ComputerProviders) | null,
    readonly modelError: string | null = null, options: ComputerRuntimeOptions = {}) {
    this.tools = new ComputerTools([...driver.tools, fileVerificationTool]);
    this.taskTimeout = options.taskTimeoutMs ?? 15 * 60_000;
    this.progressTimeout = options.progressTimeoutMs ?? 120_000;
    this.maxSteps = options.maxSteps ?? 150;
    this.providers = typeof providers === 'function' ? providers(this) : providers;
    this.agent = new Agent({
      environment: { context: () => this.world, observe: () => this.modelState(), candidates: () => [control[0]], capabilities: [],
        channels: [{ id: 'computer', mode: 'async', deviceSessionId: randomUUID(), resources: ['cua:desktop'], onInput: 'cancel',
          candidates: () => this.candidates(), capabilities: [{ id: 'cua_tool', prepare: call => this.prepare(call) }] }],
      },
      fast: { decide: async (context, signal) => {
        if (this.manual) {
          const result = idle(), candidate = context.channels?.computer.candidates.find(item => item.selection.kind === 'execute');
          if (candidate) result.channels!.computer = candidate.selection;
          return result;
        }
        if (this.preparing || this.ioBusy || this.task?.status !== 'active' || !this.providers) return idle();
        return this.providers.fast.decide(context, signal);
      } },
      ...(this.providers ? { slow: this.providers.slow } : {}),
      decisionIntervalMs: options.decisionIntervalMs ?? 250, maxDecisionsPerMinute: 180,
      decisionTimeoutMs: 12000, thoughtTimeoutMs: 47000, thoughtIntervalMs: 250, proposalTtlMs: 60000, idleIntervalMs: 500,
      policies: { canThink: () => this.task?.status === 'active' && !this.segment && !this.manual && !this.preparing && !this.operation(),
        acceptProposal: proposal => this.accept(proposal), verifyCompletion: () => this.task?.status === 'completed' },
    });
    this.agent.subscribe(event => { this.onEvent(event); this.notifyTasks(); });
  }

  private operation() { return this.agent.channels.snapshot().computer.current; }
  private phase(phase: string, message: string): void {
    this.progress = { phase, message, updatedAt: Date.now() }; this.notifyTasks();
  }
  private log(type: string, detail: string, taskId: string | null = this.task?.id ?? null): void {
    this.history.push({ id: randomUUID(), taskId, type, at: Date.now(), detail: detail.slice(0, 2000) }); this.history = this.history.slice(-150);
    this.notifyTasks();
  }
  /** Observers project task state; they never own or retry an admitted device operation. */
  subscribeTasks(listener: () => void): () => void {
    this.taskListeners.add(listener); return () => { this.taskListeners.delete(listener); };
  }
  private notifyTasks(): void {
    for (const listener of this.taskListeners) { try { listener(); } catch { /* Projection failures cannot change execution. */ } }
  }
  taskState() {
    const operation = this.operation();
    return { task: structuredClone(this.task), progress: { ...this.progress }, error: this.error,
      manualPending: this.inputPending || this.manual !== null,
      pendingOperation: operation ? { id: operation.id, status: operation.status,
        turnId: operation.scope.turnId, tool: operation.call.target ?? null } : null };
  }
  taskTrace(taskId: string) {
    return { actions: structuredClone(this.trace.filter(item => item.taskId === taskId)),
      evidence: structuredClone(this.evidence.filter(item => item.taskId === taskId)),
      history: structuredClone(this.history.filter(item => item.taskId === taskId)) };
  }
  private modelState(): any {
    return JSON.parse(JSON.stringify({ task: this.task, desktop: this.world, refreshing: this.preparing,
      evidence: this.evidence.slice(-6), lastError: this.error,
      recentActions: this.trace.slice(-10).map(item => ({ id: item.id, tool: item.tool, arguments: item.arguments, isError: item.isError, evidenceId: item.evidenceId })),
      remaining: this.segment ? { summary: this.segment.plan.summary, step: this.segment.index } : null,
    }));
  }
  snapshot() {
    return { backend: 'cua' as const, connected: this.connected, mode: this.providers ? 'live' as const : 'manual' as const,
      modelReady: !!this.providers, modelError: this.modelError, task: structuredClone(this.task), error: this.error,
      modelCapabilities: this.providers?.capabilities?.() ?? { vision: 'off' },
      progress: { ...this.progress }, observation: structuredClone(this.world), viewWindowId: this.viewWindowId,
      history: structuredClone(this.history), agent: this.agent.snapshot(), metrics: this.agent.telemetry.summary(),
      driver: { version: String(this.driver.metadata.driverVersion ?? ''), platform: String(this.driver.metadata.platform ?? process.platform), toolCount: this.driver.tools.length },
    };
  }
  exportTrace() { return { ...this.snapshot(), evidence: structuredClone(this.evidence), actions: structuredClone(this.trace), timings: this.agent.telemetry.snapshot() }; }
  modelImage() {
    const frames = [...this.frames.values()].filter(frame => this.evidence.some(item => item.id === frame.evidenceId));
    const frame = frames.at(-1);
    return frame && frame.bytes.length <= 6 * 1024 * 1024 ? { mimeType: frame.mimeType, dataBase64: frame.bytes.toString('base64'), evidenceId: frame.evidenceId } : null;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.discover(this.controller.signal, true);
    this.connected = true;
    this.timer = setInterval(() => this.pump(), 100);
    this.tickTimer = setInterval(() => { if (!this.closed) this.agent.tick(.05); }, 50);
  }
  private pump(): void {
    if (this.closed || this.preparing || this.ioBusy || !this.connected || !(this.manual || this.task?.status === 'active')) return;
    if (this.task?.status === 'active' && (performance.now() - this.taskClock > this.taskTimeout || this.task.steps >= this.maxSteps)) {
      this.block('任务已达到本次时间或步骤预算，保留当前进度，可核对后继续。'); return;
    }
    if (performance.now() - this.progressAt > this.progressTimeout && !this.operation()) {
      this.block('任务长时间没有进展，已暂停。可查看记录、修正目标或继续。'); return;
    }
    void this.agent.decide().catch(error => { if (!this.closed) this.block(error instanceof AgentError ? error.message : '任务调度失败。'); });
  }
  private block(message: string): void {
    this.error = message;
    if (this.task?.status === 'active') this.task.status = 'blocked';
    this.segment = null; this.manual = null;
    this.phase('blocked', message); this.log('blocked', message);
    this.agent.pause(true);
  }

  async submit(text: string): Promise<void> {
    if (this.closed) throw new AgentError('closed', 'Computer 会话已关闭。', 0);
    if (this.inputPending) throw new AgentError('operation_pending', '正在处理手动接管，请等待本次输入回执。', 0);
    if (!this.providers) throw new AgentError('models_missing', this.modelError ?? '自动任务需要 System One 与 LLM 配置。', 0);
    const goal = text.trim();
    if (!goal || goal.length > 8000) throw new AgentError('invalid_input', '任务应为 1–8000 个字符。', 0);
    const generation = ++this.generation;
    this.controller.abort(); this.controller = new AbortController();
    this.segment = null; this.manual = null; this.error = null;
    this.agent.pause(false); const turn = this.agent.receive(goal);
    this.task = { id: randomUUID(), text: goal, status: 'active', steps: 0, turnId: turn.id, startedAt: Date.now(), evidenceIds: [] };
    this.taskClock = this.progressAt = performance.now(); this.rejected = 0; this.repeated = 0; this.malformedPlans = 0;
    this.phase('queued', '目标已接收，正在发现应用和桌面窗口。'); this.log('goal', goal);
    this.preparing = true;
    const pending = (async () => {
      try {
        // New goals do not race with an earlier admitted native side effect.
        if (this.operation() || this.ioBusy) await this.waitForOperation();
        if (generation !== this.generation || this.closed) return;
        await this.discover(this.controller.signal, true);
        if (generation !== this.generation || this.closed) return;
        this.connected = true; this.agent.wake();
      } catch (error) {
        if (generation === this.generation && !this.closed) this.block(this.message(error));
      } finally { if (generation === this.generation) { this.preparing = false; this.pump(); } }
    })();
    this.track(pending);
  }

  async stop(): Promise<void> {
    this.generation++; this.controller.abort(); this.preparing = false;
    this.segment = null; this.manual = null;
    if (this.task?.status === 'active' || this.task?.status === 'blocked') this.task.status = 'cancelled';
    this.agent.stop();
    this.phase('cancelled', this.operation() ? '已停止后续决策，正在核对已发出的操作。' : '任务已停止，实际操作结果保留。');
    this.log('stop', this.progress.message);
  }
  async resume(): Promise<void> {
    if (!this.task || !['blocked', 'cancelled'].includes(this.task.status)) throw new AgentError('no_task', '当前没有可继续的任务。', 0);
    if (this.operation()?.status === 'unknown' && !this.ioBusy) {
      const generation = this.generation;
      if (this.agent.channels.reconcile('computer', this.world)) await this.waitForOperation(10000);
      if (generation !== this.generation) throw new AgentError('superseded', '继续操作已被新的指令取消。', 0);
    }
    if (this.operation()) throw new AgentError('operation_pending', '上一操作结果仍未确认，请先核对或重启 Driver 会话。', 0);
    const text = this.task.text;
    // Keep the trace as actual evidence; the planner must reason about existing effects.
    await this.submit(text);
  }
  private track<T>(promise: Promise<T>): void { this.pending.add(promise); void promise.finally(() => this.pending.delete(promise)).catch(() => undefined); }
  private message(error: unknown): string {
    return error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 700) : 'Cua Driver 操作未完成。';
  }
  private async waitForOperation(timeoutMs = 35000): Promise<void> {
    const started = performance.now();
    while (this.operation() || this.ioBusy) {
      if (this.closed) throw new AgentError('closed', 'Computer 会话已关闭。', 0);
      if (performance.now() - started > timeoutMs) throw new AgentError('operation_pending', '上一操作未确认结束，已保留现场。', 0);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }

  private async rawCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    signal?.throwIfAborted();
    if (this.ioBusy) throw new AgentError('cua_busy', 'Driver 正在处理另一项操作。', 0);
    this.ioBusy = true;
    try { return await this.driver.call(name, args, signal); }
    catch (error) {
      if (['cua_closed', 'cua_worker_exit', 'cua_worker_failure', 'cua_worker_start', 'cua_protocol'].includes(String(record(error).code))) this.connected = false;
      throw error;
    }
    finally { this.ioBusy = false; }
  }
  private remember(name: string, args: Record<string, unknown>, result: CuaResult, taskId: string | null): ComputerEvidence {
    const projected = compactData(result.data, name === 'list_apps' ? 22000 : 24000);
    const evidence: ComputerEvidence = { id: randomUUID(), taskId, tool: name, arguments: structuredClone(args), capturedAt: Date.now(),
      data: projected.data, text: result.data ? '' : result.text.slice(0, 16000), isError: result.isError,
      truncated: projected.truncated, ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(typeof result.verified === 'boolean' ? { verified: result.verified } : {}),
      ...(typeof result.degraded === 'boolean' ? { degraded: result.degraded } : {}) };
    this.evidence.push(evidence); this.evidence = this.evidence.slice(-24);
    this.world.id = evidence.id; this.world.capturedAt = evidence.capturedAt; this.world.summary = `${name}${result.isError ? ' 返回错误' : ' 已更新'}`;
    if (!result.isError) {
      if (name === 'list_apps') {
        const apps = record(result.data).apps;
        // Keep every installed app discoverable even when a few verbose launcher
        // records exhaust the detailed evidence budget. Names are returned by
        // the driver and can be resolved directly by launch_app(name).
        this.world.applications = Array.isArray(apps) ? { names: apps.slice(0, 2000).map(app => {
          const item = record(app);
          return { name: String(item.name ?? '').slice(0, 200), running: item.running === true,
            ...(typeof item.pid === 'number' && item.pid > 0 ? { pid: item.pid } : {}) };
        }), count: apps.length, truncated: apps.length > 2000, details: projected.data } : projected.data;
      }
      if (name === 'list_windows') this.world.windows = windowsFrom(result.data);
      const resultWindows = windowsFrom(result.data);
      if (name === 'launch_app' && resultWindows.length) {
        const ids = new Set(resultWindows.map(window => window.id));
        this.world.windows = [...this.world.windows.filter(window => !ids.has(window.id)), ...resultWindows];
      }
      const front = [...this.world.windows].filter(window => window.zIndex !== null && !window.minimized).sort((a, b) => b.zIndex! - a.zIndex!)[0];
      this.world.activeWindowId = front?.id ?? this.world.activeWindowId;
      this.saveImages(name, args, result, evidence.id);
    }
    return evidence;
  }
  private async observeTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerEvidence> {
    const taskId = this.task?.id ?? null;
    const result = await this.rawCall(name, args, signal), evidence = this.remember(name, args, result, taskId);
    if (result.isError) throw new AgentError(result.errorCode ?? 'cua_observation', result.text.slice(0, 700) || 'Cua 无法读取桌面状态。', 0);
    return evidence;
  }
  private async discover(signal: AbortSignal, applications: boolean): Promise<void> {
    if (applications && this.tools.has('list_apps')) await this.observeTool('list_apps', {}, signal);
    await this.observeTool('list_windows', {}, signal);
    if (this.tools.has('get_desktop_state')) await this.observeTool('get_desktop_state', {}, signal);
  }

  private candidates(): Candidate[] {
    if (!this.connected || this.preparing || this.operation()) return control;
    const step = this.manual ?? this.segment?.plan.steps[this.segment.index];
    if (!step || !this.manual && this.task?.status !== 'active') return control;
    return [...control, { id: 'next-cua', description: `${step.purpose}\n${step.tool} ${JSON.stringify(step.arguments)}`,
      selection: { kind: 'execute', call: { capability: 'cua_tool', target: step.tool,
        input: JSON.parse(JSON.stringify({ segment: this.manual ? 'manual' : this.segment!.id, index: this.manual ? 0 : this.segment!.index, step })) } } }];
  }
  private accept(proposal: ProposalRecord): boolean {
    const metadata = record(proposal.value.metadata);
    const reject = (message: string): false => {
      this.error = message; this.log('replan', message);
      if (++this.rejected >= 4) this.block(`计划连续未能执行：${message}`);
      return false;
    };
    if (this.route === 'reject_plan') return reject('System One 要求修订计划或补充完成证据。');
    if (!this.task || this.task.status !== 'active' || metadata.taskId !== this.task.id || proposal.scope.turnId !== this.task.turnId) return reject('提议对应的任务已变化。');
    const parsed = computerPlanSchema.safeParse(metadata.plan);
    if (!parsed.success) return reject('规划输出格式无效。');
    const plan = parsed.data;
    if (plan.completion) {
      const imageId = this.providers?.capabilities?.().vision === 'enabled' && [...this.frames.values()].some(frame => frame.evidenceId === metadata.imageEvidenceId)
        ? String(metadata.imageEvidenceId) : undefined;
      if (!checkCompletion(plan, this.evidence, this.task.startedAt, this.task.id, imageId)) return reject('完成证据不匹配实际观察，请重新检查保存结果和目标内容。');
      this.task.status = 'completed'; this.task.evidenceIds = [...plan.completion.checks.map(check => check.evidenceId), ...(plan.completion.visual ? [plan.completion.visual.evidenceId] : [])];
      this.task.verification = plan.completion.visual ? 'model-visual' : 'observed-data';
      this.phase('completed', plan.completion.summary); this.log('verified', plan.completion.summary); return true;
    }
    if (plan.blocked) { this.block(plan.blocked); return false; }
    try { for (const step of plan.steps) this.tools.validate(step); }
    catch (error) { return reject(this.message(error)); }
    for (const step of plan.steps) {
      if (!['click', 'double_click', 'right_click', 'drag', 'move_cursor'].includes(step.tool)
        || typeof step.arguments.x !== 'number' && typeof step.arguments.y !== 'number') continue;
      const frame = [...this.frames.values()].find(item => item.evidenceId === metadata.imageEvidenceId);
      if (!frame || metadata.perception !== 'vision' || Date.now() - frame.capturedAt > 60000) return reject('像素操作缺少本次规划使用的有效截图。');
      const target = record(step.arguments.target);
      const window = target.window_id ?? step.arguments.window_id;
      if (frame.windowId !== (window === undefined ? null : String(window))) return reject('像素坐标与截图目标不一致，请重新获取目标窗口截图。');
      const x = step.arguments.x, y = step.arguments.y;
      if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || y < 0 || x >= frame.width || y >= frame.height) return reject('像素坐标超出了实际截图范围。');
    }
    this.segment = { id: proposal.id, plan, index: 0 }; this.rejected = 0;
    this.phase('reviewing', '计划已通过检查，System One 正在选择当前动作。'); return true;
  }
  private prepare(call: ActionCall): PreparedOperation<World> {
    const candidate = this.candidates().find(item => item.selection.kind === 'execute');
    const binding = bindingSchema.parse(call.input);
    if (!candidate || candidate.selection.kind !== 'execute' || !isDeepStrictEqual(candidate.selection.call, call)) {
      throw new AgentError('stale_candidate', '操作提议已经更新。', 0);
    }
    this.tools.validate(binding.step);
    const taskId = this.task?.id ?? null, goal = this.task?.text ?? '';
    let sequence = 0, settled = false;
    return { maxDurationMs: 60000, interruptibility: 'checkpoint', dispatch: async (_world, operation, report) => {
      const start = performance.now();
      try {
        operation.signal.throwIfAborted();
        const result = binding.step.tool === 'verify_file' ? await this.verifyFile(binding.step.arguments, goal, operation.signal)
          : await this.rawCall(binding.step.tool, binding.step.arguments, operation.signal);
        const evidence = this.remember(binding.step.tool, binding.step.arguments, result, taskId);
        this.trace.push({ id: operation.operationId, taskId, tool: binding.step.tool,
          arguments: binding.step.arguments, at: Date.now(), durationMs: performance.now() - start, isError: result.isError, evidenceId: evidence.id });
        this.trace = this.trace.slice(-180);
        // Read the new window set after actions. New dialogs and launched apps are
        // task observations, never pinned to the preview selection.
        if (!operation.signal.aborted && !result.isError && !observationTools.has(binding.step.tool) && binding.step.tool !== 'verify_file') {
          try {
            await this.observeTool('list_windows', {}, operation.signal);
            await this.observeTool('get_desktop_state', {}, operation.signal);
          } catch (error) { if (!operation.signal.aborted) this.log('observation', this.message(error)); }
        }
        settled = true;
        report({ sequence: ++sequence, status: result.isError ? 'failed' : 'completed', effect: result.isError ? 'unknown' : observationTools.has(binding.step.tool) || binding.step.tool === 'verify_file' ? 'none' : 'committed',
          evidenceIds: [evidence.id], result: { tool: binding.step.tool, evidenceId: evidence.id, isError: result.isError,
            ...(result.errorCode ? { errorCode: result.errorCode } : {}), message: result.text.slice(0, 1000), businessSuccess: false } });
      } catch (error) {
        settled = true;
        const uncertain = record(error).mayHaveExecuted === true;
        this.error = this.message(error); this.log('tool-error', this.error, taskId);
        report({ sequence: ++sequence, status: uncertain ? 'unknown' : operation.signal.aborted ? 'cancelled' : 'failed', effect: uncertain ? 'unknown' : 'none',
          result: { tool: binding.step.tool, message: this.error, outcomeUnknown: uncertain } });
      }
    }, cancel() { /* Agent's signal is forwarded to Cua. A cancellation request is not proof of no effect. */ },
    reconcile: async (_world, _operation, report) => {
      if (!settled || this.ioBusy) return;
      await this.discover(new AbortController().signal, false);
      report({ sequence: ++sequence, status: 'failed', effect: 'unknown', result: { reconciled: true, businessSuccess: false } });
    } };
  }

  private async verifyFile(args: Record<string, unknown>, goal: string, signal: AbortSignal): Promise<CuaResult> {
    signal.throwIfAborted();
    const path = typeof args.path === 'string' ? args.path : '';
    const source = process.platform === 'win32' ? goal.toLowerCase() : goal;
    const wanted = process.platform === 'win32' ? path.toLowerCase() : path;
    const boundary = (value: string) => value === '' || /[\s"'“”‘’`。，；、！!？?（）()<>]/u.test(value);
    let authorized = false;
    if (wanted) for (let at = source.indexOf(wanted); at >= 0; at = source.indexOf(wanted, at + wanted.length)) {
      if (boundary(at > 0 ? source[at - 1] : '') && boundary(source[at + wanted.length] ?? '')) { authorized = true; break; }
    }
    if (!isAbsolute(path) || !authorized) {
      return { text: 'verify_file 只能读取用户目标中明确给出的绝对输出路径；也可通过应用重新打开文件核对。', data: null, images: [], isError: true, errorCode: 'verification_path' };
    }
    const filename = resolve(path);
    let file;
    try {
      file = await openFile(filename, 'r'); const info = await file.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('文件不存在、不是普通文件或超过 1 MiB 文本核对上限。');
      const bytes = Buffer.alloc(info.size); let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const chunk = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!chunk.bytesRead) throw new Error('File changed while reading.');
        offset += chunk.bytesRead;
      }
      const afterRead = await file.stat();
      if (afterRead.size !== info.size || afterRead.mtimeMs !== info.mtimeMs) throw new Error('File changed while reading.');
      signal.throwIfAborted();
      const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '');
      return { text: '已只读检查实际保存文件。', data: { path: filename, exists: true, byteLength: bytes.length,
        text, sha256: createHash('sha256').update(bytes).digest('hex') }, images: [], isError: false };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return { text: record(error).code === 'ENOENT' ? '输出文件尚不存在。' : '输出文件无法读取。',
        data: { path: filename, exists: false }, images: [], isError: true, errorCode: 'file_not_verified' };
    } finally { await file?.close(); }
  }

  private onEvent(event: AgentEvent): void {
    if (event.type === 'decision-started' && this.task?.status === 'active' && !this.preparing && !this.operation()) this.phase('deciding', 'System One 正在选择下一步。');
    if (event.type === 'decision-resolved') {
      this.route = String(record(event.result.metadata).route ?? '');
      if (this.route === 'replan') { this.segment = null; this.log('replan', '正在根据实际结果重新规划。'); }
      if (this.route === 'blocked') this.block(String(record(this.agent.snapshot().proposal?.value.metadata).plan?.blocked ?? 'System One 未找到可继续的动作。'));
    }
    if (event.type === 'thought-started') { this.phase('planning', 'LLM 正在根据应用、窗口和执行结果规划。'); this.log('planning', '规划下一段操作。'); }
    if (event.type === 'proposal-created') { this.phase('reviewing', event.proposal.value.summary); this.log('plan', event.proposal.value.summary); }
    if (event.type === 'proposal-accepted' || event.type === 'proposal-rejected') this.agent.wake();
    if (event.type === 'error' && this.task?.status === 'active') {
      this.error = event.message;
      if (event.code === 'invalid_plan' && ++this.malformedPlans <= 2) {
        this.phase('planning', '规划格式有误，正在把校验结果反馈给模型修正。');
        this.log('replan', event.message); this.agent.wake();
      } else this.block(`${event.message} 可核对配置或现场后继续任务。`);
    }
    if (event.type !== 'channel-progress' || event.channel !== 'computer') return;
    const binding = bindingSchema.safeParse(event.receipt.call.input);
    if (!binding.success) return;
    if (!event.terminal) {
      if (event.receipt.status === 'dispatched') { this.phase('executing', binding.data.step.purpose); this.log('action', `${binding.data.step.tool}：${binding.data.step.purpose}`); }
      if (event.receipt.status === 'unknown') {
        if (this.task?.status === 'active') this.task.status = 'blocked';
        this.phase('blocked', '操作结果不确定，禁止自动重复。请核对现场后继续或重新连接。');
      }
      return;
    }
    if (binding.data.segment === 'manual') {
      this.manual = null;
      this.phase(event.receipt.status === 'completed' ? 'idle' : 'blocked', event.receipt.status === 'completed'
        ? '手动操作已完成，已收到 Cua 回执。' : '手动操作未确认成功，请核对现场。');
      this.log('manual-result', this.progress.message);
    }
    if (this.task?.status !== 'active' || event.receipt.scope.turnId !== this.task.turnId) return;
    const result = record(event.receipt.result);
    if (event.receipt.status !== 'completed') {
      this.segment = null; this.error = String(result.message ?? this.error ?? '工具执行未确认成功。');
      this.log('replan', this.error);
      const failedStep = binding.data.step;
      const backgroundUnavailable = result.errorCode === 'background_unavailable'
        || failedStep.tool === 'hotkey' && this.error.includes('could not find a UIA AcceleratorKey');
      if (backgroundUnavailable && failedStep.arguments.delivery_mode !== 'foreground') {
        // The same known operation is offered as a new explicit System One
        // choice. Nothing is dispatched automatically, and Cua's immutable
        // permission policy still governs the alternative delivery mode.
        const alternative = { ...failedStep, arguments: { ...failedStep.arguments, delivery_mode: 'foreground' },
          purpose: `Cua 已确认后台输入不可用；在同一目标上尝试前台输入：${failedStep.purpose}` };
        this.tools.validate(alternative);
        this.segment = { id: randomUUID(), index: 0, plan: { summary: alternative.purpose, steps: [alternative], completion: null, blocked: null } };
        this.phase('deciding', '后台输入不可用，System One 将判断是否采用该目标的前台输入。');
        this.agent.wake(); return;
      }
      if (['permission_denied', 'approval_required'].includes(String(result.errorCode)) || ++this.rejected >= 4) this.block(this.error);
      else this.agent.wake();
      return;
    }
    this.task.steps++; this.progressAt = performance.now();
    if (!observationTools.has(binding.data.step.tool)) this.error = null;
    const current = this.evidence.find(item => item.id === result.evidenceId);
    const fingerprint = JSON.stringify([binding.data.step.tool, binding.data.step.arguments, current?.data]);
    this.repeated = fingerprint === this.previousFingerprint ? this.repeated + 1 : 0; this.previousFingerprint = fingerprint;
    if (this.repeated >= 4) { this.block('同一操作多次没有改变实际结果，已暂停重复执行。'); return; }
    if (this.segment?.id === binding.data.segment) {
      this.segment.index++;
      if (this.segment.index >= this.segment.plan.steps.length) this.segment = null;
    }
    this.phase('verifying', '已收到 Cua 实际结果，正在核对下一步。');
    this.agent.wake();
  }

  private saveImages(name: string, args: Record<string, unknown>, result: CuaResult, evidenceId: string): void {
    const image = result.images[0]; if (!image) return;
    const bytes = Buffer.from(image.dataBase64, 'base64');
    if (image.mimeType !== 'image/png' || bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return;
    const data = record(result.data), windowId = args.window_id ?? record(args.target).window_id ?? data.window_id;
    const target = windowId !== undefined ? { kind: 'window', pid: args.pid ?? record(args.target).pid ?? data.pid, window_id: windowId }
      : { kind: 'desktop', display_id: 'primary' };
    const frame: Frame = { id: randomUUID(), bytes, mimeType: image.mimeType, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
      capturedAt: Date.now(), windowId: windowId === undefined ? null : String(windowId), target,
      captureId: typeof data.capture_id === 'string' ? data.capture_id : undefined, evidenceId };
    this.frames.set(frame.id, frame); while (this.frames.size > 8) this.frames.delete(this.frames.keys().next().value!);
  }
  async view(windowId: string | null): Promise<void> {
    if (windowId !== null && !this.world.windows.some(window => window.id === windowId)) throw new AgentError('window_missing', '窗口列表已变化，请刷新。', 0);
    this.viewWindowId = windowId;
  }
  async screen(): Promise<Frame> {
    const view = this.viewWindowId;
    let frame = [...this.frames.values()].findLast(item => item.windowId === view);
    if (!this.ioBusy && !this.preparing && !this.operation() && !this.agent.snapshot().decisionBusy && !this.agent.snapshot().thoughtBusy
      && (!frame || Date.now() - frame.capturedAt > 900)) {
      const window = this.world.windows.find(item => item.id === view);
      const args = window ? { pid: window.pid, window_id: Number(window.id), include_accessibility_tree: false, include_screenshot: true } : {};
      const name = window ? 'get_window_state' : 'get_desktop_state';
      const result = await this.rawCall(name, args);
      if (!result.isError) this.saveImages(name, args, result, 'preview');
      frame = [...this.frames.values()].findLast(item => item.windowId === view);
    }
    if (!frame) throw new AgentError('screen_pending', '正在等待 Cua Driver 的真实截图。', 0);
    return frame;
  }
  async input(raw: unknown): Promise<void> {
    const input = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('click'), x: z.number().int(), y: z.number().int(), frameId: z.string() }).strict(),
      z.object({ kind: z.literal('scroll'), x: z.number().int(), y: z.number().int(), delta: z.number().int(), frameId: z.string() }).strict(),
      z.object({ kind: z.literal('type'), text: z.string().min(1).max(8000) }).strict(),
      z.object({ kind: z.literal('key'), keys: z.array(z.string().min(1).max(40)).min(1).max(5) }).strict(),
    ]).parse(raw);
    if (this.closed || !this.connected) throw new AgentError('closed', 'Cua Driver 未连接。', 0);
    if (this.inputPending) throw new AgentError('operation_pending', '上一手动输入正在接管或执行。', 0);
    const frame = 'frameId' in input ? this.frames.get(input.frameId) : [...this.frames.values()].findLast(item => item.windowId === this.viewWindowId);
    if (!frame || 'frameId' in input && Date.now() - frame.capturedAt > 6000) throw new AgentError('stale_frame', '请等待一张新的截图再操作。', 0);
    if ('x' in input && (input.x < 0 || input.y < 0 || input.x >= frame.width || input.y >= frame.height)) throw new AgentError('invalid_coordinates', '点击或滚动位置超出了这张截图。', 0);
    let target = frame.target;
    if (input.kind === 'key' || input.kind === 'type') {
      const active = this.world.windows.find(window => window.id === this.world.activeWindowId);
      if (frame.windowId === null && active) target = { kind: 'window', pid: active.pid, window_id: Number(active.id) };
    }
    const arguments_: Record<string, unknown> = { target, delivery_mode: 'foreground' };
    let tool: string;
    if (input.kind === 'click') { tool = 'click'; Object.assign(arguments_, { x: input.x, y: input.y }); }
    else if (input.kind === 'scroll') { tool = 'scroll'; Object.assign(arguments_, { x: input.x, y: input.y,
      direction: input.delta > 0 ? 'up' : 'down', amount: Math.min(50, Math.max(1, Math.ceil(Math.abs(input.delta) / 120))), by: 'line' }); }
    else if (input.kind === 'type') { tool = 'type_text'; arguments_.text = input.text; }
    else {
      const keys = input.keys.map(key => ({ enter: 'return', esc: 'escape', control: 'ctrl' }[key.toLowerCase()] ?? key.toLowerCase()));
      tool = keys.length === 1 ? 'press_key' : 'hotkey'; if (tool === 'press_key') arguments_.key = keys[0]; else arguments_.keys = keys;
    }
    const step = { tool, arguments: arguments_, purpose: '执行用户手动输入' };
    this.tools.validate(step);
    this.inputPending = true;
    try {
      const generation = this.generation + 1;
      await this.stop();
      if (this.operation() || this.ioBusy) await this.waitForOperation(8000);
      if (this.generation !== generation || this.closed) throw new AgentError('superseded', '手动接管已被停止或更新。', 0);
      if ('frameId' in input && Date.now() - frame.capturedAt > 6000) throw new AgentError('stale_frame', '等待期间截图已过期，请根据新截图再次选择。', 0);
      this.agent.pause(false); this.agent.receive('用户手动接管桌面'); this.manual = step; this.progressAt = performance.now(); this.agent.wake(); this.pump();
    } finally { this.inputPending = false; }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.generation++; this.controller.abort();
    if (this.timer) clearInterval(this.timer); if (this.tickTimer) clearInterval(this.tickTimer);
    this.agent.dispose(); await this.driver.close(); await Promise.allSettled([...this.pending]);
    this.frames.clear(); this.taskListeners.clear();
  }
}
