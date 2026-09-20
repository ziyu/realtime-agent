import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, setSensitiveDataLoggingEnabled } from '@openai/agents-realtime';
import type { NativeVoiceEvent, VoiceOutputPlan } from '../../shared/voice';
import type { AudioConnection, AudioOptions } from './types';
import { voiceRequest } from './types';

setSensitiveDataLoggingEnabled(false);

export async function connectOpenAI({ ticket, callbacks, signal }: AudioOptions): Promise<AudioConnection> {
  if (ticket.connection.kind !== 'openai') throw new Error('会话类型不匹配。');
  let closed = false, sequence = 0;
  let stream: MediaStream | undefined, session: RealtimeSession | undefined, transport: OpenAIRealtimeWebRTC | undefined;
  // The provider's WebRTC track is never directly audible before a turn is authorized.
  const incoming = new Audio(); incoming.autoplay = true; incoming.muted = true; incoming.hidden = true;
  const audio = new Audio(); audio.autoplay = true; audio.hidden = true;
  audio.dataset.nativeVoiceAudio = 'openai'; document.body.append(incoming, audio);
  const inputSequences = new Map<string, number>();
  const finalInputs = new Set<string>();
  const plans = new Map<string, VoiceOutputPlan>();
  let pendingOutput: AbortController | null = null;
  let capture: { responseId: string; plan: VoiceOutputPlan; recorder: MediaRecorder; chunks: Blob[]; bytes: number;
    text: string; completed: boolean; stopped: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
  let executionId: string | null = null;
  let objectUrl: string | null = null;
  const current = () => !closed && !signal.aborted;
  const valid = (plan: VoiceOutputPlan) => current() && plan.sequence === sequence && plan.executionId === executionId && Date.now() < plan.expiresAt;
  const bound = <T>(map: Map<string, T>) => { if (map.size > 128) map.delete(map.keys().next().value!); };
  const post = (event: NativeVoiceEvent) => voiceRequest(ticket, 'event', event, signal);
  const emit = (event: NativeVoiceEvent) => { void post(event).catch(() => { if (current()) callbacks.error('转写未能同步到家园，通话已停止，请重新连接。'); }); };
  const clearPlayback = () => {
    audio.pause(); audio.srcObject = null; audio.removeAttribute('src'); audio.onended = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null;
    const old = capture; capture = null;
    if (old) { clearTimeout(old.timer); if (old.recorder.state !== 'inactive') old.recorder.stop(); }
  };
  const close = () => {
    if (closed) return; closed = true; pendingOutput?.abort(); clearPlayback();
    signal.removeEventListener('abort', close); session?.close(); stream?.getTracks().forEach(track => track.stop());
    incoming.pause(); incoming.srcObject = null; incoming.remove(); audio.remove();
    inputSequences.clear(); finalInputs.clear(); plans.clear();
  };
  signal.addEventListener('abort', close, { once: true });
  const begin = (id: string) => {
    if (!current()) return 0;
    const old = inputSequences.get(id); if (old !== undefined) return old;
    pendingOutput?.abort(); clearPlayback(); session?.interrupt();
    const turn = ++sequence; inputSequences.set(id, turn); bound(inputSequences); plans.clear();
    callbacks.input(''); callbacks.output(''); callbacks.status('hearing');
    emit({ type: 'speech-start', sequence: turn, itemId: id }); return turn;
  };
  const requestOutput = async (turn: number) => {
    if (!current() || turn !== sequence || !executionId) return;
    pendingOutput?.abort(); const controller = new AbortController(); pendingOutput = controller;
    try {
      const plan = await voiceRequest<VoiceOutputPlan | null>(ticket, 'output-plan', { sequence: turn }, AbortSignal.any([signal, controller.signal]));
      if (!plan || !valid(plan) || controller.signal.aborted) return;
      plans.set(plan.id, plan); callbacks.status('thinking');
      emit({ type: 'generating', sequence: plan.sequence, itemId: plan.id });
      transport?.sendEvent({ type: 'response.create', response: {
        instructions: `${ticket.instructions}\n${plan.instructions}`, metadata: { output_permit: plan.id }, tool_choice: 'none',
      } });
    } catch { if (current() && !controller.signal.aborted) callbacks.error('这次语音没有获得当前轮次的回复许可。'); }
  };
  const delivered = (plan: VoiceOutputPlan, text: string) => {
    if (!valid(plan)) return;
    emit({ type: 'reply', sequence: plan.sequence, itemId: plan.id, text }); callbacks.status('listening');
  };
  const approve = async (plan: VoiceOutputPlan, text: string) => {
    if (!valid(plan)) return false;
    const result = await voiceRequest<{ approved: boolean }>(ticket, 'approve-output', { sequence: plan.sequence, id: plan.id, transcript: text }, signal);
    return valid(plan) && result.approved;
  };
  const finishOutput = () => {
    const item = capture;
    if (item && item.completed && item.stopped) {
      clearTimeout(item.timer); if (item.recorder.state !== 'inactive') item.recorder.stop();
    }

  };
  const started = (responseId: string, plan: VoiceOutputPlan) => {
    clearPlayback();
    const source = incoming.srcObject;
    if (!valid(plan) || !(source instanceof MediaStream)) return;
    if (typeof MediaRecorder === 'undefined') { callbacks.error('此浏览器不支持行动语音校验缓冲。'); return; }
    const recorder = new MediaRecorder(source), chunks: Blob[] = [];
    const record = { responseId, plan, recorder, chunks, bytes: 0, text: '', completed: false, stopped: false,
      timer: setTimeout(() => { if (capture === record) { clearPlayback(); callbacks.status('listening'); } }, 20000) };
    capture = record;
    recorder.ondataavailable = event => {
      if (capture !== record) return;
      record.bytes += event.data.size;
      if (record.bytes > 4 * 1024 * 1024) { clearPlayback(); return; }
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (capture !== record) return;
      capture = null;
      void (async () => {
        if (!record.completed || !record.stopped || !chunks.length || !await approve(plan, record.text)) {
          if (valid(plan)) { callbacks.output(''); callbacks.status('listening'); } return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType });
        objectUrl = URL.createObjectURL(blob); audio.srcObject = null; audio.src = objectUrl;
        audio.onended = () => delivered(plan, record.text);
        callbacks.output(record.text); callbacks.status('speaking');
        await audio.play().then(() => { if (valid(plan)) emit({ type: 'playback-started', sequence: plan.sequence, itemId: plan.id }); }).catch(() => { callbacks.audioBlocked(); emit({ type: 'playback-blocked', sequence: plan.sequence, itemId: plan.id }); });
      })().catch(() => { if (valid(plan)) callbacks.status('listening'); });
    };
    recorder.start(100);
  };
  try {
    signal.throwIfAborted();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (!current()) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Cancelled', 'AbortError'); }
    const agent = new RealtimeAgent({ name: 'Milo', instructions: ticket.instructions, tools: [] });
    transport = new OpenAIRealtimeWebRTC({ audioElement: incoming, mediaStream: stream });
    session = new RealtimeSession(agent, { transport, model: ticket.profile.model, tracingDisabled: true, historyStoreAudio: false,
      config: { audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'zh' }, noiseReduction: { type: 'near_field' },
        turnDetection: { type: 'semantic_vad', eagerness: 'medium', createResponse: false, interruptResponse: true } }, output: { voice: ticket.profile.voice } } },
    });
    session.on('transport_event', event => {
      if (!current()) return;
      const e = event as Record<string, unknown>, itemId = typeof e.item_id === 'string' ? e.item_id : '', responseId = typeof e.response_id === 'string' ? e.response_id : '';
      if (e.type === 'input_audio_buffer.speech_started' && itemId) begin(itemId);
      if (e.type === 'input_audio_buffer.speech_stopped' && inputSequences.get(itemId) === sequence) { emit({ type: 'speech-end', sequence }); callbacks.status('thinking'); }
      if (e.type === 'conversation.item.input_audio_transcription.completed' && itemId && typeof e.transcript === 'string') {
        if (e.isFinal === false || e.status === 'in_progress' || finalInputs.has(itemId)) return;
        const turn = inputSequences.get(itemId); if (turn === undefined) return;
        finalInputs.add(itemId); if (finalInputs.size > 128) finalInputs.delete(finalInputs.values().next().value!);
        if (turn === sequence) callbacks.input(e.transcript);
        void post({ type: 'input', sequence: turn, itemId, text: e.transcript, source: 'voice' }).catch(() => { if (current()) callbacks.error('转写未能同步到家园。'); });
      }
      if (e.type === 'conversation.item.input_audio_transcription.failed') callbacks.error('没有得到完整转写，请重新开始通话。');
      if (e.type === 'response.created') {
        const response = e.response as { id?: string; metadata?: { output_permit?: string } } | undefined;
        const plan = response?.metadata?.output_permit ? plans.get(response.metadata.output_permit) : undefined;
        if (!plan || !response?.id || !valid(plan)) { clearPlayback(); return; }
        plans.delete(plan.id); started(response.id, plan);
      }
      if (e.type === 'response.output_audio_transcript.done' && typeof e.transcript === 'string') {
        if (capture?.responseId === responseId) { capture.text = e.transcript.slice(0, 2400); }
      }
      if (e.type === 'response.done') {
        const response = e.response as { id?: string; status?: string } | undefined;
        if (response?.status !== 'completed') { if (response?.id === capture?.responseId) clearPlayback(); return; }
        if (capture && capture.responseId === response.id) capture.completed = true;
        finishOutput();
      }
      if (e.type === 'output_audio_buffer.stopped') {
        if (capture?.responseId === responseId) capture.stopped = true;
        finishOutput();
      }
      if (e.type === 'output_audio_buffer.cleared' && (capture?.responseId === responseId)) clearPlayback();
    });
    session.on('error', () => { if (current()) callbacks.error('OpenAI 实时音频发生错误，请检查模型权限、额度或网络后重新连接。'); });
    transport.on('connection_change', state => { if (current() && state === 'disconnected') callbacks.error('OpenAI 音频连接已断开，请重新连接。'); });
    await session.connect({ apiKey: ticket.connection.ephemeralKey });
    signal.throwIfAborted(); callbacks.status('listening');
    return {
      close,
      syncOutput(world) {
        const next = world.epoch === ticket.epoch && !world.paused && !world.attending && world.speech?.native && !world.speech.delivered && !world.speech.error ? world.speechExecution?.id ?? null : null;
        if (next === executionId) return;
        executionId = next; pendingOutput?.abort(); clearPlayback();
        if (next) void requestOutput(sequence); else session?.interrupt();
      },
      interrupt() { pendingOutput?.abort(); clearPlayback(); session?.interrupt(); emit({ type: 'interrupt', sequence }); callbacks.status('listening'); },
      async sendText(text) {
        const id = `text-${crypto.randomUUID()}`, turn = begin(id); callbacks.input(text);
        await post({ type: 'input', sequence: turn, itemId: id, text, source: 'text' });
        if (current() && turn === sequence) { transport?.sendMessage(text, {}, { triggerResponse: false }); }
      },
      mute(muted) { session?.mute(muted); }, resumeAudio() { return audio.play(); },
    };
  } catch (error) { close(); throw error; }
}
