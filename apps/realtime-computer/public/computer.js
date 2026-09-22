const $ = selector => document.querySelector(selector);

const ui = {
  modeCopy: $('#mode-copy'), connection: $('#connection-status'), perception: $('#perception-status'), goalForm: $('#goal-form'), goalText: $('#goal-text'), start: $('#start-goal'), stop: $('#stop'), resume: $('#resume'),
  taskStatus: $('#task-status'), progress: $('#progress-status'), verification: $('#verification-status'), view: $('#view-select'), activeWindow: $('#active-window'), screen: $('#screen'), screenEmpty: $('#screen-empty'),
  captureMeta: $('#capture-meta'), pointerMeta: $('#pointer-meta'), marker: $('#click-marker'), typeForm: $('#type-form'), typeText: $('#type-text'), scrollUp: $('#scroll-up'), scrollDown: $('#scroll-down'),
  manualState: $('#manual-state'), manualHelp: $('#manual-help'), inputFeedback: $('#input-feedback'), history: $('#history'), historyCount: $('#history-count'),
  driverDiagnostics: $('#driver-diagnostics'), observationDiagnostics: $('#observation-diagnostics'), errorBanner: $('#error-banner'), errorText: $('#error-text'), dismissError: $('#dismiss-error'),
};

let latestState = null;
let viewedWindowId = null;
let viewGeneration = 0;
let frameId = null;
let frameWidth = 0;
let frameHeight = 0;
let frameWindowId = null;
let pointer = null;
let objectUrl = null;
let localError = '';
let serverError = '';
let stateRunning = false;
let stateQueued = false;
let stateTimer = null;
let screenRunning = false;
let screenQueued = false;
let screenTimer = null;
let goalBusy = false;
let stopBusy = false;
let resumeBusy = false;
let inputBusy = false;
let viewBusy = false;
let closed = false;

const taskLabels = { active: '任务进行中', completed: '任务已完成', blocked: '任务受阻', cancelled: '任务已停止' };
const settledPhases = new Set(['idle', 'waiting', 'completed', 'cancelled', 'blocked']);

function formatTime(at) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function setPersistentError(error, source = 'local') {
  const message = error instanceof Error ? error.message : String(error || '操作失败');
  if (source === 'server') serverError = message; else localError = message;
  renderError();
}

function renderError() {
  const message = localError || serverError;
  ui.errorBanner.hidden = !message;
  ui.errorText.textContent = message;
}

function dismissError() {
  localError = ''; serverError = ''; renderError();
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(10000), ...options });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
  return data;
}

function post(path, body = {}) {
  return jsonFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function windowsOf(state = latestState) {
  return state?.observation?.windows ?? [];
}

function activeWindow(state = latestState) {
  return windowsOf(state).find(window => window.id === state?.observation?.activeWindowId) ?? null;
}

function taskBusy(state = latestState) {
  const phase = state?.progress?.phase;
  return state?.task?.status === 'active' || Boolean(phase && !settledPhases.has(phase));
}

function nativePending(state = latestState) {
  return state?.agent?.channels?.computer?.current ?? null;
}

function anyRequestBusy() {
  return goalBusy || stopBusy || resumeBusy || inputBusy || Boolean(nativePending());
}

function manualRequestBusy() {
  return goalBusy || stopBusy || resumeBusy || inputBusy || viewBusy || Boolean(nativePending());
}

function visionLabel(state) {
  const vision = state?.modelCapabilities?.vision;
  if (vision === 'enabled') return ['图像 + 可访问性', 'enabled'];
  if (vision === 'unavailable') return ['可访问性（模型未接受图像）', 'unavailable'];
  return ['可访问性', 'off'];
}

function verificationLabel(task) {
  if (task?.verification === 'model-visual') return ['视觉模型判断：基于任务截图判断完成；这不是确定性文件验证。', 'model-visual'];
  if (task?.verification === 'observed-data') return ['已根据结构化观察数据核对结果。', 'observed-data'];
  return ['', ''];
}

function setInputFeedback(text, tone = '') {
  ui.inputFeedback.textContent = text;
  ui.inputFeedback.dataset.tone = tone;
}

function invalidateFrame(message = '正在切换预览…') {
  viewGeneration++;
  frameId = null; frameWidth = 0; frameHeight = 0; frameWindowId = null; pointer = null;
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  ui.screen.removeAttribute('src');
  delete ui.screen.dataset.frameId;
  delete ui.screen.dataset.capturedAt;
  ui.screenEmpty.hidden = false;
  ui.screenEmpty.textContent = message;
  renderPointer();
}

function renderWindows(state) {
  const fragment = document.createDocumentFragment();
  const desktop = document.createElement('option'); desktop.value = ''; desktop.textContent = '整个桌面'; fragment.append(desktop);
  for (const window of windowsOf(state)) {
    const option = document.createElement('option'); option.value = window.id;
    option.textContent = `${window.title || '未命名窗口'} · ${window.appName || `PID ${window.pid}`}`;
    fragment.append(option);
  }
  if (viewedWindowId && !windowsOf(state).some(window => window.id === viewedWindowId)) {
    const preserved = document.createElement('option'); preserved.value = viewedWindowId; preserved.textContent = '当前预览窗口（窗口列表已变化）'; fragment.append(preserved);
  }
  ui.view.replaceChildren(fragment);
  const value = viewedWindowId ?? '';
  ui.view.value = [...ui.view.options].some(option => option.value === value) ? value : '';
}

function renderHistory(state) {
  const history = Array.isArray(state.history) ? state.history.slice(-40).reverse() : [];
  ui.historyCount.textContent = `${history.length} 条`;
  if (!history.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '还没有操作记录。'; ui.history.replaceChildren(empty); return;
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
  const modelReady = Boolean(latestState?.modelReady);
  const textReady = Boolean(ui.goalText.value.trim());
  const active = taskBusy();
  const pending = nativePending();
  ui.start.disabled = !connected || !modelReady || !textReady || anyRequestBusy() || active;
  ui.stop.disabled = !connected || stopBusy || (!active && !pending && !goalBusy && !inputBusy);
  ui.resume.disabled = !connected || !modelReady || resumeBusy || anyRequestBusy() || !latestState?.task || !['blocked', 'cancelled'].includes(latestState.task.status);
  ui.goalText.disabled = !connected || !modelReady || goalBusy || stopBusy || resumeBusy;
  const manualBlocked = !connected || manualRequestBusy();
  ui.typeText.disabled = manualBlocked;
  ui.typeForm.querySelector('button[type="submit"]').disabled = manualBlocked || !ui.typeText.value;
  document.querySelectorAll('[data-keys]').forEach(button => { button.disabled = manualBlocked; });
  const frameReady = connected && Boolean(frameId && frameWidth > 0 && frameHeight > 0 && frameWindowId === (viewedWindowId ?? ''));
  ui.scrollUp.disabled = manualBlocked || !frameReady;
  ui.scrollDown.disabled = manualBlocked || !frameReady;
  ui.view.disabled = viewBusy || inputBusy;
  ui.manualState.textContent = inputBusy ? '正在接管' : pending ? 'native 操作待回执' : connected ? '可随时接管' : '桌面未连接';
  ui.manualState.classList.toggle('busy', inputBusy || Boolean(pending));
}

function renderState(state) {
  latestState = state;
  if (state.error) setPersistentError(state.error, 'server');
  if (!state.connected && (frameId || objectUrl)) invalidateFrame('桌面连接已断开');
  ui.connection.textContent = state.connected ? 'Cua 已连接' : 'Cua 未连接';
  ui.connection.dataset.tone = state.connected ? 'ok' : 'error';
  const [perception, vision] = visionLabel(state);
  ui.perception.textContent = perception;
  ui.perception.dataset.vision = vision;
  ui.modeCopy.textContent = state.mode === 'live' && state.modelReady
    ? 'Cua Driver 已接入真实桌面。Agent 按目标发现应用、切换窗口并核对结果。'
    : '真实桌面已接入 Cua Driver；自然语言任务需要模型配置，手动接管仍可使用。';
  const task = state.task;
  ui.taskStatus.textContent = task ? `${taskLabels[task.status] || task.status} · ${task.text}` : '尚未开始任务';
  ui.progress.dataset.phase = state.progress?.phase || 'idle';
  ui.progress.textContent = state.progress?.message || (task ? `已执行 ${task.steps ?? 0} 步` : '等待任务');
  const [verification, verificationKind] = verificationLabel(task);
  ui.verification.hidden = !verification;
  ui.verification.textContent = verification;
  ui.verification.dataset.kind = verificationKind;
  renderWindows(state);
  const active = activeWindow(state);
  ui.activeWindow.textContent = `当前活动窗口：${active?.title || active?.appName || '—'}`;
  renderHistory(state);
  ui.driverDiagnostics.textContent = JSON.stringify({ backend: state.backend, connected: state.connected, mode: state.mode,
    modelReady: state.modelReady, modelCapabilities: state.modelCapabilities, taskVerification: task?.verification ?? null,
    nativePending: nativePending(state), driver: state.driver, error: state.error ?? null }, null, 2);
  ui.observationDiagnostics.textContent = JSON.stringify(state.observation ?? null, null, 2);
  updateControls();
}

async function refreshState() {
  const state = await jsonFetch('/api/state');
  renderState(state);
}

function scheduleState(delay = 0) {
  if (closed) return;
  stateQueued = true;
  if (stateRunning) return;
  if (stateTimer !== null) clearTimeout(stateTimer);
  stateTimer = setTimeout(() => { stateTimer = null; void stateLoop(); }, delay);
}

async function stateLoop() {
  if (closed || stateRunning) { stateQueued = true; return; }
  stateRunning = true; stateQueued = false;
  try { await refreshState(); }
  catch (error) { setPersistentError(error); }
  finally {
    stateRunning = false;
    if (!closed) { const delay = stateQueued ? 0 : (document.hidden ? 1200 : 320); stateQueued = false; scheduleState(delay); }
  }
}

function scheduleScreen(delay = 0) {
  if (closed) return;
  screenQueued = true;
  if (screenRunning) return;
  if (screenTimer !== null) clearTimeout(screenTimer);
  screenTimer = setTimeout(() => { screenTimer = null; void screenLoop(); }, delay);
}

function preload(url) {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.onload = resolve; image.onerror = () => reject(new Error('桌面截图无法显示。')); image.src = url;
  });
}

async function refreshScreen() {
  if (!latestState?.connected) return;
  const generation = viewGeneration, requestedWindowId = viewedWindowId ?? '';
  try {
    const response = await fetch('/api/screen', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`无法读取桌面截图（HTTP ${response.status}）`);
    const id = response.headers.get('X-Screen-Id');
    const width = Number(response.headers.get('X-Screen-Width'));
    const height = Number(response.headers.get('X-Screen-Height'));
    const responseWindowId = response.headers.get('X-Screen-Window-Id') ?? '';
    const captured = response.headers.get('X-Screen-Captured-At');
    if (!id || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('截图响应缺少有效帧信息。');
    if (responseWindowId !== requestedWindowId) return;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/png')) throw new Error('桌面截图不是 PNG。');
    if (generation !== viewGeneration || requestedWindowId !== (viewedWindowId ?? '')) return;
    const nextUrl = URL.createObjectURL(blob);
    try {
      await preload(nextUrl);
      if (generation !== viewGeneration || requestedWindowId !== (viewedWindowId ?? '')) { URL.revokeObjectURL(nextUrl); return; }
      ui.screen.src = nextUrl;
      const previous = objectUrl; objectUrl = nextUrl; if (previous) URL.revokeObjectURL(previous);
    } catch (error) { URL.revokeObjectURL(nextUrl); throw error; }
    frameId = id; frameWidth = width; frameHeight = height; frameWindowId = responseWindowId;
    ui.screen.dataset.frameId = id;
    ui.screen.dataset.capturedAt = captured ?? '';
    ui.screenEmpty.hidden = true;
    ui.captureMeta.textContent = `${width}×${height} · ${captured ? formatTime(Number(captured)) : '刚刚捕获'}`;
    renderPointer(); updateControls();
  } catch (error) {
    if (generation === viewGeneration) {
      invalidateFrame('桌面画面暂不可用'); updateControls();
    }
    throw error;
  }
}

async function screenLoop() {
  if (closed || screenRunning) { screenQueued = true; return; }
  screenRunning = true; screenQueued = false;
  try { if (!document.hidden) await refreshScreen(); }
  catch (error) { setPersistentError(error); }
  finally {
    screenRunning = false;
    if (!closed) { const delay = screenQueued ? 0 : (document.hidden ? 2200 : 1100); screenQueued = false; scheduleScreen(delay); }
  }
}

function physicalPoint(event) {
  if (!frameId || frameWidth <= 0 || frameHeight <= 0 || frameWindowId !== (viewedWindowId ?? '') || !ui.screen.clientWidth) return null;
  const rect = ui.screen.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null;
  return {
    x: Math.min(frameWidth - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * frameWidth))),
    y: Math.min(frameHeight - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * frameHeight))),
  };
}

function renderPointer() {
  if (!pointer || frameWidth <= 0 || frameHeight <= 0 || !ui.screen.clientWidth) {
    ui.marker.style.display = 'none'; ui.pointerMeta.textContent = '—'; return;
  }
  const rect = ui.screen.getBoundingClientRect();
  ui.marker.style.display = 'block';
  ui.marker.style.left = `${ui.screen.offsetLeft + pointer.x / frameWidth * rect.width}px`;
  ui.marker.style.top = `${ui.screen.offsetTop + pointer.y / frameHeight * rect.height}px`;
  ui.pointerMeta.textContent = `像素 ${pointer.x}, ${pointer.y}`;
}

async function sendInput(payload, label) {
  if (!latestState?.connected || manualRequestBusy()) return;
  inputBusy = true; updateControls();
  setInputFeedback(`${label}已提交；手动输入将接管当前自动任务。`, 'pending');
  try {
    await post('/api/input', payload);
    setInputFeedback(`${label}已发送，等待统一执行回执确认。`, 'pending');
    scheduleState(0); scheduleScreen(120);
  } catch (error) { setPersistentError(error); setInputFeedback(error.message || `${label}失败。`, 'error'); }
  finally { inputBusy = false; updateControls(); }
}

ui.goalText.addEventListener('input', updateControls);
ui.typeText.addEventListener('input', updateControls);
ui.dismissError.addEventListener('click', dismissError);

ui.goalForm.addEventListener('submit', async event => {
  event.preventDefault();
  const text = ui.goalText.value.trim(); if (!text || ui.start.disabled) return;
  goalBusy = true; updateControls();
  try { await post('/api/goal', { text }); scheduleState(0); scheduleScreen(100); }
  catch (error) { setPersistentError(error); }
  finally { goalBusy = false; updateControls(); }
});

ui.stop.addEventListener('click', async () => {
  if (ui.stop.disabled) return;
  stopBusy = true; updateControls();
  try { await post('/api/stop'); setInputFeedback('停止请求已发送；最终状态以执行回执为准。', 'pending'); scheduleState(0); }
  catch (error) { setPersistentError(error); }
  finally { stopBusy = false; updateControls(); }
});

ui.resume.addEventListener('click', async () => {
  if (ui.resume.disabled) return;
  resumeBusy = true; updateControls();
  try { await post('/api/resume'); scheduleState(0); scheduleScreen(100); }
  catch (error) { setPersistentError(error); }
  finally { resumeBusy = false; updateControls(); }
});

ui.view.addEventListener('change', async () => {
  const previous = viewedWindowId;
  const next = ui.view.value || null;
  viewBusy = true; viewedWindowId = next; invalidateFrame(); updateControls();
  try { await post('/api/view', { windowId: next }); scheduleState(0); scheduleScreen(0); }
  catch (error) {
    setPersistentError(error); viewedWindowId = previous; invalidateFrame('预览切换失败，正在恢复…');
    if (latestState) renderWindows(latestState); scheduleScreen(0);
  }
  finally { viewBusy = false; updateControls(); }
});

ui.screen.addEventListener('pointermove', event => {
  const point = physicalPoint(event); if (point) ui.pointerMeta.textContent = `像素 ${point.x}, ${point.y}`;
});

ui.screen.addEventListener('click', event => {
  const point = physicalPoint(event); if (!point || manualRequestBusy()) return;
  pointer = point; renderPointer();
  void sendInput({ kind: 'click', x: point.x, y: point.y, frameId }, '点击');
});

ui.typeForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = ui.typeText.value; if (!text) return;
  void sendInput({ kind: 'type', text }, '文本输入');
});

document.querySelectorAll('[data-keys]').forEach(button => button.addEventListener('click', () => {
  const keys = button.dataset.keys.split(',');
  void sendInput({ kind: 'key', keys }, `按键 ${keys.join(' + ')}`);
}));

function scrollPoint() {
  if (pointer) return pointer;
  if (!frameId || frameWidth <= 0 || frameHeight <= 0) return null;
  return { x: Math.floor((frameWidth - 1) / 2), y: Math.floor((frameHeight - 1) / 2) };
}

for (const [button, delta] of [[ui.scrollUp, 720], [ui.scrollDown, -720]]) button.addEventListener('click', () => {
  const point = scrollPoint(); if (!point) return;
  void sendInput({ kind: 'scroll', x: point.x, y: point.y, delta, frameId }, delta > 0 ? '向上滚动' : '向下滚动');
});

window.addEventListener('resize', renderPointer);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { scheduleState(0); scheduleScreen(0); } });
window.addEventListener('pagehide', () => {
  closed = true;
  if (stateTimer !== null) clearTimeout(stateTimer);
  if (screenTimer !== null) clearTimeout(screenTimer);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null; frameId = null;
});

updateControls();
scheduleState(0);
scheduleScreen(0);
