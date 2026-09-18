import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadRuntimeConfig } from '@realtime-agent/config';
import { AgentRuntime } from '../../server/runtime';
import { JevProvider } from '../../server/providers';
import type { WorldState } from '../../shared/types';

async function state(request: APIRequestContext): Promise<WorldState> {
  const response = await request.get('/api/state');
  expect(response.ok()).toBe(true);
  const world = await response.json() as WorldState;
  expect(world.mode).toBe('live');
  // Bound every test; an unexpected repeated request must fail instead of consuming credits indefinitely.
  expect(world.metrics.jevCalls).toBeLessThan(35);
  expect(world.metrics.llmCalls).toBeLessThan(4);
  expect(world.error).toBeNull();
  return world;
}

test.beforeEach(async ({ request }) => {
  const health = await request.get('/api/health');
  expect((await health.json()).mode, 'Live verification must use real providers').toBe('live');
  await request.post('/api/control', { data: { type: 'reset' } });
  await request.post('/api/control', { data: { type: 'speed', speed: 2 } });
});

test.afterEach(async ({ request }, info) => {
  const response = await request.get('/api/state');
  if (response.ok()) {
    const world = await response.json() as WorldState;
    const report = {
      test: info.title, result: info.status, verifiedAt: new Date().toISOString(),
      mode: world.mode, configuredModels: world.connected,
      metrics: world.metrics, scheduler: world.scheduler, intent: world.intent,
      outcomes: world.outcomes, reflection: world.reflection,
      decisions: world.traces.filter(t => t.kind === 'decision'),
      modelResponses: world.traces.filter(t => t.receipt),
      errors: world.traces.filter(t => t.kind === 'error'),
      replies: world.messages.filter(m => m.role === 'agent'),
    };
    mkdirSync('test-results/live-integration', { recursive: true });
    const name = info.title.startsWith('Jev autonomy') ? 'autonomy' : info.title.startsWith('Jev recovery') ? 'recovery-server' : info.title.startsWith('Jev action') ? 'action' : info.title.startsWith('Jev sequence') ? 'sequence-and-interrupt' : 'slow-thinking';
    writeFileSync(`test-results/live-integration/${name}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ test: info.title, result: info.status, mode: world.mode, metrics: world.metrics, choices: report.decisions.map(t => ({ action: t.title, confidence: t.confidence, latencyMs: t.latencyMs, receipt: t.receipt })), errors: report.errors }));
  }
  await request.post('/api/control', { data: { type: 'pause', paused: true } });
});

test('Jev autonomy: moves and finishes useful activities without any user instruction', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('model-mode')).toHaveText('Jev 实时模式');
  const before = await state(request);
  expect(before.intent).toBeNull();
  await expect.poll(async () => {
    const world = await state(request);
    expect(world.messages.some(m => m.role === 'user')).toBe(false);
    return world.outcomes.length >= 2 && world.outcomes.some(o => o.action === 'drink');
  }, { timeout: 40000, intervals: [500, 1000] }).toBe(true);
  const world = await state(request);
  expect(world.agent.position).not.toEqual(before.agent.position);
  expect(world.agent.needs.hydration).toBeGreaterThan(before.agent.needs.hydration + 25);
  expect(world.outcomes.every(o => o.requestId === null)).toBe(true);
  expect(world.traces.some(t => t.title.startsWith('到达：'))).toBe(true);
  expect(world.traces.some(t => t.source === 'demo')).toBe(false);
  const starts = world.traces.filter(t => t.kind === 'decision').map(t => t.requestedAt!);
  for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1000);
  expect(world.scheduler.ticks).toBeGreaterThan(world.metrics.jevCalls);
  expect(world.metrics.jevCalls).toBeLessThanOrEqual(world.metrics.started + 3);
  await expect(page.getByTestId('completed-actions')).toHaveText(String(world.metrics.completed));
  await expect(page.getByTestId('decision-cadence')).toContainText('每 1 秒');
  mkdirSync('test-results/live-integration', { recursive: true });
  await page.screenshot({ path: 'test-results/live-integration/autonomous-home.png', fullPage: true });
});

test('Jev recovery: depleted needs recover through real decisions and completed actions', async ({ request }) => {
  // Use a separate in-memory world, without inventing user instructions or exposing
  // a state-mutation endpoint in the product. The same production scheduler is used.
  await request.post('/api/control', { data: { type: 'pause', paused: true } });
  const config = loadRuntimeConfig({ appDirectory: process.cwd(), defaultPort: 3102 });
  const runtime = new AgentRuntime({ mode: 'live', fast: new JevProvider(config.systemOne.apiKey, config.systemOne.model, fetch, config.systemOne.baseUrl), slow: null });
  Object.assign(runtime.state.agent.needs, { hydration: 0, satiety: 2, energy: 0, happiness: 48 });
  const before = runtime.snapshot();
  runtime.speed(4); runtime.start();
  let result = 'failed';
  try {
    await expect.poll(() => {
      const world = runtime.snapshot();
      expect(world.error).toBeNull();
      expect(world.metrics.jevCalls).toBeLessThan(15);
      const actions = new Set(world.outcomes.map(o => o.action));
      return ['drink', 'eat', 'sleep'].every(a => actions.has(a as 'drink' | 'eat' | 'sleep'));
    }, { timeout: 45000, intervals: [500, 1000] }).toBe(true);
    const world = runtime.snapshot();
    expect(world.agent.needs.hydration).toBeGreaterThan(20);
    expect(world.agent.needs.satiety).toBeGreaterThan(20);
    expect(world.agent.needs.energy).toBeGreaterThan(20);
    expect(world.intent).toBeNull();
    expect(world.metrics.jevCalls).toBeLessThanOrEqual(world.metrics.started + 3);
    result = 'passed';
  } finally {
    runtime.stop();
    const world = runtime.snapshot();
    const report = { result, initialNeeds: before.agent.needs, finalNeeds: world.agent.needs, metrics: world.metrics, scheduler: world.scheduler, outcomes: world.outcomes, decisions: world.traces.filter(t => t.kind === 'decision'), errors: world.traces.filter(t => t.kind === 'error') };
    mkdirSync('test-results/live-integration', { recursive: true });
    writeFileSync('test-results/live-integration/depleted-recovery.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
});

test('Jev action: a real UI instruction completes drinking with physical effects', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('model-mode')).toHaveText('Jev 实时模式');
  await expect(page.locator('canvas')).toHaveCount(1);
  const field = page.getByRole('textbox', { name: '给 Milo 发消息' });
  const before = await state(request);
  await field.fill('请现在去厨房喝一杯水。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(field).toHaveValue('');
  await expect.poll(async () => {
    const world = await state(request);
    return world.outcomes.some(o => o.action === 'drink' && o.requestId === world.intent?.id);
  }, { timeout: 35000, intervals: [300, 500, 1000] }).toBe(true);
  const world = await state(request);
  expect(world.agent.needs.hydration).toBeGreaterThan(before.agent.needs.hydration + 25);
  expect(world.traces.some(t => t.kind === 'decision' && t.source === 'jev' && t.receipt?.status === 200)).toBe(true);
  expect(world.traces.some(t => t.source === 'demo')).toBe(false);
});

test('Jev slow thinking: an open question calls DeepSeek and displays its accepted answer', async ({ page, request }) => {
  await request.post('/api/control', { data: { type: 'pause', paused: true } });
  await page.goto('/');
  const field = page.getByRole('textbox', { name: '给 Milo 发消息' });
  await field.fill('和我聊聊：如果安排一天的生活，你会怎样平衡工作和休息？请用一两句话说明理由，先不要执行动作。');
  await field.press('Enter');
  await expect(field).toHaveValue('');
  await page.getByRole('button', { name: '继续世界', exact: true }).click();
  await expect.poll(async () => {
    const world = await state(request);
    return Boolean(world.reflection?.source === 'llm' && world.reflection.accepted && world.reflection.receipt?.status === 200);
  }, { timeout: 45000, intervals: [300, 500, 1000] }).toBe(true);
  const world = await state(request);
  expect(world.metrics.llmCalls).toBeGreaterThan(0);
  expect(world.metrics.started).toBe(0);
  expect(world.outcomes).toEqual([]);
  expect(world.agent.action).toBeNull();
  expect(world.reflection?.reply.trim().length).toBeGreaterThan(8);
  expect(world.messages.some(m => m.role === 'agent' && m.text === world.reflection?.reply)).toBe(true);
  const trigger = world.traces.findIndex(t => t.title === '快系统发起慢思考');
  const returned = world.traces.findIndex(t => t.title === '慢思考建议已返回' && t.receipt?.status === 200);
  expect(trigger).toBeGreaterThanOrEqual(0); expect(returned).toBeGreaterThan(trigger);
  await page.getByRole('tab', { name: '思考', exact: true }).click();
  await expect(page.getByText('快系统采纳了慢思考建议', { exact: true }).first()).toBeVisible();
  mkdirSync('test-results/live-integration', { recursive: true });
  await page.screenshot({ path: 'test-results/live-integration/live-home.png', fullPage: true });
});

test('Jev sequence: ordered actions finish and a new stop command interrupts sleep', async ({ page, request }) => {
  await page.goto('/');
  const field = page.getByRole('textbox', { name: '给 Milo 发消息' });
  await field.fill('请先喝一杯水，再给植物浇水，按这个顺序做。');
  await field.press('Enter');
  await expect.poll(async () => {
    const world = await state(request);
    return world.outcomes.filter(o => o.requestId === world.intent?.id).map(o => o.action);
  }, { timeout: 35000, intervals: [300, 500, 1000] }).toEqual(['drink', 'water']);
  expect((await state(request)).objects.plantMoisture).toBeGreaterThan(90);
  await field.fill('现在去卧室睡一会儿。'); await field.press('Enter');
  await expect.poll(async () => (await state(request)).agent.action?.id).toBe('sleep');
  const sleepRequest = (await state(request)).intent?.id;
  await field.fill('立即停止当前动作，站在原地等我。'); await field.press('Enter');
  await expect.poll(async () => (await state(request)).agent.action).toBeNull();
  const world = await state(request);
  expect(world.traces.some(t => t.title === '中断：睡一会儿')).toBe(true);
  expect(world.outcomes.some(o => o.action === 'sleep' && o.requestId === sleepRequest)).toBe(false);
});
