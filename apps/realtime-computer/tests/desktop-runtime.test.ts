import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../server/desktop-runtime.js';
import { startDesktopServer } from '../server/desktop-app.js';
import type { DesktopCommand, DesktopDriver, DesktopObservation } from '../server/desktop-types.js';
import type { DesktopProviders } from '../server/desktop-providers.js';
import type { DecisionResult } from '@realtime-agent/agent';
import { asJson } from '../server/model.js';

class FixtureDesktop implements DesktopDriver {
  deviceSessionId = 'fixture-device';
  value = '';
  x = -400;
  calls: DesktopCommand[] = [];
  released = 0;
  closed = false;
  pending: Promise<void> | null = null;
  async observe(windowId: string | null = null): Promise<DesktopObservation> {
    return { id: randomUUID(), capturedAt: Date.now(), desktop: { x: -1000, y: 0, width: 2000, height: 1000 },
      foregroundWindowId: 'window-1', selectedWindowId: windowId,
      windows: [{ id: 'window-1', title: 'Native test editor', processName: 'fixture', processId: 99,
        bounds: { x: this.x, y: 10, width: 500, height: 500 }, minimized: false }],
      elements: windowId ? [{ id: 'editor', name: 'Editor', role: 'Edit', value: this.value, enabled: true, offscreen: false,
        bounds: { x: this.x + 10, y: 30, width: 400, height: 300 } }] : [] };
  }
  async screen(windowId: string | null = null) {
    return { png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC', 'base64'),
      bounds: windowId ? { x: this.x, y: 10, width: 500, height: 500 } : { x: -1000, y: 0, width: 2000, height: 1000 }, capturedAt: Date.now() };
  }
  async execute(command: DesktopCommand, _expected: DesktopObservation, signal: AbortSignal, onIssued: () => void = () => {}) {
    signal.throwIfAborted(); onIssued(); this.calls.push(command);
    if (this.pending) await this.pending;
    if (command.kind === 'type') this.value += command.text;
    return this.observe(command.windowId);
  }
  async release() { this.released++; }
  async close() { this.closed = true; }
}
async function until(check: () => boolean, timeout = 4000) {
  const started = performance.now();
  while (!check()) { if (performance.now() - started > timeout) throw new Error('Desktop fixture condition timed out.'); await delay(10); }
}
function providers(): DesktopProviders {
  return {
    fast: { async decide(context) {
      const result: DecisionResult = { selection: { kind: 'wait' }, channels: { computer: { kind: 'continue' } }, interrupt: false, think: false, acceptProposal: false, complete: false };
      if (context.proposal && !context.proposal.accepted) result.acceptProposal = true;
      else {
        const action = context.channels?.computer.candidates.find(candidate => candidate.selection.kind === 'execute');
        if (action) result.channels!.computer = action.selection;
        else if (!context.thinking && !context.channels?.computer.current) result.think = true;
      }
      return result;
    } },
    slow: { async think(context) {
      const observation = context.observation as any;
      return { summary: 'Write requested text in the selected native editor.', suggestions: [], metadata: asJson({
        taskId: observation.task.id, observationId: observation.desktop.id,
        plan: { summary: 'Write requested text', actions: [{ kind: 'click', elementId: 'editor' }, { kind: 'type', text: observation.task.text }],
          verification: { elementId: 'editor', text: observation.task.text, match: 'equals' } },
      }) };
    } },
  };
}

test('manual desktop input is version-bound, recorded by the shared Agent and does not invent a business outcome', async () => {
  const driver = new FixtureDesktop(), runtime = new DesktopRuntime(driver, null, null, { decisionIntervalMs: 1 });
  try {
    await runtime.start();
    assert.equal(runtime.snapshot().backend, 'windows');
    await assert.rejects(runtime.submit('write something'), { code: 'models_missing' });
    await runtime.selectWindow('window-1');
    const frame = await runtime.screen();
    driver.x += 50;
    await assert.rejects(runtime.input({ kind: 'click', windowId: 'window-1', x: -300, y: 60 }, frame.id), { code: 'stale_screen' });
    assert.equal(driver.calls.length, 0);
    await runtime.input({ kind: 'type', windowId: 'window-1', text: '真实输入' });
    await until(() => runtime.snapshot().agent.channels.computer.receipts.length === 1);
    assert.equal(driver.value, '真实输入');
    assert.equal(runtime.snapshot().agent.channels.computer.receipts[0].status, 'completed');
    assert.equal((runtime.snapshot().agent.channels.computer.receipts[0].result as { businessSuccess: boolean }).businessSuccess, false);
    assert.equal(runtime.snapshot().task, null);
  } finally { await runtime.close(); }
  assert.equal(driver.closed, true);
});

test('System Two proposes native controls, System One selects them, and visible text verifies the goal', async () => {
  const driver = new FixtureDesktop(), runtime = new DesktopRuntime(driver, providers(), null, { decisionIntervalMs: 1 });
  try {
    await runtime.start(); await runtime.selectWindow('window-1'); await runtime.submit('今天的待办');
    assert.equal(runtime.snapshot().task?.status, 'active');
    await until(() => runtime.snapshot().task?.status === 'completed');
    assert.deepEqual(driver.calls.map(command => command.kind), ['click', 'type']);
    assert.equal(driver.value, '今天的待办');
    assert.equal(runtime.snapshot().task?.steps, 2);
    assert.equal(runtime.snapshot().task?.evidenceIds.length, 1);
  } finally { await runtime.close(); }
});

test('stop keeps a sent native operation pending until its actual late result, without completing a cancelled task', async () => {
  const driver = new FixtureDesktop(); let finish!: () => void;
  driver.pending = new Promise<void>(resolve => { finish = resolve; });
  const runtime = new DesktopRuntime(driver, null, null, { decisionIntervalMs: 1 });
  try {
    await runtime.start(); await runtime.selectWindow('window-1');
    await runtime.input({ kind: 'type', windowId: 'window-1', text: 'before-stop' });
    const oldTurn = runtime.snapshot().agent.turn!.id;
    await runtime.stop();
    assert.equal(runtime.snapshot().agent.channels.computer.current?.status, 'cancel-requested');
    await assert.rejects(runtime.input({ kind: 'type', windowId: 'window-1', text: 'overlap' }), { code: 'operation_busy' });
    finish();
    await until(() => !runtime.snapshot().agent.channels.computer.current);
    const receipt = runtime.snapshot().agent.channels.computer.receipts[0];
    assert.equal(receipt.scope.turnId, oldTurn); assert.equal(receipt.status, 'completed');
    assert.equal(runtime.snapshot().agent.paused, true); assert.equal(driver.calls.length, 1);
  } finally { finish(); await runtime.close(); }
});

test('lost native acknowledgements remain unknown even if the issued notification never arrived', async () => {
  const driver = new FixtureDesktop();
  driver.execute = async () => { throw Object.assign(new Error('Native reply lost'), { mayHaveExecuted: true }); };
  const runtime = new DesktopRuntime(driver, null, null, { decisionIntervalMs: 1 });
  try {
    await runtime.start(); await runtime.selectWindow('window-1');
    await runtime.input({ kind: 'key', windowId: 'window-1', keys: ['ENTER'] });
    await until(() => runtime.snapshot().agent.channels.computer.current?.status === 'unknown');
    assert.equal(runtime.snapshot().agent.channels.computer.receipts.length, 0);
    await assert.rejects(runtime.input({ kind: 'key', windowId: 'window-1', keys: ['ENTER'] }), { code: 'operation_busy' });
  } finally { await runtime.close(); }
});

test('concurrent manual requests cannot both cross the asynchronous observation checkpoint', async () => {
  const driver = new FixtureDesktop(); let finish!: () => void;
  driver.pending = new Promise<void>(resolve => { finish = resolve; });
  const runtime = new DesktopRuntime(driver, null, null, { decisionIntervalMs: 1 });
  try {
    await runtime.start(); await runtime.selectWindow('window-1');
    const results = await Promise.allSettled([
      runtime.input({ kind: 'type', windowId: 'window-1', text: 'first' }),
      runtime.input({ kind: 'type', windowId: 'window-1', text: 'second' }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'operation_busy');
    finish(); await until(() => !runtime.snapshot().agent.channels.computer.current);
    assert.equal(driver.calls.length, 1);
  } finally { finish(); await runtime.close(); }
});

test('default desktop HTTP serves the real-desktop UI, PNG bounds and input endpoints, never the browser fixture', async () => {
  const driver = new FixtureDesktop(), session = await startDesktopServer({ driver, port: 0, decisionIntervalMs: 1 });
  const post = (path: string, body: unknown) => fetch(`${session.origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const html = await (await fetch(session.origin)).text();
    assert.ok(html.includes('/desktop.js')); assert.ok(!html.includes('goal-form-name'));
    assert.equal((await fetch(`${session.origin}/workspace`)).status, 404);
    assert.equal((await post('/api/window', { windowId: 'window-1' })).status, 200);
    const response = await fetch(`${session.origin}/api/screen`);
    assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('x-screen-x'), '-400');
    assert.equal(response.headers.get('x-screen-window-id'), 'window-1'); assert.ok(response.headers.get('x-screen-id'));
    await response.arrayBuffer();
    assert.equal((await post('/api/goal', { name: 'old form', category: 'life', note: '' })).status, 400);
    assert.equal((await post('/api/input', { command: { kind: 'type', windowId: 'window-1', text: 'native' } })).status, 200);
    await until(() => driver.value === 'native');
    assert.equal((await fetch(`${session.origin}/api/stop`, { method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${session.origin}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  } finally { await session.close(); }
});
