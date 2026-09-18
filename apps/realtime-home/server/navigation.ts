import { OBSTACLES } from '../shared/world';
import type { Vec2 } from '../shared/types';

const STEP = 0.25;
const RADIUS = 0.23;
const key = (p: Vec2) => `${p.x},${p.z}`;
const snap = (p: Vec2): Vec2 => ({ x: Math.round(p.x / STEP) * STEP, z: Math.round(p.z / STEP) * STEP });
export const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
export function walkable(p: Vec2): boolean {
  return Math.abs(p.x) <= 5.7 && Math.abs(p.z) <= 4.2 && !OBSTACLES.some(o =>
    Math.abs(p.x - o.x) < o.width / 2 + RADIUS && Math.abs(p.z - o.z) < o.depth / 2 + RADIUS);
}
export function segmentClear(a: Vec2, b: Vec2): boolean {
  const steps = Math.ceil(distance(a, b) / 0.08);
  for (let i = 0; i <= steps; i++) {
    const t = steps ? i / steps : 0;
    if (!walkable({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })) return false;
  }
  return true;
}

/** Bounded A* on the actual furniture/wall footprint, followed by safe line smoothing. */
export function findPath(from: Vec2, to: Vec2): Vec2[] | null {
  if (!walkable(from) || !walkable(to)) return null;
  if (segmentClear(from, to)) return [to];
  const start = snap(from);
  const goal = snap(to);
  if (!segmentClear(from, start) || !segmentClear(goal, to)) return null;
  const open = new Map<string, Vec2>([[key(start), start]]);
  const parents = new Map<string, Vec2>();
  const scores = new Map<string, number>([[key(start), 0]]);
  const closed = new Set<string>();
  for (let iteration = 0; iteration < 6000 && open.size; iteration++) {
    let current = start;
    let best = Infinity;
    for (const p of open.values()) {
      const score = scores.get(key(p))! + distance(p, goal);
      if (score < best) { best = score; current = p; }
    }
    const id = key(current);
    if (id === key(goal)) {
      const reverse = [goal];
      let p = current;
      while (parents.has(key(p))) { p = parents.get(key(p))!; reverse.push(p); }
      const raw = [from, ...reverse.reverse(), to];
      const smooth: Vec2[] = [];
      let anchor = 0;
      while (anchor < raw.length - 1) {
        let next = raw.length - 1;
        while (next > anchor + 1 && !segmentClear(raw[anchor], raw[next])) next--;
        smooth.push(raw[next]); anchor = next;
      }
      return smooth;
    }
    open.delete(id); closed.add(id);
    for (const [dx, dz] of [[STEP, 0], [-STEP, 0], [0, STEP], [0, -STEP]]) {
      const p = { x: current.x + dx, z: current.z + dz };
      const nextKey = key(p);
      if (closed.has(nextKey) || !segmentClear(current, p)) continue;
      const score = scores.get(id)! + STEP;
      if (score >= (scores.get(nextKey) ?? Infinity)) continue;
      parents.set(nextKey, current); scores.set(nextKey, score); open.set(nextKey, p);
    }
  }
  return null;
}
