import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { WorldState } from '../../shared/types';

const screenshots = 'test-results/presentation';

async function world(request: APIRequestContext): Promise<WorldState> {
  const response = await request.get('/api/state');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<WorldState>;
}

function canvas(page: Page) {
  return page.getByTestId('home-scene').locator('canvas');
}

async function send(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: '给 Milo 发消息' });
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

test.beforeEach(async ({ request }) => {
  expect((await (await request.get('/api/health')).json()).mode, 'Presentation E2E must run against the isolated local demo').toBe('demo');
  await request.post('/api/control', { data: { type: 'reset' } });
  await request.post('/api/control', { data: { type: 'speed', speed: 1 } });
  mkdirSync(screenshots, { recursive: true });
});

test('real demo drives listening, task, thought, pause and reset presentation through the same world state', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('model-mode')).toHaveText('本地演示');
  await expect(canvas(page)).toHaveCount(1);
  await expect(page.getByText('3D 画面暂时不可用')).toHaveCount(0);

  const taskText = '现在去喝水。';
  await send(page, taskText);
  await expect.poll(async () => {
    const state = await world(request);
    return {
      intent: state.intent?.text ?? null,
      expression: state.presentation?.expression ?? null,
      gaze: state.presentation?.gaze ?? null,
      faceStatus: state.channels?.face.current?.status ?? null,
      gazeStatus: state.channels?.gaze.current?.status ?? null,
      canvasExpression: await canvas(page).getAttribute('data-expression'),
      canvasGaze: await canvas(page).getAttribute('data-gaze'),
    };
  }, { timeout: 5000, intervals: [40, 80, 120] }).toEqual({
    intent: taskText,
    expression: 'attentive',
    gaze: 'speaker',
    faceStatus: 'running',
    gazeStatus: 'running',
    canvasExpression: 'attentive',
    canvasGaze: 'speaker',
  });
  await page.getByTestId('home-scene').screenshot({ path: `${screenshots}/01-listening.png` });

  await expect.poll(async () => {
    const state = await world(request);
    return {
      action: state.agent.action?.id ?? null,
      requestMatchesTurn: Boolean(state.agent.action && state.agent.action.requestId === state.intent?.id),
      expression: state.presentation?.expression ?? null,
      gaze: state.presentation?.gaze ?? null,
      canvasExpression: await canvas(page).getAttribute('data-expression'),
      canvasGaze: await canvas(page).getAttribute('data-gaze'),
    };
  }, { timeout: 5000, intervals: [40, 80, 120] }).toEqual(expect.objectContaining({
    action: 'drink',
    requestMatchesTurn: true,
    expression: 'attentive',
    gaze: 'speaker',
    canvasExpression: 'attentive',
    canvasGaze: 'speaker',
  }));
  await page.getByTestId('home-scene').screenshot({ path: `${screenshots}/02-task.png` });

  const thoughtText = '继续手头的事情，同时帮我安排一下今天。';
  await send(page, thoughtText);
  await expect.poll(async () => {
    const state = await world(request);
    return {
      intent: state.intent?.text ?? null,
      expression: state.presentation?.expression ?? null,
      gaze: state.presentation?.gaze ?? null,
      faceTarget: state.channels?.face.current?.call.target ?? null,
      thoughtStarted: state.traces.some(trace => trace.title === '快系统发起慢思考'),
      canvasExpression: await canvas(page).getAttribute('data-expression'),
      canvasGaze: await canvas(page).getAttribute('data-gaze'),
    };
  }, { timeout: 5000, intervals: [40, 60, 100] }).toEqual({
    intent: thoughtText,
    expression: 'thinking',
    gaze: 'speaker',
    faceTarget: 'thinking',
    thoughtStarted: true,
    canvasExpression: 'thinking',
    canvasGaze: 'speaker',
  });
  await page.getByTestId('home-scene').screenshot({ path: `${screenshots}/03-thinking.png` });

  await page.getByRole('button', { name: '暂停世界', exact: true }).click();
  await expect.poll(async () => {
    const state = await world(request);
    return {
      paused: state.paused,
      expression: state.presentation?.expression ?? null,
      gaze: state.presentation?.gaze ?? null,
      face: state.channels?.face.current ?? null,
      head: state.channels?.gaze.current ?? null,
      canvasExpression: await canvas(page).getAttribute('data-expression'),
      canvasGaze: await canvas(page).getAttribute('data-gaze'),
    };
  }).toEqual({
    paused: true,
    expression: 'neutral',
    gaze: 'forward',
    face: null,
    head: null,
    canvasExpression: 'neutral',
    canvasGaze: 'forward',
  });
  await page.getByTestId('home-scene').screenshot({ path: `${screenshots}/04-paused.png` });

  const beforeReset = await world(request);
  await page.getByRole('button', { name: '重新开始', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '重新开始这一天？' })).toBeVisible();
  await dialog.getByRole('button', { name: '重新开始', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => {
    const state = await world(request);
    return {
      epochChanged: state.epoch !== beforeReset.epoch,
      paused: state.paused,
      intent: state.intent,
      expression: state.presentation?.expression ?? null,
      gaze: state.presentation?.gaze ?? null,
      canvasExpression: await canvas(page).getAttribute('data-expression'),
      canvasGaze: await canvas(page).getAttribute('data-gaze'),
    };
  }, { timeout: 5000, intervals: [40, 80, 120] }).toEqual({
    epochChanged: true,
    paused: false,
    intent: null,
    expression: 'neutral',
    gaze: 'forward',
    canvasExpression: 'neutral',
    canvasGaze: 'forward',
  });
  await page.getByTestId('home-scene').screenshot({ path: `${screenshots}/05-reset.png` });
});
