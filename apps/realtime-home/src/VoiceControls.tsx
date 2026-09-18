import { Mic, MicOff, Volume2 } from 'lucide-react';
import type { useVoiceConversation } from './useVoiceConversation';
import type { VoiceProfileId } from '../shared/voice';

type Voice = ReturnType<typeof useVoiceConversation>;
const STATUS: Record<string, string> = {
  starting: '正在建立音频连接…', listening: '正在听，可以直接说话。', hearing: '正在听你说…',
  thinking: '正在回应，随时可以插话。', speaking: 'Milo 正在说话，可以直接打断。', reconnecting: '正在恢复音频连接…',
};
export function VoiceControls({ voice, connected, paused, canInterrupt, onToggle, onInterrupt }: {
  voice: Voice; connected: boolean; paused: boolean; canInterrupt: boolean; onToggle(): void; onInterrupt(): void;
}) {
  return <div className="realtime-controls" data-testid="realtime-controls">
    <label className="voice-profile-label">对话声音<select aria-label="实时语音方案" value={voice.profile} disabled={voice.active} onChange={event => voice.selectProfile(event.target.value as VoiceProfileId | 'browser')}>
      {(voice.catalog?.profiles ?? [{ id: 'openai-webrtc', label: 'GPT-Realtime · 直连', configured: false }]).map(profile => <option key={profile.id} value={profile.id}>{profile.label}{profile.configured ? '' : ' · 待配置'}</option>)}
      <option value="browser">浏览器语音 · 旧版</option>
    </select></label>
    {voice.isNative && <div className="voice-provider-note"><span>{voice.selected?.framework ?? 'OpenAI Agents SDK'}</span><code>{voice.selected?.model ?? 'gpt-realtime-2.1'}</code></div>}
    <div className="realtime-controls-row"><button type="button" className="realtime-toggle" aria-pressed={voice.active} disabled={!voice.supported || !connected || paused} onClick={onToggle}><Mic size={15} />{voice.active ? '结束实时对话' : '开始实时对话'}</button>
      <button type="button" className="interrupt-reply" disabled={!connected || !canInterrupt} onClick={onInterrupt}>打断回复</button>
      {voice.active && voice.isNative && <button type="button" className="icon-button" aria-label={voice.muted ? '开启麦克风' : '静音麦克风'} aria-pressed={voice.muted} onClick={voice.toggleMute}>{voice.muted ? <MicOff size={16} /> : <Mic size={16} />}</button>}
    </div>
    <p className="voice-caption" data-testid="voice-caption" aria-live="polite">{voice.transcript ? <><strong>你：</strong>{voice.transcript}</> : voice.active ? STATUS[voice.status] ?? '正在连接…' : voice.isNative ? '原生音频会话：持续聆听、流式声音，允许插话和改口。' : '旧版浏览器识别，说完自动发送；建议戴耳机。'}</p>
    {voice.active && voice.isNative && voice.output && <p className="native-voice-output" data-testid="native-voice-output"><strong>Milo：</strong>{voice.output}</p>}
    {voice.audioBlocked && <button className="text-button" onClick={() => void voice.resumeAudio()}><Volume2 size={14} />点击启用声音</button>}
    {voice.isNative && !voice.active && (voice.catalogError || voice.selected) && <details className="voice-setup" open={Boolean(voice.catalogError || !voice.selected?.configured)}>
      <summary>{voice.selected?.configured ? '查看此方案' : '完成语音配置'}</summary>
      <p>{voice.catalogError || voice.selected?.note}</p>
      {!!voice.selected?.missing.length && <p>根目录 <code>.env</code> 还需：{voice.selected.missing.map(key => <code key={key}>{key}</code>)}。配置后重启服务。</p>}
      <button type="button" onClick={() => void voice.refresh()}>刷新配置</button>
    </details>}
  </div>;
}
