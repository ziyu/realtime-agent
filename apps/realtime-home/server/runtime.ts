import { createHash, randomUUID } from 'node:crypto';
import { Agent, AgentError } from '@realtime-agent/agent';
import type { ActionReceipt, AgentEvent, ConversationContext, DecisionContext as CoreContext, DecisionResult, GroundingClaim, JsonValue, ProposalRecord } from '@realtime-agent/agent';
import { ACTIONS, candidatesFor, clamp, isAction, isMovement, nearbyObservation, observeTarget, roomAt, TARGETS } from '../shared/world';
import type { ActionId, Choice, Decision, DecisionContext, FastProvider, Memory, MessageInput, MessageReceipt, Mode, Need, OutputStatus, Reflection, TargetId, SlowProvider, Trace, WorldState } from '../shared/types';
import { modelContext, ProviderError } from './providers';
import { homeTargetForId, homeCall, homeCandidates, homeCapabilities } from './agent-environment';
import type { HomeExecutionResult } from './agent-environment';
import type { MindState } from '../shared/mind';
import { acceptInsight, activeGoal, addEpisode, advanceMind, AUTONOMOUS_THOUGHT_INTERVAL_MS, boundedMemories, createMind, recall, recordOutcome, reflectionOpportunity } from './mind';
import { speechCandidates, speechCapability } from './voice/output';
import type { LifeSnapshot } from './life-store';

interface Options {
  fast: FastProvider; slow: SlowProvider | null; mode: Mode; provider?: 'direct' | 'cloudflare';
  jevModel?: string; llmModel?: string; memories?: Memory[]; mind?: MindState; now?: () => number;
  persist?: (memories: Memory[]) => void; persistLife?: (life: LifeSnapshot) => void;
}
const label = (id: string, target?: TargetId | null) => isAction(id) ? ACTIONS[id].label
  : isMovement(id) ? `${id === 'inspect' ? '查看' : '走向'}${target ? TARGETS[target].object : '目标'}` : id === 'continue' ? '继续当前动作' : '原地等待';
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
const homeContext = (context: CoreContext) => context.observation as unknown as DecisionContext;
const reflectionOf = (proposal: ProposalRecord): Reflection => ({ ...(proposal.value.metadata as unknown as Omit<Reflection, 'id' | 'createdAt' | 'accepted'>),
  id: proposal.id, createdAt: proposal.createdAt, accepted: proposal.accepted });
function legacyAction(receipt: ActionReceipt): { id: ActionId | 'approach' | 'inspect'; target?: TargetId } {
  const target = homeTargetForId(receipt.call.target ?? '');
  if (!target) throw new Error('Invalid Home execution receipt');
  if (receipt.call.capability === 'inspect') return { id: 'inspect', target };
  if (receipt.call.capability === 'move_to') return { id: 'approach', target };
  if (!isAction(target)) throw new Error('Invalid Home activity receipt');
  return { id: target };
}
export const DECISION_INTERVAL_MS = 1000;
export const INPUT_COALESCE_MS = 40;
export class InputConflict extends Error {}

/** Home hosts physics, character and persistence. The independent Agent owns all coordination. */
export class AgentRuntime {
  state: WorldState;
  private now: () => number;
  private agent: Agent<WorldState>;
  private listeners = new Set<(state: WorldState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private decisionTimer: ReturnType<typeof setInterval> | null = null;
  private inputTimer: ReturnType<typeof setTimeout> | null = null;
  private urgentDecision = false;
  private clients = new Map<string, { sequence: number; signature: string; receipt: MessageReceipt }>();
  private lastTick = 0;
  private lastEmit = 0;
  private nextTickAt = 0;
  private lastInnerCheckAt = -Infinity;

  constructor(private options: Options) {
    this.now = options.now ?? Date.now;
    this.state = this.initialState(options.memories ?? [], options.mind);
    this.agent = new Agent({ thoughtIntervalMs: DECISION_INTERVAL_MS, epoch: this.state.epoch, now: this.now, id: randomUUID,
      environment: { context: () => this.state, observe: () => json(this.context()), perceive: () => json({ object: nearbyObservation(this.state.agent.position), room: observeTarget(this.state.agent.position, roomAt(this.state.agent.position)) }),
        candidates: () => homeCandidates(this.context()), capabilities: homeCapabilities,
        output: { candidates: speechCandidates, capabilities: [speechCapability] }, revision: world => world.version },
      fast: { decide: (context, signal) => this.fastDecision(context, signal) },
      ...(options.slow ? { slow: { think: (context: CoreContext, signal: AbortSignal) => this.slowThought(context, signal) } } : {}),
      policies: { canThink: () => this.canThink(), acceptProposal: proposal => this.reviewProposal(proposal),
        verifyCompletion: context => this.verifyCompletion(context) },
    });
    this.agent.subscribe(event => this.onAgentEvent(event));
  }
  private initialState(memories: Memory[], previousMind?: MindState): WorldState {
    const mind = previousMind ? structuredClone(previousMind) : createMind(this.now());
    return {
      epoch: randomUUID(), version: 0, intentVersion: 0, elapsed: 0, paused: false, speed: 1, mode: this.options.mode,
      connected: { jev: this.options.mode === 'live', llm: this.options.mode === 'live' && !!this.options.slow, jevModel: this.options.jevModel ?? 'jev-latest', llmModel: this.options.llmModel ?? '', provider: this.options.provider ?? 'direct' },
      agent: { name: 'Milo', position: { x: -2.5, z: 1.5 }, needs: { energy: 78, satiety: 64, hydration: 47, happiness: 82 }, action: null },
      intent: null, attending: false, nativeVoiceActive: false, turns: [], objects: { plantMoisture: 52, dishesClean: true },
      messages: [],
      mind, memories: memories.slice(-60), outcomes: [], traces: [], reflection: null,
      thinking: false, deciding: false, decision: null, error: null,
      scheduler: { intervalMs: DECISION_INTERVAL_MS, ticks: 0, lastTickAt: null, nextTickAt: null, lastRequestAt: null, retryAt: null, status: 'waiting' },
      metrics: { decisions: 0, jevCalls: 0, llmCalls: 0, reflections: 0, started: 0, completed: 0, interrupted: 0, discarded: 0 },
    };
  }
  snapshot(): WorldState { return structuredClone(this.state); }
  conversationContext(): ConversationContext {
    return this.agent.conversation();
  }
  speechAction() { return this.agent.outputs.current; }
  cancelSpeech(reason = 'cancelled') { this.agent.cancelOutput(reason); }
  completeSpeech(executionId: string, text: string): boolean {
    const active = this.agent.outputs.current, speech = this.state.speech;
    if (!active || active.id !== executionId || active.status !== 'running' || !speech || speech.executionId !== executionId
      || !speech.native || speech.delivered || speech.text !== text || this.state.paused || this.state.attending) return false;
    speech.delivered = true; speech.deliveredAt = this.now(); this.emit(); return true;
  }
  failSpeech(executionId: string, reason: string) {
    if (this.state.speech?.executionId === executionId) { this.state.speech.error = reason; this.emit(); }
  }
  checkClaims(claims: readonly GroundingClaim[]): boolean { return this.agent.checkClaims(claims); }
  recordOutputRejection(reason: string, turnId: string | null) {
    const code = ['transcript-mismatch', 'stale', 'invalid-output', 'generation-failed'].includes(reason) ? reason : 'not-approved';
    this.recordOutput(turnId, 'blocked', `播放前校验结果：${code}。`);
  }
  recordOutput(turnId: string | null, status: OutputStatus, detail: string, data?: JsonValue, permitId?: string) {
    const turn = this.state.turns.find(t => t.id === turnId);
    if (!turn) { this.trace('guard', `输出：${status}`, detail, { stage: 'output', turnId: undefined, data }); return; }
    if (status === 'cancelled' && turn.output?.status === 'delivered' || (turn.output?.status === status && turn.output.detail === detail && turn.output.permitId === permitId)) return;
    turn.output = { status, detail, at: this.now(), ...(permitId ? { permitId } : {}) };
    this.trace(status === 'blocked' ? 'error' : 'guard', `输出：${status}`, detail, { stage: 'output', turnId: turnId ?? undefined, data });
    this.emit();
  }
  subscribe(listener: (state: WorldState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private refreshScheduler() {
    const core = this.agent.snapshot(), s = this.state;
    s.execution = core.action; s.executions = core.receipts; s.speechExecution = core.output; s.speechExecutions = core.outputReceipts;
    s.attending = core.attending; s.deciding = core.deciding; s.thinking = core.thinking;
    s.scheduler.lastRequestAt = core.lastDecisionAt;
    s.scheduler.nextTickAt = this.decisionTimer && !s.paused ? this.nextTickAt : null;
    s.scheduler.retryAt = core.retryAt;
    s.scheduler.status = s.paused ? 'paused' : core.decisionBusy ? 'deciding' : core.retryAt ? 'backoff'
      : s.agent.action ? 'executing' : core.thoughtBusy ? 'thinking' : 'waiting';
  }
  private emit() { this.refreshScheduler(); for (const listener of this.listeners) listener(this.state); }
  private trace(kind: Trace['kind'], title: string, detail: string, extra: Partial<Trace> = {}) {
    this.state.traces.push({ id: randomUUID(), at: this.now(), kind, title, detail, turnId: this.state.intent && !this.state.intent.completed ? this.state.intent.id : undefined, ...extra }); this.state.traces = this.state.traces.slice(-200);
  }
  private chat(text: string, role: 'user' | 'agent' | 'system' = 'agent', id: string = randomUUID(), initiative = false) {
    this.state.messages.push({ id, role, text, at: this.now(), ...(initiative ? { initiative: true } : {}), ...(!initiative && this.state.intent ? { turnId: this.state.intent.id } : {}) });
    this.state.messages = this.state.messages.slice(-70);
  }
  private context(): DecisionContext { return { state: this.snapshot(), candidates: candidatesFor(this.state), observedAt: this.now() }; }
  private currentTurn() { return this.state.turns.find(turn => turn.id === this.state.intent?.id); }
  private wakeInteraction() {
    this.urgentDecision = true;
    const core = this.agent.snapshot();
    if (!this.timer || this.state.paused || core.decisionBusy || this.inputTimer || core.disposed) return;
    const wait = Math.max(INPUT_COALESCE_MS, (core.nextDecisionAt ?? 0) - this.now());
    this.inputTimer = setTimeout(() => { this.inputTimer = null; void this.decide(); }, wait);
  }
  private applied(action: Choice, target: TargetId | null = null) {
    const turn = this.currentTurn();
    if (turn && turn.appliedAt === null && turn.supersededAt === null) {
      turn.appliedAt = this.now(); turn.appliedAction = action; turn.appliedTarget = target;
      this.trace('guard', '已响应这次对话', `从接收消息到行为响应 ${Math.max(0, turn.appliedAt - turn.receivedAt)} ms。`, { turnId: turn.id });
    }
  }
  receive(input: MessageInput): MessageReceipt {
    if (input.epoch && input.epoch !== this.state.epoch) throw new InputConflict('家园已经重新开始，请重新发送这句话。');
    const text = input.text.trim(), source = input.source ?? 'text';
    const signature = createHash('sha256').update(`${source}\0${text}`).digest('hex');
    const previous = input.client && this.clients.get(input.client.id);
    if (previous && input.client!.sequence <= previous.sequence) {
      if (input.client!.sequence === previous.sequence && signature === previous.signature) return { ...previous.receipt, duplicate: true };
      throw new InputConflict('这句话已被你之后的输入替换。');
    }
    const receipt = this.message(text, source);
    if (input.client) {
      this.clients.delete(input.client.id); this.clients.set(input.client.id, { sequence: input.client.sequence, signature, receipt });
      if (this.clients.size > 128) this.clients.delete(this.clients.keys().next().value!);
    }
    return receipt;
  }
  message(text: string, source: MessageInput['source'] = 'text'): MessageReceipt {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 1200) throw new Error('消息长度应为 1–1200 个字符。');
    const previous = this.currentTurn(), previousAction = this.state.agent.action?.id ?? null;
    if (previous) { previous.supersededAt = this.now(); this.recordOutput(previous.id, 'cancelled', '新的输入已替代这轮未完成的回复。'); }
    this.state.intentVersion++; this.state.version++;
    const turn = this.agent.receive(trimmed);
    this.state.intent = { id: turn.id, text: turn.text, completed: false, createdAt: turn.receivedAt, ...(this.state.nativeVoiceActive ? { replyChannel: 'native' as const } : {}) };
    this.state.turns.push({ id: turn.id, text: turn.text, source, receivedAt: turn.receivedAt, previousAction,
      decisionStartedAt: null, decisionAt: null, appliedAt: null, appliedAction: null, appliedTarget: null, replyAt: null, supersededAt: null, replyCancelledAt: null, error: null });
    this.state.turns = this.state.turns.slice(-32); this.state.reflection = null; this.state.error = null;
    this.chat(trimmed, 'user', turn.id);
    addEpisode(this.state.mind, { id: turn.id, kind: 'conversation', role: 'user', text: trimmed, at: this.now(), epoch: this.state.epoch, requestId: turn.id });
    this.state.mind.drives.connection = clamp(this.state.mind.drives.connection - 12); this.persistLife();
    this.trace('guard', '收到新的指令', '旧决策与旧慢思考已取消，当前动作等待快系统重新评估。', { turnId: turn.id, stage: 'input', data: json({ text: trimmed, source, previousAction }) });
    this.recordOutput(turn.id, 'waiting-decision', '已收到输入，等待快系统选择动作和回复方式。');
    this.emit(); this.wakeInteraction(); return { ok: true, turnId: turn.id, receivedAt: turn.receivedAt, duplicate: false };
  }
  setNativeVoice(active: boolean) {
    if (this.agent.snapshot().disposed) return;
    this.state.nativeVoiceActive = active;
    if (this.state.intent) this.state.intent.replySuppressed = true;
    this.state.reflection = null; this.state.version++; this.agent.cancelReasoning(); this.emit();
  }
  holdNativeInput() {
    if (!this.state.nativeVoiceActive || this.state.paused) return;
    if (this.state.intent) this.state.intent.replySuppressed = true;
    this.state.version++; this.agent.holdInput(); this.emit();
  }
  releaseNativeInput() { this.agent.releaseInput(); this.emit(); this.wakeInteraction(); }
  interruptReply(epoch: string, turnId: string): boolean {
    if (epoch !== this.state.epoch || this.state.intent?.id !== turnId) return false;
    if (this.state.intent.replySuppressed) return true;
    this.state.intent.replySuppressed = true; this.state.intentVersion++; this.state.version++; this.state.reflection = null;
    const turn = this.currentTurn(); if (turn) turn.replyCancelledAt = this.now();
    this.agent.interruptReply(epoch, turnId);
    this.recordOutput(turnId, 'cancelled', '用户插话，旧回复已取消。');
    this.trace('guard', '对话被插话打断', '旧回复已取消；新的完整输入到来后重新判断行为。', { turnId }); this.emit(); return true;
  }
  start() {
    if (this.timer) return;
    this.lastTick = this.now(); this.nextTickAt = this.lastTick + DECISION_INTERVAL_MS;
    this.timer = setInterval(() => {
      const now = this.now(), dt = Math.min(0.5, Math.max(0, (now - this.lastTick) / 1000)); this.lastTick = now; this.tick(dt);
      if (now - this.lastEmit >= 200) { this.lastEmit = now; this.emit(); }
    }, 100);
    this.decisionTimer = setInterval(() => {
      const now = this.now(); this.nextTickAt = now + DECISION_INTERVAL_MS;
      if (this.state.paused) return;
      this.state.scheduler.ticks++; this.state.scheduler.lastTickAt = now; void this.decide();
    }, DECISION_INTERVAL_MS);
    this.refreshScheduler(); if (this.urgentDecision) this.wakeInteraction();
  }
  stop() {
    if (this.timer) clearInterval(this.timer); if (this.decisionTimer) clearInterval(this.decisionTimer); if (this.inputTimer) clearTimeout(this.inputTimer);
    this.inputTimer = null; this.timer = null; this.decisionTimer = null; this.agent.dispose(); this.refreshScheduler(); this.persistLife();
  }
  pause(paused: boolean) {
    if (paused === this.state.paused) return;
    if (paused && this.state.intent) this.recordOutput(this.state.intent.id, 'cancelled', '世界暂停，当前回复已取消。');
    this.state.paused = paused; this.state.version++; this.agent.pause(paused);
    this.trace('guard', paused ? '世界已暂停' : '世界继续运行', paused ? '动作进度、需求变化和模型请求均已暂停。' : '从当前状态重新评估下一步。');
    this.emit(); if (!paused && this.urgentDecision) this.wakeInteraction();
  }
  speed(speed: 1 | 2 | 4) { this.state.speed = speed; this.emit(); }
  setProactiveChat(enabled: boolean) { this.state.mind.settings.proactiveChat = enabled; this.persistLife(); this.emit(); }
  forgetMemory(id: string): boolean {
    const target = this.state.memories.find(m => m.id === id); if (!target) return false;
    const ids = new Set(target.evidenceIds ?? []);
    this.state.memories = this.state.memories.filter(m => m.id !== id && !m.evidenceIds?.some(e => ids.has(e)));
    this.state.mind.episodes = this.state.mind.episodes.filter(e => !ids.has(e.id));
    this.state.mind.journal = this.state.mind.journal.filter(j => !j.evidence.some(e => ids.has(e.id)));
    this.state.mind.goals = this.state.mind.goals.filter(g => !g.evidenceIds.some(e => ids.has(e)));
    this.state.messages = this.state.messages.filter(m => m.role === 'user' && !ids.has(m.id)); this.state.traces = this.state.traces.filter(t => t.kind === 'action');
    this.state.turns = this.state.turns.filter(t => !ids.has(t.id)); this.state.reflection = null;
    this.state.mind.innerVoice = { text: '把这一页轻轻翻过去，接着体验眼前的生活。', source: 'experience', at: this.now() };
    if (this.state.intent && ids.has(this.state.intent.id)) this.state.intent = null;
    this.state.intentVersion++; this.state.version++; this.agent.forgetTurns(ids);
    try { this.options.persist?.(this.state.memories); } catch { this.trace('error', '记忆保存失败', '删除暂时只在本次会话生效。'); }
    this.persistLife(); this.emit(); return true;
  }
  reset() {
    if (this.inputTimer) clearTimeout(this.inputTimer); this.inputTimer = null; this.urgentDecision = false;
    this.agent.reset(); this.state = this.initialState(this.state.memories, this.state.mind); this.state.epoch = this.agent.scope.epoch;
    this.persistLife(); this.emit();
  }
  tick(realSeconds: number) {
    if (this.state.paused || realSeconds <= 0 || this.agent.snapshot().disposed) return;
    const dt = Math.min(realSeconds, 0.5) * this.state.speed; this.state.elapsed += dt;
    const needs = this.state.agent.needs, before = { ...needs };
    needs.energy = clamp(needs.energy - dt * 0.05); needs.satiety = clamp(needs.satiety - dt * 0.045);
    needs.hydration = clamp(needs.hydration - dt * 0.07); needs.happiness = clamp(needs.happiness - dt * 0.025);
    this.state.objects.plantMoisture = clamp(this.state.objects.plantMoisture - dt * 0.035); advanceMind(this.state, dt);
    if ((Object.keys(needs) as Need[]).some(need => before[need] >= 20 && needs[need] < 20)) { this.state.version++; this.agent.invalidate(); }
    const action = this.state.agent.action, phase = action?.phase;
    this.agent.tick(dt);
    if (phase === 'walking' && action?.phase === 'acting' && isAction(action.id)) this.trace('action', `到达：${ACTIONS[action.id].object}`, `开始${label(action.id)}，完成后才结算效果。`, { stage: 'action', turnId: action.requestId ?? undefined });
  }
  async decide(): Promise<void> {
    if (this.state.paused || this.agent.snapshot().disposed) return;
    const now = this.now(), core = this.agent.snapshot();
    // Only character strategy lives here; concurrency, cadence and proposal expiry belong to Agent.
    if (this.state.reflection && !core.proposal && now - this.state.reflection.createdAt > 60000) {
      this.state.reflection = null; this.trace('guard', '旧想法已过期', '重新观察眼前的生活。');
    }
    if (!core.thoughtBusy && (!core.proposal || core.proposal.accepted) && reflectionOpportunity(this.state, now).due && now - this.lastInnerCheckAt >= 15000) {
      this.lastInnerCheckAt = now; this.agent.wake();
    }
    await this.agent.decide();
  }
  private async fastDecision(context: CoreContext, signal: AbortSignal): Promise<DecisionResult> {
    try {
      const result = await this.options.fast.decide(homeContext(context), signal);
      const selection = result.action === 'idle' ? { kind: 'wait' as const } : result.action === 'continue' ? { kind: 'continue' as const }
        : { kind: 'execute' as const, call: homeCall(result.action, result.target) };
      const output = result.speech === undefined ? undefined : context.outputCandidates?.find(c => c.id === result.speech)?.selection;
      if (result.speech !== undefined && !output) throw new AgentError('invalid_output_candidate', '说话候选不可用，未执行发言。');
      return { selection, ...(output ? { output } : {}), interrupt: result.interrupt >= 0.7, think: result.think >= 0.7, acceptProposal: result.acceptReflection >= 0.5,
        complete: result.requestComplete >= 0.8, metadata: json(result) };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error instanceof ProviderError ? new AgentError('home_provider', error.message, error.retryAfterMs)
        : new AgentError('decision_failed', '决策请求失败，正在保留现场并等待重试。');
    }
  }
  private async slowThought(context: CoreContext, signal: AbortSignal) {
    const observation = homeContext(context), state = observation.state;
    const purpose = !state.intent || state.intent.completed ? 'autonomous' as const : 'conversation' as const;
    try {
      const result = await this.options.slow!.reflect(observation, signal);
      return { summary: result.summary, reply: result.reply, suggestions: result.suggestedActions.map(id => homeCall(id)), memories: result.memories,
        metadata: json({ ...result, intentVersion: state.intentVersion, source: state.mode === 'demo' ? 'demo' : 'llm', purpose,
          executionEvidenceIds: context.receipts.filter(r => r.scope.turnId === context.scope.turnId && r.status === 'completed').map(r => r.id),
          evidenceSequence: state.mind.sequence, contextEvidenceIds: recall(state).episodes.map(e => e.id) }) };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error instanceof ProviderError ? new AgentError('home_thought', error.message, error.retryAfterMs)
        : new AgentError('thinking_failed', '慢思考请求失败，当前世界继续运行。');
    }
  }
  private canThink() {
    const automatic = !this.state.intent || this.state.intent.completed;
    const ready = this.state.mind.lastAutonomousAttemptAt === null || this.now() - this.state.mind.lastAutonomousAttemptAt >= AUTONOMOUS_THOUGHT_INTERVAL_MS;
    return (automatic || !this.state.intent?.replySuppressed) && (!automatic || ready);
  }
  private reviewProposal(proposal: ProposalRecord): boolean {
    const reflection = reflectionOf(proposal), automatic = reflection.purpose === 'autonomous';
    if (reflection.intentVersion !== this.state.intentVersion) return false;
    const insightAccepted = reflection.self && acceptInsight(this.state, reflection.self, reflection.source, this.now(), reflection.contextEvidenceIds ?? []);
    if (reflection.self && !insightAccepted) this.trace('guard', '随记缺少有效经历来源', '没有把无依据的自述写入长期记忆。');
    return !automatic || Boolean(insightAccepted);
  }
  private verifyCompletion(context: CoreContext): boolean {
    if (!this.state.intent) return false;
    if (this.state.intent.observation) {
      const id = this.state.intent.observation.executionId;
      return context.receipts.some(r => r.id === id && r.status === 'completed') && (context.outputReceipts ?? []).some(r => r.scope.turnId === this.state.intent!.id && r.status === 'completed' && (r.result as { evidenceIds?: string[] })?.evidenceIds?.includes(id));
    }
    if (context.receipts.some(r => r.scope.turnId === this.state.intent!.id && r.status === 'completed') || this.state.intent.replyDelivered) return true;
    const text = this.state.intent.text;
    return /^(停下|停止|别动|站住|stop|暂停动作)/i.test(text.trim()) && !this.state.agent.action
      || /清洗餐具|洗碗/.test(text) && this.state.objects.dishesClean;
  }
  private onAgentEvent(event: AgentEvent) {
    const turn = this.state.intent?.completed ? undefined : this.currentTurn();
    switch (event.type) {
      case 'decision-started':
        this.urgentDecision = false; if (this.inputTimer) clearTimeout(this.inputTimer); this.inputTimer = null;
        if (turn && turn.decisionAt === null) { turn.decisionStartedAt = event.at; turn.error = null; }
        this.trace('decision', '提交快系统决策', '结构化输入与候选动作已提交。', { stage: 'decision', turnId: event.context.input && !event.context.input.completed ? event.context.input.id : undefined, requestedAt: event.at, data: json({ scope: event.context.scope, observation: modelContext(homeContext(event.context), 'fast'), candidates: event.context.candidates, speechCandidates: event.context.outputCandidates, currentSpeech: event.context.currentOutput, currentAction: event.context.currentAction }) });
        if (this.state.mode === 'live') this.state.metrics.jevCalls++; this.emit(); break;
      case 'decision-resolved': {
        const decision = event.result.metadata as unknown as Decision;
        this.state.decision = decision; this.state.metrics.decisions++; this.state.error = null;
        if (turn && turn.decisionAt === null) turn.decisionAt = event.at;
        this.trace('decision', label(decision.action, decision.target), decision.source === 'demo' ? '本地规则选择 · 非 Jev 推理。'
          : `Jev 选择动作；中断概率 ${Math.round(decision.interrupt * 100)}%，慢思考概率 ${Math.round(decision.think * 100)}%。`,
        { stage: 'decision', data: json(decision), latencyMs: decision.latencyMs, confidence: decision.confidence, source: decision.source, receipt: decision.receipt, requestedAt: this.state.scheduler.lastRequestAt ?? event.at, turnId: event.context.input && !event.context.input.completed ? event.context.input.id : undefined }); break;
      }
      case 'decision-applied': {
        const decision = event.result.metadata as unknown as Decision, previous = event.previous, current = event.current;
        if (previous && previous.id !== current?.id) {
          const action = legacyAction(previous); this.state.metrics.interrupted++;
          this.trace('action', `中断：${label(action.id, action.target)}`, '未完成动作不产生效果；从实际位置重新出发。', { stage: 'action', turnId: previous.scope.turnId ?? undefined, data: json(this.agent.actions.history.find(r => r.id === previous.id) ?? previous) });
          addEpisode(this.state.mind, { id: randomUUID(), kind: 'interruption', ...(isAction(action.id) ? { action: action.id } : {}),
            at: event.at, epoch: this.state.epoch, requestId: previous.scope.turnId, text: `${label(action.id, action.target)}还没完成就停下了；没有结算效果。` }); this.persistLife();
        }
        if (current && current.id !== previous?.id) {
          const action = legacyAction(current); this.state.metrics.started++;
          this.trace('action', `开始：${label(action.id, action.target)}`, `前往${TARGETS[action.target ?? action.id as ActionId].object}，到达后执行。`, { stage: 'action', turnId: current.scope.turnId ?? undefined, data: json(current) }); this.state.version++;
        }
        if (this.state.agent.action && current) this.state.agent.action.requestId = current.scope.turnId;
        const intent = this.state.intent;
        if (intent && current?.scope.turnId === intent.id && current.call.capability === 'inspect') {
          if (intent.observation?.executionId !== current.id) {
            intent.observation = { target: homeTargetForId(current.call.target!)!, executionId: current.id };
            this.trace('guard', '查看任务已启动', '完成后只提交观察事实；是否思考和说话由后续 Jev 决定。', { stage: 'observation', data: json(intent.observation) });
            this.recordOutput(intent.id, 'waiting-observation', `等待抵达${TARGETS[intent.observation.target].object}取得观察，再交回 Jev 决策。`);
          }
        } else if (intent?.observation && previous?.id === intent.observation.executionId && previous.id !== current?.id) {
          this.recordOutput(intent.id, 'cancelled', '查看动作已被替换，原观察回答取消。');
          delete intent.observation;
        }
        this.trace('guard', event.applied ? '控制器已采纳决策' : '控制器未采纳切换', event.applied ? '实际执行状态已更新。' : '中断条件未满足，保留当前动作。', { stage: 'decision', data: json({ proposed: event.result.selection, applied: event.applied, actual: current, interrupt: event.result.interrupt }) });
        if (event.applied) this.applied(decision.action, current && ['move_to', 'inspect'].includes(current.call.capability) ? homeTargetForId(current.call.target!) ?? null : null);
        else this.trace('guard', '继续已承诺的动作', 'Jev 尚未批准中断当前动作。');
        if (intent && !intent.completed && (!intent.observation || current?.id !== intent.observation.executionId) && decision.speech === 'silent') this.recordOutput(intent.id, 'silent', '快系统选择了 silent，没有安排新的回答。');
        break;
      }
      case 'action-ended': {
        this.recordExecution(event.receipt);
        if (event.receipt.call.capability === 'inspect') this.trace('action', event.receipt.status === 'completed' ? '观察结果已就绪' : '观察失败', '事实已交回决策，尚未授权发言。', { stage: 'observation', turnId: event.receipt.scope.turnId ?? undefined, data: json(event.receipt) });
        break;
      }
      case 'output-applied': {
        this.trace('action', event.current ? 'Jev 已批准说话动作' : 'Jev 选择保持安静', '输出使用独立的执行回执，可与身体动作并行。', { stage: 'output', data: json(event) });
        if (event.current && event.current.id !== event.previous?.id && turn) this.recordOutput(turn.id, 'authorized', 'speak 已启动，内容来自被采纳的慢思考提议。', json(event.current), event.current.id);
        this.emit(); break;
      }
      case 'output-ended': {
        const receipt = event.receipt;
        this.trace('action', `说话回执：${receipt.status}`, receipt.reason ?? '输出执行器报告交付结果。', { stage: 'output', turnId: receipt.scope.turnId ?? undefined, data: json(receipt) });
        if (receipt.status === 'completed') {
          const message = this.state.messages.find(m => m.id === receipt.id); if (message) message.at = receipt.endedAt!;
          if (receipt.scope.turnId && this.state.intent?.id === receipt.scope.turnId) {
            this.state.intent.replyDelivered = true; this.agent.markReplyDelivered(this.state.epoch, receipt.scope.turnId);
            if (turn) { turn.replyAt = event.at; turn.error = null; }
            this.recordOutput(receipt.scope.turnId, 'delivered', 'speak 执行完成，回复已交付。', receipt.result, receipt.id);
          } else { this.state.mind.lastSharedAt = this.now(); this.persistLife(); }
        } else if (receipt.scope.turnId) this.recordOutput(receipt.scope.turnId, receipt.status === 'failed' ? 'blocked' : 'cancelled', receipt.reason ?? '说话动作已取消。', json(receipt), receipt.id);
        this.emit(); break;
      }
      case 'thought-started': {
        const automatic = !this.state.intent || this.state.intent.completed;
        if (automatic) { this.state.mind.lastAutonomousAttemptAt = event.at; this.persistLife(); }
        if (this.state.mode === 'live') this.state.metrics.llmCalls++;
        if (!automatic && turn) this.recordOutput(turn.id, 'generating', '慢思考正在生成文字回复。');
        this.trace('thought', '快系统发起慢思考', automatic ? '回顾真实经历、整理感受与愿望。' : '结合性格、心情和记忆提出回复。', { stage: 'thought' }); this.emit(); break;
      }
      case 'proposal-created':
        this.state.reflection = reflectionOf(event.proposal); this.state.metrics.reflections++; this.state.version++;
        this.trace('thought', '慢思考建议已返回', this.state.reflection.summary, { stage: 'thought', source: this.state.reflection.source, receipt: this.state.reflection.receipt, data: json(this.state.reflection) });
        if (this.state.reflection.purpose === 'conversation') {
          if (turn) this.recordOutput(turn.id, 'waiting-review', '文字回复已生成，等待快系统采纳。');
          this.wakeInteraction();
        } break;
      case 'proposal-accepted': this.acceptedProposal(event.proposal); break;
      case 'proposal-rejected': this.state.reflection = null; break;
      case 'proposal-expired': this.state.reflection = null; this.trace('guard', '旧想法已过期', '重新观察眼前的生活。'); break;
      case 'turn-completed':
        if (this.state.intent?.id === event.turn.id) this.state.intent.completed = true;
        this.trace('guard', '当前请求已满足', '依据真实执行与交付回执结束请求。', { turnId: event.turn.id }); break;
      case 'discarded': if (event.scope.epoch === this.state.epoch) { this.state.metrics.discarded++; this.trace('guard', '过期模型结果已丢弃', `被丢弃的阶段：${event.stage}。`, { stage: 'decision', turnId: event.scope.turnId ?? undefined, data: json(event.scope) }); } break;
      case 'error':
        if (event.scope.epoch !== this.state.epoch) break;
        if (event.stage === 'decision') { this.state.error = event.message; if (turn) turn.error = event.message; this.trace('error', '快系统暂时不可用', event.message, { stage: 'decision' });
          if (turn) this.recordOutput(turn.id, 'blocked', '快系统请求失败，等待重试。'); }
        else if (event.stage === 'thought') {
          if (turn) { turn.error = event.message; this.recordOutput(turn.id, 'blocked', '慢思考未能生成回复。'); } this.trace('error', '慢思考暂时不可用', event.message);
          this.chat('这次回复没有生成成功。你可以重新提问，也可以直接改口；正在做的事情会继续。', 'system');
        }
        break;
      case 'settled': if (this.urgentDecision) this.wakeInteraction(); break;
      case 'changed': this.emit(); break;
      case 'wake': break;
    }
  }
  private recordExecution(receipt: ActionReceipt) {
    this.trace('action', `执行回执：${receipt.status}`, receipt.reason ?? '执行器报告实际结果。', { stage: 'action', turnId: receipt.scope.turnId ?? undefined, data: json(receipt) });
    if (receipt.status !== 'completed') { this.trace('guard', '动作未完成', '执行器保留真实状态，未授予完成效果。'); this.state.version++; return; }
    const result = receipt.result as unknown as HomeExecutionResult;
    const outcome = { id: receipt.id, action: result.action, ...(result.target ? { target: result.target } : {}), requestId: receipt.scope.turnId, at: receipt.endedAt!, effects: result.effects };
    this.state.outcomes.push(outcome); this.state.outcomes = this.state.outcomes.slice(-60); this.state.metrics.completed++;
    this.trace('action', `完成：${label(result.action, result.target)}`, result.effects);
    if (isAction(result.action)) { recordOutcome(this.state, outcome, result.goalId); this.remember(`完成过${ACTIONS[result.action].label}：${result.effects}。`, 'experience', [outcome.id]); }
    this.state.version++; this.persistLife();
  }
  private acceptedProposal(proposal: ProposalRecord) {
    const reflection = reflectionOf(proposal), automatic = reflection.purpose === 'autonomous'; this.state.reflection = reflection;
    if (automatic) this.state.mind.reflectedThrough = Math.max(this.state.mind.reflectedThrough, reflection.evidenceSequence ?? 0);
    const source = this.state.mind.episodes.find(e => e.id === this.state.intent?.id && e.role === 'user');
    if (!automatic && source) reflection.memories.forEach(text => this.remember(text, 'reflection', [source.id], source.text));
    if (!automatic && this.state.intent) this.recordOutput(this.state.intent.id, 'waiting-decision', '提议已采纳，等待 Jev 的 speak 选择。');
    this.persistLife(); this.trace('thought', '快系统采纳了慢思考建议', '内容已采纳；是否发言仍需选择 speak。', { stage: 'thought', data: json(reflection) });
  }
  private persistLife() {
    try { this.options.persistLife?.({ mind: this.state.mind, memories: this.state.memories }); }
    catch { this.trace('error', '生活记忆保存失败', '这次经历仍在当前会话中，重启前请检查数据目录。'); }
  }
  private remember(text: string, source: Memory['source'], evidenceIds: string[] = [], evidenceText?: string) {
    if (this.state.memories.some(memory => memory.text === text)) return;
    this.state.memories.push({ id: randomUUID(), text, source, at: this.now(), evidenceIds, evidenceText }); this.state.memories = boundedMemories(this.state.memories);
    try { this.options.persist?.(this.state.memories); } catch { this.trace('error', '记忆保存失败', '当前记忆仍在本次会话中，重启后可能丢失。'); }
  }
}
