import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { SystemOne } from '@system-one-ai/sdk';
import { AgentError } from '@realtime-agent/agent';
import type { JsonValue } from '@realtime-agent/agent';
import { SystemOneDecisionPolicy } from '@realtime-agent/agent/system-one';
import { cloudflareAdapter } from '@system-one-ai/sdk/adapters/cloudflare';
import { chatCompletionEndpoint, chatCompletionOptions, cloudflareResult, isCloudflareAiUrl } from '@realtime-agent/config';
import { ACTION_IDS, ACTIONS, isAction, isMovement, nearbyObservation, observeTarget, roomAt, TARGETS } from '../shared/world';
import { speechCandidates } from './voice/output';
import { homeTargetForId, homeCandidates, HOME_TARGETS } from './agent-environment';
import type { ActionId, Choice, Decision, DecisionContext, FastProvider, ModelReceipt, SlowProvider, TargetId, ThoughtResult } from '../shared/types';
import { activeGoal, personalInclinations, recall, reflectionOpportunity, remainingGoalActions } from './mind';

export class ProviderError extends Error {
  constructor(message: string, public retryAfterMs = 5000, public receipt?: ModelReceipt) { super(message); }
}

/** Error bodies can echo credentials. Only sanitized status information crosses this boundary. */
async function requestJson(url: string, key: string, body: unknown, signal: AbortSignal, timeout: number, fetcher: typeof fetch) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: combined, redirect: 'error' });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new ProviderError(combined.aborted ? '模型请求超时，请检查连接。' : '无法连接模型服务，请检查网络和配置。');
  }
  if (!response.ok) {
    const value = response.headers.get('retry-after');
    const retry = value ? (/^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()) : 0;
    void response.body?.cancel().catch(() => undefined);
    throw new ProviderError(`模型服务返回 HTTP ${response.status}，请检查密钥、模型名称或额度。`, Math.min(60000, Math.max(response.status === 401 ? 30000 : 5000, Number.isFinite(retry) ? retry : 0)));
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('模型返回了空响应。');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  combined.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      combined.throwIfAborted();
      const { done, value } = await reader.read();
      combined.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > 131072) { cancel(); throw new ProviderError('模型响应过大，已拒绝。'); }
      chunks.push(value);
    }
    const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let data: unknown = decoded;
    if (isCloudflareAiUrl(url)) {
      try { data = cloudflareResult(decoded); }
      catch { throw new ProviderError('Cloudflare 模型请求失败，请检查 API Token 权限、账户余额与模型访问权限。'); }
    }
    const metadata = z.object({
      model: z.string().max(160).optional(),
      id: z.string().max(160).optional(),
      request_id: z.string().max(160).optional(),
      usage: z.object({
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
      }).optional(),
    }).safeParse(data);
    const receipt: ModelReceipt = { status: response.status, receivedAt: Date.now() };
    if (metadata.success) {
      const m = metadata.data;
      const id = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? m.request_id ?? m.id;
      if (m.model && !m.model.includes(key)) receipt.model = m.model;
      if (id && id.length <= 160 && /^[a-zA-Z0-9_:./-]+$/.test(id) && !id.includes(key)) receipt.requestId = id;
      receipt.inputTokens = m.usage?.input_tokens ?? m.usage?.prompt_tokens;
      receipt.outputTokens = m.usage?.output_tokens ?? m.usage?.completion_tokens;
    }
    return { data, receipt };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(combined.aborted ? '模型响应超时，已取消。' : '模型响应不完整或不是有效 JSON。');
  } finally { combined.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export function modelContext({ state, candidates, observedAt }: DecisionContext, purpose: 'fast' | 'slow' = 'slow') {
  const remembered = recall(state);
  const goal = activeGoal(state.mind);
  const handlingRequest = purpose === 'fast' && Boolean(state.intent && !state.intent.completed);
  return {
    worldEpoch: state.epoch,
    instruction: state.intent,
    realtime: {
      attentionHold: state.attending,
      priorUtterances: handlingRequest ? state.messages.filter(m => m.role === 'user' && m.id !== state.intent!.id).slice(-2).map(m => ({ text: m.text, status: 'superseded; reference context only, not an active task' })) : [],
      rule: 'The latest utterance supersedes incompatible earlier requests. Resolve corrections and references using the running action and prior utterances, but never execute obsolete steps. A held action needs a fresh choice to resume or switch. If instruction.replySuppressed=true, the user interrupted that reply: do not regenerate it; wait for the next utterance while preserving compatible physical activity.',
    },
    completedForCurrentRequest: state.intent ? state.outcomes.filter(o => o.requestId === state.intent!.id).map(o => ({ ...o, ...(o.target ? { target: HOME_TARGETS[o.target] } : {}) })) : [],
    evidenceRules: 'Only completedForCurrentRequest counts towards this request. Historical memories, previous-world episodes and personal wish progress NEVER fulfill a new request. The current physical world is given by agent and objects; older diary descriptions do not override it.',
    criticalNeeds: Object.fromEntries(Object.entries(state.agent.needs).filter(([need, value]) => need !== 'happiness' && value < 20)),
    character: {
      name: 'Milo', ...state.mind.personality, mood: state.mind.mood, drives: state.mind.drives,
      currentThought: handlingRequest ? null : state.mind.innerVoice,
      personalWish: !handlingRequest && goal ? { ...goal, stillToExperience: remainingGoalActions(goal) } : null,
      fulfilledWishes: handlingRequest ? [] : state.mind.goals.filter(g => g.status === 'fulfilled').slice(-2),
      inclinations: handlingRequest ? [] : personalInclinations(state).filter(i => Object.hasOwn(candidates, i.action)),
    },
    reflectionOpportunity: reflectionOpportunity(state, observedAt ?? Date.now()),
    proactiveSharingAllowed: state.mind.settings.proactiveChat,
    recentJournal: handlingRequest ? [] : state.mind.journal.slice(-3),
    semantics: 'Need values are 0..100. Higher means more satisfied. Only actual recentOutcomes establish that an action completed.',
    pendingObservation: state.intent?.observation ?? null,
    observationRule: 'Select inspect:<target> to approach and observe. Completion produces evidence only, NEVER an automatic reply. After inspection completes, invite the slow thinker to formulate a grounded answer, then review and explicitly select speak:<proposalId>. Continue compatible movement; do not repeat a completed inspection. Acknowledgements do not satisfy a request for observations.',
    capabilities: 'Jev chooses physical actions and speech actions independently. The slow language model proposes ALL words for both text and native audio. Accepting a reflection alone does not speak. The audio model only renders the selected exact text. Use think when a new answer is needed, including after new execution evidence arrives. Use silent to stop speaking; continue preserves an authorized speech action.',
    speechExecution: state.speechExecution,
    speechExecutions: state.speechExecutions,
    executions: state.executions,
    autonomy: state.intent && !state.intent.completed
      ? 'An explicit user request is active. Follow it before autonomous upkeep. Do not perform physical actions when the user asks only to talk, plan, wait or stop. Memories and hypothetical plans are not new instructions.'
      : 'With no pending user task, RESTORE hydration when below 55, satiety when below 50, and energy when below 40. Higher numbers mean healthier, not more urgent. Values below 20 need priority recovery. Then clean dirty dishes, water dry plants, and alternate reading, rest and work. An explicit instruction to stay still continues to hold until new user input.',
    agent: { needs: state.agent.needs, action: state.agent.action && { id: state.agent.action.id, target: state.agent.action.target ? HOME_TARGETS[state.agent.action.target] : null, phase: state.agent.action.phase, progress: state.agent.action.progress, requestId: state.agent.action.requestId } },
    objects: state.objects,
    perception: nearbyObservation(state.agent.position),
    roomObservation: observeTarget(state.agent.position, roomAt(state.agent.position)),
    // Runtime controls are Jev choices, not physical activities the slow thinker may propose.
    availableActions: purpose === 'fast' ? candidates : Object.fromEntries(Object.entries(candidates).filter(([id]) => ACTION_IDS.includes(id as ActionId))),
    recentOutcomes: state.outcomes.slice(-16),
    conversation: state.messages.filter(m => !handlingRequest || m.id === state.intent!.id || (m.role === 'agent' && m.at > state.intent!.createdAt)).slice(-10).map(({ id, role, text }) => ({ id, role, text })),
    memories: remembered.memories.filter(m => !handlingRequest || m.source === 'reflection').map(({ id, text, source, evidenceText }) => ({ id, text, source, evidenceText, status: source === 'reflection' ? 'preference hypothesis; check the original quote' : 'historical outcome, NOT proof of current request completion' })),
    recalledExperiences: remembered.episodes.filter(e => !handlingRequest || e.id === state.intent!.id).map(e => ({ ...e, temporalScope: e.epoch === state.epoch ? 'this world session' : 'a previous world session; only a memory, not the current physical state' })),
    reflection: state.reflection,
    reflectionEvidence: state.reflection?.self ? {
      purpose: state.reflection.purpose,
      allIdsExist: state.reflection.self.evidenceIds.length > 0 && state.reflection.self.evidenceIds.every(id => state.mind.episodes.some(e => e.id === id) && state.reflection!.contextEvidenceIds?.includes(id)),
      note: 'Autonomous diary is a subjective interpretation of actual episodes; it does not need a user question. Its wish is a future possibility, not a claim of a completed action.',
    } : null,
    slowThinkingInProgress: state.thinking,
    slowThinkingAvailable: (!state.intent?.replySuppressed || !!state.intent.completed) && (state.mode === 'demo' || state.connected.llm),
  };
}

export class JevProvider implements FastProvider {
  private policy: SystemOneDecisionPolicy;
  constructor(private key: string, private model = 'jev-latest', private fetcher = fetch, baseUrl = 'https://api.typesafe.ai/v1') {
    const accountId = (() => {
      try { return new URL(baseUrl).pathname.match(/\/accounts\/([a-f0-9]{32})\/ai(?:\/run)?\/?$/i)?.[1]; }
      catch { return undefined; }
    })();
    this.policy = new SystemOneDecisionPolicy(new SystemOne({
      apiKey: this.key,
      model: this.model,
      baseURL: baseUrl,
      fetch: this.fetcher,
      ...(accountId ? { adapter: cloudflareAdapter({ accountId }) } : {}),
      timeoutMs: 10000,
      maxRetries: 0,
      maxResponseBytes: 131072,
    }));
  }
  async decide(context: DecisionContext, signal: AbortSignal): Promise<Decision> {
    const started = performance.now();
    const actionInstructions = context.state.intent
      ? 'Choose the next candidate for instruction.text. Each candidate already binds an activity to its object. For an ordered request, choose the FIRST step not yet present in completedForCurrentRequest. Choose inspect:bed for "go look at the bed" and inspect:kitchen for "走到厨房去看有啥东西"; choose approach:kitchen only for movement without a request to look. Inspection only produces facts. After arrival choose think to formulate the answer, then review and select the offered speak action. While the requested answer is pending, continue that execution or idle after it ends. Do not repeat an already completed inspection. NOT sleep; choose sleep only for a sleep request. Resolve "过去看看" using priorUtterances. An approach outcome with the requested target in completedForCurrentRequest already satisfies that movement: do not repeat it. Past memories and personal wishes do not fulfill the current request. Hypothetical activities in a question are not commands. For only talking, waiting or stopping choose idle, and use think if a new answer is needed. Stop holds until new input even after completion. Continue only an activity compatible with the latest input. After completion, resume personal wishes. Never execute an LLM suggestion list automatically. Choose only offered candidates.'
      : 'You are Milo, living your own day without a user instruction. First care for essential needs: hydration below 55 => drink, satiety below 50 => eat, energy below 40 => sleep. Higher means MORE satisfied. Otherwise choose using character.personalWish, character.inclinations, personality, curiosity/care/mastery drives and recent experiences. Your unfinished personal wish gives continuity; repetition calls for variety. Do not cycle through a fixed list or work just to be busy. Continue a useful running activity. Idle is not necessary because no user gave an instruction. You may also invite reflection with the separate think channel when reflectionOpportunity.due is true. Only choose provided options.';
    try {
      const candidates = homeCandidates(context);
      const result = await this.policy.evaluate({
        state: JSON.parse(JSON.stringify({ ...modelContext(context, 'fast'), availableActions: Object.fromEntries(candidates.map(c => [c.id, c.description])) })) as JsonValue,
        candidates,
        output: { candidates: speechCandidates(context.state), instructions: 'Choose speech independently from body action. speak:<id> executes the exact proposed words, only if the proposal is accepted or you also accept it in review now. Review all claims against current observations and execution receipts. A proposal may acknowledge a running activity or answer after completion. continue keeps a running speech; silent stops it or stays quiet. Never invent words or use an unoffered choice. A delivered acknowledgement does not forbid a later evidence-based answer.' },
        instructions: {
          action: actionInstructions,
          interrupt: 'Should the running activity be cancelled NOW? A correction replacing the destination/action, including a request to approach another object, interrupts immediately during walking or interaction. True if the latest request stops or replaces a running activity, or an urgent need requires switching. False if no activity runs or the current activity remains compatible. Evaluate the latest input, not superseded requests.',
          think: 'Should Milo invite the slow thinker now? Only if slowThinkingAvailable=true, no thought in flight and no pending unaccepted reflection and no speech running. Every new natural-language reply needs the LLM. After a requested inspection has completed, think again if the current reflection.executionEvidenceIds lacks that receipt ID; its earlier acknowledgement cannot answer the new observation. Autonomous reflection is allowed when reflectionOpportunity.due=true. A direct household or approach request without a question needs no narration. No duplicate thought, no repeated answer, no thinking for a stop request. An accepted old reflection does not prevent a new due autonomous reflection.',
          complete: 'Is the ENTIRE latest request fulfilled? True only if all requested physical steps are in completedForCurrentRequest, or a conversation has a completed speak receipt. An inspection additionally needs a completed speak receipt whose evidenceIds includes that inspection receipt, or an explicit stop has stopped the body. No active request, missing physical steps, or an unanswered conversation means false. Past memories, proposals and audio promises are not physical completion.',
          review: 'Accept a relevant pending conversational reply grounded in user statements and character, or a subjective autonomous diary with reflectionEvidence.allIdsExist=true and no invented events. Opinions and plans need not be physical outcomes. Reject absent, already accepted, irrelevant, contradictory or unsupported reflections. Missing cited evidence and invented physical completion are rejection reasons.',
        },
      }, signal);
      const selection = result.decision.selection;
      const target = selection.kind === 'execute' && selection.call.target ? homeTargetForId(selection.call.target) : undefined;
      const action: Choice = selection.kind === 'continue' ? 'continue' : selection.kind === 'wait' ? 'idle'
        : selection.call.capability === 'move_to' ? 'approach' : selection.call.capability === 'inspect' ? 'inspect' : target as ActionId;
      const safeMetadata = (value?: string) => value && value.length <= 160 && !(this.key && value.includes(this.key)) ? value : undefined;
      const receipt: ModelReceipt = {
        status: result.status,
        receivedAt: Date.now(),
        model: safeMetadata(result.model),
        requestId: safeMetadata(result.requestId),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
      return {
        action, target: isMovement(action) ? target : null, ...(result.speechChoice ? { speech: result.speechChoice } : {}),
        confidence: result.confidence, probabilities: result.probabilities,
        interrupt: result.interruptProbability, think: result.thinkProbability,
        requestComplete: result.completeProbability, acceptReflection: Number(result.reviewAccepted),
        source: 'jev', latencyMs: Math.round(performance.now() - started), receipt,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof AgentError) {
        const message = /^http_\d{3}$/.test(error.code) ? `模型服务返回 HTTP ${error.code.slice(5)}，请检查密钥、模型名称或额度。`
          : error.code === 'response' ? 'Jev 返回的数据未通过 SDK 校验，已拒绝执行。'
          : error.code === 'timeout' ? '模型请求超时，请检查连接。' : 'Jev SDK 请求失败，正在保留现场并等待重试。';
        throw new ProviderError(message, error.retryAfterMs);
      }
      throw error;
    }
  }
}

const thoughtSchema = z.object({
  summary: z.string().trim().min(1).max(800), reply: z.string().trim().max(1200),
  // These advisory channels can be absent in an ordinary conversational answer.
  // Null/missing means no proposal; actual proposals still need full enum/string validation.
  suggestedActions: z.preprocess(value => value == null ? [] : value, z.array(z.enum(ACTION_IDS as [ActionId, ...ActionId[]])).max(8)),
  memories: z.preprocess(value => value == null ? [] : value, z.array(z.string().trim().min(1).max(240)).max(4)),
  self: z.preprocess(value => value === null ? undefined : value, z.object({
    thought: z.string().trim().min(1).max(400),
    journal: z.string().trim().max(600),
    evidenceIds: z.array(z.string().max(100)).min(1).max(8),
    // Only these proposal fields have meaning. Drop extra model commentary such as
    // status/personality rather than granting it authority or losing a valid diary.
    wish: z.object({ title: z.string().trim().min(1).max(100), motivation: z.string().trim().min(1).max(240), actions: z.array(z.enum(ACTION_IDS as [ActionId, ...ActionId[]])).min(1).max(4) }).strip().nullable().optional(),
  }).strip().optional()),
}).strict();

export class LanguageModelProvider implements SlowProvider {
  constructor(private baseUrl: string, private key: string, private model: string, private fetcher = fetch) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('LLM_BASE_URL must use HTTPS or loopback HTTP without embedded credentials.');
  }
  async reflect(context: DecisionContext, signal: AbortSignal): Promise<ThoughtResult> {
    const automatic = !context.state.intent || context.state.intent.completed;
    const { data: raw, receipt } = await requestJson(chatCompletionEndpoint(this.baseUrl), this.key, {
      model: this.model,
      messages: [
        { role: 'system', content: `You are Milo's reflective voice: an inhabitant of this virtual home with stable character, evolving interests, moods and personal wishes. Speak in natural Chinese as Milo, using character.voice, likes, values, current mood and the experiences supplied. You may express your own taste, hesitation, curiosity or a gentle disagreement, rather than echoing orders. Be concrete, warm and brief. Do not say "收到指令", "任务完成", expose numerical needs, call the user master, or promise unconditional obedience. Avoid formulaic greetings, repeated questions, clinginess or asking the user to keep you company.
When an ACTIVE user message exists, answer that message, including questions about earlier preferences using memories and their original evidenceText. Distinguish the USER's preference from YOUR own; admit missing memories. A personality is not a reason to arbitrarily disobey a clear household request. An earlier episode is a MEMORY, never proof that the current request was completed or that a plant is currently wet; current world state is authoritative. Output memories ONLY for a NEW durable preference explicitly stated in the current user message, at most 2 plain strings. The objects in observation.memories are INPUT EVIDENCE, not the output format: never copy those objects to the output. Example for a new preference: "memories":["用户喜欢安静读书"]. When merely recalling a previously stated preference, output "memories":[]; do not store the same preference again or cite the recall QUESTION as evidence of that preference. Never store temporary requests or inferred sensitive facts. Changing a user's taste does not rewrite your core personality.
Do not volunteer, promise or narrate a physical action merely because the user asked for it. Jev is the only body controller. You may say "我正在…" only when observation.agent.action proves that exact accepted action is running. For appearance/color questions, use observation.perception or completed inspection receipts; for room inventory use roomObservation and completed inspection receipts; if it is null or describes another object, say you cannot currently see the requested object closely enough. An approach outcome means Milo walked close enough to inspect the target; it does not perform the target's household activity.
When NO active user message exists, this is your own reflection on recent life. Produce self with a short first-person character note and diary grounded in recalledExperiences. If your personalWish is absent/fulfilled, propose ONE small wish (title, motivation, 1..4 actions) based on your character and what you just experienced; otherwise retain the current wish with wish:null. Your diary is an interpretation, NOT an invented event. You cannot read the actual contents of books, see a plant grow, recall a childhood, or claim unobserved physical events. Cite exact existing recalledExperiences IDs in self.evidenceIds. If there is nothing worth saying aloud, reply can be empty. Otherwise optionally share ONE short observation naturally, only when proactiveSharingAllowed; do not announce a status report. Keep memories empty during autonomous reflection.
You CANNOT execute actions, mark wishes complete, change numeric state or change core traits. Only the fast system decides action and accepts suggestions. Refer only to events provided, and never claim unseen actions completed. Your reply is only a speech proposal: Jev must explicitly select speak before it is delivered. Acknowledge an ongoing request briefly if useful, and answer from new inspection results when provided. Do not output chain-of-thought or internal model reasoning: self.thought is an intentional short public character note, like a diary sentence.
Valid physical action IDs: ${ACTION_IDS.join(', ')}. suggestedActions contains only proposals for NEW physical activities when a plan is requested. For ordinary conversation, including talking while the current activity continues, return suggestedActions:[]. Continuing the current activity requires no new proposal. Never put runtime control words such as continue, idle, stop, talk or think in suggestedActions; they are not physical action IDs. Return JSON ONLY: {"summary":"一句话概括","reply":"给室友的自然回复，或空字符串","suggestedActions":[],"memories":[],"self":{"thought":"一句公开的心声","journal":"简短随记，引用真实经历而不是任务清单","evidenceIds":["an-exact-existing-episode-id"],"wish":null}}. self may be omitted for ordinary conversation. Arrays are [] when empty. No additional keys or markdown.` },
        { role: 'system', content: automatic
          ? 'This invocation is AUTONOMOUS REFLECTION. Required output keys: summary, reply, suggestedActions, memories, self. memories must be []. self must cite real supplied episode IDs; the diary may express a subjective feeling but cannot invent a past physical event. An unfinished personal wish remains unchanged.'
          : 'This invocation is a REAL-TIME CONVERSATION. Respond directly to the latest utterance in one or two short natural Chinese sentences, unless more detail was explicitly requested. A correction replaces incompatible earlier requests. Do not answer an old question after the topic changes. Return ONLY these four keys: summary (string), reply (a brief natural Chinese answer), suggestedActions (array), memories (array of plain strings). DO NOT include self or write a diary here; your autonomous reflection handles that separately. For a recall question, memories must be []. Answer both remembered user preferences and your own interests when asked. Talk about your taste as a preference, not a claim that past events happened in the current world. Format only: {"summary":"回应当前问题","reply":"基于提供的证据和性格，用自然中文回答","suggestedActions":[],"memories":[]}.' },
        { role: 'user', content: JSON.stringify({ purpose: automatic ? 'autonomous' : 'conversation', ...modelContext(context) }) },
      ],
      response_format: { type: 'json_object' }, ...chatCompletionOptions(this.baseUrl),
    }, signal, 30000, this.fetcher);
    const envelope = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }).safeParse(raw);
    if (!envelope.success) throw new ProviderError('慢思考服务没有返回可用文本。', 5000, receipt);
    let decoded: unknown;
    try { decoded = JSON.parse(envelope.data.choices[0].message.content); }
    catch { throw new ProviderError('慢思考没有返回有效 JSON，已丢弃。', 5000, receipt); }
    const result = thoughtSchema.safeParse(decoded);
    if (!result.success) {
      const fields = new Set(['summary', 'reply', 'suggestedActions', 'memories', 'self']);
      const issues = result.error.issues.map(issue => {
        const field = String(issue.path[0] ?? 'response');
        return `${fields.has(field) ? field : 'response'}:${issue.code}`;
      });
      // Log only fixed field names and validation codes, never a raw provider body or prompt.
      console.warn(`Slow response validation failed: ${[...new Set(issues)].join(', ')}`);
      throw new ProviderError(`慢思考建议未通过结构校验（${[...new Set(issues)].join(', ')}），已丢弃。`, 5000, receipt);
    }
    const { self, ...response } = result.data;
    return { ...response, ...(automatic && self ? { self } : {}), receipt };
  }
}

const PATTERNS: [ActionId, RegExp][] = [
  ['drink', /喝水|倒.*?水|口渴|drink|thirst/gi], ['water', /浇水|浇花|植物|盆栽|water.*?plant/gi],
  ['eat', /吃|饿|简餐|eat|hungry/gi], ['sleep', /睡|小憩|sleep|nap/gi],
  ['relax', /休息|放松|沙发|relax|rest/gi], ['read', /看(?:一会儿|会儿|一会|几页|一本)?书|读(?:几页|一本)?书|阅读|read/gi],
  ['work', /工作|办公|专注|work/gi], ['wash', /洗碗|餐具|清洗|收拾厨房|wash|dishes/gi],
];
export function demoRequestedActions(text: string): ActionId[] {
  const clauses = text.split(/[，,。；;]|然后|再|接着/);
  return clauses.flatMap(clause => {
    if (/不要|别|不许|don't/i.test(clause)) return [];
    return PATTERNS.map(([id, pattern]) => ({ id, match: new RegExp(pattern.source, 'i').exec(clause) }))
      .filter(item => item.match).sort((a, b) => a.match!.index - b.match!.index).map(item => item.id);
  });
}

const demoTarget = (text: string) => ([
  ['sleep', /床|\bbed\b/i], ['relax', /沙发|sofa/i], ['read', /书架|bookshelf/i], ['work', /书桌|桌子|desk/i],
  ['water', /植物|绿植|盆栽|plant/i], ['wash', /水槽|sink/i], ['drink', /饮水|饮水台|water station/i], ['eat', /料理台|灶台|counter|stove/i],
  ['kitchen', /厨房|kitchen/i], ['bedroom', /卧室|bedroom/i], ['living', /客厅|living room/i], ['study', /书房|study/i],
] as [TargetId, RegExp][]).find(([, pattern]) => pattern.test(text))?.[0];
const appearanceQuestion = (text: string) => /颜色|外观|长什么样|有(?:什么|啥)|哪些东西|color|appearance|what.*(?:in|there)/i.test(text);

/** Local rules are an explicit demo, never a replacement for failed live inference. */
export class DemoFastProvider implements FastProvider {
  async decide({ state, candidates, observedAt }: DecisionContext, signal: AbortSignal): Promise<Decision> {
    signal.throwIfAborted();
    const start = performance.now();
    const intent = state.intent && !state.intent.completed ? state.intent : null;
    const text = intent?.text ?? '';
    const reflection = state.reflection?.intentVersion === state.intentVersion ? state.reflection : null;
    const conversationOnly = /你.*(喜欢|性格|打算|想做|心情|愿望)|自己的.*(想法|愿望)|还记得|记住|只聊|不要.*(行动|执行)/.test(text);
    const priorQuestion = state.messages.filter(m => m.role === 'user' && m.id !== intent?.id).at(-1)?.text ?? '';
    const priorTarget = appearanceQuestion(priorQuestion) ? demoTarget(priorQuestion) : undefined;
    const approachTarget = intent && !conversationOnly && !/不要|别|不用|don't/i.test(text)
      && /(过去|走到|走近|靠近|去看|看看|看一下|查看|观察|确认|go to|look at|check)/i.test(text)
      ? demoTarget(text) ?? priorTarget ?? null : null;
    const inspecting = !!approachTarget && (appearanceQuestion(text) || /去看|看看|看一下|查看|观察|look|check/i.test(text) || approachTarget === priorTarget);
    const movement = inspecting ? 'inspect' : 'approach';
    const requested = conversationOnly || approachTarget ? [] : demoRequestedActions(text);
    const completed = state.outcomes.filter(o => o.requestId === intent?.id).map(o => o.action);
    const planned = conversationOnly ? [] : requested.length ? requested : reflection?.suggestedActions ?? [];
    const pending = planned.filter(id => {
      const index = completed.indexOf(id);
      if (index >= 0) { completed.splice(index, 1); return false; }
      if (id === 'water' && state.objects.plantMoisture > 90) return false;
      if (id === 'wash' && state.objects.dishesClean) return false;
      return true;
    });
    const stop = /^(停下|停止|别动|站住|stop|暂停动作)/i.test(state.intent?.text.trim() ?? '');
    const approachDone = Boolean(intent && approachTarget && state.outcomes.some(o => o.requestId === intent.id && o.action === movement && o.target === approachTarget));
    const observationReceipt = state.executions?.find(r => r.id === intent?.observation?.executionId && r.status === 'completed');
    const needsObservationReply = !!observationReceipt && !reflection?.executionEvidenceIds?.includes(observationReceipt.id);
    const needsThought = Boolean(!stop && !state.speechExecution && (intent
      ? needsObservationReply || ((!requested.length && !approachTarget) || /计划|安排|为什么|记住|复盘|建议|喜欢|想法|心情|聊|plan|remember/i.test(text)) && !reflection
      : reflectionOpportunity(state, observedAt ?? Date.now()).due && (!reflection || reflection.accepted)));
    let action: Choice = 'idle';
    if (!stop && intent && approachTarget && !approachDone && candidates[movement]) action = movement;
    else if (!stop && intent && pending.length) action = candidates[pending[0]] ? pending[0] : 'idle';
    else if (!stop && !conversationOnly && state.agent.action) action = 'continue';
    else if (!stop && !intent) {
      const n = state.agent.needs;
      if (n.hydration < 55) action = 'drink';
      else if (n.satiety < 50) action = 'eat';
      else if (n.energy < 40) action = 'sleep';
      else if (!state.objects.dishesClean) action = 'wash';
      else if (state.objects.plantMoisture < 45) action = 'water';
      else action = personalInclinations(state).find(i => candidates[i.action])?.action ?? 'relax';
    }
    if (action === state.agent.action?.id && (!isMovement(action) || state.agent.action.target === approachTarget)) action = 'continue';
    const requestComplete = Boolean(intent && (!intent.observation || intent.replyDelivered)
      && (stop ? !state.agent.action : approachDone || (planned.length > 0 && !pending.length) || (!planned.length && reflection?.accepted)));
    const speech = state.speechExecution ? 'continue' : speechCandidates(state).find(c => c.selection.kind === 'execute')?.id ?? 'silent';
    return { action, target: isMovement(action) ? approachTarget : null, speech, confidence: null, probabilities: {}, interrupt: Number(Boolean(intent && action !== 'continue' && state.agent.action)), think: Number(needsThought), requestComplete: Number(requestComplete), acceptReflection: Number(Boolean(reflection && !reflection.accepted)), source: 'demo', latencyMs: Math.round(performance.now() - start) };
  }
}

export class DemoSlowProvider implements SlowProvider {
  async reflect({ state }: DecisionContext, signal: AbortSignal): Promise<ThoughtResult> {
    await delay(1200, undefined, { signal });
    const episodes = recall(state).episodes;
    if (!state.intent || state.intent.completed) {
      const facts = episodes.filter(e => e.kind === 'action').slice(-2);
      const events = facts.length ? facts : episodes.slice(-1);
      return {
        summary: '本地演示：回顾真实经历，保留自己的小愿望。',
        reply: state.mind.settings.proactiveChat ? '忙完这几件小事，我还是想留一点时间安静看看书。把日子过得舒服些，对我也挺重要。' : '',
        suggestedActions: [], memories: [],
        ...(events.length ? { self: {
          thought: '照顾好自己和身边的小东西之后，我想给好奇心也留一点位置。',
          journal: `今天实际经历了${facts.map(e => ACTIONS[e.action!].label).join('、') || '一次对话'}。这些小事让我想把日子过得从容些。`,
          evidenceIds: events.map(e => e.id),
          wish: activeGoal(state.mind) ? null : { title: '专注一会儿，也认真休息', motivation: '想做成一点事，但不把自己耗空。', actions: ['work', 'relax'] as ActionId[] },
        } } : {}),
      };
    }
    const text = state.intent?.text ?? '';
    if (/你.*(喜欢|性格|打算|想做|心情|愿望)|自己的.*(想法|愿望)/.test(text)) {
      const goal = activeGoal(state.mind);
      return { summary: '本地演示：根据已有性格和愿望回答。', reply: `我喜欢安静地看书，也喜欢照顾绿植。${goal ? `我还惦记着「${goal.title}」，${goal.motivation}` : '我想先慢慢体验，再给自己定一个小愿望。'}`, suggestedActions: [], memories: [] };
    }
    if (/还记得|记得.*喜欢/.test(text)) {
      const preference = recall(state).memories.find(m => m.source === 'reflection');
      return { summary: '本地演示：从保存的记忆中回忆。', reply: preference ? `我记着这件事：${preference.evidenceText ?? preference.text}` : '这件事我还没有留下可靠的记忆。你可以再告诉我一次。', suggestedActions: [], memories: [] };
    }
    const target = demoTarget(text) ?? (state.intent.observation?.target);
    if (target && (appearanceQuestion(text) || state.intent.observation)) {
      const observation = observeTarget(state.agent.position, target);
      return { summary: '本地演示：根据当前观察提出回复，等待 Jev 选择说话。', reply: observation?.text ?? `我现在还没有${TARGETS[target].object}的可靠近距离观察。`, suggestedActions: [], memories: [] };
    }
    const explicit = demoRequestedActions(text);
    const actions: ActionId[] = explicit.length ? explicit : /安排|计划|plan/i.test(text) ? ['drink', 'work', 'relax'] : [];
    const summary = actions.length ? `建议按顺序${actions.map(id => ACTIONS[id].label).join(' → ')}，每一步完成后重新评估。` : '保留当前请求作为上下文；本地演示只能识别简单生活指令，开放式问题需要连接真实模型。';
    return { summary,
      reply: actions.length ? `我拟了一个小计划：${actions.map(id => ACTIONS[id].label).join('、')}。接下来会结合当时的状态决定每一步。` : '我收到了。现在是本地规则演示；连接 Jev 和语言模型后，就能处理更开放的对话与思考。',
      suggestedActions: actions,
      memories: /记住|喜欢|习惯|remember/i.test(text) ? [`用户表达的偏好（待持续验证）：${text.slice(0, 160)}`] : [],
    };
  }
}
