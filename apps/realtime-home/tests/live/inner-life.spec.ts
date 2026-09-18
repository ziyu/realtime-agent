import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadRuntimeConfig } from '@realtime-agent/config';
import { AgentRuntime } from '../../server/runtime';
import { JevProvider, LanguageModelProvider } from '../../server/providers';
import { LifeStore } from '../../server/life-store';
import type { WorldState } from '../../shared/types';

test('Milo inner life: spontaneous diary, a personal voice, and preference recall after a real reload from disk', async ({ page, request }) => {
  test.setTimeout(120000);
  const config = loadRuntimeConfig({ appDirectory: process.cwd(), defaultPort: 3102 });
  expect(Boolean(config.systemOne.apiKey && config.llm.apiKey && config.llm.model)).toBe(true);
  const world = async () => {
    const result = await (await request.get('/api/state')).json() as WorldState;
    expect(result.mode).toBe('live');
    expect(result.error).toBeNull();
    expect(result.metrics.jevCalls).toBeLessThan(30);
    expect(result.metrics.llmCalls).toBeLessThan(5);
    return result;
  };
  await request.post('/api/control', { data: { type: 'reset' } });
  await request.post('/api/control', { data: { type: 'speed', speed: 4 } });
  let restarted: AgentRuntime | undefined;
  try {
    await page.goto('/');
    await page.getByRole('tab', { name: '内心', exact: true }).click();
    await expect(page.getByTestId('mind-panel')).toBeVisible();
    const original = await world();
    // No user instruction is sent: lived events must make Jev request a reflection.
    await expect.poll(async () => (await world()).mind.journal.filter(j => j.source === 'llm').length, { timeout: 40000, intervals: [500, 1000] }).toBeGreaterThan(original.mind.journal.length);
    const autonomous = await world();
    expect(autonomous.intent).toBeNull();
    expect(autonomous.metrics.completed).toBeGreaterThanOrEqual(2);
    expect(autonomous.reflection?.purpose).toBe('autonomous');
    expect(autonomous.reflection?.receipt?.status).toBe(200);
    expect(autonomous.mind.journal.at(-1)!.evidence.every(e => autonomous.mind.episodes.some(real => real.id === e.id))).toBe(true);
    expect(autonomous.mind.personality).toEqual(original.mind.personality);
    await page.screenshot({ path: 'test-results/inner-life-desktop.png', fullPage: true });

    await page.getByRole('tab', { name: '对话', exact: true }).click();
    const input = page.getByRole('textbox', { name: '给 Milo 发消息' });
    await input.fill('请记住，我最喜欢爵士乐，尤其是钢琴三重奏。先聊聊就好，不要行动。');
    await input.press('Enter');
    await expect.poll(async () => (await world()).memories.some(m => m.source === 'reflection' && m.text.includes('爵士') && m.evidenceText?.includes('钢琴三重奏')), { timeout: 35000, intervals: [500, 1000] }).toBe(true);
    const remembered = await world();
    await request.post('/api/control', { data: { type: 'pause', paused: true } });
    const path = resolve('.live-test-data', `continuity-${randomUUID()}`, 'life-live.json');
    const store = new LifeStore(path);
    store.save({ mind: remembered.mind, memories: remembered.memories });
    const reloaded = new LifeStore(path).load();
    restarted = new AgentRuntime({
      mode: 'live', mind: reloaded.mind, memories: reloaded.memories,
      fast: new JevProvider(config.systemOne.apiKey, config.systemOne.model, fetch, config.systemOne.baseUrl),
      slow: new LanguageModelProvider(config.llm.baseUrl, config.llm.apiKey, config.llm.model),
      persistLife: snapshot => store.save(snapshot),
    });
    expect(restarted.state.messages).toHaveLength(1); // Original conversation is NOT replayed as chat history.
    expect(restarted.state.mind.personality).toEqual(original.mind.personality);
    expect(restarted.state.mind.goals).toEqual(remembered.mind.goals);
    restarted.message('你还记得我偏爱什么音乐吗？你自己喜欢怎样的生活？先聊聊，不要行动。');
    restarted.start();
    await expect.poll(() => {
      expect(restarted!.state.metrics.jevCalls).toBeLessThan(25);
      expect(restarted!.state.metrics.llmCalls).toBeLessThan(4);
      expect(restarted!.state.error).toBeNull();
      return restarted!.state.reflection?.accepted && restarted!.state.reflection?.reply.includes('爵士');
    }, { timeout: 35000, intervals: [500, 1000] }).toBe(true);
    const final = restarted.snapshot();
    expect(final.reflection?.receipt?.status).toBe(200);
    expect(final.reflection?.reply).not.toMatch(/收到指令|主人|任务完成/);
    expect(final.metrics.started).toBe(0);
    const report = {
      verifiedAt: new Date().toISOString(), result: 'passed',
      autonomous: { metrics: autonomous.metrics, reflection: autonomous.reflection, journal: autonomous.mind.journal, goals: autonomous.mind.goals },
      memory: remembered.memories.filter(m => m.source === 'reflection' && m.evidenceText?.includes('钢琴三重奏')),
      afterReload: { reply: final.reflection?.reply, receipt: final.reflection?.receipt, metrics: final.metrics, personalityRetained: true, goalsRetained: true },
    };
    mkdirSync('test-results/inner-life', { recursive: true });
    writeFileSync('test-results/inner-life/live.json', JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ result: 'passed', diary: autonomous.mind.journal.at(-1)?.text, afterReloadReply: final.reflection?.reply, receipt: final.reflection?.receipt, autonomousMetrics: autonomous.metrics }));
  } finally {
    restarted?.stop();
    if (restarted) {
      const final = restarted.snapshot();
      mkdirSync('test-results/inner-life', { recursive: true });
      writeFileSync('test-results/inner-life/reload-last-run.json', JSON.stringify({ metrics: final.metrics, decision: final.decision, reflection: final.reflection, errors: final.traces.filter(t => t.kind === 'error'), latest: final.traces.slice(-8) }, null, 2), { mode: 0o600 });
    }
    const last = await (await request.get('/api/state')).json() as WorldState;
    mkdirSync('test-results/inner-life', { recursive: true });
    writeFileSync('test-results/inner-life/last-run.json', JSON.stringify({ metrics: last.metrics, reflection: last.reflection, journal: last.mind.journal, errors: last.traces.filter(t => t.kind === 'error'), latest: last.traces.slice(-12) }, null, 2), { mode: 0o600 });
    await request.post('/api/control', { data: { type: 'pause', paused: true } });
  }
});
