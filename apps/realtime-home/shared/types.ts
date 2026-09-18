import type { MindState, SelfInsight } from './mind';

export type Vec2 = { x: number; z: number };
export type ActionId = 'relax' | 'eat' | 'drink' | 'sleep' | 'read' | 'work' | 'water' | 'wash';
export type Choice = ActionId | 'idle' | 'continue';
export type Need = 'energy' | 'satiety' | 'hydration' | 'happiness';
export type Room = 'living' | 'kitchen' | 'bedroom' | 'study';
export type Mode = 'demo' | 'live';
export interface ModelReceipt {
  status: number;
  receivedAt: number;
  model?: string;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
}
export interface ActionSpec {
  id: ActionId;
  label: string;
  verb: string;
  room: Room;
  object: string;
  position: Vec2;
  destination: Vec2;
  size: Vec2;
  duration: number;
  effects: Partial<Record<Need, number>>;
  description: string;
}
export interface RunningAction {
  id: ActionId;
  startedAt: number;
  requestId: string | null;
  goalId?: string;
  phase: 'walking' | 'acting';
  progress: number;
  elapsed: number;
  path: Vec2[];
}
export interface Intent { id: string; text: string; completed: boolean; createdAt: number; replySuppressed?: boolean; replyChannel?: 'native'; replyDelivered?: boolean }
export type InputSource = 'text' | 'voice' | 'object';
export interface MessageInput {
  text: string;
  source?: InputSource;
  epoch?: string;
  client?: { id: string; sequence: number };
}
/** All timestamps use the server clock; browser round-trip latency is measured separately. */
export interface RealtimeTurn {
  id: string;
  source: InputSource;
  receivedAt: number;
  previousAction: ActionId | null;
  decisionStartedAt: number | null;
  decisionAt: number | null;
  appliedAt: number | null;
  appliedAction: Choice | null;
  replyAt: number | null;
  supersededAt: number | null;
  replyCancelledAt: number | null;
  error: string | null;
}
export interface MessageReceipt { ok: true; turnId: string; receivedAt: number; duplicate: boolean }
export interface Outcome { id: string; action: ActionId; requestId: string | null; at: number; effects: string }
export interface ChatMessage { id: string; role: 'user' | 'agent' | 'system'; text: string; at: number; initiative?: boolean; turnId?: string; nativeAudio?: boolean }
export interface Memory { id: string; text: string; source: 'experience' | 'reflection'; at: number; evidenceIds?: string[]; evidenceText?: string }
export interface Reflection {
  id: string;
  summary: string;
  reply: string;
  suggestedActions: ActionId[];
  memories: string[];
  createdAt: number;
  intentVersion: number;
  accepted: boolean;
  source: 'llm' | 'demo';
  receipt?: ModelReceipt;
  self?: SelfInsight;
  purpose?: 'conversation' | 'autonomous';
  evidenceSequence?: number;
  contextEvidenceIds?: string[];
}
export interface Decision {
  action: Choice;
  confidence: number | null;
  probabilities: Record<string, number>;
  interrupt: number;
  think: number;
  requestComplete: number;
  acceptReflection: number;
  source: 'jev' | 'demo';
  latencyMs: number;
  receipt?: ModelReceipt;
}
export interface Trace {
  id: string;
  at: number;
  kind: 'decision' | 'action' | 'thought' | 'guard' | 'error';
  title: string;
  detail: string;
  latencyMs?: number;
  confidence?: number | null;
  source?: string;
  receipt?: ModelReceipt;
  requestedAt?: number;
  turnId?: string;
}
export interface DecisionScheduler {
  intervalMs: number;
  ticks: number;
  lastTickAt: number | null;
  nextTickAt: number | null;
  lastRequestAt: number | null;
  retryAt: number | null;
  status: 'waiting' | 'deciding' | 'executing' | 'thinking' | 'backoff' | 'paused';
}
export interface WorldState {
  epoch: string;
  version: number;
  intentVersion: number;
  elapsed: number;
  paused: boolean;
  speed: 1 | 2 | 4;
  mode: Mode;
  connected: { jev: boolean; llm: boolean; jevModel: string; llmModel: string };
  agent: { name: string; position: Vec2; needs: Record<Need, number>; action: RunningAction | null };
  intent: Intent | null;
  attending: boolean;
  nativeVoiceActive: boolean;
  turns: RealtimeTurn[];
  objects: { plantMoisture: number; dishesClean: boolean };
  messages: ChatMessage[];
  memories: Memory[];
  mind: MindState;
  outcomes: Outcome[];
  traces: Trace[];
  reflection: Reflection | null;
  thinking: boolean;
  deciding: boolean;
  decision: Decision | null;
  error: string | null;
  scheduler: DecisionScheduler;
  metrics: { decisions: number; jevCalls: number; llmCalls: number; reflections: number; started: number; completed: number; interrupted: number; discarded: number };
}
export interface DecisionContext {
  state: WorldState;
  candidates: Partial<Record<Choice, string>>;
  observedAt?: number;
}
export interface FastProvider {
  decide(context: DecisionContext, signal: AbortSignal): Promise<Decision>;
}
export type ThoughtResult = Pick<Reflection, 'summary' | 'reply' | 'suggestedActions' | 'memories' | 'receipt' | 'self'>;
export interface SlowProvider {
  reflect(context: DecisionContext, signal: AbortSignal): Promise<ThoughtResult>;
}
