import type { Candidate, ChannelDefinition, ChannelDecisionContext, Selection } from '@realtime-agent/agent';
import type { Decision, WorldState } from '../shared/types';
import { EXPRESSIONS, initialPresentation } from '../shared/presentation';
import type { Expression, GazeTarget } from '../shared/presentation';

const faceDescriptions: Record<Expression, string> = {
  neutral: '自然放松，未表达新的判断。', attentive: '专注倾听对方，不表示任务已经完成。',
  thinking: '正在规划或组织回答，身体可以继续当前活动。', curious: '对眼前信息感到好奇。',
  pleased: '温和地表达欣喜；不是任务成功回执。',
};
const gazeDescriptions: Record<GazeTarget, string> = { forward: '自然看向前方。', speaker: '转头看向说话者。', activity: '看向当前活动的目标。' };
const controls: Candidate[] = [
  { id: 'continue', description: '继续当前表现；不重新开始。', selection: { kind: 'continue' } },
  { id: 'rest', description: '结束当前表现并恢复自然状态。', selection: { kind: 'wait' } },
];

export function presentationChannels(now: () => number): ChannelDefinition<WorldState>[] {
  return [{
    id: 'face', mode: 'sync', resources: ['avatar:face'], blocksCompletion: false,
    whileHearing: 'continue', onInput: 'cancel', reflexes: ['attentive', 'thinking'],
    candidates: () => [...controls, ...EXPRESSIONS.map(expression => ({ id: expression, description: faceDescriptions[expression],
      selection: { kind: 'execute' as const, call: { capability: 'express', target: expression } } }))],
    capabilities: [{ id: 'express', prepare(call) {
      if (!EXPRESSIONS.includes(call.target as Expression) || call.input !== undefined) throw new Error('Invalid expression');
      const expression = call.target as Expression; let endAt = 0;
      return {
        phase: 'expressing',
        start(world, execution) { endAt = now() + 4500; const view = world.presentation ??= initialPresentation(); view.expression = expression; view.faceExecutionId = execution.id; },
        step(world, _seconds, execution) {
          if (expression === 'attentive' && world.attending || expression === 'thinking' && world.thinking) return { status: 'running', phase: 'expressing' };
          if (now() < endAt) return { status: 'running', phase: 'expressing' };
          if (world.presentation?.faceExecutionId === execution.id) { world.presentation.expression = 'neutral'; world.presentation.faceExecutionId = null; }
          return { status: 'completed', result: { expression } };
        },
        cancel(world, execution) { if (world.presentation?.faceExecutionId === execution.id) { world.presentation.expression = 'neutral'; world.presentation.faceExecutionId = null; } },
      };
    } }],
  }, {
    id: 'gaze', mode: 'sync', resources: ['avatar:head'], blocksCompletion: false,
    whileHearing: 'continue', onInput: 'cancel', reflexes: ['speaker'],
    candidates: () => [...controls, ...(Object.keys(gazeDescriptions) as GazeTarget[]).map(target => ({ id: target, description: gazeDescriptions[target],
      selection: { kind: 'execute' as const, call: { capability: 'look', target } } }))],
    capabilities: [{ id: 'look', prepare(call) {
      if (!Object.hasOwn(gazeDescriptions, call.target ?? '') || call.input !== undefined) throw new Error('Invalid gaze');
      const gaze = call.target as GazeTarget; let endAt = 0;
      return {
        phase: 'looking',
        start(world, execution) { endAt = now() + 4500; const view = world.presentation ??= initialPresentation(); view.gaze = gaze; view.gazeExecutionId = execution.id; },
        step(world, _seconds, execution) {
          if (gaze === 'speaker' && (world.attending || world.thinking || !!world.speech)) return { status: 'running', phase: 'looking' };
          if (now() < endAt) return { status: 'running', phase: 'looking' };
          if (world.presentation?.gazeExecutionId === execution.id) { world.presentation.gaze = 'forward'; world.presentation.gazeExecutionId = null; }
          return { status: 'completed', result: { gaze } };
        },
        cancel(world, execution) { if (world.presentation?.gazeExecutionId === execution.id) { world.presentation.gaze = 'forward'; world.presentation.gazeExecutionId = null; } },
      };
    } }],
  }];
}

/** Explicit local demo policy. Live decisions come from the same Jev evaluation as body and speech. */
export function demoPresentation(world: WorldState, result: Decision, channels: Record<string, ChannelDecisionContext>): Record<string, Selection> {
  const expression = result.think || world.thinking ? 'thinking' : result.requestComplete >= .8 ? 'pleased' : world.attending ? 'attentive' : 'neutral';
  const speaking = result.speech?.startsWith('speak:') || !!world.speechExecution;
  const gaze = world.attending || world.thinking || speaking ? 'speaker' : world.agent.action ? 'activity' : 'forward';
  return Object.fromEntries([['face', expression], ['gaze', gaze]].flatMap(([name, id]) => {
    const candidate = channels[name]?.candidates.find(item => item.id === id);
    return candidate ? [[name, candidate.selection]] : [];
  }));
}
