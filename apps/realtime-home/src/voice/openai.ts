import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, setSensitiveDataLoggingEnabled, tool } from '@openai/agents-realtime';
import { z } from 'zod';
import type { NativeVoiceEvent, VoiceWorldObservation } from '../../shared/voice';
import type { AudioConnection, AudioOptions } from './types';
import { voiceRequest } from './types';

setSensitiveDataLoggingEnabled(false);

export async function connectOpenAI({ ticket, callbacks, signal }: AudioOptions): Promise<AudioConnection> {
  if (ticket.connection.kind !== 'openai') throw new Error('会话类型不匹配。');
  let closed = false, sequence = 0;
  let stream: MediaStream | undefined;
  let session: RealtimeSession | undefined;
  const audio = new Audio(); audio.autoplay = true; audio.hidden = true;
  audio.dataset.nativeVoiceAudio = 'openai'; document.body.append(audio);
  const inputSequences = new Map<string, number>();
  const responseSequences = new Map<string, number>();
  const outputs = new Map<string, { itemId: string; text: string }>();
  const bound = <T>(map: Map<string, T>) => { if (map.size > 128) map.delete(map.keys().next().value!); };
  const current = () => !closed && !signal.aborted;
  const close = () => {
    if (closed) return; closed = true;
    signal.removeEventListener('abort', close);
    session?.close(); stream?.getTracks().forEach(track => track.stop());
    audio.pause(); audio.srcObject = null; audio.remove();
    inputSequences.clear(); responseSequences.clear(); outputs.clear();
  };
  signal.addEventListener('abort', close, { once: true });
  const post = (event: NativeVoiceEvent) => voiceRequest(ticket, 'event', event, signal);
  const emit = (event: NativeVoiceEvent) => {
    void post(event).catch(() => { if (current()) callbacks.error('转写未能同步到家园，通话已停止，请重新连接。'); });
  };
  const begin = (id: string) => {
    if (!current()) return 0;
    const previous = inputSequences.get(id);
    if (previous !== undefined) return previous;
    const turn = ++sequence; inputSequences.set(id, turn); bound(inputSequences);
    callbacks.input(''); callbacks.output(''); callbacks.status('hearing');
    emit({ type: 'speech-start', sequence: turn, itemId: id });
    return turn;
  };
  try {
    signal.throwIfAborted();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (!current()) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Cancelled', 'AbortError'); }
    const agent = new RealtimeAgent({ name: 'Milo', instructions: ticket.instructions, tools: [tool({
      name: 'observe_world', description: 'Read the current world after Jev processes the latest final transcript. Never changes the world. Only the completed list establishes that an activity finished.',
      parameters: z.object({}), execute: async () => {
        if (!current()) return { phase: 'superseded' };
        return voiceRequest<VoiceWorldObservation>(ticket, 'observe', { sequence }, signal);
      },
    })] });
    const transport = new OpenAIRealtimeWebRTC({ audioElement: audio, mediaStream: stream });
    session = new RealtimeSession(agent, { transport, model: ticket.profile.model, tracingDisabled: true, historyStoreAudio: false,
      config: { audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'zh' }, noiseReduction: { type: 'near_field' },
        turnDetection: { type: 'semantic_vad', eagerness: 'medium', createResponse: true, interruptResponse: true } }, output: { voice: ticket.profile.voice } } },
    });
    session.on('transport_event', event => {
      if (!current()) return;
      const e = event as Record<string, unknown>;
      const itemId = typeof e.item_id === 'string' ? e.item_id : '';
      const responseId = typeof e.response_id === 'string' ? e.response_id : '';
      if (e.type === 'input_audio_buffer.speech_started' && itemId) begin(itemId);
      if (e.type === 'input_audio_buffer.speech_stopped') {
        const turn = inputSequences.get(itemId);
        if (turn === sequence) { emit({ type: 'speech-end', sequence }); callbacks.status('thinking'); }
      }
      if (e.type === 'conversation.item.input_audio_transcription.completed' && itemId && typeof e.transcript === 'string') {
        const turn = inputSequences.get(itemId);
        // A final transcript cannot manufacture a new turn after a newer speech-start.
        if (turn === undefined) return;
        if (turn === sequence) callbacks.input(e.transcript);
        emit({ type: 'input', sequence: turn, itemId, text: e.transcript, source: 'voice' });
      }
      if (e.type === 'conversation.item.input_audio_transcription.failed') callbacks.error('没有得到完整转写，无法将口头指令交给 Jev。请重新开始通话。');
      if (e.type === 'response.created') {
        const response = e.response as { id?: string } | undefined;
        if (response?.id) { responseSequences.set(response.id, sequence); bound(responseSequences); }
      }
      if (e.type === 'response.output_audio_transcript.delta' && responseSequences.get(responseId) === sequence && typeof e.delta === 'string') {
        const text = (outputs.get(responseId)?.text ?? '') + e.delta;
        outputs.set(responseId, { itemId, text }); callbacks.output(text.slice(0, 2400));
      }
      if (e.type === 'response.output_audio_transcript.done' && typeof e.transcript === 'string') {
        outputs.set(responseId, { itemId, text: e.transcript }); bound(outputs);
      }
      if (e.type === 'response.done') {
        const response = e.response as { id?: string; status?: string } | undefined;
        const turn = response?.id ? responseSequences.get(response.id) : undefined;
        const output = response?.id ? outputs.get(response.id) : undefined;
        if (response?.status === 'completed' && turn === sequence && output?.text) emit({ type: 'reply', sequence, itemId: output.itemId, text: output.text.slice(0, 2400) });
      }
    });
    session.on('audio_start', () => { if (current()) { callbacks.status('speaking'); void audio.play().catch(() => callbacks.audioBlocked()); } });
    session.on('audio_stopped', () => { if (current()) callbacks.status('listening'); });
    session.on('audio_interrupted', () => { if (current()) callbacks.status('hearing'); });
    session.on('error', () => { if (current()) callbacks.error('OpenAI 实时音频发生错误，请检查模型权限、额度或网络后重新连接。'); });
    transport.on('connection_change', state => {
      if (current() && state === 'disconnected') callbacks.error('OpenAI 音频连接已断开，请重新连接。');
    });
    await session.connect({ apiKey: ticket.connection.ephemeralKey });
    signal.throwIfAborted(); callbacks.status('listening');
    return {
      close,
      interrupt() { session?.interrupt(); if (sequence) emit({ type: 'interrupt', sequence }); callbacks.status('listening'); },
      async sendText(text) {
        const turn = begin(`text-${crypto.randomUUID()}`);
        const id = [...inputSequences.keys()].at(-1)!;
        session?.interrupt(); callbacks.input(text);
        await post({ type: 'input', sequence: turn, itemId: id, text, source: 'text' });
        if (current() && turn === sequence) { callbacks.status('thinking'); session?.sendMessage(text); }
      },
      mute(muted) { session?.mute(muted); },
      resumeAudio() { return audio.play(); },
    };
  } catch (error) { close(); throw error; }
}
