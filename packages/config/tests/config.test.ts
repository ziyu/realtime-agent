import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { apiBaseUrl, chatCompletionEndpoint, chatCompletionOptions, loadRuntimeConfig, systemOneEndpoint } from '../src/index.ts';

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
