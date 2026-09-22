import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { BrowserDriver } from './browser.js';
import { ComputerRuntime } from './runtime.js';
import { demoProviders } from './providers.js';
import type { ComputerProviders } from './providers.js';

export async function startComputerServer(options: {
  port?: number;
  mode?: 'demo' | 'live';
  providers?: ComputerProviders;
  channel?: 'chrome' | 'chromium';
  decisionIntervalMs?: number;
} = {}) {
  const port = options.port ?? 3110;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid computer reference port.');
  if (options.mode === 'live' && !options.providers) throw new Error('Live mode requires explicit model providers.');
  const app = express(), server = createServer(app);
  let runtime: ComputerRuntime | null = null, origin = '';
  const getRuntime = () => { if (!runtime) throw new Error('The browser is not ready.'); return runtime; };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
    const address = server.address(), actualPort = address && typeof address === 'object' ? address.port : port;
    if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(req.get('host') ?? '')) { res.status(403).json({ error: '只接受本机访问。' }); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('origin') && ![origin, `http://localhost:${actualPort}`].includes(req.get('origin')!)) {
      res.status(403).json({ error: '请求来源与本机会话不匹配。' }); return;
    }
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.get('/api/health', (_req, res) => res.status(runtime ? 200 : 503).json({ ready: !!runtime }));
  app.get('/api/state', (_req, res) => res.json(getRuntime().snapshot()));
  app.get('/api/trace', (_req, res) => {
    const current = getRuntime(); res.set('Content-Disposition', 'attachment; filename="computer-trace.json"');
    res.json({ ...current.snapshot(), timings: current.agent.telemetry.snapshot() });
  });
  app.get('/api/screen', async (_req, res) => { res.type('png').send(await getRuntime().driver.screen()); });
  app.post('/api/goal', (req, res) => { getRuntime().submit(req.body); res.json({ ok: true }); });
  app.post('/api/stop', (_req, res) => { getRuntime().stop(); res.json({ ok: true }); });
  app.post('/api/reconcile', (_req, res) => res.json({ requested: getRuntime().reconcile() }));
  app.post('/api/scenario', async (req, res) => {
    const { kind } = z.object({ kind: z.enum(['popup', 'shuffle', 'slow']) }).strict().parse(req.body);
    await getRuntime().driver.scenario(kind); await getRuntime().refresh(); res.json({ ok: true });
  });
  const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
  app.get('/workspace', (_req, res) => res.sendFile('workspace.html', { root: publicDirectory }));
  app.use(express.static(publicDirectory));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    const invalid = error instanceof z.ZodError || error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large';
    res.status(invalid ? 400 : 503).json({ error: invalid ? '输入格式无效，请检查字段长度和分类。' : '操作暂未完成；请查看执行回执后重试。' });
  };
  app.use(errors);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local server address.');
  origin = `http://127.0.0.1:${address.port}`;
  let driver: BrowserDriver | null = null;
  try {
    driver = await BrowserDriver.open(origin, options.channel);
    runtime = new ComputerRuntime(driver, options.mode ?? 'demo', options.providers ?? demoProviders(), { decisionIntervalMs: options.decisionIntervalMs });
    await runtime.start();
  } catch (error) {
    if (runtime) await runtime.close(); else await driver?.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); throw error;
  }
  let closed = false;
  return { origin, runtime, async close() {
    if (closed) return; closed = true;
    try { await runtime!.close(); } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  } };
}
