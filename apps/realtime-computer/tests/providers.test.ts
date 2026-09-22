import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlan, authorizedCall, goalSchema } from '../server/model.js';
import { demoProviders, liveProviders } from '../server/providers.js';
import type { DecisionContext } from '@realtime-agent/agent';
import type { RuntimeConfig } from '@realtime-agent/config';

const goal = { name: '林晓', category: 'work' as const, note: '复核资料' };
const context: DecisionContext = { scope: { epoch: 'session', turnId: 'turn', revision: 1 }, input: null, previousTurns: [],
  observation: { task: { id: 'task', version: 1, goal, status: 'active', plan: null } }, candidates: [], currentAction: null, receipts: [],
  proposal: null, thinking: false, slowThinkingAvailable: true, channels: { computer: { mode: 'async', blocksCompletion: true, current: null, receipts: [], candidates: [] } } };
const config: RuntimeConfig = { provider: 'direct', mode: 'live', port: 3110, dataDirectory: 'unused',
  systemOne: { apiKey: 'fixture-fast-key', model: 'fixture', baseUrl: 'https://example.test/v1' },
  llm: { apiKey: 'fixture-slow-key', model: 'fixture', baseUrl: 'https://example.test/v1' } };

test('capability parameters are restricted to the exact explicit form goal', () => {
  assert.ok(defaultPlan(goal).every(call => authorizedCall(call, goal)));
  assert.equal(authorizedCall({ capability: 'fill', target: 'name', input: { value: 'Different' } }, goal), false);
  assert.equal(authorizedCall({ capability: 'fill', target: 'name', input: { value: goal.name, script: 'not-executable' } }, goal), false);
  assert.equal(authorizedCall({ capability: 'click', target: 'outside' }, goal), false);
  assert.throws(() => goalSchema.parse({ ...goal, url: 'https://example.test' }));
});
test('demo uses an explicit local plan and keeps planning separate from device execution', async () => {
  const providers = demoProviders({ thoughtDelayMs: 1 });
  const decision = await providers.fast.decide(context, new AbortController().signal);
  assert.equal(decision.think, true); assert.equal(decision.channels?.computer.kind, 'wait');
  const plan = await providers.slow.think(context, new AbortController().signal);
  assert.deepEqual(plan.suggestions, defaultPlan(goal)); assert.equal((plan.metadata as { source: string }).source, 'demo');
  const expiredContext = structuredClone(context);
  expiredContext.observation = { task: { id: 'task', version: 1, goal, status: 'active',
    plan: { accepted: true, expired: true, completedSteps: [], steps: [{}] } } };
  assert.equal((await providers.fast.decide(expiredContext, new AbortController().signal)).think, true);
});
test('live planning uses the configured transport and validates proposal values without exposing private response fields', async () => {
  let calls = 0;
  const providers = liveProviders(config, async (url, init) => {
    calls++; assert.equal(String(url), 'https://example.test/v1/chat/completions');
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'fixture'); assert.equal(body.stream, false);
    assert.equal(String(init?.body).includes('fixture-slow-key'), false);
    return Response.json({ model: 'fixture-slow-model', id: 'completion-fixture', usage: { prompt_tokens: 21, completion_tokens: 7 },
      choices: [{ message: { reasoning_content: 'not-public', content: JSON.stringify({ summary: '填写并保存', suggestions: defaultPlan(goal) }) } }] },
    { headers: { 'x-request-id': 'req-slow-fixture' } });
  });
  const proposal = await providers.slow.think(context, new AbortController().signal);
  assert.equal(calls, 1); assert.deepEqual(proposal.suggestions, defaultPlan(goal)); assert.equal(JSON.stringify(proposal).includes('not-public'), false);
  assert.deepEqual((proposal.metadata as { receipt: unknown }).receipt,
    { status: 200, model: 'fixture-slow-model', requestId: 'req-slow-fixture', inputTokens: 21, outputTokens: 7 });
  const invalid = liveProviders(config, async () => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: '替换姓名', suggestions: [{ capability: 'fill', target: 'name', input: { value: 'unauthorized' } }] }) } }] }));
  await assert.rejects(invalid.slow.think(context, new AbortController().signal), { code: 'invalid_plan' });
});
test('live fast decisions use System One while device calls remain bound to offered computer candidates', async () => {
  const fill = defaultPlan(goal)[0];
  const fastContext: DecisionContext = { ...context,
    candidates: [{ id: 'wait', description: 'Wait', selection: { kind: 'wait' } }],
    channels: { computer: { mode: 'async', blocksCompletion: true, current: null, receipts: [], candidates: [
      { id: 'wait', description: 'Wait', selection: { kind: 'wait' } },
      { id: 'fill-name', description: 'Fill the exact approved name', selection: { kind: 'execute', call: fill } },
    ] } },
  };
  let calls = 0;
  const providers = liveProviders(config, async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'fixture');
    assert.equal(body.questions.channel_computer.criteria['fill-name'], 'Fill the exact approved name');
    return Response.json({ model: 'fixture', answers: {
      action: { type: 'choice', choice: 'wait', confidence: 1, probabilities: { wait: 1 } },
      interrupt: { type: 'noul', noul: 0 }, think: { type: 'noul', noul: 0 }, request_complete: { type: 'noul', noul: 0 },
      accept_reflection: { type: 'choice', choice: 'reject', probabilities: { accept: 0, reject: 1 } },
      channel_computer: { type: 'choice', choice: 'fill-name', probabilities: { wait: 0, 'fill-name': 1 } },
    }, usage: { input_tokens: 8, output_tokens: 4 } });
  });
  const decision = await providers.fast.decide(fastContext, new AbortController().signal);
  assert.equal(calls, 1); assert.deepEqual(decision.channels?.computer, { kind: 'execute', call: fill });
});
test('provider failures remain failures and cancellation closes a streaming response', async () => {
  const invalid = liveProviders(config, async () => new Response('echo-private-key', { status: 429 }));
  await assert.rejects(invalid.slow.think(context, new AbortController().signal), error => String(error).includes('HTTP 429') && !String(error).includes('echo-private'));
  let cancelled = false, ready!: () => void;
  const responseReady = new Promise<void>(resolve => { ready = resolve; });
  const streaming = liveProviders(config, async () => { ready(); return new Response(new ReadableStream({ cancel() { cancelled = true; } })); });
  const controller = new AbortController(), pending = streaming.slow.think(context, controller.signal);
  await responseReady; await Promise.resolve(); controller.abort();
  await assert.rejects(pending); assert.equal(cancelled, true);
});
