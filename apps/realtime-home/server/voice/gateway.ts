import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { VoiceConfig } from '@realtime-agent/config';
import { VOICE_PROFILES } from '../../shared/voice';
import type { VoiceProfile, VoiceProfileId, VoiceSessionTicket } from '../../shared/voice';
import type { AgentRuntime } from '../runtime';
import { VoiceBridge } from './bridge';
import { voiceCatalog, voiceInstructions } from './profiles';

export interface VoiceBackend {
  connection: VoiceSessionTicket['connection'];
  interrupt(): Promise<void>;
  sendText(text: string): Promise<void>;
  close(): Promise<void>;
}
export type BackendFactory = (profile: VoiceProfile, bridge: VoiceBridge, instructions: string, signal: AbortSignal) => Promise<VoiceBackend>;
interface Lease {
  id: string; token: string; epoch: string; profile: VoiceProfile; bridge: VoiceBridge;
  controller: AbortController; touchedAt: number; backend?: VoiceBackend;
}
export class VoiceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const eventSchema = z.object({
  type: z.enum(['speech-start', 'speech-end', 'input', 'reply', 'interrupt', 'generating', 'playback-started', 'playback-blocked']),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  itemId: z.string().min(1).max(160).optional(), text: z.string().trim().min(1).max(2400).optional(),
  source: z.enum(['text', 'voice']).optional(),
}).strict().superRefine((event, ctx) => {
  if (['input', 'reply'].includes(event.type) && (!event.itemId || !event.text)) ctx.addIssue({ code: 'custom', message: 'Missing transcript.' });
  if (event.type === 'input' && event.text && event.text.length > 1200) ctx.addIssue({ code: 'custom', message: 'Input too long.' });
});

/** One leased conversation for the existing shared world; credentials never enter WorldState. */
export class VoiceGateway {
  private lease: Lease | null = null;
  private timer: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  constructor(readonly runtime: AgentRuntime, readonly config: VoiceConfig, private factory?: BackendFactory, private fetcher = fetch, private now = Date.now) {
    this.timer = setInterval(() => {
      const lease = this.lease;
      if (lease && (this.now() >= lease.bridge.state.expiresAt || this.now() - lease.touchedAt > 45000)) void this.end();
    }, 5000);
    this.timer.unref();
    this.unsubscribe = runtime.subscribe(state => {
      if (this.lease && (state.epoch !== this.lease.epoch || state.paused)) void this.end();
    });
  }
  catalog() { return voiceCatalog(this.config); }
  async create(profileId: VoiceProfileId, epoch: string): Promise<VoiceSessionTicket> {
    if (this.lease) throw new VoiceError(409, '已有一个实时通话，请先在原页面结束。');
    if (epoch !== this.runtime.state.epoch) throw new VoiceError(409, '家园已重置，请重新连接。');
    if (this.runtime.state.paused) throw new VoiceError(409, '请先继续世界，再开始通话。');
    if (this.runtime.state.mode !== 'live') throw new VoiceError(409, '原生语音需要真实模型模式，请配置 Cloudflare 账户与 API Token。');
    const profile = this.catalog().profiles.find(p => p.id === profileId);
    if (!profile) throw new VoiceError(409, '此模型不在当前凭据方案中，请使用 Cloudflare 语音方案。');
    if (!profile.configured) throw new VoiceError(503, `尚未配置：${profile.missing.join('、')}。请修改根目录 .env 并重启服务。`);
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    const expiresAt = this.now() + 15 * 60 * 1000;
    const bridge = new VoiceBridge(this.runtime, epoch, id, expiresAt, this.now);
    const lease: Lease = { id, token, epoch, profile, bridge, controller: new AbortController(), touchedAt: this.now() };
    this.lease = lease;
    this.runtime.setNativeVoice(true);
    const instructions = voiceInstructions();
    const startupDeadline = setTimeout(() => lease.controller.abort(), 20000);
    startupDeadline.unref();
    try {
      const signal = lease.controller.signal;
      let backend: VoiceBackend;
      if (this.factory) backend = await this.factory(profile, bridge, instructions, signal);
      else if (profileId === 'openai-webrtc') {
        const response = await this.fetcher('https://api.openai.com/v1/realtime/client_secrets', {
          method: 'POST', headers: { Authorization: `Bearer ${this.config.openaiKey}`, 'Content-Type': 'application/json' }, signal, redirect: 'error',
          body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 60 }, session: {
            type: 'realtime', model: profile.model, instructions,
            audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'zh' }, noise_reduction: { type: 'near_field' }, turn_detection: { type: 'semantic_vad', eagerness: 'medium', create_response: false, interrupt_response: true } }, output: { voice: profile.voice } },
          } }),
        });
        if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new VoiceError(502, `OpenAI 实时会话返回 HTTP ${response.status}，请检查账号权限、密钥和额度。`); }
        const reader = response.body?.getReader();
        if (!reader) throw new VoiceError(502, 'OpenAI 未返回实时会话凭据。');
        let text = '', bytes = 0;
        try {
          const decoder = new TextDecoder();
          for (;;) {
            signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
            bytes += chunk.value.byteLength; if (bytes > 65536) { void reader.cancel().catch(() => undefined); throw new VoiceError(502, '实时会话响应过大。'); }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
        const data = z.object({ value: z.string().startsWith('ek_').max(4096) }).safeParse(JSON.parse(text));
        if (!data.success) throw new VoiceError(502, 'OpenAI 实时临时凭据格式不正确。');
        backend = { connection: { kind: 'openai', ephemeralKey: data.data.value }, async interrupt() {}, async sendText() {}, async close() {} };
      } else if (profileId === 'cloudflare-grok') {
        const { startCloudflareVoice } = await import('./cloudflare');
        backend = await startCloudflareVoice(profile, bridge, instructions, this.config, signal);
      } else {
        const { startLiveKit } = await import('./livekit');
        backend = await startLiveKit(profile, bridge, instructions, this.config, signal);
      }
      lease.backend = backend;
      if (this.lease !== lease || signal.aborted) { await backend.close(); throw new VoiceError(409, '实时会话启动已取消。'); }
      return { id, token, epoch, profile, expiresAt, instructions, connection: backend.connection };
    } catch (error) {
      if (this.lease === lease) await this.end();
      if (error instanceof VoiceError) throw error;
      throw new VoiceError(502, '实时音频连接未建立，请检查所选模型的权限、网络及 LiveKit 服务。');
    } finally { clearTimeout(startupDeadline); }
  }
  authorize(id: string, bearer: string | undefined) {
    const lease = this.lease;
    const supplied = Buffer.from(bearer?.replace(/^Bearer /, '') ?? '');
    if (!lease || lease.id !== id || supplied.length !== lease.token.length || !timingSafeEqual(supplied, Buffer.from(lease.token))) throw new VoiceError(401, '实时会话凭据无效或已结束。');
    if (!lease.bridge.active || this.now() >= lease.bridge.state.expiresAt) { void this.end(); throw new VoiceError(409, '实时会话已结束。'); }
    return lease;
  }
  async end() {
    const lease = this.lease; if (!lease) return;
    this.lease = null; lease.controller.abort(); lease.bridge.close();
    await lease.backend?.close().catch(() => undefined);
  }
  async dispose() { clearInterval(this.timer); this.unsubscribe(); await this.end(); }
  router() {
    const router = Router();
    router.get('/catalog', (_req, res) => res.json(this.catalog()));
    router.post('/sessions', async (req, res, next) => {
      try {
        const body = z.object({ profile: z.enum(VOICE_PROFILES), epoch: z.uuid() }).strict().parse(req.body);
        const previous = this.lease;
        const pending = this.create(body.profile, body.epoch);
        const created = this.lease !== previous ? this.lease : null;
        res.on('close', () => { if (!res.writableFinished && created && this.lease === created) void this.end(); });
        res.status(201).json(await pending);
      } catch (error) { next(error); }
    });
    router.post('/sessions/:id/:action', async (req, res, next) => {
      try {
        const lease = this.authorize(req.params.id, req.get('authorization'));
        const action = req.params.action;
        if (action === 'end') { await this.end(); res.json({ ok: true }); return; }
        if (action === 'heartbeat') { lease.touchedAt = this.now(); res.json(lease.bridge.snapshot()); return; }
        if (action === 'event') {
          // LiveKit events are received in the server framework, not trusted from browser copies.
          if (lease.profile.id !== 'openai-webrtc') throw new VoiceError(409, '此通话由服务端接收转写。');
          res.json({ ok: lease.bridge.event(eventSchema.parse(req.body)) }); return;
        }
        if (action === 'observe') {
          const { sequence } = z.object({ sequence: z.number().int().nonnegative() }).strict().parse(req.body);
          res.json(await lease.bridge.observe(sequence, lease.controller.signal)); return;
        }
        if (action === 'output-plan') {
          const { sequence } = z.object({ sequence: z.number().int().nonnegative() }).strict().parse(req.body);
          const disconnected = new AbortController();
          const cancel = () => { if (!res.writableFinished) disconnected.abort(); };
          res.on('close', cancel);
          try { res.json(await lease.bridge.outputPlan(sequence, AbortSignal.any([lease.controller.signal, disconnected.signal]))); }
          finally { res.off('close', cancel); }
          return;
        }
        if (action === 'approve-output') {
          const { sequence, id, transcript } = z.object({ sequence: z.number().int().nonnegative(), id: z.string().min(1).max(160), transcript: z.string().max(2400).optional() }).strict().parse(req.body);
          res.json({ approved: lease.bridge.approveOutput(id, sequence, transcript) }); return;
        }
        if (action === 'interrupt') {
          lease.bridge.event({ type: 'interrupt', sequence: lease.bridge.state.sequence });
          await lease.backend?.interrupt(); res.json({ ok: true }); return;
        }
        if (action === 'text' && lease.profile.id !== 'openai-webrtc') {
          const { text } = z.object({ text: z.string().trim().min(1).max(1200) }).strict().parse(req.body);
          await lease.backend?.sendText(text); res.json({ ok: true }); return;
        }
        throw new VoiceError(404, '实时会话操作不存在。');
      } catch (error) { next(error); }
    });
    return router;
  }
}
