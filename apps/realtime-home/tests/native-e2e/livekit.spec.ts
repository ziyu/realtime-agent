import { expect, test } from '@playwright/test';

test('LiveKit Agents exchanges microphone and generated PCM with an actual room and releases the model connection', async ({ page, request }) => {
  expect(await (await request.get('/__fixture')).json()).toEqual({ fixture: true, modelRequests: false });
  await page.goto('/');
  await page.getByRole('combobox', { name: '实时语音方案' }).selectOption('livekit-openai');
  await page.getByRole('button', { name: '开始实时对话', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/__fixture/audio')).json()).inputAudioBytes, { timeout: 15000 }).toBeGreaterThan(9600);
  await request.post('/__fixture/say', { data: { text: '去睡觉' } });
  await expect.poll(async () => (await (await request.get('/api/state')).json()).agent.action?.id).toBe('sleep');
  await expect(page.locator('audio[data-native-voice-audio="livekit"]')).toHaveCount(1);
  await page.evaluate(async () => {
    const player = document.querySelector<HTMLAudioElement>('audio[data-native-voice-audio="livekit"]')!;
    const context = new AudioContext(); await context.resume();
    const source = context.createMediaStreamSource(player.srcObject as MediaStream), analyzer = context.createAnalyser(), muted = context.createGain();
    muted.gain.value = 0; source.connect(analyzer).connect(muted).connect(context.destination);
    Object.assign(window, { audioProbe: { context, rms() { const values = new Float32Array(analyzer.fftSize); analyzer.getFloatTimeDomainData(values); return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length); } } });
  });
  await expect.poll(async () => page.evaluate(() => (window as any).audioProbe.rms())).toBeGreaterThan(0.005);
  await request.post('/__fixture/say', { data: { text: '改去喝水' } });
  await expect.poll(async () => (await (await request.get('/api/state')).json()).agent.action?.id).toBe('drink');
  const state = await (await request.get('/api/state')).json();
  expect(state.metrics.interrupted).toBeGreaterThan(0); expect(state.outcomes.some((o: { action: string }) => o.action === 'sleep')).toBe(false);
  await page.getByRole('button', { name: '结束实时对话', exact: true }).click();
  await expect(page.locator('audio[data-native-voice-audio]')).toHaveCount(0);
  await expect.poll(async () => (await (await request.get('/__fixture/audio')).json()).connected).toBe(0);
  await expect.poll(async () => (await (await request.get('/api/state')).json()).nativeVoiceActive).toBe(false);
  await page.evaluate(() => (window as any).audioProbe.context.close());
});
