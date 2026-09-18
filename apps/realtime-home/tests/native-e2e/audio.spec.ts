import { expect, test } from '@playwright/test';

test('official OpenAI SDK carries actual bidirectional WebRTC audio, supersedes commands, and closes microphone tracks', async ({ page, request }) => {
  expect(await (await request.get('/__fixture')).json()).toEqual({ fixture: true, modelRequests: false });
  await page.addInitScript(() => {
    const state = window as typeof window & { capturedTracks: MediaStreamTrack[] };
    state.capturedTracks = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getUserMedia(constraints); state.capturedTracks.push(...stream.getTracks()); return stream;
    };
  });
  await page.goto('/');
  await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    const context = new AudioContext();
    const oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
    oscillator.frequency.value = 440; gain.gain.value = 0.05;
    oscillator.connect(gain).connect(destination); oscillator.start();
    pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
    let channel: RTCDataChannel | undefined;
    let inputTrack: MediaStreamTrack | undefined;
    const received: string[] = [];
    const send = (event: Record<string, unknown>) => channel?.send(JSON.stringify({ event_id: crypto.randomUUID(), ...event }));
    pc.ontrack = event => { inputTrack = event.track; };
    pc.ondatachannel = event => {
      channel = event.channel;
      channel.onopen = () => send({ type: 'session.created', session: { id: 'sess_fixture', model: 'gpt-realtime-2.1', type: 'realtime', output_modalities: ['audio'] } });
      channel.onmessage = event => {
        const data = JSON.parse(event.data); received.push(data.type);
        if (data.type === 'session.update') send({ type: 'session.updated', session: { id: 'sess_fixture', ...data.session } });
        if (data.type === 'output_audio_buffer.clear') { gain.gain.value = 0; send({ type: 'output_audio_buffer.cleared', response_id: 'resp_old' }); }
        if (data.type === 'conversation.item.create') send({ type: 'conversation.item.added', item: { id: data.item.id ?? 'text_user', status: 'completed', ...data.item } });
      };
    };
    Object.assign(window, { protocolPeer: {
      send, received,
      async answer(sdp: string) {
        await pc.setRemoteDescription({ type: 'offer', sdp }); await pc.setLocalDescription(await pc.createAnswer());
        if (pc.iceGatheringState !== 'complete') await new Promise<void>(resolve => { pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); }); });
        await context.resume(); return pc.localDescription!.sdp;
      },
      async audioStats() {
        const reports = await pc.getStats();
        return { inputTrack: inputTrack?.kind, incomingBytes: [...reports.values()].filter(r => r.type === 'inbound-rtp' && r.kind === 'audio').reduce((n, r) => n + r.bytesReceived, 0),
          outgoingBytes: [...reports.values()].filter(r => r.type === 'outbound-rtp' && r.kind === 'audio').reduce((n, r) => n + r.bytesSent, 0) };
      },
      close() { pc.close(); oscillator.stop(); destination.stream.getTracks().forEach(t => t.stop()); void context.close(); },
    } });
  });
  await page.route('https://api.openai.com/**', async route => {
    expect(route.request().headers().authorization).toBe('Bearer ek_protocol_fixture_no_real_model');
    const offer = route.request().postData()!;
    expect(offer).toContain('v=0');
    const answer = await page.evaluate(async sdp => (window as any).protocolPeer.answer(sdp), offer);
    await route.fulfill({ status: 201, contentType: 'application/sdp', body: answer });
  });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '开始实时对话', exact: true }).click();
  await expect(page.getByTestId('voice-caption')).toContainText('正在听');
  await expect.poll(async () => page.evaluate(async () => {
    const s = await (window as any).protocolPeer.audioStats(); return s.incomingBytes > 100 && s.outgoingBytes > 100 && s.inputTrack === 'audio';
  })).toBe(true);
  await expect(page.locator('audio[data-native-voice-audio="openai"]')).toHaveCount(1);
  const say = (id: string, transcript: string) => page.evaluate(({ id, transcript }) => {
    const send = (window as any).protocolPeer.send;
    send({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: 0 });
    send({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: 800 });
    send({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript });
  }, { id, transcript });
  await say('utterance_one', '去睡觉');
  await expect.poll(async () => (await (await request.get('/api/state')).json()).agent.action?.id).toBe('sleep');
  await say('utterance_two', '改去喝水');
  await expect.poll(async () => (await (await request.get('/api/state')).json()).agent.action?.id).toBe('drink');
  // Delayed transcription for a known older audio item must not reverse the correction.
  await page.evaluate(() => (window as any).protocolPeer.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'utterance_one', content_index: 0, transcript: '去睡觉' }));
  await expect(page.getByTestId('voice-caption')).toContainText('改去喝水');
  const state = await (await request.get('/api/state')).json();
  expect(state.intent.text).toBe('改去喝水'); expect(state.metrics.interrupted).toBeGreaterThan(0);
  expect(state.outcomes.some((o: { action: string }) => o.action === 'sleep')).toBe(false);
  await page.getByRole('button', { name: '结束实时对话', exact: true }).click();
  await expect(page.locator('audio[data-native-voice-audio]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).capturedTracks.length > 0 && (window as any).capturedTracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true);
  await expect.poll(async () => (await (await request.get('/api/state')).json()).nativeVoiceActive).toBe(false);
  await page.evaluate(() => (window as any).protocolPeer.close());
  expect(errors).toEqual([]);
});
