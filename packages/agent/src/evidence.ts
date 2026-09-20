import { defaultId, jsonCopy, positive, sameScope } from './common.js';
import type { ActionReceipt, GroundingClaim, JsonValue, ObservationEvidence, Scope } from './types.js';

export class EvidenceLedger {
  private records: ObservationEvidence[] = [];
  private now: () => number;
  private id: () => string;
  private ttl: number;
  constructor(options: { now?: () => number; id?: () => string; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now; this.id = options.id ?? defaultId;
    this.ttl = positive(options.ttlMs ?? 3000, 'ttlMs');
  }
  observe(scope: Scope, facts: JsonValue): ObservationEvidence {
    const now = this.now();
    const evidence: ObservationEvidence = { id: this.id(), scope: { ...scope }, observedAt: now, expiresAt: now + this.ttl, facts: jsonCopy(facts) };
    this.records = [...this.records.filter(record => record.expiresAt > now), evidence].slice(-32);
    return structuredClone(evidence);
  }
  clear(): void { this.records = []; }

  /** Checks references and lifecycle state, not the semantics of arbitrary prose. */
  checkClaims(scope: Scope, claims: readonly GroundingClaim[], executions: readonly ActionReceipt[]): boolean {
    return claims.every(claim => {
      if (claim.kind === 'observation') {
        return this.records.some(record => record.id === claim.id && sameScope(record.scope, scope) && record.expiresAt > this.now());
      }
      if (claim.kind === 'action') {
        return executions.some(record => record.id === claim.id && record.scope.epoch === scope.epoch
          && record.scope.turnId === scope.turnId && record.status === claim.status);
      }
      return false;
    });
  }
}
