import { ActionRuntime } from './actions.js';
import { OperationRuntime } from './executions.js';
import type { AsyncCapability, OperationReceipt, OperationRuntimeOptions } from './executions.js';
import { AgentError, candidateSnapshot, sameScope, selectionKey } from './common.js';
import { ResourceArbiter } from './resources.js';
import type { ActionReceipt, Candidate, Capability, Scope, Selection } from './types.js';

interface ChannelBase<C> {
  id: string;
  candidates(context: C): Candidate[];
  resources: readonly string[];
  /** Cosmetic channels do not establish task completion and may continue while listening. */
  blocksCompletion?: boolean;
  onInput?: 'hold' | 'cancel' | 'continue';
  whileHearing?: 'hold' | 'continue';
  /** Host-authored, nonverbal interaction reflexes. Other selections require a model decision. */
  reflexes?: readonly string[];
}
export type ChannelDefinition<C> = ChannelBase<C> & (
  | { mode: 'sync'; capabilities: readonly Capability<C>[] }
  | { mode: 'async'; deviceSessionId: string; capabilities: readonly AsyncCapability<C>[] }
);
export interface ChannelSnapshot {
  mode: 'sync' | 'async';
  blocksCompletion: boolean;
  current: ActionReceipt | OperationReceipt | null;
  receipts: (ActionReceipt | OperationReceipt)[];
}
export interface ChannelDecisionContext extends ChannelSnapshot { candidates: Candidate[] }
export interface ChannelEvent { channel: string; receipt: ActionReceipt | OperationReceipt; terminal: boolean }
interface Entry<C> { definition: ChannelDefinition<C>; runtime: ActionRuntime<C> | OperationRuntime<C> }

/** Extra channels share the Agent's scope and arbiter; they never create another model scheduler. */
export class ChannelRuntime<C> {
  private entries = new Map<string, Entry<C>>();
  constructor(private options: {
    definitions: readonly ChannelDefinition<C>[];
    arbiter: ResourceArbiter;
    now: () => number;
    monotonicNow?: () => number;
    id: () => string;
    onChange(event: ChannelEvent): void;
    currentScope(): Scope;
  }) {
    for (const definition of options.definitions) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(definition.id) || ['body', 'output', 'constructor', 'prototype'].includes(definition.id) || this.entries.has(definition.id)) {
        throw new AgentError('invalid_channel', 'Channel IDs must be unique, non-reserved identifiers.');
      }
      if (definition.mode === 'async' && definition.onInput === 'hold') throw new AgentError('invalid_channel', 'Asynchronous devices must cancel or continue; they cannot pretend to hold.');
      if (definition.mode === 'async' && definition.whileHearing === 'hold') throw new AgentError('invalid_channel', 'Asynchronous devices cannot be held by skipping local ticks.');
      if (definition.blocksCompletion !== false && definition.reflexes?.length) throw new AgentError('invalid_channel', 'Interaction reflexes must be nonblocking presentation channels.');
      const common = { capabilities: definition.capabilities, resources: definition.resources, arbiter: options.arbiter, now: options.now, id: options.id };
      const runtime = definition.mode === 'sync'
        ? new ActionRuntime<C>({ ...common, capabilities: definition.capabilities })
        : new OperationRuntime<C>({ ...common, capabilities: definition.capabilities, deviceSessionId: definition.deviceSessionId,
          monotonicNow: options.monotonicNow, onChange: (receipt, terminal) => this.emit({ channel: definition.id, receipt, terminal }) } satisfies OperationRuntimeOptions<C>);
      this.entries.set(definition.id, { definition, runtime });
    }
  }
  private emit(event: ChannelEvent): void { this.options.onChange(event); }
  snapshot(): Record<string, ChannelSnapshot> {
    return Object.fromEntries([...this.entries].map(([name, { definition, runtime }]) => [name, {
      mode: definition.mode, blocksCompletion: definition.blocksCompletion !== false, current: runtime.current, receipts: runtime.history,
    }]));
  }
  context(context: C): Record<string, ChannelDecisionContext> {
    const states = this.snapshot();
    return Object.fromEntries([...this.entries].map(([name, { definition }]) => [name, { ...states[name], receipts: states[name].receipts.slice(-8), candidates: candidateSnapshot(definition.candidates(context)) }]));
  }
  get blocking(): boolean { return [...this.entries.values()].some(e => e.definition.blocksCompletion !== false && e.runtime.current !== null); }

  /** Validate the complete combination before starting any selected channel. */
  validate(selections: Record<string, Selection>, offered: Record<string, ChannelDecisionContext>, context: C): void {
    if (!selections || typeof selections !== 'object' || Array.isArray(selections)) throw new AgentError('invalid_channel_selection', 'Expected named channel selections.');
    const claims = new Map<string, string>();
    for (const [name, selection] of Object.entries(selections)) {
      const entry = this.entries.get(name), key = selectionKey(selection);
      if (!entry || !Object.hasOwn(offered, name) || !offered[name].candidates.some(c => selectionKey(c.selection) === key)
        || !candidateSnapshot(entry.definition.candidates(context)).some(c => selectionKey(c.selection) === key)) {
        throw new AgentError('stale_channel_candidate', 'A channel selection was not offered or is no longer available.');
      }
      if (selection.kind === 'execute') {
        if (!entry.runtime.available()) throw new AgentError('resource_busy', 'A required resource is not available.', 0);
        for (const resource of entry.definition.resources) {
          if (claims.has(resource) && claims.get(resource) !== name) throw new AgentError('resource_conflict', 'Selected channels require the same exclusive resource.', 0);
          claims.set(resource, name);
        }
      }
    }
  }
  prepare(selections: Record<string, Selection>, context: C): void {
    for (const [name, selection] of Object.entries(selections)) {
      if (selection.kind === 'execute') this.entries.get(name)!.runtime.validate(selection.call, context);
    }
  }
  apply(selections: Record<string, Selection>, scope: Scope, context: C): boolean {
    let applied = true;
    for (const [name, selection] of Object.entries(selections)) {
      if (!sameScope(scope, this.options.currentScope())) return false;
      const entry = this.entries.get(name);
      if (!entry) throw new AgentError('unknown_channel', 'This channel is not registered.');
      const runtime = entry.runtime, current = runtime.current;
      const same = selection.kind === 'execute' && current && selectionKey(selection) === selectionKey({ kind: 'execute', call: current.call });
      if (selection.kind === 'continue' || same) {
        if (runtime instanceof ActionRuntime) runtime.continue(scope);
        // An in-flight remote effect keeps its original scope; adopting it cannot rewrite its origin.
        continue;
      }
      if (selection.kind === 'wait') { this.cancelEntry(name, entry, context, 'decision'); continue; }
      if (runtime instanceof OperationRuntime && current) {
        runtime.cancel(context, 'replaced');
        if (runtime.current || !sameScope(scope, this.options.currentScope())) { applied = false; continue; }
      }
      const previous = runtime.current;
      const receipt = runtime.start(selection.call, scope, context);
      if (runtime instanceof ActionRuntime) {
        if (previous) {
          const ended = runtime.history.find(r => r.id === previous.id);
          if (ended) this.emit({ channel: name, receipt: ended, terminal: true });
        }
        this.emit({ channel: name, receipt, terminal: false });
      }
    }
    return applied;
  }
  react(name: string, candidateId: string, scope: Scope, context: C): void {
    const entry = this.entries.get(name);
    if (!entry || !entry.definition.reflexes?.includes(candidateId)) throw new AgentError('invalid_reflex', 'This interaction reflex is not registered.');
    const offered = this.context(context), candidate = offered[name].candidates.find(c => c.id === candidateId);
    if (!candidate) throw new AgentError('stale_channel_candidate', 'The reflex is not currently available.');
    this.validate({ [name]: candidate.selection }, offered, context);
    this.prepare({ [name]: candidate.selection }, context);
    this.apply({ [name]: candidate.selection }, scope, context);
  }
  private cancelEntry(name: string, entry: Entry<C>, context: C, reason: string): void {
    const result = entry.runtime.cancel(context, reason);
    if (entry.runtime instanceof ActionRuntime && result) this.emit({ channel: name, receipt: result, terminal: true });
  }
  cancel(context: C, reason: string): void {
    let failure: unknown;
    for (const [name, entry] of this.entries) { try { this.cancelEntry(name, entry, context, reason); } catch (error) { failure ??= error; } }
    if (failure) throw failure;
  }
  input(context: C): void {
    let failure: unknown;
    for (const [name, entry] of this.entries) {
      if (entry.definition.onInput === 'continue') continue;
      try {
        if (entry.definition.onInput === 'hold' && entry.runtime instanceof ActionRuntime) entry.runtime.hold();
        else this.cancelEntry(name, entry, context, 'new-input');
      } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  tick(context: C, seconds: number, paused: boolean, hearing: boolean): void {
    for (const [name, entry] of this.entries) {
      if (entry.runtime instanceof OperationRuntime) { entry.runtime.tick(context); continue; }
      if (paused || hearing && entry.definition.whileHearing !== 'continue') continue;
      const receipt = entry.runtime.tick(context, seconds);
      if (receipt) this.emit({ channel: name, receipt, terminal: true });
    }
  }
  reconcile(name: string, context: C): boolean {
    const runtime = this.entries.get(name)?.runtime;
    return runtime instanceof OperationRuntime ? runtime.reconcile(context) : false;
  }
  reset(context: C): void {
    this.cancel(context, 'reset');
    if ([...this.entries.values()].some(e => e.runtime.current)) throw new AgentError('unsettled_operation', 'Reconcile active channels before resetting.');
    for (const { runtime } of this.entries.values()) runtime.reset(context);
  }
}
