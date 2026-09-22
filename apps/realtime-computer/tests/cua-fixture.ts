import assert from 'node:assert/strict';
import { CuaDriver } from '@trycua/cua-driver';
import type { DecisionContext, DecisionResult, SlowThinker } from '@realtime-agent/agent';
import type { ComputerProviders } from '../server/cua-models.js';
import type { CuaConnection, ComputerPlan } from '../server/cua-policy.js';
import type { CuaResult, CuaTool } from '../server/cua-transport.js';

export const EDITOR_PID = 4242;
export const EDITOR_WINDOW = 1001;
export const SAVE_WINDOW = 2002;
export const BODY = '今天的待办：复核 CUA runtime';
export const FILE_NAME = 'cua-runtime-note.txt';

export async function installedToolSubset(names: readonly string[]): Promise<CuaTool[]> {
  const driver = CuaDriver.create(undefined);
  try {
    const inventory = JSON.parse(await driver.listToolsJson()) as { tools?: CuaTool[] };
    assert.ok(Array.isArray(inventory.tools));
    return names.map(name => {
      const tool = inventory.tools!.find(candidate => candidate.name === name);
      assert.ok(tool, `Installed Cua inventory is missing ${name}.`);
      return structuredClone(tool);
    });
  } finally {
    await driver.shutdown();
    if ('uniffiDestroy' in driver && typeof driver.uniffiDestroy === 'function') driver.uniffiDestroy();
  }
}

export function ok(data: unknown, text = 'ok'): CuaResult {
  return { text, data, images: [], isError: false, degraded: false };
}

export class ScriptedConnection implements CuaConnection {
  readonly metadata = { driverVersion: '0.28.2', platform: 'win32', embedded: true };
  readonly calls: Array<{ name: string; args: Record<string, unknown>; at: number }> = [];
  closed = 0;
  launched = false;
  saveDialog = false;
  saved = false;
  body = '';
  fileName = '';
  previewDelay: { started: Promise<void>; resolve(): void } | null = null;
  private previewResolve: (() => void) | null = null;

  constructor(readonly tools: CuaTool[]) {}

  delayNextDesktopPreview(): { started: Promise<void>; resolve(): void } {
    let startedResolve!: () => void;
    let resolve!: () => void;
    const started = new Promise<void>(done => { startedResolve = done; });
    const waiting = new Promise<void>(done => { resolve = done; });
    this.previewDelay = { started, resolve };
    this.previewResolve = () => { startedResolve(); void waiting; };
    (this.previewDelay as any).waiting = waiting;
    return this.previewDelay;
  }

  private windows() {
    if (!this.launched) return [];
    const editor = { window_id: EDITOR_WINDOW, pid: EDITOR_PID, app_name: 'Notepad', title: this.saved ? `${FILE_NAME} - Notepad` : 'Untitled - Notepad',
      bounds: { x: 10, y: 10, width: 800, height: 600 }, is_on_screen: true, minimized: false, z_index: this.saveDialog ? 1 : 5 };
    const dialog = { window_id: SAVE_WINDOW, pid: EDITOR_PID, app_name: 'Notepad', title: 'Save As', bounds: { x: 90, y: 80, width: 500, height: 400 },
      is_on_screen: true, minimized: false, z_index: 10 };
    return this.saveDialog ? [editor, dialog] : [editor];
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    signal?.throwIfAborted();
    this.calls.push({ name, args: structuredClone(args), at: Date.now() });
    if (name === 'list_apps') return ok({ apps: [{ pid: this.launched ? EDITOR_PID : 0, name: 'Notepad', running: this.launched, active: this.launched,
      kind: 'desktop', launch_path: 'C:\\Windows\\notepad.exe' }] });
    if (name === 'list_windows') return ok({ windows: this.windows() });
    if (name === 'get_desktop_state') {
      const delay = this.previewDelay as any;
      if (delay?.waiting) {
        this.previewDelay = null; this.previewResolve?.(); this.previewResolve = null;
        await delay.waiting; signal?.throwIfAborted();
        const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(2, 16); png.writeUInt32BE(2, 20);
        return { ...ok({ platform: 'windows', display: 'primary', screenshot_width: 2, screenshot_height: 2, screen_width: 1920, screen_height: 1080,
          scale_factor: 1, screenshot_mime_type: 'image/png' }), images: [{ mimeType: 'image/png', dataBase64: png.toString('base64') }] };
      }
      return ok({ platform: 'windows', display: 'primary', screenshot_width: 0, screenshot_height: 0, screen_width: 1920, screen_height: 1080,
        scale_factor: 1, screenshot_mime_type: 'image/png' });
    }
    if (name === 'launch_app') {
      assert.equal(args.launch_path, 'C:\\Windows\\notepad.exe'); this.launched = true;
      return ok({ pid: EDITOR_PID, windows: this.windows() });
    }
    if (name === 'get_window_state') {
      assert.equal(args.pid, EDITOR_PID);
      if (args.window_id === SAVE_WINDOW) return ok({ window_title: 'Save As', snapshot_id: 's22222222', elements: [
        { element_index: 0, element_token: 'filename-token', role: 'Edit', label: 'File name', value: this.fileName },
        { element_index: 1, element_token: 'save-token', role: 'Button', label: 'Save' },
      ] });
      assert.equal(args.window_id, EDITOR_WINDOW);
      return ok({ window_title: this.saved ? `${FILE_NAME} - Notepad` : 'Untitled - Notepad', snapshot_id: 's11111111', elements: [
        { element_index: 0, element_token: 'editor-token', role: 'Edit', label: 'Text Editor', value: this.body },
      ] });
    }
    if (name === 'type_text') {
      const target = args.target as { window_id?: number } | undefined;
      if (target?.window_id === SAVE_WINDOW) this.fileName = String(args.text ?? '');
      else { assert.equal(target?.window_id, EDITOR_WINDOW); this.body = String(args.text ?? ''); }
      return ok({ accepted: true, value: args.text });
    }
    if (name === 'hotkey') {
      assert.deepEqual(args.keys, ['ctrl', 's']); this.saveDialog = true; return ok({ accepted: true });
    }
    if (name === 'click') {
      const target = args.target as { window_id?: number } | undefined;
      assert.equal(target?.window_id, SAVE_WINDOW); assert.equal(args.element_token, 'save-token');
      assert.equal(this.fileName, FILE_NAME); this.saveDialog = false; this.saved = true; return ok({ accepted: true });
    }
    throw new Error(`Unexpected fixture tool ${name}`);
  }

  async close(): Promise<void> { this.closed++; }
}

function baseDecision(): DecisionResult {
  return { selection: { kind: 'wait' }, channels: { computer: { kind: 'wait' } }, interrupt: false, think: false, acceptProposal: false, complete: false };
}

export function pipelineProviders(planner: (state: any, context: DecisionContext) => ComputerPlan | Promise<ComputerPlan>): ComputerProviders {
  return {
    fast: { async decide(context, signal) {
      signal.throwIfAborted(); const result = baseDecision(), state = context.observation as any, channel = context.channels?.computer;
      if (channel?.current) { result.channels!.computer = { kind: 'continue' }; return result; }
      if (state.task?.status !== 'active') return result;
      if (context.proposal && !context.proposal.accepted) {
        const plan = (context.proposal.value.metadata as any)?.plan as ComputerPlan | undefined;
        result.acceptProposal = true; result.complete = !!plan?.completion;
        result.metadata = { route: plan?.completion ? 'finish' : plan?.blocked ? 'blocked' : 'accept_plan' };
        return result;
      }
      const candidate = channel?.candidates.find(item => item.selection.kind === 'execute');
      if (candidate) { result.channels!.computer = candidate.selection; result.metadata = { route: 'execute_0' }; return result; }
      if (!context.thinking) { result.think = true; result.metadata = { route: 'plan' }; }
      return result;
    } },
    slow: { async think(context, signal) {
      signal.throwIfAborted(); const state = context.observation as any, plan = await planner(state, context); signal.throwIfAborted();
      return { summary: plan.summary, suggestions: [], metadata: JSON.parse(JSON.stringify({ taskId: state.task.id, observationId: state.desktop?.id, plan })) };
    } } satisfies SlowThinker,
  };
}

export function noProgressProviders(): ComputerProviders {
  return { fast: { async decide() { return baseDecision(); } }, slow: { async think() { throw new Error('Slow thinker should not run.'); } } };
}

export async function until(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 12000): Promise<void> {
  const start = performance.now();
  while (!await check()) {
    if (performance.now() - start > timeoutMs) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
