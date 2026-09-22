import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { startCuaServer } from '../server/cua-app.js';
import { CuaUiFixture, fixtureProviders, until } from './cua-ui-fixture.js';

test('Cua console drives real HTTP state without preselecting a task window', { timeout: 45000 }, async t => {
  const driver = new CuaUiFixture();
  const typeTool = driver.tools.find(tool => tool.name === 'type_text')!;
  typeTool.inputSchema = { type: 'object', properties: {
    target: { type: 'object' }, delivery_mode: { type: 'string' }, text: { type: 'string' },
  }, required: ['target', 'delivery_mode', 'text'], additionalProperties: false };
  let vision: 'enabled' | 'unavailable' | 'off' = 'off';
  const providers = { ...fixtureProviders, capabilities: () => ({ vision }) };
  const session = await startCuaServer({ driver, providers, port: 0, decisionIntervalMs: 20,
    taskTimeoutMs: 60000, progressTimeoutMs: 60000 });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(session.origin, { waitUntil: 'domcontentloaded' });
    await page.getByText('Cua 已连接', { exact: true }).waitFor();
    assert.equal(await page.locator('#perception-status').innerText(), '可访问性');
    assert.equal(await page.locator('#perception-status').getAttribute('data-vision'), 'off');
    await until(() => driver.screenWaiting, 'The intentionally slow screen request did not start.');

    await t.test('vision capability stays explicit when image input is enabled, rejected, or off', async () => {
      vision = 'enabled';
      await until(async () => await page.locator('#perception-status').innerText() === '图像 + 可访问性', 'Enabled vision label did not render.');
      vision = 'unavailable';
      await until(async () => (await page.locator('#perception-status').innerText()).includes('模型未接受图像'), 'Rejected image capability was hidden.');
      assert.equal(await page.locator('#perception-status').getAttribute('data-vision'), 'unavailable');
      vision = 'off';
      await until(async () => await page.locator('#perception-status').innerText() === '可访问性', 'Off vision label did not render.');
    });

    await t.test('fast state polling stays responsive while screen capture is slow, and Start needs no preview selection', async () => {
      assert.equal(await page.locator('#view-select').inputValue(), '');
      await page.locator('#goal-text').fill('Open the fixture editor and prepare the requested note');
      await until(async () => await page.locator('#start-goal').isEnabled(), 'Start did not enable on connected/modelReady/text alone.');
      await page.locator('#start-goal').click();
      await until(async () => (await page.locator('#task-status').innerText()).includes('任务进行中'), 'State polling was blocked by the slow screen request.');
      assert.equal(await page.locator('#progress-status').getAttribute('data-phase'), 'queued');
      assert.equal(session.runtime.snapshot().task?.status, 'active');
      assert.equal(session.runtime.snapshot().viewWindowId, null);
    });

    await t.test('screen failure remains visible after later state and screen refreshes recover', async () => {
      driver.releaseScreen();
      await until(async () => !(await page.locator('#error-banner').isHidden()), 'Screen failure never reached the UI.');
      const message = await page.locator('#error-text').innerText();
      assert.ok(message.length > 0);
      await until(async () => await page.locator('#screen').evaluate(image => (image as HTMLImageElement).naturalWidth > 0), 'Screen did not recover after the fixture failure.');
      assert.ok(await page.locator('#screen').getAttribute('data-frame-id'));
      assert.ok(await page.locator('#screen').getAttribute('data-captured-at'));
      await delay(700);
      assert.equal(await page.locator('#error-text').innerText(), message, 'A successful poll incorrectly cleared the prior error.');
    });

    await t.test('preview selection never scopes or stops the active task', async () => {
      const taskId = session.runtime.snapshot().task!.id;
      await page.locator('#view-select').selectOption('101');
      await until(() => session.runtime.snapshot().viewWindowId === '101', 'Preview selection did not reach the real API.');
      const state = session.runtime.snapshot();
      assert.equal(state.task?.id, taskId);
      assert.equal(state.task?.status, 'active');
      assert.equal(state.agent.paused, false);
    });

    await t.test('Stop cancels and Resume restarts the same natural-language goal', async () => {
      await page.locator('#stop').click();
      await until(() => session.runtime.snapshot().task?.status === 'cancelled', 'Stop did not cancel the task.');
      await until(async () => await page.locator('#resume').isEnabled(), 'Resume did not enable for the cancelled task.');
      const text = session.runtime.snapshot().task!.text;
      await page.locator('#resume').click();
      await until(() => session.runtime.snapshot().task?.status === 'active', 'Resume did not recreate the active task.');
      assert.equal(session.runtime.snapshot().task?.text, text);
    });

    await t.test('manual desktop typing targets the latest observed active window and Stop stays available while native input is pending', async () => {
      await page.locator('#view-select').selectOption('');
      await until(() => session.runtime.snapshot().viewWindowId === null, 'Desktop preview did not become active.');
      await until(async () => Boolean(await page.locator('#screen').getAttribute('data-frame-id')), 'Desktop frame did not become available.');
      const baseCall = driver.call.bind(driver);
      let releaseType!: () => void, typeArgs: Record<string, unknown> | null = null, typeStarted = false;
      const typeGate = new Promise<void>(resolve => { releaseType = resolve; });
      driver.call = async (name, args, signal) => {
        if (name === 'type_text') {
          typeStarted = true; typeArgs = structuredClone(args);
          await typeGate; signal?.throwIfAborted();
        }
        return baseCall(name, args, signal);
      };
      try {
        await page.locator('#type-text').fill('manual fixture text');
        await page.locator('#type-form button[type="submit"]').click();
        await until(() => typeStarted, 'Manual type never reached the Cua fixture.');
        assert.equal(session.runtime.snapshot().task?.status, 'cancelled', 'Manual takeover did not stop the automatic task first.');
        const received = typeArgs as Record<string, unknown> | null;
        assert.equal((received?.target as { window_id?: number })?.window_id, 101, 'Desktop typing was not explicitly targeted at the latest observed active window.');
        await until(async () => (await page.locator('#manual-state').innerText()).includes('native 操作待回执'), 'Native pending state was not visible.');
        assert.equal(await page.locator('#stop').isEnabled(), true, 'Stop must remain available while a native operation is pending.');
        await page.locator('#stop').click();
      } finally {
        releaseType(); driver.call = baseCall;
      }
      await until(() => !session.runtime.snapshot().agent.channels.computer.current, 'Pending native input did not settle after Stop.');
    });

    await t.test('390px console has no horizontal overflow', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });

    assert.deepEqual(errors, []);
  } finally {
    driver.releaseScreen();
    await page.close(); await browser.close(); await session.close();
  }
});
