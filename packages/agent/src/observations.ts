import { AgentError, jsonCopy, positive } from './common.js';
import type { JsonValue } from './types.js';

export interface ObservationFrame {
  id: string;
  source: string;
  sequence: number;
  /** UTC capture time. null means freshness cannot be established. */
  capturedAt: number | null;
  clockUncertaintyMs: number | null;
  maxAgeMs: number;
  facts: JsonValue;
  entities: Record<string, string | number>;
  provenance: 'sensor' | 'simulation' | 'inference';
}
export interface ObservationSnapshot extends ObservationFrame {
  receivedAt: number;
  fresh: boolean;
  ageMs: number | null;
}
export interface ObservationReference { id: string; source: string; sequence: number; generation: number; entities?: Record<string, string | number> }
interface Stored { frame: ObservationFrame; receivedAt: number; receivedClock: number; initialAge: number | null }

/** Latest-value sensor storage; execution events use a separate reliable accounting path. */
export class ObservationStore {
  private latest = new Map<string, Stored>();
  private history = new Map<string, Stored>();
  private now: () => number;
  private clock: () => number;
  private limit: number;
  private sourceLimit: number;
  private generation = 0;
  constructor(options: { now?: () => number; monotonicNow?: () => number; historyLimit?: number; sourceLimit?: number } = {}) {
    this.now = options.now ?? Date.now; this.clock = options.monotonicNow ?? options.now ?? (() => performance.now());
    this.limit = positive(options.historyLimit ?? 128, 'historyLimit');
    this.sourceLimit = positive(options.sourceLimit ?? 16, 'sourceLimit');
    if (!Number.isSafeInteger(this.limit) || this.limit > 10000 || !Number.isSafeInteger(this.sourceLimit) || this.sourceLimit > this.limit) {
      throw new AgentError('configuration', 'Invalid observation storage limits.');
    }
  }
  ingest(frame: ObservationFrame): boolean {
    if (!frame || typeof frame.id !== 'string' || !frame.id || typeof frame.source !== 'string' || !frame.source || frame.id.length > 240 || frame.source.length > 160
      || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0
      || (frame.capturedAt !== null && !Number.isFinite(frame.capturedAt))
      || (frame.clockUncertaintyMs !== null && (!Number.isFinite(frame.clockUncertaintyMs) || frame.clockUncertaintyMs < 0))
      || !['sensor', 'simulation', 'inference'].includes(frame.provenance)
      || !frame.entities || typeof frame.entities !== 'object' || Array.isArray(frame.entities)
      || Object.keys(frame.entities).length > 256 || Object.entries(frame.entities).some(([id, version]) => !id || id.length > 240
        || !(typeof version === 'string' && version.length <= 240 || typeof version === 'number' && Number.isFinite(version)))) {
      throw new AgentError('invalid_observation', 'Invalid versioned sensor observation.');
    }
    positive(frame.maxAgeMs, 'maxAgeMs');
    const previous = this.latest.get(frame.source);
    if (previous && frame.sequence <= previous.frame.sequence) return false;
    if (this.history.has(frame.id)) throw new AgentError('duplicate_observation', 'Observation IDs cannot be reused.');
    if (!previous && this.latest.size >= this.sourceLimit) throw new AgentError('observation_capacity', 'Too many sensor sources.');
    const copy = jsonCopy(frame), wall = this.now(), clock = this.clock();
    if (new TextEncoder().encode(JSON.stringify(copy)).byteLength > 65536) throw new AgentError('observation_capacity', 'An observation may contain at most 64 KiB.');
    let initialAge: number | null = null;
    if (copy.capturedAt !== null && copy.clockUncertaintyMs !== null) {
      const difference = wall - copy.capturedAt;
      if (difference >= -copy.clockUncertaintyMs) initialAge = Math.max(0, difference) + copy.clockUncertaintyMs;
    }
    const stored = { frame: copy, receivedAt: wall, receivedClock: clock, initialAge };
    this.latest.set(copy.source, stored); this.history.set(copy.id, stored);
    while (this.history.size > this.limit) {
      const removable = [...this.history].find(([, item]) => this.latest.get(item.frame.source) !== item);
      if (!removable) break;
      this.history.delete(removable[0]);
    }
    return true;
  }
  private project(stored: Stored): ObservationSnapshot {
    const ageMs = stored.initialAge === null ? null : stored.initialAge + Math.max(0, this.clock() - stored.receivedClock);
    return { ...structuredClone(stored.frame), receivedAt: stored.receivedAt, ageMs, fresh: ageMs !== null && ageMs < stored.frame.maxAgeMs };
  }
  snapshot(): ObservationSnapshot[] { return [...this.latest.values()].map(stored => this.project(stored)); }
  reference(source: string, entities?: readonly string[]): ObservationReference {
    const stored = this.latest.get(source);
    if (!stored || !this.project(stored).fresh) throw new AgentError('stale_observation', 'No fresh observation is available for this source.');
    if (entities?.some(id => !Object.hasOwn(stored.frame.entities, id))) throw new AgentError('unknown_entity', 'The sensor did not observe this entity.');
    return { id: stored.frame.id, source, sequence: stored.frame.sequence, generation: this.generation,
      ...(entities?.length ? { entities: Object.fromEntries(entities.map(id => [id, stored.frame.entities[id]])) } : {}) };
  }
  current(reference: ObservationReference): boolean {
    const observed = this.history.get(reference.id), latest = this.latest.get(reference.source);
    if (!observed || !latest || reference.generation !== this.generation || observed.frame.sequence !== reference.sequence
      || observed.frame.source !== reference.source || !this.project(observed).fresh || !this.project(latest).fresh) return false;
    if (reference.entities && Object.keys(reference.entities).length) {
      return Object.entries(reference.entities).every(([id, version]) => Object.hasOwn(observed.frame.entities, id)
        && observed.frame.entities[id] === version && Object.hasOwn(latest.frame.entities, id) && latest.frame.entities[id] === version);
    }
    return observed === latest;
  }
  clear(): void { this.latest.clear(); this.history.clear(); this.generation++; }
}
