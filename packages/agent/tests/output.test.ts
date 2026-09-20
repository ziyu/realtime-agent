import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, OutputGate } from '../src/index.js';
import type { AgentEvent, ThoughtProposal } from '../src/index.js';
import { decision, deferred, move, room, scope } from './fixture.js';

test('output permits require the exact issued object, current facts and unchanged words', () => {
  let now = 1000, current = true;
  const gate = new OutputGate({ now: () => now, ttlMs: 1000 });
  const permit = gate.issue(scope(), '我已经到床边了。', () => current);
  assert.equal(gate.allows(permit, '我已经到床边了！'), true);
  assert.equal(gate.allows(permit, '我还没有到床边。'), false);
  assert.equal(gate.allows({ ...permit }, permit.exactText!), false);
  const numericGate = new OutputGate(), number = numericGate.issue(scope(), '变化为 -1.5。', () => true);
  assert.equal(numericGate.allows(number, '变化为 1.5。'), false);
  assert.equal(numericGate.allows(number, '变化为 -15。'), false); numericGate.dispose();
  current = false; assert.equal(gate.allows(permit), false); current = true;
  now = 2000; assert.equal(gate.allows(permit), false);
  gate.dispose(); assert.equal(permit.signal.aborted, true);
});

test('a new permitted response synchronously aborts the old one', () => {
  const gate = new OutputGate(), one = gate.issue(scope('one'), '开始走路。', () => true);
  const next = gate.issue(scope('two'), null, () => true);
  assert.equal(one.signal.aborted, true); assert.equal(gate.allows(one), false);
  assert.equal(gate.allows(next, '你好。'), true);
  gate.cancel(); assert.equal(next.signal.aborted, true); assert.equal(gate.allows(next), false);
});

test('host lifecycle events cannot apply a decision after a listener submits newer input', async () => {
  const f = room(), events: AgentEvent[] = [];
  const agent = new Agent({ environment: f.environment, fast: { decide: async () => decision({ selection: move() }) } });
  agent.subscribe(event => { events.push(event); if (event.type === 'decision-resolved') agent.receive('Actually go elsewhere'); });
  agent.receive('Go to bed'); assert.equal(await agent.decide(), false);
  assert.equal(agent.actions.current, null); assert.equal(events.some(event => event.type === 'discarded'), true); agent.dispose();
});

test('observer failures do not replay a committed action and receipt objects stay detached', async () => {
  const f = room();
  const agent = new Agent({ environment: f.environment, fast: { decide: async () => decision({ selection: move() }) } });
  agent.subscribe(event => { if (event.type === 'action-ended') { event.receipt.call.target = 'forged'; throw new Error('storage error'); } });
  agent.receive('Go to bed'); await agent.decide(); agent.tick(2);
  assert.equal(agent.actions.history[0].call.target, 'bed'); assert.equal(agent.actions.history.length, 1); agent.dispose();
});

test('public perception excludes private reasoning data while its evidence remains verifiable', () => {
  const f = room();
  const agent = new Agent({ environment: { ...f.environment, observe: () => ({ privateNotes: 'secret' }), perceive: () => ({ object: 'bed' }) },
    fast: { decide: async () => decision() } });
  const context = agent.conversation();
  assert.deepEqual(context.observation.facts, { object: 'bed' });
  assert.equal(JSON.stringify(context).includes('secret'), false);
  assert.equal(agent.checkClaims([{ kind: 'observation', id: context.observation.id }]), true); agent.dispose();
});

test('forgetting a user turn cancels its pending thought and removes it from future model input', async () => {
  const f = room(), pending = deferred<ThoughtProposal>();
  let sent = '';
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now,
    fast: { decide: async context => { sent = JSON.stringify(context); return decision({ think: context.input?.text === 'remember purple cranes' }); } }, slow: { think: () => pending.promise } });
  const first = agent.receive('remember purple cranes'); await agent.decide();
  agent.forgetTurns(new Set([first.id]));
  pending.resolve({ summary: 'stale purple cranes', suggestions: [] }); await Promise.resolve(); await Promise.resolve();
  agent.receive('What is new?'); f.clock.now += 2000; await agent.decide();
  assert.equal(sent.includes('purple cranes'), false); assert.equal(agent.snapshot().proposal, null); agent.dispose();
});
