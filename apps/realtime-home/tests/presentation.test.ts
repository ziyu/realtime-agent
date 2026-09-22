import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../server/runtime';
import { DemoFastProvider } from '../server/providers';
import type { Decision, DecisionContext } from '../shared/types';

const baseDecision = (values: Partial<Decision> = {}): Decision => ({ action: 'idle', confidence: null, probabilities: {}, interrupt: 0, think: 0,
  requestComplete: 0, acceptReflection: 0, source: 'jev', latencyMs: 0, ...values });

describe('independent presentation channels', () => {
  it('looks toward a new speaker before a model reply and preserves the held body while listening', async () => {
    let now = 100000;
    const runtime = new AgentRuntime({ mode: 'demo', fast: new DemoFastProvider(), slow: null, now: () => now });
    runtime.setNativeVoice(true); runtime.message('走到床边');
    expect(runtime.state.presentation).toMatchObject({ expression: 'attentive', gaze: 'speaker' });
    expect(runtime.state.agent.action).toBeNull();
    await runtime.decide(); runtime.tick(.2);
    const position = { ...runtime.state.agent.position };
    runtime.holdNativeInput(); now += 6000; runtime.tick(.2);
    expect(runtime.state.agent.position).toEqual(position);
    expect(runtime.state.presentation).toMatchObject({ expression: 'attentive', gaze: 'speaker' });
    expect(runtime.state.channels?.face.current?.status).toBe('running');
    runtime.releaseNativeInput(); runtime.tick(.2);
    expect(runtime.state.presentation).toMatchObject({ expression: 'neutral', gaze: 'forward' });
    runtime.pause(true);
    expect(runtime.state.presentation).toMatchObject({ expression: 'neutral', gaze: 'forward' });
    runtime.stop();
  });
  it('applies model-selected face and gaze alongside the ordinary Home body action, then resets both channels', async () => {
    const fast = { async decide(context: DecisionContext) {
      const face = context.channels?.face.candidates.find(candidate => candidate.id === 'curious')?.selection;
      const gaze = context.channels?.gaze.candidates.find(candidate => candidate.id === 'activity')?.selection;
      expect(face).toBeTruthy(); expect(gaze).toBeTruthy();
      return baseDecision({ action: 'drink', channels: { face: face!, gaze: gaze! } });
    } };
    const runtime = new AgentRuntime({ mode: 'demo', fast, slow: null });
    await runtime.decide();
    expect(runtime.state.agent.action?.id).toBe('drink');
    expect(runtime.state.presentation).toMatchObject({ expression: 'curious', gaze: 'activity' });
    expect(runtime.state.channels?.face.current?.call).toMatchObject({ capability: 'express', target: 'curious' });
    expect(runtime.state.channels?.gaze.current?.call).toMatchObject({ capability: 'look', target: 'activity' });
    const oldEpoch = runtime.state.epoch; runtime.reset();
    expect(runtime.state.epoch).not.toBe(oldEpoch);
    expect(runtime.state.presentation).toMatchObject({ expression: 'neutral', gaze: 'forward' });
    expect(runtime.state.channels?.face.current).toBeNull(); expect(runtime.state.channels?.gaze.current).toBeNull();
    runtime.stop();
  });
  it('keeps thinking presentation for the full slow-thought interval and looks toward the speaker while a reply is active', async () => {
    let now = 100000, resolve!: (value: { summary: string; reply: string; suggestedActions: []; memories: [] }) => void;
    const thought = new Promise<{ summary: string; reply: string; suggestedActions: []; memories: [] }>(done => { resolve = done; });
    const fast = { async decide({ state }: DecisionContext) {
      return baseDecision(state.reflection ? { acceptReflection: 1, speech: `speak:${state.reflection.id}` } : { think: 1 });
    } };
    const runtime = new AgentRuntime({ mode: 'demo', fast, slow: { reflect: () => thought }, now: () => now });
    runtime.message('和我聊聊'); await runtime.decide();
    await vi.waitFor(() => expect(runtime.state.thinking).toBe(true));
    now += 6000; runtime.tick(.1);
    expect(runtime.state.presentation?.expression).toBe('thinking');
    resolve({ summary: '聊聊', reply: '我在这里。', suggestedActions: [], memories: [] });
    await vi.waitFor(() => expect(runtime.state.reflection).not.toBeNull());
    await runtime.decide();
    expect(runtime.state.speechExecution?.call.capability).toBe('speak');
    expect(runtime.state.presentation?.gaze).toBe('speaker');
    now += 6000; runtime.tick(.1);
    expect(runtime.state.presentation?.gaze).toBe('speaker');
    runtime.tick(.1);
    expect(runtime.state.presentation?.gaze).toBe('forward');
    runtime.stop();
  });
  it('showing a pleased expression cannot count as completing a user task', async () => {
    const runtime = new AgentRuntime({ mode: 'demo', slow: null, fast: { async decide() {
      return { action: 'idle', confidence: null, probabilities: {}, interrupt: 0, think: 0, requestComplete: 1, acceptReflection: 0, source: 'demo', latencyMs: 0 };
    } } });
    runtime.message('完成一个尚未执行的任务'); await runtime.decide();
    expect(runtime.state.presentation?.expression).toBe('pleased');
    expect(runtime.state.intent?.completed).toBe(false); expect(runtime.state.outcomes).toEqual([]);
    expect(runtime.state.timings?.some(sample => sample.stage === 'decision')).toBe(true); runtime.stop();
  });
});
