import { APIError, ResponseValidationError, SystemOneError, booleanQuestion, choice } from '@system-one-ai/sdk';
import type { EvaluationClient, State } from '@system-one-ai/sdk';
import { AgentError, candidateSnapshot, jsonCopy } from './common.js';
import type { Candidate, DecisionContext, DecisionPolicy, DecisionResult, JsonValue, Selection } from './types.js';

export interface DecisionInstructions { action: string; interrupt: string; think: string; complete: string; review: string }
const defaults: DecisionInstructions = {
  action: 'Select exactly one offered candidate for the latest user input. Resolve references using previous turns, but do not execute superseded requests. Respect completed execution receipts. With no active user task, choose a useful available activity. A request to approach/inspect an object does not authorize using it. Continue compatible running actions; wait when the user asks to stop or only converse.',
  interrupt: 'Should the current execution be cancelled to honor the latest correction or stop request? A request for another target should interrupt now. No current execution or a compatible continuation means false.',
  think: 'Should the slow thinker be consulted for reasoning, a new conversational reply, or reflection? Only when available, with no thought in flight and no pending unaccepted proposal. Direct executable commands usually need no additional thought.',
  complete: 'Is the entire latest user task fulfilled by completed receipts or an accepted conversational reply? Merely saying an action will be done, starting it, or proposing it is not completion.',
  review: 'Accept a pending relevant slow-thinking proposal supported by the supplied observations, character and user statements. Reject absent, stale, contradictory or unsupported proposals. Acceptance never executes its suggestions.',
};

export interface SystemOneDecision {
  decision: DecisionResult;
  candidateId: string;
  confidence: number | null;
  probabilities: Record<string, number>;
  interruptProbability: number;
  thinkProbability: number;
  completeProbability: number;
  reviewAccepted: boolean;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  status: number;
  requestId?: string;
  durationMs: number;
  speechChoice?: string;
}

/** Only SDK APIs are used here; provider URL/envelope handling belongs to the SDK. */
export class SystemOneDecisionPolicy implements DecisionPolicy {
  private timeout: number;
  private thresholds: { interrupt: number; think: number; complete: number };
  constructor(private client: EvaluationClient, private options: {
    instructions?: Partial<DecisionInstructions>; timeoutMs?: number;
    thresholds?: Partial<{ interrupt: number; think: number; complete: number }>;
  } = {}) {
    this.timeout = options.timeoutMs ?? 10000;
    this.thresholds = { interrupt: 0.7, think: 0.7, complete: 0.8, ...options.thresholds };
    if (!Number.isFinite(this.timeout) || this.timeout <= 0 || Object.values(this.thresholds).some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new AgentError('configuration', 'Invalid decision timeout or probability threshold.');
    }
  }

  async decide(context: DecisionContext, signal: AbortSignal): Promise<DecisionResult> {
    const result = await this.evaluate({ state: jsonCopy(context) as unknown as JsonValue, candidates: context.candidates,
      ...(context.channels ? { channels: Object.fromEntries(Object.entries(context.channels).map(([name, channel]) => [name, { candidates: channel.candidates }])) } : {}),
      ...(context.outputCandidates?.length ? { output: { instructions: 'Select an offered output action. Speaking requires an available proposal; accepting a proposal alone does not speak. Continue the current output or choose silent when nothing new should be said.', candidates: context.outputCandidates } } : {}) }, signal);
    return { ...result.decision, metadata: {
      source: 'system-one', model: result.model, status: result.status, durationMs: result.durationMs,
      ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      usage: { inputTokens: result.inputTokens ?? null, outputTokens: result.outputTokens ?? null },
    } };
  }

  async evaluate(input: { state: JsonValue; candidates: readonly Candidate[]; instructions?: Partial<DecisionInstructions>;
    output?: { instructions: string; candidates: readonly Candidate[] };
    channels?: Record<string, { instructions?: string; candidates: readonly Candidate[] }>;
    speech?: { instructions: string; choices: Record<string, string> } }, signal: AbortSignal): Promise<SystemOneDecision> {
    const candidates = candidateSnapshot(input.candidates);
    const outputs = input.output ? candidateSnapshot(input.output.candidates) : [];
    const instructions = { ...defaults, ...this.options.instructions, ...input.instructions };
    const criteria = Object.fromEntries(candidates.map(candidate => [candidate.id, candidate.description]));
    const channels = Object.entries(input.channels ?? {}).map(([name, channel]) => {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new AgentError('invalid_channel', 'Invalid channel name.');
      return { name, candidates: candidateSnapshot(channel.candidates), instructions: channel.instructions };
    });
    if (channels.length > 16) throw new AgentError('invalid_channel', 'At most 16 decision channels are supported.');
    const channelQuestions = Object.fromEntries(channels.map(channel => [`channel_${channel.name}`,
      choice(channel.instructions ?? `Select one available action for the ${channel.name} channel. Continue compatible active work. Waiting cancels this channel. A dispatched or unknown device operation is not completed.`,
        Object.fromEntries(channel.candidates.map(candidate => [candidate.id, candidate.description])))])) as Record<`channel_${string}`, ReturnType<typeof choice>>;
    try {
      const questions = {
        action: choice(instructions.action, criteria),
        interrupt: booleanQuestion(instructions.interrupt),
        think: booleanQuestion(instructions.think),
        request_complete: booleanQuestion(instructions.complete),
        accept_reflection: choice(instructions.review, { accept: 'Relevant pending proposal supported by current evidence.', reject: 'Absent, stale, contradictory or unsupported proposal.' }),
        ...channelQuestions,
      };
      const state = jsonCopy(input.state) as State, request = { signal, timeoutMs: this.timeout, maxRetries: 0 };
      const speech = input.output ? { instructions: input.output.instructions, choices: Object.fromEntries(outputs.map(c => [c.id, c.description])) } : input.speech;
      const result = speech
        ? await this.client.evaluate({ state, questions: { ...questions, speech: choice(speech.instructions, speech.choices) } }, request)
        : await this.client.evaluate({ state, questions }, request);
      const a = result.answers;
      const selected = candidates.find(candidate => candidate.id === a.action.choice);
      if (!selected) throw new AgentError('invalid_candidate', 'The model selected an unavailable candidate.');
      const speechChoice = 'speech' in a ? (a.speech as { choice: string }).choice : undefined;
      const output = speechChoice && outputs.find(c => c.id === speechChoice);
      if (input.output && !output) throw new AgentError('invalid_output_candidate', 'The model selected an unavailable output action.');
      const reviewAccepted = a.accept_reflection.choice === 'accept';
      const selections: Record<string, Selection> = Object.fromEntries(channels.map(channel => {
        const answer = (a as unknown as Record<string, { choice?: unknown }>)[`channel_${channel.name}`];
        const selected = channel.candidates.find(candidate => candidate.id === answer?.choice);
        if (!selected) throw new AgentError('invalid_channel_candidate', 'The model selected an unavailable channel action.');
        return [channel.name, structuredClone(selected.selection)];
      }));
      return {
        decision: { selection: structuredClone(selected.selection), ...(output ? { output: structuredClone(output.selection) } : {}), interrupt: a.interrupt.probability >= this.thresholds.interrupt,
          think: a.think.probability >= this.thresholds.think, complete: a.request_complete.probability >= this.thresholds.complete, acceptProposal: reviewAccepted,
          ...(channels.length ? { channels: selections } : {}) },
        candidateId: selected.id, confidence: a.action.confidence ?? null, probabilities: { ...a.action.probabilities },
        interruptProbability: a.interrupt.probability, thinkProbability: a.think.probability, completeProbability: a.request_complete.probability,
        reviewAccepted, model: result.model, status: result.response.status, requestId: result.response.requestId,
        durationMs: result.response.durationMs, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
        ...('speech' in a ? { speechChoice: (a.speech as { choice: string }).choice } : {}),
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof AgentError) throw error;
      if (error instanceof APIError) throw new AgentError(`http_${error.statusCode}`, `Decision service returned HTTP ${error.statusCode}.`,
        Math.max(error.statusCode === 401 ? 30000 : 5000, error.retryAfterMs ?? 0));
      if (error instanceof ResponseValidationError) throw new AgentError('response', 'Decision response did not pass SDK validation.');
      if (error instanceof SystemOneError) throw new AgentError(error.code, error.code === 'timeout' ? 'Decision request timed out.' : 'Decision SDK request failed.');
      throw new AgentError('decision_failed', 'Decision service unavailable.');
    }
  }
}
