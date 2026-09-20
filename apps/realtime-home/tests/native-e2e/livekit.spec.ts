import { expect, test } from '@playwright/test';

test.afterEach(async ({ request }, info) => {
  if (info.status !== 'passed') console.log(JSON.stringify({ mediaFixture: await (await request.get('/__fixture/audio')).json() }));
});

test('LiveKit Agents exchanges microphone and generated PCM with an actual room and releases the model connection', async ({ page, request }) => {
  expect(await (await request.get('/__fixture')).json()).toEqual({ fixture: true, modelRequests: false });
  await page.goto('/');
  const catalog = await (await request.get('/api/voice/catalog')).json();
  const cloudflare = catalog.defaultProfile === 'cloudflare-grok';
  await page.getByRole('combobox', { name: '实时语音方案' }).selectOption(cloudflare ? 'cloudflare-grok' : 'livekit-openai');
  if (cloudflare) expect(catalog.profiles).toHaveLength(1);
  await page.getByRole('button', { name: '开始实时对话', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/__fixture/audio')).json()).inputAudioBytes, { timeout: 15000 }).toBeGreaterThan(9600);
  if (cloudflare) expect((await (await request.get('/__fixture/audio')).json()).accountRouteVerified).toBe(true);
  if (cloudflare) {
    await request.post('/__fixture/say', { data: { text: '去睡觉', partial: true } });
    await expect.poll(async () => (await (await request.get('/api/state')).json()).attending).toBe(true);
    const before = await (await request.get('/api/state')).json();
    await expect.poll(async () => (await (await request.get('/api/state')).json()).elapsed).toBeGreaterThan(before.elapsed + 1.1);
    const unfinished = await (await request.get('/api/state')).json();
    expect(unfinished.turns).toHaveLength(0);
    expect(unfinished.agent.position).toEqual(before.agent.position);
  }
  await request.post('/__fixture/say', { data: { text: '去睡觉，聊聊为什么要休息' } });
  await expect.poll(async () => (await (await request.get('/api/state')).json()).agent.action?.id).toBe('sleep');
  await expect(page.getByTestId('voice-caption')).toContainText('去睡觉');
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

test('unapproved automatic audio and a mismatched action transcript never reach the room listener', async ({ page, request }) => {
  await page.goto('/');
  const catalog = await (await request.get('/api/voice/catalog')).json();
  await page.getByRole('combobox', { name: '实时语音方案' }).selectOption(catalog.defaultProfile === 'cloudflare-grok' ? 'cloudflare-grok' : 'livekit-openai');
  await page.getByRole('button', { name: '开始实时对话', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/__fixture/audio')).json()).inputAudioBytes).toBeGreaterThan(9600);
  await expect(page.locator('audio[data-native-voice-audio="livekit"]')).toHaveCount(1);
  await page.evaluate(async () => {
    const audio = document.querySelector<HTMLAudioElement>('audio[data-native-voice-audio="livekit"]')!;
    const context = new AudioContext(), analyzer = context.createAnalyser(), gain = context.createGain(); gain.gain.value = 0;
    context.createMediaStreamSource(audio.srcObject as MediaStream).connect(analyzer).connect(gain).connect(context.destination); await context.resume();
    const probe = { context, max: 0, timer: 0 };
    probe.timer = window.setInterval(() => { const samples = new Float32Array(analyzer.fftSize); analyzer.getFloatTimeDomainData(samples);
      probe.max = Math.max(probe.max, Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length)); }, 20);
    Object.assign(window, { blockedOutputProbe: probe });
  });
  try {
    await request.post('/__fixture/mismatch', { data: { enabled: true } });
    await request.post('/__fixture/say', { data: { text: '去床边看看' } });
    await expect(page.getByRole('alert')).toContainText('未通过发言校验', { timeout: 12000 });
    expect(await page.evaluate(() => (window as any).blockedOutputProbe.max)).toBeLessThan(0.001);
    const failed = await (await request.get('/api/state')).json();
    expect(failed.messages.some((message: { text: string }) => message.text.includes('从未执行的动作'))).toBe(false);
    await expect(page.getByRole('button', { name: '结束实时对话', exact: true })).toBeVisible();
    await request.post('/__fixture/mismatch', { data: { enabled: false } });
    await request.post('/__fixture/say', { data: { text: '改去沙发旁边看看' } });
    await expect.poll(async () => page.evaluate(() => (window as any).blockedOutputProbe.max), { timeout: 12000 }).toBeGreaterThan(0.005);
    const stats = await (await request.get('/__fixture/audio')).json(); expect(stats.explicitReplies).toBeGreaterThan(1); expect(stats.unsolicitedReplies).toBeGreaterThan(1);
    await request.post('/__fixture/say', { data: { text: '去看看书架是什么颜色' } });
    await expect.poll(async () => (await (await request.get('/api/state')).json()).intent?.observation?.target).toBe('read');
    const inspecting = await (await request.get('/api/state')).json();
    expect(inspecting.agent.action?.phase).toBe('walking');
    expect(inspecting.messages.some((m: any) => m.nativeAudio && m.turnId === inspecting.intent.id)).toBe(false);
    await expect.poll(async () => {
      const state = await (await request.get('/api/state')).json();
      return state.messages.filter((m: any) => m.nativeAudio && m.turnId === inspecting.intent.id).map((m: any) => m.text);
    }, { timeout: 15000 }).toEqual(['书架是暖木色，上面摆着绿色、陶土色、米黄色和蓝绿色等不同颜色的书。']);
    const inspected = await (await request.get('/api/state')).json();
    expect(inspected.outcomes.some((o: any) => o.requestId === inspecting.intent.id && o.target === 'read' && o.action === 'inspect')).toBe(true);
  } finally {
    await request.post('/__fixture/mismatch', { data: { enabled: false } });
    await page.getByRole('button', { name: '结束实时对话', exact: true }).click().catch(() => undefined);
    await page.evaluate(() => { clearInterval((window as any).blockedOutputProbe?.timer); void (window as any).blockedOutputProbe?.context.close(); });
  }
});
