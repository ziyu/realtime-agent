import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { apiBaseUrl, chatCompletionEndpoint, chatCompletionOptions, loadRuntimeConfig, loadVoiceConfig, systemOneEndpoint } from '../src/index.ts';

function fixture(rootEnv: string, appEnv = '') {
  mkdirSync('test-results', { recursive: true });
  const root = mkdtempSync(resolve('test-results/config-'));
  const appDirectory = join(root, 'apps/home');
  mkdirSync(appDirectory, { recursive: true });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
  writeFileSync(join(root, '.env'), rootEnv);
  writeFileSync(join(appDirectory, '.env'), appEnv);
  return { appDirectory, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('workspace SYSTEM_ONE settings select live mode and the configured LLM', () => {
  const f = fixture('SYSTEM_ONE_API_KEY=test-key\nSYSTEM_ONE_MODEL=jev-latest\nLLM_API_KEY=test-llm\nLLM_MODEL=deepseek-flash\nLLM_BASE_URL=https://api.deepseek.com');
  try {
    const c = loadRuntimeConfig({ appDirectory: f.appDirectory, defaultPort: 3102, environment: {} });
    assert.equal(c.mode, 'live'); assert.equal(c.systemOne.apiKey, 'test-key');
    assert.equal(c.llm.model, 'deepseek-flash'); assert.equal(c.port, 3102);
    assert.equal(c.dataDirectory, join(f.appDirectory, 'data'));
  } finally { f.dispose(); }
});

test('process overrides app overrides root, including legacy aliases, without changing process.env', () => {
  const f = fixture('SYSTEM_ONE_API_KEY=root-key\nSYSTEM_ONE_MODEL=root-model\nAGENT_MODE=live', 'TYPESAFE_API_KEY=app-key\nJEV_MODEL=app-model');
  try {
    const env = { AGENT_MODE: 'demo', LLM_MODEL: 'process-model' };
    const c = loadRuntimeConfig({ appDirectory: f.appDirectory, defaultPort: 3102, environment: env });
    assert.equal(c.mode, 'demo'); assert.equal(c.systemOne.apiKey, 'app-key');
    assert.equal(c.systemOne.model, 'app-model'); assert.equal(c.llm.model, 'process-model');
    assert.deepEqual(env, { AGENT_MODE: 'demo', LLM_MODEL: 'process-model' });
  } finally { f.dispose(); }
});

test('explicit empty app key masks root credentials and live without a key is rejected', () => {
  const f = fixture('SYSTEM_ONE_API_KEY=root-key', 'SYSTEM_ONE_API_KEY=');
  try {
    assert.equal(loadRuntimeConfig({ appDirectory: f.appDirectory, defaultPort: 3102, environment: {} }).mode, 'demo');
    assert.throws(() => loadRuntimeConfig({ appDirectory: f.appDirectory, defaultPort: 3102, environment: { AGENT_MODE: 'live' } }), /requires SYSTEM_ONE_API_KEY/);
  } finally { f.dispose(); }
});

test('normalizes configured endpoints without appending duplicate routes', () => {
  assert.equal(systemOneEndpoint('https://api.typesafe.ai'), 'https://api.typesafe.ai/v1/systemone');
  assert.equal(systemOneEndpoint('https://api.typesafe.ai/v1/'), 'https://api.typesafe.ai/v1/systemone');
  assert.equal(systemOneEndpoint('https://example.com/v1/systemone'), 'https://example.com/v1/systemone');
  assert.equal(chatCompletionEndpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
  assert.equal(chatCompletionEndpoint('https://example.com/v1/chat/completions'), 'https://example.com/v1/chat/completions');
});

test('DeepSeek gets its documented bounded non-thinking request options; other hosts do not', () => {
  assert.deepEqual(chatCompletionOptions('https://api.deepseek.com/v1'), { max_tokens: 1400, thinking: { type: 'disabled' } });
  assert.deepEqual(chatCompletionOptions('https://api.openai.com/v1'), { max_completion_tokens: 1400 });
  assert.deepEqual(chatCompletionOptions('https://api.deepseek.com.example/v1'), { max_completion_tokens: 1400 });
});

test('invalid URLs fail without echoing credentials', () => {
  for (const value of ['http://remote.example', 'https://user:secret-value@example.com', 'https://example.com?key=secret-value', 'bad-secret-value']) {
    assert.throws(() => apiBaseUrl(value), error => error instanceof Error && !error.message.includes('secret-value'));
  }
});

test('voice credentials remain separate from text keys and honor explicit blank overrides', () => {
  const f = fixture('LLM_API_KEY=text-only\nSYSTEM_ONE_API_KEY=body-only\nOPENAI_API_KEY=voice-root\nGOOGLE_API_KEY=google-root', 'VOICE_OPENAI_API_KEY=\nGEMINI_API_KEY=google-app');
  try {
    const c = loadVoiceConfig({ appDirectory: f.appDirectory, environment: { XAI_API_KEY: 'xai-process' } });
    assert.equal(c.openaiKey, ''); assert.equal(c.googleKey, 'google-app'); assert.equal(c.xaiKey, 'xai-process');
    assert.equal(c.models.google, 'gemini-3.8-live'); assert.equal(c.models.openai, 'gpt-realtime-2.1');
    assert.equal(c.models.duplex, 'gpt-live-1'); assert.equal(c.models.xai, 'grok-voice-think-fast-2.0');
  } finally { f.dispose(); }
});

test('LiveKit accepts loopback development and WSS without allowing credential-bearing URLs', () => {
  const f = fixture('');
  try {
    for (const url of ['ws://127.0.0.1:7880', 'wss://voice.example.com']) assert.equal(loadVoiceConfig({ appDirectory: f.appDirectory, environment: { LIVEKIT_URL: url } }).livekit.url, url);
    for (const url of ['ws://external.example.com', 'wss://user:private@example.com', 'wss://example.com?token=private']) {
      assert.throws(() => loadVoiceConfig({ appDirectory: f.appDirectory, environment: { LIVEKIT_URL: url } }), error => error instanceof Error && !error.message.includes('private'));
    }
  } finally { f.dispose(); }
});
