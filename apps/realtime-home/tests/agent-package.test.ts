import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../server/runtime';
import { DemoFastProvider, JevProvider } from '../server/providers';
import { VoiceBridge } from '../server/voice/bridge';
import { ACTIONS, candidatesFor } from '../shared/world';

describe('Home integration with the independent Agent package', () => {
  it('uses generic move_to/use receipts while preserving the Home UI shape', async () => {
    let now = 100000;
    const runtime = new AgentRuntime({ mode: 'demo', fast: new DemoFastProvider(), slow: null, now: () => now });
    runtime.state.agent.needs.energy = 40;
    runtime.message('走到床边'); await runtime.decide();
    expect(runtime.state.agent.action).toMatchObject({ id: 'approach', target: 'sleep' });
    expect(runtime.state.execution).toMatchObject({ call: { capability: 'move_to', target: 'bed' }, status: 'running' });
    const energy = runtime.state.agent.needs.energy;
    for (let i = 0; i < 100 && runtime.state.agent.action; i++) runtime.tick(0.1);
    expect(runtime.state.agent.position).toEqual(ACTIONS.sleep.destination);
    expect(runtime.state.agent.needs.energy).toBeLessThan(energy);
    expect(runtime.conversationContext().receipts.at(-1)).toMatchObject({ status: 'completed', call: { capability: 'move_to', target: 'bed' } });
    now += 2000; runtime.message('请睡一会儿'); await runtime.decide();
    expect(runtime.state.execution).toMatchObject({ call: { capability: 'use', target: 'bed', input: { activity: 'sleep' } } });
    for (let i = 0; i < 300 && runtime.state.agent.action; i++) runtime.tick(0.1);
    expect(runtime.state.agent.needs.energy).toBeGreaterThan(energy + 30);
    expect(runtime.conversationContext().receipts.filter(receipt => receipt.status === 'completed')).toHaveLength(2);
    runtime.stop();
  });

  it('voice sees held, cancelled and completed execution receipts instead of inferring them from words', async () => {
    let now = 100000;
    const runtime = new AgentRuntime({ mode: 'demo', fast: new DemoFastProvider(), slow: null, now: () => now });
    runtime.setNativeVoice(true);
    const bridge = new VoiceBridge(runtime, runtime.state.epoch, 'package-session', now + 900000, () => now);
    bridge.event({ type: 'input', sequence: 1, itemId: 'one', text: '去床边看看' }); await runtime.decide(); runtime.tick(0.2);
    const execution = bridge.observation(1).agentContext.currentAction!;
    bridge.event({ type: 'speech-start', sequence: 2 });
    expect(bridge.observation(2).agentContext.currentAction?.status).toBe('held');
    const position = { ...runtime.state.agent.position }; runtime.tick(0.5); expect(runtime.state.agent.position).toEqual(position);
    bridge.event({ type: 'input', sequence: 2, itemId: 'two', text: '改去书架看看' }); now += 2000; await runtime.decide();
    expect(bridge.observation(2).agentContext.currentAction?.call.target).toBe('bookshelf');
    expect(bridge.observation(2).agentContext.receipts.find(receipt => receipt.id === execution.id)?.status).toBe('cancelled');
    expect(runtime.state.outcomes).toHaveLength(0); bridge.close(); runtime.stop();
  });

  it('SDK selects a bound object candidate without an independent target question', async () => {
    const runtime = new AgentRuntime({ mode: 'demo', fast: new DemoFastProvider(), slow: null });
    runtime.message('去床边看看');
    const context = { state: runtime.snapshot(), candidates: candidatesFor(runtime.state) };
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.questions.target).toBeUndefined();
      expect(body.questions.action.criteria['approach:bed']).toContain('床');
      return Response.json({ answers: {
        action: { type: 'choice', choice: 'approach:bed', probabilities: Object.fromEntries(Object.keys(body.questions.action.criteria).map(id => [id, id === 'approach:bed' ? 1 : 0])) },
        interrupt: { type: 'noul', noul: 1 }, think: { type: 'noul', noul: 0 }, request_complete: { type: 'noul', noul: 0 },
        accept_reflection: { type: 'choice', choice: 'reject' },
        speech: { type: 'choice', choice: 'silent' },
      } });
    };
    const decision = await new JevProvider('fixture', undefined, fetcher).decide(context, new AbortController().signal);
    expect(decision).toMatchObject({ action: 'approach', target: 'sleep' }); runtime.stop();
  });
});
