import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, ModelSlot, OperationRuntime, ResourceArbiter, TaskLedger } from '../src/index.js';
import type { ReportOperation, ThoughtProposal } from '../src/index.js';
import { decision, deferred, move, room, scope } from './fixture.js';

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('explicit cancellation ends the local await without releasing an unsettled upstream', { timeout: 1000 }, async () => {
  const slot = new ModelSlot(), upstream = deferred<string>(); let settled = 0;
  const local = slot.run(() => upstream.promise, 10000, () => settled++);
  slot.cancel();
  await assert.rejects(local, { name: 'AbortError' });
  assert.equal(slot.busy, true); assert.equal(settled, 0);
  assert.throws(() => slot.run(async () => 'overlap', 1000, () => {}), { code: 'model_busy' });
  upstream.reject(new Error('late upstream failure')); await flush();
  assert.equal(slot.busy, false); assert.equal(settled, 1);
});

test('cancelling from the dispatch notification does not send either device hook', () => {
  let starts = 0, cancels = 0;
  const arbiter = new ResourceArbiter();
  const runtime: OperationRuntime<{}> = new OperationRuntime({
    deviceSessionId: 'desktop', resources: ['pointer'], arbiter,
    capabilities: [{ id: 'click', prepare: () => ({ maxDurationMs: 500, interruptibility: 'immediate',
      dispatch() { starts++; }, cancel() { cancels++; },
    }) }],
    onChange(receipt) { if (receipt.status === 'dispatched') runtime.cancel({}, 'new-input'); },
  });
  runtime.start({ capability: 'click' }, scope(), {});
  assert.equal(starts, 0); assert.equal(cancels, 0);
  assert.equal(runtime.history.length, 1);
  assert.equal(runtime.history[0].status, 'cancelled'); assert.equal(runtime.history[0].effect, 'none');
  assert.equal(runtime.current, null); assert.deepEqual(arbiter.snapshot(), []);
});

test('a terminal report during abort is emitted once and cannot be downgraded to pending', () => {
  const events: { status: string; terminal: boolean }[] = [];
  const runtime = new OperationRuntime({ deviceSessionId: 'desktop', resources: [],
    capabilities: [{ id: 'click', prepare: () => ({ maxDurationMs: 500, interruptibility: 'immediate',
      dispatch(_context, operation, report) {
        report({ sequence: 1, status: 'running', effect: 'none' });
        operation.signal.addEventListener('abort', () => report({ sequence: 2, status: 'completed', effect: 'committed', result: { saved: true } }), { once: true });
      }, cancel() { throw new Error('Must not run after a terminal report'); },
    }) }], onChange: (receipt, terminal) => events.push({ status: receipt.status, terminal }),
  });
  runtime.start({ capability: 'click' }, scope(), {}); runtime.cancel({}, 'new-input');
  assert.deepEqual(events.filter(event => event.status === 'completed'), [{ status: 'completed', terminal: true }]);
  assert.equal(runtime.history.length, 1); assert.equal(runtime.current, null);
});

test('an unavailable reconcile hook reports that no query started', () => {
  let report!: ReportOperation;
  const runtime = new OperationRuntime({ deviceSessionId: 'desktop', resources: [],
    capabilities: [{ id: 'click', prepare: () => ({ maxDurationMs: 500, interruptibility: 'noninterruptible',
      dispatch(_context, _operation, emit) { report = emit; },
    }) }],
  });
  runtime.start({ capability: 'click' }, scope(), {}); runtime.cancel({});
  assert.equal(runtime.reconcile({}), false); assert.equal(runtime.reconcile({}), false);
  report({ sequence: 1, status: 'completed', effect: 'committed', result: { saved: true } });
});

test('device elapsed time measures real monotonic duration rather than wall-clock adjustments', () => {
  let report!: ReportOperation, wall = 100000, monotonic = 0;
  const runtime = new OperationRuntime({ deviceSessionId: 'desktop', resources: [], now: () => wall, monotonicNow: () => monotonic,
    capabilities: [{ id: 'click', prepare: () => ({ maxDurationMs: 500, interruptibility: 'immediate',
      dispatch(_context, _operation, emit) { report = emit; },
    }) }],
  });
  runtime.start({ capability: 'click' }, scope(), {});
  wall += 900000; monotonic = 250;
  report({ sequence: 1, status: 'completed', effect: 'committed', result: { saved: true } });
  assert.equal(runtime.history[0].elapsedSeconds, .25);
});

test('new sensor evidence during decision review prevents the old candidate from executing', async () => {
  const f = room();
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now, fast: { decide: async () => decision({ selection: move() }) } });
  const observed = { id: 'dom-1', source: 'dom', sequence: 1, capturedAt: f.clock.now, clockUncertaintyMs: 0,
    maxAgeMs: 1000, facts: {}, entities: { bed: 1 }, provenance: 'sensor' as const };
  agent.observe(observed);
  const reference = agent.observations.reference('dom', ['bed']), original = f.environment.candidates;
  f.environment.candidates = context => original(context).map(c => c.id === 'move:bed' ? { ...c, observations: [reference] } : c);
  agent.subscribe(event => {
    if (event.type === 'decision-resolved') agent.observe({ ...observed, id: 'dom-2', sequence: 2, entities: { bed: 2 } });
  });
  agent.receive('Move'); assert.equal(await agent.decide(), false);
  assert.equal(agent.snapshot().error?.code, 'stale_observation');
  assert.equal(agent.actions.current, null); assert.equal(f.state.position, 0); agent.dispose();
});

test('an unsettled device reset still stops other execution and preserves evidence for reconciliation', async () => {
  const f = room(); let report!: ReportOperation;
  f.environment.output = { candidates: () => [{ id: 'say', description: 'Speak', selection: { kind: 'execute', call: { capability: 'say' } } }],
    capabilities: [{ id: 'say', prepare: () => ({ step: () => ({ status: 'running' }) }) }] };
  f.environment.channels = [{ id: 'computer', mode: 'async', deviceSessionId: 'desktop', resources: ['pointer'],
    candidates: () => [{ id: 'click', description: 'Click', selection: { kind: 'execute', call: { capability: 'click' } } }],
    capabilities: [{ id: 'click', prepare: () => ({ maxDurationMs: 1000, interruptibility: 'immediate',
      dispatch(_context, _operation, emit) { report = emit; }, cancel() {},
    }) }],
  }];
  const agent = new Agent({ environment: f.environment, fast: { decide: async () => decision({ selection: move(),
    output: { kind: 'execute', call: { capability: 'say' } }, channels: { computer: { kind: 'execute', call: { capability: 'click' } } },
  }) } });
  agent.receive('Walk, speak and click'); await agent.decide(); const epoch = agent.scope.epoch;
  assert.throws(() => agent.reset(), { code: 'unsettled_operation' });
  assert.equal(agent.snapshot().paused, true); assert.equal(agent.actions.current, null); assert.equal(agent.outputs.current, null);
  agent.tick(.5); assert.equal(f.state.position, 0); assert.equal(agent.scope.epoch, epoch);
  report({ sequence: 1, status: 'completed', effect: 'committed', result: { saved: true } });
  assert.equal(agent.snapshot().channels.computer.receipts[0].scope.epoch, epoch);
  agent.reset(); assert.notEqual(agent.scope.epoch, epoch); assert.equal(agent.snapshot().paused, false); agent.dispose();
});

test('thinking cooldown follows monotonic time across wall-clock corrections', async () => {
  const f = room(); let wall = 100000, monotonic = 0, calls = 0;
  let selected = decision({ think: true });
  const agent = new Agent({ environment: f.environment, now: () => wall, monotonicNow: () => monotonic,
    fast: { decide: async () => selected }, slow: { think: async (): Promise<ThoughtProposal> => { calls++; return { summary: 'Advice', suggestions: [] }; } },
  });
  agent.receive('Plan'); await agent.decide(); await flush();
  assert.equal(calls, 1);
  selected = decision({ acceptProposal: true, think: true }); wall += 20000; monotonic = 1000;
  await agent.decide(); await flush(); assert.equal(calls, 1);
  wall -= 900000; monotonic = 15000; agent.wake();
  await agent.decide(); await flush(); assert.equal(calls, 2); agent.dispose();
});

test('cancelled inference is included in the discarded timing count with its original scope', async () => {
  const f = room(), upstream = deferred<ReturnType<typeof decision>>();
  const agent = new Agent({ environment: f.environment, now: () => f.clock.now, fast: { decide: () => upstream.promise } });
  const first = agent.receive('First request'); const pending = agent.decide();
  f.clock.now += 40; agent.receive('Replacement'); await pending;
  assert.equal(agent.telemetry.summary().decision.discarded, 1);
  const timing = agent.telemetry.snapshot().find(sample => sample.stage === 'decision' && sample.outcome === 'discarded')!;
  assert.equal(timing.scope.turnId, first.id); assert.equal(timing.durationMs, 40);
  upstream.resolve(decision()); await flush();
  assert.equal(agent.telemetry.summary().decision.discarded, 1); agent.dispose();
});

test('expired plans expose a replan signal without wall-clock jumps expiring current work', () => {
  let wall = 100000, monotonic = 0;
  const tasks = new TaskLedger({ now: () => wall, monotonicNow: () => monotonic });
  const task = tasks.begin({}, scope()), plan = tasks.propose(task, [{ id: 'click', call: { capability: 'click' }, after: [] }], 1000);
  assert.equal(tasks.accept(task, plan.id, () => true), true);
  wall += 900000; monotonic = 500;
  assert.equal(tasks.snapshot()?.plan?.expired, false); assert.equal(tasks.next(task).length, 1);
  wall -= 1000000; monotonic = 1000;
  assert.equal(tasks.snapshot()?.plan?.expired, true); assert.deepEqual(tasks.next(task), []);
  const replacement = tasks.propose(task, [{ id: 'observe', call: { capability: 'observe' }, after: [] }], 1000);
  assert.equal(replacement.expired, false); assert.equal(tasks.accept(task, replacement.id, () => true), true);
});
