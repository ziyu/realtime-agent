import type { DecisionResult } from '@realtime-agent/agent';
import type { CuaConnection, ComputerPlan } from '../server/cua-policy.js';
import type { CuaResult, CuaTool } from '../server/cua-transport.js';
import type { ComputerProviders } from '../server/cua-models.js';

/** No installed native SDK, credentials, browser, or model network is used. */
export class ApiDesktop implements CuaConnection {
  readonly metadata = { driverVersion: 'api-fixture', platform: 'fixture' };
  readonly tools: CuaTool[] = [
    { name: 'list_windows', description: 'Read available windows', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_desktop_state', description: 'Read current desktop', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_window_state', description: 'Read selected window', inputSchema: { type: 'object', properties: {
      pid: { type: 'integer' }, window_id: { type: 'integer' },
    }, required: ['pid', 'window_id'] } },
    { name: 'type_text', description: 'Deliver text', inputSchema: { type: 'object', properties: {
      text: { type: 'string' }, target: { type: 'object' }, delivery_mode: { type: 'string' },
    }, required: ['text'] } },
  ];
  value = '';
  calls: string[] = [];
  delayedInput: Promise<void> | null = null;
  inputStarted = false;
  inputAborted = false;
  closed = false;
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaResult> {
    signal?.throwIfAborted(); this.calls.push(name);
    let data: unknown;
    if (name === 'list_windows') data = { windows: [{ window_id: 501, pid: 55, app_name: 'Application', title: 'Task fixture', z_index: 1 }] };
    else if (name === 'get_desktop_state') data = { visible: true };
    else if (name === 'get_window_state') data = { window_id: 501, pid: 55, value: this.value };
    else if (name === 'type_text') {
      this.inputStarted = true;
      const onAbort = () => { this.inputAborted = true; };
      signal?.addEventListener('abort', onAbort, { once: true });
      try { if (this.delayedInput) await this.delayedInput; this.value = String(args.text); }
      finally { signal?.removeEventListener('abort', onAbort); }
      data = { delivered: true };
    } else throw new Error(`Unexpected fixture operation ${name}`);
    return { text: 'fixture response', data, isError: false, images: [] };
  }
  async close() { this.closed = true; }
}

const idle = (): DecisionResult => ({ selection: { kind: 'wait' }, channels: { computer: { kind: 'continue' } },
  interrupt: false, think: false, acceptProposal: false, complete: false });

export function apiProviders(mode: 'complete' | 'idle' | 'blocked' = 'complete'): ComputerProviders {
  return {
    fast: { async decide(context) {
      const state = context.observation as any, result = idle();
      if (mode === 'idle' || context.thinking || context.channels?.computer.current || state.task?.status !== 'active') return result;
      if (context.proposal && !context.proposal.accepted) {
        const plan = (context.proposal.value.metadata as any).plan;
        result.acceptProposal = true; result.complete = !!plan.completion;
        result.metadata = { route: plan.completion ? 'finish' : plan.blocked ? 'blocked' : 'accept_plan' };
      } else {
        const candidate = context.channels?.computer.candidates.find(item => item.selection.kind === 'execute');
        if (candidate) result.channels!.computer = candidate.selection;
        else { result.think = true; result.metadata = { route: 'plan' }; }
      }
      return result;
    } },
    slow: { async think(context) {
      const state = context.observation as any;
      let plan: ComputerPlan;
      const found = [...state.evidence].reverse().find((item: any) => item.taskId === state.task.id && item.tool === 'get_window_state' && item.data.value === state.task.text);
      if (mode === 'blocked') plan = { summary: 'More input is required', steps: [], completion: null, blocked: 'fixture needs input' };
      else if (found) plan = { summary: 'Observed requested result', steps: [], blocked: null,
        completion: { summary: 'Verified requested result', checks: [{ evidenceId: found.id, pointer: '/value', operator: 'equals', expected: state.task.text, description: 'requested state' }] } };
      else if (state.recentActions.some((item: any) => item.tool === 'type_text' && item.arguments.text === state.task.text)) plan = { summary: 'Observe result', blocked: null, completion: null,
        steps: [{ tool: 'get_window_state', arguments: { pid: 55, window_id: 501 }, purpose: 'Verify state' }] };
      else plan = { summary: 'Perform requested operation', blocked: null, completion: null,
        steps: [{ tool: 'type_text', arguments: { text: state.task.text }, purpose: 'Apply the goal in the injected environment' }] };
      return { summary: plan.summary, suggestions: [], metadata: JSON.parse(JSON.stringify({ taskId: state.task.id, plan })) };
    } },
  };
}

export async function until(check: () => boolean | Promise<boolean>, message = 'Condition timed out', ms = 6000) {
  const start = performance.now();
  while (!await check()) {
    if (performance.now() - start > ms) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
