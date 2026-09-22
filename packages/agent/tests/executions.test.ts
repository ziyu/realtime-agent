import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, ActionRuntime, OperationRuntime, ResourceArbiter } from '../src/index.js';
import type { AsyncCapability, OperationContext, ReportOperation } from '../src/index.js';
import { decision, deferred, scope } from './fixture.js';

function fixture(arbiter = new ResourceArbiter()) {
  let report!: ReportOperation, operation!: OperationContext, sequence = 0, starts = 0, cancels = 0;
  const clock = { wall: 100000, monotonic: 0 };
  const capabilities: AsyncCapability<{}>[] = [{ id: 'click', prepare(call) {
    if (call.target === 'missing') throw new Error('Unavailable');
    return { maxDurationMs: 500, interruptibility: 'immediate',
      dispatch(_context, op, emit) { starts++; operation = op; report = emit; },
      cancel() { cancels++; },
      reconcile(_context, _op, emit) { emit({ sequence: ++sequence, status: 'completed', effect: 'committed', result: { saved: true } }); },
    };
  } }];
  const runtime = new OperationRuntime({ capabilities, deviceSessionId: 'device-1', resources: ['desktop:pointer', 'desktop:keyboard'], arbiter,
    now: () => clock.wall, monotonicNow: () => clock.monotonic });
  return { runtime, capabilities, arbiter, clock, report: (...args: Parameters<ReportOperation>) => report(...args),
    operation: () => operation, starts: () => starts, cancels: () => cancels };
}

test('cancel requests retain both device resources until a real terminal report; a late commit keeps its origin', () => {
  const f = fixture(), other = fixture(f.arbiter);
  const first = f.runtime.start({ capability: 'click', target: 'save' }, scope('old'), {});
  f.runtime.cancel({}, 'new-input');
  assert.equal(f.operation().signal.aborted, true);
  assert.equal(f.runtime.current?.status, 'cancel-requested');
  assert.equal(f.runtime.history.length, 0);
  assert.throws(() => other.runtime.start({ capability: 'click' }, scope('new'), {}), { code: 'resource_busy' });
  assert.equal(other.starts(), 0); assert.equal(f.arbiter.snapshot().length, 2);
  assert.equal(f.report({ sequence: 1, status: 'completed', effect: 'committed', result: { saved: true } }), true);
  assert.equal(f.runtime.history[0].scope.turnId, 'old'); assert.equal(f.runtime.history[0].id, first.id);
  assert.equal(f.runtime.history[0].status, 'completed'); assert.equal(f.arbiter.snapshot().length, 0);
  assert.equal(f.report({ sequence: 1, status: 'completed', effect: 'committed', result: { saved: true } }), false);
  assert.equal(f.runtime.history.length, 1);
  other.runtime.start({ capability: 'click' }, scope('new'), {});
  other.report({ sequence: 1, status: 'cancelled', effect: 'none' });
});

test('deadlines use monotonic time; unknown operations require reconciliation before reset', () => {
  const f = fixture(); f.runtime.start({ capability: 'click' }, scope(), {});
  f.clock.wall += 900000; f.runtime.tick({}); assert.equal(f.cancels(), 0);
  f.clock.monotonic = 501; f.runtime.tick({});
  assert.equal(f.runtime.current?.status, 'unknown'); assert.equal(f.cancels(), 1);
  assert.throws(() => f.runtime.reset({}), { code: 'unsettled_operation' });
  assert.equal(f.arbiter.snapshot().length, 2);
  f.runtime.reconcile({});
  assert.equal(f.runtime.history[0].status, 'completed'); assert.deepEqual(f.runtime.history[0].result, { saved: true });
  f.runtime.reset({}); assert.equal(f.runtime.history.length, 0);
});

test('dispatch settlement does not fabricate success, rejection is unknown, and reports are identity/sequence checked', async () => {
  const send = deferred<void>(); let report!: ReportOperation;
  const runtime = new OperationRuntime({ deviceSessionId: 'device', resources: ['mouse'], capabilities: [{ id: 'send', prepare: () => ({
    maxDurationMs: 1000, interruptibility: 'noninterruptible', dispatch(_c, _op, emit) { report = emit; return send.promise; },
  }) }] });
  const started = runtime.start({ capability: 'send' }, scope(), {});
  send.reject(new Error('private raw transport details')); await Promise.resolve(); await Promise.resolve();
  assert.equal(runtime.current?.status, 'unknown'); assert.equal(JSON.stringify(runtime.current).includes('private raw'), false);
  assert.equal(runtime.report({ operationId: started.id, deviceSessionId: 'other', sequence: 1, status: 'cancelled', effect: 'none' }), false);
  assert.throws(() => report({ sequence: 1, status: 'completed', effect: 'unknown' }), { code: 'invalid_operation_event' });
  report({ sequence: 2, status: 'running', effect: 'partial', progress: .5 });
  assert.equal(report({ sequence: 1, status: 'cancelled', effect: 'none' }), false);
  report({ sequence: 3, status: 'cancelled', effect: 'partial' });
  assert.equal(runtime.history[0].effect, 'partial'); assert.equal(runtime.history[0].status, 'cancelled');
  runtime.history[0].effect = 'none'; assert.equal(runtime.history[0].effect, 'partial');
});

test('synchronous and asynchronous executors share the same resource arbiter', () => {
  const f = fixture(), sync = new ActionRuntime({ arbiter: f.arbiter, resources: ['desktop:pointer'], capabilities: [{ id: 'move', prepare: () => ({ step: () => ({ status: 'completed', result: {} }) }) }] });
  f.runtime.start({ capability: 'click' }, scope(), {});
  assert.throws(() => sync.start({ capability: 'move' }, scope(), {}), { code: 'resource_busy' });
  f.report({ sequence: 1, status: 'cancelled', effect: 'none' });
  sync.start({ capability: 'move' }, scope(), {}); assert.equal(sync.tick({}, .1)?.status, 'completed');
  assert.deepEqual(f.arbiter.snapshot(), []);
});

test('Agent accounts for late asynchronous execution while paused without completing a different turn', async () => {
  const f = fixture();
  const agent = new Agent({ now: () => f.clock.wall, monotonicNow: () => f.clock.monotonic,
    environment: { context: () => ({}), observe: () => ({}), capabilities: [], candidates: () => [{ id: 'wait', description: 'Wait', selection: { kind: 'wait' } }],
      channels: [{ id: 'computer', mode: 'async', deviceSessionId: 'device-1', resources: ['desktop'], capabilities: f.capabilities,
        candidates: () => [{ id: 'click', description: 'Save', selection: { kind: 'execute', call: { capability: 'click', target: 'save' } } }] }] },
    fast: { decide: async () => decision({ channels: { computer: { kind: 'execute', call: { capability: 'click', target: 'save' } } } }) },
  });
  const old = agent.receive('Save'); assert.equal(await agent.decide(), true);
  const first = agent.snapshot().channels.computer.current!;
  agent.receive('A different goal'); agent.pause();
  f.report({ sequence: 1, status: 'completed', effect: 'committed', result: { saved: true } });
  const receipt = agent.snapshot().channels.computer.receipts[0];
  assert.equal(receipt.id, first.id); assert.equal(receipt.scope.turnId, old.id);
  assert.equal(agent.snapshot().turn?.completed, false); assert.equal(agent.snapshot().channels.computer.current, null);
  agent.dispose();
});
