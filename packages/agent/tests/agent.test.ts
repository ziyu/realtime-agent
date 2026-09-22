import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, AgentError } from '../src/index.js';
import type { DecisionContext, DecisionResult, ThoughtProposal } from '../src/index.js';
import { decision, deferred, move, room } from './fixture.js';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('final input needs a decision; physics and model cadence are independent', async () => {
  const f = room(); let requests = 0;
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now, id: f.id,
    fast: { decide: async () => { requests++; return decision({ selection: move() }); } } });
  agent.receive('Go to the bed'); agent.tick(1);
  assert.equal(f.state.position, 0);
  assert.equal(await agent.decide(), true);
  const executionId = agent.actions.current!.id;
  agent.tick(0.5); assert.equal(f.state.position, 1);
  assert.equal(await agent.decide(), false);
  f.clock.now += 1000;
  assert.equal(await agent.decide(), false); // Accepted action needs no repeated model call.
  assert.equal(requests, 1); assert.equal(agent.actions.current?.id, executionId);
  agent.receive('Keep going to the bed'); await agent.decide();
  assert.equal(agent.actions.current?.id, executionId); // Same call is adopted, not restarted.
  agent.tick(1.5); assert.equal(agent.actions.history[0].status, 'completed');
  assert.equal(f.state.energy, 30); agent.dispose();
});

test('late decisions cannot revive superseded input or overlap an occupied decision slot', async () => {
  const f = room(), first = deferred<DecisionResult>();
  const signals: AbortSignal[] = [];
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now,
    fast: { decide: async (_context, signal) => { signals.push(signal); return signals.length === 1 ? first.promise : decision({ selection: move('bookshelf') }); } } });
  agent.receive('Go to bed'); const pending = agent.decide();
  agent.receive('Go to bookshelf instead'); f.clock.now += 2000;
  assert.equal(signals[0].aborted, true); assert.equal(await agent.decide(), false);
  assert.equal(await pending, false); // Local cancellation finishes before an uncooperative provider settles.
  assert.equal(agent.snapshot().decisionBusy, true);
  first.resolve(decision({ selection: move() })); await flush();
  assert.equal(agent.snapshot().decisionBusy, false);
  assert.equal(agent.actions.current, null);
  assert.equal(await agent.decide(), true); assert.equal(agent.snapshot().action?.call.target, 'bookshelf');
  agent.tick(0.5); assert.equal(f.state.position, -1); agent.dispose();
});

test('slow thinking is Jev-invited and accepted suggestions are never an executable queue', async () => {
  const f = room(), pending = deferred<ThoughtProposal>();
  let slowCalls = 0, selected = decision();
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now,
    fast: { decide: async () => selected }, slow: { think: async () => { slowCalls++; return pending.promise; } } });
  agent.receive('Think about a plan'); await agent.decide(); assert.equal(slowCalls, 0);
  selected = decision({ think: true }); agent.invalidate(); f.clock.now += 1000; await agent.decide();
  assert.equal(slowCalls, 1); assert.equal(agent.actions.current, null);
  pending.resolve({ summary: 'Proposed inspection', reply: 'We could look at the bed.', suggestions: [move().call] }); await flush();
  assert.equal(agent.snapshot().proposal?.accepted, false); assert.equal(agent.actions.current, null);
  selected = decision({ acceptProposal: true, complete: true }); f.clock.now += 1000; await agent.decide();
  assert.equal(agent.snapshot().proposal?.accepted, true); assert.equal(agent.snapshot().turn?.completed, false);
  assert.equal(agent.actions.current, null); assert.equal(f.state.position, 0); agent.dispose();
});

test('an old slow proposal cannot enter a new turn or a reset Agent', async () => {
  for (const reset of [false, true]) {
    const f = room(), pending = deferred<ThoughtProposal>();
    const agent = new Agent({ environment: f.environment, now: () => f.clock.now,
      fast: { decide: async () => decision({ think: true }) }, slow: { think: () => pending.promise } });
    agent.receive('Old question'); await agent.decide();
    if (reset) agent.reset(); else agent.receive('New question');
    pending.resolve({ summary: 'Stale advice', reply: 'Already arrived', suggestions: [move().call] }); await flush();
    assert.equal(agent.snapshot().proposal, null); assert.equal(agent.actions.current, null); agent.dispose();
  }
});

test('an environment change or revoked candidate prevents stale execution', async () => {
  for (const changeRevision of [false, true]) {
    const f = room(), pending = deferred<DecisionResult>();
    const agent = new Agent({ environment: f.environment, now: () => f.clock.now, fast: { decide: () => pending.promise } });
    agent.receive('Go to bed'); const result = agent.decide();
    f.state.bedAvailable = false; if (changeRevision) f.state.revision++;
    pending.resolve(decision({ selection: move() }));
    assert.equal(await result, false); assert.equal(agent.actions.current, null); assert.equal(f.state.position, 0); agent.dispose();
  }
});

test('a new question can invite thinking once an aborted old thought releases its slot', async () => {
  const f = room(), old = deferred<ThoughtProposal>(); let calls = 0;
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now,
    fast: { decide: async () => decision({ selection: move(), think: true }) },
    slow: { think: async () => ++calls === 1 ? old.promise : { summary: 'New answer', reply: 'Current reply', suggestions: [] } } });
  agent.receive('First question while moving'); await agent.decide();
  agent.receive('A different question'); f.clock.now += 1000; await agent.decide();
  assert.equal(calls, 1); // The cancelled request still owns its slot until it settles.
  old.resolve({ summary: 'Stale', suggestions: [] }); await flush();
  f.clock.now += 1000; await agent.decide(); await flush();
  assert.equal(calls, 2); assert.equal(agent.snapshot().proposal?.value.summary, 'New answer'); agent.dispose();
});

test('registered-but-unoffered capabilities cannot be selected by a custom model policy', async () => {
  const f = room();
  const agent = new Agent({ environment: f.environment, fast: { decide: async () => decision({ selection: { kind: 'execute', call: { capability: 'use', target: 'bed' } } }) } });
  agent.receive('Sleep'); assert.equal(await agent.decide(), false);
  assert.equal(agent.snapshot().error?.code, 'stale_candidate'); assert.equal(f.state.completedUses, 0); agent.dispose();
});

test('model failures remain errors, respect retry budget across new inputs and resets, and do not expose raw exceptions', async () => {
  const f = room(); let requests = 0;
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now, fast: { decide: async () => { requests++; throw new Error('private-api-key'); } } });
  agent.receive('Go to bed'); await agent.decide();
  assert.equal(agent.actions.current, null); assert.equal(JSON.stringify(agent.snapshot()).includes('private-api-key'), false);
  agent.reset(); agent.receive('Try again'); f.clock.now += 2000; assert.equal(await agent.decide(), false);
  assert.equal(requests, 1); f.clock.now += 4000; await agent.decide(); assert.equal(requests, 2); agent.dispose();
});

test('pause and hearing hold the body without awarding incomplete effects', async () => {
  const f = room();
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now, fast: { decide: async () => decision({ selection: move() }) } });
  agent.receive('Go to bed'); await agent.decide(); agent.tick(0.5);
  agent.holdInput(); agent.tick(200); assert.equal(f.state.position, 1); assert.equal(await agent.decide(), false);
  agent.releaseInput(); f.clock.now += 1000; await agent.decide();
  agent.pause(); agent.tick(100); assert.equal(f.state.position, 1);
  agent.pause(false); f.clock.now += 1000; await agent.decide(); agent.tick(1.5);
  assert.equal(f.state.position, 4); assert.equal(f.state.energy, 30); agent.dispose();
});

test('two Agent instances do not share turns, executions or evidence', async () => {
  const a = room(), b = room();
  const first = new Agent({ environment: a.environment, fast: { decide: async () => decision({ selection: move() }) } });
  const second = new Agent({ environment: b.environment, fast: { decide: async () => decision({ selection: move('bookshelf') }) } });
  first.receive('bed'); second.receive('bookshelf'); await Promise.all([first.decide(), second.decide()]);
  first.tick(1); second.tick(0.5);
  assert.equal(a.state.position, 2); assert.equal(b.state.position, -1);
  const evidence = first.conversation().observation;
  assert.equal(second.checkClaims([{ kind: 'observation', id: evidence.id }]), false);
  first.dispose(); second.dispose();
});

test('grounding distinguishes running, held and completed, and rejects stale observation and old-turn claims', async () => {
  const f = room();
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now, fast: { decide: async () => decision({ selection: move() }) } });
  agent.receive('Go to bed'); await agent.decide();
  const id = agent.actions.current!.id;
  assert.equal(agent.checkClaims([{ kind: 'action', id, status: 'completed' }]), false);
  assert.equal(agent.checkClaims([{ kind: 'action', id, status: 'running' }]), true);
  const beforeMoving = agent.conversation().observation; agent.tick(0.1);
  assert.equal(agent.checkClaims([{ kind: 'observation', id: beforeMoving.id }]), false);
  agent.actions.hold(); assert.equal(agent.checkClaims([{ kind: 'action', id, status: 'running' }]), false);
  agent.actions.continue(agent.scope); agent.tick(2);
  assert.equal(agent.checkClaims([{ kind: 'action', id, status: 'completed' }]), true);
  const observed = agent.conversation().observation;
  assert.equal(agent.checkClaims([{ kind: 'observation', id: observed.id }]), true);
  f.state.revision++; assert.equal(agent.checkClaims([{ kind: 'observation', id: observed.id }]), false);
  const fresh = agent.conversation().observation; f.clock.now += 3001;
  assert.equal(agent.checkClaims([{ kind: 'observation', id: fresh.id }]), false);
  agent.receive('A new request'); assert.equal(agent.checkClaims([{ kind: 'action', id, status: 'completed' }]), false);
  agent.dispose(); assert.throws(() => agent.receive('Too late'), AgentError);
});

test('complete flags cannot fabricate physical success without any accepted evidence', async () => {
  const f = room();
  const agent = new Agent({ environment: f.environment, fast: { decide: async () => decision({ complete: true }) } });
  agent.receive('Go to bed'); await agent.decide();
  assert.equal(agent.snapshot().turn?.completed, false); assert.deepEqual(agent.actions.history, []); agent.dispose();
});

test('autonomous activity after completing a turn is not attributed to the old request', async () => {
  const f = room(); let selected = decision({ selection: move() });
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now, fast: { decide: async () => selected } });
  const turn = agent.receive('Go to the bed'); await agent.decide(); agent.tick(2);
  selected = decision({ complete: true }); f.clock.now += 1000; await agent.decide();
  assert.equal(agent.snapshot().turn?.completed, true);
  selected = decision({ selection: move('bookshelf') }); f.clock.now += 5000; await agent.decide();
  assert.equal(agent.actions.current?.scope.turnId, null);
  agent.tick(4);
  assert.equal(agent.actions.history[0].scope.turnId, turn.id);
  assert.equal(agent.actions.history[1].scope.turnId, null); agent.dispose();
});

test('policy receives detached candidates and cannot mutate the original authorization snapshot', async () => {
  const f = room();
  const agent = new Agent({ environment: f.environment, fast: { decide: async (context: DecisionContext) => {
    context.candidates.push({ id: 'forged', description: 'Bad', selection: { kind: 'execute', call: { capability: 'teleport' } } });
    return decision({ selection: context.candidates.at(-1)!.selection });
  } } });
  agent.receive('Go to bed'); assert.equal(await agent.decide(), false); assert.equal(agent.actions.current, null); agent.dispose();
});

test('speech needs an explicit output selection and can execute alongside movement', async () => {
  const f = room(); let delivered = false, spoken = 0;
  const speak = { kind: 'execute' as const, call: { capability: 'speak', input: { text: 'On my way.' } } };
  f.environment.output = { candidates: () => [{ id: 'silent', description: 'Silent', selection: { kind: 'wait' } }, { id: 'speak', description: 'Say proposed words', selection: speak }],
    capabilities: [{ id: 'speak', prepare: () => ({ step: () => delivered ? (spoken++, { status: 'completed', result: { text: 'On my way.' } }) : { status: 'running' } }) }] };
  let selected = decision({ think: true });
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now, fast: { decide: async () => selected }, slow: { think: async () => ({ summary: 'Greeting', reply: 'On my way.', suggestions: [] }) } });
  agent.receive('Go to bed'); await agent.decide(); await Promise.resolve();
  selected = decision({ acceptProposal: true, complete: true }); f.clock.now += 1000; await agent.decide(); agent.tick(.1);
  assert.equal(agent.snapshot().proposal?.accepted, true); assert.equal(spoken, 0); assert.equal(agent.snapshot().turn?.completed, false);
  selected = decision({ selection: move(), output: speak }); f.clock.now += 1000; agent.wake(); await agent.decide();
  agent.tick(.2); assert.ok(f.state.position > 0); assert.equal(agent.outputs.current?.call.capability, 'speak'); assert.equal(spoken, 0);
  delivered = true; agent.tick(.1); agent.tick(.1);
  assert.equal(spoken, 1); assert.equal(agent.outputs.history.at(-1)?.status, 'completed');
  assert.equal(agent.actions.current?.status, 'running'); agent.dispose();
});

test('unoffered output rejects the whole decision before any body effect', async () => {
  const f = room();
  f.environment.output = { candidates: () => [{ id: 'silent', description: 'Silent', selection: { kind: 'wait' } }], capabilities: [] };
  const agent = new Agent({ environment: f.environment, fast: { decide: async () => decision({ selection: move(), output: { kind: 'execute', call: { capability: 'speak', input: { text: 'Forged' } } } }) } });
  agent.receive('Hello'); assert.equal(await agent.decide(), false);
  assert.equal(agent.actions.current, null); assert.equal(agent.outputs.current, null); agent.dispose();
});

test('new input, pause and channel changes cancel speech; channel changes hold the body until a new decision', async () => {
  for (const event of ['input', 'pause', 'channel'] as const) {
    const f = room(); let cancelled = 0;
    const output = { kind: 'execute' as const, call: { capability: 'speak' } };
    f.environment.output = { candidates: () => [{ id: 'speak', description: 'Speak', selection: output }], capabilities: [{ id: 'speak', prepare: () => ({ step: () => ({ status: 'running' }), cancel: () => { cancelled++; } }) }] };
    const agent = new Agent({ environment: f.environment, fast: { decide: async () => decision({ selection: move(), output }) } });
    agent.receive('Walk and talk'); await agent.decide();
    if (event === 'input') agent.receive('Stop'); else if (event === 'pause') agent.pause(); else agent.cancelReasoning();
    agent.tick(.5); assert.equal(f.state.position, 0); assert.equal(cancelled, 1);
    assert.equal(agent.outputs.history.at(-1)?.status, 'cancelled'); assert.equal(agent.actions.current?.status, 'held'); agent.dispose();
  }
});
