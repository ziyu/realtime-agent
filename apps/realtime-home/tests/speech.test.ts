import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceConversation } from '../src/speech';
import type { Recognition, RecognitionEvent, SpeechCallbacks } from '../src/speech';

class FakeRecognition implements Recognition {
  lang = ''; continuous = false; interimResults = false;
  onstart: Recognition['onstart'] = null;
  onspeechstart: Recognition['onspeechstart'] = null;
  onspeechend: Recognition['onspeechend'] = null;
  onresult: Recognition['onresult'] = null;
  onerror: Recognition['onerror'] = null;
  onend: Recognition['onend'] = null;
  start() { this.onstart?.(); }
  abort = vi.fn();
}
const sessions: VoiceConversation[] = [];
function setup() {
  vi.useFakeTimers();
  const engines: FakeRecognition[] = [];
  const callbacks = { status: vi.fn(), transcript: vi.fn(), interrupt: vi.fn(), utterance: vi.fn(), error: vi.fn() } satisfies SpeechCallbacks;
  const session = new VoiceConversation(() => { const engine = new FakeRecognition(); engines.push(engine); return engine; }, callbacks);
  sessions.push(session); session.start();
  return { session, engines, callbacks, engine: engines[0] };
}
const result = (values: [string, boolean][]): RecognitionEvent => ({ resultIndex: 0, results: values.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal })) });
afterEach(() => { sessions.splice(0).forEach(s => s.stop()); vi.useRealTimers(); });

describe('continuous speech turn boundaries', () => {
  it('interrupts on speech onset, shows interim text, and sends only finalized words once', async () => {
    const { engine, callbacks } = setup();
    expect(engine.continuous && engine.interimResults).toBe(true);
    engine.onspeechstart?.();
    engine.onresult?.(result([['先去睡', false]]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(callbacks.utterance).not.toHaveBeenCalled();
    expect(callbacks.transcript).toHaveBeenLastCalledWith('先去睡');
    engine.onresult?.(result([['先去睡觉', true]]));
    engine.onresult?.(result([['先去睡觉', true]]));
    await vi.advanceTimersByTimeAsync(160);
    expect(callbacks.utterance.mock.calls).toEqual([['先去睡觉']]);
    expect(callbacks.interrupt).toHaveBeenCalledTimes(1);
    engine.onresult?.(result([['先去睡觉', true], ['不，去喝水', true]]));
    await vi.advanceTimersByTimeAsync(160);
    expect(callbacks.utterance.mock.calls).toEqual([['先去睡觉'], ['不，去喝水']]);
  });
  it('merges final fragments without treating a changing interim hypothesis as an instruction', async () => {
    const { engine, callbacks } = setup();
    engine.onresult?.(result([['不要睡觉，', true], ['去', false]]));
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.utterance).not.toHaveBeenCalled();
    engine.onresult?.(result([['不要睡觉，', true], ['去喝水', true]]));
    await vi.advanceTimersByTimeAsync(160);
    expect(callbacks.utterance).toHaveBeenCalledExactlyOnceWith('不要睡觉，去喝水');
  });
  it('cancels queued transcript and ignores late callbacks after ending the conversation', async () => {
    const { engine, session, callbacks, engines } = setup();
    const late = engine.onresult!;
    engine.onresult?.(result([['去喝水', true]]));
    session.stop(); late(result([['去睡觉', true]]));
    await vi.advanceTimersByTimeAsync(5000);
    expect(callbacks.utterance).not.toHaveBeenCalled();
    expect(engine.abort).toHaveBeenCalledTimes(1);
    expect(engines).toHaveLength(1);
  });
  it('stops on permission or network failure instead of restarting forever', async () => {
    const { engine, callbacks, engines } = setup();
    engine.onerror?.({ error: 'network' });
    await vi.advanceTimersByTimeAsync(10000);
    expect(callbacks.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('连接失败'));
    expect(callbacks.status).toHaveBeenLastCalledWith('off');
    expect(engines).toHaveLength(1);
  });
  it('resumes after a normal recognition end, and stopping cancels the reconnection', async () => {
    const { engine, engines, session } = setup();
    engine.onend?.(); await vi.advanceTimersByTimeAsync(350);
    expect(engines).toHaveLength(2);
    engines[1].onend?.(); session.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(engines).toHaveLength(2);
  });
  it('does not submit an unfinished utterance or accept late results from an ended recognizer', async () => {
    const { engine, callbacks } = setup();
    const late = engine.onresult!;
    engine.onresult?.(result([['去睡觉，', true], ['不，', false]]));
    engine.onend?.();
    late(result([['去睡觉', true]]));
    await vi.advanceTimersByTimeAsync(350);
    expect(callbacks.utterance).not.toHaveBeenCalled();
    expect(callbacks.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('没有识别完整'));
  });
});
