import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { WorldState } from '../../shared/types';

test('native speech recognition sends recorded audio turns to real Jev and redirects the agent', async ({ page, request }, info) => {
  test.setTimeout(40000);
  expect((await (await request.get('/api/health')).json()).mode).toBe('live');
  await request.post('/api/control', { data: { type: 'reset' } });
  let verified = false;
  try {
    // Observe native recognition events without synthesizing any result or replacing its service.
    await page.addInitScript(() => {
      type NativeRecognition = EventTarget & { start(): void };
      const target = window as unknown as { SpeechRecognition?: new () => NativeRecognition; webkitSpeechRecognition?: new () => NativeRecognition; __nativeSpeechEvents: { type: string; at: number }[] };
      const Native = target.SpeechRecognition ?? target.webkitSpeechRecognition;
      target.__nativeSpeechEvents = [];
      if (!Native) return;
      const observed = class extends Native {
        constructor() {
          super();
          for (const type of ['start', 'audiostart', 'soundstart', 'speechstart', 'speechend', 'result', 'nomatch', 'error', 'audioend', 'end']) {
            this.addEventListener(type, () => target.__nativeSpeechEvents.push({ type, at: performance.now() }));
          }
        }
      };
      target.SpeechRecognition = observed; target.webkitSpeechRecognition = observed;
    });
    await page.goto('/');
    await page.getByRole('combobox', { name: '实时语音方案' }).selectOption('browser');
    await page.getByRole('button', { name: '开始实时对话', exact: true }).click();
    await expect.poll(async () => {
      const alert = await page.getByRole('alert').allTextContents();
      if (alert.length) return { error: alert.join(' ') };
      const state = await (await request.get('/api/state')).json() as WorldState;
      expect(state.metrics.jevCalls).toBeLessThan(25);
      const spoken = state.turns.filter(t => t.source === 'voice');
      return spoken.some(t => t.appliedAction === 'sleep') && spoken.some(t => t.appliedAction === 'drink');
    }, { timeout: 20000, intervals: [250] }).toBe(true);
    const state = await (await request.get('/api/state')).json() as WorldState;
    expect(state.agent.action?.id).toBe('drink');
    expect(state.metrics.interrupted).toBeGreaterThan(0);
    verified = true;
  } finally {
    const state = await (await request.get('/api/state')).json() as WorldState;
    const caption = await page.getByTestId('voice-caption').textContent().catch(() => null);
    const errors = await page.getByRole('alert').allTextContents().catch(() => []);
    const nativeEvents = await page.evaluate(() => (window as unknown as { __nativeSpeechEvents: unknown[] }).__nativeSpeechEvents).catch(() => []);
    const report = { verifiedAt: new Date().toISOString(), result: verified ? 'passed' : 'not-verified',
      audioSource: 'recorded synthetic PCM WAV through Chrome capture device; not a physical microphone',
      headed: process.env.VOICE_TEST_HEADED === '1', caption, errors, nativeEvents, turns: state.turns, metrics: state.metrics,
      responses: state.traces.filter(t => t.receipt), test: info.title };
    mkdirSync('test-results/realtime', { recursive: true });
    writeFileSync(`test-results/realtime/native-voice-${process.env.VOICE_TEST_HEADED === '1' ? 'headed' : 'headless'}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ nativeVoice: report.result, caption, errors, turns: state.turns.length }));
    await page.getByRole('button', { name: '结束实时对话', exact: true }).click({ timeout: 1000 }).catch(() => undefined);
    await request.post('/api/control', { data: { type: 'pause', paused: true } });
  }
});
