import { randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { Room, RoomEvent } from '@livekit/rtc-node';
import { initializeLogger, llm, voice } from '@livekit/agents';
import { Behavior, FunctionResponseScheduling } from '@google/genai';
import type { VoiceConfig } from '@realtime-agent/config';
import type { VoiceProfile } from '../../shared/voice';
import type { VoiceBridge } from './bridge';
import type { VoiceBackend } from './gateway';
import { VoiceTurns } from './turns';
import { observeModel } from './model-lifecycle';
import { ControlledRealtimeModel } from './controlled-model';

// Provider failures can contain request objects. Only our sanitized session errors are exposed.
initializeLogger({ pretty: false, level: 'silent' });

export async function createVoiceModel(profile: VoiceProfile, config: VoiceConfig) {
  if (profile.id === 'cloudflare-grok') throw new Error('Cloudflare voice requires the account WebSocket adapter.');
  if (profile.id === 'livekit-duplex') {
    const openai = await import('@livekit/agents-plugin-openai');
    return new openai.realtime.GPTLiveModel({ model: profile.model, voice: profile.voice, apiKey: config.openaiKey,
      responsesOptions: { model: config.models.backend, maxOutputTokens: 800,
        instructions: 'Jev controls actions and speech. Only render supplied VERIFIED_TEXT; do not answer the user independently or call tools.',
      },
    });
  }
  if (profile.id === 'livekit-gemini') {
    const google = await import('@livekit/agents-plugin-google');
    // Gemini 3.8 rejects thinking_config, proactive_audio:false and affective-dialog settings.
    return new google.realtime.RealtimeModel({ model: profile.model, voice: profile.voice, apiKey: config.googleKey,
      inputAudioTranscription: {}, outputAudioTranscription: {},
      toolBehavior: Behavior.NON_BLOCKING, toolResponseScheduling: FunctionResponseScheduling.WHEN_IDLE,
    });
  }
  if (profile.id === 'livekit-grok') {
    const { GrokRealtimeModel } = await import('./grok-model');
    return new GrokRealtimeModel({ model: profile.model, voice: profile.voice, apiKey: config.xaiKey });
  }
  const openai = await import('@livekit/agents-plugin-openai');
  return new openai.realtime.RealtimeModel({ model: profile.model, voice: profile.voice, apiKey: config.openaiKey,
    inputAudioTranscription: { model: 'gpt-4o-mini-transcribe', language: 'zh' },
    inputAudioNoiseReduction: { type: 'near_field' },
    turnDetection: { type: 'semantic_vad', eagerness: 'medium', create_response: false, interrupt_response: true },
  });
}

/** In-process AgentSession is sufficient for the current single shared world. No Python worker. */
export async function startLiveKit(profile: VoiceProfile, bridge: VoiceBridge, instructions: string, config: VoiceConfig, signal: AbortSignal, modelFactory = createVoiceModel): Promise<VoiceBackend> {
  const roomName = `milo-${randomUUID()}`, humanIdentity = `human-${randomUUID()}`;
  const room = new Room();
  const service = new RoomServiceClient(config.livekit.url.replace(/^ws/, 'http'), config.livekit.apiKey, config.livekit.apiSecret);
  const model = await modelFactory(profile, config);
  const turns = new VoiceTurns(bridge);
  let closed = false, started = false;
  const lifecycle = observeModel(model, provider => {
    // Raw OpenAI/xAI IDs are available before their generic speech events are emitted.
    if (provider instanceof llm.RealtimeSession) provider.on('openai_server_event_received', (event: Record<string, unknown>) => {
      if (closed || !bridge.active) return;
      if (event.type === 'input_audio_buffer.speech_started' && typeof event.item_id === 'string') turns.start(event.item_id);
      // xAI's plugin may hold a final transcript until its first output audio frame.
      // The body can react as soon as the provider's final transcript arrives.
      if (event.type === 'conversation.item.input_audio_transcription.completed' && event.status !== 'in_progress' && typeof event.item_id === 'string' && typeof event.transcript === 'string') {
        turns.transcript({ itemId: event.item_id, transcript: event.transcript, isFinal: true });
      }

    });
    const inputStarted = () => { if (!closed && bridge.active && !turns.hearing) turns.start(); };
    const inputStopped = () => { if (!closed && bridge.active) turns.stop(); };
    const inputTranscribed = (event: llm.InputTranscriptionCompleted) => {
      if (!closed && bridge.active) turns.transcript(event);
    };
    // The two public SDK interfaces have different emitter overloads.
    if (provider instanceof llm.RealtimeSession) {
      provider.on('input_speech_started', inputStarted);
      provider.on('input_speech_stopped', inputStopped);
      provider.on('input_audio_transcription_completed', inputTranscribed);
    } else {
      provider.on('input_speech_started', inputStarted);
      provider.on('input_speech_stopped', inputStopped);
      provider.on('input_audio_transcription_completed', inputTranscribed);
    }
  });
  const controlled = new ControlledRealtimeModel(lifecycle.model instanceof llm.DuplexModel ? new llm.DuplexRealtimeAdapter(lifecycle.model) : lifecycle.model, bridge);
  const session = new voice.AgentSession({ llm: controlled });
  let pendingOutput: AbortController | null = null;
  let requestedExecution: string | null = null;
  const requestOutput = () => {
    if (closed || !bridge.active) { pendingOutput?.abort(); return; }
    if (!started) return;
    const execution = bridge.runtime.speechAction();
    if (!execution || bridge.runtime.state.speech?.delivered || bridge.runtime.state.speech?.error) {
      if (requestedExecution) { pendingOutput?.abort(); requestedExecution = null; }
      return;
    }
    if (execution.id === requestedExecution) return;
    requestedExecution = execution.id;
    pendingOutput?.abort(); const controller = new AbortController(); pendingOutput = controller;
    const sequence = bridge.state.sequence;
    void (async () => {
      await session.interrupt({ force: true }).await.catch(() => undefined);
      const plan = await bridge.outputPlan(sequence, controller.signal);
      if (!plan || controller.signal.aborted || closed || !bridge.allowOutput(plan.id, sequence)) return;
      const handle = session.generateReply({ instructions: controlled.authorize(plan), allowInterruptions: true });
      const cancel = () => { handle.interrupt(true); };
      const outputSignal = bridge.outputSignal(plan);
      outputSignal.addEventListener('abort', cancel, { once: true });
      try { await handle.waitForPlayout(); if (!handle.interrupted && bridge.allowOutput(plan.id, sequence)) bridge.event({ type: 'reply', sequence, itemId: plan.id, text: plan.exactText }); } finally { outputSignal.removeEventListener('abort', cancel); }
    })().catch(() => { if (!controller.signal.aborted && !closed) bridge.outputRejected(sequence); });
  };
  const unsubscribeInput = bridge.subscribeActivity(requestOutput);
  let closing: Promise<void> | undefined;
  const close = async () => {
    if (closing) return closing;
    closed = true;
    pendingOutput?.abort(); unsubscribeInput();
    closing = (async () => {
      // Close input/network and provider generation together, before a framework drain can wait.
      await Promise.allSettled([lifecycle.closeConnections(), room.disconnect(), service.deleteRoom(roomName)]);
      await session.close().catch(() => undefined);
      await model.close().catch(() => undefined);
    })();
    return closing;
  };
  const onAbort = () => { void close(); };
  signal.addEventListener('abort', onAbort, { once: true });
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, event => {
    if (closed) return;
    if (event.newState === 'speaking') bridge.audioStarted(turns.sequence);
    else if (['listening', 'thinking'].includes(event.newState)) bridge.setStatus(event.newState as 'listening' | 'thinking');
  });
  session.on(voice.AgentSessionEventTypes.Error, () => {
    bridge.fail('语音模型连接出错，请检查模型权限、额度或网络后重新开始。'); void close();
  });
  session.on(voice.AgentSessionEventTypes.Close, () => {
    if (!closed) { bridge.fail('实时语音会话已经结束，请重新开始。'); void close(); }
  });
  room.on(RoomEvent.Disconnected, () => {
    if (!closed) { bridge.fail('实时音频连接已断开，请重新开始通话。'); void close(); }
  });
  const agent = new voice.Agent({ instructions });
  try {
    signal.throwIfAborted();
    await service.createRoom({ name: roomName, emptyTimeout: 30, maxParticipants: 2 });
    signal.throwIfAborted();
    const token = async (identity: string) => {
      const grant = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, { identity, ttl: '15m' });
      grant.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
      return grant.toJwt();
    };
    await room.connect(config.livekit.url, await token(`milo-agent-${bridge.state.id}`), { autoSubscribe: true, dynacast: false });
    signal.throwIfAborted();
    await session.start({ agent, room, record: false, inputOptions: { participantIdentity: humanIdentity, textEnabled: false, videoEnabled: false, closeOnDisconnect: true }, outputOptions: { transcriptionEnabled: true } });
    started = true;
    requestOutput();
    signal.throwIfAborted();
    return {
      connection: { kind: 'livekit', url: config.livekit.url, participantToken: await token(humanIdentity) },
      async interrupt() {
        if (started && !closed) await session.interrupt({ force: true }).await.catch(() => undefined);
      },
      async sendText(text: string) {
        if (closed || !bridge.active) throw new Error('Session closed.');
        // Final text follows the same decision gate as microphone transcripts.
        const chat = session.currentAgent.chatCtx.copy(); chat.addMessage({ role: 'user', content: text });
        await session.currentAgent.updateChatCtx(chat);
        turns.text(text, `text-${randomUUID()}`);
      },
      async close() { signal.removeEventListener('abort', onAbort); await close(); },
    };
  } catch (error) {
    signal.removeEventListener('abort', onAbort); await close();
    // An SDK operation may settle after abort. Reclaim any resources it created late.
    await room.disconnect().catch(() => undefined);
    await service.deleteRoom(roomName).catch(() => undefined);
    throw error;
  }
}
