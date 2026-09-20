export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface Scope { epoch: string; turnId: string | null; revision: number }
export interface ActionCall { capability: string; target?: string; input?: JsonValue }
export type Selection = { kind: 'execute'; call: ActionCall } | { kind: 'continue' } | { kind: 'wait' };
export interface Candidate { id: string; description: string; selection: Selection }
export type ExecutionStatus = 'running' | 'held' | 'completed' | 'cancelled' | 'failed';
export interface ActionReceipt {
  id: string;
  scope: Scope;
  call: ActionCall;
  status: ExecutionStatus;
  phase: string;
  progress: number;
  elapsedSeconds: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  result?: JsonValue;
  reason?: string;
}
export interface ExecutionContext { id: string; scope: Scope; signal: AbortSignal }
export type StepResult = { status: 'running'; phase?: string; progress?: number }
  | { status: 'completed'; result: JsonValue };
/** prepare is side-effect-free; start/step/cancel are synchronous and bounded. */
export interface PreparedAction<C> {
  phase?: string;
  start?(context: C, execution: ExecutionContext): void;
  step(context: C, seconds: number, execution: ExecutionContext): StepResult;
  cancel?(context: C, execution: ExecutionContext): void;
}
export interface Capability<C> {
  id: string;
  prepare(call: ActionCall, context: C): PreparedAction<C>;
}
export interface Turn { id: string; text: string; receivedAt: number; completed: boolean; replySuppressed?: boolean; replyDelivered?: boolean }
export interface ThoughtProposal { summary: string; reply?: string; suggestions: ActionCall[]; memories?: JsonValue; metadata?: JsonValue }
export interface ProposalRecord { id: string; scope: Scope; createdAt: number; accepted: boolean; value: ThoughtProposal }
export interface DecisionContext {
  scope: Scope;
  input: Turn | null;
  previousTurns: Turn[];
  observation: JsonValue;
  candidates: Candidate[];
  currentAction: ActionReceipt | null;
  receipts: ActionReceipt[];
  outputCandidates?: Candidate[];
  currentOutput?: ActionReceipt | null;
  outputReceipts?: ActionReceipt[];
  proposal: ProposalRecord | null;
  thinking: boolean;
  slowThinkingAvailable: boolean;
}
export interface DecisionResult {
  selection: Selection;
  /** Independently selected output action; omission preserves the current output. */
  output?: Selection;
  interrupt: boolean;
  think: boolean;
  acceptProposal: boolean;
  complete: boolean;
  metadata?: JsonValue;
}
export interface DecisionPolicy { decide(context: DecisionContext, signal: AbortSignal): Promise<DecisionResult> }
export interface SlowThinker { think(context: DecisionContext, signal: AbortSignal): Promise<ThoughtProposal> }
export interface AgentEnvironment<C> {
  context(): C;
  observe(context: C): JsonValue;
  /** Public sensor projection, separate from private reasoning context. */
  perceive?(context: C): JsonValue;
  candidates(context: C): Candidate[];
  capabilities: readonly Capability<C>[];
  /** Output uses the same capability lifecycle, concurrently with physical execution. */
  output?: { candidates(context: C): Candidate[]; capabilities: readonly Capability<C>[] };
  /** Semantic changes only, not every animation frame. */
  revision?(context: C): string | number;
}
export interface ObservationEvidence {
  id: string; scope: Scope; observedAt: number; expiresAt: number; facts: JsonValue;
}
export type GroundingClaim = { kind: 'action'; id: string; status: ExecutionStatus }
  | { kind: 'observation'; id: string };
export interface ConversationContext {
  scope: Scope;
  currentAction: ActionReceipt | null;
  receipts: ActionReceipt[];
  observation: ObservationEvidence;
}

/** Host strategies remain separate from scheduling and execution authority. */
export interface AgentPolicies {
  canThink?(context: DecisionContext): boolean;
  acceptProposal?(proposal: ProposalRecord, context: DecisionContext): boolean;
  verifyCompletion?(context: DecisionContext, decision: DecisionResult): boolean;
}
export type AgentEvent =
  | { type: 'changed' | 'wake'; scope: Scope }
  | { type: 'decision-started'; context: DecisionContext; at: number }
  | { type: 'decision-resolved'; context: DecisionContext; result: DecisionResult; at: number }
  | { type: 'decision-applied'; context: DecisionContext; result: DecisionResult; previous: ActionReceipt | null; current: ActionReceipt | null; applied: boolean; at: number }
  | { type: 'discarded'; stage: 'decision' | 'thought'; scope: Scope }
  | { type: 'settled'; stage: 'decision' | 'thought'; scope: Scope }
  | { type: 'error'; stage: 'decision' | 'thought' | 'action'; scope: Scope; code: string; message: string; at: number }
  | { type: 'thought-started'; context: DecisionContext; at: number }
  | { type: 'proposal-created' | 'proposal-accepted' | 'proposal-rejected' | 'proposal-expired'; proposal: ProposalRecord; at: number }
  | { type: 'action-ended' | 'output-ended'; receipt: ActionReceipt; at: number }
  | { type: 'output-applied'; selection: Selection; previous: ActionReceipt | null; current: ActionReceipt | null; at: number }
  | { type: 'turn-completed'; turn: Turn; at: number };
