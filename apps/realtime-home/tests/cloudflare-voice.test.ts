import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCloudflareRelay } from '../server/voice/cloudflare-relay';
import { VoiceGateway } from '../server/voice/gateway';
import { AgentRuntime } from '../server/runtime';
import { DemoFastProvider } from '../server/providers';
import type { VoiceConfig } from '@realtime-agent/config';

const cf = { accountId: '0123456789abcdef0123456789abcdef', apiToken: 'cf-fixture-not-a-real-token' };
const expectedPath = `/client/v4/accounts/${cf.accountId}/ai/run?model=xai%2Fgrok-voice`;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function upstream() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanup.push(() => new Promise<void>(resolve => { for (const peer of server.clients) peer.terminate(); server.close(() => resolve()); }));
  return { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
function client(baseUrl: string, apiKey: string, origin?: string) {
  const peer = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/realtime?model=grok-voice-latest`, { headers: { Authorization: `Bearer ${apiKey}`, ...(origin ? { Origin: origin } : {}) } });
  peer.on('error', () => undefined);
  cleanup.push(() => { peer.terminate(); });
  return peer;
}
const opened = (socket: WebSocket) => new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });

describe('Cloudflare account voice adapter', () => {
  it('carries actual websocket frames to the exact account route with only the Cloudflare bearer, then closes both ends', async () => {
    const remote = await upstream();
    const accepted = new Promise<WebSocket>(resolve => remote.server.once('connection', (peer, req) => {
      expect(req.url).toBe(expectedPath);
      expect(req.headers.authorization).toBe(`Bearer ${cf.apiToken}`);
      peer.on('message', (data, binary) => peer.send(data, { binary }));
      resolve(peer);
    }));
    const connect = vi.fn((url, options) => {
      expect(url).toBe(`wss://api.cloudflare.com${expectedPath}`);
      expect(options.followRedirects).toBe(false);
      return new WebSocket(`${remote.url}${expectedPath}`, options);
    });
    const abort = new AbortController(), failure = vi.fn();
    const relay = await createCloudflareRelay(cf, abort.signal, failure, connect); cleanup.push(relay.close);
    expect(relay.apiKey).not.toBe(cf.apiToken);
    expect(relay.baseUrl).not.toContain(cf.apiToken);
    const local = client(relay.baseUrl, relay.apiKey);
    await opened(local); await relay.ready;
    const peer = await accepted;
    const received = new Promise<string>(resolve => local.once('message', value => resolve(value.toString())));
    local.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(960).toString('base64') }));
    expect(JSON.parse(await received).type).toBe('input_audio_buffer.append');
    const remoteClosed = new Promise<void>(resolve => peer.once('close', () => resolve()));
    abort.abort(); await relay.close(); await remoteClosed;
    expect(connect).toHaveBeenCalledTimes(1); expect(failure).not.toHaveBeenCalled();
  });

  it('refuses wrong local credentials and browser origins without opening or billing an upstream connection', async () => {
    const connect = vi.fn(() => { throw new Error('must not connect'); });
    const relay = await createCloudflareRelay(cf, new AbortController().signal, vi.fn(), connect); cleanup.push(relay.close);
    for (const [key, origin] of [['wrong', undefined], [relay.apiKey, 'https://external.example']]) {
      const local = client(relay.baseUrl, key!, origin);
      await expect(opened(local)).rejects.toThrow('403');
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('reports a rejected upgrade with sanitized status and leaves no pending local socket', async () => {
    const remote = createServer((_req, res) => { res.writeHead(401); res.end('echo-cf-private-token'); });
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { remote.closeAllConnections(); remote.close(() => resolve()); }));
    const failure = vi.fn();
    const relay = await createCloudflareRelay(cf, new AbortController().signal, failure,
      (_url, options) => new WebSocket(`ws://127.0.0.1:${(remote.address() as AddressInfo).port}`, options));
    cleanup.push(relay.close);
    const local = client(relay.baseUrl, relay.apiKey);
    const rejected = opened(local).catch(() => undefined);
    await expect(relay.ready).rejects.toThrow('HTTP 401'); await rejected;
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0][0]).not.toContain('echo-cf-private-token');
    await relay.close();
  });

  it('serves one Cloudflare profile and never places its permanent credential in tickets or snapshots', async () => {
    const runtime = new AgentRuntime({ mode: 'live', fast: new DemoFastProvider(), slow: null, provider: 'cloudflare' });
    const config: VoiceConfig = { provider: 'cloudflare', cloudflare: cf, openaiKey: '', googleKey: '', xaiKey: '',
      livekit: { url: 'ws://127.0.0.1:7880', apiKey: 'devkey', apiSecret: 'secret' },
      models: { openai: '', duplex: '', google: '', xai: '', backend: '' } };
    const gateway = new VoiceGateway(runtime, config, async profile => {
      expect(profile.id).toBe('cloudflare-grok');
      return { connection: { kind: 'livekit', url: config.livekit.url, participantToken: 'fixture-room-token' }, async sendText() {}, async interrupt() {}, async close() {} };
    });
    cleanup.push(async () => { await gateway.dispose(); runtime.stop(); });
    expect(gateway.catalog().profiles.map(p => p.id)).toEqual(['cloudflare-grok']);
    expect(gateway.catalog().profiles[0].missing).toEqual([]);
    await expect(gateway.create('openai-webrtc', runtime.state.epoch)).rejects.toMatchObject({ status: 409 });
    const ticket = await gateway.create('cloudflare-grok', runtime.state.epoch);
    expect(ticket.connection.kind).toBe('livekit');
    expect(JSON.stringify([ticket, gateway.catalog(), runtime.snapshot()])).not.toContain(cf.apiToken);
  });
});
