import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'test-results/agent-package');
// Windows package-manager shims are .cmd files, not executables for execFileSync.
// Invoke their JavaScript CLI with Node and an argv array, without a shell.
function runManager(name, args, options) {
  const activeCli = process.env.npm_execpath;
  const candidates = [
    ...(activeCli && (name === 'pnpm' ? /^pnpm\.(c?js|mjs)$/.test(basename(activeCli)) : basename(activeCli) === 'npm-cli.js') ? [activeCli] : []),
    ...(name === 'npm' ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')] : []),
  ];
  const cli = candidates.find(path => existsSync(path));
  if (cli) return execFileSync(process.execPath, [cli, ...args], options);
  if (process.platform === 'win32') throw new Error(`Cannot resolve the ${name} CLI. Run this check with pnpm test:agent-package from a Node.js installation that includes npm.`);
  return execFileSync(name, args, options);
}
mkdirSync(output, { recursive: true });
runManager('pnpm', ['pack', '--pack-destination', output], { cwd: join(root, 'packages/agent'), stdio: 'pipe' });
const manifest = JSON.parse(readFileSync(join(root, 'packages/agent/package.json'), 'utf8'));
const archive = join(output, `realtime-agent-agent-${manifest.version}.tgz`);
// A sibling project cannot inherit this workspace's node_modules or package configuration.
const consumer = mkdtempSync(join(dirname(root), '.realtime-agent-consumer-'));
try {
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'agent-package-consumer', private: true, type: 'module' }));
  runManager('npm', ['install', archive, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--cache', join(output, 'npm-cache')], { cwd: consumer, stdio: 'pipe' });
  const smoke = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { Agent, ActionRuntime, EvidenceLedger, OperationRuntime, ResourceArbiter, ObservationStore, TaskLedger, Telemetry } from '@realtime-agent/agent';
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
    const arbiter = new ResourceArbiter();
    const device = new OperationRuntime({ deviceSessionId: 'consumer-device', resources: ['pointer'], arbiter,
      capabilities: [{ id: 'local-device', prepare: () => ({ maxDurationMs: 1000, interruptibility: 'immediate',
        dispatch(_world, _operation, report) { report({ sequence: 1, status: 'completed', effect: 'committed', result: { done: true } }); },
      }) }],
    });
    device.start({ capability: 'local-device' }, { epoch: 'consumer', turnId: 'one', revision: 1 }, {});
    assert.equal(device.history[0].status, 'completed'); assert.deepEqual(arbiter.snapshot(), []);
    assert.equal(typeof ObservationStore, 'function'); assert.equal(typeof TaskLedger, 'function'); assert.equal(typeof Telemetry, 'function');
    console.log('Installed ESM core executes without SDK, Home or workspace dependencies.');
  `;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', smoke], { cwd: consumer, encoding: 'utf8' });
  const installed = join(consumer, 'node_modules/@realtime-agent/agent/dist');
  const report = { result: 'passed', verifiedAt: new Date().toISOString(), version: manifest.version,
    coreOnly: true, sdkInstalled: false, declarations: readdirSync(installed).filter(file => file.endsWith('.d.ts')),
    artifact: archive, message: result.trim() };
  writeFileSync(join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  const pathFromParent = relative(dirname(root), consumer);
  if (!pathFromParent.startsWith('.realtime-agent-consumer-') || pathFromParent.includes(sep)) {
    throw new Error('Refusing to remove an unexpected consumer directory.');
  }
  rmSync(consumer, { recursive: true, force: true });
}
