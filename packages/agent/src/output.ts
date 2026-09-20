import { AgentError, defaultId, positive } from './common.js';
import type { Scope } from './types.js';

export interface OutputPermit {
  readonly id: string;
  readonly scope: Scope;
  /** null permits conversation; it does not prove arbitrary prose is factual. */
  readonly exactText: string | null;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
}
/** Ignore sentence punctuation/spacing, but preserve signs and decimal points in numbers. */
export const outputTextKey = (text: string) => text.replace(/[\p{Z}\s、，。！？!?,；;：:“”‘’"'「」『』]/gu, '').replace(/(?<!\d)\.|\.(?!\d)/g, '');

export class OutputGate {
  private active: { permit: OutputPermit; controller: AbortController; valid: () => boolean } | null = null;
  private closed = false;
  private now: () => number;
  private id: () => string;
  private ttl: number;
  constructor(options: { now?: () => number; id?: () => string; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now; this.id = options.id ?? defaultId; this.ttl = positive(options.ttlMs ?? 30000, 'ttlMs');
  }
  issue(scope: Scope, exactText: string | null, valid: () => boolean): OutputPermit {
    if (this.closed) throw new AgentError('output_closed', 'Output gate is closed.');
    if (exactText !== null && (!exactText.trim() || exactText.length > 2400)) throw new AgentError('invalid_output', 'Invalid output text.');
    this.cancel(); const controller = new AbortController();
    const permit: OutputPermit = Object.freeze({ id: this.id(), scope: Object.freeze({ ...scope }), exactText, expiresAt: this.now() + this.ttl, signal: controller.signal });
    this.active = { permit, controller, valid }; return permit;
  }
  allows(permit: OutputPermit, transcript?: string): boolean {
    const active = this.active;
    if (this.closed || !active || active.permit !== permit || permit.signal.aborted || this.now() >= permit.expiresAt) return false;
    try { if (!active.valid()) return false; } catch { return false; }
    return transcript === undefined || typeof transcript === 'string' && transcript.trim().length > 0 && transcript.length <= 2400
      && (permit.exactText === null || outputTextKey(transcript) === outputTextKey(permit.exactText));
  }
  cancel(): void { this.active?.controller.abort(); this.active = null; }
  dispose(): void { this.cancel(); this.closed = true; }
}
