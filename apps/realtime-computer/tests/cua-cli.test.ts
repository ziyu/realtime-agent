import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startCuaServer } from '../server/cua-app.js';
import { ApiDesktop, apiProviders } from './cua-api-fixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cli = fileURLToPath(new URL('../../../scripts/computer.mjs', import.meta.url));
const localCli = fileURLToPath(new URL('../scripts/computer-cli.mjs', import.meta.url));

function runCli(args: string[], origin: string, input?: string, entry = cli): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, shell: false, windowsHide: true,
      env: { ...process.env, COMPUTER_URL: origin }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI fixture timed out.')); }, 15000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

test('generic CLI submits UTF-8 stdin and waits through the real HTTP task API with machine-readable output', async () => {
  const driver = new ApiDesktop(), session = await startCuaServer({ driver, providers: apiProviders(), port: 0, decisionIntervalMs: 1 });
  try {
    const health = await runCli(['health'], session.origin);
    assert.equal(health.code, 0, health.stderr); assert.equal(JSON.parse(health.stdout).apiVersion, '1');
    const goal = '请处理当前应用中的任务。\n保留中文、emoji 🌟 和完整换行。';
    const done = await runCli(['run', '--stdin', '--wait', '--poll-ms', '50', '--request-id', 'cli-utf8'], session.origin, goal);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.stdout.trim().split('\n').length, 1);
    const task = JSON.parse(done.stdout).task;
    assert.equal(task.goal, goal); assert.equal(task.status, 'completed'); assert.equal(driver.value, goal);
    assert.equal(task.result.verification, 'observed-data');
    const events = done.stderr.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.event === 'submitted' && event.taskId === task.id));
    const status = await runCli(['status', task.id, '--url', session.origin], 'http://127.0.0.1:1');
    assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).task.id, task.id);
    const result = await runCli(['result', task.id], session.origin);
    assert.equal(JSON.parse(result.stdout).result.summary, task.result.summary);
    const trace = await runCli(['trace', task.id], session.origin);
    assert.ok(JSON.parse(trace.stdout).actions.length);
    const repeated = await runCli(['run', '--stdin', '--request-id', 'cli-utf8'], session.origin, goal);
    assert.equal(repeated.code, 0); assert.equal(JSON.parse(repeated.stdout).task.id, task.id);
    assert.equal(driver.calls.filter(name => name === 'type_text').length, 1);
  } finally { await session.close(); }
});

test('CLI timeout leaves the task running; stop, resume and list address explicit task IDs', async () => {
  const session = await startCuaServer({ driver: new ApiDesktop(), providers: apiProviders('idle'), port: 0, decisionIntervalMs: 1 });
  try {
    const timed = await runCli(['run', '任意自然语言目标', '--wait', '--timeout-ms', '30', '--poll-ms', '50'], session.origin);
    assert.equal(timed.code, 3, timed.stderr); assert.equal(timed.stdout, '');
    const failure = JSON.parse(timed.stderr.trim().split('\n').at(-1)!);
    assert.equal(failure.error.code, 'wait_timeout');
    assert.equal(session.tasks.get(failure.taskId).status, 'active');
    const stopped = await runCli(['stop', failure.taskId], session.origin);
    assert.equal(stopped.code, 0); assert.equal(JSON.parse(stopped.stdout).task.status, 'cancelled');
    const waited = await runCli(['wait', failure.taskId], session.origin);
    assert.equal(waited.code, 2); assert.equal(JSON.parse(waited.stdout).task.status, 'cancelled');
    const resumed = await runCli(['resume', failure.taskId], session.origin);
    assert.equal(resumed.code, 0); const next = JSON.parse(resumed.stdout).task;
    assert.notEqual(next.id, failure.taskId); assert.equal(next.resumedFrom, failure.taskId);
    const list = await runCli(['list'], session.origin);
    assert.equal(list.code, 0); assert.equal(JSON.parse(list.stdout).tasks.length, 2);
  } finally { await session.close(); }
});

test('CLI reports blocked tasks with exit 2 and API failures as stderr-only JSON', async () => {
  const session = await startCuaServer({ driver: new ApiDesktop(), providers: apiProviders('blocked'), port: 0, decisionIntervalMs: 1 });
  try {
    const blocked = await runCli(['run', '目标需要补充信息', '--wait', '--poll-ms', '50'], session.origin);
    assert.equal(blocked.code, 2, blocked.stderr); assert.equal(JSON.parse(blocked.stdout).task.status, 'blocked');
    assert.equal(JSON.parse(blocked.stdout).task.result, null);
    const missing = await runCli(['status', randomUUID()], session.origin);
    assert.equal(missing.code, 1); assert.equal(missing.stdout, '');
    assert.equal(JSON.parse(missing.stderr).error.code, 'task_not_found');
  } finally { await session.close(); }
});

test('CLI help and validation work without loading Cua, reading configuration or starting a server', async () => {
  const origin = 'http://127.0.0.1:1';
  const help = await runCli(['--help'], origin, undefined, localCli);
  assert.equal(help.code, 0); assert.match(help.stdout, /run.*goal|自然语言目标/);
  for (const args of [['run'], ['run', 'hello', '--stdin'], ['status', '../escape'], ['list', 'extra'],
    ['run', 'hello', '--timeout-ms', 'NaN'], ['health', '--url', 'http://user:secret@localhost:3110'],
    ['health', '--url', 'https://example.test'], ['run', 'hello', '--request-id', 'with space']]) {
    const result = await runCli(args, origin);
    assert.equal(result.code, 1, `${args.join(' ')}: ${result.stderr}`); assert.equal(result.stdout, '');
    assert.ok(JSON.parse(result.stderr).error.code); assert.ok(!result.stderr.includes('secret'));
  }
  const unavailable = await runCli(['health'], origin);
  assert.equal(unavailable.code, 1); assert.equal(JSON.parse(unavailable.stderr).error.code, 'connection_failed');
});
