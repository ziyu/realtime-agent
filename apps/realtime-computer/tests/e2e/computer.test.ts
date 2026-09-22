import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startComputerServer } from '../../server/app.js';
import { demoProviders } from '../../server/providers.js';
import type { DecisionContext } from '@realtime-agent/agent';

async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 15000): Promise<void> {
  const start = performance.now();
  while (!await check()) { if (performance.now() - start > timeout) throw new Error(message); await delay(30); }
}
async function statusWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { Host: host } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode ?? 0));
    });
    req.once('error', reject); req.end();
  });
}

test('one real browser exercises the shared Agent across dynamic form tasks', { timeout: 90000 }, async t => {
  const providers = demoProviders({ thoughtDelayMs: 50 }), baseFast = providers.fast;
  let holdNextAction = false, gateStarted = false, releaseGate: (() => void) | null = null;
  providers.fast = { async decide(context: DecisionContext, signal) {
    if (holdNextAction && context.channels?.computer.candidates.some(candidate => candidate.selection.kind === 'execute')) {
      holdNextAction = false; gateStarted = true;
      await new Promise<void>(resolve => { releaseGate = resolve; });
    }
    return baseFast.decide(context, signal);
  } };
  const session = await startComputerServer({ port: 0, mode: 'demo', providers, decisionIntervalMs: 50 });
  const state = () => session.runtime.snapshot();
  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(`${session.origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  };
  try {
    await t.test('real DOM fields and visible saved output verify the goal; plan acceptance alone is insufficient', async () => {
      await post('/api/goal', { name: '林晓', category: 'work', note: '复核资料' });
      assert.equal(state().task?.status, 'active');
      await until(() => state().task?.status === 'completed' && !!state().agent.turn?.completed, 'The form goal did not complete.');
      assert.deepEqual(state().document?.saved, { name: '林晓', category: 'work', note: '复核资料' });
      const receipts = state().agent.channels.computer.receipts;
      assert.equal(receipts.filter(receipt => receipt.status === 'completed').length, 4);
      assert.ok(receipts.every(receipt => receipt.result && (receipt.result as { verified: boolean }).verified));
      assert.equal(state().task?.plan?.completedSteps.length, 4);
      assert.ok(state().task!.evidenceIds.includes(state().document!.id) || state().task!.evidenceIds.length > 0);
    });
    await t.test('popup and changed field order are observed and operated without request mocks', async () => {
      await post('/api/scenario', { kind: 'popup' });
      await post('/api/goal', { name: '周宁', category: 'life', note: '<script>这是一段普通文字</script>' });
      await until(() => state().task?.status === 'completed', 'The popup task did not complete.');
      assert.equal(state().document?.popup, false);
      assert.equal(state().document?.saved?.note, '<script>这是一段普通文字</script>');
      assert.ok(state().agent.channels.computer.receipts.some(receipt => receipt.call.target === 'dismiss' && receipt.status === 'completed'));
    });
    await t.test('a layout change during inference discards the old candidate before an input effect', async () => {
      holdNextAction = true; gateStarted = false;
      const count = state().agent.channels.computer.receipts.length;
      await post('/api/goal', { name: '陈风', category: 'work', note: '字段移动后继续' });
      await until(() => gateStarted, 'No actionable decision was intercepted.');
      await post('/api/scenario', { kind: 'shuffle' });
      assert.equal(state().agent.channels.computer.receipts.length, count);
      releaseGate!(); releaseGate = null;
      await until(() => state().task?.status === 'completed', 'The refreshed goal did not complete.');
      assert.ok(state().history.some(event => event.type === 'error' && event.detail.includes('stale sensor evidence')));
      assert.equal(state().document?.saved?.name, '陈风');
    });
    await t.test('a late save is recorded in the old turn and cannot finish the corrected goal', async () => {
      await post('/api/scenario', { kind: 'slow' });
      await post('/api/goal', { name: '旧目标', category: 'life', note: '保存期间改口' });
      await until(() => state().document?.saving === true, 'The slow save never began.');
      const oldTurn = state().agent.turn!.id, version = state().task!.version;
      await post('/api/goal', { name: '新目标', category: 'work', note: '只以新的保存结果验收' });
      assert.equal(state().task?.version, version + 1); assert.equal(state().task?.status, 'active');
      await until(() => state().agent.channels.computer.receipts.some(receipt => receipt.scope.turnId === oldTurn && receipt.call.target === 'save' && receipt.status === 'completed'), 'Old save outcome was not accounted for.');
      if (state().document?.saved?.name === '旧目标') assert.equal(state().task?.status, 'active');
      await until(() => state().task?.status === 'completed', 'Corrected goal did not complete.');
      assert.deepEqual(state().document?.saved, { name: '新目标', category: 'work', note: '只以新的保存结果验收' });
    });
    await t.test('explicit stop pauses new work while acknowledging any save already sent', async () => {
      await post('/api/goal', { name: '停止测试', category: 'life', note: '停止不会撤销已发送的保存' });
      await until(() => state().document?.saving === true, 'The save never began.');
      await post('/api/stop'); assert.equal(state().agent.paused, true); assert.equal(state().task?.status, 'cancelled');
      await until(() => !state().agent.channels.computer.current, 'Pending save was never acknowledged after stop.');
      assert.equal(state().task?.status, 'cancelled');
      assert.equal(state().agent.channels.computer.receipts.at(-1)?.status, 'completed');
      await post('/api/goal', { name: '停止后继续', category: 'work', note: '资源释放后可以接受新目标' });
      await until(() => state().task?.status === 'completed', 'A new goal could not reuse the browser after stop.');
      assert.equal(state().agent.paused, false);
      assert.deepEqual(state().document?.saved, { name: '停止后继续', category: 'work', note: '资源释放后可以接受新目标' });
    });
    await t.test('desktop/mobile monitor is usable and displays a real browser screenshot', async () => {
      await mkdir('test-results/computer', { recursive: true });
      const page = await session.runtime.driver.monitorPage(); const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.setViewportSize({ width: 1440, height: 1050 }); await page.goto(session.origin);
        await page.getByText('本地规则演示 · 未调用模型').waitFor();
        await until(() => page.locator('#screen').evaluate(image => (image as HTMLImageElement).naturalWidth > 0), 'No actual browser screenshot appeared.');
        await page.screenshot({ path: 'test-results/computer/desktop.png', fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: 'test-results/computer/mobile.png', fullPage: true });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
    await t.test('cross-origin mutations and invalid operation inputs are rejected', async () => {
      const cross = await fetch(`${session.origin}/api/stop`, { method: 'POST', headers: { Origin: 'https://example.test' } }); assert.equal(cross.status, 403);
      assert.equal(await statusWithHost(`${session.origin}/api/state`, 'example.test'), 403);
      const invalid = await fetch(`${session.origin}/api/goal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'name', category: 'unknown', note: '' }) });
      assert.equal(invalid.status, 400);
    });
  } finally { (releaseGate as (() => void) | null)?.(); await session.close(); }
});
