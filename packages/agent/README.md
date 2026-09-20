# Realtime Agent

An environment-independent Agent coordinator, capability executor, execution receipts, and observation evidence. The core entry point has no runtime dependencies. Jev integration uses `@system-one-ai/sdk` through the optional `@realtime-agent/agent/system-one` entry point.

The architecture and migration plan are in [Agent architecture](../../docs/agent-architecture.md). Home now uses the complete Agent coordinator, action runtime and System One decision policy. Character, world effects and persistence remain host strategies, connected through policies and lifecycle events. Native action narration also uses output permits before playback.

## Run locally

From the workspace root:

```sh
pnpm install
pnpm --filter @realtime-agent/agent build
pnpm --filter @realtime-agent/agent test
pnpm --filter @realtime-agent/agent example:local
pnpm test:agent-package
```

The example uses an explicitly local policy and real in-memory environment mutations, with no model requests. `test:agent-package` packs the package, installs it in a separate temporary project, and loads the built core without the SDK installed.

## A capability is not a model promise

```ts
import { Agent } from '@realtime-agent/agent';
import type { AgentEnvironment } from '@realtime-agent/agent';
import { SystemOneDecisionPolicy } from '@realtime-agent/agent/system-one';
import { SystemOne } from '@system-one-ai/sdk';
import { cloudflareAdapter } from '@system-one-ai/sdk/adapters/cloudflare';

const state = { x: 0 };
const environment: AgentEnvironment<typeof state> = {
  context: () => state,
  observe: world => ({ x: world.x }),
  candidates: () => [
    { id: 'wait', description: 'Wait here', selection: { kind: 'wait' } },
    {
      id: 'move:bed', description: 'Walk to the bed without sleeping',
      selection: { kind: 'execute', call: { capability: 'move_to', target: 'bed' } },
    },
  ],
  capabilities: [{
    id: 'move_to',
    prepare(call) {
      if (call.target !== 'bed') throw new Error('Unknown target');
      return {
        phase: 'walking',
        step(world, seconds) {
          world.x = Math.min(4, world.x + seconds * 2);
          return world.x === 4
            ? { status: 'completed', result: { arrived: 'bed' } }
            : { status: 'running', phase: 'walking' };
        },
      };
    },
  }],
};

const fast = new SystemOneDecisionPolicy(new SystemOne({
  adapter: cloudflareAdapter({ accountId: 'YOUR_ACCOUNT_ID' }),
  apiKey: 'YOUR_SERVER_SIDE_TOKEN',
  maxRetries: 0,
}));
const agent = new Agent({ environment, fast });
agent.receive('Please walk to the bed.');
await agent.decide();
agent.tick(0.1);
console.log(agent.conversation());
agent.dispose();
```

Provide actual server-side credentials in the application, not in checked-in code. Other SDK adapters are supplied when constructing `SystemOne`; the Agent does not guess a protocol from a URL or read environment variables.

The host drives time. Call `tick(seconds)` at the environment's frame cadence and call `decide()` when appropriate; it skips occupied, rate-limited, paused and unnecessary requests. Do not await a slow model before allowing subsequent physics ticks. No timers or background processes are created by the package.

## Public components

| Component | Responsibility |
| --- | --- |
| `Agent<C>` | Final input, previous turns, decision cadence, stale-result isolation, slow-thinking proposals, coordination |
| `ActionRuntime<C>` | Registered capability execution, holds, continuation, cancellation, active-time deadlines, bounded receipts |
| `EvidenceLedger` | Versioned, expiring observations and structured claim-reference validation |
| `OutputGate` | Current-turn permits, cancellation, expiry and exact transcript matching |
| `SystemOneDecisionPolicy` | SDK question construction and mapping one selected candidate to a complete operation |
| `AgentEnvironment<C>` | Host context, reasoning observation, optional public `perceive` projection, offered capabilities, semantic revision |
| `AgentPolicies` / `AgentEvent` | Host-specific thinking eligibility, proposal evidence, completion checks and lifecycle projections |
| `SlowThinker` | An injected, abort-aware `think(context, signal)` implementation |

`Agent` exposes `receive`, `holdInput`, `releaseInput`, `invalidate`, `wake`, `cancelReasoning`, `interruptReply`, `markReplyDelivered`, `forgetTurns`, `pause`, `reset`, `dispose`, `tick`, `decide`, `snapshot`, `conversation`, `checkClaims`, and `subscribe`. `ActionRuntime` also remains usable independently.

Subscribe to detached lifecycle events for UI metrics and persistence. `AgentPolicies.canThink` controls domain eligibility after a model invites thinking; `acceptProposal` verifies domain evidence; `verifyCompletion` handles domain-specific completed-state conditions. These policies do not replace the single-flight scheduler. Event listeners cannot mutate receipt snapshots; a listener exception does not replay committed effects. Reentrant input during decision review invalidates the old selection.

Each candidate binds the entire operation: `{ capability, target?, input? }`. The core has no fixed object names, verbs or coordinates. Register only operations your environment actually supports. `prepare` must be synchronous, bounded and side-effect-free; it runs before the previous action is cancelled. `start`, `step` and `cancel` are synchronous execution hooks. A failed cancellation blocks a replacement until the host restores the environment and can confirm cancellation/reset.

`running` means the environment has started execution; `held` means it is not advancing. Only a completed `step` creates a completed receipt. A held execution does not consume its execution-time budget. Receipts and history are detached snapshots; manipulating one does not change the Agent.

The first milestone is a tick-driven execution contract. Asynchronous external side effects need an adapter with explicit cancellation/commit confirmation; do not force an async function into `step` or claim that aborting a network request undoes a remote action.

## Slow thinking and grounded output

The decision policy alone can invite `SlowThinker`. Its output is a pending `{ summary, reply?, suggestions, memories?, metadata? }` proposal. The next decision can accept it, but acceptance neither speaks nor executes suggestions as a queue. Acceptance alone does not complete the turn. New final input, pause, reset and disposal invalidate older in-flight reasoning. `forgetTurns` removes user-source context and cancels pending proposals. A provider must honor cancellation or otherwise settle its Promise; a non-cooperative pending call retains its slot. The thought deadline also rejects a late result rather than treating it as current advice.

`conversation()` returns current execution, terminal receipts and fresh observation evidence. `checkClaims()` can verify that a referenced execution has a particular state, or that a referenced observation is current. For example:

```ts
const frame = agent.conversation();
const claims = [{ kind: 'observation' as const, id: frame.observation.id }];
const referencesAreCurrent = agent.checkClaims(claims);
```

Movement ticks, explicit invalidation, environment semantic changes, new turns and expiry invalidate old observation references. Observation facts must come from the environment's sensor, not a model assertion. Action references must belong to the same epoch and turn; a past completed action does not complete a new request.

This checks references and lifecycle state, **not whether arbitrary natural-language text entails those references**. Use `perceive` to provide the output adapter a public sensor view without exposing the full reasoning context.

For exact narration, derive text from real receipts or observations and issue an `OutputGate` permit with a predicate that rechecks those facts. Permits are identity-bound, expiring and abortable; issuing a new one cancels the old one. `allows(permit, transcript)` requires matching words, ignoring sentence punctuation and spacing only. Numeric signs and decimal points remain significant. `exactText: null` explicitly permits free conversation, with no deterministic semantic guarantee.

Environments may register `output: { candidates, capabilities }`. A decision's optional `output: Selection` is validated against the offered candidates and applied by `agent.outputs`, a second `ActionRuntime` concurrent with `agent.actions`. Omission preserves ongoing output; `wait` cancels it. New input, hearing, pause, reset and channel changes cancel output. Snapshot fields `output` and `outputReceipts`, plus `output-applied` / `output-ended` events, expose its lifecycle. A running output prevents turn completion.

Home registers `speak` with the exact accepted proposal ID and text. Both text and voice delivery produce execution receipts; inspection completion cannot directly speak. Home never issues free-conversation permits: all words come from slow proposals explicitly selected by Jev. LiveKit and browser WebRTC buffer audio until the entire transcript matches the selected text, and dispatch by speech execution ID, allowing multiple deliberate replies in one turn. This trades first-audio latency for consistent authorization. Semantic accuracy still depends on model review, and transcript matching is not independent ASR verification of the waveform.

## Packaging and verification

The package builds ESM JavaScript, declarations and source maps. The core imports no Home, React, Three.js, LiveKit, Node filesystem APIs or model SDK runtime. The optional SDK entry point requires `@system-one-ai/sdk >=0.5.2 <1`; workspace verification pins 0.5.2.

The package is currently a private workspace package and has not been published. Packing and installing its tarball is supported. Node is the tested core runtime; browser/Workers core execution still needs platform-specific validation. Home's browser audio adapter has its own real WebRTC tests. Persistent factual memory, asynchronous device operations, a durable task planner, and broader native microphone/provider verification remain future work.
