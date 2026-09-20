import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createCloudflareRelay } from '../server/voice/cloudflare-relay';

// Independent boundary checks with real local sockets. No external API or .env is used.
const teardown: (() => Promise<unknown> | void)[] = [];
const cf = { accountId: 'a'.repeat(32), apiToken: 'cf-fixture-secret-never-send-to-browser' };
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  teardown.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function client(url: string, authorization: string, origin?: string) {
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/realtime', {
    headers: { Authorization: authorization, ...(origin ? { Origin: origin } : {}) }, handshakeTimeout: 1500,
  });
  ws.on('error', () => undefined);
  teardown.push(() => ws.terminate());
  return ws;
}
afterEach(async () => { for (const fn of teardown.splice(0).reverse()) await fn(); });

describe('Cloudflare relay transport boundaries', () => {
  it('keeps the account token upstream and relays actual binary and JSON frames in both directions', async () => {
    const server = createServer();
    const upstream = new WebSocketServer({ server });
    const upstreamUrl = await listen(server);
    teardown.push(() => { for (const ws of upstream.clients) ws.terminate(); upstream.close(); });
    const failures: string[] = [];
    const abort = new AbortController();
    let requests = 0;
    const relay = await createCloudflareRelay(cf, abort.signal, message => failures.push(message), (url, options) => {
      requests++;
      expect(url).toBe(`wss://api.cloudflare.com/client/v4/accounts/${cf.accountId}/ai/run?model=xai%2Fgrok-voice`);
      expect(options.headers).toEqual({ Authorization: `Bearer ${cf.apiToken}` });
      expect(options.followRedirects).toBe(false);
      return new WebSocket(upstreamUrl);
    });
    teardown.push(() => relay.close());
    expect(relay.apiKey).not.toBe(cf.apiToken);
    expect(relay.baseUrl).not.toContain(cf.apiToken);
    const remoteConnected = once(upstream, 'connection');
    const local = client(relay.baseUrl, `Bearer ${relay.apiKey}`);
    await once(local, 'open');
    const [remote] = await remoteConnected as [WebSocket];
    await relay.ready;
    const audio = Buffer.from([1, 0, 127, 0, 255, 255]);
    const incomingAudio = once(remote, 'message');
    local.send(audio);
    const [actualAudio, binary] = await incomingAudio;
    expect(binary).toBe(true); expect(Buffer.from(actualAudio)).toEqual(audio);
    const incomingEvent = once(local, 'message');
    remote.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture-call' } }));
    const [event, eventBinary] = await incomingEvent;
    expect(eventBinary).toBe(false); expect(JSON.parse(String(event)).session.id).toBe('fixture-call');
    const remoteClosed = once(remote, 'close');
    abort.abort();
    await relay.close(); await remoteClosed;
    expect(requests).toBe(1); expect(failures).toEqual([]);
  });

  it('rejects wrong capabilities and browser origins before opening a paid upstream connection', async () => {
    let attempts = 0;
    const relay = await createCloudflareRelay(cf, new AbortController().signal, () => {}, () => {
      attempts++; throw new Error('must not connect');
    });
    teardown.push(() => relay.close());
    for (const [auth, origin] of [[`Bearer ${cf.apiToken}`, undefined], [`Bearer ${relay.apiKey}`, 'https://untrusted.example']] as const) {
      const peer = client(relay.baseUrl, auth, origin);
      const status = new Promise<number | undefined>(resolve => peer.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode); response.destroy(); peer.terminate();
      }));
      expect(await status).toBe(403);
    }
    expect(attempts).toBe(0);
  });

  it('reports an upstream rejection without exposing response bodies, tokens or leaving a pending local handshake', async () => {
    const server = createServer((_request, response) => { response.writeHead(403); response.end(`private-echo:${cf.apiToken}`); });
    const url = await listen(server);
    const failures: string[] = [];
    const relay = await createCloudflareRelay(cf, new AbortController().signal, message => failures.push(message), () => new WebSocket(url));
    teardown.push(() => relay.close());
    const rejected = expect(relay.ready).rejects.toThrow('HTTP 403');
    const peer = client(relay.baseUrl, `Bearer ${relay.apiKey}`);
    const localClosed = new Promise<void>(resolve => peer.once('close', () => resolve()));
    await rejected; await localClosed; await relay.close();
    expect(failures).toHaveLength(1);
    expect(failures.join()).not.toContain('private-echo');
    expect(failures.join()).not.toContain(cf.apiToken);
  });

  it('cancels an upstream handshake that has not completed and releases both sockets', async () => {
    const sockets = new Set<Socket>();
    const server = createServer();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (_request, socket) => {
      // No upgrade response; keep reading so TCP EOF is observable by this test server.
      socket.resume(); socket.on('end', () => socket.end());
    });
    const url = await listen(server);
    teardown.push(() => { for (const socket of sockets) socket.destroy(); });
    const abort = new AbortController();
    const relay = await createCloudflareRelay(cf, abort.signal, () => {}, () => new WebSocket(url));
    teardown.push(() => relay.close());
    const pending = expect(relay.ready).rejects.toThrow('取消');
    const upstreamRequested = once(server, 'upgrade');
    const peer = client(relay.baseUrl, `Bearer ${relay.apiKey}`);
    const peerClosed = new Promise<void>(resolve => peer.once('close', () => resolve()));
    await upstreamRequested;
    abort.abort(); await relay.close(); await pending; await peerClosed;
    await expect.poll(() => sockets.size).toBe(0);
  });
});
