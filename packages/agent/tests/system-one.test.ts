import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemOne } from '@system-one-ai/sdk';
import { cloudflareAdapter } from '@system-one-ai/sdk/adapters/cloudflare';
import { AgentError } from '../src/index.js';
import { SystemOneDecisionPolicy } from '../src/system-one.js';
import { deferred, room } from './fixture.js';

function wire(choices: string[], action = 'move:bed') {
  return { model: 'jev-1.13.0', answers: {
    action: { type: 'choice', choice: action, confidence: 0.6, probabilities: Object.fromEntries(choices.map(id => [id, id === action ? 1 : 0])) },
    interrupt: { type: 'noul', noul: 0.9 }, think: { type: 'noul', noul: 0.3 }, request_complete: { type: 'noul', noul: 0 },
    accept_reflection: { type: 'choice', choice: 'reject', probabilities: { accept: 0, reject: 1 } },
  }, usage: { input_tokens: 200, output_tokens: 80 } };
}

test('published SDK owns Cloudflare envelopes; a single choice binds capability and target', async () => {
  const f = room(), candidates = f.candidates(); let requests = 0;
  const client = new SystemOne({ adapter: cloudflareAdapter({ accountId: '0123456789abcdef0123456789abcdef' }), apiKey: 'fixture-token',
    fetch: async (url, init) => {
      requests++; assert.equal(String(url).endsWith('/ai/run'), true);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'typesafe/jev'); assert.equal(body.input.questions.interrupt.type, 'noul');
      assert.equal(body.input.questions.target, undefined); // No unrelated action/target pair.
      assert.equal(body.input.questions.action.criteria['move:bed'], 'Move to bed');
      return Response.json({ success: true, result: { state: 'Completed', result: wire(candidates.map(c => c.id)) }, errors: [] });
    } });
  const result = await new SystemOneDecisionPolicy(client).evaluate({ state: { text: 'Go to the bed' }, candidates }, new AbortController().signal);
  assert.deepEqual(result.decision.selection, { kind: 'execute', call: { capability: 'move_to', target: 'bed' } });
  assert.equal(result.confidence, 0.6); assert.equal(result.inputTokens, 200); assert.equal(result.thinkProbability, 0.3);
  assert.equal(result.decision.think, false); assert.equal(result.status, 200); assert.equal(requests, 1);
});

test('the candidate mapping is snapshotted before awaiting the SDK', async () => {
  const candidates = room().candidates(), response = deferred<Response>();
  const policy = new SystemOneDecisionPolicy(new SystemOne({ apiKey: null, fetch: () => response.promise }));
  const pending = policy.evaluate({ state: {}, candidates }, new AbortController().signal);
  const target = candidates.find(candidate => candidate.id === 'move:bed')!;
  if (target.selection.kind === 'execute') target.selection.call.target = 'forged';
  response.resolve(Response.json(wire(candidates.map(c => c.id))));
  assert.deepEqual((await pending).decision.selection, { kind: 'execute', call: { capability: 'move_to', target: 'bed' } });
});

test('SDK invalid decisions fail closed; HTTP retries remain the Agent scheduler responsibility', async () => {
  const candidates = room().candidates(); let requests = 0;
  const failed = new SystemOneDecisionPolicy(new SystemOne({ apiKey: null, fetch: async () => {
    requests++; return new Response('echo-private-secret', { status: 429, headers: { 'retry-after': '12' } });
  } }));
  await assert.rejects(failed.evaluate({ state: {}, candidates }, new AbortController().signal), error =>
    error instanceof AgentError && error.code === 'http_429' && error.retryAfterMs === 12000 && !error.message.includes('private-secret'));
  assert.equal(requests, 1);
  const invalid = new SystemOneDecisionPolicy(new SystemOne({ apiKey: null, fetch: async () => Response.json(wire(candidates.map(c => c.id), 'teleport')) }));
  await assert.rejects(invalid.evaluate({ state: {}, candidates }, new AbortController().signal), error => error instanceof AgentError && error.code === 'response');
});

test('cancellation goes into the SDK and cannot return an executable selection', async () => {
  const ready = deferred<void>(), candidates = room().candidates(); let requestSignal: AbortSignal | null | undefined;
  const policy = new SystemOneDecisionPolicy(new SystemOne({ apiKey: null, fetch: async (_url, init) => {
    requestSignal = init?.signal; ready.resolve(); return new Promise<Response>(() => {});
  } }));
  const abort = new AbortController();
  const pending = policy.evaluate({ state: {}, candidates }, abort.signal);
  await ready.promise; abort.abort();
  await assert.rejects(pending); assert.equal(requestSignal?.aborted, true);
});

test('the SDK speech choice binds a snapshotted output call alongside the body choice', async () => {
  const candidates = room().candidates(), response = deferred<Response>();
  const output = { instructions: 'Choose speech', candidates: [
    { id: 'silent', description: 'Silent', selection: { kind: 'wait' as const } },
    { id: 'speak:proposal-1', description: 'Say hello', selection: { kind: 'execute' as const, call: { capability: 'speak', target: 'proposal-1', input: { text: 'Hello.' } } } },
  ] };
  const policy = new SystemOneDecisionPolicy(new SystemOne({ apiKey: null, fetch: (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).questions.speech.criteria['speak:proposal-1'], 'Say hello'); return response.promise;
  } }));
  const pending = policy.evaluate({ state: {}, candidates, output }, new AbortController().signal);
  output.candidates[1].selection.call!.input.text = 'Changed after request';
  const result = wire(candidates.map(c => c.id));
  response.resolve(Response.json({ ...result, answers: { ...result.answers, speech: { type: 'choice', choice: 'speak:proposal-1' } } }));
  assert.deepEqual((await pending).decision.output, { kind: 'execute', call: { capability: 'speak', target: 'proposal-1', input: { text: 'Hello.' } } });
});
