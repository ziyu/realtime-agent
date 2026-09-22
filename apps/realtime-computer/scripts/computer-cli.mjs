#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const HELP = `Computer Use CLI

Usage:
  node scripts/computer.mjs health
  node scripts/computer.mjs capabilities
  node scripts/computer.mjs run "自然语言目标" [--wait]
  node scripts/computer.mjs run --stdin [--wait]
  node scripts/computer.mjs list
  node scripts/computer.mjs status <task-id>
  node scripts/computer.mjs wait <task-id>
  node scripts/computer.mjs stop <task-id>
  node scripts/computer.mjs resume <task-id> [--wait]
  node scripts/computer.mjs result <task-id>
  node scripts/computer.mjs trace <task-id>

Options:
  --url <origin>         Default COMPUTER_URL or http://127.0.0.1:3110
  --timeout-ms <ms>      Maximum client wait; default 300000
  --poll-ms <ms>         Status polling interval; default 500
  --request-id <key>     Idempotency-Key for run; generated when omitted
  --wait                Wait after run/resume until completed, blocked or cancelled
  --stdin               Read the goal as UTF-8 from stdin (run only)
  --json                JSON is already the default output format
  --help                Show this help

Start the service separately with pnpm dev:computer:live. No browser is required.
stdout: one JSON result. stderr: progress and JSON errors.
Exit: 0 accepted/query/completed; 1 input/API/connection error;
      2 waited task blocked/cancelled; 3 wait timed out; 130 interrupted.
Timeout and Ctrl+C stop the local wait only. Use stop <task-id> to cancel the task.
`;

class CliError extends Error {
  constructor(code, message, exitCode = 1) { super(message); this.code = code; this.exitCode = exitCode; }
}

function parseArguments(args) {
  const options = { url: process.env.COMPUTER_URL || 'http://127.0.0.1:3110', timeoutMs: 300000, pollMs: 500,
    wait: false, stdin: false, requestId: undefined, help: false };
  const positionals = [];
  const values = new Map([['--url', 'url'], ['--timeout-ms', 'timeoutMs'], ['--poll-ms', 'pollMs'], ['--request-id', 'requestId']]);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }
    if (seen.has(arg)) throw new CliError('invalid_arguments', `Repeated option: ${arg}`);
    seen.add(arg);
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--wait') options.wait = true;
    else if (arg === '--stdin') options.stdin = true;
    else if (arg === '--json') { /* Machine-readable output is the default. */ }
    else if (values.has(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new CliError('invalid_arguments', `Missing value for ${arg}`);
      const key = values.get(arg);
      options[key] = key === 'timeoutMs' || key === 'pollMs' ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
    } else throw new CliError('invalid_arguments', `Unknown option: ${arg}`);
  }
  const command = positionals.shift() || 'help';
  if (options.help || command === 'help') return { command: 'help', positionals, options };
  if (!['health', 'capabilities', 'run', 'list', 'status', 'wait', 'stop', 'resume', 'result', 'trace'].includes(command)) {
    throw new CliError('invalid_arguments', 'Unknown command. Run with --help for usage.');
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86400000
    || !Number.isSafeInteger(options.pollMs) || options.pollMs < 50 || options.pollMs > 10000) {
    throw new CliError('invalid_arguments', '--timeout-ms must be 1–86400000; --poll-ms must be 50–10000.');
  }
  if (options.wait && !['run', 'resume'].includes(command)) throw new CliError('invalid_arguments', '--wait is only supported by run and resume.');
  if (options.stdin && command !== 'run' || options.requestId !== undefined && command !== 'run') {
    throw new CliError('invalid_arguments', '--stdin and --request-id are run options.');
  }
  if (options.requestId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(options.requestId)) {
    throw new CliError('invalid_arguments', '--request-id must contain 1–128 letters, digits or . _ : -');
  }
  if (['health', 'capabilities', 'list'].includes(command) && positionals.length) throw new CliError('invalid_arguments', `${command} does not accept positional arguments.`);
  if (!['health', 'capabilities', 'list', 'run'].includes(command)
    && (positionals.length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(positionals[0]))) {
    throw new CliError('invalid_arguments', `${command} requires one task ID returned by the service.`);
  }
  if (command === 'run' && (options.stdin ? positionals.length !== 0 : positionals.length === 0)) {
    throw new CliError('invalid_arguments', 'Supply a goal or --stdin, but not both.');
  }
  return { command, positionals, options };
}

function serviceOrigin(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new CliError('invalid_url', '--url must be a loopback HTTP origin.'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new CliError('invalid_url', '--url must use localhost/127.0.0.1 HTTP, without credentials, query, fragment or path.');
  }
  return url.origin;
}

async function inputGoal(positionals, fromStdin, signal) {
  let goal;
  if (fromStdin) {
    if (process.stdin.isTTY) throw new CliError('invalid_input', '--stdin requires piped UTF-8 input.');
    const chunks = []; let length = 0;
    const cancelInput = () => process.stdin.destroy(new CliError('interrupted', 'stdin interrupted.', 130));
    signal.throwIfAborted(); signal.addEventListener('abort', cancelInput, { once: true });
    try {
      for await (const chunk of process.stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 64000) throw new CliError('invalid_input', 'stdin exceeded the goal size limit.');
        chunks.push(bytes);
      }
    } finally { signal.removeEventListener('abort', cancelInput); }
    goal = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/^\uFEFF/, '').trim();
  } else goal = positionals.join(' ').trim();
  if (!goal || goal.length > 8000) throw new CliError('invalid_input', 'The goal must contain 1–8000 characters.');
  return goal;
}

function taskFrom(body) {
  const task = body?.task;
  if (!task || typeof task.id !== 'string' || !['active', 'completed', 'blocked', 'cancelled'].includes(task.status)) {
    throw new CliError('invalid_response', 'The service did not return a valid task. Restart it with the task API version installed.');
  }
  return task;
}

/** CLI uses only HTTP. It never loads model credentials, Cua, or a desktop runtime. */
export async function main(args = process.argv.slice(2)) {
  let taskId, requestId;
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort();
  process.once('SIGINT', interrupt);
  const progress = value => process.stderr.write(`${JSON.stringify(value)}\n`);
  try {
    const { command, positionals, options } = parseArguments(args);
    if (command === 'help') { process.stdout.write(HELP); return 0; }
    const origin = serviceOrigin(options.url);
    const request = async (path, method = 'GET', body, extraHeaders = {}, timeoutMs = 10000) => {
      interrupted.signal.throwIfAborted();
      let response;
      const signal = AbortSignal.any([interrupted.signal, AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))]);
      try {
        response = await fetch(`${origin}/api/v1${path}`, { method, redirect: 'error', signal,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const reader = response.body?.getReader();
        if (!reader) throw new CliError('invalid_response', 'The service returned an empty response.');
        let bytes = 0; const chunks = [];
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            bytes += item.value.length;
            if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new CliError('response_limit', 'The response exceeded 8 MiB.'); }
            chunks.push(item.value);
          }
        } finally { reader.releaseLock(); }
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new CliError('invalid_response', 'Expected a JSON response from the Computer task API.'); }
        if (!response.ok) throw new CliError(typeof value.error?.code === 'string' ? value.error.code : `http_${response.status}`,
          typeof value.error?.message === 'string' ? value.error.message : `Computer API returned HTTP ${response.status}.`);
        return value;
      } catch (error) {
        if (error instanceof CliError) throw error;
        if (interrupted.signal.aborted) throw new CliError('interrupted', 'Local request/wait interrupted; the remote task was not cancelled.', 130);
        throw new CliError(signal.aborted ? 'request_timeout' : 'connection_failed',
          signal.aborted ? 'Computer API request timed out; its remote outcome may still be pending.'
            : 'Cannot reach the Computer API. Start pnpm dev:computer:live and check --url.');
      }
    };
    const waitForTask = async initial => {
      const deadline = performance.now() + options.timeoutMs;
      let task = initial, last = '';
      for (;;) {
        const phase = `${task.status}:${task.progress?.phase ?? ''}:${task.steps ?? 0}`;
        if (phase !== last) { progress({ event: 'progress', taskId: task.id, status: task.status, progress: task.progress, steps: task.steps }); last = phase; }
        if (task.status !== 'active') return task;
        const left = deadline - performance.now();
        if (left <= 0) throw new CliError('wait_timeout', 'Local wait timed out; the task is still available by its ID and was not cancelled.', 3);
        await delay(Math.min(options.pollMs, left), undefined, { signal: interrupted.signal });
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new CliError('wait_timeout', 'Local wait timed out; the task was not cancelled.', 3);
        try { task = taskFrom(await request(`/tasks/${encodeURIComponent(task.id)}`, 'GET', undefined, {}, Math.min(10000, remaining))); }
        catch (error) {
          if (error instanceof CliError && error.code === 'request_timeout' && performance.now() >= deadline) {
            throw new CliError('wait_timeout', 'Local wait timed out; the task was not cancelled.', 3);
          }
          throw error;
        }
      }
    };
    let output, waited = false;
    if (command === 'health' || command === 'capabilities') output = await request(`/${command}`);
    else if (command === 'list') output = await request('/tasks');
    else if (command === 'run') {
      const goal = await inputGoal(positionals, options.stdin, interrupted.signal);
      requestId = options.requestId ?? randomUUID();
      progress({ event: 'submitting', requestId });
      output = await request('/tasks', 'POST', { goal }, { 'Idempotency-Key': requestId });
      const task = taskFrom(output); taskId = task.id;
      progress({ event: 'submitted', taskId, requestId });
      if (options.wait) { output = { task: await waitForTask(task) }; waited = true; }
    } else {
      taskId = positionals[0];
      const path = `/tasks/${encodeURIComponent(taskId)}`;
      if (command === 'status') output = await request(path);
      else if (command === 'result' || command === 'trace') output = await request(`${path}/${command}`);
      else if (command === 'wait') { output = { task: await waitForTask(taskFrom(await request(path))) }; waited = true; }
      else {
        output = await request(`${path}/${command}`, 'POST', {});
        const task = taskFrom(output); taskId = task.id;
        if (command === 'resume') progress({ event: 'resumed', taskId, resumedFrom: task.resumedFrom });
        if (options.wait) { output = { task: await waitForTask(task) }; waited = true; }
      }
    }
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return waited && output.task.status !== 'completed' ? 2 : 0;
  } catch (error) {
    const failure = interrupted.signal.aborted ? new CliError('interrupted', 'Local wait interrupted; the remote task was not cancelled.', 130)
      : error instanceof CliError ? error : new CliError('invalid_input', 'The command could not be processed. Check the arguments and UTF-8 input.');
    progress({ error: { code: failure.code, message: failure.message }, ...(taskId ? { taskId } : {}), ...(requestId ? { requestId } : {}) });
    return failure.exitCode;
  } finally { process.off('SIGINT', interrupt); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
