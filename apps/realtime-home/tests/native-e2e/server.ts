// Protocol-only server. It never loads .env or contacts a model provider.
import express from 'express';
import { resolve } from 'node:path';
import { AgentRuntime } from '../../server/runtime';
import { DemoFastProvider, DemoSlowProvider } from '../../server/providers';
import { VoiceGateway } from '../../server/voice/gateway';
import { createApp } from '../../server/app';
import { startAudioProviderFixture } from './provider';
import { startLiveKit } from '../../server/voice/livekit';
import { realtime } from '@livekit/agents-plugin-openai';
import { WebSocket } from 'ws';
import { startCloudflareVoice } from '../../server/voice/cloudflare';
import { initializeLogger } from '@livekit/agents';

// This isolated server only uses synthetic fixtures; production logger stays sanitized.
if (process.env.NATIVE_TEST_DEBUG === '1') initializeLogger({ pretty: false, level: 'debug' });

const useCloudflare = process.env.NATIVE_TEST_CLOUDFLARE === '1';
const cf = { accountId: '0123456789abcdef0123456789abcdef', apiToken: 'cf-protocol-fixture-token' };
const cfPath = `/client/v4/accounts/${cf.accountId}/ai/run?model=xai%2Fgrok-voice`;
const provider = process.env.NATIVE_TEST_LIVEKIT === '1' || useCloudflare
  ? await startAudioProviderFixture(useCloudflare ? { bearer: cf.apiToken, path: cfPath } : {}) : null;
const localRoom = { url: 'ws://127.0.0.1:7880', apiKey: 'devkey', apiSecret: 'secret' };

const runtime = new AgentRuntime({ mode: 'live', fast: new DemoFastProvider(), slow: new DemoSlowProvider(), jevModel: 'protocol-fixture-no-real-model' });
const gateway: VoiceGateway = new VoiceGateway(runtime, {
  ...(useCloudflare ? { provider: 'cloudflare' as const, cloudflare: cf } : {}),
  openaiKey: 'fixture-only-never-used', googleKey: '', xaiKey: '', livekit: provider ? localRoom : { url: '', apiKey: '', apiSecret: '' },
  models: { openai: 'gpt-realtime-2.1', duplex: 'gpt-live-1', google: 'gemini-3.8-live', xai: 'grok-voice-think-fast-2.0', backend: 'gpt-5.6-luna' },
}, async (profile, bridge, instructions, signal) => {
  if (useCloudflare && provider && profile.id === 'cloudflare-grok') {
    return startCloudflareVoice(profile, bridge, instructions, gateway.config, signal, (url, options) => {
      if (url !== `wss://api.cloudflare.com${cfPath}`) throw new Error('Wrong account route.');
      return new WebSocket(`${provider.baseUrl.replace(/\/v1$/, '')}${cfPath}`, options);
    });
  }
  if (profile.id !== 'openai-webrtc' && provider) return startLiveKit(profile, bridge, instructions, gateway.config, signal,
    async () => new realtime.RealtimeModel({ apiKey: 'fixture-model-key', baseURL: provider.baseUrl, model: 'fixture' }));
  return { connection: { kind: 'openai', ephemeralKey: 'ek_protocol_fixture_no_real_model' }, async close() {}, async interrupt() {}, async sendText() {} };
});
const app = express();
app.get('/__fixture', (_req, res) => res.json({ fixture: true, modelRequests: false }));
app.get('/__fixture/audio', (_req, res) => res.json(provider?.stats ?? {}));
app.post('/__fixture/say', express.json(), (req, res) => { provider?.say(String(req.body.text), req.body.partial === true); res.json({ ok: true }); });
app.post('/__fixture/mismatch', express.json(), (req, res) => { provider?.mismatch(req.body.enabled === true); res.json({ ok: true }); });
app.use(createApp(runtime, { port: 3104, voice: gateway }));
app.use(express.static(resolve('dist')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
const server = app.listen(3104, '127.0.0.1', () => runtime.start());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void gateway.dispose(); provider?.close(); runtime.stop(); server.close(); server.closeAllConnections(); });
