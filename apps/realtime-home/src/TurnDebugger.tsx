import { useState } from 'react';
import type { ActionReceipt } from '@realtime-agent/agent';
import type { Decision, OutputStatus, Reflection, Trace, WorldState } from '../shared/types';
import { ACTIONS, isAction, TARGETS } from '../shared/world';
import './debug.css';

const outputs: Record<OutputStatus, string> = {
  'waiting-review': '等待采纳', 'waiting-decision': '等待决策', 'waiting-observation': '等待观察', authorized: '已授权回复', generating: '正在生成回复',
  approved: '已通过校验', playing: '正在播放', delivered: '已交付', blocked: '输出受阻', cancelled: '已取消', silent: '未安排回复',
};
const stages: [NonNullable<Trace['stage']>, string][] = [['input', '输入'], ['decision', '决策'], ['action', '行动'], ['observation', '观察'], ['thought', '思考提议'], ['output', '输出']];
const executionStatus: Record<ActionReceipt['status'], string> = { running: '执行中', held: '等待重新决策', completed: '已完成', cancelled: '已取消', failed: '执行失败' };
const choice = (decision: Decision) => `${isAction(decision.action) ? ACTIONS[decision.action].label : { inspect: '查看', approach: '走向', idle: '等待', continue: '继续' }[decision.action]}${decision.target ? ` · ${TARGETS[decision.target].object}` : ''}`;

export function TurnDebugger({ world, connected }: { world: WorldState; connected: boolean }) {
  const [selected, setSelected] = useState('latest');
  const turn = selected === 'latest' ? world.turns.at(-1) : world.turns.find(t => t.id === selected);
  const traces = turn ? world.traces.filter(t => t.turnId === turn.id) : [];
  const receipts = turn ? [...(world.executions ?? []), ...(world.execution ? [world.execution] : [])].filter(r => r.scope.turnId === turn.id) : [];
  const execution = receipts.at(-1);
  const speechReceipts = turn ? [...(world.speechExecutions ?? []), ...(world.speechExecution ? [world.speechExecution] : [])].filter(r => r.scope.turnId === turn.id) : [];
  const thought = traces.findLast(t => t.title === '慢思考建议已返回');
  const proposed = traces.findLast(t => t.kind === 'decision' && t.source)?.data as Decision | undefined;
  const applied = traces.findLast(t => t.title === '控制器已采纳决策' || t.title === '控制器未采纳切换');
  const observation = traces.findLast(t => t.stage === 'observation');
  const observedText = (observation?.data as { result?: { observation?: { text?: string } } } | undefined)?.result?.observation?.text;
  const replies = turn ? world.messages.filter(m => m.turnId === turn.id && m.role === 'agent') : [];
  const missingReply = execution?.status === 'completed' && execution.call.capability === 'inspect' && !turn?.replyAt && !world.thinking && !speechReceipts.length;
  const diagnosis = !connected ? '连接中断 · 显示最后记录' : !turn ? selected === 'latest' ? '发送一句话，观察它如何执行' : '这轮记录已清理'
    : turn.error ? turn.error : missingReply ? '观察已就绪，等待思考提议与 speak 决策' : turn.output ? outputs[turn.output.status] : '尚未记录输出状态';
  function download() {
    if (!turn) return;
    const blob = new Blob([JSON.stringify({ epoch: world.epoch, turn, traces, receipts, speechReceipts, messages: world.messages.filter(m => m.turnId === turn.id),
      history: '仅保留最近 32 轮和 200 条事件；旧事件可能已清理。时间为服务端时间。' }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `milo-turn-${turn.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <details className="turn-debugger" open data-testid="turn-debugger">
    <summary><strong>闭环调试</strong><span>{diagnosis}</span></summary>
    <div className="debug-body">
      <div className="debug-toolbar"><label>调试轮次<select value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="latest">跟随最新输入</option>
        {[...world.turns].reverse().map(t => <option key={t.id} value={t.id}>{new Date(t.receivedAt).toLocaleTimeString('zh-CN')} · {t.text.slice(0, 42)}</option>)}
      </select></label><button type="button" onClick={download} disabled={!turn}>导出这一轮</button></div>
      {turn && <>
        <p className="debug-input">“{turn.text}”<small>{turn.source === 'voice' ? '语音最终转写' : turn.source === 'object' ? '物体操作' : '文字输入'} · {turn.id.slice(0, 8)}{turn.supersededAt ? ' · 已被后续输入替代' : ''}</small></p>
        <ol className="debug-stages" aria-label="输入到输出的六个阶段">
          {stages.map(([stage, name], i) => <li key={stage} data-recorded={traces.some(t => t.stage === stage)}>
            <span>{String(i + 1).padStart(2, '0')} / {name}</span>
            <strong>{stage === 'input' ? '已接收' : stage === 'decision' ? proposed ? choice(proposed) : turn.decisionStartedAt ? '等待模型返回' : '尚未请求'
              : stage === 'action' ? execution ? executionStatus[execution.status] : turn.appliedAction === 'idle' ? '原地等待' : '无执行回执'
              : stage === 'thought' ? thought ? '已有回复提议' : '尚无回复提议' : stage === 'observation' ? observation?.title ?? '未绑定观察任务' : turn.output ? outputs[turn.output.status] : '未记录'}</strong>
          </li>)}
        </ol>
        <dl className="debug-facts">
          <div><dt>模型提议</dt><dd>{proposed ? `${choice(proposed)}；说话选择 ${proposed.speech ?? '未指定'}` : '尚无有效模型结果'}</dd></div>
          <div><dt>控制器处理</dt><dd>{applied ? `${applied.title}。${applied.detail}` : '尚无采纳记录'}</dd></div>
          <div><dt>实际执行</dt><dd>{execution ? <>{execution.call.capability} → {execution.call.target} · {executionStatus[execution.status]}{execution.status === 'running' || execution.status === 'held' ? ` · ${execution.phase === 'walking' ? '行走' : '交互'} ${Math.round(execution.progress * 100)}%` : ''} · {(execution.elapsedSeconds).toFixed(1)} 秒<small>执行 ID：{execution.id}</small></> : '这一轮没有保留的执行回执'}</dd></div>
          <div><dt>观察证据</dt><dd>{observedText ?? observation?.detail ?? '尚无观察证据。观察完成只提交事实，由下一次决策决定是否思考和说话。'}</dd></div>
          <div><dt>回复提议</dt><dd>{(thought?.data as Reflection | undefined)?.reply || '尚无拟定措辞'}</dd></div>
          <div><dt>说话执行</dt><dd>{speechReceipts.length ? speechReceipts.map(r => <div key={r.id}>speak · {executionStatus[r.status]} · {r.phase}<small>执行 ID：{r.id} · 提议：{r.call.target}</small></div>) : '没有获准的 speak 执行'}</dd></div>
          <div><dt>回复状态</dt><dd>{missingReply ? '观察完成后尚未执行 speak。查看 think、提议采纳和说话选择。' : turn.output?.detail ?? '尚未记录'}{turn.output?.permitId && <small>许可 ID：{turn.output.permitId}</small>}</dd></div>
        </dl>
        {!!replies.length && <p className="debug-reply">{replies.map(m => m.text).join('\n')}</p>}
        <details className="debug-events"><summary>查看这轮的 {traces.length} 条事件与结构化数据</summary>
          <p className="debug-note">观察来自虚拟场景状态。仅展示输入、决策字段、执行回执与观察事实。最近 32 轮 / 200 条事件；旧事件可能已清理。相对时间从服务端收到输入开始，含行走与语音等待。</p>
          {!traces.some(t => t.stage === 'input') && <p role="status">本轮早期事件已不在保留范围内，无法完整回放。</p>}
          <ol>{traces.map(t => <li key={t.id}><time>+{Math.max(0, t.at - turn.receivedAt)} ms</time><div><strong>{t.title}</strong><p>{t.detail}</p>
            {t.data !== undefined && <details><summary>结构化数据</summary><pre>{JSON.stringify(t.data, null, 2)}</pre></details>}
          </div></li>)}</ol>
        </details>
      </>}
    </div>
  </details>;
}
