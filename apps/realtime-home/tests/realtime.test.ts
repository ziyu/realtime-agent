import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime, InputConflict, INPUT_COALESCE_MS } from '../server/runtime';
import { ProviderError } from '../server/providers';
import type { Decision, FastProvider, SlowProvider, ThoughtResult } from '../shared/types';

const runtimes: AgentRuntime[] = [];
const decision = (overrides: Partial<Decision> = {}): Decision => ({ action: 'drink', source: 'jev', confidence: 0.4, probabilities: {}, interrupt: 1, think: 0, requestComplete: 0, acceptReflection: 0, latencyMs: 0, ...overrides });
function fixture(fast: FastProvider, slow: SlowProvider | null = null) {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const runtime = new AgentRuntime({ mode: 'live', fast, slow }); runtimes.push(runtime);
  return runtime;
}
afterEach(() => { runtimes.splice(0).forEach(r => r.stop()); vi.useRealTimers(); });

describe('real-time turns', () => {
  it('marks a failed conversational reply on its turn without stopping the existing activity or exposing parser details in chat', async () => {
    const runtime = fixture({ decide: async () => decision({ action: 'work', think: 1 }) }, {
      reflect: async () => { throw new ProviderError('suggestedActions:invalid_value'); },
    });
    runtime.start(); runtime.message('继续工作，聊聊你喜欢看书的原因。');
    await vi.advanceTimersByTimeAsync(1500);
    expect(runtime.state.agent.action?.id).toBe('work');
    expect(runtime.state.turns[0].error).toBe('suggestedActions:invalid_value');
    expect(runtime.state.turns[0].replyAt).toBeNull();
    expect(runtime.state.messages.some(m => m.text.includes('这次回复没有生成成功'))).toBe(true);
    expect(runtime.state.messages.some(m => m.text.includes('invalid_value'))).toBe(false);
    expect(runtime.state.traces.some(t => t.detail === 'suggestedActions:invalid_value')).toBe(true);
  });
  it('holds a moving action on new input, then switches from the real position without completing the old action', async () => {
    const fast = { decide: vi.fn(async () => decision()) };
    const runtime = fixture(fast); runtime.start();
    const first = runtime.message('去喝水');
    await vi.advanceTimersByTimeAsync(INPUT_COALESCE_MS + 300);
    const position = { ...runtime.state.agent.position };
    const oldProgress = runtime.state.agent.action!.progress;
    fast.decide.mockResolvedValue(decision({ action: 'sleep' }));
    const next = runtime.message('改去睡觉');
    expect(runtime.state.attending).toBe(true);
    await vi.advanceTimersByTimeAsync(699);
    expect(runtime.state.agent.position).toEqual(position);
    expect(runtime.state.agent.action!.progress).toBe(oldProgress);
    expect(fast.decide).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.state.agent.action?.id).toBe('sleep');
    expect(runtime.state.agent.action?.requestId).toBe(next.turnId);
    expect(runtime.state.attending).toBe(false);
    expect(runtime.state.outcomes.filter(o => o.requestId === first.turnId)).toEqual([]);
    expect(runtime.state.metrics.interrupted).toBe(1);
    expect(runtime.state.turns[0].supersededAt).toBe(next.receivedAt);
    expect(runtime.state.turns[1].appliedAt! - next.receivedAt).toBe(700);
    expect(runtime.state.turns[1].appliedAction).toBe('sleep');
  });

  it('deduplicates retries and rejects out-of-order requests before they can cancel the newest turn', () => {
    const runtime = fixture({ decide: async () => decision() });
    const client = { id: 'browser-one', sequence: 2 };
    const latest = runtime.receive({ text: '看书', client, epoch: runtime.state.epoch });
    expect(runtime.receive({ text: '看书', client, epoch: runtime.state.epoch })).toEqual({ ...latest, duplicate: true });
    expect(() => runtime.receive({ text: '睡觉', client: { ...client, sequence: 1 } })).toThrow(InputConflict);
    expect(() => runtime.receive({ text: '睡觉', client })).toThrow(InputConflict);
    expect(runtime.state.turns).toHaveLength(1);
    expect(runtime.state.intent?.id).toBe(latest.turnId);
    const oldEpoch = runtime.state.epoch; runtime.reset();
    expect(() => runtime.receive({ text: '旧窗口的请求', epoch: oldEpoch })).toThrow(InputConflict);
    expect(runtime.state.intent).toBeNull();
  });

  it('handles the latest correction after an aborted request settles, with no overlap or stale execution', async () => {
    let settle!: (value: Decision) => void;
    const signals: AbortSignal[] = [], texts: string[] = [], starts: number[] = [];
    const runtime = fixture({ decide: async (context, signal) => {
      signals.push(signal); texts.push(context.state.intent!.text); starts.push(Date.now());
      return signals.length === 1 ? new Promise(resolve => { settle = resolve; }) : decision({ action: 'read' });
    } });
    runtime.start(); runtime.message('先睡觉');
    await vi.advanceTimersByTimeAsync(INPUT_COALESCE_MS);
    runtime.message('改去喝水'); runtime.message('还是去看书');
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2200);
    expect(signals).toHaveLength(1);
    expect(runtime.state.scheduler.status).toBe('deciding');
    settle(decision({ action: 'sleep' })); await Promise.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(runtime.state.scheduler.status).toBe('waiting');
    await vi.advanceTimersByTimeAsync(INPUT_COALESCE_MS);
    expect(texts).toEqual(['先睡觉', '还是去看书']);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
    expect(runtime.state.agent.action?.id).toBe('read');
    expect(runtime.state.metrics.started).toBe(1);
    expect(runtime.state.metrics.discarded).toBe(1);
  });

  it('does not grant an almost-complete interaction its effects while a correction is being evaluated', async () => {
    const fast = { decide: vi.fn(async () => decision({ action: 'sleep' })) };
    const runtime = fixture(fast);
    runtime.message('睡觉'); await runtime.decide();
    const action = runtime.state.agent.action!;
    action.phase = 'acting'; action.path = []; action.elapsed = 14.9; action.progress = 14.9 / 15;
    const energy = runtime.state.agent.needs.energy;
    runtime.message('先停下'); runtime.tick(0.5);
    expect(runtime.state.outcomes).toEqual([]);
    expect(runtime.state.agent.needs.energy).toBeLessThan(energy);
    expect(runtime.state.agent.action?.elapsed).toBe(14.9);
  });

  it('cancels a pending spoken reply without changing physical action, and rejects a late interrupt for a newer turn', async () => {
    let resolve!: (value: ThoughtResult) => void;
    const signals: AbortSignal[] = [];
    const runtime = fixture({ decide: async () => decision({ action: 'idle', think: 1 }) }, { reflect: async (_c, signal) => {
      signals.push(signal); return new Promise(r => { resolve = r; });
    } });
    const first = runtime.message('聊聊今天'); await runtime.decide();
    expect(runtime.state.thinking).toBe(true);
    expect(runtime.interruptReply(runtime.state.epoch, first.turnId)).toBe(true);
    expect(signals[0].aborted).toBe(true);
    resolve({ summary: '旧问题', reply: '不应再出现的回复', memories: ['不应记住'], suggestedActions: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(runtime.state.reflection).toBeNull();
    expect(runtime.state.messages.some(m => m.text === '不应再出现的回复')).toBe(false);
    expect(runtime.state.memories).toEqual([]);
    expect(runtime.state.turns[0].replyCancelledAt).not.toBeNull();
    const next = runtime.message('改聊明天');
    expect(runtime.interruptReply(runtime.state.epoch, first.turnId)).toBe(false);
    expect(runtime.state.intent?.id).toBe(next.turnId);
    expect(runtime.state.intent?.replySuppressed).toBeUndefined();
  });

  it('records accepted conversational latency against its own turn, and keeps old replies out after replacement', async () => {
    const runtime = fixture({ decide: async ({ state }) => decision({ action: 'idle', think: state.reflection ? 0 : 1, acceptReflection: 1, speech: state.reflection ? `speak:${state.reflection.id}` : 'silent' }) }, {
      reflect: async () => ({ summary: '聊天', reply: '我喜欢照顾绿植。', memories: [], suggestedActions: [] }),
    });
    runtime.start(); const receipt = runtime.message('你喜欢什么？');
    await vi.advanceTimersByTimeAsync(1200);
    expect(runtime.state.turns[0].replyAt).not.toBeNull();
    const reply = runtime.state.messages.find(m => m.role === 'agent' && m.turnId === receipt.turnId);
    expect(reply?.text).toBe('我喜欢照顾绿植。');
    expect(runtime.state.metrics.started).toBe(0);
    const starts = runtime.state.traces.filter(t => t.kind === 'decision' && !!t.source).map(t => t.requestedAt!);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
  });
});
