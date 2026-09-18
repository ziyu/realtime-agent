import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadRuntimeConfig } from '@realtime-agent/config';
import { AgentRuntime } from '../../server/runtime';
import { JevProvider } from '../../server/providers';
import { VoiceBridge } from '../../server/voice/bridge';
import { VoiceTurns } from '../../server/voice/turns';

test('native voice bridge: real Jev follows final transcripts and rejects a late older utterance', async ({ request }) => {
  test.setTimeout(25000);
  await request.post('/api/control', { data: { type: 'pause', paused: true } });
  const config = loadRuntimeConfig({ appDirectory: process.cwd(), defaultPort: 3102 });
  expect(Boolean(config.systemOne.apiKey)).toBe(true);
  const runtime = new AgentRuntime({ mode: 'live', fast: new JevProvider(config.systemOne.apiKey, config.systemOne.model, fetch, config.systemOne.baseUrl), slow: null });
  runtime.setNativeVoice(true);
  const bridge = new VoiceBridge(runtime, runtime.state.epoch, 'live-body', Date.now() + 25000);
  const turns = new VoiceTurns(bridge);
  let result = 'failed';
  runtime.start();
  const speak = (id: string, text: string) => { turns.start(id); turns.stop(); turns.transcript({ itemId: id, transcript: text, isFinal: true }); };
  try {
    speak('first', '现在去卧室睡觉。');
    await expect.poll(() => runtime.state.agent.action?.id, { timeout: 6000, intervals: [100] }).toBe('sleep');
    const original = runtime.state.intent!.id;
    speak('second', '不睡了，现在改去厨房喝水。');
    await expect.poll(() => runtime.state.agent.action?.id, { timeout: 6000, intervals: [100] }).toBe('drink');
    expect(turns.transcript({ itemId: 'first', transcript: '现在去卧室睡觉。', isFinal: true })).toBe(false);
    expect(runtime.state.intent?.text).toBe('不睡了，现在改去厨房喝水。');
    speak('third', '停下，站在原地等我。');
    await expect.poll(() => runtime.state.agent.action, { timeout: 6000, intervals: [100] }).toBeNull();
    expect(runtime.state.outcomes.some(outcome => outcome.requestId === original)).toBe(false);
    expect(runtime.state.metrics.interrupted).toBeGreaterThanOrEqual(2);
    expect(runtime.state.metrics.jevCalls).toBeLessThan(10);
    expect(runtime.state.metrics.llmCalls).toBe(0);
    expect(runtime.state.traces.filter(trace => trace.kind === 'decision').every(trace => trace.source === 'jev' && trace.receipt?.status === 200)).toBe(true);
    for (const turn of runtime.state.turns) expect(turn.appliedAt! - turn.receivedAt).toBeLessThan(3000);
    result = 'passed';
  } finally {
    bridge.close(); runtime.stop();
    mkdirSync('test-results/native-body', { recursive: true });
    const report = { result, source: 'real Jev; deterministic final-transcript input, no speech API', verifiedAt: new Date().toISOString(),
      turns: runtime.state.turns, metrics: runtime.state.metrics, outcomes: runtime.state.outcomes,
      decisions: runtime.state.traces.filter(trace => trace.kind === 'decision') };
    writeFileSync(`test-results/native-body/run-${Date.now()}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ result, realJev: true, realSpeechApi: false, reactionMs: runtime.state.turns.map(turn => turn.appliedAt === null ? null : turn.appliedAt - turn.receivedAt), metrics: runtime.state.metrics }));
  }
});
