// Isolated opt-in verification: uses configured models but never loads or persists the user's life data.
import express from 'express';
import { resolve } from 'node:path';
import { loadRuntimeConfig, loadVoiceConfig } from '@realtime-agent/config';
import { AgentRuntime } from '../server/runtime';
import { JevProvider, LanguageModelProvider } from '../server/providers';
import { createApp } from '../server/app';
import { VoiceGateway } from '../server/voice/gateway';

const directory = resolve('.'), config = loadRuntimeConfig({ appDirectory: directory, defaultPort: 3105 });
if (config.provider !== 'cloudflare') throw new Error('Controlled voice verification requires the configured Cloudflare provider.');
let modelCalls = 0;
const requestModel: typeof fetch = async (url, init) => {
  if (++modelCalls > 16) throw new Error('Verification model budget exhausted.'); return fetch(url, init);
};
const runtime = new AgentRuntime({ mode: 'live', provider: config.provider,
  fast: new JevProvider(config.systemOne.apiKey, config.systemOne.model, requestModel, config.systemOne.baseUrl), slow: new LanguageModelProvider(config.llm.baseUrl, config.llm.apiKey, config.llm.model, requestModel) });
const voice = new VoiceGateway(runtime, loadVoiceConfig({ appDirectory: directory }));
const app = express();
app.get('/__verification', (_req, res) => res.json({ isolated: true, realJev: true, realVoice: true, modelCalls }));
app.use(createApp(runtime, { port: 3105, voice }));
app.use(express.static(resolve('dist')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
const server = app.listen(3105, '127.0.0.1', () => runtime.start());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void voice.dispose(); runtime.stop(); server.close(); server.closeAllConnections();
});
