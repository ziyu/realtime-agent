import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { ACTIONS, isAction } from '../shared/world';
import type { AgentRuntime } from './runtime';
import { InputConflict } from './runtime';
import { VoiceError } from './voice/gateway';
import type { VoiceGateway } from './voice/gateway';

export function createApp(runtime: AgentRuntime, options: { port?: number; voice?: VoiceGateway } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Local demo only. A web page on another origin must not spend local API credits.
    if (req.method !== 'GET') {
      const origin = req.get('origin');
      const port = options.port ?? 3102;
      const allowed = ['http://127.0.0.1:5174', 'http://localhost:5174', `http://127.0.0.1:${port}`, `http://localhost:${port}`];
      if (origin && !allowed.includes(origin)) { res.status(403).json({ error: '此请求来源未获允许。' }); return; }
      if (!req.is('application/json')) { res.status(415).json({ error: '请使用 JSON 请求。' }); return; }
    }
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  if (options.voice) app.use('/api/voice', options.voice.router());
  app.get('/api/health', (_req, res) => res.json({ ok: true, mode: runtime.state.mode }));
  app.get('/api/state', (_req, res) => res.json(runtime.snapshot()));
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders(); res.write('retry: 1500\n\n');
    let pending = false;
    const send = (state: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      // Keep at most one snapshot queued; the next drain sends the latest state.
      if (res.writableNeedDrain) { pending = true; return; }
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    };
    res.on('drain', () => { if (pending) { pending = false; send(runtime.snapshot()); } });
    send(runtime.snapshot());
    const unsubscribe = runtime.subscribe(send);
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(': heartbeat\n\n'); }, 15000);
    res.on('close', () => { unsubscribe(); clearInterval(heartbeat); });
  });
  app.post('/api/messages', (req, res) => {
    if (runtime.state.nativeVoiceActive) { res.status(409).json({ error: '正在进行原生语音通话，请从通话页面发送文字，或先结束通话。' }); return; }
    const body = z.object({ text: z.string().trim().min(1).max(1200), source: z.enum(['text', 'voice', 'object']).optional(), epoch: z.uuid().optional(),
      client: z.object({ id: z.uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
    }).strict().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: '请输入 1–1200 个字符。' }); return; }
    res.status(202).json(runtime.receive(body.data));
  });
  app.post('/api/conversation/interrupt', (req, res) => {
    const body = z.object({ epoch: z.uuid(), turnId: z.uuid() }).strict().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: '无效的对话标识。' }); return; }
    res.json({ ok: true, interrupted: runtime.interruptReply(body.data.epoch, body.data.turnId) });
  });
  app.post('/api/interact', (req, res) => {
    const action: unknown = req.body?.action;
    if (typeof action !== 'string' || !isAction(action)) { res.status(400).json({ error: '未知的可交互物体。' }); return; }
    // Furniture clicks enter the same instruction path; they never directly execute an action.
    res.status(202).json(runtime.message(`请${ACTIONS[action].label}。`, 'object'));
  });
  app.post('/api/control', (req, res) => {
    const parsed = z.discriminatedUnion('type', [
      z.object({ type: z.literal('pause'), paused: z.boolean() }).strict(),
      z.object({ type: z.literal('speed'), speed: z.union([z.literal(1), z.literal(2), z.literal(4)]) }).strict(),
      z.object({ type: z.literal('reset') }).strict(),
    ]).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: '无效的世界控制指令。' }); return; }
    const body = parsed.data;
    if (body.type === 'pause') runtime.pause(body.paused);
    if (body.type === 'speed') runtime.speed(body.speed);
    if (body.type === 'reset') runtime.reset();
    res.json({ ok: true });
  });
  app.post('/api/mind/settings', (req, res) => {
    const body = z.object({ proactiveChat: z.boolean() }).strict().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: '无效的分享设置。' }); return; }
    runtime.setProactiveChat(body.data.proactiveChat);
    res.json({ ok: true });
  });
  app.post('/api/memories/forget', (req, res) => {
    const body = z.object({ id: z.string().min(1).max(100) }).strict().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: '无效的记忆。' }); return; }
    if (!runtime.forgetMemory(body.data.id)) { res.status(404).json({ error: '这条记忆已经不在了。' }); return; }
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof VoiceError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof InputConflict) { res.status(409).json({ error: error.message }); return; }
    res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: error?.type === 'entity.too.large' ? '请求内容过大。' : '请求内容无法解析。' });
  };
  app.use(errors);
  return app;
}
