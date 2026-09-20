import type { WorldState } from '../../shared/types';
import type { NativeVoiceStatus, VoiceSessionTicket } from '../../shared/voice';

export interface AudioConnection {
  syncOutput?(world: WorldState): void;
  close(): void;
  interrupt(): void;
  sendText(text: string): Promise<void>;
  mute(muted: boolean): void;
  resumeAudio(): Promise<void>;
}
export interface AudioCallbacks {
  status(status: NativeVoiceStatus): void;
  input(text: string): void;
  output(text: string): void;
  error(message: string): void;
  audioBlocked(): void;
}
export interface AudioOptions {
  ticket: VoiceSessionTicket;
  callbacks: AudioCallbacks;
  signal: AbortSignal;
}
export async function voiceRequest<T = unknown>(ticket: VoiceSessionTicket, action: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(10000);
  const response = await fetch(`/api/voice/sessions/${ticket.id}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticket.token}` },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    keepalive: action === 'end',
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error ?? '实时会话连接中断，请重新开始。');
  }
  return response.json() as Promise<T>;
}
