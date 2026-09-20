import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { WorldState } from '../../shared/types';

test('real Jev chooses a slow-model speech proposal after kitchen inspection and Grok renders it', async ({ page, request }) => {
  let result = 'failed';
  await page.goto('/');
  await page.getByRole('combobox', { name: '实时语音方案' }).selectOption('cloudflare-grok');
  try {
    await page.getByRole('button', { name: '开始实时对话', exact: true }).click();
    await expect(page.locator('audio[data-native-voice-audio="livekit"]')).toHaveCount(1, { timeout: 20000 });
    await page.evaluate(async () => {
      const audio = document.querySelector<HTMLAudioElement>('audio[data-native-voice-audio="livekit"]')!;
      const context = new AudioContext(), analyzer = context.createAnalyser(), gain = context.createGain(); gain.gain.value = 0;
      context.createMediaStreamSource(audio.srcObject as MediaStream).connect(analyzer).connect(gain).connect(context.destination); await context.resume();
      const probe = { context, max: 0, timer: 0 };
      probe.timer = window.setInterval(() => { const s = new Float32Array(analyzer.fftSize); analyzer.getFloatTimeDomainData(s);
        probe.max = Math.max(probe.max, Math.sqrt(s.reduce((sum, n) => sum + n * n, 0) / s.length)); }, 20);
      Object.assign(window, { controlledAudioProbe: probe });
    });
    const send = async (text: string) => {
      const composer = page.getByRole('textbox', { name: '给 Milo 发消息' }); await composer.fill(text); await composer.press('Enter');
    };
    await send('走到厨房去看有啥东西');
    await expect.poll(async () => (await (await request.get('/api/state')).json() as WorldState).intent?.observation?.target,
      { timeout: 12000 }).toBe('kitchen');
    const inspection = (await (await request.get('/api/state')).json() as WorldState).intent!.id;
    await expect.poll(async () => {
      const state = await (await request.get('/api/state')).json() as WorldState;
      return state.messages.findLast(message => message.nativeAudio && message.turnId === inspection)?.text;
    }, { timeout: 45000 }).toMatch(/(?=.*料理台)(?=.*饮水台)(?=.*水槽)/);
    const inspected = await (await request.get('/api/state')).json() as WorldState;
    const arrival = inspected.outcomes.find(o => o.requestId === inspection && o.action === 'inspect' && o.target === 'kitchen');
    expect(arrival).toBeTruthy();
    expect(inspected.turns.find(t => t.id === inspection)?.output?.status).toBe('delivered');
    expect(inspected.traces.filter(t => t.turnId === inspection).map(t => t.stage)).toEqual(expect.arrayContaining(['input', 'decision', 'action', 'observation', 'output']));
    expect(inspected.turns.find(t => t.id === inspection)!.replyAt).toBeGreaterThanOrEqual(arrival!.at);
    const replies = inspected.messages.filter(message => message.nativeAudio && message.turnId === inspection);
    for (const reply of replies) expect(inspected.speechExecutions).toContainEqual(expect.objectContaining({ id: reply.id, status: 'completed', call: expect.objectContaining({ capability: 'speak', input: { text: reply.text } }) }));
    expect(inspected.speechExecutions?.some(r => r.scope.turnId === inspection && r.status === 'completed' && (r.result as { evidenceIds?: string[] })?.evidenceIds?.includes(arrival!.id))).toBe(true);
    await expect.poll(async () => page.evaluate(() => (window as any).controlledAudioProbe.max)).toBeGreaterThan(0.002);
    result = 'passed';
  } finally {
    await page.getByRole('button', { name: '结束实时对话', exact: true }).click({ timeout: 1000 }).catch(() => undefined);
    await page.evaluate(() => { clearInterval((window as any).controlledAudioProbe?.timer); void (window as any).controlledAudioProbe?.context.close(); }).catch(() => undefined);
    await request.post('/api/control', { data: { type: 'pause', paused: true } });
    const state = await (await request.get('/api/state')).json() as WorldState;
    const verification = await (await request.get('/__verification')).json();
    mkdirSync('test-results/controlled-live', { recursive: true });
    const report = { result, verifiedAt: new Date().toISOString(), realJev: true, realVoice: true, physicalMicrophone: false,
      input: 'text input via real voice session', verification, turns: state.turns, metrics: state.metrics,
      spoken: state.messages.filter(message => message.nativeAudio), executions: state.executions, speechExecutions: state.speechExecutions, diagnostics: state.traces.filter(trace => trace.kind === 'guard' || trace.kind === 'decision') };
    writeFileSync(`test-results/controlled-live/verification-${Date.now()}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ result, realJev: true, realVoice: true, physicalMicrophone: false, spoken: report.spoken.map(message => message.text), modelCalls: verification.modelCalls }));
  }
});
