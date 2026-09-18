import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Choice, RealtimeTurn, WorldState } from '../../shared/types';

// Acceptance budgets for these bounded samples, not a provider latency guarantee.
const ACTION_BUDGET_MS = 3000;
const REPLY_BUDGET_MS = 5000;
const samples: { text: string; turnId: string; browserObservedMs: number; serverReactionMs: number | null; serverReplyMs: number | null }[] = [];

async function world(request: APIRequestContext): Promise<WorldState> {
  const response = await request.get('/api/state');
  expect(response.ok()).toBe(true);
  const state = await response.json() as WorldState;
  expect(state.mode).toBe('live');
  expect(state.metrics.jevCalls).toBeLessThan(35);
  expect(state.metrics.llmCalls).toBeLessThan(6);
  expect(state.error).toBeNull();
  return state;
}
async function send(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: '给 Milo 发消息' });
  await input.fill(text);
  const at = await page.evaluate(() => performance.now());
  await input.press('Enter');
  return at;
}
async function observe(page: Page, request: APIRequestContext, text: string, started: number, action?: Choice): Promise<RealtimeTurn> {
  let observed: RealtimeTurn | undefined;
  await expect.poll(async () => {
    const state = await world(request);
    if (state.intent?.text !== text) return false;
    observed = state.turns.find(t => t.id === state.intent!.id);
    if (action) return observed?.appliedAt != null && observed.appliedAction === action && (action === 'idle' ? !state.agent.action : state.agent.action?.id === action);
    return observed?.replyAt != null && state.messages.some(m => m.role === 'agent' && m.turnId === observed!.id);
  }, { timeout: action ? 8000 : 12000, intervals: [50, 100] }).toBe(true);
  // Wait for this turn's SSE snapshot to reach the page, not a still-visible older label.
  await expect(page.getByTestId('realtime-status')).toHaveAttribute('data-turn-id', observed!.id);
  await expect(page.getByTestId('reaction-latency')).toContainText(`行为响应 ${((observed!.appliedAt! - observed!.receivedAt) / 1000).toFixed(2)} 秒`);
  if (!action) await expect(page.getByTestId('reaction-latency')).toContainText(`回复 ${((observed!.replyAt! - observed!.receivedAt) / 1000).toFixed(2)} 秒`);
  const sample = {
    text, turnId: observed!.id,
    browserObservedMs: Math.round(await page.evaluate(() => performance.now()) - started),
    serverReactionMs: observed!.appliedAt == null ? null : observed!.appliedAt - observed!.receivedAt,
    serverReplyMs: observed!.replyAt == null ? null : observed!.replyAt - observed!.receivedAt,
  };
  samples.push(sample);
  expect(action ? sample.serverReactionMs : sample.serverReplyMs).not.toBeNull();
  expect(action ? sample.serverReactionMs! : sample.serverReplyMs!).toBeLessThan(action ? ACTION_BUDGET_MS : REPLY_BUDGET_MS);
  return observed!;
}

test.beforeEach(async ({ page, request }) => {
  samples.length = 0;
  expect((await (await request.get('/api/health')).json()).mode).toBe('live');
  await request.post('/api/control', { data: { type: 'reset' } });
  // Real-time interaction is evaluated at 1×, never accelerated to shorten action timings.
  await request.post('/api/control', { data: { type: 'speed', speed: 1 } });
  await page.goto('/');
  await expect(page.getByTestId('model-mode')).toHaveText('Jev 实时模式');
});
test.afterEach(async ({ request }, info) => {
  const response = await request.get('/api/state');
  if (response.ok()) {
    const state = await response.json() as WorldState;
    const report = { result: info.status, test: info.title, verifiedAt: new Date().toISOString(),
      budgets: { actionMs: ACTION_BUDGET_MS, replyMs: REPLY_BUDGET_MS }, speed: state.speed,
      samples: [...samples], turns: state.turns, metrics: state.metrics, intent: state.intent,
      outcomes: state.outcomes, responses: state.traces.filter(t => t.receipt),
      events: state.traces.filter(t => t.kind === 'action' || t.kind === 'error'),
      replies: state.messages.filter(m => m.role === 'agent'),
    };
    mkdirSync('test-results/realtime', { recursive: true });
    const name = info.title.includes('redirect') ? 'redirect' : info.title.includes('conversation') ? 'conversation' : info.title.includes('alongside') ? 'alongside' : 'barge-in';
    writeFileSync(`test-results/realtime/${name}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    if (info.status !== 'passed') writeFileSync(`test-results/realtime/${name}-failed-${Date.now()}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ test: info.title, result: info.status, samples, metrics: state.metrics }));
  }
  await request.post('/api/control', { data: { type: 'pause', paused: true } });
});

test('Realtime redirect: change destination while walking, replace an interaction, then stop', async ({ page, request }) => {
  const sleep = '现在去卧室睡一会儿。';
  const first = await observe(page, request, sleep, await send(page, sleep), 'sleep');
  expect((await world(request)).agent.action?.phase).toBe('walking');

  const drink = '不睡了，现在改去厨房喝水。';
  const second = await observe(page, request, drink, await send(page, drink), 'drink');
  await expect.poll(async () => {
    const state = await world(request);
    return state.agent.action?.id === 'drink' && state.agent.action.phase === 'acting';
  }, { timeout: 15000, intervals: [50, 100] }).toBe(true);

  const read = '先别喝了，马上改去书房看书。';
  const third = await observe(page, request, read, await send(page, read), 'read');
  const stop = '停下，站在原地等我。';
  await observe(page, request, stop, await send(page, stop), 'idle');
  const state = await world(request);
  for (const id of [first.id, second.id, third.id]) expect(state.outcomes.some(o => o.requestId === id)).toBe(false);
  expect(state.metrics.interrupted).toBeGreaterThanOrEqual(3);
  expect(state.traces.filter(t => t.kind === 'decision').every(t => t.source === 'jev' && t.receipt?.status === 200)).toBe(true);
  expect(state.traces.some(t => t.source === 'demo')).toBe(false);
  const starts = state.traces.filter(t => t.kind === 'decision').map(t => t.requestedAt!);
  for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1000);
});

test('Realtime conversation: two natural replies arrive on their own turns without executing hypothetical activities', async ({ page, request }) => {
  const one = '你喜欢怎样的生活？请用一句话回答，先只聊天，不要行动。';
  const first = await observe(page, request, one, await send(page, one));
  const two = '为什么你喜欢照顾绿植？再和我聊一句，仍然不要行动。';
  const second = await observe(page, request, two, await send(page, two));
  const state = await world(request);
  for (const turn of [first, second]) {
    const reply = state.messages.find(m => m.role === 'agent' && m.turnId === turn.id);
    expect(reply?.text.length).toBeGreaterThan(5);
    expect(state.outcomes.some(o => o.requestId === turn.id)).toBe(false);
  }
  expect(state.agent.action).toBeNull();
  expect(state.traces.filter(t => t.source === 'llm' && t.receipt?.status === 200).length).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: 'test-results/realtime/live-conversation.png', fullPage: true });
});

test('Realtime barge-in: cancel a real pending LLM answer and follow the latest of consecutive corrections', async ({ page, request }) => {
  const old = '先不要行动，和我详细聊聊你对阅读、绿植和日常生活节奏的想法。';
  await send(page, old);
  await expect.poll(async () => {
    const state = await world(request);
    return state.intent?.text === old && state.thinking;
  }, { timeout: 10000, intervals: [50] }).toBe(true);
  const interrupted = (await world(request)).intent!.id;
  await send(page, '不用回答刚才的问题了，改去厨房喝水。');
  const latest = '又改主意了，先不要喝水，现在直接去看书。';
  const final = await observe(page, request, latest, await send(page, latest), 'read');
  const state = await world(request);
  expect(state.turns.find(t => t.id === interrupted)?.supersededAt).not.toBeNull();
  expect(state.turns.find(t => t.id === interrupted)?.replyAt).toBeNull();
  expect(state.messages.some(m => m.role === 'agent' && m.turnId === interrupted)).toBe(false);
  expect(state.agent.action?.requestId).toBe(final.id);
  expect(state.metrics.llmCalls).toBeGreaterThanOrEqual(1);
  expect(state.reflection?.reply ?? '').toBe('');
  expect(state.outcomes.some(o => o.requestId === interrupted)).toBe(false);
});

test('Realtime alongside: answer a compatible question while the existing activity continues without restarting', async ({ page, request }) => {
  const work = '现在去书桌前专注工作。';
  await observe(page, request, work, await send(page, work), 'work');
  const before = await world(request);
  const question = '继续手头的工作，边做边和我聊聊：你为什么喜欢看书？请用一句话回答。';
  await observe(page, request, question, await send(page, question));
  const after = await world(request);
  expect(after.agent.action?.id).toBe('work');
  expect(after.agent.action?.startedAt).toBe(before.agent.action?.startedAt);
  expect(after.metrics.started).toBe(before.metrics.started);
  expect(after.metrics.interrupted).toBe(before.metrics.interrupted);
  expect(after.agent.position).not.toEqual(before.agent.position);
});
