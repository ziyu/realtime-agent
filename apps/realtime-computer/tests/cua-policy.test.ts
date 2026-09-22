import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentError } from '@realtime-agent/agent';
import { ComputerTools, checkCompletion, compactData, computerPlanSchema, jsonPointer } from '../server/cua-policy.js';
import type { ComputerEvidence, ComputerPlan } from '../server/cua-policy.js';
import { installedToolSubset } from './cua-fixture.js';

const installed = await installedToolSubset(['list_apps', 'list_windows', 'get_window_state', 'get_desktop_state', 'type_text', 'click', 'verify_state']);

test('ComputerTools uses installed schemas, strips host fields, and rejects absent/invalid capabilities', () => {
  const tools = new ComputerTools(installed);
  const windowSchema = tools.modelCatalog().find(tool => tool.name === 'get_window_state')!.inputSchema as any;
  assert.equal(windowSchema.additionalProperties, false);
  assert.equal(windowSchema.properties.session, undefined);
  assert.equal(windowSchema.properties.screenshot_out_file, undefined);
  assert.deepEqual(windowSchema.required, ['pid', 'window_id']);

  assert.throws(() => tools.validate({ tool: 'shutdown', arguments: {}, purpose: 'not exposed' }),
    error => error instanceof AgentError && error.code === 'unsupported_cua_tool');
  assert.throws(() => tools.validate({ tool: 'get_window_state', arguments: { pid: 42 }, purpose: 'missing hwnd' }),
    error => error instanceof AgentError && error.code === 'invalid_cua_arguments');
  assert.throws(() => tools.validate({ tool: 'get_window_state', arguments: { pid: 42, window_id: 7, session: 'model-owned' }, purpose: 'host field' }),
    error => error instanceof AgentError && ['invalid_cua_arguments', 'host_only'].includes(error.code));
  assert.throws(() => tools.validate({ tool: 'get_window_state', arguments: { pid: 42, window_id: 7, max_elements: 1001 }, purpose: 'oversized tree' }),
    error => error instanceof AgentError && error.code === 'capture_limit');
  assert.throws(() => tools.validate({ tool: 'type_text', arguments: { text: 'x', target: { kind: 'window', pid: 'wrong', window_id: 7 } }, purpose: 'bad target' }),
    error => error instanceof AgentError && error.code === 'invalid_cua_arguments');
});

test('JSON pointer follows RFC6901 escaping and rejects prototype traversal', () => {
  const value = Object.create(null) as Record<string, unknown>;
  value['a/b'] = { '~key': 'escaped' };
  value.arr = [{ value: 'first' }];
  Object.defineProperty(value, '__proto__', { value: { leaked: true }, enumerable: true });
  assert.equal(jsonPointer(value, '/a~1b/~0key'), 'escaped');
  assert.equal(jsonPointer(value, '/arr/0/value'), 'first');
  assert.equal(jsonPointer(value, '/__proto__/leaked'), undefined);
  assert.equal(jsonPointer(value, '/constructor/name'), undefined);
  assert.equal(jsonPointer(value, 'arr/0'), undefined);
});

test('completion requires fresh evidence-tool data and never treats an action receipt as business completion', () => {
  const now = Date.now(), taskStartedAt = now - 1000;
  const completion = (evidenceId: string): ComputerPlan => ({ summary: 'verified', steps: [], blocked: null,
    completion: { summary: 'saved result verified', checks: [
      { evidenceId, pointer: '/elements/0/value', operator: 'equals', expected: 'done', description: 'editor content' },
      { evidenceId, pointer: '/window_title', operator: 'contains', expected: 'note.txt', description: 'saved filename' },
    ] } });
  const evidence = (id: string, tool: string, capturedAt = now): ComputerEvidence => ({ id, taskId: 'task-1', tool, arguments: {}, capturedAt,
    data: { window_title: 'note.txt - Notepad', elements: [{ value: 'done' }] }, text: '', isError: false, truncated: false });

  assert.equal(checkCompletion(completion('fresh'), [evidence('fresh', 'get_window_state')], taskStartedAt, 'task-1'), true);
  assert.equal(checkCompletion(completion('wrong-task'), [{ ...evidence('wrong-task', 'get_window_state'), taskId: 'old-task' }], taskStartedAt, 'task-1'), false);
  assert.equal(checkCompletion(completion('action'), [evidence('action', 'type_text')], taskStartedAt), false);
  assert.equal(checkCompletion(completion('stale'), [evidence('stale', 'get_window_state', taskStartedAt - 1)], taskStartedAt), false);
  assert.equal(checkCompletion(completion('failed'), [{ ...evidence('failed', 'get_window_state'), isError: true }], taskStartedAt), false);
});

test('compactData removes image/tree payloads without changing surviving JSON paths', () => {
  const projected = compactData({ elements: [{ value: 'keep' }], nested: { screenshot_base64: 'secret-image', tree_markdown: 'huge tree', state: 'saved' } }, 5000);
  assert.equal(jsonPointer(projected.data, '/elements/0/value'), 'keep');
  assert.equal(jsonPointer(projected.data, '/nested/state'), 'saved');
  assert.equal(jsonPointer(projected.data, '/nested/screenshot_base64'), undefined);
  assert.equal(jsonPointer(projected.data, '/nested/tree_markdown'), undefined);
});

test('visual completion permits empty checks only with visual grounding and requires matching fresh current-task image evidence', () => {
  const now = Date.now(), taskStartedAt = now - 1000;
  const visualPlan: ComputerPlan = { summary: 'visually verified', steps: [], blocked: null,
    completion: { summary: 'looks correct', checks: [], visual: { evidenceId: 'img-1', description: 'The requested result is visibly present.' } } };
  const imageEvidence = (overrides: Partial<ComputerEvidence> = {}): ComputerEvidence => ({ id: 'img-1', taskId: 'task-1', tool: 'get_window_state',
    arguments: { pid: 42, window_id: 7 }, capturedAt: now, data: { window_title: 'fixture' }, text: '', isError: false, truncated: false, ...overrides });

  assert.equal(computerPlanSchema.safeParse({ summary: 'invalid', steps: [], blocked: null,
    completion: { summary: 'no proof', checks: [] } }).success, false, 'empty checks without visual evidence must be rejected');
  assert.equal(computerPlanSchema.safeParse(visualPlan).success, true);
  assert.equal(checkCompletion(visualPlan, [imageEvidence()], taskStartedAt, 'task-1', 'img-1'), true);
  assert.equal(checkCompletion(visualPlan, [imageEvidence({ taskId: 'old-task' })], taskStartedAt, 'task-1', 'img-1'), false);
  assert.equal(checkCompletion(visualPlan, [imageEvidence({ capturedAt: taskStartedAt - 1 })], taskStartedAt, 'task-1', 'img-1'), false);
  assert.equal(checkCompletion(visualPlan, [imageEvidence({ tool: 'type_text' })], taskStartedAt, 'task-1', 'img-1'), false,
    'a non-image action receipt cannot satisfy a visual completion');
  assert.equal(checkCompletion(visualPlan, [], taskStartedAt, 'task-1', 'img-1'), false);
  assert.equal(checkCompletion(visualPlan, [imageEvidence()], taskStartedAt, 'task-1'), false, 'missing current imageEvidenceId must fail closed');
  assert.equal(checkCompletion(visualPlan, [imageEvidence()], taskStartedAt, 'task-1', 'different-image'), false);
});
