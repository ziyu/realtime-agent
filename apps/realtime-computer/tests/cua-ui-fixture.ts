import { setTimeout as delay } from 'node:timers/promises';
import type { DecisionResult, DecisionPolicy, SlowThinker } from '@realtime-agent/agent';
import type { CuaConnection } from '../server/cua-policy.js';
import type { CuaResult, CuaTool } from '../server/cua-transport.js';
import type { ComputerProviders } from '../server/cua-models.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC', 'base64');
const image = { mimeType: 'image/png', dataBase64: png.toString('base64') };
const objectSchema = { type: 'object', properties: {}, additionalProperties: true } as const;

const tool = (name: string): CuaTool => ({ name, description: `Fixture ${name}`, inputSchema: { ...objectSchema } });

function ok(data: unknown, images: CuaResult['images'] = []): CuaResult {
  return { text: 'fixture ok', data, images, isError: false };
}

function idleDecision(): DecisionResult {
  return { selection: { kind: 'wait' }, channels: { computer: { kind: 'continue' } }, interrupt: false,
    think: false, acceptProposal: false, complete: false, metadata: { source: 'fixture-agent' } };
}

export const fixtureProviders: ComputerProviders = {
  fast: { async decide() { return idleDecision(); } } satisfies DecisionPolicy,
  slow: { async think() { return { summary: 'fixture planner is intentionally idle', suggestions: [] }; } } satisfies SlowThinker,
};

export class CuaUiFixture implements CuaConnection {
  readonly tools = ['list_apps', 'list_windows', 'get_desktop_state', 'get_window_state', 'click', 'scroll', 'type_text', 'press_key', 'hotkey'].map(tool);
  readonly metadata = { driverVersion: 'fixture-cua-0.28.2', platform: 'win32' };
  private desktopReads = 0;
  private releaseSlowScreen!: () => void;
  private slowScreen = new Promise<void>(resolve => { this.releaseSlowScreen = resolve; });
  screenWaiting = false;
  closed = false;

  releaseScreen(): void { this.releaseSlowScreen(); }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    signal?.throwIfAborted();
    if (name === 'list_apps') return ok({ apps: [{ name: 'Fixture', launch_path: 'fixture.exe' }] });
    if (name === 'list_windows') return ok({ windows: [
      { window_id: 101, pid: 501, title: 'Fixture Editor', app_name: 'Fixture', z_index: 2, minimized: false },
      { window_id: 202, pid: 502, title: 'Fixture Dialog', app_name: 'Fixture', z_index: 1, minimized: false },
    ] });
    if (name === 'get_desktop_state') {
      this.desktopReads++;
      if (this.desktopReads === 1) return ok({ capture_id: 'startup-desktop' });
      if (this.desktopReads === 2) {
        this.screenWaiting = true;
        await Promise.race([this.slowScreen, new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
        signal?.throwIfAborted();
        return { text: 'fixture screen failure', data: null, images: [], isError: true, errorCode: 'fixture_screen' };
      }
      return ok({ capture_id: `desktop-${this.desktopReads}` }, [image]);
    }
    if (name === 'get_window_state') return ok({ capture_id: `window-${String(args.window_id ?? '')}` }, [image]);
    if (['click', 'scroll', 'type_text', 'press_key', 'hotkey'].includes(name)) return ok({ executed: true });
    return { text: `unsupported fixture tool: ${name}`, data: null, images: [], isError: true, errorCode: 'fixture_unsupported' };
  }

  async close(): Promise<void> { this.closed = true; this.releaseSlowScreen(); }
}

export async function until(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 7000): Promise<void> {
  const started = performance.now();
  while (!await check()) {
    if (performance.now() - started > timeoutMs) throw new Error(message);
    await delay(20);
  }
}
