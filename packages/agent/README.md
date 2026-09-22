# Realtime Agent

An environment-independent Agent coordinator, capability executor, execution receipts, and observation evidence. The core entry point has no runtime dependencies. Jev integration uses `@system-one-ai/sdk` through the optional `@realtime-agent/agent/system-one` entry point.

The architecture and migration plan are in [Agent architecture](../../docs/agent-architecture.md). Home and the [Computer reference app](../../apps/realtime-computer/README.md) share this coordinator. Versioned observations, asynchronous operations, resource arbitration, short plans and presentation channels extend the existing synchronous execution API. Character, world effects and persistence remain host strategies. See [implementation and verification](../../docs/realtime-runtime-implementation.md) for the current delivery scope.

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

The host drives the recurring loop. Call `tick(seconds)` at the environment's frame cadence and call `decide()` when appropriate; it skips occupied, rate-limited, paused and unnecessary requests. Do not await a slow model before allowing subsequent physics ticks. Each in-flight model await uses a deadline timer; the package creates no recurring loop or background process. Admission, model cooldowns, observation freshness and operation deadlines use an injected monotonic clock; UTC timestamps are for display and correlation.

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
| `ObservationStore` | Bounded, source-ordered sensor frames, capture age and entity-specific references |
| `OperationRuntime<C>` | Asynchronous device dispatch, explicit results, cancellation confirmation and reconciliation |
| `ChannelRuntime<C>` / `ResourceArbiter` | Registered sync/async channels and shared exclusive device leases |
| `TaskLedger` | Versioned goals, adopted short plans, bound step receipts and host goal verification |
| `RequestBudget` / `ModelSlot` | Rolling request limits, retry admission and bounded local waits |
| `Telemetry` | Bounded timing metadata and observed percentile summaries |

`Agent` exposes `receive`, `holdInput`, `releaseInput`, `invalidate`, `wake`, `cancelReasoning`, `interruptReply`, `markReplyDelivered`, `forgetTurns`, `pause`, `stop`, `reset`, `dispose`, `tick`, `decide`, `snapshot`, `conversation`, `checkClaims`, `observe`, `react`, and `subscribe`. `actions`, `outputs`, `channels`, `observations` and `telemetry` expose the corresponding runtime components. `ActionRuntime` also remains usable independently.

Subscribe to detached lifecycle events for UI metrics and persistence. `AgentPolicies.canThink` controls domain eligibility after a model invites thinking; `acceptProposal` verifies domain evidence; `verifyCompletion` handles domain-specific completed-state conditions. These policies do not replace the single-flight scheduler. Event listeners cannot mutate receipt snapshots; a listener exception does not replay committed effects. Reentrant input during decision review invalidates the old selection.

Each candidate binds the entire operation: `{ capability, target?, input? }`. The core has no fixed object names, verbs or coordinates. Register only operations your environment actually supports. `prepare` must be synchronous, bounded and side-effect-free; it runs before the previous action is cancelled. `start`, `step` and `cancel` are synchronous execution hooks. A failed cancellation blocks a replacement until the host restores the environment and can confirm cancellation/reset.

`running` means the environment has started execution; `held` means it is not advancing. Only a completed `step` creates a completed receipt. A held execution does not consume its execution-time budget. Receipts and history are detached snapshots; manipulating one does not change the Agent.

Asynchronous devices use `OperationRuntime` or an `AgentEnvironment.channels` entry with `mode: 'async'`. Their `prepare()` is still side-effect-free, but returns `dispatch`, optional `cancel` / `reconcile`, a real-time duration budget and declared interruptibility. Settling the dispatch Promise acknowledges transport only; the adapter reports the real operation outcome separately. Do not force an async function into the synchronous `step` contract.

## Observations, channels and short plans

`agent.observe(frame, { wake })` ingests a source ID, sequence, capture time and uncertainty, age limit, provenance, facts and entity versions. Unknown capture age never becomes fresh merely because the frame just arrived. `agent.observations.reference(source, entityIds)` produces dependencies for a candidate. An unrelated frame may preserve an entity reference; a changed target or expired capture rejects it. Dependencies are checked again after decision review, before execution. Raw media is not stored in the core.

Register channels with an ID, offered candidates, resources and a sync or async capability set. `DecisionResult.channels` selects a complete operation for each named channel. Omission preserves the channel; `wait` requests its cancellation. Additional channels share the same model scheduler and scope. A batch with conflicting resource claims is rejected before its actions start. This is preflight validation, not a transaction that can roll back device effects already committed.

Share one `ResourceArbiter` between every Agent controlling the same device. Unknown or cancellation-pending operations retain their lease until a real terminal report. The legacy body/output APIs remain compatible; shared device resources should be registered through named channels, or through standalone executors constructed with explicit resources.

Nonblocking cosmetic channels set `blocksCompletion: false` and may set `whileHearing: 'continue'`. Only candidate IDs declared in `reflexes` can be invoked by `agent.react(channel, candidateId)` without model selection. Home uses these for immediate nonverbal attention; they do not provide task-completion evidence. Asynchronous devices cannot implement pause by skipping ticks.

An operation report contains its operation/device identity, source sequence, lifecycle state and actual effect (`none`, `partial`, `committed`, or `unknown`). A late report retains the original scope and is accounted for even after a user correction. Duplicate or older reports are ignored. `cancel-requested` never implies rollback; `cancelled` can still carry a partial effect. Device `elapsedSeconds` measures real monotonic duration including waits, while synchronous `ActionRuntime.elapsedSeconds` continues to measure active simulation time.

`agent.stop()` pauses new decisions and attempts to cancel every execution. `reset()` also stops other channels when a device remains unsettled, retains the old epoch, and throws `unsettled_operation`; query the device with `agent.channels.reconcile(name, context)` before retrying reset. The driver must keep reporting outcomes until the device has settled or been independently recovered. These records are in memory; they do not provide restart durability or GUI exactly-once semantics.

`TaskLedger` is host-owned: begin/revise a goal, propose a bounded dependency plan, accept it, offer `next()` steps as candidates, bind an execution ID and record its actual terminal receipt. Adoption never starts a step. The snapshot exposes `plan.expired` so a host can request a fresh proposal; expiry uses monotonic time and does not discard facts from an operation already dispatched. `verify()` requires a host verifier and evidence IDs. The Computer app demonstrates exact goal-value checks and saved-DOM verification.

`agent.telemetry.snapshot()` and `summary()` contain timing metadata only. Model decision events retain actual returned System One model, request ID and usage when provided; unknown usage remains null. Host-specific media milestones and verified costs must be recorded separately. Percentiles describe the retained samples, not a model benchmark.

## Slow thinking and grounded output

The decision policy alone can invite `SlowThinker`. Its output is a pending `{ summary, reply?, suggestions, memories?, metadata? }` proposal. The next decision can accept it, but acceptance neither speaks nor executes suggestions as a queue. Acceptance alone does not complete the turn. New final input, pause, reset and disposal invalidate older in-flight reasoning. `forgetTurns` removes user-source context and cancels pending proposals. Cancellation or a deadline ends the local await immediately, while a non-cooperative upstream retains its slot until its Promise actually settles. This prevents overlapping orphan requests; the provider must eventually settle to restore availability. The thought deadline rejects late results rather than treating them as current advice.

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

The package is currently a private workspace package and has not been published. Packing and installing its tarball is supported. Node is the tested core runtime; browser/Workers core execution still needs platform-specific validation. Asynchronous local browser operations and in-memory short plans are implemented. Persistent execution recovery, native desktop drivers, a durable task planner and broader microphone/provider verification remain future work. The original Home media tests have their own documented verification scope.
