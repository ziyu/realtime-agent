import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from '@realtime-agent/config';
import { AgentRuntime } from '../server/runtime';
import { JevProvider } from '../server/providers';
import { VoiceBridge } from '../server/voice/bridge';
import { ACTIONS } from '../shared/world';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadRuntimeConfig({ appDirectory: directory, defaultPort: 3102 });
assert.equal(config.provider, 'cloudflare', 'This opt-in verification expects configured Cloudflare credentials.');
let requests = 0;
const fetcher: typeof fetch = async (url, init) => {
  if (++requests > 6) throw new Error('Verification model-call budget exceeded.');
  return fetch(url, init);
};
const runtime = new AgentRuntime({ mode: 'live', provider: config.provider,
  fast: new JevProvider(config.systemOne.apiKey, config.systemOne.model, fetcher, config.systemOne.baseUrl), slow: null });
runtime.state.agent.needs.energy = 45;
runtime.setNativeVoice(true);
const bridge = new VoiceBridge(runtime, runtime.state.epoch, 'agent-package-live', Date.now() + 90000);
let sequence = 0, result = 'failed';
const respond = async (text: string) => {
  sequence++;
  assert.equal(bridge.event({ type: 'input', sequence, itemId: `fixture-${sequence}`, text, source: 'text' }), true);
  await delay(Math.max(0, (runtime.state.scheduler.lastRequestAt ?? 0) + 1005 - Date.now()));
  await runtime.decide();
  assert.equal(runtime.state.error, null);
  assert.equal(runtime.state.deciding, false);
};
const finish = () => {
  for (let tick = 0; tick < 1200 && runtime.state.agent.action; tick++) runtime.tick(0.1);
  assert.equal(runtime.state.agent.action, null);
};
try {
  assert.equal(bridge.observation(0).observedObject, null);
  await respond('床是什么颜色，你还记得吗？');
  assert.equal(runtime.state.agent.action, null);
  await respond('你过去看一下呀。');
  assert.equal(runtime.snapshot().agent.action?.id, 'approach');
  assert.equal(runtime.conversationContext().currentAction?.call.target, 'bed');
  assert.equal(bridge.observation(sequence).observedObject, null);
  finish();
  assert.deepEqual(runtime.state.agent.position, ACTIONS.sleep.destination);
  assert.equal(runtime.state.outcomes.at(-1)?.action, 'approach');
  assert.equal(bridge.observation(sequence).observedObject?.object, '床');
  const beforeSleep = runtime.state.agent.needs.energy;
  await respond('请睡一会儿。');
  assert.equal(runtime.conversationContext().currentAction?.call.capability, 'use');
  finish(); assert.ok(runtime.state.agent.needs.energy > beforeSleep + 30);
  await respond('去书架旁边看看。');
  assert.equal(runtime.conversationContext().currentAction?.call.target, 'bookshelf');
  runtime.tick(0.1);
  const interruptedId = runtime.conversationContext().currentAction!.id;
  await respond('不去书架了，改去沙发旁边看看。');
  assert.equal(runtime.conversationContext().currentAction?.call.target, 'sofa');
  assert.equal(runtime.conversationContext().receipts.find(receipt => receipt.id === interruptedId)?.status, 'cancelled');
  finish(); result = 'passed';
} finally {
  const report = { result, verifiedAt: new Date().toISOString(), sdk: '@system-one-ai/sdk@0.5.2',
    realJev: true, realAudio: false, realLLM: false, physics: 'real Home executor; simulation ticks advanced manually',
    requests, turns: runtime.state.turns, executions: runtime.conversationContext().receipts,
    decisions: runtime.state.traces.filter(trace => trace.kind === 'decision'), outcomes: runtime.state.outcomes };
  bridge.close(); runtime.stop();
  const output = join(directory, 'test-results/agent-live'); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, `verification-${Date.now()}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ result, requests, realJev: true, realAudio: false, realLLM: false,
    executions: report.executions.map(receipt => ({ call: receipt.call, status: receipt.status })) }, null, 2));
}
