import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { WindowsDriver } from '../../server/windows-driver.js';
import { startDesktopServer } from '../../server/desktop-app.js';

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15000) {
  const start = performance.now();
  while (!await check()) { if (performance.now() - start > timeoutMs) throw new Error('Native desktop UI condition timed out.'); await delay(80); }
}

test('the desktop control page reads real Windows pixels and sends actual input to an owned native window', { timeout: 90000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Interactive Windows acceptance.'); return; }
  const title = `Realtime Agent Desktop UI ${randomUUID()}`;
  const fixture = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./fixture.ps1', import.meta.url)), '-Title', title],
    { shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  fixture.stderr.resume();
  let browser: Browser | null = null, driver: WindowsDriver | null = null;
  let session: Awaited<ReturnType<typeof startDesktopServer>> | null = null;
  const errors: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned native fixture startup timed out.')), 12000);
      const lines = createInterface({ input: fixture.stdout, crlfDelay: Infinity });
      fixture.once('error', error => { clearTimeout(timer); reject(error); });
      fixture.once('exit', () => { clearTimeout(timer); reject(new Error('Owned native fixture closed.')); });
      lines.on('line', line => {
        try { if (JSON.parse(line).ready) { clearTimeout(timer); resolve(); } } catch { /* No fixture output is copied into the test report. */ }
      });
    });
    driver = await WindowsDriver.open();
    const window = (await driver.observe()).windows.find(item => item.title === title);
    assert.ok(window, 'Owned native window should appear in the real Win32 window list.');
    session = await startDesktopServer({ driver, port: 0, decisionIntervalMs: 50 });
    const activeSession = session;
    const post = async (path: string, body: unknown = {}) => {
      const response = await fetch(`${activeSession.origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.text());
    };
    await post('/api/window', { windowId: window.id });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(activeSession.origin);
    await page.getByText('Windows 已连接', { exact: true }).waitFor();
    await until(() => page.locator('#screen').evaluate(image => (image as HTMLImageElement).naturalWidth > 0));
    assert.equal(await page.locator('#window-select').inputValue(), window.id);
    assert.ok((await page.locator('#mode-copy').textContent())?.includes('真实桌面'));
    assert.equal(await page.locator('#start-goal').isDisabled(), true);

    const performed = async (send: () => Promise<unknown>) => {
      await until(() => page.locator('#focus-window').isEnabled());
      const count = activeSession.runtime.snapshot().agent.channels.computer.receipts.length;
      await send();
      try {
        await until(() => activeSession.runtime.snapshot().agent.channels.computer.receipts.length > count
          && !activeSession.runtime.snapshot().agent.channels.computer.current);
      } catch {
        throw new Error(`Input did not settle: ${await page.locator('#command-feedback').textContent()}; ${activeSession.runtime.snapshot().error ?? 'no runtime error'}`);
      }
      assert.equal(activeSession.runtime.snapshot().agent.channels.computer.receipts.at(-1)?.status, 'completed',
        activeSession.runtime.snapshot().error ?? 'Native input must have a real completed receipt.');
    };
    await performed(() => page.locator('#focus-window').click());
    assert.equal(activeSession.runtime.snapshot().observation?.foregroundWindowId, window.id);
    const clickNativeControl = async (name: string) => {
      await until(() => !activeSession.runtime.snapshot().agent.channels.computer.current);
      await until(() => page.locator('[data-click-mode="left"]').isEnabled());
      const observed = activeSession.runtime.snapshot().observation!;
      const target = observed.elements.find(element => element.name === name);
      assert.ok(target, `The owned ${name} control must be observed through UI Automation.`);
      const windowBounds = observed.windows.find(item => item.id === window.id)!.bounds;
      const image = page.locator('#screen');
      await image.scrollIntoViewIfNeeded();
      const box = await image.boundingBox(); assert.ok(box);
      await performed(() => image.click({ position: {
        x: (target.bounds.x + target.bounds.width / 2 - windowBounds.x) / windowBounds.width * box.width,
        y: (target.bounds.y + target.bounds.height / 2 - windowBounds.y) / windowBounds.height * box.height,
      } }));
    };
    await clickNativeControl('InputBox');
    await page.locator('#type-text').fill('来自网页控制台的真实输入');
    await performed(() => page.locator('#type-form button[type=submit]').click());
    await until(() => activeSession.runtime.snapshot().observation?.elements.some(element => element.name === 'InputBox' && element.value === '来自网页控制台的真实输入') === true);
    await performed(() => page.getByRole('button', { name: 'Ctrl + A', exact: true }).click());
    await page.locator('#type-text').fill('桌面验证完成');
    await performed(() => page.locator('#type-form button[type=submit]').click());
    await until(() => activeSession.runtime.snapshot().observation?.elements.some(element => element.name === 'InputBox' && element.value === '桌面验证完成') === true);
    await clickNativeControl('Apply');
    await until(() => activeSession.runtime.snapshot().observation?.elements.some(element => element.name === 'StatusBox' && element.value === 'Clicked') === true);
    assert.ok(activeSession.runtime.snapshot().agent.channels.computer.receipts.filter(receipt => receipt.status === 'completed').length >= 6);
    assert.equal(activeSession.runtime.snapshot().task, null, 'Direct input delivery must not pretend an AI task completed.');
    await until(async () => await page.locator('#manual-badge').textContent() === '窗口已选择'
      && (await page.locator('#command-feedback').textContent())?.includes('系统输入已送达') === true);

    await mkdir('test-results/desktop-native', { recursive: true });
    await page.screenshot({ path: 'test-results/desktop-native/control-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'test-results/desktop-native/control-mobile.png', fullPage: true });
    const actual = await activeSession.runtime.screen();
    await writeFile('test-results/desktop-native/after-input.png', actual.png);
    await post('/api/stop');
    assert.equal(activeSession.runtime.snapshot().agent.paused, true);
    assert.deepEqual(errors, []);
    await writeFile('test-results/desktop-native/ui-verification.json', JSON.stringify({ result: 'passed', backend: 'windows',
      screenshots: ['control-desktop.png', 'control-mobile.png', 'after-input.png'], nativeInput: true,
      modelCalls: 0, checked: ['native-window-pixels', 'web-to-native-click', 'unicode', 'shortcut', 'button-result', 'stop', 'responsive-ui'] }, null, 2));
  } finally {
    await browser?.close();
    if (session) await session.close(); else await driver?.close();
    if (fixture.exitCode === null) fixture.kill();
  }
});
