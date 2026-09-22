import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { AgentError } from '@realtime-agent/agent';
import { DesktopRuntime } from './desktop-runtime.js';
import type { DesktopDriver } from './desktop-types.js';
import type { DesktopProviders } from './desktop-providers.js';

export async function startDesktopServer(options: {
  driver: DesktopDriver; providers?: DesktopProviders | null; port?: number; modelError?: string | null; decisionIntervalMs?: number;
}) {
  const port = options.port ?? 3110;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid desktop port.');
  const app = express(), server = createServer(app);
  const runtime = new DesktopRuntime(options.driver, options.providers ?? null, options.modelError ?? null, options);
  let origin = '', ready = false;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'" });
    const address = server.address(), actualPort = address && typeof address === 'object' ? address.port : port;
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.get('host') ?? '')) { res.status(403).json({ error: '只接受本机访问。' }); return; }
    if (req.get('origin') && ![origin, `http://localhost:${actualPort}`].includes(req.get('origin')!)) { res.status(403).json({ error: '请求来源与桌面会话不匹配。' }); return; }
    if (req.get('sec-fetch-site') === 'cross-site') { res.status(403).json({ error: '不接受跨站桌面请求。' }); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json')) { res.status(415).json({ error: '桌面控制请求需要 JSON。' }); return; }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_req, res) => res.status(ready ? 200 : 503).json({ ready, backend: 'windows', decisionProtocol: 'desktop-choice-v1' }));
  app.get('/api/state', (_req, res) => res.json(runtime.snapshot()));
  app.get('/api/screen', async (_req, res) => {
    const frame = await runtime.screen();
    res.set({ 'X-Screen-X': String(frame.bounds.x), 'X-Screen-Y': String(frame.bounds.y), 'X-Screen-Width': String(frame.bounds.width),
      'X-Screen-Height': String(frame.bounds.height), 'X-Screen-Captured-At': String(frame.capturedAt),
      'X-Screen-Window-Id': frame.windowId ?? '', 'X-Screen-Id': frame.id });
    res.type('png').send(frame.png);
  });
  app.post('/api/window', async (req, res) => {
    const { windowId } = z.object({ windowId: z.string().min(1).max(80).nullable() }).strict().parse(req.body);
    await runtime.selectWindow(windowId); res.json({ ok: true });
  });
  app.post('/api/goal', async (req, res) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).strict().parse(req.body);
    await runtime.submit(text); res.json({ ok: true });
  });
  app.post('/api/input', async (req, res) => {
    const { command, frameId } = z.object({ command: z.unknown(), frameId: z.string().max(80).optional() }).strict().parse(req.body);
    await runtime.input(command, frameId); res.json({ ok: true });
  });
  app.post('/api/stop', async (_req, res) => { await runtime.stop(); res.json({ ok: true }); });
  app.post('/api/reconcile', (_req, res) => res.json({ requested: runtime.reconcile() }));
  app.get('/api/trace', (_req, res) => {
    res.set('Content-Disposition', 'attachment; filename="desktop-trace.json"');
    res.json({ ...runtime.snapshot(), timings: runtime.agent.telemetry.snapshot() });
  });
  const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
  app.get('/', (_req, res) => res.sendFile('desktop.html', { root: publicDirectory }));
  for (const file of ['desktop.js', 'desktop.css']) app.get(`/${file}`, (_req, res) => res.sendFile(file, { root: publicDirectory }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    const invalid = error instanceof z.ZodError || error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large';
    res.status(invalid ? 400 : error instanceof AgentError ? 409 : 503).json({
      error: invalid ? '输入格式无效。' : error instanceof AgentError ? error.message : '桌面操作未完成，请检查所选窗口和 Windows 会话。',
    });
  };
  app.use(errors);
  try {
    await runtime.start();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No desktop server address.');
    origin = `http://127.0.0.1:${address.port}`; ready = true;
  } catch (error) { await runtime.close(); server.close(); throw error; }
  let closed = false;
  return { origin, runtime, async close() {
    if (closed) return; closed = true; ready = false;
    try { await runtime.close(); }
    finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  } };
}
