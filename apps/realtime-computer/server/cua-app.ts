import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { AgentError } from '@realtime-agent/agent';
import { CuaComputerRuntime } from './cua-runtime.js';
import type { ComputerRuntimeOptions } from './cua-runtime.js';
import type { CuaConnection } from './cua-policy.js';
import type { ComputerProviders } from './cua-models.js';
import { ComputerApiError, ComputerTaskApi, TASK_RETENTION } from './task-api.js';

export async function startCuaServer(options: ComputerRuntimeOptions & {
  driver: CuaConnection;
  providers?: ComputerProviders | ((runtime: CuaComputerRuntime) => ComputerProviders) | null;
  modelError?: string | null;
  port?: number;
}) {
  const port = options.port ?? 3110;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid computer port.');
  const app = express(), server = createServer(app);
  const runtime = new CuaComputerRuntime(options.driver, options.providers ?? null, options.modelError ?? null, options);
  const tasks = new ComputerTaskApi(runtime);
  let origin = '', ready = false;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'" });
    const address = server.address(), actualPort = address && typeof address === 'object' ? address.port : port;
    const allowed = [origin, `http://localhost:${actualPort}`];
    if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(req.get('host') ?? '')
      || req.get('origin') && !allowed.includes(req.get('origin')!) || req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: req.path.startsWith('/api/v1/')
        ? { code: 'forbidden_origin', message: '此 Computer 会话只接受同源本机访问。' } : '此 Computer 会话只接受同源本机访问。' }); return;
    }
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
      res.status(415).json({ error: req.path.startsWith('/api/v1/')
        ? { code: 'unsupported_media_type', message: 'Computer 请求必须使用 JSON。' } : 'Computer 请求必须使用 JSON。' }); return;
    }
    next();
  });
  app.use(express.json({ limit: '48kb' }));
  app.get(['/api/health', '/api/v1/health'], (_req, res) => res.status(ready ? 200 : 503).json({ apiVersion: '1', ready, backend: 'cua',
    decisionProtocol: 'cua-computer-v1', driverVersion: options.driver.metadata.driverVersion ?? null }));
  app.get('/api/v1/capabilities', (_req, res) => {
    const state = runtime.snapshot();
    res.json({ apiVersion: '1', backend: 'cua', driver: state.driver, connected: state.connected,
      modelReady: state.modelReady, modelCapabilities: state.modelCapabilities,
      tasks: { maxConcurrent: 1, maxGoalLength: 8000, retained: TASK_RETENTION, storage: 'process-memory',
        resumeCreatesNewTask: true, idempotency: 'Idempotency-Key', statuses: ['active', 'completed', 'blocked', 'cancelled'] },
      tools: runtime.tools.modelCatalog() });
  });
  const taskId = (value: unknown) => z.string().uuid().parse(value);
  app.post('/api/v1/tasks', async (req, res) => {
    const { goal } = z.object({ goal: z.string().trim().min(1).max(8000) }).strict().parse(req.body);
    const result = await tasks.create(goal, { requestId: req.get('Idempotency-Key') });
    res.location(`/api/v1/tasks/${result.task.id}`).status(result.replayed ? 200 : 202).json(result);
  });
  app.get('/api/v1/tasks', (_req, res) => res.json({ tasks: tasks.list() }));
  app.get('/api/v1/tasks/:id', (req, res) => res.json({ task: tasks.get(taskId(req.params.id)) }));
  app.get('/api/v1/tasks/:id/result', (req, res) => res.json(tasks.result(taskId(req.params.id))));
  app.get('/api/v1/tasks/:id/trace', (req, res) => res.json(tasks.trace(taskId(req.params.id))));
  app.post('/api/v1/tasks/:id/stop', async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json({ task: await tasks.stop(taskId(req.params.id)) });
  });
  app.post('/api/v1/tasks/:id/resume', async (req, res) => {
    z.object({}).strict().parse(req.body);
    const task = await tasks.resume(taskId(req.params.id));
    res.location(`/api/v1/tasks/${task.id}`).status(202).json({ task });
  });
  app.use('/api/v1', (_req, res) => res.status(404).json({ error: { code: 'route_not_found', message: '未知 Computer API 路由。' } }));
  app.get('/api/state', (_req, res) => res.json(runtime.snapshot()));
  app.get('/api/screen', async (_req, res) => {
    const frame = await runtime.screen();
    res.set({ 'X-Screen-Id': frame.id, 'X-Screen-Captured-At': String(frame.capturedAt),
      'X-Screen-Width': String(frame.width), 'X-Screen-Height': String(frame.height), 'X-Screen-Window-Id': frame.windowId ?? '' });
    res.type(frame.mimeType).send(frame.bytes);
  });
  app.post('/api/goal', async (req, res) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(8000) }).strict().parse(req.body);
    await tasks.create(text, { replace: true }); res.status(202).json({ ok: true, task: runtime.snapshot().task });
  });
  app.post('/api/stop', async (_req, res) => { await tasks.stopCurrent(); res.json({ ok: true }); });
  app.post('/api/resume', async (_req, res) => {
    const task = runtime.taskState().task;
    if (!task) throw new ComputerApiError('task_not_found', '当前没有可继续的任务。', 404);
    await tasks.resume(task.id); res.status(202).json({ ok: true });
  });
  app.post('/api/view', async (req, res) => {
    const { windowId } = z.object({ windowId: z.string().min(1).max(100).nullable() }).strict().parse(req.body);
    await runtime.view(windowId); res.json({ ok: true });
  });
  app.post('/api/input', async (req, res) => { await runtime.input(req.body); res.status(202).json({ ok: true }); });
  app.get('/api/trace', (_req, res) => {
    res.set('Content-Disposition', 'attachment; filename="cua-computer-trace.json"'); res.json(runtime.exportTrace());
  });
  const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
  app.get('/', (_req, res) => res.sendFile('computer.html', { root: publicDirectory }));
  for (const file of ['computer.js', 'computer.css']) app.get(`/${file}`, (_req, res) => res.sendFile(file, { root: publicDirectory }));
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    const invalid = error instanceof z.ZodError || ['entity.parse.failed', 'entity.too.large'].includes(error?.type);
    const known = error instanceof AgentError || error instanceof ComputerApiError;
    const message = invalid ? '输入格式无效。' : known ? error.message : 'Cua 操作尚未完成，请检查 Driver 会话与执行记录。';
    const status = invalid ? 400 : error instanceof ComputerApiError ? error.status : error instanceof AgentError ? 409 : 503;
    res.status(status).json({ error: req.path.startsWith('/api/v1/')
      ? { code: invalid ? 'invalid_input' : known ? error.code : 'computer_unavailable', message } : message });
  };
  app.use(errors);
  try {
    await runtime.start();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Computer HTTP address unavailable.');
    origin = `http://127.0.0.1:${address.port}`; ready = true;
  } catch (error) { tasks.close(); await runtime.close(); server.close(); throw error; }
  let closing: Promise<void> | null = null;
  return { origin, runtime, tasks, close(): Promise<void> {
    if (!closing) closing = (async () => {
      ready = false;
      try { tasks.close(); await runtime.close(); }
      finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
    })();
    return closing;
  } };
}
