import { useEffect, useRef, useState } from 'react';
import { VoiceConversation } from './speech';
import type { Recognition, VoiceStatus } from './speech';
import type { WorldState } from '../shared/types';
import { useNativeVoice } from './voice/useNativeVoice';

type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };

function useBrowserVoice(callbacks: { utterance(text: string): void; interrupt(): void; error(message: string): void }) {
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

export function useVoiceConversation(callbacks: { utterance(text: string): void; interrupt(): void; error(message: string): void }, world: WorldState | null) {
  const browser = useBrowserVoice(callbacks);
  const native = useNativeVoice(world, callbacks.error);
  const isNative = native.profile !== 'browser';
  return {
    ...native,
    isNative,
    status: isNative ? native.status === 'connecting' ? 'starting' : native.status : browser.status,
    transcript: isNative ? native.transcript : browser.transcript,
    active: isNative ? native.active : browser.active,
    supported: isNative ? native.supported : browser.supported,
    start() { if (isNative) void native.start(); else browser.start(); },
    stop() { browser.stop(); native.stop(); },
    selectProfile(value: Parameters<typeof native.selectProfile>[0]) { browser.stop(); native.selectProfile(value); },
  };
}
