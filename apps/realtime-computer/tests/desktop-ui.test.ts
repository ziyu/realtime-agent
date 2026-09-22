import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const read = (name: string) => readFile(new URL(name, `file:///${publicDir.replace(/\\/g, '/')}/`), 'utf8');

test('desktop console targets the Windows APIs without retaining the browser-form demo surface', async () => {
  const [html, script] = await Promise.all([read('desktop.html'), read('desktop.js')]);
  for (const endpoint of ['/api/state', '/api/screen', '/api/window', '/api/input', '/api/goal', '/api/stop', '/api/reconcile', '/api/trace']) {
    assert.equal(`${html}\n${script}`.includes(endpoint), true, `missing ${endpoint}`);
  }
  for (const legacy of ['姓名', '分类', '备注', 'data-scenario', '/api/scenario']) assert.equal(`${html}\n${script}`.includes(legacy), false, `legacy demo control remains: ${legacy}`);
  assert.equal(script.includes('page.route'), false);
  assert.equal(script.includes('innerHTML'), false);
});

test('desktop screenshot uses response bounds, blob URLs and single-flight refresh semantics', async () => {
  const script = await read('desktop.js');
  for (const header of ['X-Screen-X', 'X-Screen-Y', 'X-Screen-Width', 'X-Screen-Height', 'Captured-At']) assert.equal(script.includes(header), true, `missing ${header}`);
  assert.match(script, /URL\.createObjectURL\(blob\)/);
  assert.match(script, /URL\.revokeObjectURL/);
  assert.match(script, /screenBounds\.x \+ .*screenBounds\.width/);
  assert.match(script, /screenBounds\.y \+ .*screenBounds\.height/);
  assert.equal(script.includes('setInterval('), false, 'screen refresh must not accumulate interval work');
  assert.match(script, /refreshRunning/);
});

test('manual controls emit only declared DesktopCommand shapes and require a selected window', async () => {
  const script = await read('desktop.js');
  for (const kind of ['focus', 'click', 'type', 'key', 'scroll']) assert.equal(script.includes(`kind: '${kind}'`), true, `missing ${kind} command`);
  assert.match(script, /if \(!selectedWindowId\)/);
  assert.match(script, /windowId: selectedWindowId/);
  assert.match(script, /停止请求已发送；仍需等待当前未决执行回执确认/);
  assert.match(script, /自然语言任务需要模型配置/);
});
