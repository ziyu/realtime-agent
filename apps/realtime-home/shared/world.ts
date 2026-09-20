import type { ActionId, ActionSpec, Choice, Room, TargetId, Vec2, WorldState } from './types';

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
export const isMovement = (value: string): value is 'approach' | 'inspect' => value === 'approach' || value === 'inspect';
export const ROOM_DESTINATIONS: Record<Room, Vec2> = {
  living: { x: -2.5, z: 1.5 }, kitchen: { x: 2.5, z: 1.5 },
  bedroom: { x: -2.5, z: -1.5 }, study: { x: 2.5, z: -1.5 },
};
export const TARGETS: Record<TargetId, { object: string; room: Room; destination: Vec2 }> = {
  ...ACTIONS,
  ...Object.fromEntries((Object.keys(ROOM_NAMES) as Room[]).map(room => [room, { object: ROOM_NAMES[room], room, destination: ROOM_DESTINATIONS[room] }])) as Record<Room, { object: string; room: Room; destination: Vec2 }>,
};
export const TARGET_IDS = Object.keys(TARGETS) as TargetId[];
export const OBJECT_APPEARANCE: Record<ActionId, string> = {
  relax: '沙发主体是深灰绿色，坐垫是偏浅的鼠尾草绿，旁边有一只米黄色靠垫。',
  eat: '料理台主体是浅灰绿色，台面接近象牙白，灶台是深灰色。',
  drink: '饮水台主体是浅灰绿色、台面接近象牙白，饮水器是偏青蓝色。',
  sleep: '床架是暖棕色，床垫和枕头是米白色，床上的盖毯是偏陶土棕的颜色。',
  read: '书架是暖木色，上面摆着绿色、陶土色、米黄色和蓝绿色等不同颜色的书。',
  work: '书桌是暖木色，笔记本电脑外壳偏浅灰，屏幕是深绿色。',
  water: '绿植种在陶土色花盆里，叶片有深浅两种绿色。',
  wash: '水槽台主体是浅灰绿色，台面接近象牙白，水槽和龙头是灰银色。',
};
export const roomAt = ({ x, z }: Vec2): Room => z >= 0 ? (x < 0 ? 'living' : 'kitchen') : (x < 0 ? 'bedroom' : 'study');
export const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function nearbyObservation(position: Vec2) {
  let nearest: ActionId | null = null, best = Infinity;
  for (const id of ACTION_IDS) {
    const target = ACTIONS[id].destination;
    const d = Math.hypot(position.x - target.x, position.z - target.z);
    if (d < best) { best = d; nearest = id; }
  }
  if (!nearest || best > 0.45) return null;
  const spec = ACTIONS[nearest];
  return { target: nearest, object: spec.object, room: spec.room, appearance: OBJECT_APPEARANCE[nearest] };
}

export function observeTarget(position: Vec2, target: TargetId) {
  if (isAction(target)) {
    const observed = nearbyObservation(position);
    return observed?.target === target ? { ...observed, text: observed.appearance } : null;
  }
  if (roomAt(position) !== target) return null;
  // ponytail: room membership is the simulated sensor; add visibility/occlusion when the scene supports it.
  const objects = ACTION_IDS.filter(id => ACTIONS[id].room === target).map(id => ACTIONS[id].object);
  return { target, room: target, objects, text: `${ROOM_NAMES[target]}里有${objects.join('、')}。` };
}

export function candidatesFor(state: WorldState): Partial<Record<Choice, string>> {
  const candidates: Partial<Record<Choice, string>> = { idle: '原地等待：用于用户明确要求停止、等待，或等待正在生成的对话回复。自主生活时应选择有用的生活动作。' };
  if (state.agent.action) candidates.continue = isMovement(state.agent.action.id)
    ? `继续走向${TARGETS[state.agent.action.target!].object}。`
    : `继续当前动作：${ACTIONS[state.agent.action.id].verb}。`;
  if (state.intent && !state.intent.completed) {
    candidates.approach = '只走到指定物体或房间，不执行生活动作，也不承担观察回答。';
    candidates.inspect = '前往指定物体或房间，抵达后观察并主动回答。用于“去厨房看看有什么”“过去看看颜色”，不执行睡觉、吃饭等生活动作。';
  }
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
