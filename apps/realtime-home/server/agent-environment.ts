import type { ActionCall, Candidate, Capability, JsonValue, PreparedAction } from '@realtime-agent/agent';
import { ACTIONS, candidatesFor, clamp, isAction, isMovement, observeTarget, TARGET_IDS, TARGETS } from '../shared/world';
import type { ActionId, Choice, DecisionContext, ExecutableActionId, Need, RunningAction, TargetId, WorldState } from '../shared/types';
import { distance, findPath } from './navigation';
import { activeGoal, remainingGoalActions } from './mind';

/** Legacy action IDs remain a Home UI detail. The Agent sees object IDs. */
export const HOME_TARGETS: Record<TargetId, string> = {
  relax: 'sofa', eat: 'kitchen-counter', drink: 'water-station', sleep: 'bed',
  read: 'bookshelf', work: 'desk', water: 'plant', wash: 'sink',
  living: 'living', kitchen: 'kitchen', bedroom: 'bedroom', study: 'study',
};
export function homeTargetForId(target: string): TargetId | undefined {
  return TARGET_IDS.find(id => HOME_TARGETS[id] === target);
}
export function homeCall(action: Choice, target?: TargetId | null): ActionCall {
  if (isMovement(action) && target && Object.hasOwn(TARGETS, target)) return { capability: action === 'inspect' ? 'inspect' : 'move_to', target: HOME_TARGETS[target] };
  if (isAction(action)) return { capability: 'use', target: HOME_TARGETS[action], input: { activity: action } };
  throw new Error('No executable Home action.');
}

export function homeCandidates(context: DecisionContext): Candidate[] {
  return Object.entries(context.candidates).flatMap(([id, description]): Candidate[] => {
    if (id === 'idle') return [{ id, description: description!, selection: { kind: 'wait' } }];
    if (id === 'continue') return [{ id, description: description!, selection: { kind: 'continue' } }];
    if (isMovement(id)) return TARGET_IDS.map(target => ({ id: `${id}:${HOME_TARGETS[target]}`,
      description: `${description} 此候选目标是${TARGETS[target].object}。`,
      selection: { kind: 'execute', call: homeCall(id, target) } }));
    return isAction(id) ? [{ id, description: description!, selection: { kind: 'execute', call: homeCall(id) } }] : [];
  });
}

export interface HomeExecutionResult {
  action: ExecutableActionId;
  target?: TargetId;
  goalId?: string;
  effects: string;
}
const NEED_NAMES: Record<Need, string> = { energy: '精力', satiety: '饱腹', hydration: '水分', happiness: '心情' };

function prepare(call: ActionCall, world: WorldState): PreparedAction<WorldState> {
  const target = call.target && homeTargetForId(call.target);
  if (!target || !['move_to', 'inspect', 'use'].includes(call.capability)) throw new Error('Unknown Home capability target.');
  const approaching = call.capability !== 'use';
  if (!approaching && !isAction(target)) throw new Error('Rooms cannot be used as household activities.');
  if (approaching ? call.input !== undefined : !call.input || typeof call.input !== 'object' || Array.isArray(call.input)
    || Object.keys(call.input).length !== 1 || call.input.activity !== target) throw new Error('Invalid Home activity parameters.');
  const actionId: ExecutableActionId = approaching ? call.capability === 'inspect' ? 'inspect' : 'approach' : target as ActionId;
  if (!Object.hasOwn(candidatesFor(world), actionId)) throw new Error('Home action is not available.');
  const spec = TARGETS[target];
  const path = findPath(world.agent.position, spec.destination);
  if (!path) throw new Error('Home target is not reachable.');
  const goal = activeGoal(world.mind);
  const action: RunningAction = { id: actionId, ...(approaching ? { target } : {}), startedAt: world.elapsed,
    requestId: null, ...(goal && !approaching && isAction(target) && remainingGoalActions(goal).includes(target) ? { goalId: goal.id } : {}),
    phase: 'walking', progress: 0, elapsed: 0, path };
  return {
    phase: 'walking',
    start(context, execution) { action.requestId = execution.scope.turnId; context.agent.action = action; },
    cancel(context) { if (context.agent.action === action) context.agent.action = null; },
    step(context, seconds, execution) {
      if (execution.signal.aborted || context.agent.action !== action) throw new Error('Home execution is no longer active.');
      action.requestId = execution.scope.turnId;
      if (action.phase === 'walking') {
        let travel = seconds * 2;
        while (action.path.length && travel > 0) {
          const destination = action.path[0];
          const remaining = distance(context.agent.position, destination);
          if (remaining <= travel) { context.agent.position = { ...destination }; action.path.shift(); travel -= remaining; }
          else {
            const position = context.agent.position;
            context.agent.position = { x: position.x + (destination.x - position.x) / remaining * travel,
              z: position.z + (destination.z - position.z) / remaining * travel };
            travel = 0;
          }
        }
        if (!action.path.length) {
          if (approaching) {
            context.agent.action = null;
            const observation = actionId === 'inspect' ? observeTarget(context.agent.position, target) : null;
            if (actionId === 'inspect' && !observation) throw new Error('Target observation is unavailable after arrival.');
            return { status: 'completed', result: { action: actionId, target, effects: observation?.text ?? `已到达${spec.object}，可以查看。`, ...(observation ? { observation } : {}) } as unknown as JsonValue };
          }
          action.phase = 'acting'; action.elapsed = 0;
        }
        return { status: 'running', phase: action.phase, progress: action.progress };
      }
      if (approaching || !isAction(target) || !Object.hasOwn(candidatesFor(context), target)) throw new Error('Home activity precondition changed.');
      const activity = ACTIONS[target];
      action.elapsed += seconds;
      action.progress = Math.min(1, action.elapsed / activity.duration);
      if (action.progress < 1) return { status: 'running', phase: 'acting', progress: action.progress };

      // Only the environment commits effects, and only after arrival plus interaction.
      const changes: string[] = [], needs = context.agent.needs;
      for (const [need, amount] of Object.entries(activity.effects) as [Need, number][]) {
        const old = needs[need]; needs[need] = clamp(old + amount);
        const delta = Math.round(needs[need] - old);
        changes.push(`${NEED_NAMES[need]} ${delta >= 0 ? '+' : ''}${delta}`);
      }
      if (target === 'water') { context.objects.plantMoisture = 100; changes.push('植物已浇水'); }
      if (target === 'eat') context.objects.dishesClean = false;
      if (target === 'wash') { context.objects.dishesClean = true; changes.push('餐具已洗净'); }
      context.agent.action = null;
      const result: HomeExecutionResult = { action: target, effects: changes.join(' · '), ...(action.goalId ? { goalId: action.goalId } : {}) };
      return { status: 'completed', result: result as unknown as JsonValue };
    },
  };
}

export const homeCapabilities: readonly Capability<WorldState>[] = [
  { id: 'move_to', prepare }, { id: 'inspect', prepare }, { id: 'use', prepare },
];
