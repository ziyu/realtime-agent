import { createHash, randomUUID } from 'node:crypto';
import { Agent, AgentError } from '@realtime-agent/agent';
import type { ActionCall, AgentEvent, Candidate, DecisionResult, PreparedOperation, ProposalRecord } from '@realtime-agent/agent';
import type { DesktopCommand, DesktopDriver, DesktopObservation } from './desktop-types.js';
import type { DesktopProviders } from './desktop-providers.js';
import type { DesktopRoute } from './desktop-decision.js';
import { desktopCommandSchema, desktopInputSchema, desktopPlanSchema, elementVersion, layoutVersion, resolveDesktopAction, validateDesktopCommand, verifyDesktopPlan, windowVersion } from './desktop-model.js';
import type { DesktopPlan } from './desktop-model.js';
import { asJson } from './model.js';

interface DesktopTask {
  id: string; text: string; windowId: string; turnId: string;
  status: 'active' | 'completed' | 'cancelled' | 'needs-review';
  steps: number; segments: number; evidenceIds: string[];
}
interface AcceptedPlan { id: string; taskId: string; value: DesktopPlan; index: number; windowVersion: string; layoutVersion: string; expiresAt: number }
interface ManualInput { id: string; command: DesktopCommand; turnId: string }
interface DesktopWorld { observation: DesktopObservation | null }
export type DesktopPhase = 'idle' | 'queued' | 'deciding' | 'planning' | 'reviewing' | 'executing' | 'verifying' | 'blocked' | 'completed' | 'cancelled';
const controls: Candidate[] = [
  { id: 'wait', description: 'Wait and stop incompatible input. A pending operation must still settle.', selection: { kind: 'wait' } },
  { id: 'continue', description: 'Allow the already dispatched native input to settle without repeating it.', selection: { kind: 'continue' } },
];
const waitDecision = (): DecisionResult => ({ selection: { kind: 'wait' }, interrupt: false, think: false,
  acceptProposal: false, complete: false, channels: { computer: { kind: 'continue' } } });

/** One shared Agent controls the actual desktop through a native asynchronous channel. */
export class DesktopRuntime {
  readonly agent: Agent<DesktopWorld>;
  private world: DesktopWorld = { observation: null };
  private selectedWindowId: string | null = null;
  private task: DesktopTask | null = null;
  private plan: AcceptedPlan | null = null;
  private manual: ManualInput | null = null;
  private connected = false;
  private error: string | null = null;
  private sequence = 0;
  private refreshPending: Promise<void> | null = null;
  private recent = new Map<string, DesktopObservation>();
  private pending = new Set<Promise<void>>();
  private frames = new Map<string, { windowId: string | null; windowVersion: string | null; layoutVersion: string | null; capturedAt: number }>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private closed = false;
  private lastResult: string | null = null;
  private progress = { phase: 'idle' as DesktopPhase, message: '选择目标窗口并输入任务。', updatedAt: Date.now() };
  private lastProgressAt = performance.now();
  private idleDecisions = 0;
  private rejectedPlans = 0;
  private decisions = 0;
  private reviewRoute: DesktopRoute | null = null;
  private controlGeneration = 0;
  private progressTimeout: number;
  private idleLimit: number;
  private history: { id: string; type: string; at: number; detail: string; operationId?: string }[] = [];

  constructor(readonly driver: DesktopDriver, private providers: DesktopProviders | null, readonly modelError: string | null = null,
    options: { decisionIntervalMs?: number; progressTimeoutMs?: number; maxIdleDecisions?: number } = {}) {
    this.progressTimeout = options.progressTimeoutMs ?? 45000;
    this.idleLimit = options.maxIdleDecisions ?? 3;
    if (!Number.isFinite(this.progressTimeout) || this.progressTimeout <= 0 || !Number.isInteger(this.idleLimit) || this.idleLimit < 1) {
      throw new AgentError('configuration', '任务等待期限与停滞次数必须为正数。');
    }
    this.agent = new Agent({
      environment: { context: () => this.world, observe: () => asJson({ task: this.task, desktop: this.world.observation,
        planPending: !!this.plan, plan: this.plan ? { summary: this.plan.value.summary,
          next: this.plan.value.actions[this.plan.index] ?? null, remaining: this.plan.value.actions.length - this.plan.index } : null,
        lastResult: this.lastResult, lastError: this.error }), candidates: () => [controls[0]], capabilities: [],
        channels: [{ id: 'computer', mode: 'async', deviceSessionId: driver.deviceSessionId,
          resources: ['windows:pointer', 'windows:keyboard'], onInput: 'cancel', candidates: () => this.candidates(),
          capabilities: [{ id: 'desktop_input', prepare: call => this.prepare(call) }] }],
      },
      fast: { decide: (context, signal) => {
        if (this.manual) {
          const result = waitDecision();
          const selected = context.channels?.computer.candidates.find(candidate => candidate.selection.kind === 'execute');
          if (selected) result.channels!.computer = selected.selection;
          result.metadata = { source: 'explicit-user-input' };
          return Promise.resolve(result);
        }
        if (this.task?.status !== 'active' || !this.providers) return Promise.resolve(waitDecision());
        return this.providers.fast.decide(context, signal);
      } },
      ...(providers ? { slow: providers.slow } : {}), decisionIntervalMs: options.decisionIntervalMs ?? 300,
      maxDecisionsPerMinute: 180, decisionTimeoutMs: 6000, thoughtIntervalMs: 1000, thoughtTimeoutMs: 22000,
      idleIntervalMs: 500, policies: { canThink: () => !this.manual && this.task?.status === 'active'
        && !this.plan && !this.currentOperation() && this.connected,
      acceptProposal: proposal => this.accept(proposal), verifyCompletion: () => this.task?.status === 'completed' },
    });
    this.agent.subscribe(event => this.onEvent(event));
  }
  private currentOperation() { return this.agent.channels.snapshot().computer.current; }
  private phase(phase: DesktopPhase, message: string): void {
    if (this.progress.phase !== phase || this.progress.message !== message) this.progress = { phase, message, updatedAt: Date.now() };
  }
  private block(message: string): void {
    this.error = message;
    if (this.task?.status === 'active') this.task.status = 'needs-review';
    this.manual = null; this.plan = null;
    this.phase('blocked', message); this.log('blocked', message);
    this.agent.pause(true);
  }
  private pump(): void {
    if (this.closed || !this.connected || !(this.manual || this.task?.status === 'active')) return;
    if (this.task?.status === 'active' && performance.now() - this.lastProgressAt >= this.progressTimeout && !this.currentOperation()) {
      this.block('任务长时间没有取得进展，已停止请求。请查看错误与窗口内容，调整任务后重新开始。'); return;
    }
    this.expirePlan();
    void this.agent.decide().catch(error => {
      if (!this.closed) this.block(error instanceof AgentError ? error.message : '任务调度未完成，请重新开始。');
    });
  }
  private log(type: string, detail: string, operationId?: string): void {
    this.history.push({ id: randomUUID(), type, detail, at: Date.now(), ...(operationId ? { operationId } : {}) });
    this.history = this.history.slice(-120);
  }
  snapshot() {
    return { backend: 'windows' as const, mode: this.providers ? 'live' : 'manual', connected: this.connected,
      modelReady: !!this.providers, modelError: this.modelError, observation: this.world.observation,
      selectedWindowId: this.selectedWindowId, task: this.task, agent: this.agent.snapshot(),
      history: structuredClone(this.history), metrics: this.agent.telemetry.summary(), error: this.error, progress: { ...this.progress },
      plan: this.plan ? { summary: this.plan.value.summary, step: this.plan.index, total: this.plan.value.actions.length } : null };
  }
  async start(): Promise<void> {
    if (this.timers.length) return;
    await this.refresh();
    if (!this.connected) throw new AgentError('desktop_unavailable', this.error ?? '无法连接 Windows 桌面。');
    this.timers.push(setInterval(() => { if (!this.closed) this.agent.tick(.05); }, 50));
    this.timers.push(setInterval(() => { void this.refresh(); }, 650));
    this.timers.push(setInterval(() => this.pump(), 100));
  }
  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.refreshPending) return this.refreshPending;
    const selected = this.selectedWindowId;
    this.refreshPending = this.driver.observe(selected).then(observation => {
      if (!this.closed && selected === this.selectedWindowId) { this.connected = true; this.ingest(observation); }
    }).catch(() => {
      if (!this.closed && selected === this.selectedWindowId) {
        this.connected = false; this.error = '桌面观察暂不可用。检查当前 Windows 会话是否可交互、窗口是否仍存在。';
        // A sensor failure must not leave an 'active' task paused forever after reconnection.
        this.block(this.error);
      }
    }).finally(() => { this.refreshPending = null; });
    return this.refreshPending;
  }
  private ingest(observation: DesktopObservation): void {
    if (this.closed || observation.selectedWindowId !== this.selectedWindowId) return;
    const previous = this.world.observation;
    if (previous && observation.capturedAt < previous.capturedAt) return;
    this.world.observation = observation;
    this.recent.set(observation.id, structuredClone(observation));
    while (this.recent.size > 64) this.recent.delete(this.recent.keys().next().value!);
    const entities: Record<string, string> = {};
    const version = (value: string | null) => createHash('sha256').update(value ?? 'missing').digest('hex');
    if (this.selectedWindowId) entities.window = version(windowVersion(observation, this.selectedWindowId));
    for (const element of observation.elements.slice(0, 128)) entities[`element:${element.id}`] = version(elementVersion(observation, element.id));
    const changed = !previous || JSON.stringify([previous.foregroundWindowId, previous.elements, previous.windows])
      !== JSON.stringify([observation.foregroundWindowId, observation.elements, observation.windows]);
    this.agent.observe({ id: observation.id, source: 'desktop', sequence: ++this.sequence, capturedAt: observation.capturedAt,
      clockUncertaintyMs: 0, maxAgeMs: 6500, facts: { windowId: this.selectedWindowId, foregroundWindowId: observation.foregroundWindowId },
      entities, provenance: 'sensor' }, { wake: changed });
    if (this.plan && !this.currentOperation() && this.selectedWindowId && this.plan.windowVersion !== windowVersion(observation, this.selectedWindowId)) {
      this.plan = null; this.agent.invalidate(); this.log('replan', '窗口位置或身份变化，正在重新观察。');
    }
  }
  async selectWindow(windowId: string | null): Promise<void> {
    if (windowId !== null && !this.world.observation?.windows.some(window => window.id === windowId)) {
      throw new AgentError('window_closed', '窗口列表已变化，请刷新后重新选择。', 0);
    }
    await this.stop();
    this.selectedWindowId = windowId; this.world.observation = null; this.recent.clear(); this.agent.observations.clear();
    if (this.refreshPending) await this.refreshPending;
    await this.refresh(); this.error = this.connected ? null : this.error;
  }
  async submit(text: string): Promise<void> {
    if (!this.providers) throw new AgentError('models_missing', '当前可手动操控真实桌面。自动任务需要配置 System One 和 LLM。', 0);
    const input = text.trim();
    if (!input || input.length > 4000) throw new AgentError('invalid_input', '任务长度应为 1–4000 个字符。', 0);
    const generation = ++this.controlGeneration;
    await this.refresh();
    if (generation !== this.controlGeneration || this.closed) throw new AgentError('superseded', '此任务已被停止或更新。', 0);
    if (!this.connected || !this.selectedWindowId || !this.world.observation?.windows.some(window => window.id === this.selectedWindowId)) {
      throw new AgentError('window_scope', '请先选择要操作的真实窗口。', 0);
    }
    this.plan = null; this.manual = null; this.error = null; this.lastResult = null;
    this.idleDecisions = 0; this.rejectedPlans = 0; this.decisions = 0; this.lastProgressAt = performance.now();
    this.agent.pause(false); const turn = this.agent.receive(input);
    this.task = { id: randomUUID(), text: input, windowId: this.selectedWindowId, turnId: turn.id,
      status: 'active', steps: 0, segments: 0, evidenceIds: [] };
    this.phase('queued', '任务已接收，正在选择下一步。');
    this.log('goal', input); this.agent.wake(); this.pump();
  }
  async input(raw: unknown, frameId?: string): Promise<void> {
    const command = desktopCommandSchema.parse(raw);
    if (this.currentOperation() || this.manual) throw new AgentError('operation_busy', '上一项输入仍在执行或核对，请稍后再试。', 0);
    const generation = this.controlGeneration;
    await this.refresh();
    if (generation !== this.controlGeneration || this.closed) throw new AgentError('superseded', '此输入已被停止或更新。', 0);
    if (this.currentOperation() || this.manual) throw new AgentError('operation_busy', '上一项输入仍在执行或核对，请稍后再试。', 0);
    if (!this.connected || !this.world.observation) throw new AgentError('desktop_unavailable', '桌面尚未连接。', 0);
    if (frameId) {
      const frame = this.frames.get(frameId);
      if (!frame || frame.windowId !== this.selectedWindowId || Date.now() - frame.capturedAt > 5000
        || frame.windowVersion !== windowVersion(this.world.observation, command.windowId)
        || frame.layoutVersion !== layoutVersion(this.world.observation)) {
        throw new AgentError('stale_screen', '截图已过期或窗口已移动，请等待新画面后再操作。', 0);
      }
    }
    validateDesktopCommand(command, this.world.observation, this.selectedWindowId);
    this.plan = null; this.error = null;
    if (this.task?.status === 'active') this.task.status = 'cancelled';
    this.agent.pause(false); const turn = this.agent.receive(`手动桌面操作：${command.kind}`);
    this.manual = { id: randomUUID(), command, turnId: turn.id };
    this.log('manual', `执行手动操作：${command.kind}`); this.agent.wake();
    await this.agent.decide();
  }
  async stop(): Promise<void> {
    this.controlGeneration++;
    this.manual = null; this.plan = null;
    if (this.task?.status === 'active') this.task.status = 'cancelled';
    this.agent.stop();
    this.phase('cancelled', this.currentOperation() ? '已停止后续操作，等待已发送输入的真实回执。' : '已停止。');
    await this.driver.release();
  }
  reconcile(): boolean { return this.agent.channels.reconcile('computer', this.world); }
  async screen() {
    const windowId = this.selectedWindowId;
    const observedWindow = this.world.observation?.windows.find(window => window.id === windowId);
    const version = windowId && this.world.observation ? windowVersion(this.world.observation, windowId) : null;
    const layout = this.world.observation ? layoutVersion(this.world.observation) : null;
    const frame = await this.driver.screen(windowId);
    const sameBounds = observedWindow && ['x', 'y', 'width', 'height'].every(key =>
      observedWindow.bounds[key as keyof typeof frame.bounds] === frame.bounds[key as keyof typeof frame.bounds]);
    const id = randomUUID();
    // Bind to geometry observed before the capture. If the native capture already
    // reflects another rectangle, it may be displayed but cannot authorize input.
    this.frames.set(id, { windowId, windowVersion: sameBounds ? version : null, layoutVersion: layout, capturedAt: frame.capturedAt });
    while (this.frames.size > 12) this.frames.delete(this.frames.keys().next().value!);
    return { ...frame, id, windowId };
  }
  private expirePlan(): void {
    const observation = this.world.observation;
    const changedLayout = this.plan && observation && this.plan.value.actions.slice(this.plan.index).some(action => action.kind === 'click_position')
      && this.plan.layoutVersion !== layoutVersion(observation);
    const unavailableControl = this.plan && observation && this.plan.value.actions[this.plan.index]?.kind === 'click'
      && !observation.elements.some(element => element.id === (this.plan!.value.actions[this.plan!.index] as { elementId: string }).elementId && element.enabled && !element.offscreen);
    if (this.plan && (performance.now() >= this.plan.expiresAt || changedLayout || unavailableControl) && !this.currentOperation()) {
      this.plan = null; this.agent.wake(); this.log('replan', '计划已过期，重新读取现场。');
    }
  }
  private candidates(): Candidate[] {
    const observation = this.world.observation, windowId = this.selectedWindowId;
    if (!observation || !windowId || !this.connected || this.currentOperation()) return controls;
    let command: DesktopCommand, binding: { manualId?: string; planId?: string; step?: number };
    let elementId: string | undefined;
    try {
      if (this.manual) { command = this.manual.command; binding = { manualId: this.manual.id }; }
      else {
        if (!this.plan || this.task?.status !== 'active' || performance.now() >= this.plan.expiresAt) return controls;
        const action = this.plan.value.actions[this.plan.index];
        if (!action) return controls;
        if (action.kind === 'click_position' && this.plan.layoutVersion !== layoutVersion(observation)) return controls;
        command = resolveDesktopAction(action, observation, windowId); binding = { planId: this.plan.id, step: this.plan.index };
        if (action.kind === 'click') elementId = action.elementId;
      }
      validateDesktopCommand(command, observation, windowId);
      const reference = this.agent.observations.reference('desktop', ['window', ...(elementId ? [`element:${elementId}`] : [])]);
      return [...controls, { id: 'native-next', description: `Native Windows ${command.kind}: ${JSON.stringify(command)}. Verify after dispatch.`,
        selection: { kind: 'execute', call: { capability: 'desktop_input', target: windowId, input: asJson({ command, ...binding }) } }, observations: [reference] }];
    } catch { return controls; }
  }
  private accept(proposal: ProposalRecord): boolean {
    const reject = (message: string): false => {
      this.error = message; this.log('plan-rejected', message);
      if (++this.rejectedPlans >= 3) this.block(`计划连续未通过检查：${message}`);
      else this.phase('reviewing', `${message} 正在重新规划。`);
      return false;
    };
    if (this.reviewRoute === 'reject_plan') return reject('System One 判断提议不符合当前目标或窗口。');
    const metadata = proposal.value.metadata as { taskId?: string; observationId?: string; plan?: unknown } | undefined;
    const task = this.task, observation = this.world.observation;
    if (!task || task.status !== 'active' || task.turnId !== proposal.scope.turnId || task.id !== metadata?.taskId || !observation) return reject('提议对应的任务已变化。');
    const source = metadata.observationId && this.recent.get(metadata.observationId);
    if (!source || source.selectedWindowId !== task.windowId || windowVersion(source, task.windowId) !== windowVersion(observation, task.windowId)) return reject('规划使用的窗口观察已失效。');
    const parsed = desktopPlanSchema.safeParse(metadata.plan);
    if (!parsed.success) return reject('规划结果不符合桌面操作格式。');
    try {
      for (const action of parsed.data.actions) {
        if (action.kind === 'click' && elementVersion(source, action.elementId) !== elementVersion(observation, action.elementId)) return reject('计划中的目标控件已变化。');
        validateDesktopCommand(resolveDesktopAction(action, source, task.windowId), observation, task.windowId);
      }
    } catch (error) { return reject(error instanceof AgentError ? error.message : '计划含有当前不可执行的步骤。'); }
    task.segments++;
    const evidence = verifyDesktopPlan(parsed.data, observation);
    if (parsed.data.actions.length === 0 && evidence.length) {
      task.status = 'completed'; task.evidenceIds = [observation.id]; this.phase('completed', '已核对当前窗口中的结果文字。');
      this.log('verified', `已匹配当前窗口中的结果文字：${parsed.data.verification!.text}`);
      return true;
    }
    if (!parsed.data.actions.length || task.segments > 12 || task.steps >= 48) {
      this.block(parsed.data.actions.length ? '已达到本次任务的步骤上限，请核对当前进度。' : `规划器未找到可执行操作：${parsed.data.summary}`); return false;
    }
    this.plan = { id: proposal.id, taskId: task.id, value: parsed.data, index: 0, windowVersion: windowVersion(source, task.windowId)!,
      layoutVersion: layoutVersion(source), expiresAt: performance.now() + 45000 };
    this.idleDecisions = 0;
    this.phase('reviewing', '计划已通过检查，正在选择当前操作。');
    return true;
  }
  private prepare(call: ActionCall): PreparedOperation<DesktopWorld> {
    const offered = this.candidates().find(candidate => candidate.selection.kind === 'execute');
    const input = desktopInputSchema.parse(call.input);
    if (!offered || offered.selection.kind !== 'execute' || call.capability !== 'desktop_input' || call.target !== this.selectedWindowId
      || JSON.stringify(desktopInputSchema.parse(offered.selection.call.input)) !== JSON.stringify(input) || !this.world.observation) {
      throw new AgentError('stale_candidate', '该桌面操作已失效。', 0);
    }
    const command = input.command;
    const expected = structuredClone(this.world.observation);
    let sequence = 0, issued = false, settled = false;
    return { maxDurationMs: 18000, interruptibility: 'checkpoint', dispatch: (_world, operation, report) => {
      const pending = (async () => {
        try {
          // Inference may outlive the driver's short capture TTL. Refresh before dispatch
          // but never rebase a bound position onto a changed window or control layout.
          const fresh = await this.driver.observe(command.windowId);
          operation.signal.throwIfAborted();
          if (windowVersion(fresh, command.windowId) !== windowVersion(expected, command.windowId)
            || (command.kind === 'click' || command.kind === 'scroll') && layoutVersion(fresh) !== layoutVersion(expected)) {
            throw new AgentError('stale_observation', '执行前窗口或控件布局已变化，需要重新观察。', 0);
          }
          const observed = await this.driver.execute(command, fresh, operation.signal, () => { issued = true; });
          settled = true; this.ingest(observed);
          report({ sequence: ++sequence, status: 'completed', effect: 'committed', evidenceIds: [observed.id],
            result: { inputDelivered: true, observationId: observed.id, businessSuccess: false } });
        } catch (error) {
          settled = true;
          // A lost helper response after commit cannot prove that Windows saw no
          // input, even if the separate issued notification was also lost.
          if (error && typeof error === 'object' && 'mayHaveExecuted' in error && error.mayHaveExecuted === true) issued = true;
          this.error = error instanceof AgentError ? error.message : 'Windows 输入未完成；请核对窗口焦点、控件状态及执行记录。';
          this.log('input-error', this.error, operation.operationId);
          report({ sequence: ++sequence, status: issued ? 'unknown' : operation.signal.aborted ? 'cancelled' : 'failed', effect: issued ? 'unknown' : 'none' });
        }
      })();
      this.pending.add(pending); void pending.finally(() => this.pending.delete(pending)); return pending;
    }, cancel: async () => { await this.driver.release(); }, reconcile: async (_world, _operation, report) => {
      if (!settled) { report({ sequence: ++sequence, status: 'unknown', effect: 'unknown' }); return; }
      await this.driver.release();
      const observed = await this.driver.observe(expected.selectedWindowId); this.ingest(observed);
      // The input dispatch has ended and keys have been released. This establishes
      // resource availability, not whether a previously sent click took effect.
      report({ sequence: ++sequence, status: 'failed', effect: issued ? 'unknown' : 'none', evidenceIds: [observed.id],
        result: { reconciled: true, inputOutcome: 'unknown', observationId: observed.id, businessSuccess: false } });
    } };
  }
  private onEvent(event: AgentEvent): void {
    if (event.type === 'decision-started') {
      if (this.task?.status === 'active' && !event.context.thinking && !this.currentOperation()) {
        this.phase(event.context.proposal && !event.context.proposal.accepted ? 'reviewing' : 'deciding',
          event.context.proposal && !event.context.proposal.accepted ? 'System One 正在检查计划。' : 'System One 正在选择下一步。');
        if (++this.decisions > 64) this.block('已达到本次任务的决策上限，尚未验证完成。请核对现场后重新开始。');
      }
    }
    if (event.type === 'decision-resolved') {
      const metadata = event.result.metadata as { route?: DesktopRoute } | undefined;
      this.reviewRoute = metadata?.route ?? null;
      if (metadata?.route === 'blocked') this.block('System One 未找到能在所选窗口执行的下一步。请确认选中了目标应用，并具体描述要操作的控件或文字。');
      if (metadata?.route === 'replan') { this.plan = null; this.error = '当前计划需要根据窗口状态修订。'; }
      if (metadata?.route && metadata.route !== 'pending') this.log('decision', `下一步：${metadata.route}`);
    }
    if (event.type === 'decision-applied' && this.task?.status === 'active') {
      const meaningful = event.result.think || event.result.acceptProposal
        || Object.values(event.result.channels ?? {}).some(selection => selection.kind === 'execute');
      if (!meaningful && !event.context.thinking && !this.currentOperation() && ++this.idleDecisions >= this.idleLimit) {
        this.block('连续决策没有产生规划或操作，已停止空转。请查看所选窗口与任务描述后重试。');
      }
    }
    if (event.type === 'thought-started') { this.phase('planning', 'LLM 正在根据当前窗口生成下一段操作。'); this.log('thinking', '正在根据真实窗口状态规划下一步。'); }
    if (event.type === 'proposal-created') { this.phase('reviewing', '已收到计划，等待 System One 检查。'); this.log('proposal', event.proposal.value.summary); }
    if (event.type === 'proposal-accepted' || event.type === 'proposal-rejected') this.agent.wake();
    if (event.type === 'error') {
      this.error = event.message; this.log('error', `${event.code}: ${event.message}`);
      const transient = ['superseded', 'stale_candidate', 'stale_observation', 'stale_channel_candidate', 'operation_busy', 'prepare_failed', 'resource_busy', 'resource_conflict'].includes(event.code);
      if (this.task?.status === 'active' && (!transient || ++this.idleDecisions >= this.idleLimit)) {
        this.block(`${event.message} 任务已暂停，请检查后重新开始。`);
      }
    }
    if (event.type !== 'channel-progress' || event.channel !== 'computer') return;
    const receipt = event.receipt;
    if (!event.terminal) {
      if (receipt.status === 'dispatched') this.phase('executing', `正在执行 ${desktopInputSchema.parse(receipt.call.input).command.kind}。`);
      if (receipt.status === 'unknown') {
        this.error = '已发送的输入结果未知，请核对现场后再继续。'; this.phase('blocked', this.error); this.log('unknown', this.error, receipt.id);
        if (this.task?.status === 'active') this.task.status = 'needs-review';
      }
      return;
    }
    const binding = desktopInputSchema.parse(receipt.call.input);
    const failed = receipt.status !== 'completed';
    this.lastResult = `${binding.command.kind}: ${receipt.status}`;
    this.log('execution', failed ? '输入未确认成功，请查看实际窗口。' : '系统输入已送达，已重新读取窗口状态。', receipt.id);
    if (this.manual?.id === binding.manualId && this.manual?.turnId === receipt.scope.turnId) this.manual = null;
    if (!failed) this.error = null;
    else this.error ??= '输入未确认成功；未重复发送。';
    if (this.task?.status === 'active' && this.task.turnId === receipt.scope.turnId && this.plan && this.plan.id === binding.planId) {
      if (failed) { this.plan = null; this.block(this.error!); }
      else {
        this.lastProgressAt = performance.now(); this.idleDecisions = 0; this.rejectedPlans = 0;
        this.task.steps++; this.plan.index++;
        this.phase('verifying', '输入已送达，正在核对结果与下一步。');
        if (this.plan.index >= this.plan.value.actions.length) {
          const observation = this.world.observation;
          const evidence = observation ? verifyDesktopPlan(this.plan.value, observation) : [];
          if (evidence.length && observation) {
            this.task.status = 'completed'; this.task.evidenceIds = [observation.id];
            this.phase('completed', '已执行任务，并核对当前窗口中的结果文字。');
            this.log('verified', `已匹配当前窗口中的结果文字：${this.plan.value.verification!.text}`);
          }
          this.plan = null;
        }
      }
    }
    this.agent.wake();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; for (const timer of this.timers) clearInterval(timer);
    this.agent.dispose();
    try { await this.driver.close(); }
    finally { await Promise.allSettled([...this.pending, ...(this.refreshPending ? [this.refreshPending] : [])]); }
  }
}
