import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Activity, ArrowDown, ArrowRight, ArrowUp, BookOpen, Brain, Check, ChevronRight, CircleHelp, Clock3, Coffee, Download, Droplets, Expand, Heart, House, Leaf, LoaderCircle, MessageCircle, Mic, Minus, Pause, Play, Plus, RotateCcw, Settings2, Sparkles, Sun, Terminal, Volume2, VolumeX, WifiOff, X, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { TARGETS, isMovement, ACTIONS, ACTION_IDS, ROOM_NAMES, roomAt } from '../shared/world';
import type { ActionId, InputSource, Memory, MessageReceipt, ModelReceipt, Need, WorldState } from '../shared/types';
import { createHome } from './scene';
import { sendApi, useWorld } from './useWorld';
import { MemoryPanel, MindGlance, MindPanel } from './MindPanel';
import { useVoiceConversation } from './useVoiceConversation';
import { TurnDebugger } from './TurnDebugger';
import { VoiceControls } from './VoiceControls';
import './realtime.css';

type Tab = 'chat' | 'mind' | 'thoughts' | 'memories';

function ReceiptDetails({ name, receipt }: { name: string; receipt?: ModelReceipt }) {
  if (!receipt) return <div className="model-receipt">{name}：等待首次成功响应</div>;
  return <div className="model-receipt" data-testid="model-receipt">
    <strong>{name} · {receipt.model ?? '模型响应'} · HTTP {receipt.status}</strong>
    {(receipt.inputTokens !== undefined || receipt.outputTokens !== undefined) && <span>输入 {receipt.inputTokens ?? '—'} / 输出 {receipt.outputTokens ?? '—'} tokens</span>}
    {receipt.requestId && <code>请求 ID：{receipt.requestId}</code>}
  </div>;
}
const time = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const NEEDS: { id: Need; label: string; Icon: LucideIcon }[] = [
  { id: 'energy', label: '精力', Icon: Zap }, { id: 'satiety', label: '饱腹感', Icon: Coffee },
  { id: 'hydration', label: '水分', Icon: Droplets }, { id: 'happiness', label: '心情', Icon: Heart },
];

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog className="modal" ref={ref} onClose={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>{children}
  </dialog>;
}

function HomeScene({ world, connected, selected, onSelect, sceneRef, setError }: { world: WorldState | null; connected: boolean; selected: ActionId | null; onSelect: (id: ActionId) => void; sceneRef: React.RefObject<ReturnType<typeof createHome> | null>; setError: (message: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const callback = useRef(onSelect); callback.current = onSelect;
  const errorCallback = useRef(setError); errorCallback.current = setError;
  useEffect(() => {
    try {
      const home = createHome(container.current!, id => callback.current(id), message => { setFailed(true); errorCallback.current(message); });
      sceneRef.current = home;
      return () => { home.dispose(); sceneRef.current = null; };
    } catch {
      setFailed(true); errorCallback.current('当前浏览器无法启动 WebGL。聊天和物体列表仍然可用，请检查浏览器硬件加速。');
    }
  }, [sceneRef]);
  useEffect(() => { if (world) sceneRef.current?.update(connected && !world.attending ? world : { ...world, paused: true }, selected); }, [world, connected, selected, sceneRef]);
  return <div className="home-canvas" ref={container} data-testid="home-scene">{failed && <div className="scene-fallback"><House size={42} /><p>3D 画面暂时不可用</p><small>仍可通过对话与物体列表和 Milo 互动。</small></div>}</div>;
}

export function App() {
  const { world, connected } = useWorld();
  const [tab, setTab] = useState<Tab>('chat');
  const [selected, setSelected] = useState<ActionId | null>(null);
  const [palette, setPalette] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'settings' | 'about' | 'reset' | null>(null);
  const [forgetting, setForgetting] = useState<Memory | null>(null);
  const [voice, setVoice] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [delivery, setDelivery] = useState<{ pending: boolean; ms?: number; turnId?: string }>({ pending: false });
  const clientId = useRef(crypto.randomUUID());
  const sequence = useRef(0);
  const pendingSends = useRef(0);
  const awaitingDelivery = useRef(false);
  const blockedTurns = useRef(new Set<string>());
  const sceneRef = useRef<ReturnType<typeof createHome> | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastSpoken = useRef<string>('');
  const playbackGeneration = useRef(0);
  const realtimeVoice = useVoiceConversation({
    utterance: text => { void send(text, 'voice'); },
    interrupt: () => interruptReply(),
    error: message => { cancelPlayback(); setError(message); },
  }, world);
  const listening = realtimeVoice.active;
  const turn = world?.turns.find(t => t.id === world.intent?.id);
  const action = world?.agent.action;
  const actionObject = action ? TARGETS[isMovement(action.id) ? action.target! : action.id as ActionId].object : null;
  const actionLabel = action ? isMovement(action.id) ? `${action.id === 'inspect' ? '查看' : '走向'}${actionObject}` : ACTIONS[action.id].label : null;
  const actionVerb = action ? isMovement(action.id) ? `前往${actionObject}${action.id === 'inspect' ? '查看' : ''}` : ACTIONS[action.id].verb : null;
  const local = world?.mode !== 'live';
  const status = !connected ? world ? '连接中断' : '连接中' : world?.paused ? '已暂停' : world?.attending ? world.error ? '保留现场，等待连接恢复' : '听到你了，正在调整' : action?.phase === 'walking' ? `前往${actionObject}` : action ? actionVerb : world?.deciding ? '想想接下来做什么' : world?.thinking ? '整理自己的想法' : world?.error ? '等待连接恢复' : world?.mind?.mood.label ?? '安静待一会儿';
  const cadence = !connected ? '等待连接恢复' : world?.paused ? '调度已暂停' : world?.scheduler?.status === 'backoff' ? '模型重试等待中' : '每 1 秒检查一次 · 按需决策';
  const lastMessage = world?.messages.at(-1);
  const simMinutes = Math.floor((9 * 3600 + 41 * 60 + (world?.elapsed ?? 0) * 12) / 60);
  const clock = `${String(Math.floor(simMinutes / 60) % 24).padStart(2, '0')}:${String(simMinutes % 60).padStart(2, '0')}`;
  const turnStatus = delivery.pending ? '正在送达这句话…' : !connected ? '等待家园重新连接' : world?.paused ? '已记下这句话，继续世界后处理' : world?.attending ? '听到了，正在调整下一步…' : turn?.error ? '这次回复没有生成成功，可以重新提问或直接改口' : world?.thinking ? '正在回应，可以随时继续说或改口' : speaking ? 'Milo 正在说话，可以直接插话' : turn?.replyCancelledAt ? '已打断回复，正在听你说' : turn?.replyAt ? '已回应，继续聊吧' : turn?.appliedAt ? '已经响应，可以随时改口' : '文字和语音都可以随时打断、改口';

  useEffect(() => {
    if (tab === 'chat' && nearBottom.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
  }, [lastMessage?.id, tab]);
  useEffect(() => {
    if (!lastMessage || lastSpoken.current === lastMessage.id) return;
    lastSpoken.current = lastMessage.id;
    if (voice && !lastMessage.nativeAudio && !world?.nativeVoiceActive && connected && !world?.paused && !awaitingDelivery.current && realtimeVoice.status !== 'hearing' && lastMessage.role === 'agent' && (!lastMessage.turnId || !blockedTurns.current.has(lastMessage.turnId)) && 'speechSynthesis' in window) {
      const generation = ++playbackGeneration.current;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(lastMessage.text); utterance.lang = 'zh-CN'; utterance.rate = 1.1;
      utterance.onstart = () => { if (generation === playbackGeneration.current) setSpeaking(true); };
      utterance.onend = utterance.onerror = () => { if (generation === playbackGeneration.current) setSpeaking(false); };
      window.speechSynthesis.speak(utterance);
    }
  }, [lastMessage, voice, connected, world?.paused, realtimeVoice.status]);
  useEffect(() => { cancelPlayback(); }, [world?.epoch, world?.intent?.id, world?.intent?.replySuppressed]);
  useEffect(() => { if (!connected || world?.paused) { realtimeVoice.stop(); cancelPlayback(); } }, [connected, world?.paused]);
  useEffect(() => () => { playbackGeneration.current++; window.speechSynthesis?.cancel(); }, []);

  function cancelPlayback() { playbackGeneration.current++; window.speechSynthesis?.cancel(); setSpeaking(false); }
  function blockPreviousTurn() {
    if (world?.intent) blockedTurns.current.add(world.intent.id);
    if (blockedTurns.current.size > 64) blockedTurns.current.delete(blockedTurns.current.values().next().value!);
    cancelPlayback();
  }
  function interruptReply() {
    blockPreviousTurn();
    if (realtimeVoice.isNative && realtimeVoice.active) { realtimeVoice.interrupt(); return; }
    if (!connected || !world?.intent) return;
    void sendApi('conversation/interrupt', { epoch: world.epoch, turnId: world.intent.id }).catch(() => {
      setError('朗读已停止，但打断消息未送达。请检查连接后再发送新指令。');
    });
  }

  async function request(path: string, body: unknown): Promise<boolean> {
    try { await sendApi(path, body); setError(''); return true; }
    catch (err) { setError(err instanceof Error ? err.message : '连接失败，请稍后重试。'); return false; }
  }
  async function send(text: string, source: InputSource = 'text') {
    const trimmed = text.trim();
    if (!trimmed || !connected || !world) return;
    if (realtimeVoice.isNative && realtimeVoice.active) {
      nearBottom.current = true; setTab('chat');
      if (source === 'text') setDraft(value => value.trim() === trimmed ? '' : value);
      try { await realtimeVoice.sendText(trimmed); setError(''); }
      catch (err) { setError(err instanceof Error ? err.message : '实时文字未送达。'); if (source === 'text') setDraft(value => value || trimmed); }
      return;
    }
    const current = ++sequence.current;
    const started = performance.now();
    blockPreviousTurn(); awaitingDelivery.current = true;
    pendingSends.current++; setSending(true); setDelivery({ pending: true });
    nearBottom.current = true; setTab('chat');
    if (source === 'text') setDraft(value => value.trim() === trimmed ? '' : value);
    try {
      const receipt = await sendApi<MessageReceipt>('messages', { text: trimmed, source, epoch: world.epoch, client: { id: clientId.current, sequence: current } });
      if (current === sequence.current) {
        awaitingDelivery.current = false;
        setDelivery({ pending: false, ms: Math.round(performance.now() - started), turnId: receipt.turnId });
        setError('');
      } else blockedTurns.current.add(receipt.turnId);
    } catch (err) {
      if (current === sequence.current) {
        awaitingDelivery.current = false; setDelivery({ pending: false });
        setError(err instanceof Error ? err.message : '连接失败，请稍后重试。');
        setDraft(value => value || trimmed);
      }
    } finally {
      pendingSends.current--; setSending(pendingSends.current > 0);
      if (source === 'text') input.current?.focus();
    }
  }
  function submit(event: FormEvent) { event.preventDefault(); void send(draft); }
  function startListening() {
    if (listening) { realtimeVoice.stop(); cancelPlayback(); setVoice(false); return; }
    setError(''); setVoice(!realtimeVoice.isNative); setTab('chat'); realtimeVoice.start();
  }
  function downloadTrace() {
    if (!world) return;
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...world }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `realtime-agent-${world.mode}-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="app-shell">
    <header className="topbar">
      <a href="/" className="brand"><span className="brand-mark"><Activity size={23} strokeWidth={2.4} /></span>Realtime<span className="brand-light">Agent</span><span className="alpha">LAB</span></a>
      <nav aria-label="主导航"><button className={tab !== 'thoughts' ? 'nav-active' : ''} onClick={() => setTab('chat')}>我的家园</button><button className={tab === 'thoughts' ? 'nav-active' : ''} onClick={() => setTab('thoughts')}>运行记录</button></nav>
      <div className="topbar-right"><span className={`mode-chip ${local ? 'demo' : ''}`} data-testid="model-mode"><span className="dot" />{local ? '本地演示' : 'Jev 实时模式'}</span><button className="connect-button" aria-label="模型连接" onClick={() => setModal('settings')}><Settings2 size={15} /><span>模型连接</span></button></div>
    </header>

    <main className="workspace">
      <section className="world-column" aria-label="家园与状态">
        <div className="page-heading"><div><div className="eyebrow">A LITTLE WORLD, A LIVING MIND</div><h1>一个会生活的 AI。<span className="heading-spark">✳</span></h1><p>看它生活，和它聊聊。每一个小决定，都在此刻发生。</p></div><button className="about-button" onClick={() => setModal('about')} aria-label="了解这个实验"><CircleHelp size={19} /></button></div>
        <div className="scene-card">
          <div className="scene-heading"><div className="scene-title"><House size={16} /><span>Milo 的家</span><span className="scene-divider" /><small>DAY {String(1 + Math.floor(simMinutes / 1440)).padStart(2, '0')}</small></div><div className="world-weather"><Sun size={16} /><span>晴朗</span><span className="clock">{clock}</span></div></div>
          <div className="scene-stage">
            <HomeScene world={world} connected={connected} selected={selected} onSelect={setSelected} sceneRef={sceneRef} setError={setError} />
            <div className="scene-legend"><span className={`dot ${!connected || world?.paused ? 'muted' : ''}`} />{!connected ? world ? '连接中断 · 显示最后状态' : '正在连接家园' : world?.paused ? '时间暂停了' : '世界正在发生'}</div>
            <div className="camera-controls"><button title="放大" aria-label="放大" onClick={() => sceneRef.current?.zoom(0.15)}><Plus size={17} /></button><button title="缩小" aria-label="缩小" onClick={() => sceneRef.current?.zoom(-0.15)}><Minus size={17} /></button><span /><button title="重置视角" aria-label="重置视角" onClick={() => sceneRef.current?.resetCamera()}><Expand size={16} /></button></div>
            {selected && <div className="object-card" data-testid="object-card"><button className="object-close icon-button" onClick={() => setSelected(null)} aria-label="取消选择"><X size={15} /></button><div className="eyebrow">{ROOM_NAMES[ACTIONS[selected].room]} · 可交互物体</div><h3>{ACTIONS[selected].object}</h3><p>{ACTIONS[selected].description}</p><button className="primary-button" disabled={!connected} onClick={() => { void send(`请${ACTIONS[selected].label}。`, 'object'); setSelected(null); }}><Sparkles size={15} />请 Milo {ACTIONS[selected].label}<ArrowRight size={14} /></button></div>}
            <div className="scene-bottom-label"><span className="tiny-robot">m<span /></span><div><strong>Milo<span className="online-dot" /></strong><span data-testid="agent-status">{status}</span></div>{world?.thinking && <Brain size={17} className="thinking-icon" />}</div>
            <span className="scene-hint">拖动旋转 · 滚轮缩放 · 点击物体</span>
          </div>
          <div className="scene-toolbar"><div className="playback"><button className="play-button" aria-label={world?.paused ? '继续世界' : '暂停世界'} disabled={!connected} onClick={() => void request('control', { type: 'pause', paused: !world?.paused })}>{world?.paused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}</button><div className="speed-control" aria-label="世界速度">{([1, 2, 4] as const).map(speed => <button key={speed} aria-pressed={world?.speed === speed} className={world?.speed === speed ? 'active' : ''} disabled={!connected} onClick={() => void request('control', { type: 'speed', speed })}>{speed}×</button>)}</div><button className="icon-button restart" title="重新开始（保留记忆）" aria-label="重新开始" disabled={!connected} onClick={() => setModal('reset')}><RotateCcw size={15} /></button></div><div className="objects-menu"><button className={`objects-button ${palette ? 'active' : ''}`} aria-expanded={palette} onClick={() => setPalette(!palette)}><Leaf size={14} />8 个可交互物体<ChevronRight size={13} /></button>{palette && <div className="object-palette">{ACTION_IDS.map(id => <button key={id} onClick={() => { setSelected(id); setPalette(false); }}><span>{ACTIONS[id].object}</span><small>{ROOM_NAMES[ACTIONS[id].room]}</small></button>)}</div>}</div></div>
        </div>

        <section className="needs-card" aria-label="Milo 的需求"><div className="needs-intro"><span className="avatar-small"><Activity size={20} /></span><div><strong>Milo 的状态</strong><span>{world ? ROOM_NAMES[roomAt(world.agent.position)] : '正在连接家园'}</span></div></div><div className="needs-grid">{NEEDS.map(({ id, label: title, Icon }) => { const value = Math.round(world?.agent.needs[id] ?? 0); return <div className={`need-item need-${id}`} key={id}><div><span><Icon size={13} />{title}</span><strong>{world ? value : '—'}<small>/100</small></strong></div><div className="need-track" role="progressbar" aria-label={title} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${value}%` }} /></div></div>; })}</div></section>

        <section className="execution-status" aria-label="行为执行状态" data-testid="execution-status">
          <div className="execution-current"><Activity size={16} /><div><strong>{status}</strong><span data-testid="decision-cadence">{cadence}</span></div></div>
          <div className="execution-progress">{action ? <><span>{action.phase === 'walking' ? `正在行走 · ${actionLabel}` : `${actionLabel} · ${Math.round(action.progress * 100)}%`}</span><progress aria-label="当前动作进度" max={1} value={action.progress} /></> : <span>完成动作后才更新需求与记忆</span>}</div>
          <div className="execution-totals"><strong data-testid="completed-actions">{world?.metrics.completed ?? 0}</strong><span>已完成动作</span></div>
        </section>
        {world && <TurnDebugger world={world} connected={connected} />}
        {world?.mind && <MindGlance mind={world.mind} onOpen={() => setTab('mind')} />}
        <div className="architecture-heading"><span><Activity size={14} />此刻，两种思考在协作</span><button onClick={() => setTab('thoughts')}>查看决策过程<ArrowRight size={13} /></button></div>
        <div className="systems-grid"><div className={`system-card ${world?.deciding ? 'system-active' : ''}`}><span className="system-icon fast"><Zap size={18} /></span><div><div className="system-title"><strong>快速决策</strong><span>SYSTEM 1</span></div><p>{local ? '本地规则演示' : world?.connected.jevModel} · {world?.deciding ? '正在选择下一步' : '感知、选择、行动'}</p></div><div className="system-stat">{world?.metrics.decisions ?? 0}<small>次决策</small></div></div><div className={`system-card ${world?.thinking ? 'system-active' : ''}`}><span className="system-icon slow"><Brain size={18} /></span><div><div className="system-title"><strong>慢速思考</strong><span>SYSTEM 2</span></div><p>{world?.thinking ? '正在整理想法…' : local ? '模拟建议 · 按需唤醒' : world?.connected.llm ? '语言模型 · 按需唤醒' : '语言模型待连接'}</p></div><div className="system-stat">{world?.metrics.reflections ?? 0}<small>次思考</small></div></div></div>
        <p className="world-footnote">{local ? '当前使用本地规则与模拟建议，不会调用模型，也不代表 Jev 的实际能力。' : 'Jev 选择每一个行为，并决定何时唤醒语言模型。动作结果由世界验证。'}<button onClick={() => setModal('settings')}>{local ? '连接真实模型' : '查看连接'}<ArrowRight size={12} /></button></p>
      </section>

      <aside className="conversation-column" aria-label="与 Milo 互动">
        <div className="companion-heading"><div className="companion-avatar"><span className="robot-eyes">••</span><span className="antenna" /></div><div><h2>Milo<span className="companion-badge">你的 AI 室友</span></h2><p><span className={`dot ${!connected || world?.paused ? 'muted' : ''}`} />{status}</p></div><button className="icon-button voice-button" aria-pressed={voice} aria-label={voice ? '关闭朗读' : '朗读回复'} title={voice ? '关闭朗读' : '朗读回复（浏览器语音）'} disabled={!('speechSynthesis' in window)} onClick={() => { if (voice) cancelPlayback(); setVoice(!voice); }}>{voice ? <Volume2 size={17} /> : <VolumeX size={17} />}</button></div>
        <div className="tabs" role="tablist" aria-label="互动面板">{([{ id: 'chat', label: '对话', Icon: MessageCircle }, { id: 'mind', label: '内心', Icon: Heart }, { id: 'thoughts', label: '思考', Icon: Brain }, { id: 'memories', label: '记忆', Icon: BookOpen }] as const).map(({ id, label: title, Icon }) => <button id={`tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} key={id} onClick={() => { setTab(id); nearBottom.current = true; }}><Icon size={15} />{title}{id === 'memories' && !!world?.memories.length && <span className="tab-count">{world.memories.length}</span>}{id === 'thoughts' && world?.thinking && <span className="dot" />}</button>)}</div>
        <VoiceControls voice={realtimeVoice} connected={connected} paused={world?.paused ?? false} canInterrupt={realtimeVoice.isNative && listening || speaking || Boolean(world?.thinking || world?.reflection)} onToggle={startListening} onInterrupt={interruptReply} />
        {!connected && <div className="connection-note" role="status"><WifiOff size={14} />正在连接家园，恢复后会自动同步…</div>}
        {(error || world?.error) && <div className="error-note" role="alert"><span>{error || world?.error}</span>{error && <button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={14} /></button>}</div>}

        {tab === 'thoughts' && !local && <div className="request-receipts">
          <small>最近成功的模型响应</small>
          <ReceiptDetails name="Jev" receipt={world?.traces.findLast(t => t.source === 'jev' && t.receipt)?.receipt} />
          <ReceiptDetails name="LLM" receipt={world?.traces.findLast(t => t.source === 'llm' && t.receipt)?.receipt} />
        </div>}

        {tab === 'chat' && <><div className="chat-scroll" id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" ref={scroll} onScroll={e => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; }}>
          <div className="day-separator"><span />今天 · 新的一天<span /></div>
          <div className="chat-welcome"><span><Sun size={24} strokeWidth={1.4} /></span><h3>打个招呼吧。</h3><p>它有自己的生活，<br />也会为你停下手边的小事。</p></div>
          <div className="message-list" role="log" aria-label="聊天记录" aria-live="polite" aria-relevant="additions text">{world?.messages.map(message => <div key={message.id} className={`message message-${message.role}${message.initiative ? ' message-initiative' : ''}`}><div className="message-meta"><span>{message.role === 'user' ? '你' : message.role === 'system' ? '家园提示' : message.initiative ? 'Milo · 想与你分享' : 'Milo'}</span><time>{time(message.at)}</time>{message.role === 'agent' && <span className="message-source">{local ? 'DEMO' : 'LIVE'}</span>}</div><div className="message-bubble">{message.text}</div></div>)}</div>
          {world?.thinking && <div className="thinking-message"><span className="typing-dots"><i /><i /><i /></span>Milo 在慢慢想，生活还在继续。</div>}
        </div><div className="chat-composer">
          <div className="suggestion-heading">一起做点什么</div>
          <div className="suggestions">{['先喝水，再给植物浇水', '去看会儿书吧', '帮我安排一下今天'].map(text => <button key={text} disabled={!connected} onClick={() => void send(text)}>{text}<ArrowUp size={12} /></button>)}</div>
          <form onSubmit={submit} className={`composer ${listening ? 'listening' : ''}`}>
            <textarea ref={input} value={draft} onChange={e => setDraft(e.target.value)} maxLength={1200} placeholder={listening ? '也可以直接输入文字…' : '和 Milo 说点什么…'} aria-label="给 Milo 发消息" rows={2} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft); } }} />
            <div className="composer-actions"><button type="button" className={`icon-button ${listening ? 'recording' : ''}`} disabled={!realtimeVoice.supported || !connected || world?.paused} aria-label={listening ? '停止语音输入' : '语音输入'} title="持续语音对话，说完自动发送" onClick={startListening}><Mic size={18} /></button><small>{listening ? '正在听，说完自动发送' : world?.paused ? '世界已暂停，指令将在继续后处理' : '随时改口，不用等它做完。'}</small><button className="send-button" type="submit" disabled={!connected || !draft.trim()} aria-label="发送消息">{sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={19} />}</button></div>
          </form>
          <div className="realtime-status" role="status" data-testid="realtime-status" data-turn-id={turn?.id}><span>{turnStatus}</span>{turn?.appliedAt != null && <small data-testid="reaction-latency">行为响应 {((turn.appliedAt - turn.receivedAt) / 1000).toFixed(2)} 秒{turn.replyAt != null ? ` · 回复 ${((turn.replyAt - turn.receivedAt) / 1000).toFixed(2)} 秒` : ''}</small>}</div>
          <p className="input-hint">Enter 发送<span>·</span>Shift + Enter 换行</p>
        </div></>}

        {tab === 'thoughts' && turn && <div className="turn-metrics" data-testid="turn-metrics"><h4>最近一轮对话</h4><p><span>页面到服务端往返</span><span>{delivery.turnId === turn.id && delivery.ms != null ? `${delivery.ms} ms` : '—'}</span></p><p><span>接收到首个有效决策</span><span>{turn.decisionAt == null ? '等待中' : `${turn.decisionAt - turn.receivedAt} ms`}</span></p><p><span>接收到行为响应</span><span>{turn.appliedAt == null ? '等待中' : `${turn.appliedAt - turn.receivedAt} ms`}</span></p><p><span>接收到已采纳回复</span><span>{turn.replyAt == null ? '—' : `${turn.replyAt - turn.receivedAt} ms`}</span></p><small>行为响应表示开始、继续或停止动作；完成效果另行记录。语音识别耗时不包含在服务端时间内。</small></div>}

        {tab === 'thoughts' && <div className="inspector-scroll" id="panel-thoughts" role="tabpanel" aria-labelledby="tab-thoughts"><div className="inspector-intro"><div className="eyebrow">BEHIND THE MOMENT</div><h3>每一步，都有迹可循。</h3><p>{local ? '正在观察本地规则演示的选择与动作。' : '观察 Jev 的选择、执行结果与慢思考建议。'}</p></div><div className="metric-row"><div><strong>{world?.metrics.jevCalls ?? 0}</strong><span>Jev 请求</span></div><div><strong>{world?.metrics.llmCalls ?? 0}</strong><span>LLM 请求</span></div><div><strong>{world?.metrics.completed ?? 0}</strong><span>完成动作</span></div></div>{world?.decision?.confidence != null && <div className="probability-card"><strong>最近一次决策的置信度 <span>{Math.round(world.decision.confidence * 100)}%</span></strong><p>置信度与动作概率是两个不同的值。</p>{Object.entries(world.decision.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, value]) => <div key={id}><span>{Object.hasOwn(ACTIONS, id) ? ACTIONS[id as ActionId].label : id === 'idle' ? '等待' : '继续'}</span><meter min={0} max={1} value={value} /><small>{Math.round(value * 100)}%</small></div>)}</div>}{world?.reflection && <div className="reflection-card"><span><Brain size={14} />{world.reflection.source === 'demo' ? '模拟慢思考建议' : '慢思考建议'}<small>{world.reflection.accepted ? '已采纳' : '待快系统评估'}</small></span><p>{world.reflection.summary}</p><div className="plan-steps">{world.reflection.suggestedActions.map((id, index) => <span key={`${id}-${index}`}>{index + 1}. {ACTIONS[id].label}</span>)}</div></div>}<div className="timeline-heading"><span>事件时间线</span><button className="icon-button" onClick={downloadTrace} disabled={!world} aria-label="导出运行记录" title="导出本次世界状态与记录"><Download size={15} /></button></div><div className="timeline">{[...(world?.traces ?? [])].reverse().map(trace => <article key={trace.id} className={`trace trace-${trace.kind}`}><span className="trace-dot" /><div className="trace-title"><strong>{trace.title}</strong><time>{time(trace.at)}</time></div><p>{trace.detail}</p>{trace.latencyMs !== undefined && <small>{trace.source === 'demo' ? '本地耗时' : '请求耗时'} {trace.latencyMs} ms{trace.confidence != null ? ` · 置信度 ${Math.round(trace.confidence * 100)}%` : ''}</small>}</article>)}</div>{!world?.traces.length && <div className="empty-state"><Activity size={24} /><p>第一个决定，马上就来。</p></div>}</div>}

        {tab === 'mind' && world && <MindPanel world={world} connected={connected} onToggleSharing={value => void request('mind/settings', { proactiveChat: value })} />}
        {tab === 'memories' && <MemoryPanel memories={world?.memories ?? []} connected={connected} onForget={setForgetting} />}
      </aside>
    </main>
    <footer className="page-footer"><span>REALTIMEAGENT <i>/</i> A SYSTEM 1 + SYSTEM 2 EXPERIMENT</span><span><span className="dot" />Little moments. Real decisions.</span></footer>

    {modal === 'settings' && <Modal title="连接它的思考能力" onClose={() => setModal(null)}>
      <p className="modal-lead">当前为<strong>{local ? '本地规则演示' : 'Jev 实时模式'}</strong>。Jev 选择行为，并按需调用语言模型。</p>
      <div className="connection-list">
        <div><Zap size={18} /><span>快速决策<small>{world?.connected.provider === 'cloudflare' ? 'Cloudflare' : 'TypeSafe'} · {world?.connected.jevModel ?? 'jev-latest'}</small></span><b>{world?.connected.jev ? '已配置' : '未连接'}</b></div>
        <div><Brain size={18} /><span>慢速思考<small>{world?.connected.llmModel || '兼容 Chat Completions 的语言模型'}</small></span><b>{world?.connected.llm ? '已配置' : '未连接'}</b></div>
      </div>
      <p>统一使用 Cloudflare：在根目录 <code>.env</code> 填写下面两项，运行 <code>pnpm dev:cloudflare</code>。Jev、文字对话和 Grok 实时语音共用这一个账户 Token，本地音频房间自动启动。</p>
      <pre>{'CLOUDFLARE_ACCOUNT_ID=你的账户 ID\nCLOUDFLARE_API_TOKEN=你的 API Token'}</pre>
      <p className="modal-note">Token 需要 Account → Workers AI → Read 权限，账户需有 AI Gateway 预付余额。请使用 API Token，不是 Global API Key。凭据只留在服务端；“已配置”表示读取到了配置，实际连接结果会显示在运行记录中。</p>
      <button className="primary-button modal-done" onClick={() => setModal(null)}>回到家园<ArrowRight size={15} /></button>
    </Modal>}
    {modal === 'about' && <Modal title="一个关于实时行为的小实验" onClose={() => setModal(null)}><div className="about-symbol"><Activity size={34} /></div><p className="modal-lead">Milo 住在一个有真实状态的小世界里。它会口渴、会疲惫，也会在你的指令到来时重新考虑正在做的事。</p><div className="about-step"><Zap size={19} /><p><strong>快系统负责每一个行为</strong><span>Jev 从可执行动作中选择下一步，也决定是否需要中断当前动作、是否唤醒慢思考。</span></p></div><div className="about-step"><Brain size={19} /><p><strong>慢系统整理更长远的想法</strong><span>语言模型提供计划、对话和记忆建议。返回的计划仍需经过快系统选择，才能变为行动。</span></p></div><div className="about-step"><House size={19} /><p><strong>世界决定事情有没有完成</strong><span>角色需要走到物体旁边、执行完动作，才会获得效果。中断和过期的结果不会被当成成功。</span></p></div><p className="modal-note">这是单机共享世界 Demo，时间与天气均为模拟。语音功能使用浏览器能力，支持情况取决于浏览器。</p></Modal>}
    {modal === 'reset' && <Modal title="重新开始这一天？" onClose={() => setModal(null)}><p className="modal-lead">Milo 会回到最初的位置和状态。本轮对话、动作与决策记录会清空，已经积累的记忆会保留。</p><div className="modal-buttons"><button className="secondary-button" onClick={() => setModal(null)}>继续这一天</button><button className="primary-button" onClick={async () => { if (await request('control', { type: 'reset' })) { setModal(null); setSelected(null); } }}><RotateCcw size={15} />重新开始</button></div></Modal>}
    {forgetting && <Modal title="让 Milo 忘记这件事？" onClose={() => setForgetting(null)}><p className="modal-lead">这条记忆及相关原话、随记和对话回复会被移除，之后不会再作为回忆提供给模型。它的性格会保留。</p><div className="modal-buttons"><button className="secondary-button" onClick={() => setForgetting(null)}>留下这页</button><button className="primary-button" onClick={async () => { if (await request('memories/forget', { id: forgetting.id })) setForgetting(null); }}>忘记这件事</button></div></Modal>}
  </div>;
}
