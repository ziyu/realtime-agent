import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputerConfigurationError, formatComputerConfiguration, requireComputerModels, resolveComputerStartup } from '../server/startup.js';

function fixture(rootEnv?: string, appEnv?: string) {
  const directory = resolve('test-results'); mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(directory, 'computer-startup-'));
  const appDirectory = join(root, 'apps/realtime-computer');
  mkdirSync(appDirectory, { recursive: true });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
  if (rootEnv !== undefined) writeFileSync(join(root, '.env'), rootEnv);
  if (appEnv !== undefined) writeFileSync(join(appDirectory, '.env'), appEnv);
  return { root, appDirectory, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('missing files report the exact direct-mode fields and reject live startup before a device is needed', t => {
  const f = fixture(); t.after(f.dispose);
  const startup = resolveComputerStartup({ appDirectory: f.appDirectory, args: ['--live'], environment: {} });
  assert.equal(startup.ready, false);
  assert.deepEqual(startup.missing, ['SYSTEM_ONE_API_KEY', 'LLM_API_KEY', 'LLM_MODEL']);
  assert.deepEqual(startup.files, [{ path: join(f.appDirectory, '.env'), exists: false }, { path: join(f.root, '.env'), exists: false }]);
  assert.throws(() => requireComputerModels(startup), error => error instanceof ComputerConfigurationError
    && error.message.includes('LLM_MODEL') && error.message.includes(join(f.root, '.env')));
});

test('direct configuration uses the shared loader and honors file ports and explicit COMPUTER_PORT', t => {
  const f = fixture('SYSTEM_ONE_API_KEY=fixture-fast-secret\nLLM_API_KEY=fixture-slow-secret\nLLM_MODEL=fixture-model\nPORT=4111');
  t.after(f.dispose);
  const environment = { AGENT_MODE: 'demo' };
  const startup = resolveComputerStartup({ appDirectory: f.appDirectory, args: ['--live'], environment });
  assert.equal(startup.ready, true); assert.equal(startup.config?.mode, 'live'); assert.equal(startup.port, 4111);
  assert.doesNotThrow(() => requireComputerModels(startup));
  const report = formatComputerConfiguration(startup);
  for (const value of ['fixture-fast-secret', 'fixture-slow-secret', 'fixture-model']) assert.equal(report.includes(value), false);
  assert.deepEqual(environment, { AGENT_MODE: 'demo' });
  assert.equal(resolveComputerStartup({ appDirectory: f.appDirectory, args: [], environment: { COMPUTER_PORT: '4222' } }).port, 4222);
});

test('application aliases and explicit empty overrides keep their documented priority', t => {
  const f = fixture('SYSTEM_ONE_API_KEY=root-key\nLLM_API_KEY=root-llm\nLLM_MODEL=root-model', 'TYPESAFE_API_KEY=app-key\nLLM_API_KEY=');
  t.after(f.dispose);
  const startup = resolveComputerStartup({ appDirectory: f.appDirectory, args: ['--check-config'], environment: {} });
  assert.equal(startup.checkOnly, true); assert.equal(startup.config?.systemOne.apiKey, 'app-key');
  assert.deepEqual(startup.missing, ['LLM_API_KEY']);
  const override = resolveComputerStartup({ appDirectory: f.appDirectory, args: ['--live'], environment: { LLM_API_KEY: 'process-key' } });
  assert.equal(override.ready, true); assert.equal(override.config?.llm.apiKey, 'process-key');
});

test('Cloudflare requires its account ID and token rather than treating a token alone as ready', t => {
  const f = fixture('AI_PROVIDER=cloudflare\nCLOUDFLARE_API_TOKEN=cf-secret'); t.after(f.dispose);
  const incomplete = resolveComputerStartup({ appDirectory: f.appDirectory, args: ['--live'], environment: {} });
  assert.equal(incomplete.ready, false); assert.deepEqual(incomplete.missing, ['CLOUDFLARE_ACCOUNT_ID']);
  const account = '0123456789abcdef0123456789abcdef';
  const complete = resolveComputerStartup({ appDirectory: f.appDirectory, args: ['--live'], environment: { CF_ACCOUNT_ID: account } });
  assert.equal(complete.ready, true); assert.deepEqual(complete.missing, []);
  assert.equal(complete.config?.systemOne.apiKey, 'cf-secret'); assert.equal(complete.config?.llm.apiKey, 'cf-secret');
  assert.equal(formatComputerConfiguration(complete).includes('cf-secret'), false);
  assert.equal(formatComputerConfiguration(complete).includes(account), false);
  const blankToken = resolveComputerStartup({ appDirectory: f.appDirectory, args: [], environment: { CF_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: '' } });
  assert.deepEqual(blankToken.missing, ['CLOUDFLARE_API_TOKEN']);
});

test('invalid configuration gives a sanitized explanation, while explicit manual mode does not load it', t => {
  const f = fixture('LLM_BASE_URL=https://user:private-credential@example.test'); t.after(f.dispose);
  assert.throws(() => resolveComputerStartup({ appDirectory: f.appDirectory, args: ['--live'], environment: {} }), error =>
    error instanceof ComputerConfigurationError && error.message.includes('Model base URL') && !error.message.includes('private-credential'));
  const manual = resolveComputerStartup({ appDirectory: f.appDirectory, args: ['--manual'], environment: {} });
  assert.equal(manual.mode, 'manual'); assert.equal(manual.config, null);
  assert.throws(() => resolveComputerStartup({ appDirectory: f.appDirectory, args: ['--manual', '--live'], environment: {} }), ComputerConfigurationError);
});

test('the real CLI exits with actionable missing-field output; check-only accepts configured fields without starting Windows or calling models', async () => {
  const run = promisify(execFile), cwd = fileURLToPath(new URL('../', import.meta.url));
  const entry = fileURLToPath(new URL('../server/index.ts', import.meta.url));
  const env = { ...process.env, AI_PROVIDER: 'direct', AGENT_MODE: 'demo', COMPUTER_PORT: '3110', PORT: '3110',
    CLOUDFLARE_ACCOUNT_ID: '', CF_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_API_KEY: '',
    SYSTEM_ONE_API_KEY: '', TYPESAFE_API_KEY: '', SYSTEM_ONE_BASE_URL: 'https://example.test/v1', SYSTEM_ONE_MODEL: 'fixture-model',
    LLM_API_KEY: '', LLM_BASE_URL: 'https://example.test/v1', LLM_MODEL: '' };
  await assert.rejects(run(process.execPath, ['--import', 'tsx', entry, '--live'], { cwd, env, timeout: 10000 }), error => {
    const failure = error as Error & { code: number; stderr: string; stdout: string };
    assert.equal(failure.code, 1);
    assert.ok(failure.stderr.includes('SYSTEM_ONE_API_KEY、LLM_API_KEY、LLM_MODEL'));
    assert.ok(failure.stderr.includes('check:computer'));
    assert.equal(failure.stderr.includes('at ModuleJob'), false);
    assert.equal(failure.stdout.includes('Windows desktop connected'), false);
    return true;
  });
  const checked = await run(process.execPath, ['--import', 'tsx', entry, '--check-config'], { cwd, timeout: 10000,
    env: { ...env, SYSTEM_ONE_API_KEY: 'check-fast-secret', LLM_API_KEY: 'check-slow-secret', LLM_MODEL: 'check-model' } });
  assert.ok(checked.stdout.includes('模型配置已齐全'));
  for (const value of ['check-fast-secret', 'check-slow-secret', 'check-model', 'Windows desktop connected']) assert.equal(checked.stdout.includes(value), false);
  assert.equal(checked.stderr, '');
});

test('COMPUTER_VISION precedence is process environment, then app .env, then root .env, with auto as the default', t => {
  const base = 'SYSTEM_ONE_API_KEY=fast\nLLM_API_KEY=slow\nLLM_MODEL=model';
  const f = fixture(`${base}\nCOMPUTER_VISION=1`, 'COMPUTER_VISION=0'); t.after(f.dispose);
  const processOverride = resolveComputerStartup({ appDirectory: f.appDirectory, args: ['--live'], environment: { COMPUTER_VISION: 'auto' } });
  assert.equal(processOverride.visionMode, 'auto'); assert.equal(processOverride.vision, true);
  const appOverride = resolveComputerStartup({ appDirectory: f.appDirectory, args: ['--live'], environment: {} });
  assert.equal(appOverride.visionMode, 'off'); assert.equal(appOverride.vision, false);

  const rootOnly = fixture(`${base}\nCOMPUTER_VISION=1`); t.after(rootOnly.dispose);
  assert.equal(resolveComputerStartup({ appDirectory: rootOnly.appDirectory, args: ['--live'], environment: {} }).visionMode, 'required');
  const defaulted = fixture(base); t.after(defaulted.dispose);
  assert.equal(resolveComputerStartup({ appDirectory: defaulted.appDirectory, args: ['--live'], environment: {} }).visionMode, 'auto');
});
