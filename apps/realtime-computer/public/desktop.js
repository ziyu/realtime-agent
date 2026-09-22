const $ = selector => document.querySelector(selector);

const ui = {
  modeCopy: $('#mode-copy'), connection: $('#connection-status'), goalForm: $('#goal-form'), goalText: $('#goal-text'), goalHelp: $('#goal-help'),
  startGoal: $('#start-goal'), stop: $('#stop'), taskStatus: $('#task-status'), windowSelect: $('#window-select'), focusWindow: $('#focus-window'),
  foreground: $('#foreground-label'), screen: $('#screen'), screenEmpty: $('#screen-empty'), screenStage: $('#screen-stage'), screenHint: $('#screen-hint'),
  capture: $('#capture-label'), pointerLabel: $('#pointer-label'), pointerMarker: $('#pointer-marker'), manualBadge: $('#manual-badge'),
  typeForm: $('#type-form'), typeText: $('#type-text'), scrollUp: $('#scroll-up'), scrollDown: $('#scroll-down'), reconcile: $('#reconcile'),
  feedback: $('#command-feedback'), history: $('#history'), historyCount: $('#history-count'), observation: $('#diagnostic-observation'),
  agent: $('#diagnostic-agent'), error: $('#error'),
  startHint: $('#start-hint'), progress: $('#task-progress'),
};

let latestState = null;
let lastReceiptId = null;
let selectedWindowId = null;
let screenBounds = null;
let screenFrameId = null;
let screenWindowId = null;
let pointerPhysical = null;
let clickMode = 'left';
let objectUrl = null;
let stopped = false;
let refreshRunning = false;
let refreshQueued = false;
let refreshTimer = null;
let commandBusy = false;
let windowSelectionBusy = false;
let selectionGeneration = 0;
let goalSubmitting = false;
let stopping = false;
let submissionError = '';
let stateSequence = 0;
let screenPending = null;
let nextScreenAt = 0;
let minimumFrameTime = 0;
let displayedFrameTime = 0;

const statuses = {
  idle: '等待任务', active: '任务进行中', running: '执行中', completed: '已完成', failed: '执行失败', cancelled: '已取消',
  dispatched: '已发送，等待结果', 'cancel-requested': '已请求停止，等待确认', unknown: '结果未确认', stopped: '已停止', 'needs-review': '等待核对',
};
const phases = { idle: '等待任务', queued: '任务已接收', deciding: '正在决策', planning: '正在规划',
  reviewing: '正在检查计划', executing: '正在操作', verifying: '正在核对', blocked: '需要处理', completed: '已完成', cancelled: '已停止' };

function showError(error) {
  ui.error.hidden = false;
  ui.error.textContent = error instanceof Error ? error.message : String(error || '连接已中断');
}

function clearError() {
  ui.error.hidden = true;
  ui.error.textContent = '';
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(10000), ...options });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
  return data;
}

async function post(path, body = {}) {
  return jsonFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function formatTime(at) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function setFeedback(text, tone = '') {
  ui.feedback.textContent = text;
  ui.feedback.dataset.tone = tone;
}

function currentWindow() {
  return latestState?.observation?.windows?.find(window => window.id === selectedWindowId) ?? null;
}

function pendingInput(state = latestState) {
  return state?.agent?.channels?.computer?.current ?? null;
}

function executionBusy() {
  return commandBusy || Boolean(pendingInput());
}

function invalidateScreen(message = '正在切换截图范围…') {
  selectionGeneration++;
  screenBounds = null;
  screenFrameId = null;
  screenWindowId = null;
  displayedFrameTime = 0;
  pointerPhysical = null;
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  ui.screen.removeAttribute('src');
  ui.screenEmpty.hidden = false;
  ui.screenEmpty.textContent = message;
  renderPointer();
}

function renderWindows(state) {
  const windows = state.observation?.windows ?? [];
  const previous = ui.windowSelect.value;
  const previousLabel = ui.windowSelect.selectedOptions[0]?.textContent ?? '';
  const fragment = document.createDocumentFragment();
  const desktop = document.createElement('option'); desktop.value = ''; desktop.textContent = '整个桌面'; fragment.append(desktop);
  for (const window of windows) {
    const option = document.createElement('option');
    option.value = window.id;
    option.textContent = `${window.title || '未命名窗口'} · ${window.processName || `PID ${window.processId}`}`;
    fragment.append(option);
  }
  const preserveLocal = windowSelectionBusy || commandBusy || goalSubmitting || Boolean(pendingInput(state));
  if (preserveLocal && previous && !windows.some(window => window.id === previous)) {
    const preserved = document.createElement('option'); preserved.value = previous; preserved.textContent = previousLabel || '当前选择窗口'; fragment.append(preserved);
  }
  ui.windowSelect.replaceChildren(fragment);
  const value = preserveLocal ? previous : (state.selectedWindowId ?? '');
  ui.windowSelect.value = [...ui.windowSelect.options].some(option => option.value === value) ? value : '';
  const nextSelected = ui.windowSelect.value || null;
  if (selectedWindowId !== nextSelected) invalidateScreen();
  selectedWindowId = nextSelected;
}

function renderHistory(state) {
  const history = Array.isArray(state.history) ? state.history.slice(-30).reverse() : [];
  ui.historyCount.textContent = `${history.length} 条`;
  if (!history.length) {
    const empty = document.createElement('p'); empty.className = 'empty-copy'; empty.textContent = '还没有执行记录。';
    ui.history.replaceChildren(empty); return;
  }
  ui.history.replaceChildren(...history.map(entry => {
    const row = document.createElement('div'); row.className = 'history-row';
    const type = document.createElement('span'); type.className = 'history-type'; type.textContent = entry.type || 'event';
    const detail = document.createElement('span'); detail.className = 'history-detail'; detail.textContent = entry.detail || '—';
    const time = document.createElement('time'); time.className = 'history-time'; time.textContent = formatTime(entry.at);
    row.append(type, detail, time); return row;
  }));
}

function updateControls() {
  const connected = Boolean(latestState?.connected);
  const hasWindow = connected && Boolean(selectedWindowId && currentWindow());
  const modelReady = Boolean(latestState?.modelReady);
  const liveModel = latestState?.mode === 'live' && modelReady;
  const busy = executionBusy();
  const frameReady = hasWindow && Boolean(screenFrameId && screenWindowId === selectedWindowId && screenBounds) && displayedFrameTime >= minimumFrameTime;
  const task = latestState?.task;
  const activeTask = Boolean(task && !['completed', 'failed', 'cancelled'].includes(task.status));
  const reason = !connected ? '桌面尚未连接，请检查本地服务。' : !liveModel ? '自动任务需要模型配置；当前可手动操作。'
    : !hasWindow ? '请先在“观察范围”选择要操作的应用窗口；“整个桌面”目前仅供查看。'
    : windowSelectionBusy ? '正在切换操作窗口…' : goalSubmitting ? '任务正在提交…'
    : stopping ? '正在停止上一项任务…' : busy ? '上一项输入仍在执行或核对，请稍候。'
    : !ui.goalText.value.trim() ? '描述你要在所选窗口完成的任务。' : '';
  ui.startGoal.disabled = Boolean(reason);
  ui.startGoal.title = reason;
  ui.startHint.textContent = reason || `操作范围：${currentWindow()?.title || currentWindow()?.processName || '所选窗口'}。`;
  ui.startGoal.textContent = goalSubmitting ? '提交中…' : activeTask ? '更新任务' : '开始任务';
  ui.goalText.disabled = !connected || !liveModel;
  ui.stop.disabled = stopping || (!activeTask && !pendingInput() && !goalSubmitting);
  ui.focusWindow.disabled = busy || !hasWindow;
  ui.typeText.disabled = busy || !hasWindow;
  ui.typeForm.querySelector('button[type="submit"]').disabled = busy || !hasWindow || !ui.typeText.value;
  ui.scrollUp.disabled = busy || !frameReady;
  ui.scrollDown.disabled = busy || !frameReady;
  ui.reconcile.disabled = commandBusy || !connected;
  document.querySelectorAll('[data-keys]').forEach(button => { button.disabled = busy || !hasWindow; });
  document.querySelectorAll('[data-click-mode]').forEach(button => { button.disabled = busy || !frameReady; });
  ui.windowSelect.disabled = windowSelectionBusy || busy || goalSubmitting;
  ui.manualBadge.textContent = busy ? '等待执行回执' : hasWindow ? '窗口已选择' : '需选择窗口';
  ui.manualBadge.classList.toggle('ready', hasWindow && !busy);
  ui.screenHint.textContent = hasWindow
    ? '点击画面会按截图响应的物理桌面边界换算坐标，并发送到当前选择窗口。'
    : '当前显示真实桌面。选择一个窗口后，才会启用焦点、点击、输入、按键和滚轮操作。';
}

function renderState(state) {
  latestState = state;
  const connected = Boolean(state.connected);
  ui.connection.textContent = connected ? 'Windows 已连接' : 'Windows 未连接';
  ui.connection.dataset.tone = connected ? 'ok' : 'error';
  const manual = state.mode !== 'live' || !state.modelReady;
  ui.modeCopy.textContent = manual
    ? '真实桌面 · 手动控制。自然语言任务需要配置 System One / 语言模型。'
    : '真实桌面 · Agent 可执行自然语言任务，也可随时手动接管。';
  ui.goalHelp.textContent = manual
    ? (state.modelError ? `自然语言任务暂不可用：${state.modelError}` : '自然语言任务需要模型配置；当前仍可直接操作真实 Windows 桌面。')
    : '自然语言目标会经过 Agent 决策；实际鼠标和键盘输入都由 Windows 驱动执行并留下回执。';
  ui.goalText.placeholder = manual ? '配置模型后可在这里输入自然语言任务' : '例如：在所选记事本窗口中写下今天的待办';
  const task = state.task;
  ui.taskStatus.textContent = task ? `${statuses[task.status] || task.status} · ${task.text}` : (manual ? '真实桌面 · 手动控制' : '尚未开始任务');
  if (submissionError) {
    ui.progress.dataset.phase = 'blocked'; ui.progress.textContent = `任务未提交成功：${submissionError}`;
  } else if (!goalSubmitting) {
    const progress = state.progress;
    ui.progress.dataset.phase = progress?.phase || 'idle';
    ui.progress.textContent = progress ? `${phases[progress.phase] || progress.phase}：${progress.message}` : state.agent?.thinking ? '正在规划…' : '尚未开始任务。';
  }
  renderWindows(state);
  const foreground = state.observation?.windows?.find(window => window.id === state.observation?.foregroundWindowId);
  ui.foreground.textContent = `前台窗口：${foreground?.title || foreground?.processName || '—'}`;
  renderHistory(state);
  const receipt = state.agent?.channels?.computer?.receipts?.at(-1);
  if (receipt && receipt.id !== lastReceiptId) {
    lastReceiptId = receipt.id;
    minimumFrameTime = Math.max(minimumFrameTime, receipt.updatedAt || 0);
    nextScreenAt = 0;
    setFeedback(receipt.status === 'completed' ? '系统输入已送达，已重新读取窗口状态。'
      : receipt.status === 'cancelled' ? '输入已停止，请以当前窗口内容为准。' : '输入未确认成功，请核对当前窗口。',
    receipt.status === 'failed' ? 'error' : '');
  }
  ui.observation.textContent = JSON.stringify({
    backend: state.backend, connected: state.connected, selectedWindowId: state.selectedWindowId,
    observationId: state.observation?.id, capturedAt: state.observation?.capturedAt, desktop: state.observation?.desktop,
    foregroundWindowId: state.observation?.foregroundWindowId, windows: state.observation?.windows?.length ?? 0,
    elements: state.observation?.elements?.length ?? 0, accessibilityError: state.observation?.accessibilityError ?? null,
  }, null, 2);
  ui.agent.textContent = JSON.stringify({ mode: state.mode, modelReady: state.modelReady, modelError: state.modelError ?? null,
    task: state.task, agent: state.agent, metrics: state.metrics, error: state.error ?? null }, null, 2);
  if (state.error) showError(typeof state.error === 'string' ? state.error : state.error.message || JSON.stringify(state.error));
  updateControls();
}

async function refreshState() {
  const sequence = ++stateSequence;
  const state = await jsonFetch('/api/state');
  if (!stopped && sequence === stateSequence) renderState(state);
}

function readScreenBounds(response) {
  const number = name => Number(response.headers.get(name));
  const bounds = { x: number('X-Screen-X'), y: number('X-Screen-Y'), width: number('X-Screen-Width'), height: number('X-Screen-Height') };
  if (!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error('截图缺少有效的物理桌面边界。');
  return bounds;
}

async function preloadScreen(nextUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('桌面截图无法显示。'));
    image.src = nextUrl;
  });
}

async function refreshScreen() {
  if (!latestState?.connected) return;
  const generation = selectionGeneration, requestedWindowId = selectedWindowId ?? '';
  try {
    const response = await fetch('/api/screen', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`无法读取桌面截图（HTTP ${response.status}）`);
    const responseWindowId = response.headers.get('X-Screen-Window-Id');
    const frameId = response.headers.get('X-Screen-Id');
    if (responseWindowId === null || responseWindowId !== requestedWindowId) throw new Error('截图窗口已变化，正在重新读取。');
    if (!frameId) throw new Error('截图缺少帧标识。');
    const bounds = readScreenBounds(response);
    const capturedHeader = response.headers.get('X-Screen-Captured-At');
    const capturedAt = capturedHeader === null ? Number.NaN : Number(capturedHeader);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/png')) throw new Error('桌面截图不是 PNG。');
    if (Number.isFinite(capturedAt) && capturedAt < minimumFrameTime) return;
    if (generation !== selectionGeneration || requestedWindowId !== (selectedWindowId ?? '')) return;
    const nextUrl = URL.createObjectURL(blob);
    try {
      await preloadScreen(nextUrl);
      if (generation !== selectionGeneration || requestedWindowId !== (selectedWindowId ?? '')) { URL.revokeObjectURL(nextUrl); return; }
      if (Number.isFinite(capturedAt) && capturedAt < minimumFrameTime) { URL.revokeObjectURL(nextUrl); return; }
      ui.screen.src = nextUrl;
      ui.screen.dataset.capturedAt = String(capturedAt);
      ui.screen.dataset.frameId = frameId;
      const previous = objectUrl; objectUrl = nextUrl; if (previous) URL.revokeObjectURL(previous);
    } catch (error) {
      URL.revokeObjectURL(nextUrl); throw error;
    }
    screenBounds = bounds;
    screenFrameId = frameId;
    screenWindowId = responseWindowId || null;
    displayedFrameTime = Number.isFinite(capturedAt) ? capturedAt : 0;
    ui.screenEmpty.hidden = true;
    ui.capture.textContent = `${bounds.width}×${bounds.height} · ${Number.isFinite(capturedAt) ? formatTime(capturedAt) : '刚刚捕获'}`;
    renderPointer(); updateControls();
  } catch (error) {
    if (generation === selectionGeneration) {
      screenBounds = null; screenFrameId = null; screenWindowId = null; pointerPhysical = null;
      ui.screenEmpty.hidden = false; ui.screenEmpty.textContent = '桌面画面暂不可用'; renderPointer();
    }
    throw error;
  }
}

function scheduleRefresh(delay = 0) {
  if (stopped) return;
  refreshQueued = true;
  if (refreshRunning) return;
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = null; void refreshLoop(); }, delay);
}

async function refreshLoop() {
  if (stopped) return;
  if (refreshRunning) { refreshQueued = true; return; }
  if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null; }
  refreshRunning = true;
  refreshQueued = false;
  try {
    await refreshState();
    // Screenshot encoding and native capture must not delay task status, errors or Stop.
    if (!document.hidden && !screenPending && Date.now() >= nextScreenAt) {
      screenPending = refreshScreen().catch(error => {
        ui.capture.textContent = error.message || '截图暂不可用';
      }).finally(() => { screenPending = null; nextScreenAt = Date.now() + 650; });
    }
  } catch (error) { showError(error); }
  finally {
    refreshRunning = false;
    if (stopped) return;
    const delay = refreshQueued ? 0 : (document.hidden ? 1800 : 300); refreshQueued = false;
    scheduleRefresh(delay);
  }
}

function toPhysical(event) {
  if (!screenBounds || !screenFrameId || screenWindowId !== selectedWindowId || displayedFrameTime < minimumFrameTime || !ui.screen.naturalWidth || !ui.screen.clientWidth) return null;
  const rect = ui.screen.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null;
  const localX = Math.min(screenBounds.width - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * screenBounds.width)));
  const localY = Math.min(screenBounds.height - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * screenBounds.height)));
  return {
    x: screenBounds.x + localX,
    y: screenBounds.y + localY,
  };
}

function renderPointer() {
  if (!pointerPhysical || !screenBounds || !ui.screen.clientWidth) { ui.pointerMarker.style.display = 'none'; ui.pointerLabel.textContent = '未选择操作位置'; return; }
  const rect = ui.screen.getBoundingClientRect();
  const left = (pointerPhysical.x - screenBounds.x) / screenBounds.width * rect.width;
  const top = (pointerPhysical.y - screenBounds.y) / screenBounds.height * rect.height;
  ui.pointerMarker.style.display = 'block';
  ui.pointerMarker.style.left = `${ui.screen.offsetLeft + left}px`;
  ui.pointerMarker.style.top = `${ui.screen.offsetTop + top}px`;
  ui.pointerLabel.textContent = `物理坐标 ${pointerPhysical.x}, ${pointerPhysical.y}`;
}

async function sendCommand(command, label, frameId = null) {
  if (!selectedWindowId) { setFeedback('先选择一个窗口，再发送真实输入。', 'error'); return; }
  commandBusy = true; updateControls(); clearError();
  setFeedback(`${label}已提交，等待 Windows 执行回执确认。`, 'pending');
  try {
    await post('/api/input', frameId ? { command, frameId } : { command });
    await refreshState();
    if (pendingInput()) setFeedback(`${label}已交给执行器，正在等待实际回执。`, 'pending');
    scheduleRefresh(0);
  } catch (error) { setFeedback(error.message || `${label}未完成。`, 'error'); showError(error); }
  finally { commandBusy = false; updateControls(); }
}

ui.goalText.addEventListener('input', updateControls);
ui.typeText.addEventListener('input', updateControls);

ui.goalForm.addEventListener('submit', async event => {
  event.preventDefault();
  const text = ui.goalText.value.trim();
  if (!text || ui.startGoal.disabled || goalSubmitting) return;
  goalSubmitting = true; submissionError = ''; updateControls(); clearError();
  ui.progress.dataset.phase = 'queued'; ui.progress.textContent = '正在提交任务…';
  try { await post('/api/goal', { text }); goalSubmitting = false; await refreshState(); scheduleRefresh(0); }
  catch (error) {
    submissionError = error.message;
    ui.progress.dataset.phase = 'blocked'; ui.progress.textContent = `任务未提交成功：${submissionError}`;
    showError(error);
  } finally { goalSubmitting = false; updateControls(); }
});

ui.stop.addEventListener('click', async () => {
  if (stopping) return;
  stopping = true; clearError(); updateControls(); setFeedback('停止请求已发送；仍需等待当前未决执行回执确认。', 'pending');
  try { await post('/api/stop'); await refreshState(); scheduleRefresh(0); }
  catch (error) { showError(error); }
  finally { stopping = false; updateControls(); }
});

ui.reconcile.addEventListener('click', async () => {
  commandBusy = true; updateControls(); clearError(); setFeedback('正在核对未决执行结果…', 'pending');
  try {
    const result = await post('/api/reconcile');
    setFeedback(result?.requested === false ? '当前没有需要核对的未决执行。' : '已请求核对；最终结果以新的执行回执为准。', 'pending');
    scheduleRefresh(0);
  } catch (error) { setFeedback(error.message || '核对未完成。', 'error'); showError(error); }
  finally { commandBusy = false; updateControls(); }
});

ui.windowSelect.addEventListener('change', async () => {
  const next = ui.windowSelect.value || null;
  windowSelectionBusy = true;
  selectedWindowId = next;
  invalidateScreen();
  updateControls(); clearError();
  try { await post('/api/window', { windowId: next }); scheduleRefresh(0); }
  catch (error) { showError(error); windowSelectionBusy = false; if (latestState) renderWindows(latestState); }
  finally { windowSelectionBusy = false; updateControls(); }
});

ui.focusWindow.addEventListener('click', () => {
  if (selectedWindowId) void sendCommand({ kind: 'focus', windowId: selectedWindowId }, '聚焦命令');
});

document.querySelectorAll('[data-click-mode]').forEach(button => button.addEventListener('click', () => {
  clickMode = button.dataset.clickMode;
  document.querySelectorAll('[data-click-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
}));

ui.screen.addEventListener('pointermove', event => {
  const point = toPhysical(event); if (!point) return;
  ui.pointerLabel.textContent = `物理坐标 ${point.x}, ${point.y}`;
});

ui.screen.addEventListener('click', event => {
  if (!selectedWindowId || executionBusy()) return;
  const point = toPhysical(event); if (!point) return;
  pointerPhysical = { x: point.x, y: point.y }; renderPointer();
  const button = clickMode === 'right' ? 'right' : 'left';
  const clicks = clickMode === 'double' ? 2 : 1;
  void sendCommand({ kind: 'click', windowId: selectedWindowId, x: point.x, y: point.y, button, clicks }, clickMode === 'double' ? '双击' : button === 'right' ? '右键' : '点击', screenFrameId);
});

function scrollPoint() {
  if (pointerPhysical) return pointerPhysical;
  if (!screenBounds || !screenFrameId || screenWindowId !== selectedWindowId) return null;
  return { x: screenBounds.x + Math.floor((screenBounds.width - 1) / 2), y: screenBounds.y + Math.floor((screenBounds.height - 1) / 2) };
}

for (const [button, delta] of [[ui.scrollUp, 720], [ui.scrollDown, -720]]) button.addEventListener('click', () => {
  const point = scrollPoint();
  if (selectedWindowId && point) void sendCommand({ kind: 'scroll', windowId: selectedWindowId, x: point.x, y: point.y, delta }, delta > 0 ? '向上滚动' : '向下滚动', screenFrameId);
});

ui.typeForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = ui.typeText.value; if (!selectedWindowId || !text) return;
  void sendCommand({ kind: 'type', windowId: selectedWindowId, text }, '文本输入');
});

document.querySelectorAll('[data-keys]').forEach(button => button.addEventListener('click', () => {
  if (!selectedWindowId) return;
  const keys = button.dataset.keys.split(',');
  void sendCommand({ kind: 'key', windowId: selectedWindowId, keys }, `按键 ${keys.join(' + ')}`);
}));

window.addEventListener('resize', renderPointer);
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(0); });
window.addEventListener('pagehide', () => {
  stopped = true;
  if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null; }
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  screenFrameId = null; screenWindowId = null; screenBounds = null;
});

updateControls();
scheduleRefresh(0);
