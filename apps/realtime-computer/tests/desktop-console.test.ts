import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { startDesktopServer } from '../server/desktop-app.js';
import { TestDesktop, protocolFixture, until } from './desktop-fixture.js';

test('Start sends the task through the actual HTTP and SDK path, with visible prerequisites and progress', { timeout: 30000 }, async () => {
  const device = new TestDesktop();
  let allowPlan!: () => void, allowScreen!: () => void;
  const planGate = new Promise<void>(resolve => { allowPlan = resolve; });
  const screenGate = new Promise<void>(resolve => { allowScreen = resolve; });
  const capture = device.screen.bind(device);
  device.screen = async () => { await screenGate; return capture(); };
  const wire = protocolFixture({ planningGate: planGate });
  const session = await startDesktopServer({ driver: device, providers: wire.providers, port: 0, decisionIntervalMs: 1 });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(session.origin, { waitUntil: 'domcontentloaded' });
    await page.getByText('Windows 已连接', { exact: true }).waitFor();
    await page.locator('#goal-text').fill('from task button');
    assert.equal(await page.locator('#start-goal').isDisabled(), true);
    assert.match(await page.locator('#start-hint').innerText(), /观察范围/);
    await page.locator('#window-select').selectOption('editor-window');
    await until(async () => await page.locator('#start-goal').isEnabled(), 'Window selection never enabled Start');
    await page.locator('#start-goal').click();
    await until(async () => await page.locator('#task-progress').getAttribute('data-phase') === 'planning', 'Slow screenshot prevented planning status from reaching the UI');
    assert.match(await page.locator('#task-progress').innerText(), /LLM/);
    assert.equal(device.calls.length, 0);
    // No route mocks or DOM state injection: the server runs the real coordinator and provider code.
    allowPlan();
    await until(async () => await page.locator('#task-progress').getAttribute('data-phase') === 'completed', 'Goal never completed from the Start button');
    assert.equal(device.value, 'from task button');
    assert.deepEqual(wire.routes, ['plan', 'accept_plan', 'execute_0', 'execute_0']);
    assert.deepEqual(errors, []);
    allowScreen();

    // Closing the target during submission must leave a visible blocked state,
    // whether the submission or the final pre-execution check detects it first.
    const observe = device.observe.bind(device);
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/goal')) {
        // The selected application closes as the next task reaches the server.
        // Capture itself succeeds, so a later state poll has no server error to re-display.
        device.observe = async selected => { const state = await observe(selected); state.windows = state.windows.filter(window => window.id !== 'editor-window'); return state; };
      }
    });
    await page.locator('#goal-text').fill('unavailable desktop');
    await page.locator('#start-goal').click();
    await until(async () => (await page.locator('#error').innerText()).length > 0, 'Submission failure disappeared');
    await delay(800); assert.ok((await page.locator('#error').innerText()).length > 0);
    await until(async () => await page.locator('#task-progress').getAttribute('data-phase') === 'blocked',
      'Closed target left the task active without a reason');
  } finally {
    allowPlan(); allowScreen(); await browser.close(); await session.close();
  }
});
