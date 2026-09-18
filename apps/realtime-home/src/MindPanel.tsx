import { ArrowRight, BookOpen, Heart, Leaf, Sparkles, Trash2 } from 'lucide-react';
import type { Memory, WorldState } from '../shared/types';
import { ACTIONS } from '../shared/world';
import type { MindState, PersonalGoal } from '../shared/mind';
import './mind.css';

const date = (at: number) => new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const currentGoal = (mind: MindState) => mind.goals.find(goal => goal.status === 'active');

export function MindGlance({ mind, onOpen }: { mind: MindState; onOpen: () => void }) {
  const goal = currentGoal(mind);
  return <section className="mind-glance" aria-label="Milo 此刻的心事" data-testid="mind-glance">
    <div className="mind-glance-mood"><span><Heart size={17} /></span><div><small>此刻的心情</small><strong>{mind.mood.label}</strong></div></div>
    <div className="mind-glance-wish"><small>{goal ? '它还惦记着' : '慢慢积累的新想法'}</small><p>{goal?.title ?? mind.innerVoice.text}</p></div>
    <button onClick={onOpen}>走近 Milo<ArrowRight size={13} /></button>
  </section>;
}

function GoalCard({ goal }: { goal: PersonalGoal }) {
  const counted: Record<string, number> = {};
  return <article className="wish-card" data-testid="personal-wish">
    <div className="mind-section-label"><Leaf size={14} /><span>{goal.source === 'initial' ? '起初的小愿望' : '经历之后，生出的愿望'}</span><small>{goal.completedActions.length}/{goal.actions.length}</small></div>
    <h4>{goal.title}</h4><p>{goal.motivation}</p>
    <ol>{goal.actions.map((id, i) => {
      counted[id] = (counted[id] ?? 0) + 1;
      const done = goal.completedActions.filter(a => a === id).length >= counted[id];
      return <li key={`${id}-${i}`} data-done={done}><span aria-label={done ? '已经历' : '还惦记着'}>{done ? '✓' : '○'}</span>{ACTIONS[id].label}</li>;
    })}</ol>
    <small className="mind-soft-note">这是它的愿望。会结合身体状态和眼前的事，自己决定怎么做。</small>
  </article>;
}

export function MindPanel({ world, connected, onToggleSharing }: { world: WorldState; connected: boolean; onToggleSharing: (value: boolean) => void }) {
  const { mind } = world;
  const goal = currentGoal(mind);
  return <div className="inspector-scroll mind-panel" id="panel-mind" role="tabpanel" aria-labelledby="tab-mind" data-testid="mind-panel">
    <div className="inspector-intro"><div className="eyebrow">A LIFE OF MY OWN</div><h3>日子里，有自己的心事。</h3><p>{mind.personality.description}</p></div>
    <div className="personality-tags">{mind.personality.likes.map(like => <span key={like}>{like}</span>)}</div>
    <blockquote className="inner-voice" data-testid="inner-voice"><Sparkles size={16} /><p>{mind.innerVoice.text}</p><footer>{mind.innerVoice.source === 'initial' ? '最初给自己的期许' : mind.innerVoice.source === 'demo' ? '本地演示随想' : mind.innerVoice.source === 'experience' ? '经历留下的感受' : '刚刚整理的心声'}</footer></blockquote>
    <div className="mind-mood"><Heart size={15} /><div><strong>{mind.mood.label}</strong><p>{mind.mood.reason}</p></div></div>
    {goal && <GoalCard goal={goal} />}
    <div className="sharing-setting"><div><strong>偶尔主动分享</strong><p>关闭后安静生活，仍然会思考和记事。</p></div><button type="button" className="sharing-switch" role="switch" aria-label="偶尔主动分享" aria-checked={mind.settings.proactiveChat} disabled={!connected} onClick={() => onToggleSharing(!mind.settings.proactiveChat)}><span /></button></div>
    <div className="mind-section-label journal-heading"><BookOpen size={14} /><span>它的生活随记</span><small>{mind.journal.length} 页</small></div>
    {!mind.journal.length && <p className="mind-empty">等它亲自经历一些事，再慢慢写下自己的感受。这里不会提前编造一段过去。</p>}
    {[...mind.journal].reverse().map(entry => <article className="journal-entry" key={entry.id} data-testid="journal-entry"><time>{date(entry.at)} · {entry.source === 'demo' ? '本地演示' : '生活反思'}</time><p>{entry.text}</p><details><summary>想起了 {entry.evidence.length} 件事</summary>{entry.evidence.map(e => <p key={e.id}>{e.text}</p>)}</details></article>)}
    {mind.goals.some(g => g.status === 'fulfilled') && <div className="fulfilled-wishes"><div className="mind-section-label"><Leaf size={14} /><span>已经实现的小愿望</span></div>{mind.goals.filter(g => g.status === 'fulfilled').slice(-3).reverse().map(g => <p key={g.id}>✓ {g.title}</p>)}</div>}
    <div className="personal-values"><strong>它的小坚持</strong>{mind.personality.values.map(value => <p key={value}>{value}</p>)}</div>
    <p className="storage-note">性格、随记和愿望进度保存在本机，重启后继续。</p>
  </div>;
}

export function MemoryPanel({ memories, onForget, connected }: { memories: Memory[]; onForget: (memory: Memory) => void; connected: boolean }) {
  return <div className="inspector-scroll" id="panel-memories" role="tabpanel" aria-labelledby="tab-memories">
    <div className="inspector-intro"><div className="eyebrow">LITTLE THINGS, REMEMBERED</div><h3>记得的事，会影响以后。</h3><p>经历留下记录，对话留下偏好。它会在相关的时候想起来，也可能需要你纠正理解。</p></div>
    {!memories.length && <div className="empty-state memory-empty"><Leaf size={29} /><h4>从一件小事开始。</h4><p>让它慢慢生活，或聊聊你的一个小偏好。</p></div>}
    <div className="memory-list">{[...memories].reverse().map(memory => <article key={memory.id} className="memory-card">
      <span className={`memory-type ${memory.source}`}><BookOpen size={13} />{memory.source === 'experience' ? '亲身经历' : '记下的偏好 · 可纠正'}<small>{date(memory.at)}</small></span>
      <p>{memory.text}</p>
      {memory.evidenceText && <details className="memory-evidence"><summary>当时你说</summary><p>{memory.evidenceText}</p></details>}
      {memory.source === 'reflection' && !memory.evidenceText && <small className="mind-soft-note">早期记录，未保留原始对话来源。</small>}
      <button type="button" className="forget-memory" disabled={!connected} onClick={() => onForget(memory)} aria-label="忘记这条记忆"><Trash2 size={11} />忘记</button>
    </article>)}</div>
    <p className="storage-note">遗忘也会移除相关原话与衍生随记，避免再次想起。</p>
  </div>;
}
