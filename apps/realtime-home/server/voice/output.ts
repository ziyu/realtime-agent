import type { Candidate, Capability, JsonValue } from '@realtime-agent/agent';
import type { WorldState } from '../../shared/types';

/** A reply is a proposed action, never a side effect of observation or proposal acceptance. */
export function speechCandidates(state: WorldState): Candidate[] {
  const candidates: Candidate[] = [{ id: 'silent', description: '保持安静，或停止当前发言。不生成默认播报。', selection: { kind: 'wait' } }];
  if (state.speechExecution) candidates.push({ id: 'continue', description: '继续已经获准的发言。', selection: { kind: 'continue' } });
  const proposal = state.reflection;
  if (!proposal?.reply.trim() || proposal.intentVersion !== state.intentVersion || !state.intent?.completed && state.intent?.replySuppressed
    || proposal.purpose === 'autonomous' && !state.mind.settings.proactiveChat
    || [state.speechExecution, ...(state.speechExecutions ?? [])].some(r => r?.call.target === proposal.id)) return candidates;
  candidates.push({ id: `speak:${proposal.id}`, description: `说出这段慢思考提议，提议需已被采纳或同时通过本次 review；不自动执行建议动作：${proposal.reply}`,
    selection: { kind: 'execute', call: { capability: 'speak', target: proposal.id, input: { text: proposal.reply } } } });
  return candidates;
}

export const speechCapability: Capability<WorldState> = {
  id: 'speak',
  prepare(call, state) {
    const proposal = state.reflection, input = call.input;
    if (!proposal?.accepted || call.target !== proposal.id || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 1 || input.text !== proposal.reply || !proposal.reply.trim() || proposal.reply.length > 2400
      || !speechCandidates(state).some(c => c.id === `speak:${proposal.id}`)) throw new Error('Speech is not an accepted available proposal.');
    const text = proposal.reply, native = state.nativeVoiceActive, evidenceIds = proposal.executionEvidenceIds ?? [];
    return {
      phase: native ? 'awaiting-audio' : 'sending-text',
      start(world, execution) { world.speech = { executionId: execution.id, text, native, delivered: false }; },
      cancel(world, execution) { if (world.speech?.executionId === execution.id) world.speech = null; },
      step(world, _seconds, execution) {
        const speech = world.speech;
        if (!speech || speech.executionId !== execution.id || execution.signal.aborted) throw new Error('Speech cancelled.');
        if (speech.error) throw new Error('Speech transport failed.');
        if (native && !speech.delivered) return { status: 'running', phase: speech.phase ?? 'awaiting-audio' };
        world.messages.push({ id: execution.id, role: 'agent', text, at: speech.deliveredAt ?? proposal.createdAt,
          ...(execution.scope.turnId ? { turnId: execution.scope.turnId } : { initiative: true }), ...(native ? { nativeAudio: true } : {}) });
        world.messages = world.messages.slice(-70);
        world.speech = null;
        return { status: 'completed', result: { text, native, proposalId: proposal.id, evidenceIds } as JsonValue };
      },
    };
  },
};

export function speechInstructions(text: string): string {
  return `You are the audio renderer for an explicitly accepted speak action. Speak this text naturally, with conversational intonation, exactly as written. Do not answer again, add commentary, call tools, or invent any action.\nVERIFIED_TEXT=${JSON.stringify(text)}`;
}
