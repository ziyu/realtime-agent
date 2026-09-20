import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'test-results/agent-package');
mkdirSync(output, { recursive: true });
execFileSync('pnpm', ['pack', '--pack-destination', output], { cwd: join(root, 'packages/agent'), stdio: 'pipe' });
const manifest = JSON.parse(readFileSync(join(root, 'packages/agent/package.json'), 'utf8'));
const archive = join(output, `realtime-agent-agent-${manifest.version}.tgz`);
// A sibling project cannot inherit this workspace's node_modules or package configuration.
const consumer = mkdtempSync(join(dirname(root), '.realtime-agent-consumer-'));
try {
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'agent-package-consumer', private: true, type: 'module' }));
  execFileSync('npm', ['install', archive, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--cache', join(output, 'npm-cache')], { cwd: consumer, stdio: 'pipe' });
  const smoke = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { Agent, ActionRuntime, EvidenceLedger } from '@realtime-agent/agent';
    const require = createRequire(import.meta.url);
    assert.throws(() => require.resolve('@system-one-ai/sdk'));
    const state = { done: false };
    const body = new ActionRuntime({ capabilities: [{ id: 'local', prepare: () => ({ step(world) {
      world.done = true; return { status: 'completed', result: { done: true } };
    } }) }] });
    body.start({ capability: 'local' }, { epoch: 'consumer', turnId: 'one', revision: 1 }, state);
    assert.equal(body.tick(state, 0.1).status, 'completed');
    assert.equal(state.done, true);
    assert.equal(typeof Agent, 'function'); assert.equal(typeof EvidenceLedger, 'function');
    console.log('Installed ESM core executes without SDK, Home or workspace dependencies.');
  `;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', smoke], { cwd: consumer, encoding: 'utf8' });
  const installed = join(consumer, 'node_modules/@realtime-agent/agent/dist');
  const report = { result: 'passed', verifiedAt: new Date().toISOString(), version: manifest.version,
    coreOnly: true, sdkInstalled: false, declarations: readdirSync(installed).filter(file => file.endsWith('.d.ts')),
    artifact: archive, message: result.trim() };
  writeFileSync(join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { rmSync(consumer, { recursive: true, force: true }); }
