import { loadRuntimeConfig } from '@realtime-agent/config';
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { AgentRuntime } from './runtime';
import { DemoFastProvider, DemoSlowProvider, JevProvider, LanguageModelProvider } from './providers';
import { LifeStore } from './life-store';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadRuntimeConfig({ appDirectory, defaultPort: 3102 });
const { mode, port, systemOne, llm } = config;
const llmReady = Boolean(llm.apiKey && llm.model);
const memory = new LifeStore(resolve(config.dataDirectory, `life-${mode}.json`), resolve(config.dataDirectory, `memories-${mode}.json`));
const life = memory.load();
const runtime = new AgentRuntime({
  mode,
  fast: mode === 'demo' ? new DemoFastProvider() : new JevProvider(systemOne.apiKey, systemOne.model, fetch, systemOne.baseUrl),
  slow: mode === 'demo' ? new DemoSlowProvider() : llmReady ? new LanguageModelProvider(llm.baseUrl, llm.apiKey, llm.model) : null,
  jevModel: systemOne.model, llmModel: llm.model,
  memories: life.memories, mind: life.mind, persistLife: snapshot => memory.save(snapshot),
});
const app = createApp(runtime, { port });
const dist = resolve(appDirectory, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}
const server = app.listen(port, '127.0.0.1', () => {
  runtime.start();
  console.log(`RealtimeAgent world: http://127.0.0.1:${port} (${mode === 'demo' ? 'local rules demo, no model calls' : 'live Jev'})`);
});
server.on('error', error => { runtime.stop(); console.error(`World server failed: ${error.message}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  runtime.stop(); server.close(); server.closeAllConnections();
});
