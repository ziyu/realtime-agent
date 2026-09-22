import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CuaTransport, CuaTransportError } from '../server/cua-transport.js';
import type { CuaResult, CuaTool, CuaWire } from '../server/cua-transport.js';

const tools: CuaTool[] = [
  { name: 'list_apps', description: 'List apps', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'screenshot', description: 'Capture screen', inputSchema: { type: 'object', properties: { display: { type: 'integer' } } } },
  { name: 'error_tool', description: 'Fixture error', inputSchema: { type: 'object', properties: {} } },
];

class FakeWire implements CuaWire {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  closed = 0;
  pending: ((value: CuaResult) => void) | null = null;
  async start() { return { tools, metadata: { driverVersion: '0.28.2', embedded: true } }; }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    this.calls.push({ name, args });
    if (name === 'list_apps') return { text: 'ok', data: { apps: [{ name: 'Notepad' }] }, images: [{ mimeType: 'image/png', dataBase64: 'AA==' }], isError: false, verified: true, degraded: false };
    if (name === 'error_tool') return { text: 'denied', data: { refusal: true }, images: [], isError: true, errorCode: 'permission_denied', degraded: true };
    return new Promise<CuaResult>((resolve, reject) => {
      this.pending = resolve;
      signal?.addEventListener('abort', () => reject(new CuaTransportError('wire_cancelled', 'cancelled', true)), { once: true });
    });
  }
  async close() { this.closed++; }
}

class NonSettlingWire extends FakeWire {
  override async call(name: string, args: Record<string, unknown>): Promise<CuaResult> {
    this.calls.push({ name, args });
    return new Promise<CuaResult>(() => {});
  }
}

class SuccessfulAfterAbortWire extends FakeWire {
  override async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    this.calls.push({ name, args });
    return new Promise<CuaResult>(resolve => {
      signal?.addEventListener('abort', () => setTimeout(() => resolve({
        text: 'actual outcome', data: { observed: 'after-abort' }, images: [], isError: false, verified: true, degraded: false,
      }), 25), { once: true });
    });
  }
}

class NotStartedAfterAbortWire extends FakeWire {
  override async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    this.calls.push({ name, args });
    return new Promise<CuaResult>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new CuaTransportError('ActionInterrupted', 'not started', false)), { once: true });
    });
  }
}

test('CuaTransport exposes dynamic tools and preserves structured/image/error metadata', async () => {
  const wire = new FakeWire(), transport = await CuaTransport.open({ wire });
  try {
    assert.deepEqual(transport.metadata, { driverVersion: '0.28.2', embedded: true });
    assert.equal(transport.tools[1].inputSchema.properties instanceof Object, true);
    const result = await transport.call('list_apps', {});
    assert.deepEqual(result.data, { apps: [{ name: 'Notepad' }] });
    assert.deepEqual(result.images, [{ mimeType: 'image/png', dataBase64: 'AA==' }]);
    assert.equal(result.verified, true); assert.equal(result.degraded, false); assert.equal(result.isError, false);
    const failure = await transport.call('error_tool', {});
    assert.equal(failure.isError, true); assert.equal(failure.errorCode, 'permission_denied'); assert.equal(failure.degraded, true);
    assert.equal(wire.calls.length, 2);
    await assert.rejects(transport.call('missing', {}), error => error instanceof CuaTransportError && error.code === 'cua_unknown_tool');
  } finally { await transport.close(); }
  assert.equal(wire.closed, 1);
});

test('real Cua SDK worker discovers metadata and dynamic tools without invoking an action tool', { timeout: 30000 }, async () => {
  if (process.platform !== 'win32') return;
  const transport = await CuaTransport.open({ timeoutMs: 5000 });
  try {
    assert.equal(transport.metadata.driverVersion, '0.28.2');
    assert.equal(transport.metadata.embedded, true);
    assert.ok(transport.tools.length > 40);
    const listApps = transport.tools.find(tool => tool.name === 'list_apps');
    assert.ok(listApps); assert.equal(listApps.inputSchema.type, 'object');
    for (const name of ['launch_app', 'list_windows', 'get_window_state', 'type_text', 'hotkey', 'verify_state']) {
      assert.ok(transport.tools.some(tool => tool.name === name), `Expected Cua SDK tool ${name}.`);
    }
  } finally { await transport.close(); }
});

test('pre-abort has no effect, active calls are single-flight, and pending cancellation is uncertain', async () => {
  const wire = new FakeWire(), transport = await CuaTransport.open({ wire });
  try {
    const pre = new AbortController(); pre.abort();
    await assert.rejects(transport.call('screenshot', {}, pre.signal), error => error instanceof Error && error.name === 'AbortError');
    assert.equal(wire.calls.length, 0);

    const abort = new AbortController();
    const pending = transport.call('screenshot', { display: 0 }, abort.signal);
    await delay(0);
    await assert.rejects(transport.call('list_apps', {}), error => error instanceof CuaTransportError && error.code === 'cua_busy');
    abort.abort();
    await assert.rejects(pending, error => error instanceof CuaTransportError && error.code === 'wire_cancelled' && error.mayHaveExecuted === true);
  } finally { await transport.close(); }
});

test('cancellation returns a real late result for reconciliation and preserves known not-started errors', async () => {
  const successWire = new SuccessfulAfterAbortWire(), success = await CuaTransport.open({ wire: successWire });
  try {
    const abort = new AbortController(), pending = success.call('screenshot', {}, abort.signal);
    await delay(0); abort.abort();
    const result = await pending;
    assert.deepEqual(result.data, { observed: 'after-abort' }); assert.equal(result.verified, true); assert.equal(successWire.closed, 0);
  } finally { await success.close(); }

  const notStartedWire = new NotStartedAfterAbortWire(), notStarted = await CuaTransport.open({ wire: notStartedWire });
  try {
    const abort = new AbortController(), pending = notStarted.call('screenshot', {}, abort.signal);
    await delay(0); abort.abort();
    await assert.rejects(pending, error => error instanceof CuaTransportError && error.code === 'ActionInterrupted' && error.mayHaveExecuted === false);
  } finally { await notStarted.close(); }
});

test('timeout is uncertain and closes a non-settling injected transport once', async () => {
  const wire = new NonSettlingWire(), transport = await CuaTransport.open({ wire, timeoutMs: 100 });
  await assert.rejects(transport.call('screenshot', {}), error => error instanceof CuaTransportError && error.code === 'cua_timeout' && error.mayHaveExecuted === true);
  assert.equal(wire.closed, 1);
  await transport.close(); assert.equal(wire.closed, 1);
});

test('a synchronous wire rejection still releases local admission and clears its deadline', async () => {
  const wire = new FakeWire(), base = wire.call.bind(wire);
  let first = true;
  wire.call = (name, args, signal) => {
    if (first) { first = false; throw new CuaTransportError('fixture_failure', 'Request rejected before enqueueing.', false); }
    return base(name, args, signal);
  };
  const transport = await CuaTransport.open({ wire, timeoutMs: 100 });
  try {
    await assert.rejects(transport.call('list_apps', {}), { code: 'fixture_failure', mayHaveExecuted: false });
    assert.equal((await transport.call('list_apps', {})).isError, false);
    await delay(120);
    assert.equal(wire.closed, 0);
  } finally { await transport.close(); }
});
