import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { WorldState } from '../../shared/types';

test.beforeEach(async ({ request }) => {
  expect((await (await request.get('/api/health')).json()).mode).toBe('demo');
  await request.post('/api/control', { data: { type: 'reset' } });
});

test('a walking agent responds to a correction, with visible turn latency and no old action effects', async ({ page, request }) => {
  const world = async () => (await (await request.get('/api/state')).json()) as WorldState;
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '给 Milo 发消息' });
  await input.fill('去睡觉'); await input.press('Enter');
  await expect.poll(async () => (await world()).agent.action?.id).toBe('sleep');
  const old = (await world()).intent!.id;
  await input.fill('先别睡，去喝水'); await input.press('Enter');
  await expect.poll(async () => (await world()).agent.action?.id).toBe('drink');
  const state = await world(), turn = state.turns.at(-1)!;
  expect(state.agent.action?.requestId).toBe(turn.id);
  expect(state.outcomes.some(o => o.requestId === old)).toBe(false);
  expect(state.traces.some(t => t.title === '中断：睡一会儿')).toBe(true);
  expect(turn.appliedAt! - turn.receivedAt).toBeLessThan(1200);
  await expect(page.getByTestId('reaction-latency')).toContainText('行为响应');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('realtime-controls')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/realtime-mobile.png', fullPage: true });
});

test('a slow HTTP delivery does not block a newer message or erase a newly typed draft', async ({ page, request }) => {
  await page.goto('/');
  let release!: () => void;
  let intercepted = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/messages', async route => {
    if (route.request().postDataJSON().text === '去睡觉') { intercepted = true; await gate; }
    await route.continue();
  });
  const input = page.getByRole('textbox', { name: '给 Milo 发消息' });
  try {
    await input.fill('去睡觉'); await input.press('Enter');
    await expect.poll(() => intercepted).toBe(true);
    await input.fill('去喝水');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await input.press('Enter');
    await input.fill('这句话还在编辑中');
    await expect.poll(async () => (await (await request.get('/api/state')).json()).intent?.text).toBe('去喝水');
    const rejected = page.waitForResponse(r => r.url().endsWith('/api/messages') && r.status() === 409);
    release(); await rejected;
    await expect(input).toHaveValue('这句话还在编辑中');
    await expect(page.getByRole('alert')).toHaveCount(0);
    const world = await (await request.get('/api/state')).json() as WorldState;
    expect(world.intent?.text).toBe('去喝水');
    expect(world.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['去喝水']);
  } finally { release(); }
});

test('kitchen inspection answers once and exposes an exportable per-turn loop on desktop and mobile', async ({ page, request }) => {
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '给 Milo 发消息' });
  await input.fill('走到厨房去看有啥东西'); await input.press('Enter');
  await expect.poll(async () => (await (await request.get('/api/state')).json()).intent?.observation?.target).toBe('kitchen');
  const walking = await (await request.get('/api/state')).json() as WorldState;
  expect(walking.agent.action?.phase).toBe('walking');
  expect(walking.messages.some(m => m.turnId === walking.intent!.id && m.role === 'agent')).toBe(false);
  const debug = page.getByTestId('turn-debugger');
  await expect(debug).toContainText('等待抵达厨房取得观察');
  await expect(page.getByRole('log', { name: '聊天记录' })).toContainText('厨房里有料理台、饮水台、水槽。');
  const arrived = await (await request.get('/api/state')).json() as WorldState;
  expect(arrived.outcomes.some(o => o.requestId === walking.intent!.id && o.action === 'inspect' && o.target === 'kitchen')).toBe(true);
  expect(arrived.messages.filter(m => m.role === 'user')).toHaveLength(1);
  await expect(debug).toContainText('已交付');
  await expect(debug).toContainText('控制器已采纳决策');
  await debug.screenshot({ path: 'test-results/debug-desktop.png' });
  await input.fill('停下'); await input.press('Enter');
  await expect(debug).toContainText('“停下”');
  await page.getByRole('combobox', { name: '调试轮次' }).selectOption(walking.intent!.id);
  await expect(debug).toContainText('“走到厨房去看有啥东西”');
  await expect(debug).not.toContainText('“停下”');
  await debug.getByText(/查看这轮的.*条事件与结构化数据/).click();
  await expect(debug).toContainText('观察结果已就绪');
  const downloaded = page.waitForEvent('download');
  await debug.getByRole('button', { name: '导出这一轮' }).click();
  const artifact = await downloaded;
  const exported = JSON.parse(await readFile((await artifact.path())!, 'utf8'));
  expect(exported.turn.id).toBe(walking.intent!.id);
  expect(exported.traces.every((t: { turnId: string }) => t.turnId === exported.turn.id)).toBe(true);
  expect(exported.speechReceipts).toContainEqual(expect.objectContaining({ status: 'completed', call: expect.objectContaining({ capability: 'speak' }) }));
  expect(exported.receipts.every((r: { scope: { turnId: string } }) => r.scope.turnId === exported.turn.id)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await debug.screenshot({ path: 'test-results/debug-mobile.png' });
});

test('continuous speech final results auto-send and speech onset cancels the previous reply', async ({ page, request }) => {
  // Exercise the actual page and HTTP/runtime; only the device recognition boundary is a fixture.
  // This is not an assertion that a physical microphone or hosted speech recognition worked.
  await page.addInitScript(() => {
    type TestWindow = Window & { __speechTest: { engine: BrowserRecognition | null; cancels: number; spoken: string[] }; webkitSpeechRecognition: typeof BrowserRecognition };
    const target = window as unknown as TestWindow;
    class BrowserRecognition {
      lang = ''; continuous = false; interimResults = false;
      onstart: (() => void) | null = null; onend: (() => void) | null = null;
      onspeechstart: (() => void) | null = null;
      onresult: ((e: unknown) => void) | null = null;
      start() { target.__speechTest.engine = this; this.onstart?.(); }
      abort() {}
    }
    target.__speechTest = { engine: null, cancels: 0, spoken: [] };
    target.webkitSpeechRecognition = BrowserRecognition;
    Object.defineProperty(window, 'SpeechRecognition', { value: BrowserRecognition, configurable: true });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      cancel: () => { target.__speechTest.cancels++; },
      speak: (utterance: SpeechSynthesisUtterance) => { target.__speechTest.spoken.push(utterance.text); },
    } });
  });
  await page.goto('/');
  await page.getByRole('combobox', { name: '实时语音方案' }).selectOption('browser');
  await page.getByRole('button', { name: '开始实时对话', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束实时对话', exact: true })).toBeVisible();
  async function recognize(parts: [string, boolean][]) {
    await page.evaluate(values => {
      const target = window as unknown as { __speechTest: { engine: { onresult(e: unknown): void } } };
      target.__speechTest.engine.onresult({ resultIndex: 0, results: values.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal })) });
    }, parts);
  }
  await recognize([['你喜欢', false]]);
  await expect(page.getByTestId('voice-caption')).toContainText('你喜欢');
  expect((await (await request.get('/api/state')).json()).intent).toBeNull();
  await recognize([['你喜欢怎样的生活？只聊聊。', true]]);
  await expect.poll(async () => (await (await request.get('/api/state')).json()).thinking, { intervals: [50] }).toBe(true);
  const first = await (await request.get('/api/state')).json() as WorldState;
  await page.evaluate(() => {
    const target = window as unknown as { __speechTest: { engine: { onspeechstart(): void } } };
    target.__speechTest.engine.onspeechstart();
  });
  await expect.poll(async () => (await (await request.get('/api/state')).json()).intent?.replySuppressed).toBe(true);
  await recognize([['你喜欢怎样的生活？只聊聊。', true], ['去喝水', true]]);
  await expect.poll(async () => (await (await request.get('/api/state')).json()).agent.action?.id).toBe('drink');
  const state = await (await request.get('/api/state')).json() as WorldState;
  expect(state.turns.at(-1)?.source).toBe('voice');
  expect(state.turns.find(t => t.id === first.intent!.id)?.replyAt).toBeNull();
  expect(state.messages.some(m => m.role === 'agent' && m.turnId === first.intent!.id)).toBe(false);
  const device = await page.evaluate(() => (window as unknown as { __speechTest: { cancels: number; spoken: string[] } }).__speechTest);
  expect(device.cancels).toBeGreaterThan(0);
  expect(device.spoken).toEqual([]);
  await page.getByRole('button', { name: '结束实时对话', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始实时对话', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/realtime-desktop.png', fullPage: true });
});
