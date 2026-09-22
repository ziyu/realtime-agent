const $ = selector => document.querySelector(selector);
let stopped = false;
async function post(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作未完成'); return data;
}
function showError(error) { $('#error').textContent = error.message || '连接已中断'; }
$('#goal-form').addEventListener('submit', event => {
  event.preventDefault(); $('#error').textContent = '';
  void post('/api/goal', Object.fromEntries(new FormData(event.currentTarget))).catch(showError);
});
$('#stop').addEventListener('click', () => { void post('/api/stop').catch(showError); });
$('#reconcile').addEventListener('click', () => { void post('/api/reconcile').catch(showError); });
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  void post('/api/scenario', { kind: button.dataset.scenario }).catch(showError);
}));
const element = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
const statuses = { active: '进行中', completed: '已验证完成', cancelled: '已取消', dispatched: '已发送', running: '执行中', 'cancel-requested': '等待停止确认', unknown: '等待核对', failed: '执行失败' };
async function refresh() {
  if (stopped) return;
  try {
    const response = await fetch('/api/state', { cache: 'no-store' }); if (!response.ok) throw new Error('无法读取当前状态');
    const state = await response.json();
    $('#mode').textContent = state.mode === 'demo' ? '本地规则演示 · 未调用模型' : 'JEV + LLM';
    const current = state.agent.channels.computer.current;
    $('#status').textContent = state.agent.paused ? '已停止' : state.agent.thinking ? '正在整理计划' : current ? statuses[current.status] : state.task ? statuses[state.task.status] : '等待任务';
    $('#status-detail').textContent = state.agent.error?.message || (current ? `${current.call.capability} · ${current.call.target || ''}` : '可继续修改目标。');
    $('#avatar').dataset.expression = state.presentation.expression;
    $('#goal-status').textContent = state.task ? `目标 v${state.task.version} · ${statuses[state.task.status]}` : '尚未创建目标';
    const plan = state.task?.plan;
    $('#steps').replaceChildren(...(plan?.steps || []).map(step => {
      const item = element('li', `${step.call.capability} ${step.call.target || ''}`);
      item.dataset.done = String(plan.completedSteps.includes(step.id)); return item;
    }));
    const receipts = [...state.agent.channels.computer.receipts, ...(current ? [current] : [])].slice(-8).reverse();
    $('#receipts').replaceChildren(...receipts.map(receipt => {
      const row = element('div', `${statuses[receipt.status]} · ${receipt.call.capability} ${receipt.call.target || ''}`);
      row.className = 'receipt'; row.append(element('small', `${receipt.effect} · ${receipt.scope.turnId?.slice(0, 8) || '自主'}`)); return row;
    }));
    const metrics = [ [state.mode === 'demo' ? '本地决策 P95' : 'System One 决策 P95', state.metrics.decision.durationMs.p95], ['排队 P95', state.metrics.decision.queueMs.p95], ['执行 P95', state.metrics.execution.durationMs.p95] ];
    $('#metrics').replaceChildren(...metrics.flatMap(([label, value]) => [element('dt', label), element('dd', value === null ? '暂无样本' : `${Math.round(value)} ms`)]));
    $('#screen').src = `/api/screen?t=${Date.now()}`;
  } catch (error) { showError(error); }
  if (!stopped) setTimeout(refresh, 600);
}
window.addEventListener('pagehide', () => { stopped = true; });
void refresh();
