import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { AgentRuntime } from '../server/runtime';
import { DemoFastProvider } from '../server/providers';
import { randomUUID } from 'node:crypto';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function fixture() {
  const runtime = new AgentRuntime({ mode: 'demo', fast: new DemoFastProvider(), slow: null });
  const server = createApp(runtime).listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { runtime, url, post };
}

describe('local world HTTP API', () => {
  it('returns turn receipts and rejects delayed or conflicting browser input without replacing the latest intent', async () => {
    const { post, runtime } = await fixture();
    const client = { id: randomUUID(), sequence: 2 };
    const body = { text: '去喝水', source: 'voice', epoch: runtime.state.epoch, client };
    const accepted = await (await post('messages', body)).json();
    expect(accepted.turnId).toBe(runtime.state.intent?.id);
    expect(accepted.receivedAt).toBe(runtime.state.intent?.createdAt);
    expect((await (await post('messages', body)).json()).duplicate).toBe(true);
    expect((await post('messages', { ...body, client: { ...client, sequence: 1 }, text: '去睡觉' })).status).toBe(409);
    expect((await post('messages', { ...body, text: '另一个内容' })).status).toBe(409);
    expect(runtime.state.intent?.text).toBe('去喝水');
    expect(runtime.state.turns).toHaveLength(1);
    expect(runtime.state.turns[0].source).toBe('voice');
    expect((await post('messages', { text: 'test', client: { id: client.id, sequence: 0 } })).status).toBe(400);
  });
  it('scopes speech interruption to its observed world and turn, and keeps it subject to the write origin guard', async () => {
    const { post, runtime } = await fixture();
    const receipt = runtime.message('聊聊');
    const input = { epoch: runtime.state.epoch, turnId: receipt.turnId };
    expect((await post('conversation/interrupt', input, { Origin: 'https://untrusted.example' })).status).toBe(403);
    expect((await (await post('conversation/interrupt', input)).json()).interrupted).toBe(true);
    expect(runtime.state.intent?.replySuppressed).toBe(true);
    runtime.message('新问题');
    expect((await (await post('conversation/interrupt', input)).json()).interrupted).toBe(false);
    expect(runtime.state.intent?.replySuppressed).toBeUndefined();
    expect((await post('conversation/interrupt', { ...input, text: '不能附带指令' })).status).toBe(400);
    runtime.reset();
    expect((await post('messages', { text: '旧请求', epoch: input.epoch })).status).toBe(409);
  });
  it('only allows the sharing setting, and forgetting requires an existing exact memory ID', async () => {
    const { post, runtime } = await fixture();
    expect((await post('mind/settings', { proactiveChat: false })).status).toBe(200);
    expect(runtime.state.mind.settings.proactiveChat).toBe(false);
    expect((await post('mind/settings', { proactiveChat: true, personality: 'overwrite' })).status).toBe(400);
    expect((await post('memories/forget', { id: 'missing' })).status).toBe(404);
    expect((await post('mind/settings', { proactiveChat: true }, { Origin: 'https://untrusted.example' })).status).toBe(403);
  });
  it('routes furniture clicks through user instructions rather than direct execution', async () => {
    const { runtime, post } = await fixture();
    expect((await post('interact', { action: 'read' })).status).toBe(202);
    expect(runtime.state.intent?.text).toContain('看书');
    expect(runtime.state.agent.action).toBeNull();
    await runtime.decide(); expect(runtime.state.agent.action?.id).toBe('read');
  });
  it('validates messages, world controls, and unknown objects', async () => {
    const { post } = await fixture();
    expect((await post('messages', { text: ' ' })).status).toBe(400);
    expect((await post('messages', { text: 'x'.repeat(1201) })).status).toBe(400);
    expect((await post('control', { type: 'speed', speed: 99 })).status).toBe(400);
    expect((await post('interact', { action: '__proto__' })).status).toBe(400);
    expect((await post('messages', { text: '去喝水' })).status).toBe(202);
  });
  it('rejects cross-origin mutations and oversized request bodies', async () => {
    const { post } = await fixture();
    expect((await post('messages', { text: '去喝水' }, { Origin: 'https://untrusted.example' })).status).toBe(403);
    expect((await post('messages', { text: 'x'.repeat(10000) })).status).toBe(413);
  });
  it('streams a fresh authoritative snapshot when EventSource reconnects', async () => {
    const { url, runtime, post } = await fixture();
    await post('messages', { text: '去睡觉' });
    const controller = new AbortController();
    const response = await fetch(`${url}/api/events`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      for (let i = 0; i < 10 && !text.includes(runtime.state.intent!.id); i++) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).toContain('event: state'); expect(text).toContain(runtime.state.intent!.id);
    } finally { controller.abort(); reader.releaseLock(); }
  });
  it('keeps SSE subscribed after the GET request has finished and streams later state changes', async () => {
    const { url, runtime } = await fixture();
    const controller = new AbortController();
    const response = await fetch(`${url}/api/events`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder(); let buffer = '';
    async function until(marker: string) {
      while (!buffer.includes(marker)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE ended before the state update');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
    try {
      await until(runtime.state.epoch);
      buffer = '';
      runtime.message('SSE 后续消息');
      await until(runtime.state.intent!.id);
      expect(buffer).toContain('SSE 后续消息');
      buffer = '';
      runtime.pause(true);
      await until('"paused":true');
      expect(buffer).toContain('"status":"paused"');
    } finally { controller.abort(); reader.releaseLock(); }
  });
});
