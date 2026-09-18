import { createHash, randomUUID } from 'node:crypto';
import { ACTIONS, candidatesFor, clamp, isAction } from '../shared/world';
import type { Choice, DecisionContext, FastProvider, Memory, MessageInput, MessageReceipt, Mode, Need, SlowProvider, Trace, WorldState } from '../shared/types';
import { distance, findPath } from './navigation';
import { ProviderError } from './providers';
import type { MindState } from '../shared/mind';
import { acceptInsight, activeGoal, addEpisode, advanceMind, AUTONOMOUS_THOUGHT_INTERVAL_MS, boundedMemories, createMind, recall, recordOutcome, reflectionOpportunity, remainingGoalActions } from './mind';
import type { LifeSnapshot } from './life-store';

interface Options {
  fast: FastProvider;
  slow: SlowProvider | null;
  mode: Mode;
  jevModel?: string;
  llmModel?: string;
  memories?: Memory[];
  mind?: MindState;
  now?: () => number;
  persist?: (memories: Memory[]) => void;
  persistLife?: (life: LifeSnapshot) => void;
}
const NEED_NAMES: Record<Need, string> = { energy: '精力', satiety: '饱腹', hydration: '水分', happiness: '心情' };
const label = (id: string) => isAction(id) ? ACTIONS[id].label : id === 'continue' ? '继续当前动作' : '原地等待';
export const DECISION_INTERVAL_MS = 1000;
export const INPUT_COALESCE_MS = 40;
const IDLE_RECHECK_MS = 5000;

export class InputConflict extends Error {}

/** Authoritative simulation. Only validated fast-system choices reach the action executor. */
export class AgentRuntime {
  state: WorldState;
  private now: () => number;
  private listeners = new Set<(state: WorldState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private decisionTimer: ReturnType<typeof setInterval> | null = null;
  private inputTimer: ReturnType<typeof setTimeout> | null = null;
  private urgentDecision = false;
  private clients = new Map<string, { sequence: number; signature: string; receipt: MessageReceipt }>();
  private fastController: AbortController | null = null;
  private slowController: AbortController | null = null;
  private pendingDecision = true;
  private nextObservationAt = 0;
  private retryAt = 0;
  private nextTickAt = 0;
  private lastDecisionAt = -Infinity;
  private lastThoughtAt = -Infinity;
  private lastTick = 0;
  private lastEmit = 0;
  private failures = 0;
  private lastInnerCheckAt = -Infinity;
  private nativeListening = false;

  constructor(private options: Options) {
    this.now = options.now ?? Date.now;
    this.state = this.initialState(options.memories ?? [], options.mind);
  }
  private initialState(memories: Memory[], previousMind?: MindState): WorldState {
    const mind = previousMind ? structuredClone(previousMind) : createMind(this.now());
    return {
      epoch: randomUUID(), version: 0, intentVersion: 0, elapsed: 0, paused: false, speed: 1,
      mode: this.options.mode,
      connected: { jev: this.options.mode === 'live', llm: this.options.mode === 'live' && !!this.options.slow, jevModel: this.options.jevModel ?? 'jev-latest', llmModel: this.options.llmModel ?? '' },
      agent: { name: 'Milo', position: { x: -2.5, z: 1.5 }, needs: { energy: 78, satiety: 64, hydration: 47, happiness: 82 }, action: null },
      intent: null, attending: false, nativeVoiceActive: false, turns: [], objects: { plantMoisture: 52, dishesClean: true },
      messages: [{ id: randomUUID(), role: 'agent', text: mind.lifetimeCompleted
        ? `又是新的一刻。${activeGoal(mind) ? `我还惦记着「${activeGoal(mind)!.title}」。` : '之前的小经历和随记还在，我想接着慢慢过。'}`
        : '嗨，我是 Milo。我喜欢安静地看书，也喜欢照顾那盆绿植。你忙你的就好；有意思的事，我们可以慢慢聊。', at: this.now() }],
      mind, memories: memories.slice(-60), outcomes: [], traces: [], reflection: null,
      thinking: false, deciding: false, decision: null, error: null,
      scheduler: { intervalMs: DECISION_INTERVAL_MS, ticks: 0, lastTickAt: null, nextTickAt: null, lastRequestAt: null, retryAt: null, status: 'waiting' },
      metrics: { decisions: 0, jevCalls: 0, llmCalls: 0, reflections: 0, started: 0, completed: 0, interrupted: 0, discarded: 0 },
    };
  }
  snapshot(): WorldState { return structuredClone(this.state); }
  subscribe(listener: (state: WorldState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setNativeVoice(active: boolean) {
    this.cancelRequests();
    this.nativeListening = false;
    this.state.nativeVoiceActive = active;
    this.state.attending = false;
    if (this.state.intent) this.state.intent.replySuppressed = true;
    this.state.reflection = null;
    this.state.version++; this.pendingDecision = true; this.emit();
  }
  /** Yield while the microphone turn is unfinished; never execute interim transcripts. */
  holdNativeInput() {
    if (!this.state.nativeVoiceActive || this.state.paused) return;
    this.cancelRequests(); this.nativeListening = true;
    this.state.attending = true; this.state.version++;
    if (this.state.intent) this.state.intent.replySuppressed = true;
    this.emit();
  }
  releaseNativeInput() {
    this.nativeListening = false; this.state.attending = false;
    this.pendingDecision = true; this.emit(); this.wakeInteraction();
  }
  recordNativeReply(turnId: string, text: string) {
    const intent = this.state.intent;
    if (!this.state.nativeVoiceActive || !intent || intent.id !== turnId || intent.replySuppressed || this.nativeListening || !text.trim()) return false;
    this.state.messages.push({ id: randomUUID(), role: 'agent', text: text.slice(0, 2400), at: this.now(), turnId, nativeAudio: true });
    this.state.messages = this.state.messages.slice(-70);
    intent.replyDelivered = true;
    const turn = this.currentTurn(); if (turn) turn.replyAt = this.now();
    this.pendingDecision = true; this.emit();
    return true;
  }
  private refreshScheduler() {
    const s = this.state;
    s.scheduler.nextTickAt = this.decisionTimer && !s.paused ? this.nextTickAt : null;
    s.scheduler.retryAt = this.retryAt > this.now() ? this.retryAt : null;
    s.scheduler.status = s.paused ? 'paused' : this.fastController ? 'deciding' : s.scheduler.retryAt ? 'backoff'
      : s.agent.action ? 'executing' : this.slowController ? 'thinking' : 'waiting';
  }
  private emit() { this.refreshScheduler(); for (const listener of this.listeners) listener(this.state); }
  private trace(kind: Trace['kind'], title: string, detail: string, extra: Partial<Trace> = {}) {
    this.state.traces.push({ id: randomUUID(), at: this.now(), kind, title, detail, ...extra });
    this.state.traces = this.state.traces.slice(-70);
  }
  private chat(text: string, role: 'user' | 'agent' | 'system' = 'agent', id: string = randomUUID(), initiative = false) {
    this.state.messages.push({ id, role, text, at: this.now(), ...(initiative ? { initiative: true } : {}), ...(!initiative && this.state.intent ? { turnId: this.state.intent.id } : {}) });
    this.state.messages = this.state.messages.slice(-70);
  }
  private context(): DecisionContext { return { state: this.snapshot(), candidates: candidatesFor(this.state), observedAt: this.now() }; }
  private cancelRequests() {
    this.fastController?.abort(); this.slowController?.abort();
    // Keep each slot occupied until its promise settles; abort is not synchronous completion.
    this.state.deciding = false; this.state.thinking = false;
  }
  private currentTurn() { return this.state.turns.find(turn => turn.id === this.state.intent?.id); }
  /** User input wakes the same single-flight scheduler; it never bypasses its rate limit. */
  private wakeInteraction() {
    this.urgentDecision = true;
    if (!this.timer || this.state.paused || this.fastController || this.inputTimer) return;
    const delay = Math.max(INPUT_COALESCE_MS, this.lastDecisionAt + DECISION_INTERVAL_MS - this.now(), this.retryAt - this.now());
    this.inputTimer = setTimeout(() => { this.inputTimer = null; void this.decide(); }, delay);
  }
  private applied(action: Choice) {
    const turn = this.currentTurn();
    if (turn && turn.appliedAt === null && turn.supersededAt === null) {
      turn.appliedAt = this.now(); turn.appliedAction = action;
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
      // Bound per-browser ordering state. Epoch validation protects resets independently.
      this.clients.delete(input.client.id);
      this.clients.set(input.client.id, { sequence: input.client.sequence, signature, receipt });
      if (this.clients.size > 128) this.clients.delete(this.clients.keys().next().value!);
    }
    return receipt;
  }
  /** Speech beginning cancels output for the observed turn, never a newer turn or physical action. */
  interruptReply(epoch: string, turnId: string): boolean {
    if (epoch !== this.state.epoch || this.state.intent?.id !== turnId) return false;
    if (this.state.intent.replySuppressed) return true;
    this.cancelRequests();
    this.state.intent.replySuppressed = true;
    this.state.intentVersion++; this.state.version++;
    this.state.reflection = null;
    const turn = this.currentTurn();
    if (turn) turn.replyCancelledAt = this.now();
    this.pendingDecision = true;
    this.trace('guard', '对话被插话打断', '旧回复已取消；新的完整输入到来后重新判断行为。', { turnId });
    this.emit();
    return true;
  }
  private persistLife() {
    try { this.options.persistLife?.({ mind: this.state.mind, memories: this.state.memories }); }
    catch { this.trace('error', '生活记忆保存失败', '这次经历仍在当前会话中，重启前请检查数据目录。'); }
  }
  private remember(text: string, source: Memory['source'], evidenceIds: string[] = [], evidenceText?: string) {
    if (this.state.memories.some(memory => memory.text === text)) return;
    this.state.memories.push({ id: randomUUID(), text, source, at: this.now(), evidenceIds, evidenceText });
    this.state.memories = boundedMemories(this.state.memories);
    try { this.options.persist?.(this.state.memories); }
    catch { this.trace('error', '记忆保存失败', '当前记忆仍在本次会话中，重启后可能丢失。'); }
  }
  start() {
    if (this.timer) return;
    this.lastTick = this.now();
    this.nextTickAt = this.lastTick + DECISION_INTERVAL_MS;
    this.timer = setInterval(() => {
      const now = this.now();
      const dt = Math.min(0.5, Math.max(0, (now - this.lastTick) / 1000));
      this.lastTick = now;
      this.tick(dt);
      if (now - this.lastEmit >= 200) { this.lastEmit = now; this.emit(); }
    }, 100);
    this.decisionTimer = setInterval(() => {
      const now = this.now();
      this.nextTickAt = now + DECISION_INTERVAL_MS;
      if (this.state.paused) return;
      this.state.scheduler.ticks++;
      this.state.scheduler.lastTickAt = now;
      void this.decide();
    }, DECISION_INTERVAL_MS);
    this.refreshScheduler();
    if (this.urgentDecision) this.wakeInteraction();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.decisionTimer) clearInterval(this.decisionTimer);
    if (this.inputTimer) clearTimeout(this.inputTimer);
    this.inputTimer = null;
    this.timer = null; this.decisionTimer = null; this.cancelRequests(); this.refreshScheduler(); this.persistLife();
  }
  message(text: string, source: MessageInput['source'] = 'text'): MessageReceipt {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 1200) throw new Error('消息长度应为 1–1200 个字符。');
    this.cancelRequests();
    const previous = this.currentTurn();
    if (previous) previous.supersededAt = this.now();
    this.state.intentVersion++; this.state.version++;
    this.lastThoughtAt = -Infinity;
    this.nativeListening = false;
    this.state.intent = { id: randomUUID(), text: trimmed, completed: false, createdAt: this.now(), ...(this.state.nativeVoiceActive ? { replyChannel: 'native' as const } : {}) };
    this.state.turns.push({ id: this.state.intent.id, source, receivedAt: this.now(), previousAction: this.state.agent.action?.id ?? null,
      decisionStartedAt: null, decisionAt: null, appliedAt: null, appliedAction: null, replyAt: null, supersededAt: null, replyCancelledAt: null, error: null });
    this.state.turns = this.state.turns.slice(-32);
    // Yield an in-progress action while the new instruction is being evaluated.
    // Its progress is preserved; only Jev may choose to resume, replace or cancel it.
    this.state.attending = true;
    this.state.reflection = null; this.state.error = null;
    this.chat(trimmed, 'user', this.state.intent.id);
    addEpisode(this.state.mind, { id: this.state.intent.id, kind: 'conversation', role: 'user', text: trimmed, at: this.now(), epoch: this.state.epoch, requestId: this.state.intent.id });
    this.state.mind.drives.connection = clamp(this.state.mind.drives.connection - 12);
    this.persistLife();
    this.trace('guard', '收到新的指令', '旧决策与旧慢思考已取消，当前动作等待快系统重新评估。', { turnId: this.state.intent.id });
    this.pendingDecision = true;
    this.emit();
    this.wakeInteraction();
    return { ok: true, turnId: this.state.intent.id, receivedAt: this.state.intent.createdAt, duplicate: false };
  }
  pause(paused: boolean) {
    if (paused === this.state.paused) return;
    this.cancelRequests(); this.state.paused = paused; this.state.version++;
    this.pendingDecision = true;
    this.trace('guard', paused ? '世界已暂停' : '世界继续运行', paused ? '动作进度、需求变化和模型请求均已暂停。' : '从当前状态重新评估下一步。');
    this.emit();
    if (!paused && this.urgentDecision) this.wakeInteraction();
  }
  speed(speed: 1 | 2 | 4) { this.state.speed = speed; this.emit(); }
  setProactiveChat(enabled: boolean) {
    this.state.mind.settings.proactiveChat = enabled;
    this.persistLife(); this.emit();
  }
  forgetMemory(id: string): boolean {
    const target = this.state.memories.find(m => m.id === id);
    if (!target) return false;
    this.cancelRequests();
    const ids = new Set(target.evidenceIds ?? []);
    this.state.memories = this.state.memories.filter(m => m.id !== id && !m.evidenceIds?.some(e => ids.has(e)));
    this.state.mind.episodes = this.state.mind.episodes.filter(e => !ids.has(e.id));
    this.state.mind.journal = this.state.mind.journal.filter(j => !j.evidence.some(e => ids.has(e.id)));
    this.state.mind.goals = this.state.mind.goals.filter(g => !g.evidenceIds.some(e => ids.has(e)));
    // Remove derived conversation/advice so a forgotten preference cannot be re-ingested.
    this.state.messages = this.state.messages.filter(m => m.role === 'user' && !ids.has(m.id));
    this.state.traces = this.state.traces.filter(t => t.kind === 'action');
    this.state.turns = this.state.turns.filter(t => !ids.has(t.id));
    this.state.reflection = null;
    this.state.mind.innerVoice = { text: '把这一页轻轻翻过去，接着体验眼前的生活。', source: 'experience', at: this.now() };
    if (this.state.intent && ids.has(this.state.intent.id)) this.state.intent = null;
    this.state.attending = false;
    this.state.intentVersion++; this.state.version++; this.pendingDecision = true;
    try { this.options.persist?.(this.state.memories); } catch { this.trace('error', '记忆保存失败', '删除暂时只在本次会话生效。'); }
    this.persistLife(); this.emit(); return true;
  }
  reset() {
    this.nativeListening = false;
    if (this.inputTimer) clearTimeout(this.inputTimer);
    this.inputTimer = null; this.urgentDecision = false;
    this.cancelRequests(); this.state = this.initialState(this.state.memories, this.state.mind);
    this.lastThoughtAt = -Infinity;
    // Resetting the world must not bypass the rate limit or a provider Retry-After.
    this.state.scheduler.lastRequestAt = Number.isFinite(this.lastDecisionAt) ? this.lastDecisionAt : null;
    this.pendingDecision = true; this.nextObservationAt = 0; this.persistLife(); this.emit();
  }
  tick(realSeconds: number) {
    if (this.state.paused || realSeconds <= 0) return;
    const dt = Math.min(realSeconds, 0.5) * this.state.speed;
    this.state.elapsed += dt;
    const needs = this.state.agent.needs;
    const before = { ...needs };
    needs.energy = clamp(needs.energy - dt * 0.05);
    needs.satiety = clamp(needs.satiety - dt * 0.045);
    needs.hydration = clamp(needs.hydration - dt * 0.07);
    needs.happiness = clamp(needs.happiness - dt * 0.025);
    this.state.objects.plantMoisture = clamp(this.state.objects.plantMoisture - dt * 0.035);
    advanceMind(this.state, dt);
    if ((Object.keys(needs) as Need[]).some(need => before[need] >= 20 && needs[need] < 20)) {
      this.state.version++; this.pendingDecision = true;
    }
    const action = this.state.agent.action;
    if (!action || this.state.attending) return;
    if (this.state.elapsed - action.startedAt > 120) {
      this.trace('guard', '动作超出承诺期限', `${label(action.id)}未能按时完成，已取消并重新评估。`);
      this.state.agent.action = null; this.state.version++; this.pendingDecision = true; return;
    }
    if (action.phase === 'walking') {
      let travel = dt * 2;
      while (action.path.length && travel > 0) {
        const destination = action.path[0];
        const remaining = distance(this.state.agent.position, destination);
        if (remaining <= travel) { this.state.agent.position = { ...destination }; action.path.shift(); travel -= remaining; }
        else {
          const p = this.state.agent.position;
          this.state.agent.position = { x: p.x + (destination.x - p.x) / remaining * travel, z: p.z + (destination.z - p.z) / remaining * travel };
          travel = 0;
        }
      }
      if (!action.path.length) {
        action.phase = 'acting'; action.elapsed = 0;
        this.trace('action', `到达：${ACTIONS[action.id].object}`, `开始${label(action.id)}，完成后才结算效果。`);
      }
      return;
    }
    action.elapsed += dt;
    action.progress = Math.min(1, action.elapsed / ACTIONS[action.id].duration);
    if (action.progress < 1) return;
    if (!Object.hasOwn(candidatesFor(this.state), action.id)) {
      this.state.agent.action = null; this.state.version++; this.pendingDecision = true;
      this.trace('guard', '动作前提已改变', '没有应用过期动作的效果。'); return;
    }
    const spec = ACTIONS[action.id];
    const changes: string[] = [];
    for (const [need, amount] of Object.entries(spec.effects) as [Need, number][]) {
      const old = needs[need]; needs[need] = clamp(old + amount);
      const delta = Math.round(needs[need] - old);
      changes.push(`${NEED_NAMES[need]} ${delta >= 0 ? '+' : ''}${delta}`);
    }
    if (action.id === 'water') { this.state.objects.plantMoisture = 100; changes.push('植物已浇水'); }
    if (action.id === 'eat') this.state.objects.dishesClean = false;
    if (action.id === 'wash') { this.state.objects.dishesClean = true; changes.push('餐具已洗净'); }
    const effects = changes.join(' · ');
    const outcome = { id: randomUUID(), action: action.id, requestId: action.requestId, at: this.now(), effects };
    this.state.outcomes.push(outcome);
    this.state.outcomes = this.state.outcomes.slice(-60);
    this.state.metrics.completed++;
    this.trace('action', `完成：${spec.label}`, effects);
    recordOutcome(this.state, outcome, action.goalId);
    this.remember(`完成过${spec.label}：${effects}。`, 'experience', [outcome.id]);
    this.persistLife();
    this.state.agent.action = null; this.state.version++;
    this.pendingDecision = true;
  }

  async decide(): Promise<void> {
    const now = this.now();
    if (this.state.paused || this.nativeListening || this.fastController || now < this.lastDecisionAt + DECISION_INTERVAL_MS || now < this.retryAt) return;
    if (this.state.reflection && !this.state.reflection.accepted && now - this.state.reflection.createdAt > 60000) {
      this.state.reflection = null; this.state.version++; this.pendingDecision = true;
      this.trace('guard', '旧想法已过期', '重新观察眼前的生活，过期建议不会一直占着思考的位置。');
    }
    if (!this.slowController && (!this.state.reflection || this.state.reflection.accepted) && reflectionOpportunity(this.state, now).due && now - this.lastInnerCheckAt >= 15000) {
      this.pendingDecision = true;
      this.lastInnerCheckAt = now;
    }
    // A one-second tick is a scheduling opportunity, not an unconditional model request.
    // Keep an accepted action running. Reconsider only new input, an outcome, urgent need,
    // or returned advice. An intentional idle gets a bounded observation interval.
    if (!this.pendingDecision && (this.state.agent.action || this.slowController || now < this.nextObservationAt)) return;
    const controller = new AbortController(); this.fastController = controller;
    const context = this.context(); const { epoch, version } = this.state;
    this.pendingDecision = false;
    this.urgentDecision = false;
    if (this.inputTimer) clearTimeout(this.inputTimer);
    this.inputTimer = null;
    this.state.deciding = true; this.lastDecisionAt = now;
    const turn = this.currentTurn();
    if (turn && turn.decisionAt === null) { turn.decisionStartedAt = now; turn.error = null; }
    this.state.scheduler.lastRequestAt = now;
    if (this.state.mode === 'live') this.state.metrics.jevCalls++;
    this.emit();
    try {
      const decision = await this.options.fast.decide(context, controller.signal);
      if (controller.signal.aborted || epoch !== this.state.epoch || version !== this.state.version || this.state.paused) {
        if (epoch === this.state.epoch) {
          this.state.metrics.discarded++;
          this.pendingDecision = true;
        }
        return;
      }
      if (!Object.hasOwn(context.candidates, decision.action)) {
        this.trace('guard', '拒绝非法动作', '所选动作不在本次提供的候选集合中。');
        this.retryAt = this.now() + IDLE_RECHECK_MS; this.pendingDecision = true; return;
      }
      this.state.decision = decision; this.state.metrics.decisions++;
      this.state.attending = false;
      if (turn && turn.decisionAt === null) turn.decisionAt = this.now();
      this.state.error = null; this.failures = 0; this.retryAt = 0;
      this.trace('decision', label(decision.action), decision.source === 'demo' ? '本地规则选择 · 非 Jev 推理，未生成模型置信度。' : `Jev 选择动作；中断概率 ${Math.round(decision.interrupt * 100)}%，慢思考概率 ${Math.round(decision.think * 100)}%。`, { latencyMs: decision.latencyMs, confidence: decision.confidence, source: decision.source, receipt: decision.receipt, requestedAt: now, turnId: this.state.intent?.id });
      const reflection = this.state.reflection;
      // Providers map an explicit accept/reject verdict to 1/0. The model's confidence
      // is not another hidden gate; diary evidence and execution constraints remain separate.
      if (reflection && !reflection.accepted && reflection.intentVersion === this.state.intentVersion && this.now() - reflection.createdAt <= 60000 && decision.acceptReflection >= 0.5) {
        const automatic = reflection.purpose === 'autonomous';
        const insightAccepted = reflection.self && acceptInsight(this.state, reflection.self, reflection.source, this.now(), reflection.contextEvidenceIds ?? []);
        reflection.accepted = !automatic || Boolean(insightAccepted);
        if (automatic && !insightAccepted) this.state.reflection = null;
        const canShare = !automatic || (insightAccepted && this.state.mind.settings.proactiveChat && (this.state.mind.lastSharedAt === null || now - this.state.mind.lastSharedAt >= AUTONOMOUS_THOUGHT_INTERVAL_MS));
        if (reflection.reply && canShare && (automatic || !this.state.intent?.replySuppressed)) {
          this.chat(reflection.reply, 'agent', randomUUID(), automatic);
          if (!automatic && turn) { turn.replyAt = this.now(); turn.error = null; }
          if (automatic) this.state.mind.lastSharedAt = now;
        }
        if (automatic) this.state.mind.reflectedThrough = Math.max(this.state.mind.reflectedThrough, reflection.evidenceSequence ?? 0);
        const source = this.state.mind.episodes.find(e => e.id === this.state.intent?.id && e.role === 'user');
        if (!automatic && source) reflection.memories.forEach(text => this.remember(text, 'reflection', [source.id], source.text));
        if (reflection.self && !insightAccepted) this.trace('guard', '随记缺少有效经历来源', '保留真实经历，没有把无依据的自述写入长期记忆。');
        this.persistLife();
        if (reflection.accepted) this.trace('thought', '快系统采纳了慢思考建议', reflection.summary);
      }
      // This is the sole slow-provider entrypoint: only the fast system can request a thought.
      const automatic = !this.state.intent || this.state.intent.completed;
      const automaticReady = this.state.mind.lastAutonomousAttemptAt === null || now - this.state.mind.lastAutonomousAttemptAt >= AUTONOMOUS_THOUGHT_INTERVAL_MS;
      if (!this.state.nativeVoiceActive && (automatic || this.state.intent?.replyChannel !== 'native') && decision.think >= 0.7 && !this.slowController && this.now() - this.lastThoughtAt >= 15000 && (!automatic || automaticReady) && (automatic || !this.state.intent?.replySuppressed)) void this.reflect();
      // All candidate actions are reversible household activities. Confidence is diagnostic,
      // not permission to move: several reasonable choices must not paralyze the executor.
      if (decision.requestComplete >= 0.8 && this.state.intent && !this.state.intent.completed && !this.state.agent.action) {
        this.state.intent.completed = true;
        this.trace('guard', '当前请求已满足', '依据已完成的结果、环境状态或已采纳的对话建议结束请求。');
      }
      if (decision.action === 'continue' || this.state.agent.action?.id === decision.action) {
        if (this.state.agent.action && this.state.intent && !this.state.intent.completed) this.state.agent.action.requestId = this.state.intent.id;
        this.applied(decision.action);
        return;
      }
      const running = this.state.agent.action;
      if (running && decision.interrupt < 0.7) {
        this.trace('guard', '继续已承诺的动作', `${label(running.id)}仍在执行；Jev 没有批准中断。`); return;
      }
      // Resolve the new path before cancelling a useful existing action.
      let path = null;
      if (decision.action !== 'idle') {
        if (!isAction(decision.action) || !Object.hasOwn(candidatesFor(this.state), decision.action)) {
          this.trace('guard', '动作条件已变化', '重新读取可执行动作。'); this.pendingDecision = true; return;
        }
        path = findPath(this.state.agent.position, ACTIONS[decision.action].destination);
        if (!path) {
          this.trace('guard', '目标暂时不可达', `${ACTIONS[decision.action].object}的路径受阻，保留当前活动。`);
          this.pendingDecision = true; this.retryAt = this.now() + IDLE_RECHECK_MS; return;
        }
      }
      if (running) {
        this.trace('action', `中断：${label(running.id)}`, '未完成的动作不会产生效果；重新从实际位置出发。');
        this.state.metrics.interrupted++;
        addEpisode(this.state.mind, { id: randomUUID(), kind: 'interruption', action: running.id, at: this.now(), epoch: this.state.epoch, requestId: running.requestId, text: `${label(running.id)}还没完成就停下了；没有结算效果，自己的小愿望可以以后继续。` });
        this.persistLife();
        this.state.agent.action = null; this.state.version++;
      }
      if (decision.action === 'idle') { this.applied('idle'); this.nextObservationAt = this.now() + IDLE_RECHECK_MS; return; }
      if (!path) return;
      const spec = ACTIONS[decision.action];
      const requestId = this.state.intent && !this.state.intent.completed ? this.state.intent.id : null;
      const goal = activeGoal(this.state.mind);
      this.state.agent.action = { id: spec.id, startedAt: this.state.elapsed, requestId, goalId: goal && remainingGoalActions(goal).includes(spec.id) ? goal.id : undefined, phase: 'walking', progress: 0, elapsed: 0, path };
      this.state.metrics.started++;
      this.applied(decision.action);
      this.state.version++; this.trace('action', `开始：${spec.label}`, `前往${spec.object}，到达后执行。`);
    } catch (error) {
      if (controller.signal.aborted || epoch !== this.state.epoch) return;
      this.failures++;
      const message = error instanceof ProviderError ? error.message : '决策请求失败，正在保留现场并等待重试。';
      this.state.error = message; this.trace('error', '快系统暂时不可用', message);
      if (turn) turn.error = message;
      this.pendingDecision = true;
      this.retryAt = this.now() + Math.max(error instanceof ProviderError ? error.retryAfterMs : 5000, Math.min(60000, 2000 * 2 ** Math.min(this.failures, 5)));
    } finally {
      if (this.fastController === controller) { this.fastController = null; this.state.deciding = false; }
      this.emit();
      if (this.urgentDecision) this.wakeInteraction();
    }
  }

  private async reflect(): Promise<void> {
    this.lastThoughtAt = this.now();
    if (!this.options.slow) {
      this.trace('error', '快系统请求慢思考', '尚未配置语言模型，请设置 LLM_API_KEY 和 LLM_MODEL。');
      this.chat('这个问题需要慢思考，但我的语言模型还没有连接。'); return;
    }
    const controller = new AbortController(); this.slowController = controller;
    const { epoch, intentVersion } = this.state;
    const context = this.context();
    const purpose = !this.state.intent || this.state.intent.completed ? 'autonomous' : 'conversation';
    const evidenceSequence = this.state.mind.sequence;
    const contextEvidenceIds = recall(context.state).episodes.map(e => e.id);
    if (purpose === 'autonomous') {
      this.state.mind.lastAutonomousAttemptAt = this.now();
      this.persistLife();
    }
    const started = this.now(); this.state.thinking = true;
    if (this.state.mode === 'live') this.state.metrics.llmCalls++;
    this.trace('thought', '快系统发起慢思考', purpose === 'autonomous' ? 'Milo 想回顾刚才的经历，整理自己的感受和下一个小愿望。' : '结合自己的性格、心情和想起的经历，回应这次对话。'); this.emit();
    try {
      const result = await this.options.slow.reflect(context, controller.signal);
      if (controller.signal.aborted || epoch !== this.state.epoch || intentVersion !== this.state.intentVersion || this.now() - started > 35000 || this.state.paused) {
        if (epoch === this.state.epoch) this.state.metrics.discarded++;
        return;
      }
      this.state.reflection = { ...result, id: randomUUID(), createdAt: this.now(), intentVersion, accepted: false, source: this.state.mode === 'demo' ? 'demo' : 'llm', purpose, evidenceSequence, contextEvidenceIds };
      this.state.metrics.reflections++; this.state.version++;
      this.trace('thought', '慢思考建议已返回', result.summary, { latencyMs: this.now() - started, source: this.state.mode === 'live' ? 'llm' : 'demo', receipt: result.receipt });
      this.pendingDecision = true;
      if (purpose === 'conversation') this.wakeInteraction();
    } catch (error) {
      if (controller.signal.aborted || epoch !== this.state.epoch) return;
      const message = error instanceof ProviderError ? error.message : '慢思考请求失败，当前世界继续运行。';
      const turn = this.currentTurn();
      if (purpose === 'conversation' && turn) turn.error = message;
      this.trace('error', '慢思考暂时不可用', message, { receipt: error instanceof ProviderError ? error.receipt : undefined, turnId: turn?.id });
      this.chat('这次回复没有生成成功。你可以重新提问，也可以直接改口；正在做的事情会继续。', 'system');
    } finally {
      if (this.slowController === controller) { this.slowController = null; this.state.thinking = false; }
      this.emit();
      if (controller.signal.aborted && intentVersion !== this.state.intentVersion && this.state.intent && !this.state.intent.completed && !this.state.intent.replySuppressed) {
        this.pendingDecision = true; this.wakeInteraction();
      }
    }
  }
}
