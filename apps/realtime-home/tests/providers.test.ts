import { describe, expect, it } from 'vitest';
import { JevProvider, LanguageModelProvider, ProviderError } from '../server/providers';
import { AgentRuntime } from '../server/runtime';
import { DemoFastProvider } from '../server/providers';
import { candidatesFor } from '../shared/world';

function context() {
  const runtime = new AgentRuntime({ mode: 'demo', fast: new DemoFastProvider(), slow: null });
  return { state: runtime.snapshot(), candidates: candidatesFor(runtime.state) };
}
function response() {
  const c = context();
  return { answers: { action: { type: 'choice', choice: 'drink', confidence: 0.81, probabilities: Object.fromEntries(Object.keys(c.candidates).map(key => [key, key === 'drink' ? 0.9 : 0.1 / (Object.keys(c.candidates).length - 1)])) }, interrupt: { type: 'noul', noul: 0.7 }, think: { type: 'noul', noul: 0.2 }, request_complete: { type: 'noul', noul: 0 }, accept_reflection: { type: 'choice', choice: 'reject', confidence: 0.9, probabilities: { accept: 0.1, reject: 0.9 } } } };
}
const signal = () => new AbortController().signal;
const fetchFixture = (body: unknown): typeof fetch => async () => Response.json(body);

describe('Jev official HTTP contract', () => {
  it('uses an explicit reflection verdict and validates its full distribution', async () => {
    const valid = response(); valid.answers.accept_reflection = { type: 'choice', choice: 'accept', confidence: 0.55, probabilities: { accept: 0.6, reject: 0.4 } };
    expect((await new JevProvider('test', undefined, fetchFixture(valid)).decide(context(), signal())).acceptReflection).toBe(1);
    valid.answers.accept_reflection.probabilities.reject = 0.8;
    await expect(new JevProvider('test', undefined, fetchFixture(valid)).decide(context(), signal())).rejects.toThrow('反思评估分布');
  });
  it('uses /v1/systemone with criteria maps and distinguishes confidence from probability', async () => {
    const fetcher: typeof fetch = async (url, init) => {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-only');
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe('jev-latest');
      expect(body.questions.action.type).toBe('choice');
      expect(body.questions.action.criteria.drink).toBeTruthy();
      expect(body.questions.think.type).toBe('noul');
      expect(body.questions.accept_reflection.type).toBe('choice');
      expect(body.state.availableActions).toBeTruthy();
      return Response.json(response());
    };
    const result = await new JevProvider('test-only', 'jev-latest', fetcher).decide(context(), signal());
    expect(result.action).toBe('drink'); expect(result.confidence).toBe(0.81); expect(result.probabilities.drink).toBe(0.9);
  });
  it('rejects nonexistent actions and invalid probability distributions', async () => {
    const unknown = response(); unknown.answers.action.choice = 'teleport';
    await expect(new JevProvider('test', undefined, fetchFixture(unknown)).decide(context(), signal())).rejects.toThrow(ProviderError);
    const invalid = response(); invalid.answers.action.probabilities.drink = 0.5;
    await expect(new JevProvider('test', undefined, fetchFixture(invalid)).decide(context(), signal())).rejects.toThrow(ProviderError);
  });
  it('rejects wrong typed primitives', async () => {
    await expect(new JevProvider('test', undefined, fetchFixture({ answers: { action: 'drink' } })).decide(context(), signal())).rejects.toThrow('类型校验');
  });
  it('handles rate limits without exposing provider bodies and retains retry delay', async () => {
    const fetcher: typeof fetch = async () => new Response('echoed-secret', { status: 429, headers: { 'retry-after': '12' } });
    try { await new JevProvider('test', undefined, fetcher).decide(context(), signal()); throw new Error('Expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(ProviderError); expect((error as ProviderError).retryAfterMs).toBe(12000); expect(String(error)).not.toContain('echoed-secret'); }
  });
  it('rejects oversized model responses', async () => {
    const fetcher: typeof fetch = async () => new Response('x'.repeat(140000));
    await expect(new JevProvider('test', undefined, fetcher).decide(context(), signal())).rejects.toThrow('响应过大');
  });
});

describe('slow thinker contract', () => {
  it('separates Jev runtime controls from slow action proposals and still rejects controls in returned advice', async () => {
    const runtime = new AgentRuntime({ mode: 'demo', fast: new DemoFastProvider(), slow: null });
    runtime.message('专注工作'); await runtime.decide();
    runtime.message('继续工作，边做边聊聊你为什么喜欢看书。');
    const c = { state: runtime.snapshot(), candidates: candidatesFor(runtime.state) };
    expect(c.candidates.continue).toBeTruthy();
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const observation = JSON.parse(body.messages.at(-1).content);
      expect(observation.agent.action.id).toBe('work');
      expect(observation.availableActions.work).toBeTruthy();
      expect(observation.availableActions.continue).toBeUndefined();
      expect(observation.availableActions.idle).toBeUndefined();
      return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: '边工作边回答', reply: '看书让我有机会遇见新的想法。', memories: [], suggestedActions: ['continue'] }) } }] });
    };
    await expect(new LanguageModelProvider('https://example.test/v1', 'test', 'fixture', fetcher).reflect(c, signal())).rejects.toThrow('suggestedActions:invalid_value');
  });
  it('keeps only allowed self-note fields and never trusts generated personality or goal completion', async () => {
    const content = JSON.stringify({ summary: '自己的小愿望', reply: '', suggestedActions: [], memories: [], self: {
      thought: '想慢慢阅读。', journal: '刚完成一件小事。', evidenceIds: ['actual-episode'],
      personality: { curiosity: 0 }, internalReasoning: 'not-public',
      wish: { title: '留一点阅读时间', motivation: '想满足好奇心', actions: ['read'], status: 'fulfilled', completedActions: ['read'] },
    } });
    const result = await new LanguageModelProvider('https://example.test/v1', 'test', 'fixture', fetchFixture({ choices: [{ message: { content } }] })).reflect(context(), signal());
    expect(result.self).toEqual({ thought: '想慢慢阅读。', journal: '刚完成一件小事。', evidenceIds: ['actual-episode'], wish: { title: '留一点阅读时间', motivation: '想满足好奇心', actions: ['read'] } });
    expect(JSON.stringify(result)).not.toContain('not-public');
    expect(JSON.stringify(result)).not.toContain('fulfilled');
  });
  it('accepts a conversational reply with null or omitted advisory arrays without inventing actions or memories', async () => {
    for (const advisory of [{ memories: null, suggestedActions: null }, {}]) {
      const content = JSON.stringify({ summary: '回答问题', reply: '工作间隙记得休息。', ...advisory });
      const provider = new LanguageModelProvider('https://api.deepseek.com', 'test-key', 'deepseek-flash', fetchFixture({ choices: [{ message: { content } }] }));
      expect(await provider.reflect(context(), signal())).toMatchObject({ summary: '回答问题', reply: '工作间隙记得休息。', memories: [], suggestedActions: [] });
    }
  });
  it('still rejects malformed nonempty memories and missing reply text', async () => {
    for (const result of [{ summary: '建议', reply: '回复', memories: [{ unsupported: true }] }, { summary: '建议', memories: [] }]) {
      const provider = new LanguageModelProvider('https://api.deepseek.com', 'test-key', 'deepseek-flash', fetchFixture({ choices: [{ message: { content: JSON.stringify(result) } }] }));
      await expect(provider.reflect(context(), signal())).rejects.toThrow('结构校验');
    }
  });
  it('accepts advisory JSON and disallows unknown executable actions', async () => {
    const thought = { summary: '先补水，再工作', reply: '我建议先喝水。', suggestedActions: ['drink', 'work'], memories: [] };
    const provider = new LanguageModelProvider('https://example.test/v1/', 'test', 'fixture', fetchFixture({ choices: [{ message: { content: JSON.stringify(thought) } }] }));
    expect(await provider.reflect(context(), signal())).toMatchObject({ ...thought, receipt: { status: 200 } });
    const invalid = new LanguageModelProvider('https://example.test/v1', 'test', 'fixture', fetchFixture({ choices: [{ message: { content: JSON.stringify({ ...thought, suggestedActions: ['teleport'] }) } }] }));
    await expect(invalid.reflect(context(), signal())).rejects.toThrow('结构校验');
  });
  it('uses the configured System One endpoint and preserves only response metadata', async () => {
    const fetcher: typeof fetch = async (url) => {
      expect(url).toBe('https://example.test/v1/systemone');
      return Response.json({ ...response(), model: 'jev-latest', usage: { input_tokens: 20, output_tokens: 10 }, unexpected_secret: 'not-public' }, { headers: { 'x-request-id': 'req-fixture-123' } });
    };
    const result = await new JevProvider('test-key', 'jev-latest', fetcher, 'https://example.test/v1').decide(context(), signal());
    expect(result.receipt).toMatchObject({ status: 200, model: 'jev-latest', requestId: 'req-fixture-123', inputTokens: 20, outputTokens: 10 });
    expect(JSON.stringify(result)).not.toContain('not-public');
  });
  it('uses DeepSeek JSON output parameters and never exposes reasoning_content', async () => {
    const fetcher: typeof fetch = async (url, init) => {
      expect(url).toBe('https://api.deepseek.com/chat/completions');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('deepseek-flash');
      expect(body.max_tokens).toBe(1400); expect(body.max_completion_tokens).toBeUndefined();
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.response_format).toEqual({ type: 'json_object' });
      return Response.json({ model: 'deepseek-flash', id: 'fixture-completion-1', usage: { prompt_tokens: 100, completion_tokens: 30 }, choices: [{ message: { reasoning_content: 'private-reasoning', content: JSON.stringify({ summary: '先补水', reply: '我建议喝水。', suggestedActions: ['drink'], memories: [] }) } }] });
    };
    const result = await new LanguageModelProvider('https://api.deepseek.com', 'test-key', 'deepseek-flash', fetcher).reflect(context(), signal());
    expect(result.receipt).toMatchObject({ status: 200, model: 'deepseek-flash', inputTokens: 100, outputTokens: 30 });
    expect(JSON.stringify(result)).not.toContain('private-reasoning');
  });
});
