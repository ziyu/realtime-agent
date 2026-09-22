import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const START_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;
const CANCEL_SETTLE_MS = 1_500;
const CLOSE_TIMEOUT_MS = 3_000;
const MAX_PROTOCOL_LINE_CHARS = 40 * 1024 * 1024;
const MAX_TOOLS = 256;

export interface CuaTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface CuaResult {
  text: string;
  data: unknown;
  images: Array<{ mimeType: string; dataBase64: string }>;
  isError: boolean;
  errorCode?: string;
  verified?: boolean;
  degraded?: boolean;
}

export class CuaTransportError extends Error {
  constructor(readonly code: string, message: string, readonly mayHaveExecuted = false) { super(message); this.name = 'CuaTransportError'; }
}

export interface CuaWire {
  start(): Promise<{ tools: CuaTool[]; metadata: Record<string, unknown> }>;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult>;
  close(): Promise<void>;
}
export type CuaConnection = CuaWire;

export interface CuaTransportOpenOptions {
  wire?: CuaConnection;
  timeoutMs?: number;
  callTimeoutMs?: number;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CuaTransportError('cua_protocol', `Cua transport returned invalid ${field}.`);
  return value as Record<string, unknown>;
}

function parseTools(inventory: unknown): CuaTool[] {
  const source = object(inventory, 'tool inventory');
  if (!Array.isArray(source.tools) || source.tools.length > MAX_TOOLS) throw new CuaTransportError('cua_protocol', 'Cua Driver returned an invalid tool inventory.');
  const names = new Set<string>();
  return source.tools.map((entry, index) => {
    const tool = object(entry, `tool ${index}`), name = tool.name, description = tool.description, inputSchema = tool.inputSchema;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(name) || names.has(name)
      || typeof description !== 'string' || description.length > 100_000 || !inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
      throw new CuaTransportError('cua_protocol', 'Cua Driver returned an invalid tool definition.');
    }
    names.add(name);
    return { name, description, inputSchema: structuredClone(inputSchema as Record<string, unknown>) };
  });
}

function parseResult(value: unknown): CuaResult {
  const result = object(value, 'tool result');
  if (typeof result.text !== 'string' || typeof result.isError !== 'boolean' || !Array.isArray(result.images)) throw new CuaTransportError('cua_protocol', 'Cua Driver returned an invalid tool result.');
  const images = result.images.map(imageValue => {
    const image = object(imageValue, 'image');
    if (typeof image.mimeType !== 'string' || typeof image.dataBase64 !== 'string') throw new CuaTransportError('cua_protocol', 'Cua Driver returned an invalid image result.');
    return { mimeType: image.mimeType, dataBase64: image.dataBase64 };
  });
  return { text: result.text, data: result.data ?? null, images, isError: result.isError,
    ...(typeof result.errorCode === 'string' ? { errorCode: result.errorCode } : {}),
    ...(typeof result.verified === 'boolean' ? { verified: result.verified } : {}),
    ...(typeof result.degraded === 'boolean' ? { degraded: result.degraded } : {}) };
}

interface Pending {
  resolve(value: CuaResult): void;
  reject(error: Error): void;
  sent: boolean;
  settled: boolean;
}

function childEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    const cuaPolicy = upper.startsWith('CUA_') || upper.startsWith('TRYCUA_');
    const secretLike = /(?:^|_)(?:API_?KEY|API_?TOKEN|ACCESS_?TOKEN|AUTH_?TOKEN|TOKEN|SECRET|PASSWORD)(?:$|_)/.test(upper)
      || /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(upper);
    const modelProvider = /^(?:SYSTEM_ONE|TYPESAFE|LLM|OPENAI|VOICE_OPENAI|ANTHROPIC|GEMINI|GOOGLE|XAI|DEEPSEEK|MISTRAL|GROQ|COHERE|TOGETHER|PERPLEXITY|AZURE_OPENAI|CLOUDFLARE|LIVEKIT)_/.test(upper);
    if (!cuaPolicy && (modelProvider && secretLike || /(?:API_?KEY|API_?TOKEN|ACCESS_?TOKEN|AUTH_?TOKEN)$/.test(upper))) continue;
    result[key] = value;
  }
  return result;
}

class ChildCuaWire implements CuaWire {
  private child: ChildProcessWithoutNullStreams;
  private ready: Promise<{ tools: CuaTool[]; metadata: Record<string, unknown> }>;
  private readyResolve!: (value: { tools: CuaTool[]; metadata: Record<string, unknown> }) => void;
  private readyReject!: (error: Error) => void;
  private pending = new Map<string, Pending>();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor() {
    const worker = fileURLToPath(new URL('./cua-native-worker.mjs', import.meta.url));
    this.child = spawn(process.execPath, [worker], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment(process.env) });
    this.child.stderr.resume();
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => this.onLine(line));
    this.child.once('error', error => this.fail(new CuaTransportError('cua_worker_start', error.message)));
    this.child.once('exit', (code, signal) => {
      if (!this.closed) this.fail(new CuaTransportError('cua_worker_exit', `Cua native worker exited unexpectedly (${code ?? signal ?? 'unknown'}).`));
    });
  }

  private uncertain(error: Error, pending: Pending): Error {
    if (!pending.sent) return error;
    if (error instanceof CuaTransportError) return new CuaTransportError(error.code, error.message, true);
    return new CuaTransportError('cua_worker_failure', error.message, true);
  }

  private fail(error: Error): void {
    this.readyReject(error);
    for (const [id, pending] of this.pending) {
      if (!pending.settled) { pending.settled = true; pending.reject(this.uncertain(error, pending)); }
      this.pending.delete(id);
    }
  }

  private onLine(line: string): void {
    if (line.length > MAX_PROTOCOL_LINE_CHARS) { this.fail(new CuaTransportError('cua_output_too_large', 'Cua native worker response exceeded its limit.')); void this.terminate(); return; }
    let message: Record<string, unknown>;
    try { message = object(JSON.parse(line), 'worker message'); }
    catch (error) { this.fail(error instanceof Error ? error : new CuaTransportError('cua_protocol', 'Cua native worker returned malformed JSON.')); void this.terminate(); return; }
    if (message.type === 'ready') {
      try { this.readyResolve({ tools: parseTools(message.inventory), metadata: structuredClone(object(message.metadata, 'metadata')) }); }
      catch (error) { this.readyReject(error instanceof Error ? error : new CuaTransportError('cua_protocol', 'Cua native worker startup failed.')); void this.terminate(); }
      return;
    }
    if (message.type === 'fatal') {
      const error = object(message.error, 'fatal error');
      this.fail(new CuaTransportError(typeof error.code === 'string' ? error.code : 'cua_worker_start', typeof error.message === 'string' ? error.message : 'Cua native worker failed to start.'));
      return;
    }
    if (typeof message.id !== 'string') return;
    const pending = this.pending.get(message.id); if (!pending || pending.settled) return;
    pending.settled = true; this.pending.delete(message.id);
    if (message.ok === true) {
      try { pending.resolve(parseResult(message.result)); }
      catch (error) { pending.reject(this.uncertain(error as Error, pending)); }
      return;
    }
    const error = object(message.error, 'call error');
    const code = typeof error.code === 'string' ? error.code : 'cua_native_error';
    const text = typeof error.message === 'string' ? error.message : 'Cua Driver call failed.';
    const completion = typeof error.completion === 'number' && Number.isInteger(error.completion) ? error.completion : undefined;
    const mayHaveExecuted = completion === 0 ? false : completion === 1 || completion === 2 ? true : pending.sent;
    pending.reject(new CuaTransportError(code, text, mayHaveExecuted));
  }

  async start(): Promise<{ tools: CuaTool[]; metadata: Record<string, unknown> }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CuaTransportError('cua_start_timeout', 'Cua native worker did not become ready.')), START_TIMEOUT_MS); });
    try { return await Promise.race([this.ready, timeout]); }
    catch (error) { await this.terminate(); throw error; }
    finally { if (timer) clearTimeout(timer); }
  }

  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    if (this.closed) return Promise.reject(new CuaTransportError('cua_closed', 'Cua transport is closed.'));
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject, sent: false, settled: false };
      this.pending.set(id, pending);
      const abort = () => {
        if (pending.settled) return;
        try { this.child.stdin.write(`${JSON.stringify({ kind: 'cancel', id })}\n`); } catch { }
      };
      signal?.addEventListener('abort', abort, { once: true });
      const doneResolve = (value: CuaResult) => { signal?.removeEventListener('abort', abort); resolve(value); };
      const doneReject = (error: Error) => { signal?.removeEventListener('abort', abort); reject(error); };
      pending.resolve = doneResolve; pending.reject = doneReject;
      try {
        this.child.stdin.write(`${JSON.stringify({ kind: 'call', id, name, args })}\n`, 'utf8', error => {
          if (!error) return;
          const current = this.pending.get(id); if (!current || current.settled) return;
          current.settled = true; this.pending.delete(id); doneReject(this.uncertain(new CuaTransportError('cua_worker_write', 'Cua native worker request could not be sent.'), current));
        });
        pending.sent = true;
      } catch (error) {
        pending.settled = true; this.pending.delete(id);
        doneReject(error instanceof TypeError
          ? new CuaTransportError('cua_arguments', 'Cua Driver arguments must be JSON serializable.')
          : error instanceof Error ? error : new CuaTransportError('cua_worker_write', 'Cua native worker request could not be sent.'));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.terminate();
    return this.closePromise;
  }

  private async terminate(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.write(`${JSON.stringify({ kind: 'close' })}\n`); } catch { }
    const exit = this.child.exitCode === null ? once(this.child, 'exit').then(() => undefined).catch(() => undefined) : Promise.resolve();
    await Promise.race([exit, new Promise<void>(resolve => setTimeout(resolve, CLOSE_TIMEOUT_MS))]);
    if (this.child.exitCode === null) this.child.kill();
    try { this.child.stdin.end(); } catch { }
    this.fail(new CuaTransportError('cua_closed', 'Cua transport is closed.'));
  }
}

export class CuaTransport {
  readonly tools: CuaTool[];
  readonly metadata: Record<string, unknown>;
  private active = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private constructor(private wire: CuaWire, ready: { tools: CuaTool[]; metadata: Record<string, unknown> }, private callTimeoutMs: number) {
    this.tools = structuredClone(ready.tools); this.metadata = structuredClone(ready.metadata);
  }

  static async open(options: CuaTransportOpenOptions = {}): Promise<CuaTransport> {
    const timeout = options.timeoutMs ?? options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300_000) throw new CuaTransportError('cua_configuration', 'Cua call timeout is invalid.');
    const wire = options.wire ?? new ChildCuaWire();
    const ready = await wire.start();
    return new CuaTransport(wire, ready, timeout);
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    if (this.closed) throw new CuaTransportError('cua_closed', 'Cua transport is closed.');
    signal?.throwIfAborted();
    if (this.active) throw new CuaTransportError('cua_busy', 'Only one Cua Driver call may be active at a time.');
    if (!this.tools.some(tool => tool.name === name)) throw new CuaTransportError('cua_unknown_tool', 'The requested Cua Driver tool is not in the discovered inventory.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CuaTransportError('cua_arguments', 'Cua Driver arguments must be an object.');
    this.active = true;
    const timeoutController = new AbortController();
    const combined = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    const timer = setTimeout(() => timeoutController.abort(new CuaTransportError('cua_timeout', 'Cua Driver call timed out.', true)), this.callTimeoutMs);
    let rejectAbort!: (error: Error) => void;
    const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new CuaTransportError(
        timeoutController.signal.aborted ? 'cua_timeout' : 'cua_cancelled',
        timeoutController.signal.aborted ? 'Cua Driver call timed out.' : 'Cua Driver call was cancelled.', true));
    combined.addEventListener('abort', onAbort, { once: true });
    let wirePromise: Promise<CuaResult>;
    try { wirePromise = this.wire.call(name, structuredClone(args), combined); }
    catch (error) { wirePromise = Promise.reject(error); }
    try {
      const result = await Promise.race([
        wirePromise,
        abortPromise,
      ]);
      return structuredClone(result);
    } catch (error) {
      if (combined.aborted) {
        const settled = await Promise.race([
          wirePromise.then(result => ({ kind: 'result' as const, result }), wireError => ({ kind: 'error' as const, error: wireError })),
          new Promise<{ kind: 'timeout' }>(resolve => setTimeout(() => resolve({ kind: 'timeout' }), CANCEL_SETTLE_MS)),
        ]);
        if (settled.kind === 'result') return structuredClone(settled.result);
        if (settled.kind === 'error') {
          if (settled.error instanceof CuaTransportError) throw settled.error;
          throw new CuaTransportError(timeoutController.signal.aborted ? 'cua_timeout' : 'cua_cancelled',
            timeoutController.signal.aborted ? 'Cua Driver call timed out.' : 'Cua Driver call was cancelled.', true);
        }
        await this.close().catch(() => undefined);
        throw new CuaTransportError(timeoutController.signal.aborted ? 'cua_timeout' : 'cua_cancelled',
          timeoutController.signal.aborted ? 'Cua Driver call timed out.' : 'Cua Driver call was cancelled.', true);
      }
      if (error instanceof CuaTransportError && error.mayHaveExecuted) throw error;
      throw error;
    } finally {
      clearTimeout(timer); this.active = false;
      combined.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.closePromise = this.wire.close(); return this.closePromise;
  }
}
