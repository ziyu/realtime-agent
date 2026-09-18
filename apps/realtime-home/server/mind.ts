import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ACTION_IDS, ACTIONS, clamp } from '../shared/world';
import type { ActionId, Memory, Outcome, WorldState } from '../shared/types';
import type { Drive, Episode, MindState, PersonalGoal, SelfInsight } from '../shared/mind';

export const AUTONOMOUS_THOUGHT_INTERVAL_MS = 90000;
export const MAX_EPISODES = 80;
const actionSchema = z.enum(ACTION_IDS as [ActionId, ...ActionId[]]);
const score = z.number().finite().min(0).max(100);
const timestamp = z.number().finite().nonnegative();
const drivesSchema = z.object({ curiosity: score, care: score, mastery: score, connection: score });
const episodeSchema = z.object({
  id: z.string().max(100), sequence: z.number().int().nonnegative(), at: timestamp,
  kind: z.enum(['action', 'conversation', 'interruption']), text: z.string().max(1600),
  action: actionSchema.optional(), role: z.enum(['user', 'agent']).optional(),
  epoch: z.string().max(100).optional(), requestId: z.string().max(100).nullable().optional(),
});
const goalSchema = z.object({
  id: z.string().max(100), title: z.string().min(1).max(100), motivation: z.string().max(240),
  actions: z.array(actionSchema).min(1).max(4), completedActions: z.array(actionSchema).max(4),
  createdAt: timestamp, status: z.enum(['active', 'fulfilled']), source: z.enum(['initial', 'reflection']),
  evidenceIds: z.array(z.string().max(100)).max(8),
});
export const mindSchema = z.object({
  schemaVersion: z.literal(1), bornAt: timestamp,
  personality: z.object({ description: z.string().max(300), traits: drivesSchema, values: z.array(z.string().max(160)).max(8), voice: z.string().max(500), likes: z.array(z.string().max(80)).max(8), dislikes: z.array(z.string().max(80)).max(8) }),
  mood: z.object({ label: z.string().max(60), reason: z.string().max(200) }),
  drives: drivesSchema,
  affinity: z.record(actionSchema, score),
  innerVoice: z.object({ text: z.string().max(400), at: timestamp, source: z.enum(['initial', 'experience', 'llm', 'demo']) }),
  goals: z.array(goalSchema).max(6), episodes: z.array(episodeSchema).max(MAX_EPISODES),
  journal: z.array(z.object({ id: z.string().max(100), text: z.string().max(600), at: timestamp, source: z.enum(['llm', 'demo']), evidence: z.array(episodeSchema.pick({ id: true, text: true, kind: true })).min(1).max(8) })).max(24),
  settings: z.object({ proactiveChat: z.boolean() }),
  lifetimeCompleted: z.number().int().nonnegative(), sequence: z.number().int().nonnegative(), reflectedThrough: z.number().int().nonnegative(),
  lastAutonomousAttemptAt: timestamp.nullable(), lastSharedAt: timestamp.nullable(),
});

export function createMind(now = Date.now()): MindState {
  return {
    schemaVersion: 1, bornAt: now,
    personality: {
      description: '安静、好奇，有点慢热。喜欢照料小东西，也想把自己的日子过得有意思。',
      traits: { curiosity: 84, care: 78, mastery: 56, connection: 46 },
      values: ['留一点时间给没有功利目的的好奇心', '先照顾好自己，再照顾这个家', '愿意帮忙，也会温和地表达不同想法'],
      voice: '用自然的中文短句交流，具体、温暖，偶尔有一点轻巧的幽默。像住在这里的室友，有主见但不故意唱反调。不称呼主人，不说收到指令、任务完成或播报需求数值。不把每句话变成问题，不催用户陪伴，不虚构共同往事。',
      likes: ['安静地读一会儿书', '照顾窗边的绿植', '把一件小事认真做完'],
      dislikes: ['连续工作到精疲力尽', '一件事没做完就反复换下一件', '为了忙碌而忙碌'],
    },
    mood: { label: '有点期待', reason: '想慢慢把这里过成自己的家。' },
    drives: { curiosity: 68, care: 56, mastery: 42, connection: 28 },
    affinity: { read: 82, water: 77, relax: 62, work: 48, wash: 44, eat: 40, drink: 38, sleep: 45 },
    innerVoice: { text: '我想先照顾好那盆绿植，再给自己留一段安静的阅读时间。', at: now, source: 'initial' },
    goals: [{ id: randomUUID(), title: '给这个家留一点安静的生机', motivation: '照顾绿植，也留一点时间满足自己的好奇心。', actions: ['water', 'read'], completedActions: [], createdAt: now, status: 'active', source: 'initial', evidenceIds: [] }],
    episodes: [], journal: [], settings: { proactiveChat: true },
    lifetimeCompleted: 0, sequence: 0, reflectedThrough: 0, lastAutonomousAttemptAt: null, lastSharedAt: null,
  };
}

export const activeGoal = (mind: MindState) => mind.goals.find(goal => goal.status === 'active');
export function remainingGoalActions(goal: PersonalGoal): ActionId[] {
  const completed = [...goal.completedActions];
  return goal.actions.filter(action => {
    const i = completed.indexOf(action);
    if (i < 0) return true;
    completed.splice(i, 1); return false;
  });
}

export function addEpisode(mind: MindState, episode: Omit<Episode, 'sequence'>) {
  mind.sequence++;
  mind.episodes.push({ ...episode, sequence: mind.sequence });
  // Routine activity must not immediately evict what the user actually said.
  const conversations = mind.episodes.filter(e => e.kind === 'conversation').slice(-32);
  const experiences = mind.episodes.filter(e => e.kind !== 'conversation').slice(-48);
  mind.episodes = [...conversations, ...experiences].sort((a, b) => a.sequence - b.sequence);
}

export function advanceMind(world: WorldState, seconds: number) {
  const { mind } = world;
  for (const drive of Object.keys(mind.drives) as Drive[]) {
    mind.drives[drive] = clamp(mind.drives[drive] + seconds * (0.018 + mind.personality.traits[drive] / 2000));
  }
  const needs = world.agent.needs;
  if (needs.energy < 25) mind.mood = { label: '有些疲惫', reason: '想把节奏放慢一点，先恢复精力。' };
  else if (needs.hydration < 20 || needs.satiety < 20) mind.mood = { label: '有点顾不上别的', reason: '先照顾身体，小愿望可以稍后继续。' };
  else if (mind.drives.curiosity > 72) mind.mood = { label: '好奇心冒头', reason: '想从熟悉的日常里找一点新鲜感。' };
  else if (mind.drives.care > 70) mind.mood = { label: '想照料点什么', reason: '把身边的小地方照顾好，会觉得踏实。' };
  else if (needs.happiness > 85) mind.mood = { label: '心里挺满足', reason: '刚做过的小事，让这一天有了些分量。' };
  else mind.mood = { label: '安安静静', reason: '可以按自己的节奏，把眼前的事慢慢做完。' };
}

export function recordOutcome(world: WorldState, outcome: Outcome, goalId?: string) {
  const mind = world.mind;
  const action = outcome.action;
  addEpisode(mind, { id: outcome.id, kind: 'action', action, at: outcome.at, epoch: world.epoch, requestId: outcome.requestId, text: `${outcome.requestId ? '回应室友的请求，' : '自己选择'}完成了${ACTIONS[action].label}。${outcome.effects}。` });
  mind.lifetimeCompleted++;
  const drive: Drive = action === 'read' ? 'curiosity' : action === 'water' || action === 'wash' ? 'care' : action === 'work' ? 'mastery' : 'connection';
  if (['read', 'water', 'wash', 'work'].includes(action)) mind.drives[drive] = clamp(mind.drives[drive] - 25);
  // Interests change slowly from actual experience, independently from the stable character.
  mind.affinity[action] = Math.min(95, mind.affinity[action] + 0.75);
  const goal = mind.goals.find(g => g.id === goalId && g.status === 'active');
  if (goal && remainingGoalActions(goal).includes(action)) {
    goal.completedActions.push(action);
    if (!remainingGoalActions(goal).length) goal.status = 'fulfilled';
  }
  advanceMind(world, 0);
}

/** Advisory weights describe character, not an alternative executor for live mode. */
export function personalInclinations(world: WorldState): { action: ActionId; score: number; reason: string }[] {
  const mind = world.mind, goal = activeGoal(mind);
  const recent = mind.episodes.filter(e => e.kind === 'action').slice(-5);
  const drives: Partial<Record<ActionId, Drive>> = { read: 'curiosity', water: 'care', wash: 'care', work: 'mastery', relax: 'connection' };
  return ACTION_IDS.map(action => {
    const urgentNeed = action === 'drink' ? world.agent.needs.hydration : action === 'eat' ? world.agent.needs.satiety : action === 'sleep' ? world.agent.needs.energy : 100;
    if (urgentNeed < 20) return { action, score: 200 + Math.round(100 - urgentNeed), reason: '身体已经很匮乏，先恢复这一项；自己的小愿望留待恢复后继续。' };
    const drive = drives[action];
    const goalRelated = goal && remainingGoalActions(goal).includes(action);
    const repetition = recent.filter(e => e.action === action).length;
    const value = mind.affinity[action] * 0.35 + (drive ? mind.drives[drive] * 0.5 + mind.personality.traits[drive] * 0.25 : 0) + (goalRelated ? 38 : 0) - repetition * 24;
    return { action, score: Math.round(value), reason: goalRelated ? `想继续自己的小愿望：${goal.title}` : repetition ? '刚做过，想换一点不同的体验' : action === 'read' ? '喜欢安静阅读，也想满足好奇心' : action === 'water' || action === 'wash' ? '照料身边的东西会让自己踏实' : action === 'work' ? '想认真做成一点事情' : '给生活留一点舒展的余地' };
  }).sort((a, b) => b.score - a.score);
}

function terms(text: string): Set<string> {
  const parts = text.toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]+/g) ?? [];
  const result = new Set<string>();
  for (const part of parts) {
    if (/^[a-z0-9_]+$/.test(part)) { if (part.length > 1) result.add(part); continue; }
    for (let i = 0; i < part.length - 1; i++) result.add(part.slice(i, i + 2));
  }
  return result;
}

/** Bounded lexical retrieval with recent context; original evidence remains visible. */
export function recall(world: WorldState) {
  const query = terms(`${world.intent?.text ?? ''} ${activeGoal(world.mind)?.title ?? ''} ${world.agent.action?.id ?? ''}`);
  const rank = (text: string, at: number) => [...terms(text)].filter(t => query.has(t)).length * 12 + at / 1e13;
  const memories = [...world.memories].sort((a, b) => rank(b.text, b.at) - rank(a.text, a.at)).slice(0, 8);
  const relevant = [...world.mind.episodes].sort((a, b) => rank(b.text, b.at) - rank(a.text, a.at)).slice(0, 6);
  const episodes = [...new Map([...relevant, ...world.mind.episodes.slice(-6)].map(e => [e.id, e])).values()].slice(-12);
  return { memories, episodes };
}

export function reflectionOpportunity(world: WorldState, now: number): { due: boolean; reason: string } {
  const mind = world.mind;
  if (world.mode === 'live' && !world.connected.llm) return { due: false, reason: '慢思考模型尚未连接，先继续生活。' };
  if (world.intent && !world.intent.completed) return { due: false, reason: '先回应眼前的对话。' };
  if (mind.lastAutonomousAttemptAt !== null && now - mind.lastAutonomousAttemptAt < AUTONOMOUS_THOUGHT_INTERVAL_MS) return { due: false, reason: '让经历慢慢积累，不必不停反思。' };
  const fresh = mind.episodes.filter(e => e.sequence > mind.reflectedThrough && e.kind !== 'conversation');
  const due = fresh.length >= 2;
  return { due, reason: due ? activeGoal(mind) ? '刚经历了几件事，想看看自己的愿望和感受有没有变化。' : '一个小愿望已经完成，想回顾一下，再决定接下来期待什么。' : '还在体验这一刻。' };
}

export function acceptInsight(world: WorldState, insight: SelfInsight, source: 'llm' | 'demo', now: number, allowedEvidence: string[]): boolean {
  const ids = new Set(allowedEvidence);
  const evidence = insight.evidenceIds.map(id => world.mind.episodes.find(e => e.id === id));
  if (!evidence.length || evidence.some((episode, i) => !episode || !ids.has(insight.evidenceIds[i]))) return false;
  const mind = world.mind;
  mind.innerVoice = { text: insight.thought, source, at: now };
  if (insight.journal && !mind.journal.some(e => e.text === insight.journal)) {
    mind.journal.push({ id: randomUUID(), text: insight.journal, at: now, source, evidence: evidence.map(e => ({ id: e!.id, text: e!.text, kind: e!.kind })) });
    mind.journal = mind.journal.slice(-24);
  }
  // A proposal cannot erase an unfinished personal commitment or claim it is complete.
  if (insight.wish && !activeGoal(mind) && !mind.goals.some(g => g.title === insight.wish!.title)) {
    mind.goals = [...mind.goals.slice(-5), { ...insight.wish, id: randomUUID(), completedActions: [], createdAt: now, status: 'active', source: 'reflection', evidenceIds: [...insight.evidenceIds] }];
  }
  return true;
}

export function boundedMemories(memories: Memory[]): Memory[] {
  // Keep user preferences from being pushed out by repetitive household effects.
  const retained = [...memories.filter(m => m.source === 'reflection').slice(-24), ...memories.filter(m => m.source === 'experience').slice(-36)];
  return retained.sort((a, b) => a.at - b.at);
}
