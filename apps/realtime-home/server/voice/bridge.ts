import { setTimeout as delay } from 'node:timers/promises';
import type { AgentRuntime } from '../runtime';
import type { NativeVoiceEvent, VoiceSessionState, VoiceWorldObservation } from '../../shared/voice';

/** Only final user transcripts enter Jev. Voice-model tools have read-only world access. */
export class VoiceBridge {
  readonly state: VoiceSessionState;
  private inputId: string | null = null;
  private turnId: string | null = null;
  private replies = new Set<string>();
  private hearing = false;
  private hearingTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingReply: { id: string; text: string } | null = null;
  private closed = false;

  constructor(readonly runtime: AgentRuntime, readonly epoch: string, id: string, expiresAt: number, private now = Date.now) {
    this.state = { id, status: 'connecting', error: null, sequence: 0, input: '', output: '', inputTurns: 0, outputTurns: 0, interruptions: 0, lastInputAt: null, firstAudioAt: null, expiresAt };
  }
  get active() { return !this.closed && this.epoch === this.runtime.state.epoch && !this.runtime.state.paused; }
  snapshot() { return structuredClone(this.state); }
  setStatus(status: VoiceSessionState['status']) { if (this.active) this.state.status = status; }
  audioStarted(sequence: number) {
    if (this.active && sequence === this.state.sequence) {
      this.state.firstAudioAt ??= this.now(); this.state.status = 'speaking';
    }
  }
  fail(message: string) { this.state.error = message; this.state.status = 'error'; }
  event(event: NativeVoiceEvent): boolean {
    if (!this.active || event.sequence < this.state.sequence || event.sequence < 1) return false;
    if (event.type === 'input' && (!event.text?.trim() || event.text.length > 1200)) {
      this.state.error = '这句话没有得到可用的完整转写，请分成短句重说。';
      this.hearing = false; this.runtime.releaseNativeInput(); return false;
    }
    if (event.sequence > this.state.sequence) {
      // A reply cannot invent a new user turn or overwrite the currently heard utterance.
      if (event.type !== 'speech-start' && event.type !== 'input') return false;
      this.state.sequence = event.sequence;
      this.state.output = ''; this.state.input = ''; this.state.firstAudioAt = null;
      this.inputId = null; this.turnId = null; this.pendingReply = null; this.replies.clear();
      this.runtime.holdNativeInput();
      this.hearing = true;
      if (this.hearingTimer) clearTimeout(this.hearingTimer);
      this.hearingTimer = setTimeout(() => {
        if (!this.active || !this.hearing) return;
        this.hearing = false;
        this.state.error = '这句话还没有得到完整转写，请重说或输入文字。';
        this.state.status = 'listening'; this.runtime.releaseNativeInput();
      }, 15000);
      this.hearingTimer.unref();
    }
    if (event.type === 'speech-start') { if (this.inputId) return false; this.state.status = 'hearing'; return true; }
    if (event.type === 'speech-end') { this.state.status = 'thinking'; return true; }
    if (event.type === 'interrupt') {
      this.state.interruptions++; this.pendingReply = null;
      if (this.turnId) this.runtime.interruptReply(this.epoch, this.turnId);
      this.state.status = 'listening'; return true;
    }
    if (!event.itemId || !event.text?.trim()) return false;
    if (event.type === 'input') {
      // A repeated final callback must not submit another command or reset its progress.
      if (this.inputId !== null) return this.inputId === event.itemId && this.state.input === event.text.trim();
      this.inputId = event.itemId;
      this.hearing = false;
      if (this.hearingTimer) clearTimeout(this.hearingTimer);
      this.state.input = event.text.trim(); this.state.inputTurns++;
      this.state.lastInputAt = this.now(); this.state.error = null; this.state.status = 'thinking';
      this.turnId = this.runtime.message(this.state.input, event.source ?? 'voice').turnId;
      if (this.pendingReply) {
        this.recordReply(this.pendingReply.id, this.pendingReply.text); this.pendingReply = null;
      }
      return true;
    }
    if (event.type === 'reply') {
      if (this.replies.has(event.itemId)) return true;
      // Input transcription can arrive after the model's audio. Never invent a user quote.
      if (!this.turnId) { this.pendingReply = { id: event.itemId, text: event.text }; return true; }
      return this.recordReply(event.itemId, event.text);
    }
    return false;
  }
  private recordReply(id: string, text: string) {
    if (!this.turnId || !this.runtime.recordNativeReply(this.turnId, text)) return false;
    this.replies.add(id); this.state.output = text; this.state.outputTurns++;
    return true;
  }
  observation(sequence: number): VoiceWorldObservation {
    const s = this.runtime.state, turn = s.turns.find(t => t.id === this.turnId);
    const valid = this.active && sequence === this.state.sequence && (!this.turnId || s.intent?.id === this.turnId);
    return {
      phase: !valid ? 'superseded' : this.hearing ? 'listening' : turn?.appliedAt != null ? 'applied' : s.attending ? 'deciding' : 'waiting',
      turnId: valid ? this.turnId : null,
      action: s.agent.action?.id ?? null, actionPhase: s.agent.action?.phase ?? null,
      progress: s.agent.action?.progress ?? 0, requestedAction: valid ? turn?.appliedAction ?? null : null,
      completed: valid ? s.outcomes.filter(o => o.requestId === this.turnId).map(o => o.action) : [],
      needs: { ...s.agent.needs }, objects: { ...s.objects },
    };
  }
  async observe(sequence: number, signal?: AbortSignal) {
    // Bound the tool to decision acceptance, not to the duration of the physical action.
    const deadline = this.now() + 2800;
    let result = this.observation(sequence);
    while (['listening', 'deciding'].includes(result.phase) && this.now() < deadline) {
      await delay(40, undefined, { signal });
      result = this.observation(sequence);
    }
    signal?.throwIfAborted(); return result;
  }
  close() {
    this.closed = true;
    if (this.hearingTimer) clearTimeout(this.hearingTimer);
    this.pendingReply = null;
    if (this.runtime.state.epoch === this.epoch) this.runtime.setNativeVoice(false);
    if (this.state.status !== 'error') this.state.status = 'off';
  }
}
