import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../server/runtime';
import { DemoFastProvider } from '../server/providers';
import { findPath, segmentClear, walkable } from '../server/navigation';
import { ACTIONS } from '../shared/world';
import type { Decision, FastProvider, SlowProvider, ThoughtResult } from '../shared/types';

const decision = (values: Partial<Decision> = {}): Decision => ({ action: 'drink', source: 'jev', confidence: 0.9, probabilities: {}, interrupt: 1, think: 0, requestComplete: 0, acceptReflection: 0, latencyMs: 10, ...values });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const clocks = new WeakMap<AgentRuntime, { now: number }>();
function makeRuntime(fast: FastProvider = new DemoFastProvider(), slow: SlowProvider | null = null) {
  const clock = { now: 0 };
  const runtime = new AgentRuntime({ fast, slow, mode: 'demo', now: () => clock.now });
  clocks.set(runtime, clock);
  return runtime;
}
// These tests inspect discrete decisions after an observation interval. The scheduler
// has separate fake-timer tests for exact one-second boundaries and in-flight requests.
async function decide(runtime: AgentRuntime) {
  clocks.get(runtime)!.now += 5000;
  await runtime.decide();
}
function finishAction(runtime: AgentRuntime) {
  for (let tick = 0; tick < 500 && runtime.state.agent.action; tick++) runtime.tick(0.2);
  expect(runtime.state.agent.action).toBeNull();
}

describe('world navigation', () => {
  it('connects every furniture interaction point without crossing walls or furniture', () => {
    const points = [{ x: -2.5, z: 1.5 }, ...Object.values(ACTIONS).map(a => a.destination)];
    for (const from of points) for (const to of points) {
      const path = findPath(from, to);
      expect(path, `${JSON.stringify(from)} -> ${JSON.stringify(to)}`).not.toBeNull();
      let previous = from;
      for (const point of path!) { expect(segmentClear(previous, point)).toBe(true); previous = point; }
      expect(previous).toEqual(to);
    }
  });
  it('rejects a destination inside furniture or outside the world', () => {
    expect(walkable(ACTIONS.sleep.position)).toBe(false);
    expect(findPath({ x: -2.5, z: 1.5 }, { x: 99, z: 0 })).toBeNull();
  });
});

describe('authoritative action runtime', () => {
  it('applies effects only after physically reaching and finishing an action', async () => {
    const runtime = makeRuntime();
    runtime.message('请喝水');
    const before = runtime.state.agent.needs.hydration;
    await decide(runtime);
    expect(runtime.state.agent.action?.id).toBe('drink');
    expect(runtime.state.metrics.completed).toBe(0);
    expect(runtime.state.agent.needs.hydration).toBe(before);
    let previous = { ...runtime.state.agent.position };
    for (let i = 0; i < 500 && runtime.state.agent.action; i++) {
      runtime.tick(0.1);
      expect(segmentClear(previous, runtime.state.agent.position)).toBe(true);
      previous = { ...runtime.state.agent.position };
    }
    expect(runtime.state.metrics.completed).toBe(1);
    expect(runtime.state.agent.needs.hydration).toBeGreaterThan(before + 30);
    expect(runtime.state.agent.position).toEqual(ACTIONS.drink.destination);
    expect(runtime.state.outcomes[0].requestId).toBe(runtime.state.intent?.id);
    expect(runtime.state.memories[0].source).toBe('experience');
  });
  it('selects ordered user instructions one step at a time', async () => {
    const runtime = makeRuntime();
    runtime.message('先喝水，再给植物浇水，最后看书');
    for (const id of ['drink', 'water', 'read']) {
      await decide(runtime); expect(runtime.state.agent.action?.id).toBe(id); finishAction(runtime);
    }
    await decide(runtime);
    expect(runtime.state.intent?.completed).toBe(true);
    expect(runtime.state.outcomes.map(o => o.action)).toEqual(['drink', 'water', 'read']);
  });
  it('interrupts on a stop instruction without awarding unfinished effects', async () => {
    const runtime = makeRuntime();
    runtime.message('去睡觉'); await decide(runtime);
    runtime.tick(0.2);
    const energy = runtime.state.agent.needs.energy;
    runtime.message('停止'); await decide(runtime);
    expect(runtime.state.agent.action).toBeNull();
    expect(runtime.state.agent.needs.energy).toBe(energy);
    expect(runtime.state.metrics.completed).toBe(0);
    expect(runtime.state.outcomes).toEqual([]);
  });
  it('keeps a stop instruction active as a hold across later decisions', async () => {
    const runtime = makeRuntime(); runtime.message('停止');
    await decide(runtime); await decide(runtime); await decide(runtime);
    expect(runtime.state.agent.action).toBeNull();
    runtime.message('去看会儿书吧'); await decide(runtime);
    expect(runtime.state.agent.action?.id).toBe('read');
  });
  it('credits an already-running useful action to the new request without repeating it', async () => {
    const runtime = makeRuntime(); await decide(runtime);
    expect(runtime.state.agent.action?.id).toBe('drink');
    runtime.message('请喝水'); await decide(runtime); finishAction(runtime);
    await decide(runtime);
    expect(runtime.state.intent?.completed).toBe(true);
    expect(runtime.state.outcomes).toHaveLength(1);
  });
  it('does not get stuck requesting already-clean dishes', async () => {
    const runtime = makeRuntime(); runtime.message('请清洗餐具'); await decide(runtime);
    expect(runtime.state.intent?.completed).toBe(true);
    expect(runtime.state.agent.action).toBeNull();
  });
  it('pause freezes physics and prevents model requests', async () => {
    const fast = { decide: vi.fn(async () => decision()) };
    const runtime = makeRuntime(fast);
    await decide(runtime); runtime.pause(true);
    const snapshot = runtime.snapshot(); runtime.tick(0.5); await decide(runtime);
    expect(runtime.snapshot()).toEqual(snapshot);
    expect(fast.decide).toHaveBeenCalledTimes(1);
  });
  it('never allows a stale fast response to override a newer instruction', async () => {
    const result = deferred<Decision>();
    const runtime = makeRuntime({ decide: () => result.promise });
    runtime.message('去工作'); const pending = decide(runtime);
    runtime.message('去睡觉'); result.resolve(decision({ action: 'work' })); await pending;
    expect(runtime.state.agent.action).toBeNull();
    expect(runtime.state.intent?.text).toBe('去睡觉');
    expect(runtime.state.metrics.discarded).toBe(1);
  });
  it('discards fast responses whose semantic world version changed', async () => {
    const result = deferred<Decision>();
    const runtime = makeRuntime({ decide: () => result.promise });
    const pending = decide(runtime); runtime.state.version++;
    result.resolve(decision()); await pending;
    expect(runtime.state.agent.action).toBeNull();
  });
  it('executes a valid low-confidence household action without calling an unrequested LLM', async () => {
    const slow = { reflect: vi.fn() };
    const runtime = makeRuntime({ decide: async () => decision({ confidence: 0.1, think: 0 }) }, slow);
    await decide(runtime);
    expect(runtime.state.agent.action?.id).toBe('drink');
    expect(runtime.state.metrics.started).toBe(1);
    expect(slow.reflect).not.toHaveBeenCalled();
    finishAction(runtime);
    expect(runtime.state.metrics.completed).toBe(1);
    expect(runtime.state.agent.needs.hydration).toBeGreaterThan(75);
  });
  it('slow thinking is called only when requested, and cannot directly start actions', async () => {
    const result = deferred<ThoughtResult>();
    const slow = { reflect: vi.fn(() => result.promise) };
    const fast = { decide: vi.fn(async () => decision({ action: 'idle', think: 0 })) };
    const runtime = makeRuntime(fast, slow);
    await decide(runtime); expect(slow.reflect).not.toHaveBeenCalled();
    fast.decide.mockResolvedValue(decision({ action: 'idle', think: 1 }));
    await decide(runtime); expect(slow.reflect).toHaveBeenCalledTimes(1);
    result.resolve({ summary: '去睡觉', reply: '建议休息', suggestedActions: ['sleep'], memories: ['用户喜欢午睡'] });
    await vi.waitFor(() => expect(runtime.state.reflection).not.toBeNull());
    expect(runtime.state.agent.action).toBeNull();
    expect(runtime.state.memories).toEqual([]);
    expect(runtime.state.reflection?.accepted).toBe(false);
  });
  it('accepts memory proposals only after a fast-system review', async () => {
    const fast = { decide: vi.fn(async () => decision({ action: 'idle', think: 1 })) };
    const slow = { reflect: async () => ({ summary: '记录偏好', reply: '已形成建议', suggestedActions: [], memories: ['用户偏好先喝水'] }) };
    const runtime = makeRuntime(fast, slow);
    runtime.message('请记住，我喜欢先喝水。');
    await decide(runtime);
    await vi.waitFor(() => expect(runtime.state.reflection).not.toBeNull());
    expect(runtime.state.memories).toHaveLength(0);
    fast.decide.mockResolvedValue(decision({ action: 'idle', acceptReflection: 1 }));
    await decide(runtime);
    expect(runtime.state.memories[0].source).toBe('reflection');
    expect(runtime.state.memories[0].evidenceIds).toEqual([runtime.state.intent!.id]);
    expect(runtime.state.memories[0].evidenceText).toBe('请记住，我喜欢先喝水。');
  });
  it('discards slow plans after a new instruction or reset', async () => {
    const result = deferred<ThoughtResult>();
    const runtime = makeRuntime({ decide: async () => decision({ action: 'idle', think: 1 }) }, { reflect: () => result.promise });
    runtime.message('安排一天'); await decide(runtime); runtime.reset();
    result.resolve({ summary: '旧计划', reply: '旧回复', suggestedActions: ['work'], memories: ['旧偏好'] });
    await Promise.resolve(); await Promise.resolve();
    expect(runtime.state.reflection).toBeNull(); expect(runtime.state.agent.action).toBeNull();
    expect(runtime.state.memories).toEqual([]);
  });
  it('lets the fast system request fresh thinking for a new user message without an old cooldown', async () => {
    const slow = { reflect: vi.fn(async () => ({ summary: '新建议', reply: '', suggestedActions: [], memories: [] })) };
    const runtime = makeRuntime({ decide: async () => decision({ action: 'idle', think: 1 }) }, slow);
    runtime.message('帮我安排今天'); await decide(runtime);
    await vi.waitFor(() => expect(runtime.state.reflection).not.toBeNull());
    runtime.message('换一个计划'); await decide(runtime);
    expect(slow.reflect).toHaveBeenCalledTimes(2);
  });
  it('provider failures never silently switch to the demo planner or expose thrown secrets', async () => {
    const runtime = makeRuntime({ decide: async () => { throw new Error('private-key-value'); } });
    await decide(runtime);
    expect(runtime.state.agent.action).toBeNull();
    expect(runtime.state.error).toBeTruthy();
    expect(JSON.stringify(runtime.snapshot())).not.toContain('private-key-value');
  });
});
