import { Agent } from '../src/index.js';
import type { AgentEnvironment, Candidate, DecisionResult } from '../src/index.js';

// Explicit local example: no model and no network. The Agent still executes actual steps.
const world = { x: 0, energy: 40 };
const environment: AgentEnvironment<typeof world> = {
  context: () => world,
  observe: state => ({ x: state.x, energy: state.energy, seen: state.x === 4 ? { object: 'bed', color: 'brown' } : null }),
  candidates: state => {
    const candidates: Candidate[] = [{ id: 'wait', description: 'Wait', selection: { kind: 'wait' } },
      { id: 'move:bed', description: 'Walk to bed without sleeping', selection: { kind: 'execute', call: { capability: 'move_to', target: 'bed' } } }];
    if (state.x === 4) candidates.push({ id: 'sleep', description: 'Sleep', selection: { kind: 'execute', call: { capability: 'use', target: 'bed' } } });
    return candidates;
  },
  capabilities: [
    { id: 'move_to', prepare(call) {
      if (call.target !== 'bed') throw new Error('Unknown object');
      return { phase: 'walking', step(state, seconds) {
        state.x = Math.min(4, state.x + seconds * 2);
        return state.x === 4 ? { status: 'completed', result: { arrived: 'bed' } } : { status: 'running', phase: 'walking' };
      } };
    } },
    { id: 'use', prepare(call, state) {
      if (call.target !== 'bed' || state.x !== 4) throw new Error('Not at the bed');
      let elapsed = 0;
      return { phase: 'sleeping', step(state, seconds) {
        elapsed += seconds;
        if (elapsed < 2) return { status: 'running', progress: elapsed / 2 };
        state.energy += 20; return { status: 'completed', result: { recoveredEnergy: 20 } };
      } };
    } },
  ],
};
let now = 100000;
const agent = new Agent({ environment, now: () => now, fast: { async decide(context): Promise<DecisionResult> {
  const desired = context.input?.text === 'Sleep' ? 'sleep' : 'move:bed';
  const done = context.receipts.some(receipt => receipt.scope.turnId === context.scope.turnId && receipt.status === 'completed'
    && receipt.call.capability === (desired === 'sleep' ? 'use' : 'move_to'));
  const selected = context.candidates.find(candidate => candidate.id === (done ? 'wait' : desired))!;
  return { selection: selected.selection, interrupt: true, think: false, acceptProposal: false, complete: done };
} } });
for (const input of ['Go to the bed', 'Sleep']) {
  agent.receive(input);
  for (let iteration = 0; iteration < 20 && !agent.snapshot().turn?.completed; iteration++) {
    now += 1000; await agent.decide();
    for (let frame = 0; frame < 10; frame++) agent.tick(0.1);
  }
  console.log(JSON.stringify({ mode: 'local policy, no model calls', input, world, context: agent.conversation() }, null, 2));
}
agent.dispose();
