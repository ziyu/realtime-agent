import { expect, test } from '@playwright/test';

test('inner life has a personal wish, lived diary, quiet sharing and a readable mobile panel', async ({ page, request }) => {
  expect((await (await request.get('/api/health')).json()).mode).toBe('demo');
  await request.post('/api/control', { data: { type: 'reset' } });
  await request.post('/api/control', { data: { type: 'speed', speed: 4 } });
  await page.goto('/');
  await page.getByRole('tab', { name: '内心', exact: true }).click();
  await expect(page.getByTestId('mind-panel')).toBeVisible();
  await expect(page.getByText('安静、好奇，有点慢热。', { exact: false })).toBeVisible();
  const toggle = page.getByRole('switch', { name: '偶尔主动分享' });
  if (await toggle.getAttribute('aria-checked') === 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  const before = await (await request.get('/api/state')).json();
  await expect.poll(async () => (await (await request.get('/api/state')).json()).metrics.completed, { timeout: 25000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await (await request.get('/api/state')).json()).mind.journal.length, { timeout: 20000 }).toBeGreaterThan(before.mind.journal.length);
  await expect(page.getByTestId('journal-entry').first()).toBeVisible();
  const after = await (await request.get('/api/state')).json();
  expect(after.messages.filter((m: { initiative?: boolean }) => m.initiative)).toHaveLength(0);
  expect(after.mind.personality).toEqual(before.mind.personality);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('mind-panel').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mind-mobile.png', fullPage: true });
  await request.post('/api/control', { data: { type: 'reset' } });
  expect((await (await request.get('/api/state')).json()).mind.journal.length).toBeGreaterThan(0);
  await request.post('/api/mind/settings', { data: { proactiveChat: true } });
});
