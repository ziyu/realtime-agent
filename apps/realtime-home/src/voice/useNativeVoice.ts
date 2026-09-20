import { useEffect, useRef, useState } from 'react';
import type { WorldState } from '../../shared/types';
import type { NativeVoiceStatus, VoiceCatalog, VoiceProfileId, VoiceSessionState, VoiceSessionTicket } from '../../shared/voice';
import type { AudioConnection } from './types';
import { voiceRequest } from './types';

export function useNativeVoice(world: WorldState | null, onError: (message: string) => void) {
  const [catalog, setCatalog] = useState<VoiceCatalog | null>(null);
  const [profile, setProfile] = useState<VoiceProfileId | 'browser'>('cloudflare-grok');
  const [status, setStatus] = useState<NativeVoiceStatus>('off');
  const [transcript, setTranscript] = useState('');
  const [output, setOutput] = useState('');
  const [muted, setMuted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const connection = useRef<AudioConnection | null>(null);
  const ticketRef = useRef<VoiceSessionTicket | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const errorRef = useRef(onError); errorRef.current = onError;
  const worldRef = useRef(world); worldRef.current = world;
  const selected = catalog?.profiles.find(p => p.id === profile);
  const active = status !== 'off' && status !== 'error';
  const supported = typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.RTCPeerConnection === 'function';
  const stop = () => {
    generation.current++; controller.current?.abort(); controller.current = null;
    clearInterval(timer.current); clearTimeout(expiryTimer.current);
    connection.current?.close(); connection.current = null;
    const ticket = ticketRef.current; ticketRef.current = null;
    if (ticket) void voiceRequest(ticket, 'end').catch(() => undefined);
    setStatus('off'); setMuted(false); setAudioBlocked(false);
  };
  const refresh = async () => {
    try {
      const response = await fetch('/api/voice/catalog', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      const result = await response.json() as VoiceCatalog;
      setCatalog(result); setCatalogError('');
      setProfile(current => catalog ? current : result.defaultProfile);
    } catch { setCatalogError('没有读到语音配置，请检查家园服务并刷新配置。'); }
  };
  useEffect(() => { void refresh(); return () => stop(); }, []);
  useEffect(() => { if (world) connection.current?.syncOutput?.(world); }, [world]);
  const start = async () => {
    if (active) return;
    const snapshot = worldRef.current;
    if (!snapshot || !selected) { errorRef.current('请先连接家园并加载语音配置。'); return; }
    if (!selected.configured) { errorRef.current(`请先配置 ${selected.missing.join('、')}，重启后刷新配置。`); return; }
    if (!supported) { errorRef.current('此浏览器没有可用的麦克风或 WebRTC，请使用桌面浏览器和安全连接。'); return; }
    stop(); const run = generation.current;
    const abort = new AbortController(); controller.current = abort;
    const current = () => run === generation.current && !abort.signal.aborted;
    const fail = (message: string) => {
      if (!current()) return;
      stop(); setStatus('error'); errorRef.current(message);
    };
    setStatus('connecting'); setTranscript(''); setOutput('');
    try {
      const response = await fetch('/api/voice/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epoch: snapshot.epoch, profile }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25000)]),
      });
      if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error ?? '无法创建实时语音会话。'); }
      const ticket = await response.json() as VoiceSessionTicket;
      if (!current()) { void voiceRequest(ticket, 'end').catch(() => undefined); return; }
      ticketRef.current = ticket;
      const options = { ticket, signal: abort.signal, callbacks: {
        status: (value: NativeVoiceStatus) => { if (current()) setStatus(value); },
        input: (text: string) => { if (current()) setTranscript(text); },
        output: (text: string) => { if (current()) setOutput(text); },
        error: fail, audioBlocked: () => { if (current()) setAudioBlocked(true); },
      } };
      let polling = false;
      let reportedBlocks = 0;
      timer.current = setInterval(() => {
        if (!current() || polling) return; polling = true;
        void voiceRequest<VoiceSessionState>(ticket, 'heartbeat', {}, abort.signal).then(state => {
          if (!current()) return;
          if (state.error) { fail(state.error); return; }
          if (state.outputError && (state.blockedOutputs ?? 0) > reportedBlocks) {
            reportedBlocks = state.blockedOutputs ?? 0; errorRef.current(state.outputError);
          }
          if (ticket.connection.kind === 'livekit' && state.status !== 'connecting') setStatus(state.status);
        }).catch(() => { if (current()) fail('实时会话已结束或连接中断，请重新开始。'); }).finally(() => { polling = false; });
      }, 2000);
      expiryTimer.current = setTimeout(() => fail('本次通话已到 15 分钟，请重新连接继续。'), Math.max(0, ticket.expiresAt - Date.now()));
      const result = ticket.connection.kind === 'openai'
        ? await (await import('./openai')).connectOpenAI(options)
        : await (await import('./livekit')).connectLiveKit(options);
      if (!current()) { result.close(); return; }
      connection.current = result;
      if (worldRef.current) result.syncOutput?.(worldRef.current);
    } catch (error) {
      if (!current()) return;
      const device = error instanceof DOMException;
      fail(device && error.name === 'NotAllowedError' ? '麦克风权限未获允许，请允许后重新开始。'
        : device && error.name === 'NotFoundError' ? '没有找到麦克风，请检查输入设备。'
        : error instanceof Error ? error.message : '实时音频连接失败，请重新开始。');
    }
  };
  return { catalog, profile, selected, status, transcript, output, active, supported, muted, audioBlocked, catalogError,
    selectProfile(value: VoiceProfileId | 'browser') { stop(); setProfile(value); },
    refresh, start, stop,
    interrupt() { connection.current?.interrupt(); },
    async sendText(text: string) { if (!connection.current) throw new Error('实时音频还在连接，请稍候或结束通话后发送文字。'); await connection.current.sendText(text); },
    toggleMute() { connection.current?.mute(!muted); setMuted(!muted); },
    async resumeAudio() { try { await connection.current?.resumeAudio(); setAudioBlocked(false); } catch { errorRef.current('浏览器还没有允许播放声音，请检查声音权限。'); } },
  };
}
