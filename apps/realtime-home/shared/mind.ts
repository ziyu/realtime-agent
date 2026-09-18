import type { ActionId } from './types';

export type Drive = 'curiosity' | 'care' | 'mastery' | 'connection';
export interface Personality {
  description: string;
  traits: Record<Drive, number>;
  values: string[];
  voice: string;
  likes: string[];
  dislikes: string[];
}
export interface Episode {
  id: string;
  sequence: number;
  at: number;
  kind: 'action' | 'conversation' | 'interruption';
  text: string;
  action?: ActionId;
  role?: 'user' | 'agent';
  epoch?: string;
  requestId?: string | null;
}
export interface PersonalGoal {
  id: string;
  title: string;
  motivation: string;
  actions: ActionId[];
  completedActions: ActionId[];
  createdAt: number;
  status: 'active' | 'fulfilled';
  source: 'initial' | 'reflection';
  evidenceIds: string[];
}
export interface JournalEntry {
  id: string;
  text: string;
  at: number;
  source: 'llm' | 'demo';
  evidence: Pick<Episode, 'id' | 'text' | 'kind'>[];
}
/** A short, intentionally public character note, never a model reasoning trace. */
export interface SelfInsight {
  thought: string;
  journal: string;
  evidenceIds: string[];
  wish?: { title: string; motivation: string; actions: ActionId[] } | null;
}
export interface MindState {
  schemaVersion: 1;
  bornAt: number;
  personality: Personality;
  mood: { label: string; reason: string };
  drives: Record<Drive, number>;
  affinity: Record<ActionId, number>;
  innerVoice: { text: string; at: number; source: 'initial' | 'experience' | 'llm' | 'demo' };
  goals: PersonalGoal[];
  episodes: Episode[];
  journal: JournalEntry[];
  settings: { proactiveChat: boolean };
  lifetimeCompleted: number;
  sequence: number;
  reflectedThrough: number;
  lastAutonomousAttemptAt: number | null;
  lastSharedAt: number | null;
}
export const DRIVE_LABELS: Record<Drive, string> = {
  curiosity: '想探索', care: '想照料', mastery: '想做成一点事', connection: '想聊聊',
};
