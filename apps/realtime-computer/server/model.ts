import { z } from 'zod';
import type { ActionCall, JsonValue } from '@realtime-agent/agent';

export const goalSchema = z.object({ name: z.string().trim().min(1).max(80), category: z.enum(['work', 'life']), note: z.string().max(400) }).strict();
export type FormGoal = z.infer<typeof goalSchema>;
export interface DocumentObservation {
  id: string;
  documentId: string;
  capturedAt: number;
  layout: number;
  popup: boolean;
  saving: boolean;
  fields: FormGoal;
  saved: FormGoal | null;
  saveVersion: number;
  targets: Record<string, { version: number; visible: boolean; enabled: boolean; value: string }>;
}
export const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
export const sameGoal = (a: FormGoal | null, b: FormGoal | null): boolean => !!a && !!b && a.name === b.name && a.category === b.category && a.note === b.note;
export function callValue(call: ActionCall): string | null {
  return call.input && typeof call.input === 'object' && !Array.isArray(call.input) && Object.keys(call.input).length === 1 && typeof call.input.value === 'string' ? call.input.value : null;
}
export function authorizedCall(call: ActionCall, goal: FormGoal): boolean {
  if (call.capability === 'click') return ['save', 'dismiss'].includes(call.target ?? '') && call.input === undefined;
  const value = callValue(call);
  if (call.capability === 'fill' && (call.target === 'name' || call.target === 'note')) return value === goal[call.target];
  return call.capability === 'select' && call.target === 'category' && value === goal.category;
}
export function defaultPlan(goal: FormGoal): ActionCall[] {
  return [
    { capability: 'fill', target: 'name', input: { value: goal.name } },
    { capability: 'select', target: 'category', input: { value: goal.category } },
    { capability: 'fill', target: 'note', input: { value: goal.note } },
    { capability: 'click', target: 'save' },
  ];
}
