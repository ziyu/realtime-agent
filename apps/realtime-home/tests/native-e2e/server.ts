// Protocol-only server. It never loads .env or contacts a model provider.
import express from 'express';
import { resolve } from 'node:path';
import { AgentRuntime } from '../../server/runtime';
import { DemoFastProvider } from '../../server/providers';
import { VoiceGateway } from '../../server/voice/gateway';
import { createApp } from '../../server/app';
import { startAudioProviderFixture } from './provider';
import { startLiveKit } from '../../server/voice/livekit';
import { realtime } from '@livekit/agents-plugin-openai';

const provider = process.env.NATIVE_TEST_LIVEKIT === '1' ? await startAudioProviderFixture() : null;
const localRoom = { url: 'ws://127.0.0.1:7880', apiKey: 'devkey', apiSecret: 'secret' };

const runtime = new AgentRuntime({ mode: 'live', fast: new DemoFastProvider(), slow: null, jevModel: 'protocol-fixture-no-real-model' });
const gateway: VoiceGateway = new VoiceGateway(runtime, {
  openaiKey: 'fixture-only-never-used', googleKey: '', xaiKey: '', livekit: provider ? localRoom : { url: '', apiKey: '', apiSecret: '' },
  models: { openai: 'gpt-realtime-2.1', duplex: 'gpt-live-1', google: 'gemini-3.8-live', xai: 'grok-voice-think-fast-2.0', backend: 'gpt-5.6-luna' },
}, async (profile, bridge, instructions, signal) => {
  if (profile.id !== 'openai-webrtc' && provider) return startLiveKit(profile, bridge, instructions, gateway.config, signal,
    async () => new realtime.RealtimeModel({ apiKey: 'fixture-model-key', baseURL: provider.baseUrl, model: 'fixture' }));
  return { connection: { kind: 'openai', ephemeralKey: 'ek_protocol_fixture_no_real_model' }, async close() {}, async interrupt() {}, async sendText() {} };
});
const app = express();
app.get('/__fixture', (_req, res) => res.json({ fixture: true, modelRequests: false }));
app.get('/__fixture/audio', (_req, res) => res.json(provider?.stats ?? {}));
app.post('/__fixture/say', express.json(), (req, res) => { provider?.say(String(req.body.text)); res.json({ ok: true }); });
app.use(createApp(runtime, { port: 3104, voice: gateway }));
app.use(express.static(resolve('dist')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
const server = app.listen(3104, '127.0.0.1', () => runtime.start());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void gateway.dispose(); provider?.close(); runtime.stop(); server.close(); server.closeAllConnections(); });
