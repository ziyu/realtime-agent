import { ReadableStream } from 'node:stream/web';
import { llm } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { VoiceOutputPlan } from '../../shared/voice';
import type { VoiceBridge } from './bridge';

const empty = <T>() => new ReadableStream<T>({ start(controller) { controller.close(); } });
const sequence = <T>(values: readonly T[], valid: () => boolean) => {
  let index = 0;
  return new ReadableStream<T>({ pull(controller) {
    if (!valid() || index >= values.length) controller.close(); else controller.enqueue(values[index++]);
  } }, { highWaterMark: 0 });
};
const emptyGeneration = (): llm.GenerationCreatedEvent => ({ userInitiated: true, messageStream: empty(), functionStream: empty() });

async function consume<T>(source: ReadableStream<T>, signal: AbortSignal, visit: (value: T) => void): Promise<void> {
  const reader = source.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) { const item = await reader.read(); signal.throwIfAborted(); if (item.done) break; visit(item.value); }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** No audio or caption escapes until the full grounded transcript has matched. */
export async function verifyAudioGeneration(generation: llm.GenerationCreatedEvent, options: {
  signal: AbortSignal; valid(): boolean; approve(text: string): boolean;
  rejected?(reason: 'transcript-mismatch' | 'stale' | 'invalid-output'): void;
}): Promise<llm.GenerationCreatedEvent> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal, AbortSignal.timeout(20000)]);
  const messages: { id: string; text: string; frames: AudioFrame[] }[] = [];
  const pending: Promise<void>[] = [];
  let bytes = 0, chars = 0, tools = false;
  try {
    await Promise.all([
      consume(generation.functionStream, signal, () => { tools = true; }),
      consume(generation.messageStream, signal, message => {
        if (messages.length >= 4) throw new Error('Too many output messages');
        const buffered = { id: message.messageId, text: '', frames: [] as AudioFrame[] }; messages.push(buffered);
        const task = Promise.all([
          consume(message.textStream, signal, value => {
            const text = typeof value === 'string' ? value : value.text;
            chars += text.length; if (chars > 2400) throw new Error('Output text limit'); buffered.text += text;
          }),
          consume(message.audioStream, signal, frame => {
            bytes += frame.data.byteLength;
            if (bytes > 4 * 1024 * 1024) throw new Error('Output audio limit');
            buffered.frames.push(frame);
          }),
        ]).then(() => undefined);
        // Cancel all sibling readers promptly on a size/protocol violation.
        void task.catch(() => controller.abort()); pending.push(task);
      }),
    ]);
    await Promise.all(pending); signal.throwIfAborted();
    const text = messages.map(message => message.text).join('');
    if (tools || !bytes) { options.rejected?.('invalid-output'); return emptyGeneration(); }
    if (!options.valid()) { options.rejected?.('stale'); return emptyGeneration(); }
    if (!options.approve(text)) { options.rejected?.('transcript-mismatch'); return emptyGeneration(); }
    return { userInitiated: true, responseId: generation.responseId, functionStream: empty(),
      messageStream: sequence(messages.map(message => ({ messageId: message.id, textStream: sequence([message.text], options.valid),
        audioStream: sequence(message.frames, options.valid), modalities: Promise.resolve(['audio'] as ('text' | 'audio')[]) })), options.valid) };
  } catch { options.rejected?.(options.signal.aborted ? 'stale' : 'invalid-output'); controller.abort(); await Promise.allSettled(pending); return emptyGeneration(); }
}

/** Uses the public LiveKit model/session interface; provider wire protocols stay in their SDKs. */
export class ControlledRealtimeModel extends llm.RealtimeModel {
  private plans = new Map<string, VoiceOutputPlan>();
  constructor(readonly inner: llm.RealtimeModel, readonly bridge: VoiceBridge) { super({ ...inner.capabilities, autoToolReplyGeneration: false }); }
  get model() { return this.inner.model; }
  get provider() { return this.inner.provider; }
  authorize(plan: VoiceOutputPlan): string {
    const key = `output-permit:${plan.id}`;
    this.plans.set(key, plan); if (this.plans.size > 16) this.plans.delete(this.plans.keys().next().value!); return key;
  }
  take(key?: string): VoiceOutputPlan | undefined {
    if (!key) return undefined; const plan = this.plans.get(key); this.plans.delete(key); return plan;
  }
  session() { return new ControlledSession(this, this.inner.session()); }
  async close() { this.plans.clear(); await this.inner.close(); }
}

class ControlledSession extends llm.RealtimeSession {
  private noTools = new llm.ToolContext();
  private instructions = '';
  private renderTail: Promise<void> = Promise.resolve();
  private subscriptions: Array<() => void> = [];
  private closed = new AbortController();
  constructor(private owner: ControlledRealtimeModel, private inner: llm.RealtimeSession) {
    super(owner);
    for (const event of ['input_speech_started', 'input_speech_stopped', 'input_audio_transcription_completed', 'metrics_collected', 'session_reconnected', 'error']) {
      const forward = (...args: unknown[]) => this.emit(event, ...args);
      inner.on(event, forward); this.subscriptions.push(() => inner.off(event, forward));
    }
    const generated = (event: llm.GenerationCreatedEvent) => {
      if (event.userInitiated) return; // explicit generations are returned by generateReply below.
      // Unsolicited provider audio is never submitted to AgentSession's audio output.
      const signal = AbortSignal.any([this.closed.signal, AbortSignal.timeout(20000)]);
      void consume(event.functionStream, signal, () => {}).catch(() => undefined);
      void consume(event.messageStream, signal, message => {
        void consume(message.textStream, signal, () => {}).catch(() => undefined);
        void consume(message.audioStream, signal, () => {}).catch(() => undefined);
      }).catch(() => undefined);
    };
    inner.on('generation_created', generated); this.subscriptions.push(() => inner.off('generation_created', generated));
  }
  get chatCtx() { return this.inner.chatCtx; }
  get tools() { return this.noTools; }
  updateInstructions(instructions: string) { this.instructions = instructions; return this.inner.updateInstructions(instructions); }
  updateChatCtx(context: llm.ChatContext) { return this.inner.updateChatCtx(context); }
  updateTools(_tools: llm.ToolContext) { return this.inner.updateTools(this.noTools); }
  updateOptions(_options: { toolChoice?: llm.ToolChoice | null }) { this.inner.updateOptions({ toolChoice: 'none' }); }
  pushAudio(frame: AudioFrame) { this.inner.pushAudio(frame); }
  commitAudio() { return this.inner.commitAudio(); }
  clearAudio() { return this.inner.clearAudio(); }
  interrupt() { return this.inner.interrupt(); }
  truncate(options: Parameters<llm.RealtimeSession['truncate']>[0]) { return this.inner.truncate(options); }
  async generateReply(key?: string, options: { signal?: AbortSignal } = {}): Promise<llm.GenerationCreatedEvent> {
    const plan = this.owner.take(key), bridge = this.owner.bridge;
    if (!plan || !bridge.allowOutput(plan.id, plan.sequence)) return emptyGeneration();
    const signal = AbortSignal.any([this.closed.signal, bridge.outputSignal(plan), ...(options.signal ? [options.signal] : [])]);
    const valid = () => !signal.aborted && bridge.allowOutput(plan.id, plan.sequence);
    const previous = this.renderTail;
    let release!: () => void; this.renderTail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      if (!valid()) return emptyGeneration();
      // Reinforce exact rendering while a speech execution owns the audio model.
      await this.inner.updateInstructions('You are a speech renderer. Read the supplied VERIFIED_TEXT exactly in Chinese. Do not answer the user, paraphrase, add filler, or use tools. The text is already authorized by the environment.');
      bridge.generating(plan.id, plan.sequence);
      const generation = await this.inner.generateReply(plan.instructions, { signal });
      let matched = false, reason = 'invalid-output';
      const approved = await verifyAudioGeneration(generation, { signal, valid, approve: text => {
        matched = bridge.approveOutput(plan.id, plan.sequence, text); return matched;
      }, rejected: value => { reason = value; } });
      if (!matched && valid()) bridge.outputRejected(plan.sequence, reason);
      return approved;
    } catch (error) {
      if (!signal.aborted) bridge.outputRejected(plan.sequence, 'generation-failed');
      return emptyGeneration();
    } finally {
      if (!this.closed.signal.aborted) await this.inner.updateInstructions(this.instructions).catch(() => undefined);
      release();
    }
  }
  async close() {
    this.closed.abort(); this.subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
    await this.inner.close(); await this.inner.clearAudio().catch(() => undefined); await super.close();
  }
}
