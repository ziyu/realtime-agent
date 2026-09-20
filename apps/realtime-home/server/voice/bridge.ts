import { setTimeout as delay } from 'node:timers/promises';
import { OutputGate } from '@realtime-agent/agent';
import type { OutputPermit } from '@realtime-agent/agent';
import type { AgentRuntime } from '../runtime';
import type { NativeVoiceEvent, VoiceOutputPlan, VoiceSessionState, VoiceWorldObservation } from '../../shared/voice';
import { nearbyObservation, observeTarget, roomAt } from '../../shared/world';
import { speechInstructions } from './output';

/** Only final user transcripts enter Jev. Voice-model tools have read-only world access. */
export class VoiceBridge {
  readonly state: VoiceSessionState;
  private inputId: string | null = null;
  private turnId: string | null = null;
  private replies = new Set<string>();
  private hearing = false;
  private hearingTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private outputGate: OutputGate;
  private output: { permit: OutputPermit; plan: VoiceOutputPlan } | null = null;
  private observers = new Set<() => void>();
  private unsubscribe: () => void;

  constructor(readonly runtime: AgentRuntime, readonly epoch: string, id: string, expiresAt: number, private now = Date.now) {
    this.state = { id, status: 'connecting', error: null, sequence: 0, input: '', output: '', inputTurns: 0, outputTurns: 0, interruptions: 0, lastInputAt: null, firstAudioAt: null, expiresAt };
    this.outputGate = new OutputGate({ now });
    this.unsubscribe = runtime.subscribe(() => {
      if (this.output && !this.outputGate.allows(this.output.permit)) this.cancelOutput();
      this.activityChanged();
    });
  }
  subscribeActivity(listener: () => void): () => void { this.observers.add(listener); return () => { this.observers.delete(listener); }; }
  private activityChanged() { for (const listener of this.observers) listener(); }
  private cancelOutput() {
    const output = this.output;
    this.output = null; this.outputGate.cancel();
    if (output && this.runtime.speechAction()?.id === output.plan.executionId && !this.runtime.state.speech?.delivered)
      this.runtime.cancelSpeech('voice-cancelled');
  }

  get active() { return !this.closed && this.epoch === this.runtime.state.epoch && !this.runtime.state.paused; }
  snapshot() { return structuredClone(this.state); }
  setStatus(status: VoiceSessionState['status']) { if (this.active) this.state.status = status; }
  audioStarted(sequence: number) {
    if (this.active && sequence === this.state.sequence && this.output && this.outputGate.allows(this.output.permit)) {
      this.state.firstAudioAt ??= this.now(); this.state.status = 'speaking';
      if (this.runtime.state.speech) this.runtime.state.speech.phase = 'playing';
      this.runtime.recordOutput(this.output.plan.turnId, 'playing', '音频通道报告开始播放。', undefined, this.output.plan.id);
    }
  }
  fail(message: string) { this.state.error = message; this.state.status = 'error'; }
  event(event: NativeVoiceEvent): boolean {
    if (!this.active || event.sequence < this.state.sequence || event.sequence < 0 || event.sequence === 0 && ['input', 'speech-start', 'speech-end'].includes(event.type)) return false;
    if (event.type === 'input' && (!event.text?.trim() || event.text.length > 1200)) {
      this.state.error = '这句话没有得到可用的完整转写，请分成短句重说。';
      this.hearing = false; this.runtime.releaseNativeInput(); return false;
    }
    if (event.sequence > this.state.sequence) {
      // A reply cannot invent a new user turn or overwrite the currently heard utterance.
      if (event.type !== 'speech-start' && event.type !== 'input') return false;
      this.state.sequence = event.sequence;
      this.state.output = ''; this.state.input = ''; this.state.firstAudioAt = null;
      this.cancelOutput();
      this.inputId = null; this.turnId = null; this.replies.clear();
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
    if (event.type === 'speech-start') { if (this.inputId) return false; this.state.status = 'hearing'; this.activityChanged(); return true; }
    if (event.type === 'speech-end') { this.state.status = 'thinking'; return true; }
    if (event.type === 'interrupt') {
      this.cancelOutput(); this.runtime.cancelSpeech('interrupted');
      this.state.interruptions++;
      if (this.turnId) this.runtime.interruptReply(this.epoch, this.turnId);
      this.state.status = 'listening'; this.activityChanged(); return true;
    }
    if (['playback-started', 'generating', 'playback-blocked'].includes(event.type)) {
      if (!event.itemId || !this.allowOutput(event.itemId, event.sequence)) return false;
      if (event.type === 'playback-started') this.audioStarted(event.sequence);
      else if (event.type === 'generating') this.generating(event.itemId, event.sequence);
      else this.runtime.recordOutput(this.output!.plan.turnId, 'blocked', '浏览器阻止音频播放，请点击启用声音。', undefined, event.itemId);
      return true;
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
      this.activityChanged();
      return true;
    }
    if (event.type === 'reply') {
      if (this.replies.has(event.itemId)) return true;
      return this.recordReply(event.itemId, event.text);
    }
    return false;
  }
  private recordReply(id: string, text: string) {
    const output = this.output;
    if (!output || output.plan.id !== id || !this.outputGate.allows(output.permit, text)
      || !this.runtime.completeSpeech(output.plan.executionId, output.plan.exactText)) return false;
    this.replies.add(id); this.state.output = output.plan.exactText; this.state.outputTurns++;
    return true;
  }
  async outputPlan(sequence: number, signal?: AbortSignal): Promise<VoiceOutputPlan | null> {
    signal?.throwIfAborted();
    const execution = this.runtime.speechAction(), speech = this.runtime.state.speech;
    if (!this.active || this.hearing || sequence !== this.state.sequence || !execution || execution.status !== 'running'
      || !speech?.native || speech.delivered || speech.error || speech.executionId !== execution.id) return null;
    if (this.output?.plan.executionId === execution.id && this.outputGate.allows(this.output.permit)) return this.output.plan;
    const permit = this.outputGate.issue(execution.scope, speech.text, () => this.active && !this.hearing
      && sequence === this.state.sequence && this.runtime.speechAction()?.id === execution.id
      && !this.runtime.state.speech?.error && !this.runtime.state.speech?.delivered);
    const plan: VoiceOutputPlan = { id: permit.id, executionId: execution.id, sequence, turnId: execution.scope.turnId,
      exactText: speech.text, expiresAt: permit.expiresAt, instructions: speechInstructions(speech.text) };
    this.output = { permit, plan };
    this.runtime.recordOutput(plan.turnId, 'authorized', '音频通道接收已获准的 speak 执行。', { executionId: execution.id, exactText: speech.text }, plan.id);
    return plan;
  }
  outputSignal(plan: VoiceOutputPlan): AbortSignal {
    return this.output?.plan.id === plan.id ? this.output.permit.signal : AbortSignal.abort();
  }
  allowOutput(id: string, sequence: number, transcript?: string): boolean {
    return !!this.output && this.output.plan.id === id && sequence === this.state.sequence && this.outputGate.allows(this.output.permit, transcript);
  }
  generating(id: string, sequence: number) {
    if (this.allowOutput(id, sequence) && this.runtime.state.speech) this.runtime.state.speech.phase = 'generating';
    if (this.allowOutput(id, sequence)) this.runtime.recordOutput(this.output!.plan.turnId, 'generating', '语音模型开始生成这轮获准的回答。', undefined, id);
  }
  approveOutput(id: string, sequence: number, transcript?: string): boolean {
    const approved = this.allowOutput(id, sequence, transcript);
    if (transcript === undefined) return approved;
    if (approved) this.runtime.recordOutput(this.output!.plan.turnId, 'approved', '音频转写通过播放前校验。', { transcript }, id);
    else if (this.output?.plan.id === id && sequence === this.state.sequence) this.outputRejected(sequence, 'transcript-mismatch');
    return approved;
  }
  outputRejected(sequence: number, reason = 'not-approved') {
    if (this.active && sequence === this.state.sequence) {
      this.state.outputError = '这次语音未通过发言校验，已阻止播放；可以继续说话。';
      this.state.blockedOutputs = (this.state.blockedOutputs ?? 0) + 1; this.state.status = 'listening';
      const executionId = this.output?.plan.executionId, turnId = this.output?.plan.turnId ?? null;
      this.output = null; this.outputGate.cancel();
      this.runtime.recordOutputRejection(reason, turnId);
      if (executionId) this.runtime.failSpeech(executionId, reason);
    }
  }
  observation(sequence: number): VoiceWorldObservation {
    const s = this.runtime.state, turn = s.turns.find(t => t.id === this.turnId);
    const valid = this.active && sequence === this.state.sequence && (!this.turnId || s.intent?.id === this.turnId);
    return {
      agentContext: this.runtime.conversationContext(),
      phase: !valid ? 'superseded' : this.hearing ? 'listening' : turn?.appliedAt != null ? 'applied' : s.attending ? 'deciding' : 'waiting',
      turnId: valid ? this.turnId : null,
      action: s.agent.action?.id ?? null, actionPhase: s.agent.action?.phase ?? null,
      actionTarget: s.agent.action?.target ?? null,
      progress: s.agent.action?.progress ?? 0, requestedAction: valid ? turn?.appliedAction ?? null : null,
      requestedTarget: valid ? turn?.appliedTarget ?? null : null,
      completed: valid ? s.outcomes.filter(o => o.requestId === this.turnId).map(o => o.action) : [],
      completedDetails: valid ? s.outcomes.filter(o => o.requestId === this.turnId).map(o => ({ action: o.action, target: o.target ?? null })) : [],
      observedObject: nearbyObservation(s.agent.position),
      observedRoom: observeTarget(s.agent.position, roomAt(s.agent.position)),
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
    this.cancelOutput(); this.outputGate.dispose(); this.unsubscribe(); this.activityChanged(); this.observers.clear();
    if (this.hearingTimer) clearTimeout(this.hearingTimer);
    if (this.runtime.state.epoch === this.epoch) this.runtime.setNativeVoice(false);
    if (this.state.status !== 'error') this.state.status = 'off';
  }
}
