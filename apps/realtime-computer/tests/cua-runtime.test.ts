import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionContext, DecisionResult } from '@realtime-agent/agent';
import { CuaComputerRuntime } from '../server/cua-runtime.js';
import type { ComputerPlan } from '../server/cua-policy.js';
import { BODY, EDITOR_PID, EDITOR_WINDOW, FILE_NAME, SAVE_WINDOW, ScriptedConnection, installedToolSubset, noProgressProviders, ok, pipelineProviders, until } from './cua-fixture.js';

const installed = await installedToolSubset(['list_apps', 'list_windows', 'get_desktop_state', 'launch_app', 'get_window_state', 'type_text', 'hotkey', 'click']);

const step = (tool: string, args: Record<string, unknown>, purpose: string): ComputerPlan => ({
  summary: purpose, steps: [{ tool, arguments: args, purpose }], completion: null, blocked: null,
});

test('submit starts without a selected window and completes only after launch, cross-window Save dialog, and fresh result data verification', { timeout: 30000 }, async () => {
  const connection = new ScriptedConnection(installed);
  let prematureCompletionAttempted = false;
  const providers = pipelineProviders((state: any) => {
    const actions = state.recentActions as Array<{ tool: string; arguments: Record<string, unknown>; evidenceId: string }>;
    const has = (name: string) => actions.some(action => action.tool === name);
    const lastIndex = (name: string, predicate: (action: any) => boolean = () => true) => {
      for (let i = actions.length - 1; i >= 0; i--) if (actions[i].tool === name && predicate(actions[i])) return i;
      return -1;
    };
    const editor = state.desktop.windows.find((window: any) => window.id === String(EDITOR_WINDOW));
    const dialog = state.desktop.windows.find((window: any) => window.id === String(SAVE_WINDOW));
    if (!has('launch_app')) {
      const apps = [...state.evidence].reverse().find((item: any) => item.tool === 'list_apps')?.data?.apps ?? [];
      const notepad = apps.find((app: any) => app.name === 'Notepad');
      assert.ok(notepad?.launch_path); return step('launch_app', { launch_path: notepad.launch_path }, 'launch observed Notepad');
    }
    if (lastIndex('get_window_state', action => action.arguments.window_id === EDITOR_WINDOW) < 0) {
      assert.equal(editor?.pid, EDITOR_PID); return step('get_window_state', { pid: editor.pid, window_id: EDITOR_WINDOW, max_elements: 100 }, 'inspect editor');
    }
    if (lastIndex('type_text', action => (action.arguments.target as any)?.window_id === EDITOR_WINDOW) < 0) {
      return step('type_text', { text: BODY, target: { kind: 'window', pid: EDITOR_PID, window_id: EDITOR_WINDOW }, delivery_mode: 'background' }, 'enter requested content');
    }
    if (!prematureCompletionAttempted) {
      prematureCompletionAttempted = true;
      const action = [...actions].reverse().find(item => item.tool === 'type_text')!;
      return { summary: 'input was sent but not verified', steps: [], blocked: null, completion: { summary: 'too early', checks: [
        { evidenceId: action.evidenceId, pointer: '/accepted', operator: 'equals', expected: true, description: 'action acknowledgement alone' },
      ] } };
    }
    if (!has('hotkey')) return step('hotkey', { keys: ['ctrl', 's'], target: { kind: 'window', pid: EDITOR_PID, window_id: EDITOR_WINDOW }, delivery_mode: 'background' }, 'open Save dialog');
    if (lastIndex('get_window_state', action => action.arguments.window_id === SAVE_WINDOW) < 0) {
      assert.ok(dialog, 'Save dialog must be discovered from the refreshed real window list.');
      return step('get_window_state', { pid: dialog.pid, window_id: SAVE_WINDOW, max_elements: 100 }, 'inspect Save dialog');
    }
    if (lastIndex('type_text', action => (action.arguments.target as any)?.window_id === SAVE_WINDOW) < 0) {
      return step('type_text', { text: FILE_NAME, target: { kind: 'window', pid: EDITOR_PID, window_id: SAVE_WINDOW }, element_token: 'filename-token', delivery_mode: 'background' }, 'enter filename');
    }
    if (!has('click')) return step('click', { target: { kind: 'window', pid: EDITOR_PID, window_id: SAVE_WINDOW }, element_token: 'save-token', delivery_mode: 'background' }, 'save file');
    const clickIndex = lastIndex('click');
    const finalInspect = lastIndex('get_window_state', action => action.arguments.window_id === EDITOR_WINDOW);
    if (finalInspect < clickIndex) return step('get_window_state', { pid: EDITOR_PID, window_id: EDITOR_WINDOW, max_elements: 100 }, 'read saved editor state');
    const evidence = [...state.evidence].reverse().find((item: any) => item.tool === 'get_window_state' && item.data?.window_title?.includes(FILE_NAME));
    assert.ok(evidence, 'Completion must cite the fresh saved editor observation.');
    return { summary: 'saved content verified', steps: [], blocked: null, completion: { summary: 'saved and verified', checks: [
      { evidenceId: evidence.id, pointer: '/elements/0/value', operator: 'equals', expected: BODY, description: 'saved document content' },
      { evidenceId: evidence.id, pointer: '/window_title', operator: 'contains', expected: FILE_NAME, description: 'saved filename in window title' },
    ] } };
  });
  const runtime = new CuaComputerRuntime(connection, providers, null, { decisionIntervalMs: 10, progressTimeoutMs: 10000 });
  try {
    await runtime.start();
    assert.equal(runtime.snapshot().viewWindowId, null);
    await runtime.submit(`Open Notepad, write ${BODY}, save as ${FILE_NAME}, and verify it.`);
    await until(() => runtime.snapshot().task?.status === 'completed', 'CUA pipeline did not complete.', 20000);
    const state = runtime.snapshot();
    assert.equal(state.task?.status, 'completed');
    assert.equal(connection.saved, true); assert.equal(connection.body, BODY); assert.equal(connection.fileName, FILE_NAME);
    assert.ok(prematureCompletionAttempted);
    assert.ok(state.history.some(event => event.type === 'replan' && event.detail.includes('完成证据不匹配')),
      'An admitted input acknowledgement must not establish business completion.');
    assert.ok(connection.calls.some(call => call.name === 'launch_app'));
    assert.ok(connection.calls.some(call => call.name === 'get_window_state' && call.args.window_id === SAVE_WINDOW), 'Planner must cross into the Save dialog window.');
    assert.ok(state.task!.evidenceIds.length >= 1);
  } finally { await runtime.close(); }
});

test('preview I/O serializes with submit discovery instead of racing the new task observation', { timeout: 15000 }, async () => {
  const tools = await installedToolSubset(['list_apps', 'list_windows', 'get_desktop_state']);
  const connection = new ScriptedConnection(tools), runtime = new CuaComputerRuntime(connection, noProgressProviders(), null, { decisionIntervalMs: 20 });
  try {
    await runtime.start();
    const gate = connection.delayNextDesktopPreview();
    const preview = runtime.screen();
    await gate.started;
    const before = connection.calls.filter(call => call.name === 'list_apps').length;
    const submitted = runtime.submit('A new goal that must wait for the preview I/O boundary.');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(connection.calls.filter(call => call.name === 'list_apps').length, before, 'submit discovery raced the in-flight preview read');
    gate.resolve();
    const frame = await preview; assert.equal(frame.width, 2); assert.equal(frame.height, 2);
    await submitted;
    await until(() => connection.calls.filter(call => call.name === 'list_apps').length > before, 'submit discovery did not resume after preview I/O.');
    assert.equal(runtime.snapshot().task?.status, 'active');
  } finally { await runtime.close(); }
});

test('a slow proposal from the superseded goal is discarded before it can execute', { timeout: 12000 }, async () => {
  const tools = await installedToolSubset(['list_windows']);
  const connection = new ScriptedConnection(tools);
  let startedResolve!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { startedResolve = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const idle = (): DecisionResult => ({ selection: { kind: 'wait' }, channels: { computer: { kind: 'wait' } }, interrupt: false, think: false, acceptProposal: false, complete: false });
  const providers = {
    fast: { async decide(context: DecisionContext) {
      const result = idle(), state = context.observation as any;
      if (state.task?.text === 'replacement goal') return result;
      if (context.proposal && !context.proposal.accepted) { result.acceptProposal = true; result.metadata = { route: 'accept_plan' }; return result; }
      const candidate = context.channels?.computer.candidates.find(item => item.selection.kind === 'execute');
      if (candidate) { result.channels!.computer = candidate.selection; return result; }
      if (!context.thinking) result.think = true;
      return result;
    } },
    slow: { async think(context: DecisionContext) {
      const state = context.observation as any; startedResolve(); await gate;
      const plan = step('list_windows', {}, 'old proposal should never execute');
      return { summary: plan.summary, suggestions: [], metadata: JSON.parse(JSON.stringify({ taskId: state.task.id, plan })) };
    } },
  };
  const runtime = new CuaComputerRuntime(connection, providers, null, { decisionIntervalMs: 10 });
  try {
    await runtime.start(); await runtime.submit('old goal'); await started;
    const oldId = runtime.snapshot().task!.id;
    await runtime.submit('replacement goal'); release();
    await new Promise(resolve => setTimeout(resolve, 150));
    const state = runtime.snapshot();
    assert.notEqual(state.task?.id, oldId); assert.equal(state.task?.text, 'replacement goal'); assert.equal(state.task?.status, 'active');
    assert.equal(runtime.exportTrace().actions.length, 0, 'A superseded slow proposal reached the execution channel.');
  } finally { await runtime.close(); }
});

test('an old proposal is discarded and a late old-task evidence result cannot complete the replacement task', { timeout: 20000 }, async () => {
  const tools = await installedToolSubset(['list_windows', 'get_window_state']);
  let lateStartedResolve!: () => void, releaseLate!: () => void, lateAborted = false;
  const lateStarted = new Promise<void>(resolve => { lateStartedResolve = resolve; });
  const lateResult = new Promise<void>(resolve => { releaseLate = resolve; });
  class LateConnection extends ScriptedConnection {
    constructor() { super(tools); this.launched = true; }
    override async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      if (name !== 'get_window_state') return super.call(name, args, signal);
      this.calls.push({ name, args: structuredClone(args), at: Date.now() }); lateStartedResolve();
      signal?.addEventListener('abort', () => { lateAborted = true; }, { once: true });
      await lateResult;
      return ok({ window_title: 'late-old.txt - Notepad', elements: [{ value: 'LATE-OLD' }] });
    }
  }
  const connection = new LateConnection();
  let newCompletionAttempted = false;
  const providers = pipelineProviders((state: any) => {
    if (state.task.text === 'old task') return step('get_window_state', { pid: EDITOR_PID, window_id: EDITOR_WINDOW }, 'old observation that will return late');
    const late = state.evidence.find((item: any) => item.tool === 'get_window_state' && item.data?.elements?.[0]?.value === 'LATE-OLD');
    if (late && !newCompletionAttempted) {
      newCompletionAttempted = true;
      return { summary: 'must reject old evidence', steps: [], blocked: null, completion: { summary: 'wrong scope', checks: [
        { evidenceId: late.id, pointer: '/elements/0/value', operator: 'equals', expected: 'LATE-OLD', description: 'old task evidence' },
      ] } };
    }
    return step('list_windows', {}, 'keep new task active after rejecting old evidence');
  });
  const runtime = new CuaComputerRuntime(connection, providers, null, { decisionIntervalMs: 10, progressTimeoutMs: 10000 });
  try {
    await runtime.start(); await runtime.submit('old task');
    await lateStarted;
    const oldId = runtime.snapshot().task!.id;
    const replacement = runtime.submit('new task');
    await until(() => lateAborted, 'Old operation was not cancelled by the replacement input.');
    releaseLate(); await replacement;
    await until(() => newCompletionAttempted, 'Replacement planner did not see the late evidence for scope validation.');
    await until(() => runtime.snapshot().history.some(event => event.type === 'replan' && event.detail.includes('完成证据不匹配')), 'Old evidence was not rejected.');
    const state = runtime.snapshot();
    assert.notEqual(state.task?.id, oldId); assert.equal(state.task?.status, 'active');
    const trace = runtime.exportTrace();
    const late = trace.evidence.find((item: any) => item.tool === 'get_window_state' && item.data?.elements?.[0]?.value === 'LATE-OLD');
    assert.equal(late?.taskId, oldId, 'Late evidence must retain the original task identity.');
    const lateAction = trace.actions.find((item: any) => item.evidenceId === late?.id);
    assert.equal(lateAction?.taskId, oldId, 'Late trace must retain the original task identity.');
  } finally { await runtime.stop().catch(() => undefined); await runtime.close(); }
});

test('verify_file reads only an explicitly authorized absolute path and does not authorize a path prefix', async () => {
  const connection = new ScriptedConnection([]), runtime = new CuaComputerRuntime(connection, null);
  const root = await mkdtemp(join(tmpdir(), 'cua-runtime-file-'));
  const exact = join(root, 'report.txt'), longer = `${exact}.bak`;
  await writeFile(exact, 'authorized-content', 'utf8'); await writeFile(longer, 'other-content', 'utf8');
  const verifyFile = (runtime as any).verifyFile.bind(runtime) as (args: Record<string, unknown>, goal: string, signal: AbortSignal) => Promise<any>;
  try {
    const unauthorized = await verifyFile({ path: exact }, `Save the requested document to "${longer}".`, new AbortController().signal);
    assert.equal(unauthorized.isError, true); assert.equal(unauthorized.errorCode, 'verification_path');
    const result = await verifyFile({ path: exact }, `Save the requested document to "${exact}".`, new AbortController().signal);
    assert.equal(result.isError, false); assert.equal(result.data.text, 'authorized-content'); assert.match(result.data.sha256, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(exact, 'utf8'), 'authorized-content');
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('background_unavailable only offers the same foreground operation to System One and never auto-dispatches it', { timeout: 12000 }, async () => {
  const tools = await installedToolSubset(['list_windows', 'hotkey']);
  const target = { kind: 'window', pid: EDITOR_PID, window_id: EDITOR_WINDOW };
  let foregroundCandidate: any = null;
  class BackgroundUnavailableConnection extends ScriptedConnection {
    override async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      if (name !== 'hotkey') return super.call(name, args, signal);
      signal?.throwIfAborted(); this.calls.push({ name, args: structuredClone(args), at: Date.now() });
      return { text: 'background unavailable', data: { status: 'background_unavailable' }, images: [], isError: true,
        errorCode: 'background_unavailable', degraded: false };
    }
  }
  const connection = new BackgroundUnavailableConnection(tools);
  const backgroundPlan = step('hotkey', { keys: ['ctrl', 's'], target, delivery_mode: 'background' }, 'save document');
  const idle = (): DecisionResult => ({ selection: { kind: 'wait' }, channels: { computer: { kind: 'wait' } }, interrupt: false, think: false, acceptProposal: false, complete: false });
  const providers = {
    fast: { async decide(context: DecisionContext) {
      const result = idle();
      if (context.proposal && !context.proposal.accepted) { result.acceptProposal = true; result.metadata = { route: 'accept_plan' }; return result; }
      const candidate = context.channels?.computer.candidates.find(item => item.selection.kind === 'execute');
      if (candidate?.selection.kind === 'execute') {
        const binding = candidate.selection.call.input as any;
        if (binding.step.arguments.delivery_mode === 'foreground') { foregroundCandidate = structuredClone(candidate); return result; }
        result.channels!.computer = candidate.selection; return result;
      }
      if (!context.thinking) { result.think = true; result.metadata = { route: 'plan' }; }
      return result;
    } },
    slow: { async think(context: DecisionContext) {
      const state = context.observation as any;
      return { summary: backgroundPlan.summary, suggestions: [], metadata: JSON.parse(JSON.stringify({ taskId: state.task.id, plan: backgroundPlan })) };
    } },
  };
  const runtime = new CuaComputerRuntime(connection, providers, null, { decisionIntervalMs: 10, progressTimeoutMs: 10000 });
  try {
    await runtime.start(); await runtime.submit('save the current document');
    await until(() => foregroundCandidate !== null, 'foreground alternative was not exposed to System One');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(connection.calls.filter(call => call.name === 'hotkey').length, 1, 'foreground fallback was dispatched without a new System One choice');
    const stepInput = foregroundCandidate.selection.call.input.step;
    assert.deepEqual(stepInput.arguments.target, target); assert.deepEqual(stepInput.arguments.keys, ['ctrl', 's']);
    assert.equal(stepInput.arguments.delivery_mode, 'foreground');
    assert.match(stepInput.purpose, /同一目标|前台输入/);
  } finally { await runtime.stop().catch(() => undefined); await runtime.close(); }
});

test('permission errors block instead of offering a foreground fallback', { timeout: 12000 }, async () => {
  const tools = await installedToolSubset(['list_windows', 'hotkey']);
  let foregroundCandidate = false;
  class PermissionConnection extends ScriptedConnection {
    override async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      if (name !== 'hotkey') return super.call(name, args, signal);
      signal?.throwIfAborted(); this.calls.push({ name, args: structuredClone(args), at: Date.now() });
      return { text: 'permission denied', data: null, images: [], isError: true, errorCode: 'permission_denied', degraded: false };
    }
  }
  const connection = new PermissionConnection(tools);
  const plan = step('hotkey', { keys: ['ctrl', 's'], target: { kind: 'window', pid: EDITOR_PID, window_id: EDITOR_WINDOW }, delivery_mode: 'background' }, 'save document');
  const idle = (): DecisionResult => ({ selection: { kind: 'wait' }, channels: { computer: { kind: 'wait' } }, interrupt: false, think: false, acceptProposal: false, complete: false });
  const providers = {
    fast: { async decide(context: DecisionContext) {
      const result = idle();
      if (context.proposal && !context.proposal.accepted) { result.acceptProposal = true; return result; }
      const candidate = context.channels?.computer.candidates.find(item => item.selection.kind === 'execute');
      if (candidate?.selection.kind === 'execute') {
        const binding = candidate.selection.call.input as any;
        if (binding.step.arguments.delivery_mode === 'foreground') { foregroundCandidate = true; return result; }
        result.channels!.computer = candidate.selection; return result;
      }
      if (!context.thinking) result.think = true;
      return result;
    } },
    slow: { async think(context: DecisionContext) {
      const state = context.observation as any;
      return { summary: plan.summary, suggestions: [], metadata: JSON.parse(JSON.stringify({ taskId: state.task.id, plan })) };
    } },
  };
  const runtime = new CuaComputerRuntime(connection, providers, null, { decisionIntervalMs: 10, progressTimeoutMs: 10000 });
  try {
    await runtime.start(); await runtime.submit('save the current document');
    await until(() => runtime.snapshot().task?.status === 'blocked', 'permission error did not block the task');
    assert.equal(foregroundCandidate, false); assert.equal(connection.calls.filter(call => call.name === 'hotkey').length, 1);
    assert.match(runtime.snapshot().error ?? '', /permission denied/i);
  } finally { await runtime.close(); }
});
