import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientOptions, RawData } from 'ws';
import { cloudflareAiBase } from '@realtime-agent/config';
import type { CloudflareConfig } from '@realtime-agent/config';

export type VoiceSocketConnector = (url: string, options: ClientOptions) => WebSocket;
const MAX_BUFFER = 1024 * 1024;
const byteLength = (data: RawData) => Array.isArray(data) ? data.reduce((total, b) => total + b.byteLength, 0) : data.byteLength;

/** Adapts the SDK's /realtime URL to Cloudflare's /ai/run WebSocket contract.
 * Only a per-call local capability enters the SDK. The Cloudflare token stays here.
 */
export async function createCloudflareRelay(
  config: CloudflareConfig,
  signal: AbortSignal,
  onFailure: (message: string) => void,
  connect: VoiceSocketConnector = (url, options) => new WebSocket(url, options),
) {
  signal.throwIfAborted();
  if (!config.apiToken) throw new Error('缺少 CLOUDFLARE_API_TOKEN。');
  const upstreamUrl = new URL(`${cloudflareAiBase(config.accountId)}/run`);
  upstreamUrl.protocol = 'wss:'; upstreamUrl.searchParams.set('model', 'xai/grok-voice');
  const localKey = randomBytes(32).toString('hex');
  const localPath = `/voice-${randomBytes(16).toString('hex')}/realtime`;
  const sockets = new Set<WebSocket>();
  const pendingUpgrades = new Set<Duplex>();
  let closed = false, occupied = false, closing: Promise<void> | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A handshake can fail before the caller reaches its await.
  void ready.catch(() => undefined);
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BUFFER, perMessageDeflate: false });
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true; signal.removeEventListener('abort', onAbort);
    rejectReady(new Error('Cloudflare 音频连接已取消。'));
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    for (const socket of pendingUpgrades) socket.destroy();
    pendingUpgrades.clear();
    closing = Promise.all([
      new Promise<void>(resolve => webSockets.close(() => resolve())),
      new Promise<void>(resolve => server.close(() => resolve())),
    ]).then(() => undefined);
    return closing;
  };
  const onAbort = () => { void close(); };
  const fail = (message: string) => {
    if (closed) return;
    rejectReady(new Error(message)); onFailure(message); void close();
  };
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (request, socket, head) => {
    const incoming = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${localKey}`);
    const path = request.url?.split('?')[0];
    if (closed || request.headers.origin || path !== localPath || incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (occupied) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
    occupied = true;
    pendingUpgrades.add(socket); socket.on('error', () => undefined);
    let remote: WebSocket;
    try {
      remote = connect(upstreamUrl.href, { headers: { Authorization: `Bearer ${config.apiToken}` },
        handshakeTimeout: 10000, followRedirects: false, maxPayload: MAX_BUFFER, perMessageDeflate: false });
    } catch { fail('无法建立 Cloudflare 实时音频连接，请检查网络。'); return; }
    sockets.add(remote);
    let local: WebSocket | undefined;
    let earlyBytes = 0;
    const early: { data: RawData; binary: boolean }[] = [];
    const forward = (destination: WebSocket, data: RawData, binary: boolean) => {
      if (closed || destination.readyState !== WebSocket.OPEN) return;
      if (byteLength(data) + destination.bufferedAmount > MAX_BUFFER) { fail('实时音频传输积压，已停止通话，请检查网络后重连。'); return; }
      destination.send(data, { binary }, error => { if (error && !closed) fail('实时音频发送失败，请重新连接。'); });
    };
    remote.on('message', (data, binary) => {
      if (local) forward(local, data, binary);
      else {
        earlyBytes += byteLength(data);
        if (earlyBytes > MAX_BUFFER) { fail('Cloudflare 实时音频响应过大，已结束连接。'); return; }
        early.push({ data, binary });
      }
    });
    remote.once('unexpected-response', (_req, response) => {
      const status = response.statusCode;
      response.destroy();
      fail(`Cloudflare 实时语音返回 HTTP ${status ?? 502}，请检查 API Token 权限、AI Gateway 余额及 Grok Voice 可用性。`);
    });
    remote.on('error', () => fail('Cloudflare 实时音频连接失败，请检查网络、API Token 和账户余额。'));
    remote.once('open', () => {
      if (closed || signal.aborted || socket.destroyed) { remote.terminate(); return; }
      webSockets.handleUpgrade(request, socket, head, peer => {
        local = peer; pendingUpgrades.delete(socket); sockets.add(peer);
        peer.on('error', () => fail('本机音频通道已断开，请重新连接。'));
        peer.on('message', (data, binary) => forward(remote, data, binary));
        peer.once('close', () => { sockets.delete(peer); remote.terminate(); });
        for (const item of early.splice(0)) forward(peer, item.data, item.binary);
        resolveReady();
      });
    });
    remote.once('close', () => {
      sockets.delete(remote); occupied = false;
      if (!closed) fail('Cloudflare 实时音频会话已结束，请重新开始。');
    });
    socket.once('close', () => { pendingUpgrades.delete(socket); if (!local) remote.terminate(); });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    signal.throwIfAborted();
    signal.addEventListener('abort', onAbort, { once: true });
    const port = (server.address() as AddressInfo).port;
    return { baseUrl: `http://127.0.0.1:${port}${localPath.slice(0, -'/realtime'.length)}`, apiKey: localKey, ready, close };
  } catch (error) { await close(); throw error; }
}
