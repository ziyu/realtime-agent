import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, ModelSlot, ObservationStore, RequestBudget, ResourceArbiter, TaskLedger, Telemetry, percentiles } from '../src/index.js';
import type { Candidate, ChannelDefinition, ObservationFrame } from '../src/index.js';
import { decision, deferred, move, room, scope } from './fixture.js';

const frame = (sequence: number, entities = { button: 1, pointer: sequence }): ObservationFrame => ({
  id: `frame-${sequence}`, source: 'dom', sequence, capturedAt: 100000, clockUncertaintyMs: 0,
  maxAgeMs: 1000, facts: { enabled: true }, entities, provenance: 'sensor',
});

test('observations coalesce by source while entity references survive unrelated frames and expire at capture age', () => {
  const clock = { wall: 100200, monotonic: 0 };
  const store = new ObservationStore({ now: () => clock.wall, monotonicNow: () => clock.monotonic });
  assert.equal(store.ingest(frame(1)), true);
  const button = store.reference('dom', ['button']), whole = store.reference('dom');
  assert.equal(store.ingest(frame(1)), false);
  store.ingest(frame(2));
  assert.equal(store.current(button), true); assert.equal(store.current(whole), false);
  store.ingest(frame(3, { button: 2, pointer: 3 })); assert.equal(store.current(button), false);
  const current = store.reference('dom', ['button']);
  clock.wall -= 10000; clock.monotonic = 801;
  assert.equal(store.current(current), false); assert.equal(store.snapshot()[0].fresh, false);
  assert.throws(() => store.reference('dom'), { code: 'stale_observation' });
});

test('unknown/future captures are not fresh; reset and reused IDs cannot revive old references', () => {
  const store = new ObservationStore({ now: () => 100000 });
  store.ingest({ ...frame(1), capturedAt: null }); assert.equal(store.snapshot()[0].fresh, false);
  store.ingest({ ...frame(2), capturedAt: 100100 }); assert.equal(store.snapshot()[0].fresh, false);
  store.ingest(frame(3)); const ref = store.reference('dom');
  store.clear(); store.ingest(frame(3)); assert.equal(store.current(ref), false);
  store.snapshot()[0].entities.button = 999; assert.equal(store.snapshot()[0].entities.button, 1);
});

test('sensor source and payload limits report backpressure instead of silently evicting required state', () => {
  const store = new ObservationStore({ now: () => 100000, historyLimit: 2, sourceLimit: 1 });
  store.ingest(frame(1)); const ref = store.reference('dom');
  store.ingest(frame(2)); store.ingest(frame(3));
  assert.equal(store.current(ref), false); assert.equal(store.snapshot().length, 1);
  assert.throws(() => store.ingest({ ...frame(4), source: 'other' }), { code: 'observation_capacity' });
  assert.throws(() => store.ingest({ ...frame(4), facts: 'x'.repeat(65537) }), { code: 'observation_capacity' });
});

test('Agent rejects a selected candidate when its sensor evidence expires during inference', async () => {
  const f = room(), result = deferred<ReturnType<typeof decision>>();
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now, fast: { decide: () => result.promise } });
  agent.observe(frame(1)); const reference = agent.observations.reference('dom', ['button']);
  const original = f.environment.candidates;
  f.environment.candidates = context => original(context).map(c => c.id === 'move:bed' ? { ...c, observations: [reference] } : c);
  agent.receive('Move'); const pending = agent.decide(); f.clock.now += 1001;
  result.resolve(decision({ selection: move() })); assert.equal(await pending, false);
  assert.equal(agent.snapshot().error?.code, 'stale_observation'); assert.equal(agent.actions.current, null); agent.dispose();
});

test('model deadline bounds the local await without opening a second upstream slot', async () => {
  const slot = new ModelSlot(), pending = deferred<string>(); let released = 0;
  await assert.rejects(slot.run(() => pending.promise, 10, () => released++), { code: 'model_deadline' });
  assert.equal(slot.busy, true); assert.equal(slot.signal?.aborted, true);
  assert.throws(() => slot.run(async () => 'another', 10, () => {}), { code: 'model_busy' });
  pending.resolve('late'); await Promise.resolve(); await Promise.resolve();
  assert.equal(slot.busy, false); assert.equal(released, 1);
  assert.equal(await slot.run(async () => 'fresh', 1000, () => {}), 'fresh');
});

test('request admission enforces rolling budgets and retry-after independently of new inputs', async () => {
  const budget = new RequestBudget({ intervalMs: 10, maxPerMinute: 2 });
  assert.equal(budget.start(0), true); assert.equal(budget.start(5), false); assert.equal(budget.start(10), true);
  assert.equal(budget.start(20), false); assert.equal(budget.next(20), 60000);
  budget.fail(20, 90000); assert.equal(budget.next(20), 90020); assert.equal(budget.start(60000), false);
  assert.equal(budget.start(90020), true);
  const f = room(); let calls = 0;
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now, maxDecisionsPerMinute: 1,
    fast: { decide: async () => { calls++; return decision(); } } });
  await agent.decide(); agent.reset(); agent.receive('New'); f.clock.now += 2000;
  assert.equal(await agent.decide(), false); assert.equal(calls, 1); agent.dispose();
});

function visualChannel(id: string, resources: string[], state: { frames: number; started: number }): ChannelDefinition<{}> {
  return { id, mode: 'sync', resources, blocksCompletion: false, whileHearing: 'continue', reflexes: ['attend'],
    candidates: () => [{ id: 'attend', description: 'Attend', selection: { kind: 'execute', call: { capability: 'attend' } } },
      { id: 'wait', description: 'Rest', selection: { kind: 'wait' } }],
    capabilities: [{ id: 'attend', prepare: () => ({ start() { state.started++; }, step() { state.frames++; return { status: 'running' }; } }) }] };
}

test('presentation channels keep animating while hearing, and only declared reflexes can bypass semantic decisions', async () => {
  const f = room(), visual = { frames: 0, started: 0 };
  f.environment.channels = [visualChannel('gaze', ['eyes'], visual)];
  const agent = new Agent({ environment: f.environment, fast: { decide: async () => decision({ selection: move() }) } });
  agent.receive('Walk'); await agent.decide(); agent.react('gaze', 'attend'); agent.holdInput(); agent.tick(.2);
  assert.equal(f.state.position, 0); assert.equal(visual.frames, 1); assert.equal(agent.channels.blocking, false);
  assert.throws(() => agent.react('gaze', 'wait'), { code: 'invalid_reflex' });
  agent.pause(); agent.tick(.2); assert.equal(visual.frames, 1); agent.dispose();
});

test('conflicting channel selections reject the entire decision before body or channel effects', async () => {
  const f = room(), visual = { frames: 0, started: 0 };
  f.environment.channels = [visualChannel('left', ['shared'], visual), visualChannel('right', ['shared'], visual)];
  const agent = new Agent({ environment: f.environment, fast: { decide: async () => decision({ selection: move(), channels: {
    left: { kind: 'execute', call: { capability: 'attend' } }, right: { kind: 'execute', call: { capability: 'attend' } },
  } }) } });
  assert.equal(await agent.decide(), false); assert.equal(agent.snapshot().error?.code, 'resource_conflict');
  assert.equal(visual.started, 0); assert.equal(agent.actions.current, null); agent.dispose();
});

test('resource lease identity prevents one Agent from releasing another instance with the same execution ID', () => {
  const arbiter = new ResourceArbiter(), lease = arbiter.acquire('same-id', ['pointer']);
  arbiter.release({ owner: 'same-id', resources: ['pointer'] }); assert.equal(arbiter.available(['pointer']), false);
  arbiter.release(lease); assert.equal(arbiter.available(['pointer']), true);
});

test('short plans require adoption and bound receipts; old executions cannot complete revised goals', () => {
  let id = 0, now = 1000;
  const tasks = new TaskLedger({ id: () => `task-${++id}`, now: () => now });
  const task = tasks.begin({ name: 'Alice' }, scope());
  const call = { capability: 'fill', target: 'name', input: { value: 'Alice' } };
  const plan = tasks.propose(task, [{ id: 'fill', call, after: [] }, { id: 'save', call: { capability: 'save' }, after: ['fill'] }], 1000);
  assert.deepEqual(tasks.next(task), []); assert.equal(tasks.accept(task, plan.id, () => true), true);
  assert.deepEqual(tasks.next(task).map(s => s.id), ['fill']);
  assert.equal(tasks.bind(task, 'fill', 'exec-1', scope()), true);
  const revised = tasks.revise(task, { name: 'Bob' }, scope('new'));
  assert.equal(tasks.record({ id: 'exec-1', scope: scope(), call, status: 'completed' }), false);
  assert.equal(tasks.verify(task, () => ({ satisfied: true, evidenceIds: ['exec-1'] })), false);
  assert.equal(tasks.snapshot()?.status, 'active');
  assert.equal(tasks.verify(revised, () => ({ satisfied: true, evidenceIds: [] })), false);
  assert.equal(tasks.verify(revised, () => ({ satisfied: false, evidenceIds: ['current-dom'] })), false);
  assert.equal(tasks.verify(revised, () => ({ satisfied: true, evidenceIds: ['current-dom'] })), true);
  now += 2000; assert.deepEqual(tasks.next(revised), []);
});

test('plan validator reentrancy and dependency cycles cannot grant execution', () => {
  const tasks = new TaskLedger(), task = tasks.begin({}, scope());
  assert.throws(() => tasks.propose(task, [{ id: 'a', call: { capability: 'x' }, after: ['b'] }]), { code: 'invalid_plan' });
  const plan = tasks.propose(task, [{ id: 'a', call: { capability: 'x' }, after: [] }]);
  assert.equal(tasks.accept(task, plan.id, () => { tasks.begin({ changed: true }, scope('new')); return true; }), false);
});

test('timing summaries bound history and do not retain accidental host content', () => {
  const telemetry = new Telemetry(2);
  telemetry.record({ scope: scope(), at: 1, stage: 'decision', outcome: 'completed', durationMs: 10, prompt: 'private' } as never);
  telemetry.record({ scope: scope(), at: 2, stage: 'decision', outcome: 'completed', durationMs: 20 });
  telemetry.record({ scope: scope(), at: 3, stage: 'decision', outcome: 'deadline', durationMs: 30 });
  assert.equal(telemetry.snapshot().length, 2); assert.equal(JSON.stringify(telemetry.snapshot()).includes('private'), false);
  assert.equal(telemetry.summary().decision.deadlineMisses, 1);
  assert.deepEqual(percentiles([20, 30]), { count: 2, p50: 20, p95: 30, p99: 30, max: 30 });
});
