import { useEffect, useRef, useState } from 'react';
import { VoiceConversation } from './speech';
import type { Recognition, VoiceStatus } from './speech';

type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };

export function useVoiceConversation(callbacks: { utterance(text: string): void; interrupt(): void; error(message: string): void }) {
  const callbacksRef = useRef(callbacks); callbacksRef.current = callbacks;
  const session = useRef<VoiceConversation | null>(null);
  const [status, setStatus] = useState<VoiceStatus>('off');
  const [transcript, setTranscript] = useState('');
  const constructor = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
  const stop = () => session.current?.stop();
  const start = () => {
    if (!constructor) return;
    session.current?.stop();
    session.current = new VoiceConversation(() => new constructor(), {
      status: setStatus, transcript: setTranscript,
      utterance: text => callbacksRef.current.utterance(text),
      interrupt: () => callbacksRef.current.interrupt(),
      error: message => callbacksRef.current.error(message),
    });
    session.current.start();
  };
  useEffect(() => () => session.current?.stop(), []);
  return { status, transcript, active: status !== 'off', supported: Boolean(constructor), start, stop };
}
