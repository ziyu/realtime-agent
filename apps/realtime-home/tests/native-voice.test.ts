import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceConfig } from '@realtime-agent/config';
import { VoiceBridge } from '../server/voice/bridge';
import { VoiceGateway } from '../server/voice/gateway';
import type { VoiceBackend } from '../server/voice/gateway';
import { AgentRuntime } from '../server/runtime';
import { DemoFastProvider } from '../server/providers';
import { createApp } from '../server/app';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { VoiceTurns } from '../server/voice/turns';

const config: VoiceConfig = { openaiKey: 'fixture-openai-secret-never-public', googleKey: '', xaiKey: '', livekit: { url: '', apiKey: '', apiSecret: '' }, models: { openai: 'gpt-realtime-2.1', duplex: 'gpt-live-1', google: 'gemini-3.8-live', xai: 'grok-voice-think-fast-2.0', backend: 'gpt-5.6-luna' } };
const runtimes: AgentRuntime[] = [], gateways: VoiceGateway[] = [], servers: Server[] = [];
const runtime = () => { const r = new AgentRuntime({ mode: 'live', fast: new DemoFastProvider(), slow: { reflect: vi.fn(async () => ({ summary: 'unexpected', reply: 'unexpected', memories: [], suggestedActions: [] })) } }); runtimes.push(r); return r; };
const backend = (): VoiceBackend => ({ connection: { kind: 'openai', ephemeralKey: 'ek_fixture' }, close: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), sendText: vi.fn(async () => {}) });
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.dispose();
  for (const r of runtimes.splice(0)) r.stop();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  vi.useRealTimers();
});

describe('native audio and authoritative behavior', () => {
  it('correlates overlapping provider transcriptions by speech IDs and never revives a duplicate final', () => {
    const r = runtime(); r.setNativeVoice(true);
    const b = new VoiceBridge(r, r.state.epoch, 'turns', Date.now() + 900000);
    const turns = new VoiceTurns(b);
    turns.start('old'); turns.stop(); turns.start('new'); turns.stop();
    expect(turns.transcript({ itemId: 'new', transcript: '改去喝水', isFinal: true })).toBe(true);
    expect(turns.transcript({ itemId: 'old', transcript: '去睡觉', isFinal: true })).toBe(false);
    expect(turns.transcript({ itemId: 'old', transcript: '去睡觉', isFinal: true })).toBe(false);
    expect(turns.sequence).toBe(2); expect(r.state.intent?.text).toBe('改去喝水');
    expect(r.state.turns).toHaveLength(1); b.close();
  });
  it('refuses ambiguous delayed transcription without a speech ID or timestamp instead of executing it as the newest turn', () => {
    const r = runtime(); r.setNativeVoice(true);
    const b = new VoiceBridge(r, r.state.epoch, 'turns', Date.now() + 900000);
    const turns = new VoiceTurns(b);
    turns.start(); turns.stop(); turns.start(); turns.stop();
    expect(turns.transcript({ itemId: 'unassociated', transcript: '去睡觉', isFinal: true })).toBe(false);
    expect(b.state.status).toBe('error'); expect(r.state.intent).toBeNull(); b.close();
  });
  it('holds unfinished actions during speech, accepts a final correction once, and rejects late transcripts and replies', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const r = runtime(); r.start(); r.message('去睡觉'); await vi.advanceTimersByTimeAsync(60);
    const original = r.state.agent.action!; expect(original.id).toBe('sleep');
    r.setNativeVoice(true);
    const b = new VoiceBridge(r, r.state.epoch, 'test-session', Date.now() + 900000);
    b.event({ type: 'speech-start', sequence: 1, itemId: 'one' });
    const position = { ...r.state.agent.position };
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.state.agent.position).toEqual(position);
    expect(r.state.outcomes).toEqual([]);
    b.event({ type: 'input', sequence: 1, itemId: 'one', text: '改去喝水' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.state.agent.action?.id).toBe('drink');
    const starts = r.state.metrics.started, turns = r.state.turns.length;
    b.event({ type: 'input', sequence: 1, itemId: 'one', text: '改去喝水' });
    expect(r.state.turns).toHaveLength(turns); expect(r.state.metrics.started).toBe(starts);
    b.event({ type: 'speech-start', sequence: 2, itemId: 'two' });
    expect(b.event({ type: 'reply', sequence: 1, itemId: 'old-reply', text: '旧回答' })).toBe(false);
    expect(b.event({ type: 'input', sequence: 1, itemId: 'late', text: '睡觉' })).toBe(false);
    b.event({ type: 'input', sequence: 2, itemId: 'two', text: '停止' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.state.agent.action).toBeNull(); expect(r.state.metrics.interrupted).toBe(2);
    expect(r.state.outcomes).toEqual([]); expect(r.state.messages.some(m => m.text === '旧回答')).toBe(false);
    expect(r.state.metrics.llmCalls).toBe(0); b.close();
  });
  it('uses the same slow proposal and explicit speak in native mode without browser TTS duplication', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const r = runtime(); r.setNativeVoice(true); r.start();
    const b = new VoiceBridge(r, r.state.epoch, 'test-session', Date.now() + 900000);
    b.event({ type: 'input', sequence: 1, itemId: 'one', text: '你喜欢怎样的生活？只聊天，不要行动' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(r.state.metrics.llmCalls).toBe(1);
    expect(b.event({ type: 'reply', sequence: 1, itemId: 'unapproved', text: '未经许可的回复' })).toBe(false);
    const plan = await b.outputPlan(1);
    expect(plan?.exactText).toBe('unexpected');
    expect(plan?.executionId).toBe(r.state.speechExecution?.id);
    b.event({ type: 'reply', sequence: 1, itemId: plan!.id, text: plan!.exactText });
    b.event({ type: 'reply', sequence: 1, itemId: plan!.id, text: plan!.exactText });
    await vi.advanceTimersByTimeAsync(100);
    expect(r.state.messages.filter(m => m.nativeAudio)).toHaveLength(1);
    expect(r.state.intent?.replyDelivered).toBe(true);
    expect(r.state.outcomes).toEqual([]); b.close();
  });
  it('exposes object appearance only after Jev accepted an approach and the body actually arrived', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const r = runtime(); r.setNativeVoice(true); r.start();
    const b = new VoiceBridge(r, r.state.epoch, 'inspect-session', Date.now() + 900000);
    b.event({ type: 'input', sequence: 1, itemId: 'bed', text: '去床边看看' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(r.state.agent.action).toMatchObject({ id: 'inspect', target: 'sleep' });
    expect(b.observation(1).observedObject).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(r.state.agent.action).toBeNull();
    expect(b.observation(1).completedDetails).toContainEqual({ action: 'inspect', target: 'sleep' });
    expect(b.observation(1).observedObject).toMatchObject({ target: 'sleep', object: '床' });
    expect(b.observation(1).observedObject?.appearance).toContain('暖棕色');
    b.close();
  });
  it('a readonly tool waiting for a transcript cannot apply an old result after a newer turn begins', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const r = runtime(); r.setNativeVoice(true);
    const b = new VoiceBridge(r, r.state.epoch, 'test-session', Date.now() + 900000);
    b.event({ type: 'speech-start', sequence: 1 });
    const pending = b.observe(1);
    b.event({ type: 'speech-start', sequence: 2 });
    await vi.advanceTimersByTimeAsync(40);
    expect((await pending).phase).toBe('superseded');
    expect(r.state.metrics.started).toBe(0);
    b.close(); expect(r.state.nativeVoiceActive).toBe(false); expect(r.state.attending).toBe(false);
  });
});

describe('leased voice sessions', () => {
  it('shows missing independent credentials, refuses unavailable profiles and sends only an ephemeral OpenAI credential to the browser', async () => {
    const r = runtime();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${config.openaiKey}`);
      const payload = JSON.parse(String(init?.body));
      expect(payload.session.type).toBe('realtime'); expect(payload.session.model).toBe(config.models.openai);
      expect(payload.session.audio.input.turn_detection.interrupt_response).toBe(true);
      expect(payload.session.instructions).toContain('Jev');
      return Response.json({ value: 'ek_fixture', expires_at: Date.now() / 1000 + 60 });
    });
    const g = new VoiceGateway(r, config, undefined, fetcher); gateways.push(g);
    expect(g.catalog().profiles.find(p => p.id === 'livekit-gemini')?.missing).toContain('GEMINI_API_KEY');
    await expect(g.create('livekit-grok', r.state.epoch)).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
    const ticket = await g.create('openai-webrtc', r.state.epoch);
    expect(JSON.stringify(ticket)).not.toContain(config.openaiKey);
    expect(JSON.stringify(r.snapshot())).not.toContain(ticket.token);
    expect(JSON.stringify(g.catalog())).not.toContain(config.openaiKey);
    expect(ticket.connection).toEqual({ kind: 'openai', ephemeralKey: 'ek_fixture' });
  });
  it('does not close a healthy session when its startup deadline passes; does close abandoned sessions', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const r = runtime(), transport = backend();
    const g = new VoiceGateway(r, config, async () => transport); gateways.push(g);
    const ticket = await g.create('openai-webrtc', r.state.epoch);
    await vi.advanceTimersByTimeAsync(25000);
    expect(transport.close).not.toHaveBeenCalled();
    expect(g.authorize(ticket.id, `Bearer ${ticket.token}`).bridge.active).toBe(true);
    await vi.advanceTimersByTimeAsync(25000);
    expect(transport.close).toHaveBeenCalledTimes(1); expect(r.state.nativeVoiceActive).toBe(false);
    expect(() => g.authorize(ticket.id, `Bearer ${ticket.token}`)).toThrow();
  });
  it('reclaims a backend that finishes connecting after reset', async () => {
    const r = runtime(), transport = backend();
    let resolve!: (backend: VoiceBackend) => void;
    const g = new VoiceGateway(r, config, () => new Promise(done => { resolve = done; })); gateways.push(g);
    const pending = g.create('openai-webrtc', r.state.epoch);
    const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
    r.reset(); resolve(transport); await rejected;
    expect(transport.close).toHaveBeenCalledTimes(1); expect(r.state.nativeVoiceActive).toBe(false);
  });
  it('enforces origin, session capability, exact epoch, strict transcript schema and stale-session isolation over HTTP', async () => {
    const r = runtime(); const g = new VoiceGateway(r, config, async () => backend()); gateways.push(g);
    const server = createApp(r, { voice: g }).listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice`;
    const post = (path: string, body: unknown, token = '', origin = 'http://127.0.0.1:5174') => fetch(`${url}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect((await post('sessions', { profile: 'openai-webrtc', epoch: r.state.epoch }, '', 'https://external.example')).status).toBe(403);
    const created = await post('sessions', { profile: 'openai-webrtc', epoch: r.state.epoch });
    expect(created.status).toBe(201); const ticket = await created.json();
    const route = `sessions/${ticket.id}`;
    expect((await post(`${route}/heartbeat`, {})).status).toBe(401);
    expect((await post(`${route}/event`, { type: 'input', sequence: 1, text: '喝水', itemId: 'one', action: 'sleep' }, ticket.token)).status).toBe(400);
    expect((await post(`${route}/event`, { type: 'input', sequence: 1, text: '喝水', itemId: 'one' }, ticket.token)).status).toBe(200);
    expect(r.state.intent?.text).toBe('喝水'); expect(r.state.agent.action).toBeNull();
    await post(`${route}/end`, {}, ticket.token);
    expect((await post(`${route}/event`, { type: 'input', sequence: 2, text: '睡觉', itemId: 'late' }, ticket.token)).status).toBe(401);
    expect(r.state.intent?.text).toBe('喝水');
  });
});
