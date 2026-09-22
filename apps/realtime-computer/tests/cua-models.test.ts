import test from 'node:test';
import assert from 'node:assert/strict';
import type { DecisionContext } from '@realtime-agent/agent';
import type { RuntimeConfig } from '@realtime-agent/config';
import { createComputerProviders } from '../server/cua-models.js';
import { installedToolSubset } from './cua-fixture.js';

const tools = await installedToolSubset(['list_apps', 'list_windows', 'get_window_state', 'click', 'type_text', 'hotkey']);
const fastKey = 'fixture-fast-secret';
const slowKey = 'fixture-slow-secret';
const config: RuntimeConfig = { provider: 'direct', mode: 'live', port: 3110, dataDirectory: 'unused',
  systemOne: { apiKey: fastKey, model: 'fixture-fast-model', baseUrl: 'https://fixture.invalid/v1' },
  llm: { apiKey: slowKey, model: 'fixture-slow-model', baseUrl: 'https://fixture.invalid/v1' } };

function context(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return { scope: { epoch: 'test', turnId: 'turn-1', revision: 1 }, input: null, previousTurns: [],
    observation: { task: { id: 'task-1', text: 'Use Notepad', status: 'active' }, desktop: { id: 'desktop-1', windows: [], activeWindowId: null, summary: '' },
      evidence: [], recentActions: [], lastError: null, refreshing: false },
    candidates: [{ id: 'wait', description: 'Wait', selection: { kind: 'wait' } }], currentAction: null, receipts: [],
    proposal: null, thinking: false, slowThinkingAvailable: true,
    channels: { computer: { mode: 'async', blocksCompletion: true, current: null, receipts: [], candidates: [
      { id: 'wait', description: 'Wait', selection: { kind: 'wait' } },
    ] } }, ...overrides };
}

function proposal(plan: unknown) {
  return { id: 'proposal-1', createdAt: Date.now(), expiresAt: Date.now() + 10000, accepted: false,
    scope: { epoch: 'test', turnId: 'turn-1', revision: 1 }, value: { summary: 'fixture plan', suggestions: [], metadata: { taskId: 'task-1', plan } } } as any;
}

function systemOneReply(choice: string, model = 'fixture-fast-response', criteria: readonly string[] = [choice]) {
  return Response.json({ model, answers: { next_step: { type: 'choice', choice, confidence: 1,
    probabilities: Object.fromEntries(criteria.map(id => [id, id === choice ? 1 : 0])) } },
    usage: { input_tokens: 12, output_tokens: 2 } });
}

function llmReply(plan: unknown, model = 'fixture-planner') {
  return Response.json({ model, choices: [{ message: { content: JSON.stringify(plan) } }], usage: { prompt_tokens: 20, completion_tokens: 8 } });
}

test('System One maps plan, review, execute and finish without treating completion proposal as device completion', async () => {
  const seenCriteria: string[][] = [];
  const choices = ['plan', 'accept_plan', 'execute_0', 'finish'];
  let call = 0;
  const providers = createComputerProviders(config, { tools, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const criteria = Object.keys(body.questions.next_step.criteria); seenCriteria.push(criteria);
    const selected = choices[call++]; assert.ok(criteria.includes(selected)); return systemOneReply(selected, 'fixture-fast-response', criteria);
  } });

  const planDecision = await providers.fast.decide(context(), new AbortController().signal);
  assert.equal(planDecision.think, true); assert.equal(planDecision.acceptProposal, false); assert.equal((planDecision.metadata as any).route, 'plan');

  const actionPlan = { summary: 'inspect', steps: [{ tool: 'list_windows', arguments: {}, purpose: 'inspect windows' }], completion: null, blocked: null };
  const review = await providers.fast.decide(context({ proposal: proposal(actionPlan) }), new AbortController().signal);
  assert.equal(review.acceptProposal, true); assert.equal(review.complete, false); assert.equal((review.metadata as any).route, 'accept_plan');

  const boundCall = { capability: 'cua_tool', target: 'list_windows', input: { segment: 'p', index: 0, step: actionPlan.steps[0] } };
  const executeContext = context({ channels: { computer: { mode: 'async', blocksCompletion: true, current: null, receipts: [], candidates: [
    { id: 'wait', description: 'Wait', selection: { kind: 'wait' } }, { id: 'next', description: 'inspect', selection: { kind: 'execute', call: boundCall } },
  ] } } });
  const execute = await providers.fast.decide(executeContext, new AbortController().signal);
  assert.deepEqual(execute.channels?.computer, { kind: 'execute', call: boundCall }); assert.equal(execute.complete, false);

  const completionPlan = { summary: 'done', steps: [], completion: { summary: 'verified', checks: [
    { evidenceId: 'e1', pointer: '/value', operator: 'equals', expected: 'done', description: 'real evidence' },
  ] }, blocked: null };
  const finish = await providers.fast.decide(context({ proposal: proposal(completionPlan) }), new AbortController().signal);
  assert.equal(finish.acceptProposal, true); assert.equal(finish.complete, true); assert.equal((finish.metadata as any).route, 'finish');
  assert.deepEqual(seenCriteria.map(keys => keys.sort()), [
    ['plan'], ['accept_plan', 'reject_plan'].sort(), ['execute_0', 'replan'].sort(), ['finish', 'reject_plan'].sort(),
  ]);
});

test('vision request carries image URL and evidenceId; auto retries once without image and marks vision unavailable for 400/415/422', async () => {
  for (const status of [400, 415, 422]) {
    const bodies: any[] = [];
    const providers = createComputerProviders(config, { tools, allowImageFallback: true,
      image: () => ({ mimeType: 'image/png', dataBase64: 'ZmFrZS1wbmc=', evidenceId: 'image-evidence-7' }),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        if (bodies.length === 1) return new Response('image unsupported', { status });
        return llmReply({ summary: 'token action', steps: [{ tool: 'click', arguments: { target: { kind: 'window', pid: 42, window_id: 7 }, element_token: 'token-1' }, purpose: 'click token' }], completion: null, blocked: null });
      } });
    const result = await providers.slow.think(context(), new AbortController().signal);
    assert.equal(bodies.length, 2);
    const first = bodies[0].messages[1].content; assert.ok(Array.isArray(first));
    assert.match(first[0].text, /image-evidence-7/); assert.equal(first[1].image_url.url, 'data:image/png;base64,ZmFrZS1wbmc=');
    assert.equal(typeof bodies[1].messages[1].content, 'string'); assert.match(bodies[1].messages[1].content, /accessibility data only/);
    assert.equal((result.metadata as any).perception, 'accessibility'); assert.deepEqual(providers.capabilities?.(), { vision: 'unavailable' });
  }
});

test('required vision never falls back on image rejection', async () => {
  let calls = 0;
  const providers = createComputerProviders(config, { tools, allowImageFallback: false,
    image: () => ({ mimeType: 'image/png', dataBase64: 'ZmFrZQ==', evidenceId: 'required-image' }),
    fetch: async () => { calls++; return new Response('unsupported image', { status: 415 }); } });
  await assert.rejects(providers.slow.think(context(), new AbortController().signal), error => (error as any).code === 'http_415');
  assert.equal(calls, 1); assert.deepEqual(providers.capabilities?.(), { vision: 'enabled' });
});

test('without image input pixel clicks are rejected while semantic tokens remain allowed', async () => {
  const pixel = createComputerProviders(config, { tools, fetch: async () => llmReply({ summary: 'pixel', steps: [
    { tool: 'click', arguments: { target: { kind: 'window', pid: 42, window_id: 7 }, x: 12, y: 24 }, purpose: 'guess coordinate' },
  ], completion: null, blocked: null }) });
  await assert.rejects(pixel.slow.think(context(), new AbortController().signal), error =>
    (error as any).code === 'invalid_plan' && String((error as Error).message).includes('不要猜测像素坐标'));

  const token = createComputerProviders(config, { tools, fetch: async () => llmReply({ summary: 'semantic', steps: [
    { tool: 'click', arguments: { target: { kind: 'window', pid: 42, window_id: 7 }, element_token: 'real-token' }, purpose: 'semantic click' },
  ], completion: null, blocked: null }) });
  const result = await token.slow.think(context(), new AbortController().signal);
  assert.equal((result.metadata as any).plan.steps[0].arguments.element_token, 'real-token'); assert.deepEqual(token.capabilities?.(), { vision: 'off' });
});

test('invalid planner JSON reports concrete schema feedback and response metadata never exposes configured credentials', async () => {
  const invalid = createComputerProviders(config, { tools, fetch: async () => llmReply({ summary: 'bad', steps: [{ tool: 'click', arguments: {} }], completion: null, blocked: null }, slowKey) });
  await assert.rejects(invalid.slow.think(context(), new AbortController().signal), error => {
    const value = error as Error & { code?: string };
    return value.code === 'invalid_plan' && /purpose|steps/.test(value.message) && !value.message.includes(slowKey);
  });

  const safe = createComputerProviders(config, { tools, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(String(init?.body).includes(slowKey), false); assert.equal(String(init?.body).includes(fastKey), false);
    if (body.questions) return systemOneReply('plan', `model-${fastKey}`, Object.keys(body.questions.next_step.criteria));
    return llmReply({ summary: 'safe', steps: [{ tool: 'list_windows', arguments: {}, purpose: 'inspect' }], completion: null, blocked: null }, `model-${slowKey}`);
  } });
  const slow = await safe.slow.think(context(), new AbortController().signal);
  assert.equal(JSON.stringify(slow).includes(slowKey), false); assert.equal((slow.metadata as any).receipt.model, null);
  const fast = await safe.fast.decide(context(), new AbortController().signal);
  assert.equal(JSON.stringify(fast).includes(fastKey), false, 'System One response metadata leaked the configured API key.');
});

test('visual completion is rejected without the exact supplied image evidence and records imageEvidenceId only for the matching screenshot', async () => {
  const visual = (evidenceId: string) => ({ summary: 'visual finish', steps: [], blocked: null,
    completion: { summary: 'visual result verified', checks: [], visual: { evidenceId, description: 'The requested visual state is present.' } } });

  const noImage = createComputerProviders(config, { tools, fetch: async () => llmReply(visual('image-1')) });
  await assert.rejects(noImage.slow.think(context(), new AbortController().signal), error =>
    (error as any).code === 'invalid_plan' && String((error as Error).message).includes('视觉完成判断必须引用本次实际提供的截图'));

  const wrongImage = createComputerProviders(config, { tools,
    image: () => ({ mimeType: 'image/png', dataBase64: 'ZmFrZQ==', evidenceId: 'image-actual' }),
    fetch: async () => llmReply(visual('image-wrong')) });
  await assert.rejects(wrongImage.slow.think(context(), new AbortController().signal), error =>
    (error as any).code === 'invalid_plan' && String((error as Error).message).includes('视觉完成判断必须引用本次实际提供的截图'));

  const matching = createComputerProviders(config, { tools,
    image: () => ({ mimeType: 'image/png', dataBase64: 'ZmFrZQ==', evidenceId: 'image-actual' }),
    fetch: async () => llmReply(visual('image-actual')) });
  const proposal = await matching.slow.think(context(), new AbortController().signal);
  assert.equal((proposal.metadata as any).imageEvidenceId, 'image-actual');
  assert.equal((proposal.metadata as any).plan.completion.visual.evidenceId, 'image-actual');
  assert.equal((proposal.metadata as any).perception, 'vision');

  const dataOnly = createComputerProviders(config, { tools, fetch: async () => llmReply({ summary: 'data plan', steps: [
    { tool: 'list_windows', arguments: {}, purpose: 'observe' },
  ], completion: null, blocked: null }) });
  const dataProposal = await dataOnly.slow.think(context(), new AbortController().signal);
  assert.equal(Object.hasOwn(dataProposal.metadata as object, 'imageEvidenceId'), false);
});
