import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { WindowsDriver, DesktopDriverError } from '../../server/windows-driver.js';
import type { DesktopElement, DesktopObservation, DesktopWindow } from '../../server/desktop-types.js';

async function eventually<T>(read: () => Promise<T | null>, message: string, timeoutMs = 10000): Promise<T> {
  const started = performance.now();
  for (;;) {
    const value = await read(); if (value !== null) return value;
    if (performance.now() - started > timeoutMs) throw new Error(message);
    await delay(50);
  }
}

function center(element: DesktopElement): { x: number; y: number } {
  return { x: Math.round(element.bounds.x + element.bounds.width / 2), y: Math.round(element.bounds.y + element.bounds.height / 2) };
}

function named(observation: DesktopObservation, name: string, role?: string): DesktopElement {
  const element = observation.elements.find(item => item.name === name && (!role || item.role === role));
  assert.ok(element, `Expected UIAutomation element ${name}${role ? ` (${role})` : ''}.`);
  return element;
}

async function startFixture(title: string) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = fileURLToPath(new URL('./fixture.ps1', import.meta.url));
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', title], {
    shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The native fixture did not become ready.')), 10000);
    const fail = (error: Error) => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', code => { if (code !== 0) fail(new Error(`The native fixture exited before ready (${code}).`)); });
    lines.on('line', line => {
      try {
        const value = JSON.parse(line) as { ready?: unknown };
        if (value.ready === true) { clearTimeout(timer); child.off('error', fail); resolve(); }
      } catch { /* Ignore non-protocol host output. */ }
    });
  });
  return child;
}

test('helper protocol expires queued commits and marks timed-out commits uncertain without OS input', { timeout: 15000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows-only helper protocol.'); return; }
  const driver = await WindowsDriver.open();
  type ProtocolRequest = (kind: string, payload: Record<string, unknown>, timeoutMs: number,
    options: { executionRisk?: boolean; terminateHelperOnTimeout?: boolean }) => Promise<unknown>;
  const request = (driver as unknown as { request: ProtocolRequest }).request.bind(driver);
  try {
    await assert.rejects(request('protocol-test-expiry', { delayMs: 120, expiresAt: Date.now() + 40 }, 1000, { executionRisk: true }), error =>
      error instanceof DesktopDriverError && error.code === 'command_expired' && error.mayHaveExecuted === false);

    await assert.rejects(request('protocol-test-delay', { delayMs: 500 }, 80, { executionRisk: true, terminateHelperOnTimeout: true }), error =>
      error instanceof DesktopDriverError && error.code === 'helper_timeout' && error.mayHaveExecuted === true);
    const started = performance.now();
    await Promise.all([driver.close(), driver.close()]);
    assert.ok(performance.now() - started < 4000, 'Concurrent close calls should share one bounded close operation.');
  } finally { await driver.close(); }
});

test('WindowsDriver controls only an explicitly selected real WinForms window', { timeout: 60000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows-only native acceptance.'); return; }
  const title = `Realtime Agent Native Fixture ${randomUUID()}`;
  const fixture = await startFixture(title);
  let driver: WindowsDriver | null = null;
  let issued = 0;
  try {
    const activeDriver = driver = await WindowsDriver.open();
    const target: DesktopWindow = await eventually(async () => {
      const observation = await activeDriver.observe();
      return observation.windows.find(window => window.title === title) ?? null;
    }, 'The owned WinForms fixture was not enumerated.');

    let selected = await activeDriver.observe(target.id);
    assert.equal(selected.selectedWindowId, target.id);
    assert.ok(selected.elements.length > 0);
    assert.equal(selected.elements.some(element => element.name === 'InputBox'), true);

    const frame = await activeDriver.screen(target.id);
    assert.ok(frame.png.length > 100);
    assert.deepEqual(frame.bounds, selected.windows.find(window => window.id === target.id)!.bounds);
    await mkdir('test-results/desktop-native', { recursive: true });
    await writeFile('test-results/desktop-native/window.png', frame.png);

    selected = await activeDriver.execute({ kind: 'focus', windowId: target.id }, selected, new AbortController().signal, () => { issued++; });
    assert.equal(selected.foregroundWindowId, target.id);
    assert.equal(issued, 1);

    const input = named(selected, 'InputBox', 'Edit');
    selected = await activeDriver.execute({ kind: 'click', windowId: target.id, ...center(input) }, selected, new AbortController().signal, () => { issued++; });
    selected = await activeDriver.execute({ kind: 'type', windowId: target.id, text: '你好🌟' }, selected, new AbortController().signal, () => { issued++; });
    assert.equal(named(selected, 'InputBox', 'Edit').value, '你好🌟');

    selected = await activeDriver.execute({ kind: 'key', windowId: target.id, keys: ['CTRL', 'A'] }, selected, new AbortController().signal, () => { issued++; });
    assert.equal(named(selected, 'StatusBox', 'Edit').value, 'Select:0:4:InputBoxControl');
    selected = await activeDriver.execute({ kind: 'type', windowId: target.id, text: '替换成功' }, selected, new AbortController().signal, () => { issued++; });
    assert.equal(named(selected, 'InputBox', 'Edit').value, '替换成功');

    selected = await activeDriver.execute({ kind: 'key', windowId: target.id, keys: ['CTRL', 'L'] }, selected, new AbortController().signal, () => { issued++; });
    assert.equal(named(selected, 'StatusBox', 'Edit').value, 'Shortcut received');

    const apply = named(selected, 'Apply', 'Button');
    selected = await activeDriver.execute({ kind: 'click', windowId: target.id, ...center(apply) }, selected, new AbortController().signal, () => { issued++; });
    assert.equal(named(selected, 'StatusBox', 'Edit').value, 'Clicked');

    const beforeMove = selected;
    const move = named(beforeMove, 'Move window', 'Button');
    selected = await activeDriver.execute({ kind: 'click', windowId: target.id, ...center(move) }, beforeMove, new AbortController().signal, () => { issued++; });
    assert.notDeepEqual(selected.windows.find(window => window.id === target.id)!.bounds, beforeMove.windows.find(window => window.id === target.id)!.bounds);
    const beforeStaleAttempt = issued;
    await assert.rejects(activeDriver.execute({ kind: 'key', windowId: target.id, keys: ['A'] }, beforeMove, new AbortController().signal, () => { issued++; }),
      error => error instanceof DesktopDriverError && error.code === 'stale_bounds');
    assert.equal(issued, beforeStaleAttempt);

    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(activeDriver.execute({ kind: 'key', windowId: target.id, keys: ['A'] }, selected, aborted.signal, () => { issued++; }),
      error => error instanceof Error && error.name === 'AbortError');
    assert.equal(issued, beforeStaleAttempt);

    await delay(2100);
    await assert.rejects(activeDriver.execute({ kind: 'focus', windowId: target.id }, selected, new AbortController().signal, () => { issued++; }),
      error => error instanceof DesktopDriverError && error.code === 'stale_observation');
    assert.equal(issued, beforeStaleAttempt);

    selected = await activeDriver.observe(target.id);
    const minimize = named(selected, 'Minimize', 'Button');
    selected = await activeDriver.execute({ kind: 'click', windowId: target.id, ...center(minimize) }, selected, new AbortController().signal, () => { issued++; });
    assert.equal(selected.windows.find(window => window.id === target.id)?.minimized, true);
    const beforeMinimizedReject = issued;
    await assert.rejects(activeDriver.execute({ kind: 'key', windowId: target.id, keys: ['A'] }, selected, new AbortController().signal, () => { issued++; }),
      error => error instanceof DesktopDriverError && error.code === 'window_minimized');
    assert.equal(issued, beforeMinimizedReject);
    selected = await activeDriver.execute({ kind: 'focus', windowId: target.id }, selected, new AbortController().signal, () => { issued++; });
    assert.equal(selected.windows.find(window => window.id === target.id)?.minimized, false);
    assert.equal(selected.foregroundWindowId, target.id);

    await activeDriver.release();
    await activeDriver.close();
    await assert.rejects(activeDriver.observe(), error => error instanceof DesktopDriverError && error.code === 'driver_closed');
  } finally {
    if (driver) await driver.close();
    if (fixture.exitCode === null) fixture.kill();
  }
});

test('expired and timed-out execute commits cannot arrive late', { timeout: 60000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows-only native acceptance.'); return; }
  const title = `Realtime Agent Native Timeout Fixture ${randomUUID()}`;
  const fixture = await startFixture(title);
  let expiredDriver: WindowsDriver | null = null, timedDriver: WindowsDriver | null = null, verifier: WindowsDriver | null = null;
  try {
    const lookup = async (driver: WindowsDriver): Promise<{ selected: DesktopObservation; target: DesktopWindow }> => {
      const target = await eventually(async () => {
        const observation = await driver.observe();
        return observation.windows.find(window => window.title === title) ?? null;
      }, 'The owned timeout fixture was not enumerated.');
      return { target, selected: await driver.observe(target.id) };
    };

    expiredDriver = await WindowsDriver.open({ executeTimeoutMs: 1200, testDelayBeforeEffectMs: 1000 });
    const expired = await lookup(expiredDriver);
    let expiredIssued = 0;
    await assert.rejects(expiredDriver.execute({ kind: 'type', windowId: expired.target.id, text: 'EXPIRED' }, expired.selected,
      new AbortController().signal, () => { expiredIssued++; }), error =>
      error instanceof DesktopDriverError && error.code === 'command_expired' && error.mayHaveExecuted === false);
    assert.equal(expiredIssued, 0);
    assert.equal(named(await expiredDriver.observe(expired.target.id), 'InputBox', 'Edit').value, '');
    await expiredDriver.close();

    timedDriver = await WindowsDriver.open({ executeTimeoutMs: 150, testDelayBeforeEffectMs: 500 });
    const timed = await lookup(timedDriver);
    let timedIssued = 0;
    await assert.rejects(timedDriver.execute({ kind: 'type', windowId: timed.target.id, text: 'TOO LATE' }, timed.selected,
      new AbortController().signal, () => { timedIssued++; }), error =>
      error instanceof DesktopDriverError && error.code === 'helper_timeout' && error.mayHaveExecuted === true);
    assert.equal(timedIssued, 0);
    const closeStarted = performance.now();
    await Promise.all([timedDriver.close(), timedDriver.close()]);
    assert.ok(performance.now() - closeStarted < 4000, 'Repeated close should reuse the same bounded close operation.');

    await delay(700);
    verifier = await WindowsDriver.open();
    const verified = await lookup(verifier);
    assert.equal(named(verified.selected, 'InputBox', 'Edit').value, '');
  } finally {
    if (expiredDriver) await expiredDriver.close();
    if (timedDriver) await timedDriver.close();
    if (verifier) await verifier.close();
    if (fixture.exitCode === null) fixture.kill();
  }
});
