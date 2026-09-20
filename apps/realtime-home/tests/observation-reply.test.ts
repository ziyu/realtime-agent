import { describe, expect, it, vi } from 'vitest';
import type { DecisionContext } from '../shared/types';
import { AgentRuntime } from '../server/runtime';
import { DemoFastProvider } from '../server/providers';
import { VoiceBridge } from '../server/voice/bridge';
import { addEpisode } from '../server/mind';
import { homeCapabilities } from '../server/agent-environment';
import { observeTarget, ROOM_DESTINATIONS } from '../shared/world';

function fixture(native = false) {
  let now = 100000;
  const fast = new DemoFastProvider();
  const reflect = vi.fn(async ({ state }: DecisionContext) => ({ summary: '根据本轮观察提出回答',
    reply: state.intent?.observation ? observeTarget(state.agent.position, state.intent.observation.target)?.text ?? '我去看看。' : '我喜欢安静地看书。',
    suggestedActions: [], memories: [] }));
  const runtime = new AgentRuntime({ mode: 'demo', fast, slow: { reflect }, now: () => now });
  if (native) runtime.setNativeVoice(true);
  const bridge = new VoiceBridge(runtime, runtime.state.epoch, 'observation', now + 900000, () => now);
  return { runtime, bridge, fast, reflect,
    async send(text: string, sequence = 1) {
      now += 1000;
      if (native) bridge.event({ type: 'input', sequence, itemId: `input-${sequence}`, text });
      else runtime.message(text);
      await runtime.decide();
    },
    async decide() { now += 1000; await runtime.decide(); await Promise.resolve(); },
    arrive() { for (let i = 0; i < 200 && runtime.state.agent.action; i++) runtime.tick(0.1); },
    close() { bridge.close(); runtime.stop(); },
  };
}

describe('speech is an explicitly selected action', () => {
  it.each([false, true])('inspection → thought → review and speak → delivery (native=%s)', async native => {
    const f = fixture(native);
    try {
      await f.send('走到厨房去看有啥东西');
      const id = f.runtime.state.intent!.id;
      f.arrive();
      const inspection = f.runtime.state.executions!.at(-1)!;
      expect(f.runtime.state.agent.position).toEqual(ROOM_DESTINATIONS.kitchen);
      expect(f.runtime.state.messages.filter(m => m.role === 'agent')).toEqual([]);
      expect(await f.bridge.outputPlan(1)).toBeNull();
      expect(f.reflect).not.toHaveBeenCalled();
      await f.decide();
      expect(f.reflect).toHaveBeenCalledTimes(1);
      expect(f.runtime.state.reflection?.executionEvidenceIds).toContain(inspection.id);
      expect(f.runtime.state.messages.filter(m => m.role === 'agent')).toEqual([]);
      await f.decide();
      const speech = f.runtime.state.speechExecution!;
      expect(speech.call.capability).toBe('speak');
      expect(f.runtime.state.intent?.completed).toBe(false);
      if (native) {
        const plan = (await f.bridge.outputPlan(1))!;
        expect(plan.executionId).toBe(speech.id);
        expect(plan.exactText).toBe(f.runtime.state.reflection?.reply);
        expect(f.bridge.allowOutput(plan.id, 1, '厨房里有冰箱。')).toBe(false);
        expect(f.bridge.approveOutput(plan.id, 1, plan.exactText)).toBe(true);
        expect(f.bridge.event({ type: 'reply', sequence: 1, itemId: plan.id, text: plan.exactText })).toBe(true);
      }
      f.runtime.tick(.1); await f.decide();
      expect(f.runtime.state.intent).toMatchObject({ completed: true, replyDelivered: true });
      expect(f.runtime.state.speechExecutions).toContainEqual(expect.objectContaining({ id: speech.id, status: 'completed', result: expect.objectContaining({ evidenceIds: [inspection.id] }) }));
      expect(f.runtime.state.messages.filter(m => m.turnId === id && m.role === 'agent').map(m => m.text)).toEqual(['厨房里有料理台、饮水台、水槽。']);
      for (const stage of ['input', 'decision', 'action', 'observation', 'thought', 'output'])
        expect(f.runtime.state.traces.some(t => t.turnId === id && t.stage === stage)).toBe(true);
    } finally { f.close(); }
  });

  it('accepting a proposal with silent neither speaks nor completes the inspection', async () => {
    const f = fixture();
    try {
      const decide = f.fast.decide.bind(f.fast);
      f.fast.decide = async (context, signal) => ({ ...await decide(context, signal), speech: 'silent', requestComplete: 1 });
      await f.send('去厨房看看有什么'); f.arrive(); await f.decide(); await f.decide(); f.runtime.tick(.1);
      expect(f.runtime.state.reflection?.accepted).toBe(true);
      expect(f.runtime.state.messages.filter(m => m.role === 'agent')).toEqual([]);
      expect(f.runtime.state.speechExecution).toBeNull();
      expect(f.runtime.state.intent?.completed).toBe(false);
    } finally { f.close(); }
  });

  it.each(['kitchen', 'bedroom', 'living', 'study'] as const)('inspection of %s only records facts', async room => {
    const f = fixture();
    try {
      f.fast.decide = async () => ({ action: 'inspect', target: room, interrupt: 1, think: 0, requestComplete: 0, acceptReflection: 0, confidence: null, probabilities: {}, source: 'demo', latencyMs: 0 });
      await f.send('查看房间'); f.arrive();
      expect(f.runtime.state.agent.position).toEqual(ROOM_DESTINATIONS[room]);
      expect(f.runtime.state.executions?.at(-1)?.status).toBe('completed');
      expect(f.runtime.state.messages.filter(m => m.role === 'agent')).toEqual([]);
    } finally { f.close(); }
  });

  it('keeps pure movement separate and rejects room use or remote inventory', async () => {
    const f = fixture();
    try {
      expect(observeTarget(f.runtime.state.agent.position, 'kitchen')).toBeNull();
      expect(() => homeCapabilities.find(c => c.id === 'use')!.prepare({ capability: 'use', target: 'kitchen', input: { activity: 'kitchen' } }, f.runtime.state)).toThrow();
      await f.send('走到厨房'); f.arrive();
      expect(f.runtime.state.intent?.observation).toBeUndefined();
      expect(f.runtime.state.agent.position).toEqual(ROOM_DESTINATIONS.kitchen);
      expect(f.runtime.state.speechExecutions).toEqual([]);
    } finally { f.close(); }
  });

  it.each(['interrupt', 'pause', 'reset', 'close', 'correction'] as const)('invalidates a selected speech on %s', async action => {
    const f = fixture(true);
    try {
      await f.send('去厨房看看有啥'); f.arrive(); await f.decide(); await f.decide();
      const plan = (await f.bridge.outputPlan(1))!;
      if (action === 'interrupt') f.bridge.event({ type: 'interrupt', sequence: 1 });
      if (action === 'pause') f.runtime.pause(true);
      if (action === 'reset') f.runtime.reset();
      if (action === 'close') f.bridge.close();
      if (action === 'correction') await f.send('改去卧室看看', 2);
      expect(f.bridge.allowOutput(plan.id, 1, plan.exactText)).toBe(false);
      expect(f.bridge.outputSignal(plan).aborted).toBe(true);
      expect(f.runtime.state.messages.some(m => m.role === 'agent')).toBe(false);
    } finally { f.close(); }
  });

  it('supports acknowledgement and a later observation answer in the same turn while walking', async () => {
    const f = fixture(true);
    try {
      const decide = f.fast.decide.bind(f.fast);
      f.fast.decide = async (c, signal) => ({ ...await decide(c, signal), ...(!c.state.reflection ? { think: 1 } : {}) });
      await f.send('去厨房看看有什么'); await f.decide();
      const first = (await f.bridge.outputPlan(1))!;
      expect(first.exactText).toBe('我去看看。');
      const position = { ...f.runtime.state.agent.position };
      f.runtime.tick(.2);
      expect(f.runtime.state.agent.position).not.toEqual(position);
      expect(f.runtime.state.speechExecution?.status).toBe('running');
      f.bridge.event({ type: 'reply', sequence: 1, itemId: first.id, text: first.exactText });
      f.runtime.tick(.1); f.arrive(); await f.decide();
      expect(f.runtime.state.intent?.completed).toBe(false);
      await f.decide();
      const second = (await f.bridge.outputPlan(1))!;
      expect(second.executionId).not.toBe(first.executionId);
      expect(second.exactText).toBe('厨房里有料理台、饮水台、水槽。');
      expect(f.bridge.allowOutput(first.id, 1)).toBe(false);
      f.bridge.event({ type: 'reply', sequence: 1, itemId: second.id, text: second.exactText });
      f.runtime.tick(.1); await f.decide();
      expect(f.runtime.state.intent?.completed).toBe(true);
      expect(f.runtime.state.speechExecutions?.filter(r => r.status === 'completed')).toHaveLength(2);
      expect(f.runtime.state.turns).toHaveLength(1);
    } finally { f.close(); }
  });

  it.each([false, true])('autonomous speech uses the same action and can be interrupted before rendering (%s)', async interrupted => {
    const f = fixture(true);
    try {
      addEpisode(f.runtime.state.mind, { id: 'experience-a', kind: 'action', action: 'read', at: 1, text: '读过书。' });
      addEpisode(f.runtime.state.mind, { id: 'experience-b', kind: 'action', action: 'water', at: 2, text: '浇过水。' });
      f.reflect.mockImplementation(async () => ({ summary: '基于经历的分享', reply: '我想安静坐一会儿。', memories: [], suggestedActions: [],
        self: { thought: '想安静一会儿。', journal: '读书后想歇一会儿。', evidenceIds: ['experience-a'], wish: null } }));
      await f.decide(); await f.decide();
      expect(f.runtime.state.speechExecution?.call.capability).toBe('speak');
      if (interrupted) {
        expect(f.bridge.event({ type: 'interrupt', sequence: 0 })).toBe(true);
        f.runtime.tick(.1); await f.decide();
        expect(await f.bridge.outputPlan(0)).toBeNull();
        expect(f.runtime.state.messages).toEqual([]);
        return;
      }
      const plan = (await f.bridge.outputPlan(0))!;
      expect(plan.turnId).toBeNull();
      expect(f.bridge.event({ type: 'reply', sequence: 0, itemId: plan.id, text: plan.exactText })).toBe(true);
      f.runtime.tick(.1);
      expect(f.runtime.state.intent).toBeNull();
      expect(f.runtime.state.turns).toEqual([]);
      expect(f.runtime.state.messages).toContainEqual(expect.objectContaining({ role: 'agent', initiative: true, nativeAudio: true }));
    } finally { f.close(); }
  });

  it('a rejected audio rendition fails the speak execution without automatic retry', async () => {
    const f = fixture(true);
    try {
      await f.send('去厨房看看有啥'); f.arrive(); await f.decide(); await f.decide();
      const plan = (await f.bridge.outputPlan(1))!;
      expect(f.bridge.approveOutput(plan.id, 1, '我已经睡醒了。')).toBe(false);
      f.runtime.tick(.1); await f.decide();
      expect(f.runtime.state.speechExecutions?.at(-1)?.status).toBe('failed');
      expect(await f.bridge.outputPlan(1)).toBeNull();
      expect(f.runtime.state.intent?.completed).toBe(false);
    } finally { f.close(); }
  });
});
