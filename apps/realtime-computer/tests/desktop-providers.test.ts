import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopProviders } from '../server/desktop-providers.js';
import type { DecisionContext } from '@realtime-agent/agent';
import type { RuntimeConfig } from '@realtime-agent/config';

const config: RuntimeConfig = { provider: 'direct', mode: 'live', port: 3110, dataDirectory: 'unused',
  systemOne: { apiKey: 'fixture-fast-key', model: 'fixture', baseUrl: 'https://example.test/v1' },
  llm: { apiKey: 'fixture-slow-key', model: 'fixture', baseUrl: 'https://example.test/v1' } };
const context: DecisionContext = { scope: { epoch: 'test', turnId: 'turn', revision: 1 }, input: null, previousTurns: [],
  observation: { task: { id: 'task', text: '写下hello', windowId: '99', status: 'active', steps: 0 },
    desktop: { id: 'desktop-1', selectedWindowId: '99', elements: [{ id: 'editor', role: 'Edit', name: 'Editor' }] }, planPending: false, lastResult: null },
  candidates: [{ id: 'wait', description: 'Wait', selection: { kind: 'wait' } }], currentAction: null, receipts: [],
  proposal: null, thinking: false, slowThinkingAvailable: true };
const reply = (plan: unknown) => Response.json({ model: 'fixture-planner', usage: { prompt_tokens: 10, completion_tokens: 5 },
  choices: [{ message: { content: JSON.stringify(plan) } }] });

test('desktop planner receives real-window semantics and returns only a proposal bound to the observed task', async () => {
  let calls = 0;
  const providers = desktopProviders(config, { fetch: async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    assert.ok(body.messages[0].content.includes('REAL Windows'));
    assert.equal(body.messages[1].content.includes('fixture-slow-key'), false);
    assert.equal(JSON.parse(body.messages[1].content).desktop.selectedWindowId, '99');
    return reply({ summary: 'Write in the editor', actions: [{ kind: 'click', elementId: 'editor' }, { kind: 'type', text: 'hello' }],
      verification: { elementId: 'editor', text: 'hello', match: 'contains' } });
  } });
  const proposal = await providers.slow.think(context, new AbortController().signal);
  assert.equal(calls, 1); assert.deepEqual(proposal.suggestions, []);
  assert.equal((proposal.metadata as { taskId: string }).taskId, 'task');
  assert.equal((proposal.metadata as { observationId: string }).observationId, 'desktop-1');
});

test('text-only desktop planning cannot invent screenshot coordinates or shell capabilities', async () => {
  for (const actions of [[{ kind: 'click_position', x: 20, y: 30 }], [{ kind: 'shell', command: 'not-allowed' }]]) {
    const providers = desktopProviders(config, { fetch: async () => reply({ summary: 'Unbound', actions, verification: null }) });
    await assert.rejects(providers.slow.think(context, new AbortController().signal));
  }
});

test('explicit vision mode passes screenshot bounds with pixels and still validates structured native actions', async () => {
  let images = 0;
  const providers = desktopProviders(config, { screenshot: async windowId => {
    images++; assert.equal(windowId, '99'); return { png: Buffer.from('fixture-image'), bounds: { x: -400, y: 10, width: 500, height: 400 }, capturedAt: Date.now() };
  }, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(JSON.parse(body.messages[1].content[0].text).screenshot.bounds.x, -400);
    assert.ok(body.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'));
    return reply({ summary: 'Click observed point', actions: [{ kind: 'click_position', x: -300, y: 60 }], verification: null });
  } });
  const result = await providers.slow.think(context, new AbortController().signal);
  assert.equal(images, 1); assert.equal((result.metadata as any).plan.actions[0].kind, 'click_position');
});

test('provider HTTP failure does not switch desktop automation to a fake local task plan', async () => {
  const providers = desktopProviders(config, { fetch: async () => new Response('secret-in-upstream-error', { status: 429 }) });
  await assert.rejects(providers.slow.think(context, new AbortController().signal), error =>
    (error as { code: string }).code === 'http_429' && !String(error).includes('secret-in-upstream-error'));
});
