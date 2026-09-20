import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  const health = await request.get('/api/health');
  expect((await health.json()).mode, 'Only a local demo world may be changed by E2E tests').toBe('demo');
  await request.post('/api/control', { data: { type: 'reset' } });
});

test('renders the 3D house and keeps the page usable at 390px', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('model-mode')).toHaveText('本地演示');
  await expect(page.getByRole('button', { name: '暂停世界', exact: true })).toBeEnabled();
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.getByText('3D 画面暂时不可用')).toHaveCount(0);
  await page.getByRole('button', { name: '暂停世界', exact: true }).click();
  await expect(page.getByTestId('agent-status')).toHaveText('已暂停');
  await page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: /一个会生活的 AI/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: /8 个可交互物体/ }).click();
  await page.getByRole('button', { name: '书架 书房' }).click();
  await expect(page.getByTestId('object-card')).toBeVisible();
  await expect(page.getByRole('button', { name: '请 Milo 看书' })).toBeEnabled();
  await page.getByRole('button', { name: '取消选择' }).click();
  await page.screenshot({ path: 'test-results/home-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '模型连接' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('real UI messages produce ordered world effects, interruption, and memory', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '4×', exact: true }).click();
  const field = page.getByRole('textbox', { name: '给 Milo 发消息' });
  await field.fill('先喝水，再给植物浇水');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(field).toHaveValue('');
  await expect.poll(async () => {
    const state = await (await request.get('/api/state')).json();
    return state.outcomes.filter((o: { requestId: string }) => o.requestId === state.intent.id).map((o: { action: string }) => o.action);
  }, { timeout: 25000 }).toEqual(['drink', 'water']);
  await page.getByRole('tab', { name: /记忆/ }).click();
  await expect(page.locator('.memory-card').filter({ hasText: '植物已浇水' }).first()).toBeVisible();
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await field.fill('去睡觉'); await field.press('Enter');
  await expect.poll(async () => (await (await request.get('/api/state')).json()).agent.action?.id).toBe('sleep');
  await field.fill('停止'); await field.press('Enter');
  await expect.poll(async () => (await (await request.get('/api/state')).json()).agent.action).toBeNull();
  await page.getByRole('tab', { name: '思考', exact: true }).click();
  await expect(page.getByText('中断：睡一会儿').first()).toBeVisible();
  const state = await (await request.get('/api/state')).json();
  expect(state.metrics.jevCalls).toBe(0); expect(state.metrics.llmCalls).toBe(0);
  expect(state.outcomes.some((o: { action: string }) => o.action === 'sleep')).toBe(false);
});

test('a planning message invokes simulated slow thinking through the fast system', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '帮我安排一下今天' }).click();
  await expect.poll(async () => (await (await request.get('/api/state')).json()).reflection?.accepted, { timeout: 20000 }).toBe(true);
  await page.getByRole('tab', { name: '思考', exact: true }).click();
  await expect(page.getByText('模拟慢思考建议', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: '思考' }).getByText('快系统发起慢思考', { exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: '思考' }).getByText('快系统采纳了慢思考建议', { exact: true })).toBeVisible();
});
