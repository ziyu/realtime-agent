import type { ActionCall, Candidate, JsonValue, Scope, Selection } from './types.js';

export class AgentError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryAfterMs = 5000) { super(message); }
}

export const sameScope = (a: Scope, b: Scope) => a.epoch === b.epoch && a.turnId === b.turnId && a.revision === b.revision;
export const defaultId = () => globalThis.crypto.randomUUID();

/** Detach host values and reject non-JSON input instead of silently dropping it. */
export function jsonCopy<T>(value: T): T {
  const seen = new Set<object>();
  const visit = (item: unknown): JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || !item || seen.has(item)) throw new AgentError('invalid_data', 'Expected finite, acyclic JSON data.');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new AgentError('invalid_data', 'Expected plain JSON data.');
    seen.add(item);
    try {
      if (Array.isArray(item)) return Array.from(item, visit);
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, visit((item as Record<string, unknown>)[key])]));
    } finally { seen.delete(item); }
  };
  return visit(value) as T;
}

export function copyCall(call: ActionCall): ActionCall {
  if (!call || typeof call.capability !== 'string' || !call.capability.trim() || call.capability.length > 160
    || (call.target !== undefined && (typeof call.target !== 'string' || !call.target.trim() || call.target.length > 240))) {
    throw new AgentError('invalid_call', 'Expected a named capability and a valid optional target.');
  }
  return jsonCopy({ capability: call.capability, ...(call.target === undefined ? {} : { target: call.target }),
    ...(call.input === undefined ? {} : { input: call.input }) });
}

export function selectionKey(selection: Selection): string {
  if (!selection || !['execute', 'wait', 'continue'].includes(selection.kind)) throw new AgentError('invalid_selection', 'Invalid decision selection.');
  return selection.kind === 'execute' ? JSON.stringify({ kind: 'execute', call: copyCall(selection.call) }) : selection.kind;
}

export function candidateSnapshot(candidates: readonly Candidate[]): Candidate[] {
  if (!candidates.length) throw new AgentError('no_candidates', 'The environment must offer at least one choice.');
  const ids = new Set<string>();
  return candidates.map(candidate => {
    if (typeof candidate.id !== 'string' || !candidate.id || ids.has(candidate.id) || typeof candidate.description !== 'string') {
      throw new AgentError('invalid_candidate', 'Candidate IDs must be nonempty and unique.');
    }
    ids.add(candidate.id); selectionKey(candidate.selection);
    return jsonCopy(candidate);
  });
}

export function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new AgentError('configuration', `${name} must be positive and finite.`);
  return value;
}
