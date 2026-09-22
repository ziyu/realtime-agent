import { AgentError, positive } from './common.js';

/** Host-clock admission; input/reset cannot reset provider budgets or backoff. */
export class RequestBudget {
  private starts: number[] = [];
  private last = -Infinity;
  private retry = -Infinity;
  private failures = 0;
  readonly intervalMs: number;
  readonly maxPerMinute: number;
  constructor(options: { intervalMs: number; maxPerMinute?: number }) {
    this.intervalMs = positive(options.intervalMs, 'intervalMs');
    this.maxPerMinute = positive(options.maxPerMinute ?? 120, 'maxPerMinute');
    if (!Number.isSafeInteger(this.maxPerMinute) || this.maxPerMinute > 10000) throw new AgentError('configuration', 'Invalid request budget.');
  }
  private prune(now: number): void { this.starts = this.starts.filter(at => at > now - 60000); }
  next(now: number): number {
    this.prune(now);
    return Math.max(this.last + this.intervalMs, this.retry, this.starts.length >= this.maxPerMinute ? this.starts[0] + 60000 : -Infinity);
  }
  start(now: number): boolean {
    if (!Number.isFinite(now)) throw new AgentError('invalid_time', 'Expected a finite monotonic time.');
    if (now < this.next(now)) return false;
    this.starts.push(now); this.last = now; return true;
  }
  success(): void { this.failures = 0; this.retry = -Infinity; }
  fail(now: number, retryAfterMs: number): number {
    this.failures++;
    const delay = Math.max(Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0, Math.min(60000, 2000 * 2 ** Math.min(this.failures, 5)));
    this.retry = now + delay; return delay;
  }
  snapshot(now: number) {
    this.prune(now);
    return { startsInWindow: this.starts.length, maxPerMinute: this.maxPerMinute, remaining: Math.max(0, this.maxPerMinute - this.starts.length),
      nextInMs: Math.max(0, this.next(now) - now), retryInMs: Math.max(0, this.retry - now) };
  }
}

/** The local await is bounded, but an uncooperative upstream keeps its single-flight slot until it settles. */
export class ModelSlot {
  private controller: AbortController | null = null;
  get busy(): boolean { return this.controller !== null; }
  get signal(): AbortSignal | null { return this.controller?.signal ?? null; }
  cancel(): void { this.controller?.abort(); }
  run<T>(call: (signal: AbortSignal) => Promise<T>, timeoutMs: number, settled: () => void): Promise<T> {
    if (this.controller) throw new AgentError('model_busy', 'The previous upstream request has not settled.', 0);
    positive(timeoutMs, 'timeoutMs');
    const controller = new AbortController(); this.controller = controller;
    return new Promise<T>((resolve, reject) => {
      // Cancellation ends the caller's wait immediately. The upstream may still be
      // running, so only its settlement below is allowed to release the slot.
      const aborted = () => { clearTimeout(timer); reject(controller.signal.reason); };
      const timer = setTimeout(() => {
        const error = new AgentError('model_deadline', 'The model missed its response deadline.');
        controller.abort(error);
      }, timeoutMs);
      controller.signal.addEventListener('abort', aborted, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', aborted);
        if (this.controller === controller) this.controller = null;
        try { settled(); } catch { /* A notification cannot revive an old model result. */ }
      };
      let pending: Promise<T>;
      try { pending = call(controller.signal); }
      catch (error) { cleanup(); reject(error); return; }
      // Retain rejection handlers after cancellation; no ignored or replayed upstream results.
      void Promise.resolve(pending).then(value => { cleanup(); if (controller.signal.aborted) reject(controller.signal.reason); else resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
}
