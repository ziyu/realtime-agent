import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { requireComputerModels, resolveComputerStartup } from '../server/startup.js';
import { desktopProviders } from '../server/desktop-providers.js';
import { WindowsDriver } from '../server/windows-driver.js';
import { startDesktopServer } from '../server/desktop-app.js';

// Opt-in: real configured models, actual UI submission, and only an owned native test window.
// No task or screen from the user's other applications enters the model prompt.
const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const startup = resolveComputerStartup({ appDirectory, args: ['--live'] });
requireComputerModels(startup);
if (process.platform !== 'win32') throw new Error('This verification requires an interactive Windows session.');
const title = `Realtime Agent Live Task ${randomUUID()}`;
const value = `任务验收 ${randomUUID().slice(0, 8)}`;
const fixture = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../tests/native/fixture.ps1', import.meta.url)), '-Title', title],
  { shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
fixture.stderr.resume();
let driver: WindowsDriver | null = null, browser: Browser | null = null;
let session: Awaited<ReturnType<typeof startDesktopServer>> | null = null;
const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), 60000);
const requests: { stage: string; status: number; durationMs: number }[] = [];
let count = 0;
const outputDirectory = join(appDirectory, 'test-results/desktop-task');
async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, message: string) {
  const start = performance.now();
  while (!await check()) {
    if (performance.now() - start > timeoutMs || abort.signal.aborted) throw new Error(message);
    await delay(100);
  }
}
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned native test window did not start.')), 12000);
    fixture.once('error', error => { clearTimeout(timer); reject(error); });
    fixture.once('exit', () => { clearTimeout(timer); reject(new Error('Owned native test window exited.')); });
    const lines = createInterface({ input: fixture.stdout });
    lines.on('line', line => { try { if (JSON.parse(line).ready) { clearTimeout(timer); resolve(); } } catch {} });
  });
  driver = await WindowsDriver.open();
  const owned = (await driver.observe()).windows.find(window => window.title === title);
  assert.ok(owned, 'The owned test window was not found.');
  const providers = desktopProviders(startup.config!, { fetch: async (url, init) => {
    if (++count > 12) throw new Error('Live verification request budget exhausted.');
    const stage = String(url).includes('chat/completions') ? 'llm' : 'system-one';
    const start = performance.now();
    const response = await fetch(url, { ...init, signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]) });
    const receipt = { stage, status: response.status, durationMs: Math.round(performance.now() - start) };
    requests.push(receipt); console.log(JSON.stringify(receipt));
    return response;
  } });
  session = await startDesktopServer({ driver, providers, port: 0 });
  const active = session;
  await active.runtime.selectWindow(owned.id);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(active.origin);
  await page.locator('#goal-text').fill(`在当前窗口的 InputBox 编辑框中输入“${value}”，完成后结束任务。不要修改其他控件。`);
  await until(async () => await page.locator('#start-goal').isEnabled(), 10000, 'The Start button did not become ready.');
  await page.locator('#start-goal').click();
  await until(() => {
    const state = active.runtime.snapshot();
    if (state.task?.status === 'needs-review') throw new Error(state.progress.message);
    return state.task?.status === 'completed';
  }, 35000, 'The live task did not complete before the verification deadline.');
  const state = active.runtime.snapshot();
  assert.equal(state.observation?.elements.find(element => element.name === 'InputBox')?.value, value);
  assert.ok(state.task?.steps && state.task.steps > 0);
  await until(async () => await page.locator('#task-progress').getAttribute('data-phase') === 'completed', 5000, 'Completion did not reach the control page.');
  const completedAt = state.agent.channels.computer.receipts.at(-1)!.updatedAt;
  await until(async () => Number(await page.locator('#screen').getAttribute('data-captured-at')) >= completedAt, 8000,
    'The control page did not display a post-operation screen frame.');
  await mkdir(outputDirectory, { recursive: true });
  await page.screenshot({ path: join(outputDirectory, 'live-completed.png'), fullPage: true });
  const finalFrame = await driver.screen(owned.id);
  await writeFile(join(outputDirectory, 'live-native-result.png'), finalFrame.png);
  const report = { result: 'passed', verifiedAt: new Date().toISOString(), backend: 'windows',
    modelTransport: 'configured-live-endpoints', realModelCalls: count, requests,
    entry: 'page-start-task', operations: state.task.steps, verifiedNativeText: true };
  await writeFile(join(outputDirectory, 'live-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  clearTimeout(deadline); abort.abort();
  await browser?.close();
  if (session) await session.close(); else await driver?.close();
  if (fixture.exitCode === null) fixture.kill();
}
