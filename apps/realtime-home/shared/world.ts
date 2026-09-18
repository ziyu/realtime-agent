import type { ActionId, ActionSpec, Choice, Room, Vec2, WorldState } from './types';

export const ROOM_NAMES: Record<Room, string> = { living: '客厅', kitchen: '厨房', bedroom: '卧室', study: '书房' };
export const ACTIONS: Record<ActionId, ActionSpec> = {
  relax: { id: 'relax', label: '休息', verb: '在沙发上放松', room: 'living', object: '沙发', position: { x: -4.7, z: 2.1 }, destination: { x: -3.5, z: 2 }, size: { x: 1.25, z: 2.5 }, duration: 9, effects: { energy: 13, happiness: 9 }, description: '坐下来休息片刻，恢复精力和心情。' },
  eat: { id: 'eat', label: '吃点东西', verb: '准备一份简餐', room: 'kitchen', object: '料理台', position: { x: 4.9, z: 3 }, destination: { x: 3.5, z: 3 }, size: { x: 1.25, z: 1.6 }, duration: 8, effects: { satiety: 34, energy: 3 }, description: '在厨房吃一份简餐，补充饱腹感。' },
  drink: { id: 'drink', label: '喝水', verb: '倒一杯水', room: 'kitchen', object: '饮水台', position: { x: 4.9, z: 1.1 }, destination: { x: 3.5, z: 1 }, size: { x: 1.25, z: 1.3 }, duration: 4, effects: { hydration: 40 }, description: '喝一杯水，补充水分。' },
  sleep: { id: 'sleep', label: '睡一会儿', verb: '在卧室小憩', room: 'bedroom', object: '床', position: { x: -4.5, z: -2.8 }, destination: { x: -3, z: -2.5 }, size: { x: 1.8, z: 2.5 }, duration: 15, effects: { energy: 38, hydration: -5 }, description: '短暂小憩，恢复大量精力。' },
  read: { id: 'read', label: '看书', verb: '翻阅一本书', room: 'study', object: '书架', position: { x: 4.9, z: -3.65 }, destination: { x: 3.5, z: -3 }, size: { x: 1.2, z: 1.1 }, duration: 10, effects: { happiness: 17, energy: -4 }, description: '读一本喜欢的书，让心情放松。' },
  work: { id: 'work', label: '专注工作', verb: '在书桌前工作', room: 'study', object: '书桌', position: { x: 1.5, z: -3.6 }, destination: { x: 1.5, z: -2.5 }, size: { x: 1.8, z: 0.9 }, duration: 12, effects: { happiness: 10, energy: -12, hydration: -6 }, description: '完成一小段专注工作，会消耗精力。' },
  water: { id: 'water', label: '给植物浇水', verb: '照料窗边的植物', room: 'living', object: '绿植', position: { x: -1.2, z: 3.45 }, destination: { x: -1.5, z: 2.5 }, size: { x: 0.75, z: 0.75 }, duration: 6, effects: { happiness: 12 }, description: '浇灌盆栽，让植物重新充满生机。' },
  wash: { id: 'wash', label: '清洗餐具', verb: '清洗水槽里的餐具', room: 'kitchen', object: '水槽', position: { x: 1.45, z: 3.6 }, destination: { x: 1.5, z: 2.5 }, size: { x: 1.5, z: 0.85 }, duration: 7, effects: { happiness: 7, energy: -3 }, description: '整理用过的餐具，让厨房恢复整洁。' },
};

export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[];
export const isAction = (value: string): value is ActionId => Object.hasOwn(ACTIONS, value);
export const roomAt = ({ x, z }: Vec2): Room => z >= 0 ? (x < 0 ? 'living' : 'kitchen') : (x < 0 ? 'bedroom' : 'study');
export const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function candidatesFor(state: WorldState): Partial<Record<Choice, string>> {
  const candidates: Partial<Record<Choice, string>> = { idle: '原地等待：用于用户明确要求停止、等待，或等待正在生成的对话回复。自主生活时应选择有用的生活动作。' };
  if (state.agent.action) candidates.continue = `继续当前动作：${ACTIONS[state.agent.action.id].verb}。`;
  for (const action of Object.values(ACTIONS)) {
    if (action.id === 'wash' && state.objects.dishesClean) continue;
    if (action.id === 'water' && state.objects.plantMoisture > 90) continue;
    candidates[action.id] = `${action.label} / ${ROOM_NAMES[action.room]}：${action.description} 完成后需求变化：${JSON.stringify(action.effects)}（需求数值越高越满足）。`;
  }
  return candidates;
}

export interface Obstacle { x: number; z: number; width: number; depth: number }
export const WALLS: Obstacle[] = [
  { x: 0, z: -3.75, width: 0.18, depth: 1.5 },
  { x: 0, z: 0, width: 0.18, depth: 2 },
  { x: 0, z: 3.75, width: 0.18, depth: 1.5 },
  { x: -5, z: 0, width: 2, depth: 0.18 },
  { x: 0, z: 0, width: 4, depth: 0.18 },
  { x: 5, z: 0, width: 2, depth: 0.18 },
];
export const OBSTACLES: Obstacle[] = [
  ...WALLS,
  ...Object.values(ACTIONS).map(a => ({ x: a.position.x, z: a.position.z, width: a.size.x, depth: a.size.z })),
  { x: -2.6, z: 3.6, width: 1.3, depth: 0.7 },
];
