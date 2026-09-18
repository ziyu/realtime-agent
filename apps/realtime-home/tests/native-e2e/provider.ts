import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

/** OpenAI wire-protocol fixture with real PCM frames; never contacts a model API. */
export async function startAudioProviderFixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const stats = { inputAudioBytes: 0, outputAudioFrames: 0, cancellations: 0, connected: 0 };
  const emitters = new Map<WebSocket, (text: string) => void>();
  server.on('connection', (socket, request) => {
    if (request.headers.authorization !== 'Bearer fixture-model-key') { socket.close(); return; }
    stats.connected++;
    let timer: ReturnType<typeof setInterval> | undefined;
    let responseId = '', messageId = '';
    const send = (data: Record<string, unknown>) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event_id: randomUUID(), ...data })); };
    const finish = (cancelled = false) => {
      clearInterval(timer); timer = undefined;
      if (!responseId) return;
      send({ type: 'response.output_audio.done', response_id: responseId, item_id: messageId, output_index: 0, content_index: 0 });
      send({ type: 'response.output_audio_transcript.done', response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, transcript: '我正在听你说。' });
      send({ type: 'response.done', response: { id: responseId, status: cancelled ? 'cancelled' : 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
      responseId = '';
    };
    const reply = (metadata?: unknown) => {
      finish(true);
      responseId = `resp_${randomUUID()}`; messageId = `msg_${randomUUID()}`;
      const common = { response_id: responseId, item_id: messageId, output_index: 0, content_index: 0 };
      send({ type: 'response.created', response: { id: responseId, status: 'in_progress', metadata, output: [] } });
      send({ type: 'response.output_item.added', ...common, item: { id: messageId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
      send({ type: 'response.content_part.added', ...common, part: { type: 'audio', transcript: '' } });
      send({ type: 'response.output_audio_transcript.delta', ...common, delta: '我正在听你说。' });
      let frame = 0;
      timer = setInterval(() => {
        const pcm = Buffer.alloc(960);
        for (let i = 0; i < 480; i++) pcm.writeInt16LE(Math.round(Math.sin((frame * 480 + i) * Math.PI * 2 * 440 / 24000) * 4000), i * 2);
        send({ type: 'response.output_audio.delta', ...common, delta: pcm.toString('base64') });
        stats.outputAudioFrames++; if (++frame >= 500) finish();
      }, 20);
    };
    const input = (text: string) => {
      finish(true); const id = `user_${randomUUID()}`;
      send({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: 0 });
      send({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: 600 });
      send({ type: 'input_audio_buffer.committed', item_id: id, previous_item_id: null });
      send({ type: 'conversation.item.created', previous_item_id: null, item: { id, type: 'message', role: 'user', status: 'completed', content: [{ type: 'input_audio', transcript: null }] } });
      send({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript: text });
      reply();
    };
    emitters.set(socket, input);
    send({ type: 'session.created', session: { id: 'sess_fixture', type: 'realtime', model: 'fixture' } });
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'session.update') send({ type: 'session.updated', session: { id: 'sess_fixture', ...event.session } });
      if (event.type === 'input_audio_buffer.append') stats.inputAudioBytes += Buffer.from(event.audio, 'base64').length;
      if (event.type === 'conversation.item.create') send({ type: 'conversation.item.created', previous_item_id: event.previous_item_id ?? null, item: event.item });
      if (event.type === 'response.create') reply(event.response?.metadata);
      if (event.type === 'response.cancel') { stats.cancellations++; finish(true); }
      if (event.type === 'conversation.item.truncate') send({ ...event, type: 'conversation.item.truncated' });
    });
    socket.on('close', () => { clearInterval(timer); emitters.delete(socket); stats.connected--; });
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, stats,
    say(text: string) { for (const emit of emitters.values()) emit(text); },
    close() { for (const socket of server.clients) socket.close(); server.close(); },
  };
}
