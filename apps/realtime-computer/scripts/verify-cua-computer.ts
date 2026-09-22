import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { CuaTransport } from '../server/cua-transport.js';
import { createComputerProviders } from '../server/cua-models.js';
import { startCuaServer } from '../server/cua-app.js';
import { resolveComputerStartup, requireComputerModels } from '../server/startup.js';

// Explicit live acceptance. Agent itself must launch the real system application,
// handle its native Save dialog, and write the document through GUI operations.
// The test only creates the output directory and reads the finished file.
const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const startup = resolveComputerStartup({ appDirectory, args: ['--live'] });
requireComputerModels(startup);
const runId = randomUUID().slice(0, 8);
const output = join(appDirectory, 'test-results', 'cua-computer', runId);
await mkdir(output, { recursive: true });
const filename = join(output, `todo-${runId}.txt`);
const content = `Computer use ${runId}\n1. 整理项目\n2. 运行测试\n3. 核对保存结果`;
const task = `打开 Windows 系统记事本（Notepad），新建一个空白文档，不要修改已有文档。在新文档里逐行写入以下内容：\n${content}\n然后通过记事本的保存界面保存为 ${filename} 。核对实际文件内容后结束。无需用户预先打开应用或选择窗口。`;
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(), 8 * 60000);
const requests: { stage: string; status: number; durationMs: number }[] = [];
let calls = 0;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let session: Awaited<ReturnType<typeof startCuaServer>> | null = null;
const driver = await CuaTransport.open({ timeoutMs: 45000 });
let previousPhase = '', previousHistoryId = '';
try {
  session = await startCuaServer({ driver, port: 0, taskTimeoutMs: 7 * 60000, maxSteps: 90,
    providers: runtime => createComputerProviders(startup.config!, { tools: runtime.tools.modelCatalog(),
      ...(startup.vision ? { image: () => runtime.modelImage(), allowImageFallback: startup.visionMode === 'auto' } : {}), fetch: async (url, init) => {
        if (++calls > 160) throw new Error('Live acceptance request budget exhausted.');
        const stage = String(url).includes('chat/completions') ? 'llm' : 'system-one', started = performance.now();
        const response = await fetch(url, { ...init, signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]) });
        requests.push({ stage, status: response.status, durationMs: Math.round(performance.now() - started) });
        return response;
      } }),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(session.origin);
  await page.locator('#goal-text').fill(task);
  await page.locator('#start-goal').click();
  for (;;) {
    abort.signal.throwIfAborted();
    const state = session.runtime.snapshot();
    if (state.progress.phase !== previousPhase) {
      previousPhase = state.progress.phase;
      console.log(JSON.stringify({ phase: previousPhase, steps: state.task?.steps, modelCalls: calls }));
    }
    const event = state.history.at(-1);
    if (event && event.id !== previousHistoryId) {
      previousHistoryId = event.id;
      if (['action', 'replan', 'blocked'].includes(event.type)) console.log(JSON.stringify({ event: event.type, detail: event.detail.slice(0, 350) }));
    }
    if (state.task?.status === 'blocked') throw new Error(state.progress.message);
    if (state.task?.status === 'completed') break;
    await delay(250);
  }
  const saved = await readFile(filename);
  const actual = saved[0] === 255 && saved[1] === 254 ? saved.subarray(2).toString('utf16le') : saved.toString('utf8').replace(/^\uFEFF/, '');
  assert.equal(actual.replace(/\r\n/g, '\n').trim(), content);
  const trace = session.runtime.exportTrace();
  assert.ok(trace.actions.some(action => action.tool === 'launch_app'), 'The Agent must launch the real application itself.');
  assert.ok(trace.actions.some(action => ['hotkey', 'invoke_menu', 'click'].includes(action.tool)), 'The task must use real native GUI actions.');
  const windowIds = new Set(trace.actions.flatMap(action => {
    const target = action.arguments.target as { window_id?: number } | undefined;
    const id = action.arguments.window_id ?? target?.window_id;
    return id === undefined ? [] : [String(id)];
  }));
  assert.ok(windowIds.size >= 2, 'Saving must cross from the editor to a native dialog window.');
  const report = { result: 'passed', runId, backend: 'cua', driverVersion: driver.metadata.driverVersion,
    entry: 'page-start-task-no-preselected-window', requests, steps: trace.task?.steps,
    independentSavedFileVerified: true, windowTargets: windowIds.size, outputFile: filename };
  await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2));
  // The UI preview is scoped to the Agent-created application before saving a screenshot.
  const lastTarget = trace.actions.toReversed().find(action => action.arguments.window_id || (action.arguments.target as any)?.window_id);
  const lastWindowId = String(lastTarget?.arguments.window_id ?? (lastTarget?.arguments.target as any)?.window_id ?? '');
  if (lastWindowId && session.runtime.snapshot().observation.windows.some(window => window.id === lastWindowId)) {
    await session.runtime.view(lastWindowId);
    const frame = await session.runtime.screen(); await writeFile(join(output, 'native-result.png'), frame.bytes);
  }
  console.log(JSON.stringify(report));
} catch (error) {
  const trace = session?.runtime.exportTrace();
  // No images, raw model responses, keys or other-window titles are persisted.
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: error instanceof Error ? error.message : 'error',
    task: trace?.task, progress: trace?.progress, actions: trace?.actions, history: trace?.history, requests }, null, 2));
  throw error;
} finally {
  clearTimeout(deadline); abort.abort();
  await browser?.close();
  if (session) await session.close(); else await driver.close();
}
