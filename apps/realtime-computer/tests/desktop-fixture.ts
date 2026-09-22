import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { desktopProviders } from '../server/desktop-providers.js';
import type { DesktopCommand, DesktopDriver, DesktopObservation } from '../server/desktop-types.js';
import type { DesktopPlan } from '../server/desktop-model.js';
import type { RuntimeConfig } from '@realtime-agent/config';

export class TestDesktop implements DesktopDriver {
  deviceSessionId = randomUUID();
  value = '';
  name = 'Editor';
  calls: DesktopCommand[] = [];
  captures = 0;
  failCapture = false;
  captureGate: Promise<void> | null = null;
  async observe(selectedWindowId: string | null = null): Promise<DesktopObservation> {
    if (this.captureGate) await this.captureGate;
    if (this.failCapture) throw new Error('Fixture capture unavailable');
    this.captures++;
    return { id: randomUUID(), capturedAt: Date.now(), selectedWindowId, foregroundWindowId: 'editor-window',
      desktop: { x: 0, y: 0, width: 1000, height: 800 },
      windows: [{ id: 'editor-window', title: 'Test editor', processId: 1, processName: 'fixture', minimized: false,
        bounds: { x: 0, y: 0, width: 600, height: 400 } },
      { id: 'other-window', title: 'Unrelated private application', processId: 2, processName: 'other', minimized: false,
        bounds: { x: 600, y: 0, width: 300, height: 400 } }],
      elements: selectedWindowId ? [{ id: 'editor', name: this.name, role: 'Edit', value: this.value,
        enabled: true, offscreen: false, bounds: { x: 10, y: 10, width: 500, height: 100 } }] : [] };
  }
  async screen() {
    return { png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC', 'base64'),
      bounds: { x: 0, y: 0, width: 600, height: 400 }, capturedAt: Date.now() };
  }
  async execute(command: DesktopCommand, _expected: DesktopObservation, signal: AbortSignal, issued?: () => void) {
    signal.throwIfAborted(); issued?.(); this.calls.push(command);
    if (command.kind === 'type') this.value += command.text;
    return this.observe(command.windowId);
  }
  async release() {}
  async close() {}
}

export const fixtureConfig: RuntimeConfig = { provider: 'direct', mode: 'live', port: 3110, dataDirectory: 'unused',
  systemOne: { apiKey: 'fixture-fast-key', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' },
  llm: { apiKey: 'fixture-slow-key', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' } };

/** Exercise the actual SDK and HTTP parsing while clearly replacing network responses only. */
export function protocolFixture(options: { choose?: (criteria: Record<string, string>) => string;
  plan?: DesktopPlan; httpStatus?: number; planningGate?: Promise<void> } = {}) {
  const routes: string[] = [], requests: unknown[] = [];
  const providers = desktopProviders(fixtureConfig, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (options.httpStatus) return new Response('fixture failure', { status: options.httpStatus });
    if (body.questions) {
      const criteria: Record<string, string> = body.questions.next_step?.criteria ?? {};
      const selected = options.choose?.(criteria) ?? (criteria.plan ? 'plan' : criteria.accept_plan ? 'accept_plan' : Object.keys(criteria).find(id => id.startsWith('execute_')) ?? 'blocked');
      routes.push(selected);
      return Response.json({ model: 'fixture-jev', answers: { next_step: { type: 'choice', choice: selected,
        confidence: 0.8, probabilities: Object.fromEntries(Object.keys(criteria).map(id => [id, id === selected ? 1 : 0])) } },
      usage: { input_tokens: 12, output_tokens: 1 } });
    }
    if (options.planningGate) await options.planningGate;
    const state = JSON.parse(body.messages[1].content);
    const plan = options.plan ?? { summary: 'Write the requested value', actions: [{ kind: 'click', elementId: 'editor' }, { kind: 'type', text: state.task.text }],
      verification: { elementId: 'editor', text: state.task.text, match: 'equals' } };
    return Response.json({ model: 'fixture-llm', choices: [{ message: { content: JSON.stringify(plan) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  } });
  return { providers, routes, requests };
}

export async function until(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 6000) {
  const start = performance.now();
  while (!await check()) {
    if (performance.now() - start > timeoutMs) throw new Error(message);
    await delay(10);
  }
}
