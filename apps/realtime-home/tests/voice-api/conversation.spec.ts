import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { WorldState } from '../../shared/types';

test('native model receives real audio, returns audio, and redirects Jev after a spoken correction', async ({ page, request }) => {
  expect((await (await request.get('/api/health')).json()).mode).toBe('live');
  await request.post('/api/control', { data: { type: 'reset' } });
  let result = 'failed';
  try {
    await page.goto('/');
    await page.getByRole('combobox', { name: '实时语音方案' }).selectOption(process.env.VOICE_TEST_PROFILE || 'openai-webrtc');
    await page.getByRole('button', { name: '开始实时对话', exact: true }).click();
    await expect.poll(async () => {
      const s = await (await request.get('/api/state')).json() as WorldState;
      expect(s.metrics.jevCalls).toBeLessThan(30);
      const turns = s.turns.filter(turn => turn.source === 'voice');
      return turns.some(turn => turn.appliedAction === 'sleep') && turns.some(turn => turn.appliedAction === 'drink');
    }, { timeout: 28000, intervals: [200] }).toBe(true);
    const world = await (await request.get('/api/state')).json() as WorldState;
    expect(world.metrics.interrupted).toBeGreaterThan(0);
    expect(world.traces.some(trace => trace.source === 'jev' && trace.receipt?.status === 200)).toBe(true);
    await expect(page.locator('audio[data-native-voice-audio]')).toHaveCount(1);
    await page.evaluate(async () => {
      const audio = document.querySelector<HTMLAudioElement>('audio[data-native-voice-audio]')!;
      const context = new AudioContext(), analyzer = context.createAnalyser(), silent = context.createGain();
      silent.gain.value = 0; context.createMediaStreamSource(audio.srcObject as MediaStream).connect(analyzer).connect(silent).connect(context.destination); await context.resume();
      Object.assign(window, { nativeApiProbe: { context, rms() { const samples = new Float32Array(analyzer.fftSize); analyzer.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length); } } });
    });
    const text = page.getByRole('textbox', { name: '给 Milo 发消息' });
    await text.fill('先停在原地，用一句话告诉我你喜欢怎样的生活。'); await text.press('Enter');
    await expect.poll(async () => page.evaluate(() => (window as any).nativeApiProbe.rms()), { timeout: 10000, intervals: [100] }).toBeGreaterThan(0.002);
    result = 'passed';
  } finally {
    await page.getByRole('button', { name: '结束实时对话', exact: true }).click({ timeout: 1000 }).catch(() => undefined);
    await page.evaluate(() => (window as any).nativeApiProbe?.context.close()).catch(() => undefined);
    await request.post('/api/control', { data: { type: 'pause', paused: true } });
    const world = await (await request.get('/api/state')).json() as WorldState;
    mkdirSync('test-results/native-api', { recursive: true });
    writeFileSync(`test-results/native-api/${process.env.VOICE_TEST_PROFILE || 'openai-webrtc'}-${Date.now()}.json`, JSON.stringify({
      result, verifiedAt: new Date().toISOString(), source: 'recorded PCM WAV, real providers; not a physical microphone',
      turns: world.turns, metrics: world.metrics, outcomes: world.outcomes, responses: world.traces.filter(trace => trace.receipt),
    }, null, 2), { mode: 0o600 });
  }
});
