import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime, DECISION_INTERVAL_MS, INPUT_COALESCE_MS } from '../server/runtime';
import { ProviderError } from '../server/providers';
import type { Decision, FastProvider, SlowProvider, ThoughtResult } from '../shared/types';

const active: AgentRuntime[] = [];
const answer = (overrides: Partial<Decision> = {}): Decision => ({ action: 'drink', source: 'jev', confidence: 0.13, probabilities: {}, interrupt: 1, think: 0, requestComplete: 0, acceptReflection: 0, latencyMs: 0, ...overrides });
function setup(fast: FastProvider, slow: SlowProvider | null = null) {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const runtime = new AgentRuntime({ mode: 'live', fast, slow });
  active.push(runtime);
  return runtime;
}
afterEach(() => { active.splice(0).forEach(r => r.stop()); vi.useRealTimers(); });

describe('one-second decision cadence and action commitment', () => {
  it('wakes promptly for coalesced input while preserving one-second spacing independently of world speed', async () => {
    const starts: number[] = [];
    const runtime = setup({ decide: async () => { starts.push(Date.now()); return answer(); } });
    runtime.speed(4); runtime.start();
    runtime.message('喝水'); runtime.message('去喝水');
    await vi.advanceTimersByTimeAsync(INPUT_COALESCE_MS - 1);
    expect(starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([100000 + INPUT_COALESCE_MS]);
    runtime.message('现在停止');
    await runtime.decide(); // Direct callers also cannot bypass the shared limit.
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([100000 + INPUT_COALESCE_MS, 101000 + INPUT_COALESCE_MS]);
    expect(runtime.state.scheduler.intervalMs).toBe(DECISION_INTERVAL_MS);
  });

  it('keeps walking and completing an accepted action without repeated model requests or restarting its progress', async () => {
    const fast = { decide: vi.fn(async () => answer()) };
    const runtime = setup(fast); runtime.start();
    await vi.advanceTimersByTimeAsync(1000);
    const startedAt = runtime.state.agent.action!.startedAt;
    const initial = { ...runtime.state.agent.position };
    await vi.advanceTimersByTimeAsync(4000);
    expect(runtime.state.agent.position).not.toEqual(initial);
    expect(runtime.state.agent.action?.startedAt).toBe(startedAt);
    expect(fast.decide).toHaveBeenCalledTimes(1);
    expect(runtime.state.scheduler.ticks).toBe(5);
    expect(runtime.state.scheduler.status).toBe('executing');
    await vi.advanceTimersByTimeAsync(4000);
    expect(runtime.state.outcomes[0]?.action).toBe('drink');
    expect(runtime.state.metrics.completed).toBeGreaterThanOrEqual(1);
    expect(runtime.state.agent.needs.hydration).toBeGreaterThan(75);
    expect(fast.decide.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('skips occupied ticks, including abort settlement, and does not replay missed requests', async () => {
    let resolve!: (d: Decision) => void;
    const signals: AbortSignal[] = [];
    const fast = { decide: vi.fn((_c, signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? new Promise<Decision>(r => { resolve = r; }) : Promise.resolve(answer({ action: 'sleep' }));
    }) };
    const runtime = setup(fast); runtime.start();
    await vi.advanceTimersByTimeAsync(1000);
    runtime.message('改成睡觉');
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(fast.decide).toHaveBeenCalledTimes(1);
    expect(runtime.state.scheduler.status).toBe('deciding');
    resolve(answer()); await vi.advanceTimersByTimeAsync(0);
    expect(runtime.state.scheduler.status).toBe('waiting');
    expect(runtime.state.agent.action).toBeNull();
    expect(runtime.state.metrics.discarded).toBe(1);
    await vi.advanceTimersByTimeAsync(INPUT_COALESCE_MS - 1);
    expect(fast.decide).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fast.decide).toHaveBeenCalledTimes(2);
    expect(runtime.state.agent.action?.id).toBe('sleep');
  });

  it('does not issue a burst after pause, resume or reset', async () => {
    const starts: number[] = [];
    const runtime = setup({ decide: async () => { starts.push(Date.now()); return answer(); } });
    runtime.start(); await vi.advanceTimersByTimeAsync(1000);
    runtime.pause(true); const position = { ...runtime.state.agent.position };
    await vi.advanceTimersByTimeAsync(400);
    expect(runtime.state.agent.position).toEqual(position);
    runtime.pause(false); runtime.reset(); await runtime.decide();
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(starts).toEqual([101000, 102000]);
    runtime.stop(); await vi.advanceTimersByTimeAsync(10000);
    expect(starts).toHaveLength(2);
  });

  it('keeps a provider backoff despite new messages or reset', async () => {
    const starts: number[] = [];
    const runtime = setup({ decide: async () => { starts.push(Date.now()); throw new ProviderError('Rate limited', 6000); } });
    runtime.start(); await vi.advanceTimersByTimeAsync(1000);
    runtime.message('请喝水'); runtime.reset();
    await vi.advanceTimersByTimeAsync(5999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([101000, 107000]);
    expect(runtime.state.scheduler.status).toBe('backoff');
  });

  it('waits for LLM advice without polling it, and applies its result only on a later tick', async () => {
    let resolve!: (r: ThoughtResult) => void;
    const fast = { decide: vi.fn(async () => answer({ action: 'idle', think: 1, acceptReflection: 1 })) };
    const slow = { reflect: vi.fn(() => new Promise<ThoughtResult>(r => { resolve = r; })) };
    const runtime = setup(fast, slow); runtime.message('给一个计划'); runtime.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(fast.decide).toHaveBeenCalledTimes(1); expect(slow.reflect).toHaveBeenCalledTimes(1);
    resolve({ summary: '先休息', reply: '可以先休息。', suggestedActions: [], memories: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.state.reflection?.accepted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(fast.decide).toHaveBeenCalledTimes(2);
    expect(runtime.state.reflection?.accepted).toBe(true);
  });

  it('an intentional idle waits five seconds but new input is handled on the next tick', async () => {
    const fast = { decide: vi.fn(async () => answer({ action: 'idle' })) };
    const runtime = setup(fast); runtime.start();
    await vi.advanceTimersByTimeAsync(5900);
    expect(fast.decide).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fast.decide).toHaveBeenCalledTimes(2);
    runtime.message('去读书'); fast.decide.mockResolvedValue(answer({ action: 'read' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.state.agent.action?.id).toBe('read');
    expect(runtime.state.metrics.started).toBe(1);
  });
});
