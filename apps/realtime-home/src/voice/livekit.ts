import { Room, RoomEvent, Track } from 'livekit-client';
import type { AudioConnection, AudioOptions } from './types';
import { voiceRequest } from './types';

export async function connectLiveKit({ ticket, callbacks, signal }: AudioOptions): Promise<AudioConnection> {
  if (ticket.connection.kind !== 'livekit') throw new Error('会话类型不匹配。');
  const room = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, adaptiveStream: true, dynacast: true });
  const players = new Set<HTMLMediaElement>();
  let closed = false;
  const close = () => {
    if (closed) return; closed = true; signal.removeEventListener('abort', close);
    void room.disconnect(true);
    for (const player of players) { player.pause(); player.srcObject = null; player.remove(); }
    players.clear();
  };
  signal.addEventListener('abort', close, { once: true });
  room.on(RoomEvent.TrackSubscribed, track => {
    if (closed || track.kind !== Track.Kind.Audio) return;
    const player = track.attach(); player.autoplay = true; player.hidden = true;
    player.dataset.nativeVoiceAudio = 'livekit'; document.body.append(player); players.add(player);
    void player.play().catch(() => callbacks.audioBlocked());
  });
  room.on(RoomEvent.TrackUnsubscribed, track => {
    for (const player of track.detach()) { player.pause(); player.srcObject = null; players.delete(player); player.remove(); }
  });
  room.on(RoomEvent.Reconnecting, () => { if (!closed) callbacks.status('reconnecting'); });
  room.on(RoomEvent.Reconnected, () => { if (!closed) callbacks.status('listening'); });
  room.on(RoomEvent.Disconnected, () => { if (!closed) callbacks.error('LiveKit 音频连接已断开，请重新连接。'); });
  room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
    try {
      let text = '';
      for await (const chunk of reader) {
        if (closed) return; text = (text + chunk).slice(-2400);
        if (participant.identity.startsWith('milo-agent-')) callbacks.output(text); else callbacks.input(text);
      }
    } catch { /* The stream may be cancelled when the user interrupts. */ }
  });
  try {
    signal.throwIfAborted();
    await room.connect(ticket.connection.url, ticket.connection.participantToken);
    if (closed || signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    await room.localParticipant.setMicrophoneEnabled(true);
    if (closed || signal.aborted) { await room.localParticipant.setMicrophoneEnabled(false); throw new DOMException('Cancelled', 'AbortError'); }
    callbacks.status('listening');
    return {
      close,
      interrupt() {
        // Flush the framework's playout queue on the server. GPT-Live owns model-level stopping.
        void voiceRequest(ticket, 'interrupt', {}, signal).catch(() => callbacks.error('打断消息未送达，请结束并重新连接。'));
      },
      async sendText(text) { await voiceRequest(ticket, 'text', { text }, signal); callbacks.input(text); },
      mute(muted) { void room.localParticipant.setMicrophoneEnabled(!muted).catch(() => callbacks.error('麦克风状态切换失败。')); },
      async resumeAudio() { await room.startAudio(); await Promise.all([...players].map(player => player.play())); },
    };
  } catch (error) { close(); throw error; }
}
