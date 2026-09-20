import { describe, expect, it } from 'vitest';
import { ReadableStream } from 'node:stream/web';
import { AudioFrame } from '@livekit/rtc-node';
import type { llm } from '@livekit/agents';
import { AgentRuntime } from '../server/runtime';
import { DemoFastProvider } from '../server/providers';
import { speechCandidates } from '../server/voice/output';
import { VoiceBridge } from '../server/voice/bridge';
import { verifyAudioGeneration } from '../server/voice/controlled-model';

const stream = <T>(values: T[]) => new ReadableStream<T>({ start(controller) { values.forEach(value => controller.enqueue(value)); controller.close(); } });
const generation = (text: string): llm.GenerationCreatedEvent => ({ userInitiated: true,
  functionStream: stream([]), messageStream: stream([{ messageId: 'message', textStream: stream([text]),
    audioStream: stream([new AudioFrame(new Int16Array(480).fill(1000), 24000, 1, 480)]), modalities: Promise.resolve(['audio'] as ('audio' | 'text')[]) }]),
});

describe('grounded voice output before playback', () => {
  it('does not release audio or captions for mismatched action text', async () => {
    const blocked = await verifyAudioGeneration(generation('我已经睡醒了。'), { signal: new AbortController().signal,
      valid: () => true, approve: text => text === '我开始往床旁边走了。' });
    expect((await blocked.messageStream.getReader().read()).done).toBe(true);
  });
  it('releases matching transcript and actual PCM only while the permit remains current', async () => {
    let valid = true;
    const approved = await verifyAudioGeneration(generation('我开始往床旁边走了。'), { signal: new AbortController().signal,
      valid: () => valid, approve: text => text === '我开始往床旁边走了。' });
    const message = await approved.messageStream.getReader().read(); expect(message.done).toBe(false);
    expect((await message.value!.textStream.getReader().read()).value).toBe('我开始往床旁边走了。');
    expect((await message.value!.audioStream.getReader().read()).value?.data.length).toBe(480);
    valid = false;
  });
  it('rejects canceled audio generation and stale observations without publishing results', async () => {
    const abort = new AbortController(); abort.abort();
    const cancelled = await verifyAudioGeneration(generation('床是棕色。'), { signal: abort.signal, valid: () => true, approve: () => true });
    expect((await cancelled.messageStream.getReader().read()).done).toBe(true);
    const stale = await verifyAudioGeneration(generation('床是棕色。'), { signal: new AbortController().signal, valid: () => false, approve: () => true });
    expect((await stale.messageStream.getReader().read()).done).toBe(true);
  });
  it('ties output permission to Jev acceptance, actual perception and the current spoken turn', async () => {
    let now = 100000;
    let reply = '我现在还没有床的可靠近距离观察。';
    const demo = new DemoFastProvider();
    const runtime = new AgentRuntime({ mode: 'live', fast: { decide: async (c, signal) => ({ ...await demo.decide(c, signal), think: c.state.reflection ? 0 : 1, acceptReflection: 1, speech: speechCandidates(c.state).find(candidate => candidate.selection.kind === 'execute')?.id ?? 'silent' }) }, slow: { reflect: async () => ({ summary: '提议', reply, memories: [], suggestedActions: [] }) }, now: () => now });
    runtime.setNativeVoice(true);
    const bridge = new VoiceBridge(runtime, runtime.state.epoch, 'test-output', now + 90000, () => now);
    bridge.event({ type: 'input', sequence: 1, itemId: 'first', text: '床是什么颜色？' }); await runtime.decide(); await Promise.resolve(); now += 1000; await runtime.decide();
    const unknown = await bridge.outputPlan(1); expect(unknown?.exactText).toContain('没有床的可靠近距离观察');
    expect(bridge.allowOutput(unknown!.id, 1, '床是蓝色。')).toBe(false);
    reply = '我开始往书架旁边走了。';
    bridge.event({ type: 'input', sequence: 2, itemId: 'second', text: '走到书架旁边' }); now += 1000; await runtime.decide(); await Promise.resolve(); now += 1000; await runtime.decide();
    expect(bridge.allowOutput(unknown!.id, 1)).toBe(false);
    const moving = await bridge.outputPlan(2); expect(moving?.exactText).toContain('开始往书架旁边走了');
    expect(bridge.allowOutput(moving!.id, 2, '我已经到了。')).toBe(false);
    bridge.event({ type: 'speech-start', sequence: 3, itemId: 'third' });
    expect(bridge.allowOutput(moving!.id, 2)).toBe(false);
    expect(bridge.outputSignal(moving!).aborted).toBe(true);
    bridge.close(); runtime.stop();
  });
});
