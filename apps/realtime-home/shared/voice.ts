export const VOICE_PROFILES = ['openai-webrtc', 'livekit-openai', 'livekit-duplex', 'livekit-gemini', 'livekit-grok'] as const;
export type VoiceProfileId = typeof VOICE_PROFILES[number];
export type NativeVoiceStatus = 'off' | 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'reconnecting' | 'error';
export interface VoiceProfile {
  id: VoiceProfileId;
  label: string;
  framework: 'OpenAI Agents SDK' | 'LiveKit Agents';
  model: string;
  voice: string;
  configured: boolean;
  missing: string[];
  note: string;
}
export interface VoiceCatalog { profiles: VoiceProfile[]; defaultProfile: VoiceProfileId }
export interface VoiceSessionTicket {
  id: string;
  token: string;
  epoch: string;
  profile: VoiceProfile;
  expiresAt: number;
  instructions: string;
  connection: { kind: 'openai'; ephemeralKey: string } | { kind: 'livekit'; url: string; participantToken: string };
}
export interface NativeVoiceEvent {
  type: 'speech-start' | 'speech-end' | 'input' | 'reply' | 'interrupt';
  sequence: number;
  itemId?: string;
  text?: string;
  source?: 'text' | 'voice';
}
export interface VoiceSessionState {
  id: string;
  status: NativeVoiceStatus;
  error: string | null;
  sequence: number;
  input: string;
  output: string;
  inputTurns: number;
  outputTurns: number;
  interruptions: number;
  lastInputAt: number | null;
  firstAudioAt: number | null;
  expiresAt: number;
}
export interface VoiceWorldObservation {
  phase: 'listening' | 'deciding' | 'applied' | 'waiting' | 'superseded';
  turnId: string | null;
  action: string | null;
  actionPhase: string | null;
  progress: number;
  requestedAction: string | null;
  completed: string[];
  needs: Record<string, number>;
  objects: { plantMoisture: number; dishesClean: boolean };
}
