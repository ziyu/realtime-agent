import { expect, test } from '@playwright/test';

test('direct WebRTC keeps mismatched buffered audio silent and plays only server-approved text', async ({ page, request }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const pc = new RTCPeerConnection(), context = new AudioContext();
    const oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
    oscillator.frequency.value = 440; gain.gain.value = 0; oscillator.connect(gain).connect(destination); oscillator.start();
    pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
    let channel: RTCDataChannel | undefined, count = 0, mismatch = true, timer: ReturnType<typeof setTimeout> | undefined;
    const send = (event: Record<string, unknown>) => channel?.send(JSON.stringify({ event_id: crypto.randomUUID(), ...event }));
    pc.ondatachannel = event => {
      channel = event.channel;
      channel.onopen = () => send({ type: 'session.created', session: { id: 'controlled-peer', type: 'realtime', model: 'gpt-realtime-2.1', output_modalities: ['audio'] } });
      channel.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'session.update') send({ type: 'session.updated', session: { id: 'controlled-peer', ...message.session } });
        if (message.type === 'output_audio_buffer.clear' || message.type === 'response.cancel') { gain.gain.value = 0; }
        if (message.type !== 'response.create') return;
        const responseId = `response-${++count}`, itemId = `assistant-${count}`;
        const expected = JSON.parse(message.response.instructions.split('VERIFIED_TEXT=').at(-1));
        const transcript = mismatch ? '我已经完成了不存在的行动。' : expected;
        const metadata = message.response.metadata;
        const common = { response_id: responseId, item_id: itemId, output_index: 0, content_index: 0 };
        send({ type: 'response.created', response: { id: responseId, object: 'realtime.response', status: 'in_progress', output: [], metadata } });
        send({ type: 'output_audio_buffer.started', response_id: responseId });
        gain.gain.value = 0.07;
        timer = setTimeout(() => {
          gain.gain.value = 0;
          send({ type: 'response.output_audio_transcript.done', ...common, transcript });
          send({ type: 'response.done', response: { id: responseId, object: 'realtime.response', status: 'completed', output: [], metadata } });
          send({ type: 'output_audio_buffer.stopped', response_id: responseId });
        }, 900);
      };
    };
    Object.assign(window, { controlledPeer: {
      setMismatch(value: boolean) { mismatch = value; },
      speak(id: string, transcript: string) {
        send({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: 0 });
        send({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: 800 });
        send({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript });
      },
      async answer(sdp: string) {
        await pc.setRemoteDescription({ type: 'offer', sdp }); await pc.setLocalDescription(await pc.createAnswer());
        if (pc.iceGatheringState !== 'complete') await new Promise<void>(resolve => pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); }));
        await context.resume(); return pc.localDescription!.sdp;
      },
      close() { if (timer) clearTimeout(timer); pc.close(); oscillator.stop(); destination.stream.getTracks().forEach(track => track.stop()); void context.close(); },
    } });
  });
  await page.route('https://api.openai.com/**', async route => {
    expect(route.request().headers().authorization).toBe('Bearer ek_protocol_fixture_no_real_model');
    const answer = await page.evaluate(sdp => (window as any).controlledPeer.answer(sdp), route.request().postData()!);
    await route.fulfill({ status: 201, contentType: 'application/sdp', body: answer });
  });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '开始实时对话', exact: true }).click();
  await expect(page.getByTestId('voice-caption')).toContainText('正在听');
  await page.evaluate(async () => {
    const audio = document.querySelector<HTMLAudioElement>('audio[data-native-voice-audio="openai"]')!;
    const context = new AudioContext(), analyzer = context.createAnalyser(), muted = context.createGain(); muted.gain.value = 0;
    context.createMediaElementSource(audio).connect(analyzer).connect(muted).connect(context.destination); await context.resume();
    const probe = { context, max: 0, plays: 0, timer: 0 };
    audio.addEventListener('play', () => probe.plays++);
    probe.timer = window.setInterval(() => { const s = new Float32Array(analyzer.fftSize); analyzer.getFloatTimeDomainData(s); probe.max = Math.max(probe.max, Math.sqrt(s.reduce((sum, n) => sum + n * n, 0) / s.length)); }, 20);
    Object.assign(window, { controlledPlaybackProbe: probe });
  });
  try {
    const blocked = page.waitForResponse(response => response.url().endsWith('/approve-output'));
    await page.evaluate(() => (window as any).controlledPeer.speak('wrong', '去床边看看'));
    expect((await (await blocked).json()).approved).toBe(false);
    expect(await page.evaluate(() => (window as any).controlledPlaybackProbe.plays)).toBe(0);
    expect(await page.evaluate(() => (window as any).controlledPlaybackProbe.max)).toBe(0);
    const allowed = page.waitForResponse(response => response.url().endsWith('/approve-output'));
    await page.evaluate(() => { (window as any).controlledPeer.setMismatch(false); (window as any).controlledPeer.speak('correct', '改去沙发旁边看看'); });
    expect((await (await allowed).json()).approved).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).controlledPlaybackProbe.max)).toBeGreaterThan(0.005);
    await expect.poll(async () => {
      const state = await (await request.get('/api/state')).json();
      return state.messages.some((message: { nativeAudio?: boolean; text: string }) => message.nativeAudio && message.text.includes('沙发'));
    }).toBe(true);
    const observation = page.waitForResponse(response => response.url().endsWith('/output-plan'));
    await page.evaluate(() => (window as any).controlledPeer.speak('inspect', '走到厨房去看有啥东西'));
    await expect.poll(async () => (await (await request.get('/api/state')).json()).intent?.observation?.target).toBe('kitchen');
    const walking = await (await request.get('/api/state')).json();
    expect(walking.agent.action?.phase).toBe('walking');
    expect(walking.messages.some((m: any) => m.role === 'agent' && m.turnId === walking.intent.id)).toBe(false);
    const plan = await (await observation).json();
    expect(plan.exactText).toBe('厨房里有料理台、饮水台、水槽。');
    const arrived = await (await request.get('/api/state')).json();
    expect(arrived.outcomes.some((o: any) => o.requestId === plan.turnId && o.action === 'inspect' && o.target === 'kitchen')).toBe(true);
    await expect.poll(async () => {
      const state = await (await request.get('/api/state')).json();
      return state.messages.filter((m: any) => m.nativeAudio && m.turnId === plan.turnId).map((m: any) => m.text);
    }).toEqual([plan.exactText]);
    const finalState = await (await request.get('/api/state')).json();
    expect(finalState.turns.find((t: any) => t.id === plan.turnId).output.status).toBe('delivered');
    expect(finalState.traces.filter((t: any) => t.turnId === plan.turnId && t.stage === 'output').map((t: any) => t.title)).toEqual(expect.arrayContaining(['输出：authorized', '输出：generating', '输出：approved', '输出：playing', '输出：delivered']));
    expect(errors).toEqual([]);
  } finally {
    await page.getByRole('button', { name: '结束实时对话', exact: true }).click().catch(() => undefined);
    await page.evaluate(() => { clearInterval((window as any).controlledPlaybackProbe?.timer); void (window as any).controlledPlaybackProbe?.context.close(); (window as any).controlledPeer.close(); });
  }
});
