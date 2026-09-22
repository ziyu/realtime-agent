import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { WindowsDriver } from '../../server/windows-driver.js';
import { startDesktopServer } from '../../server/desktop-app.js';
import { protocolFixture, until } from '../desktop-fixture.js';

test('Start task runs SDK decisions and planning through the real Windows driver to visible native text', { timeout: 60000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Requires an interactive Windows desktop.'); return; }
  const title = `Realtime Agent Task Test ${randomUUID()}`;
  const fixture = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./fixture.ps1', import.meta.url)), '-Title', title],
    { shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  fixture.stderr.resume();
  let driver: WindowsDriver | null = null, browser: Browser | null = null;
  let session: Awaited<ReturnType<typeof startDesktopServer>> | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned test window did not start')), 12000);
      fixture.once('error', error => { clearTimeout(timer); reject(error); });
      fixture.once('exit', () => { clearTimeout(timer); reject(new Error('Owned test window exited')); });
      const lines = createInterface({ input: fixture.stdout });
      lines.on('line', line => { try { if (JSON.parse(line).ready) { clearTimeout(timer); resolve(); } } catch {} });
    });
    driver = await WindowsDriver.open();
    const owned = (await driver.observe()).windows.find(window => window.title === title);
    assert.ok(owned);
    const observed = await driver.observe(owned.id);
    const editor = observed.elements.find(element => element.name === 'InputBox' && element.role === 'Edit');
    assert.ok(editor);
    const expected = '自动任务已写入真实窗口';
    const wire = protocolFixture({ plan: { summary: 'Write the requested text in the observed editor',
      actions: [{ kind: 'click', elementId: editor.id }, { kind: 'type', text: expected }],
      verification: { elementId: editor.id, text: expected, match: 'equals' } } });
    session = await startDesktopServer({ driver, providers: wire.providers, port: 0, decisionIntervalMs: 100 });
    const active = session;
    // Select only the owned window before displaying any pixels in the control page.
    const selection = await fetch(`${active.origin}/api/window`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windowId: owned.id }) });
    assert.equal(selection.status, 200);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(active.origin);
    await page.locator('#goal-text').fill(`在 InputBox 中输入“${expected}”。`);
    await until(async () => await page.locator('#start-goal').isEnabled(), 'Start remained disabled', 15000);
    await page.locator('#start-goal').click();
    await until(() => active.runtime.snapshot().task?.status === 'completed', 'Native automatic task did not complete', 25000);
    await until(async () => await page.locator('#task-progress').getAttribute('data-phase') === 'completed', 'Completion did not reach the page');
    const result = active.runtime.snapshot();
    assert.equal(result.observation?.elements.find(element => element.id === editor.id)?.value, expected);
    assert.equal(result.task?.steps, 2);
    assert.deepEqual(wire.routes, ['plan', 'accept_plan', 'execute_0', 'execute_0']);
    assert.deepEqual(errors, []);
    const completedAt = result.agent.channels.computer.receipts.at(-1)!.updatedAt;
    await until(async () => Number(await page.locator('#screen').getAttribute('data-captured-at')) >= completedAt,
      'Final native screen never reached the control page', 8000);
    await mkdir('test-results/desktop-task', { recursive: true });
    await page.screenshot({ path: 'test-results/desktop-task/completed.png', fullPage: true });
    await writeFile('test-results/desktop-task/verification.json', JSON.stringify({ result: 'passed', backend: 'windows',
      modelTransport: 'response-fixture', realModelCalls: 0, entry: 'page-start-task', routes: wire.routes,
      operations: result.task?.steps, verifiedNativeText: true }, null, 2));
  } finally {
    await browser?.close();
    if (session) await session.close(); else await driver?.close();
    if (fixture.exitCode === null) fixture.kill();
  }
});
