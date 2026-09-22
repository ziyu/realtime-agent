import { z } from 'zod';
import { AgentError } from '@realtime-agent/agent';
import type { DesktopCommand, DesktopObservation } from './desktop-types.js';

const windowId = z.string().min(1).max(80);
const coordinate = z.number().int().min(-65536).max(65536);
export const desktopCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('focus'), windowId }).strict(),
  z.object({ kind: z.literal('click'), windowId, x: coordinate, y: coordinate,
    button: z.enum(['left', 'right']).optional(), clicks: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
  z.object({ kind: z.literal('type'), windowId, text: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal('key'), windowId, keys: z.array(z.string().regex(/^[A-Z0-9_]+$/).max(24)).min(1).max(4) }).strict(),
  z.object({ kind: z.literal('scroll'), windowId, x: coordinate, y: coordinate, delta: z.number().int().min(-1200).max(1200).refine(value => value !== 0) }).strict(),
]);
export const desktopInputSchema = z.object({ command: desktopCommandSchema, manualId: z.string().optional(),
  planId: z.string().optional(), step: z.number().int().nonnegative().optional() }).strict();

const planAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('focus') }).strict(),
  z.object({ kind: z.literal('click'), elementId: z.string().min(1).max(240),
    button: z.enum(['left', 'right']).optional(), clicks: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
  z.object({ kind: z.literal('click_position'), x: coordinate, y: coordinate,
    button: z.enum(['left', 'right']).optional(), clicks: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
  z.object({ kind: z.literal('type'), text: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal('key'), keys: z.array(z.string().regex(/^[A-Z0-9_]+$/).max(24)).min(1).max(4) }).strict(),
  z.object({ kind: z.literal('scroll'), x: coordinate, y: coordinate, delta: z.number().int().min(-1200).max(1200).refine(value => value !== 0) }).strict(),
]);
export const desktopPlanSchema = z.object({
  summary: z.string().min(1).max(700),
  actions: z.array(planAction).max(8),
  verification: z.object({ elementId: z.string().max(240).optional(), text: z.string().min(1).max(2000),
    match: z.enum(['contains', 'equals']) }).strict().nullable(),
}).strict();
export type DesktopPlan = z.infer<typeof desktopPlanSchema>;
export type DesktopPlanAction = DesktopPlan['actions'][number];

export function windowVersion(observation: DesktopObservation, id: string): string | null {
  const window = observation.windows.find(item => item.id === id);
  return window ? JSON.stringify([window.processId, window.processName, window.bounds, window.minimized]) : null;
}
export function elementVersion(observation: DesktopObservation, id: string): string | null {
  const element = observation.elements.find(item => item.id === id);
  return element ? JSON.stringify([element.role, element.name, element.bounds, element.enabled, element.offscreen]) : null;
}
export function layoutVersion(observation: DesktopObservation): string {
  return JSON.stringify(observation.elements.map(element => [element.id, element.bounds, element.role]));
}
export function resolveDesktopAction(action: DesktopPlanAction, observation: DesktopObservation, selectedWindowId: string): DesktopCommand {
  if (action.kind === 'click') {
    const element = observation.elements.find(item => item.id === action.elementId);
    if (!element || !element.enabled || element.offscreen || element.bounds.width <= 0 || element.bounds.height <= 0) {
      throw new AgentError('stale_candidate', '目标控件当前不可操作，需要重新观察。', 0);
    }
    return { kind: 'click', windowId: selectedWindowId, x: Math.round(element.bounds.x + element.bounds.width / 2),
      y: Math.round(element.bounds.y + element.bounds.height / 2), ...(action.button ? { button: action.button } : {}), ...(action.clicks ? { clicks: action.clicks } : {}) };
  }
  if (action.kind === 'click_position') {
    const { kind: _kind, ...point } = action;
    return { ...point, kind: 'click', windowId: selectedWindowId };
  }
  return { ...action, windowId: selectedWindowId };
}
export function validateDesktopCommand(command: DesktopCommand, observation: DesktopObservation, selectedWindowId: string | null): void {
  if (!selectedWindowId || command.windowId !== selectedWindowId) throw new AgentError('window_scope', '请先选择要操作的真实窗口。', 0);
  const window = observation.windows.find(item => item.id === selectedWindowId);
  if (!window) throw new AgentError('window_closed', '所选窗口已经关闭，请重新选择。', 0);
  if (!Number.isFinite(observation.capturedAt) || Date.now() - observation.capturedAt > 6500) throw new AgentError('stale_observation', '桌面观察已过期，请刷新。', 0);
  if (command.kind !== 'focus' && window.minimized) throw new AgentError('window_minimized', '请先将所选窗口恢复到前台。', 0);
  if (command.kind === 'click' || command.kind === 'scroll') {
    const { x, y, width, height } = window.bounds;
    if (command.x < x || command.y < y || command.x >= x + width || command.y >= y + height) {
      throw new AgentError('coordinate_scope', '操作位置已超出所选窗口，请刷新画面。', 0);
    }
  }
}

/** This validates visible text evidence, not arbitrary natural-language task success. */
export function verifyDesktopPlan(plan: DesktopPlan, observation: DesktopObservation): string[] {
  const test = plan.verification;
  if (!test) return [];
  return observation.elements.filter(element => !element.offscreen && (!test.elementId || element.id === test.elementId)
    && [element.value, element.name].some(value => value !== undefined && (test.match === 'equals' ? value === test.text : value.includes(test.text))))
    .map(element => element.id);
}
