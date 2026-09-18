import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime } from '../server/runtime';
import { DemoFastProvider, modelContext } from '../server/providers';
import { acceptInsight, activeGoal, addEpisode, AUTONOMOUS_THOUGHT_INTERVAL_MS, createMind, personalInclinations, recall, reflectionOpportunity } from '../server/mind';
import { LifeStore } from '../server/life-store';
import { candidatesFor } from '../shared/world';
import type { Decision, FastProvider, SlowProvider, ThoughtResult } from '../shared/types';

const answer = (overrides: Partial<Decision> = {}): Decision => ({ action: 'idle', confidence: 0.8, probabilities: {}, interrupt: 1, think: 0, requestComplete: 0, acceptReflection: 0, source: 'jev', latencyMs: 0, ...overrides });
function fixture(fast: FastProvider = new DemoFastProvider(), slow: SlowProvider | null = null) {
  let now = 100000;
  const runtime = new AgentRuntime({ mode: 'live', fast, slow, now: () => now });
  return { runtime, advance: (ms: number) => { now += ms; }, decide: async () => { now += 5000; await runtime.decide(); } };
}
function complete(runtime: AgentRuntime) {
  for (let i = 0; i < 1000 && runtime.state.agent.action; i++) runtime.tick(0.1);
  expect(runtime.state.agent.action).toBeNull();
}

describe('a continuous personal life', () => {
  it('has wishes but no invented past, and a changed personality changes a free choice', async () => {
    const { runtime } = fixture();
    expect(runtime.state.mind.episodes).toEqual([]);
    expect(runtime.state.mind.journal).toEqual([]);
    expect(activeGoal(runtime.state.mind)?.completedActions).toEqual([]);
    runtime.state.mind.goals = [];
    runtime.state.agent.needs = { energy: 95, satiety: 95, hydration: 95, happiness: 95 };
    runtime.state.objects.plantMoisture = 100;
    const context = () => ({ state: runtime.snapshot(), candidates: candidatesFor(runtime.state) });
    const demo = new DemoFastProvider();
    expect((await demo.decide(context(), new AbortController().signal)).action).toBe('read');
    runtime.state.mind.personality.traits = { curiosity: 5, care: 5, mastery: 95, connection: 5 };
    runtime.state.mind.drives = { curiosity: 5, care: 5, mastery: 95, connection: 5 };
    runtime.state.mind.affinity.work = 95;
    expect((await demo.decide(context(), new AbortController().signal)).action).toBe('work');
  });
  it('keeps Jev in charge even when its choice differs from the character inclination', async () => {
    const f = fixture({ decide: async () => answer({ action: 'work' }) });
    expect(personalInclinations(f.runtime.state)[0].action).not.toBe('work');
    await f.decide();
    expect(f.runtime.state.agent.action?.id).toBe('work');
    expect(f.runtime.state.metrics.completed).toBe(0);
  });
  it('a wish gains progress only on actual outcomes, survives interruption and world reset', async () => {
    const fast = { decide: vi.fn(async () => answer({ action: 'water' })) };
    const f = fixture(fast);
    const goal = activeGoal(f.runtime.state.mind)!;
    await f.decide();
    expect(goal.completedActions).toEqual([]);
    expect(f.runtime.state.mind.episodes).toEqual([]);
    f.runtime.message('先停下'); fast.decide.mockResolvedValue(answer()); await f.decide();
    expect(goal.completedActions).toEqual([]);
    expect(f.runtime.state.mind.episodes.at(-1)?.kind).toBe('interruption');
    f.runtime.reset();
    expect(activeGoal(f.runtime.state.mind)?.id).toBe(goal.id);
    fast.decide.mockResolvedValue(answer({ action: 'water' })); await f.decide(); complete(f.runtime);
    expect(activeGoal(f.runtime.state.mind)?.completedActions).toEqual(['water']);
    f.runtime.reset();
    expect(activeGoal(f.runtime.state.mind)?.completedActions).toEqual(['water']);
    fast.decide.mockResolvedValue(answer({ action: 'read' })); await f.decide(); complete(f.runtime);
    expect(f.runtime.state.mind.goals.find(g => g.id === goal.id)?.status).toBe('fulfilled');
  });
  it('actual experience reduces curiosity pressure and creates a preference for variety', async () => {
    const f = fixture({ decide: async () => answer({ action: 'read' }) });
    f.runtime.state.mind.goals = [];
    const initialCuriosity = f.runtime.state.mind.drives.curiosity;
    const initialPreference = personalInclinations(f.runtime.state).find(i => i.action === 'read')!.score;
    await f.decide(); complete(f.runtime);
    expect(f.runtime.state.mind.drives.curiosity).toBeLessThan(initialCuriosity);
    expect(personalInclinations(f.runtime.state).find(i => i.action === 'read')!.score).toBeLessThan(initialPreference);
    expect(f.runtime.state.mind.lifetimeCompleted).toBe(1);
  });
  it('relevant old memories reach both models rather than only the latest messages', () => {
    const { runtime } = fixture();
    runtime.state.memories = [{ id: 'old-preference', text: '用户喜欢雨天读书', source: 'reflection', evidenceText: '我喜欢雨天安安静静读书', at: 1 }];
    for (let i = 0; i < 35; i++) runtime.state.memories.push({ id: `unrelated-${i}`, text: `餐具洗好了 ${i}`, source: 'experience', at: 10000 + i });
    runtime.message('你还记得我喜欢什么天气吗？雨天还是晴天？');
    expect(recall(runtime.state).memories.some(m => m.id === 'old-preference')).toBe(true);
    const context = modelContext({ state: runtime.snapshot(), candidates: candidatesFor(runtime.state) });
    expect(context.memories.some(m => m.evidenceText === '我喜欢雨天安安静静读书')).toBe(true);
    expect(context.character.likes).toContain('安静地读一会儿书');
  });
  it('past actions and personal wishes cannot masquerade as completion of a new request in fast context', () => {
    const { runtime } = fixture();
    addEpisode(runtime.state.mind, { id: 'old-drink', kind: 'action', action: 'drink', epoch: 'previous-world', at: 1, text: '喝完了水。' });
    runtime.message('请先喝水，再浇水');
    const context = modelContext({ state: runtime.snapshot(), candidates: candidatesFor(runtime.state) }, 'fast');
    expect(context.completedForCurrentRequest).toEqual([]);
    expect(context.recalledExperiences.some(e => e.id === 'old-drink')).toBe(false);
    expect(context.character.personalWish).toBeNull();
    expect(context.character.inclinations).toEqual([]);
    expect(activeGoal(runtime.state.mind)).toBeDefined(); // Paused in focus, not erased.
    expect(modelContext({ state: runtime.snapshot(), candidates: candidatesFor(runtime.state) }).recalledExperiences.find(e => e.id === 'old-drink')?.temporalScope).toContain('previous world');
  });
  it('an exhausted body outweighs hobbies, and unavailable LLMs create no autonomous reflection opportunity', () => {
    const { runtime } = fixture();
    runtime.state.agent.needs.satiety = 0;
    expect(personalInclinations(runtime.state)[0].action).toBe('eat');
    addEpisode(runtime.state.mind, { id: 'a', kind: 'action', action: 'water', at: 1, text: '浇水' });
    addEpisode(runtime.state.mind, { id: 'b', kind: 'action', action: 'read', at: 2, text: '阅读' });
    expect(reflectionOpportunity(runtime.state, Date.now()).due).toBe(false);
  });
  it('no user command is needed for a reflection opportunity, but Jev still has to request it', async () => {
    const fast = { decide: vi.fn(async () => answer({ action: 'drink' })) };
    const slow = { reflect: vi.fn(async (): Promise<ThoughtResult> => ({ summary: '回顾', reply: '', memories: [], suggestedActions: [] })) };
    const f = fixture(fast, slow);
    await f.decide(); complete(f.runtime);
    fast.decide.mockResolvedValue(answer({ action: 'read' })); await f.decide(); complete(f.runtime);
    expect(f.runtime.state.intent).toBeNull();
    expect(reflectionOpportunity(f.runtime.state, 120000).due).toBe(true);
    expect(slow.reflect).not.toHaveBeenCalled();
    fast.decide.mockResolvedValue(answer({ think: 1 })); await f.decide();
    expect(slow.reflect).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(f.runtime.state.reflection?.purpose).toBe('autonomous'));
  });
  it('a grounded reflection changes the inner voice only after review; quiet mode suppresses sharing, not thought', async () => {
    const fast = { decide: vi.fn(async () => answer({ think: 1 })) };
    const slow: SlowProvider = { reflect: async context => ({ summary: '读书后的感受', reply: '我想安静坐一会儿。', memories: [], suggestedActions: [], self: { thought: '把好奇心留给明天也不错。', journal: '读过书后，我想给一天留一点空白。', evidenceIds: [context.state.mind.episodes[0].id], wish: null } }) };
    const f = fixture(fast, slow);
    addEpisode(f.runtime.state.mind, { id: 'read-evidence', kind: 'action', action: 'read', at: 1, text: '完成了阅读。' });
    const original = f.runtime.state.mind.innerVoice.text;
    await f.decide(); await vi.waitFor(() => expect(f.runtime.state.reflection).not.toBeNull());
    expect(f.runtime.state.mind.innerVoice.text).toBe(original);
    f.runtime.setProactiveChat(false); // Also covers toggling while a result is pending.
    fast.decide.mockResolvedValue(answer({ acceptReflection: 0.55 })); await f.decide();
    expect(f.runtime.state.mind.innerVoice.text).toBe('把好奇心留给明天也不错。');
    expect(f.runtime.state.mind.journal[0].evidence[0].id).toBe('read-evidence');
    expect(f.runtime.state.messages.some(m => m.initiative)).toBe(false);
  });
  it('never converts nonexistent evidence into a diary or a new wish', () => {
    const { runtime } = fixture();
    const old = structuredClone(runtime.state.mind);
    expect(acceptInsight(runtime.state, { thought: '假的经历', journal: '做完了所有事', evidenceIds: ['invented'], wish: { title: '新愿望', motivation: '虚构', actions: ['work'] } }, 'llm', 1, ['invented'])).toBe(false);
    expect(runtime.state.mind).toEqual(old);
  });
  it('an unaccepted stale reflection expires instead of blocking all future personal thought', async () => {
    const f = fixture({ decide: async () => answer() });
    f.runtime.state.reflection = { id: 'old', createdAt: 1, intentVersion: 0, accepted: false, purpose: 'autonomous', source: 'llm', summary: '旧想法', reply: '', memories: [], suggestedActions: [] };
    await f.decide();
    expect(f.runtime.state.reflection).toBeNull();
    expect(f.runtime.state.traces.some(t => t.title === '旧想法已过期')).toBe(true);
  });
  it('a new model-generated wish does not execute itself or overwrite an unfinished wish', () => {
    const { runtime } = fixture();
    addEpisode(runtime.state.mind, { id: 'real-event', at: 1, kind: 'action', action: 'read', text: '完成了阅读。' });
    const original = activeGoal(runtime.state.mind)!.id;
    const insight = { thought: '想认真做成一件小事。', journal: '阅读之后想试着专注一会儿。', evidenceIds: ['real-event'], wish: { title: '专注之后认真休息', motivation: '不想一味忙碌', actions: ['work', 'relax'] as const } };
    const proposal = { ...insight, wish: { ...insight.wish, actions: [...insight.wish.actions] } };
    acceptInsight(runtime.state, proposal, 'llm', 5, ['real-event']);
    expect(activeGoal(runtime.state.mind)?.id).toBe(original);
    runtime.state.mind.goals[0].status = 'fulfilled';
    acceptInsight(runtime.state, proposal, 'llm', 6, ['real-event']);
    expect(activeGoal(runtime.state.mind)?.title).toBe('专注之后认真休息');
    expect(runtime.state.agent.action).toBeNull();
    expect(activeGoal(runtime.state.mind)?.completedActions).toEqual([]);
  });
  it('limits autonomous slow calls across resets even when Jev repeatedly asks to think', async () => {
    const slow = { reflect: vi.fn(async () => ({ summary: '想想', reply: '', memories: [], suggestedActions: [] })) };
    const f = fixture({ decide: async () => answer({ think: 1 }) }, slow);
    await f.decide(); await vi.waitFor(() => expect(f.runtime.state.reflection).not.toBeNull());
    f.runtime.reset(); await f.decide(); f.runtime.reset(); await f.decide();
    expect(slow.reflect).toHaveBeenCalledTimes(1);
    f.advance(AUTONOMOUS_THOUGHT_INTERVAL_MS); await f.decide();
    expect(slow.reflect).toHaveBeenCalledTimes(2);
  });
  it('discarded late thoughts cannot change personality, journal or personal wishes', async () => {
    let resolve!: (value: ThoughtResult) => void;
    const f = fixture({ decide: async () => answer({ think: 1 }) }, { reflect: () => new Promise(r => { resolve = r; }) });
    f.runtime.message('聊聊你喜欢的生活'); await f.decide();
    const oldId = f.runtime.state.intent!.id;
    f.runtime.message('先停下'); const before = structuredClone(f.runtime.state.mind);
    resolve({ summary: '旧想法', reply: '旧回复', memories: [], suggestedActions: [], self: { thought: '旧心声', journal: '旧随记', evidenceIds: [oldId] } });
    await Promise.resolve(); await Promise.resolve();
    expect(f.runtime.state.mind).toEqual(before);
  });
});

describe('memory continuity on disk', () => {
  it('migrates original records, atomically saves personal progress and restores it in a fresh runtime', () => {
    const folder = mkdtempSync(join(tmpdir(), 'realtime-life-'));
    try {
      const legacy = join(folder, 'memories-live.json'), current = join(folder, 'life-live.json');
      const content = JSON.stringify([{ id: 'preference-1', source: 'reflection', text: '喜欢安静', at: 1 }]);
      writeFileSync(legacy, content);
      const store = new LifeStore(current, legacy), saved = store.load(1000);
      expect(saved.memories[0].id).toBe('preference-1');
      saved.mind.goals[0].completedActions.push('water');
      saved.mind.settings.proactiveChat = false; store.save(saved);
      expect(readFileSync(legacy, 'utf8')).toBe(content);
      const reloaded = new LifeStore(current, legacy).load(5000);
      const runtime = new AgentRuntime({ mode: 'live', fast: new DemoFastProvider(), slow: null, mind: reloaded.mind, memories: reloaded.memories });
      expect(activeGoal(runtime.state.mind)?.completedActions).toEqual(['water']);
      expect(runtime.state.mind.personality).toEqual(saved.mind.personality);
      expect(runtime.state.mind.settings.proactiveChat).toBe(false);
      expect(runtime.state.mind.episodes).toEqual([]); // migration invented no biography
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('refuses corrupt life files instead of silently creating a new personality and overwriting history', () => {
    const folder = mkdtempSync(join(tmpdir(), 'realtime-life-'));
    try {
      const path = join(folder, 'life.json'); writeFileSync(path, '{broken');
      const store = new LifeStore(path);
      expect(() => store.load()).toThrow('preserved');
      expect(() => store.save({ mind: createMind(), memories: [] })).toThrow('Refusing');
      expect(readFileSync(path, 'utf8')).toBe('{broken');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('forgetting a preference removes source and derived context, and does not resurrect it on restart', () => {
    const folder = mkdtempSync(join(tmpdir(), 'realtime-life-'));
    try {
      const store = new LifeStore(join(folder, 'life.json'));
      const life = store.load();
      const runtime = new AgentRuntime({ mode: 'demo', fast: new DemoFastProvider(), slow: null, ...life, persistLife: state => store.save(state) });
      runtime.message('我喜欢紫色纸鹤');
      const id = runtime.state.intent!.id;
      runtime.state.memories.push({ id: 'forget-me', text: '喜欢紫色纸鹤', source: 'reflection', at: 1, evidenceIds: [id], evidenceText: '我喜欢紫色纸鹤' });
      acceptInsight(runtime.state, { thought: '记住紫色纸鹤。', journal: '室友喜欢紫色纸鹤。', evidenceIds: [id] }, 'llm', 1, [id]);
      expect(runtime.forgetMemory('forget-me')).toBe(true);
      const reloaded = store.load();
      expect(JSON.stringify(reloaded)).not.toContain('紫色纸鹤');
      expect(JSON.stringify(modelContext({ state: runtime.snapshot(), candidates: candidatesFor(runtime.state) }))).not.toContain('紫色纸鹤');
      expect(runtime.forgetMemory('missing')).toBe(false);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
