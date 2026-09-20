import type { AgentEnvironment, Candidate, Capability, DecisionResult } from '../src/index.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
export const decision = (overrides: Partial<DecisionResult> = {}): DecisionResult => ({
  selection: { kind: 'wait' }, interrupt: true, think: false, complete: false, acceptProposal: false, ...overrides,
});
export const move = (target = 'bed') => ({ kind: 'execute' as const, call: { capability: 'move_to', target } });
export const scope = (turnId: string | null = 'turn-1', revision = 1) => ({ epoch: 'epoch-1', turnId, revision });
export function room() {
  const state = { position: 0, energy: 30, completedUses: 0, revision: 0, bedAvailable: true };
  const locations: Record<string, number> = { bed: 4, bookshelf: -4 };
  const capabilities: Capability<typeof state>[] = [
    { id: 'move_to', prepare(call) {
      const target = call.target;
      if (!target || !Object.hasOwn(locations, target) || target === 'bed' && !state.bedAvailable) throw new Error('Unavailable');
      return { phase: 'walking', step(context, seconds) {
        const delta = locations[target] - context.position;
        context.position += Math.sign(delta) * Math.min(Math.abs(delta), seconds * 2);
        return context.position === locations[target] ? { status: 'completed', result: { arrived: target } }
          : { status: 'running', phase: 'walking' };
      } };
    } },
    { id: 'use', prepare(call, context) {
      if (call.target !== 'bed' || context.position !== 4) throw new Error('Not at bed');
      let elapsed = 0;
      return { phase: 'sleeping', step(context, seconds) {
        elapsed += seconds;
        if (elapsed < 2) return { status: 'running', progress: elapsed / 2 };
        context.energy += 20; context.completedUses++;
        return { status: 'completed', result: { restoredEnergy: 20 } };
      } };
    } },
    { id: 'inspect', prepare(call, context) {
      if (call.target !== 'bed' || context.position !== 4) throw new Error('Not visible');
      return { step() { return { status: 'completed', result: { object: 'bed', color: 'brown' } }; } };
    } },
  ];
  const candidates = (): Candidate[] => [
    { id: 'wait', description: 'Wait', selection: { kind: 'wait' } },
    { id: 'continue', description: 'Continue', selection: { kind: 'continue' } },
    ...Object.keys(locations).filter(target => target !== 'bed' || state.bedAvailable).map(target => ({ id: `move:${target}`, description: `Move to ${target}`, selection: move(target) })),
    ...(state.position === 4 ? [
      { id: 'sleep', description: 'Sleep', selection: { kind: 'execute' as const, call: { capability: 'use', target: 'bed' } } },
      { id: 'inspect', description: 'Inspect bed', selection: { kind: 'execute' as const, call: { capability: 'inspect', target: 'bed' } } },
    ] : []),
  ];
  const environment: AgentEnvironment<typeof state> = { context: () => state, capabilities, candidates,
    revision: context => context.revision,
    observe: context => ({ position: context.position, energy: context.energy, visible: context.position === 4 ? { object: 'bed', color: 'brown' } : null }),
  };
  let count = 0;
  return { state, environment, capabilities, candidates, clock: { now: 100000 }, id: () => `id-${++count}` };
}
