import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DesktopBounds, DesktopCommand, DesktopDriver, DesktopElement, DesktopFrame, DesktopObservation, DesktopWindow } from './desktop-types.js';

const EXPECTED_MAX_AGE_MS = 2000;
const REQUEST_TIMEOUT_MS = 5000;

interface HelperError { code?: unknown; message?: unknown }
interface HelperEnvelope { id?: unknown; ok?: unknown; result?: unknown; error?: HelperError; event?: unknown }
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  onIssued?: () => void;
  issued: boolean;
  executionRisk: boolean;
  commitWritten: boolean;
}
interface RequestOptions {
  onIssued?: () => void;
  executionRisk?: boolean;
  terminateHelperOnTimeout?: boolean;
  allowClosing?: boolean;
}
export interface WindowsDriverOpenOptions {
  /** Test-only: shorten the execute deadline without changing the DesktopDriver contract. */
  executeTimeoutMs?: number;
  /** Test-only: delay an execute in the owned helper before its expiry check. */
  testDelayBeforeEffectMs?: number;
}

export class DesktopDriverError extends Error {
  constructor(readonly code: string, message: string, readonly mayHaveExecuted = false) { super(message); this.name = 'DesktopDriverError'; }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DesktopDriverError('invalid_helper_response', 'The Windows helper returned an invalid object.');
  return value as Record<string, unknown>;
}
function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new DesktopDriverError('invalid_helper_response', `The Windows helper returned an invalid ${field}.`);
  return value;
}
function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new DesktopDriverError('invalid_helper_response', `The Windows helper returned an invalid ${field}.`);
  return value;
}
function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new DesktopDriverError('invalid_helper_response', `The Windows helper returned an invalid ${field}.`);
  return value;
}
function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return stringValue(value, field);
}
function bounds(value: unknown): DesktopBounds {
  const source = record(value);
  const result = { x: integer(source.x, 'bounds.x'), y: integer(source.y, 'bounds.y'), width: integer(source.width, 'bounds.width'), height: integer(source.height, 'bounds.height') };
  if (result.width < 0 || result.height < 0) throw new DesktopDriverError('invalid_helper_response', 'The Windows helper returned negative bounds.');
  return result;
}
function windowValue(value: unknown): DesktopWindow {
  const source = record(value);
  return { id: stringValue(source.id, 'window.id'), processId: integer(source.processId, 'window.processId'), processName: stringValue(source.processName, 'window.processName'),
    title: stringValue(source.title, 'window.title'), bounds: bounds(source.bounds), minimized: booleanValue(source.minimized, 'window.minimized') };
}
function elementValue(value: unknown): DesktopElement {
  const source = record(value);
  return { id: stringValue(source.id, 'element.id'), name: stringValue(source.name, 'element.name'), role: stringValue(source.role, 'element.role'),
    bounds: bounds(source.bounds), enabled: booleanValue(source.enabled, 'element.enabled'), offscreen: booleanValue(source.offscreen, 'element.offscreen'),
    ...(source.value === undefined ? {} : { value: stringValue(source.value, 'element.value') }) };
}
function observation(value: unknown): DesktopObservation {
  const source = record(value);
  if (!Array.isArray(source.windows) || !Array.isArray(source.elements)) throw new DesktopDriverError('invalid_helper_response', 'The Windows helper returned invalid desktop collections.');
  const capturedAt = integer(source.capturedAt, 'capturedAt');
  return { id: randomUUID(), capturedAt, desktop: bounds(source.desktop), windows: source.windows.map(windowValue),
    foregroundWindowId: nullableString(source.foregroundWindowId, 'foregroundWindowId'), selectedWindowId: nullableString(source.selectedWindowId, 'selectedWindowId'),
    elements: source.elements.map(elementValue), ...(source.accessibilityError === undefined ? {} : { accessibilityError: stringValue(source.accessibilityError, 'accessibilityError') }) };
}

function expectedWindow(command: DesktopCommand, expected: DesktopObservation): DesktopWindow {
  if (expected.selectedWindowId !== command.windowId) throw new DesktopDriverError('stale_observation', 'The expected observation does not select the command window.');
  if (!Number.isFinite(expected.capturedAt) || Date.now() - expected.capturedAt > EXPECTED_MAX_AGE_MS || expected.capturedAt > Date.now() + 5000) {
    throw new DesktopDriverError('stale_observation', 'The expected desktop observation is too old.');
  }
  const target = expected.windows.find(window => window.id === command.windowId);
  if (!target) throw new DesktopDriverError('stale_observation', 'The expected window is no longer present in the observation.');
  if (target.minimized && command.kind !== 'focus') throw new DesktopDriverError('window_minimized', 'The selected window is minimized.');
  return target;
}

function normalizedCommand(command: DesktopCommand): DesktopCommand {
  if (!command || typeof command !== 'object' || typeof command.kind !== 'string' || typeof command.windowId !== 'string' || !command.windowId) {
    throw new DesktopDriverError('invalid_command', 'A desktop command and window id are required.');
  }
  if (command.kind === 'focus') return { kind: 'focus', windowId: command.windowId };
  if (command.kind === 'click') {
    if (!Number.isSafeInteger(command.x) || !Number.isSafeInteger(command.y)) throw new DesktopDriverError('invalid_command', 'Click coordinates must be physical integer pixels.');
    const button = command.button ?? 'left', clicks = command.clicks ?? 1;
    if (!['left', 'right'].includes(button) || ![1, 2].includes(clicks)) throw new DesktopDriverError('invalid_command', 'Click parameters are invalid.');
    return { kind: 'click', windowId: command.windowId, x: command.x, y: command.y, button, clicks };
  }
  if (command.kind === 'type') {
    if (typeof command.text !== 'string' || command.text.length > 4000) throw new DesktopDriverError('invalid_command', 'Typed text must be at most 4000 UTF-16 code units.');
    return { kind: 'type', windowId: command.windowId, text: command.text };
  }
  if (command.kind === 'key') {
    if (!Array.isArray(command.keys) || !command.keys.length || command.keys.length > 8 || command.keys.some(key => typeof key !== 'string' || !key.trim())) {
      throw new DesktopDriverError('invalid_command', 'A shortcut needs between one and eight named keys.');
    }
    return { kind: 'key', windowId: command.windowId, keys: [...command.keys] };
  }
  if (command.kind === 'scroll') {
    if (!Number.isSafeInteger(command.x) || !Number.isSafeInteger(command.y) || !Number.isSafeInteger(command.delta) || command.delta === 0 || Math.abs(command.delta) > 12000) {
      throw new DesktopDriverError('invalid_command', 'Scroll coordinates and delta are invalid.');
    }
    return { kind: 'scroll', windowId: command.windowId, x: command.x, y: command.y, delta: command.delta };
  }
  throw new DesktopDriverError('invalid_command', 'The desktop command is not supported.');
}

export class WindowsDriver implements DesktopDriver {
  readonly deviceSessionId = randomUUID();
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, PendingRequest>();
  private closed = false;
  private closing = false;
  private closingPromise: Promise<void> | null = null;
  private failure: Error | null = null;
  private executeTimeoutMs: number;
  private testDelayBeforeEffectMs: number;
  private constructor(child: ChildProcessWithoutNullStreams, options: WindowsDriverOpenOptions) {
    this.child = child;
    this.executeTimeoutMs = options.executeTimeoutMs ?? 7000;
    this.testDelayBeforeEffectMs = options.testDelayBeforeEffectMs ?? 0;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => this.handleLine(line));
    child.once('error', error => this.fail(new DesktopDriverError('helper_start_failed', error.message)));
    child.once('exit', (code, signal) => {
      if (!this.closed && !this.closing) this.fail(new DesktopDriverError('helper_exited', `The Windows desktop helper exited unexpectedly (${code ?? signal ?? 'unknown'}).`));
      for (const [id, request] of this.pending) {
        clearTimeout(request.timer);
        request.reject(this.requestFailure(new DesktopDriverError('helper_closed', 'The Windows desktop helper closed.'), request, true));
        this.pending.delete(id);
      }
    });
  }

  static async open(options: WindowsDriverOpenOptions = {}): Promise<WindowsDriver> {
    if (process.platform !== 'win32') throw new DesktopDriverError('unsupported_platform', 'The native computer driver requires Windows.');
    const executeTimeoutMs = options.executeTimeoutMs ?? 7000;
    const testDelayBeforeEffectMs = options.testDelayBeforeEffectMs ?? 0;
    if (!Number.isSafeInteger(executeTimeoutMs) || executeTimeoutMs < 50 || executeTimeoutMs > 30000
      || !Number.isSafeInteger(testDelayBeforeEffectMs) || testDelayBeforeEffectMs < 0 || testDelayBeforeEffectMs > 10000) {
      throw new DesktopDriverError('invalid_configuration', 'Windows driver timing options are invalid.');
    }
    const helper = fileURLToPath(new URL('./native/windows-helper.ps1', import.meta.url));
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    const driver = new WindowsDriver(child, { executeTimeoutMs, testDelayBeforeEffectMs });
    try { await driver.request('ping', {}, 20000); return driver; }
    catch (error) { await driver.close().catch(() => undefined); throw error; }
  }

  private assertOpen(allowClosing = false): void {
    if (this.failure) throw this.failure;
    if (this.closed || this.closing && !allowClosing) throw new DesktopDriverError('driver_closed', 'The Windows desktop driver is closed.');
  }
  private requestFailure(error: Error, pending: PendingRequest, useCommitBoundary: boolean): Error {
    const risk = pending.executionRisk && (useCommitBoundary ? pending.commitWritten : pending.issued);
    if (!risk) return error;
    if (error instanceof DesktopDriverError) return new DesktopDriverError(error.code, error.message, true);
    const wrapped = new DesktopDriverError('native_failure', error.message, true); wrapped.cause = error; return wrapped;
  }
  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer); request.reject(this.requestFailure(error, request, true)); this.pending.delete(id);
    }
  }
  private handleLine(line: string): void {
    let envelope: HelperEnvelope;
    try { envelope = JSON.parse(line) as HelperEnvelope; }
    catch { this.fail(new DesktopDriverError('helper_protocol', 'The Windows desktop helper returned malformed JSON.')); return; }
    if (typeof envelope.id !== 'string') { this.fail(new DesktopDriverError('helper_protocol', 'The Windows desktop helper omitted a request id.')); return; }
    const pending = this.pending.get(envelope.id);
    if (!pending) return;
    if (envelope.event === 'issued') {
      if (!pending.issued) { pending.issued = true; try { pending.onIssued?.(); } catch { /* Accounting callbacks cannot stop an OS input already issued. */ } }
      return;
    }
    clearTimeout(pending.timer); this.pending.delete(envelope.id);
    if (envelope.ok === true) { pending.resolve(envelope.result); return; }
    const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'native_failure';
    const message = typeof envelope.error?.message === 'string' ? envelope.error.message : 'The Windows desktop helper could not complete the request.';
    const explicitNoEffect = !pending.issued && (code === 'command_expired' || code === 'stale_bounds' || code === 'window_replaced'
      || code === 'window_minimized' || code === 'window_unavailable' || code === 'invalid_window');
    const error = new DesktopDriverError(code, message);
    // Once an execute commit was written, any helper-side failure not explicitly known to precede OS effects is uncertain.
    pending.reject(explicitNoEffect ? error : this.requestFailure(error, pending, true));
  }
  private request(kind: string, payload: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS, options: RequestOptions = {}): Promise<unknown> {
    this.assertOpen(options.allowClosing ?? false);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id);
        const timeout = this.requestFailure(new DesktopDriverError('helper_timeout', 'The Windows desktop helper did not answer before its deadline.'), pending, true);
        reject(timeout);
        if (options.terminateHelperOnTimeout && pending.executionRisk) {
          const stopped = new DesktopDriverError('helper_timeout', 'The Windows desktop helper was terminated after an execution deadline.');
          this.fail(stopped);
          this.child.stdin.destroy();
          if (this.child.exitCode === null) this.child.kill();
        }
      }, timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer, onIssued: options.onIssued, issued: false, executionRisk: options.executionRisk ?? false, commitWritten: false };
      this.pending.set(id, pending);
      try {
        this.child.stdin.write(`${JSON.stringify({ id, kind, ...payload })}\n`, 'utf8', error => {
          if (!error) return;
          const current = this.pending.get(id); if (!current) return;
          clearTimeout(current.timer); this.pending.delete(id);
          reject(this.requestFailure(new DesktopDriverError('helper_write_failed', 'The Windows desktop helper request could not be sent.'), current, true));
        });
        pending.commitWritten = true;
      } catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        reject(error instanceof Error ? error : new DesktopDriverError('helper_write_failed', 'The Windows desktop helper request could not be sent.'));
      }
    });
  }

  async observe(windowId: string | null = null): Promise<DesktopObservation> {
    return observation(await this.request('observe', { windowId }));
  }

  async screen(windowId: string | null = null): Promise<DesktopFrame> {
    const source = record(await this.request('screen', { windowId }, 10000));
    const pngBase64 = stringValue(source.pngBase64, 'pngBase64');
    if (pngBase64.length > 100_000_000) throw new DesktopDriverError('capture_too_large', 'The Windows helper returned an oversized screenshot.');
    const png = Buffer.from(pngBase64, 'base64');
    if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new DesktopDriverError('invalid_capture', 'The Windows helper did not return a PNG image.');
    return { png, bounds: bounds(source.bounds), capturedAt: integer(source.capturedAt, 'capturedAt') };
  }

  async execute(command: DesktopCommand, expected: DesktopObservation, signal: AbortSignal, onIssued: () => void = () => {}): Promise<DesktopObservation> {
    signal.throwIfAborted();
    const normalized = normalizedCommand(command), target = expectedWindow(normalized, expected);
    const helperExpected = { processId: target.processId, bounds: target.bounds };
    await this.request('validate', { windowId: normalized.windowId, expected: helperExpected, requireForeground: false, allowMinimized: normalized.kind === 'focus' });
    signal.throwIfAborted();
    // This is the checkpoint. Once commit is written the OS input may finish despite later cancellation; the issued event records that fact.
    const expiryMarginMs = Math.min(250, Math.max(10, Math.floor(this.executeTimeoutMs / 4)));
    const expiresAt = Date.now() + this.executeTimeoutMs - expiryMarginMs;
    return observation(await this.request('execute', {
      windowId: normalized.windowId, expected: helperExpected, command: normalized, expiresAt,
      ...(this.testDelayBeforeEffectMs ? { testDelayBeforeEffectMs: this.testDelayBeforeEffectMs } : {}),
    }, this.executeTimeoutMs, { onIssued, executionRisk: true, terminateHelperOnTimeout: true }));
  }

  async release(): Promise<void> {
    if (this.closed || this.closing) return;
    await this.request('release', {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.closingPromise) this.closingPromise = this.performClose();
    await this.closingPromise;
  }

  private async performClose(): Promise<void> {
    this.closing = true;
    try {
      if (!this.failure && this.child.exitCode === null) {
        await this.requestWhileClosing('release', {}, 2000).catch(() => undefined);
        await this.requestWhileClosing('shutdown', {}, 2000).catch(() => undefined);
      }
      try { this.child.stdin.end(); } catch { /* The helper may already have been terminated after an unsafe timeout. */ }
      if (this.child.exitCode === null) {
        const exited = once(this.child, 'exit');
        const timeout = new Promise<void>(resolve => setTimeout(resolve, 1500));
        await Promise.race([exited.then(() => undefined), timeout]);
      }
      if (this.child.exitCode === null) this.child.kill();
    } finally {
      this.closed = true; this.closing = false;
      for (const [id, request] of this.pending) {
        clearTimeout(request.timer);
        request.reject(this.requestFailure(new DesktopDriverError('driver_closed', 'The Windows desktop driver is closed.'), request, true));
        this.pending.delete(id);
      }
    }
  }

  private requestWhileClosing(kind: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.failure || this.closed || this.child.exitCode !== null) return Promise.reject(this.failure ?? new DesktopDriverError('driver_closed', 'The Windows desktop driver is closed.'));
    return this.request(kind, payload, timeoutMs, { allowClosing: true });
  }
}
