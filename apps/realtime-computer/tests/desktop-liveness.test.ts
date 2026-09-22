import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopRuntime } from '../server/desktop-runtime.js';
import { TestDesktop, protocolFixture, until } from './desktop-fixture.js';

test('a real SDK Choice requests a plan, reviews it, and selects native input through to evidence', async () => {
  const device = new TestDesktop(), wire = protocolFixture();
  const runtime = new DesktopRuntime(device, wire.providers, null, { decisionIntervalMs: 1 });
  const phases = new Set<string>();
  runtime.agent.subscribe(() => { phases.add(runtime.snapshot().progress.phase); });
  try {
    await runtime.start(); await runtime.selectWindow('editor-window'); await runtime.submit('hello');
    await until(() => runtime.snapshot().task?.status === 'completed', 'Protocol-driven task never completed');
    assert.deepEqual(wire.routes, ['plan', 'accept_plan', 'execute_0', 'execute_0']);
    assert.deepEqual(device.calls.map(call => call.kind), ['click', 'type']); assert.equal(device.value, 'hello');
    assert.equal(runtime.snapshot().progress.phase, 'completed');
    for (const phase of ['deciding', 'planning', 'reviewing', 'executing']) assert.ok(phases.has(phase), phase);
    const requests = JSON.stringify(wire.requests);
    assert.equal(requests.includes('Unrelated private application'), false);
    assert.equal(requests.includes('request_complete'), false); assert.equal(requests.includes('"noul"'), false);
  } finally { await runtime.close(); }
});

test('actual applications with long accessibility labels remain connected and can start', async () => {
  const device = new TestDesktop(); device.name = 'Long document accessibility label '.repeat(400);
  const wire = protocolFixture(), runtime = new DesktopRuntime(device, wire.providers, null, { decisionIntervalMs: 1 });
  try {
    await runtime.start(); await runtime.selectWindow('editor-window');
    assert.equal(runtime.snapshot().connected, true);
    await runtime.submit('label test');
    await until(() => runtime.snapshot().task?.status === 'completed', 'Long UIA name prevented task execution');
    assert.equal(device.value, 'label test');
    assert.ok(JSON.stringify(wire.requests[0]).length < 6000);
  } finally { await runtime.close(); }
});

test('an old screen cannot authorize a click after controls move inside the same window', async () => {
  const device = new TestDesktop(), runtime = new DesktopRuntime(device, null);
  try {
    await runtime.start(); await runtime.selectWindow('editor-window');
    const frame = await runtime.screen(), observe = device.observe.bind(device);
    device.observe = async selected => {
      const observation = await observe(selected);
      if (observation.elements[0]) observation.elements[0].bounds.y += 100;
      return observation;
    };
    await assert.rejects(runtime.input({ kind: 'click', windowId: 'editor-window', x: 50, y: 50 }, frame.id), { code: 'stale_screen' });
    assert.equal(device.calls.length, 0);
  } finally { await runtime.close(); }
});

test('a real provider HTTP failure becomes a visible blocked task without an automatic request loop', async () => {
  const device = new TestDesktop(), wire = protocolFixture({ httpStatus: 401 });
  const runtime = new DesktopRuntime(device, wire.providers, null, { decisionIntervalMs: 1 });
  try {
    await runtime.start(); await runtime.selectWindow('editor-window'); await runtime.submit('hello');
    await until(() => runtime.snapshot().progress.phase === 'blocked', 'Model error was not displayed');
    assert.equal(runtime.snapshot().task?.status, 'needs-review');
    assert.match(runtime.snapshot().progress.message, /401/);
    assert.equal(wire.requests.length, 1); assert.equal(device.calls.length, 0);
  } finally { await runtime.close(); }
});

test('a policy returning only wait cannot leave an active task spinning forever', async () => {
  const device = new TestDesktop(), wire = protocolFixture();
  let count = 0;
  wire.providers.fast = { async decide() { count++; return { selection: { kind: 'wait' }, channels: { computer: { kind: 'continue' } },
    think: false, interrupt: false, acceptProposal: false, complete: false }; } };
  const runtime = new DesktopRuntime(device, wire.providers, null, { decisionIntervalMs: 1, maxIdleDecisions: 2 });
  try {
    await runtime.start(); await runtime.selectWindow('editor-window'); await runtime.submit('hello');
    await until(() => runtime.snapshot().progress.phase === 'blocked', 'Idle decisions were not bounded');
    assert.equal(count, 2); assert.equal(device.calls.length, 0);
    assert.match(runtime.snapshot().progress.message, /没有产生规划或操作/);
  } finally { await runtime.close(); }
});

test('rejected plans get corrected a bounded number of times instead of hiding stalled review', async () => {
  const device = new TestDesktop(), wire = protocolFixture({ choose: criteria => criteria.plan ? 'plan' : 'reject_plan' });
  const runtime = new DesktopRuntime(device, wire.providers, null, { decisionIntervalMs: 1 });
  try {
    await runtime.start(); await runtime.selectWindow('editor-window'); await runtime.submit('hello');
    await until(() => runtime.snapshot().progress.phase === 'blocked', 'Rejected plan loop did not stop');
    assert.match(runtime.snapshot().progress.message, /连续未通过/);
    assert.equal(wire.routes.filter(route => route === 'reject_plan').length, 3); assert.equal(device.calls.length, 0);
  } finally { await runtime.close(); }
});

test('Stop during the asynchronous submit checkpoint cannot start a late task', async () => {
  const device = new TestDesktop(), wire = protocolFixture();
  const runtime = new DesktopRuntime(device, wire.providers);
  let release!: () => void;
  try {
    await runtime.start(); await runtime.selectWindow('editor-window');
    device.captureGate = new Promise<void>(resolve => { release = resolve; });
    const pending = runtime.submit('must not run');
    const rejected = assert.rejects(pending, { code: 'superseded' });
    await runtime.stop(); release(); await rejected;
    assert.equal(runtime.snapshot().task, null); assert.equal(wire.requests.length, 0);
  } finally { release?.(); await runtime.close(); }
});

test('a lost observation shows the blocked state after reconnection rather than active but paused', async () => {
  const device = new TestDesktop(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wire = protocolFixture({ planningGate: gate }), runtime = new DesktopRuntime(device, wire.providers, null, { decisionIntervalMs: 1 });
  try {
    await runtime.start(); await runtime.selectWindow('editor-window'); await runtime.submit('hello');
    await until(() => runtime.snapshot().progress.phase === 'planning', 'Planning did not start');
    device.failCapture = true; await runtime.refresh();
    device.failCapture = false; await runtime.refresh();
    assert.equal(runtime.snapshot().connected, true); assert.equal(runtime.snapshot().task?.status, 'needs-review');
    assert.equal(runtime.snapshot().progress.phase, 'blocked');
    release(); assert.equal(device.calls.length, 0);
  } finally { release(); await runtime.close(); }
});
