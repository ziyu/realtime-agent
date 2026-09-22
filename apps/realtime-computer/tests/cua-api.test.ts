import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startCuaServer } from '../server/cua-app.js';
import { ApiDesktop, apiProviders, until } from './cua-api-fixture.js';

async function setup(mode: 'complete' | 'idle' | 'blocked' = 'complete') {
  const driver = new ApiDesktop();
  const session = await startCuaServer({ driver, providers: apiProviders(mode), port: 0, decisionIntervalMs: 1 });
  const api = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${session.origin}/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, location: response.headers.get('location'), body: await response.json() as any };
  };
  return { driver, session, api };
}

test('versioned API accepts a generic goal without a web page and retains evidence-backed results by ID', async () => {
  const { driver, session, api } = await setup();
  try {
    const health = await api('/health'); assert.equal(health.body.apiVersion, '1'); assert.equal(health.body.ready, true);
    const capabilities = (await api('/capabilities')).body;
    assert.equal(capabilities.tasks.maxConcurrent, 1); assert.equal(capabilities.tasks.storage, 'process-memory');
    assert.ok(capabilities.tools.some((tool: any) => tool.name === 'type_text'));
    const goal = '完成当前应用中的工作，核对结果后返回；无需预选窗口。';
    const created = await api('/tasks', { goal });
    assert.equal(created.status, 202); const id = created.body.task.id;
    assert.equal(created.location, `/api/v1/tasks/${id}`); assert.equal(created.body.task.goal, goal);
    assert.equal(session.runtime.snapshot().viewWindowId, null);
    await until(() => session.tasks.get(id).status === 'completed');
    const result = await api(`/tasks/${id}/result`);
    assert.equal(result.status, 200); assert.equal(result.body.status, 'completed');
    assert.equal(result.body.result.verification, 'observed-data'); assert.ok(result.body.result.evidenceIds.length);
    assert.equal(driver.value, goal);
    const trace = (await api(`/tasks/${id}/trace`)).body;
    assert.ok(trace.actions.some((item: any) => item.tool === 'type_text'));
    assert.ok(trace.evidence.some((item: any) => item.id === result.body.result.evidenceIds[0]));
    assert.ok(trace.actions.every((item: any) => item.taskId === id));
    await api('/tasks', { goal: '另一个独立目标' });
    assert.deepEqual((await api(`/tasks/${id}/result`)).body.result, result.body.result);
    assert.equal((await api('/tasks')).body.tasks.length, 2);
  } finally { await session.close(); }
});

test('task admission prevents concurrent goals and replays idempotent requests without repeating input', async () => {
  const { session, api, driver } = await setup('idle');
  try {
    const attempts = await Promise.all([api('/tasks', { goal: 'first' }, { 'Idempotency-Key': 'first-key' }), api('/tasks', { goal: 'second' })]);
    assert.deepEqual(attempts.map(result => result.status).sort(), [202, 409]);
    assert.equal(attempts[1].body.error.code, 'computer_busy');
    const id = attempts[0].body.task.id;
    const repeated = await api('/tasks', { goal: 'first' }, { 'Idempotency-Key': 'first-key' });
    assert.equal(repeated.status, 200); assert.equal(repeated.body.replayed, true); assert.equal(repeated.body.task.id, id);
    const conflict = await api('/tasks', { goal: 'different' }, { 'Idempotency-Key': 'first-key' });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'idempotency_conflict');
    assert.equal(driver.calls.includes('type_text'), false);
    assert.equal((await api(`/tasks/${randomUUID()}/stop`, {})).status, 404);
    assert.equal(session.runtime.snapshot().task?.id, id); assert.equal(session.tasks.get(id).status, 'active');
  } finally { await session.close(); }
});

test('stop and resume target a task ID; an old stop cannot cancel a new task and resume returns its new ID', async () => {
  const { session, api } = await setup('idle');
  try {
    const id = (await api('/tasks', { goal: 'Reusable task' })).body.task.id;
    assert.equal((await api(`/tasks/${id}/stop`, {})).body.task.status, 'cancelled');
    const resumed = await api(`/tasks/${id}/resume`, {});
    assert.equal(resumed.status, 202);
    const newId = resumed.body.task.id;
    assert.notEqual(newId, id); assert.equal(resumed.body.task.resumedFrom, id); assert.equal(resumed.body.task.goal, 'Reusable task');
    await api(`/tasks/${id}/stop`, {});
    assert.equal(session.tasks.get(newId).status, 'active');
    const conflict = await api(`/tasks/${id}/resume`, {}); assert.equal(conflict.status, 409);
    assert.equal(session.tasks.get(newId).status, 'active');
  } finally { await session.close(); }
});

test('stopping does not claim an admitted native input was undone; late receipts stay attached to its task', async () => {
  const { session, api, driver } = await setup();
  let release!: () => void; driver.delayedInput = new Promise<void>(resolve => { release = resolve; });
  try {
    const id = (await api('/tasks', { goal: 'A bounded generic operation' })).body.task.id;
    await until(() => driver.inputStarted);
    const stopped = await api(`/tasks/${id}/stop`, {});
    assert.equal(stopped.body.task.status, 'cancelled'); assert.ok(stopped.body.task.pendingOperation);
    assert.equal(stopped.body.task.result, null); assert.equal(driver.inputAborted, true);
    assert.equal((await api('/tasks', { goal: 'must not overlap' })).status, 409);
    release(); await until(() => session.tasks.get(id).pendingOperation === null);
    const trace = (await api(`/tasks/${id}/trace`)).body;
    assert.equal(trace.task.status, 'cancelled'); assert.equal(trace.task.result, null);
    assert.ok(trace.actions.some((item: any) => item.taskId === id && item.tool === 'type_text'));
  } finally { release(); await session.close(); }
});

test('legacy web submissions share the task registry while v1 errors remain machine-readable', async () => {
  const { session, api } = await setup('idle');
  try {
    const first = (await api('/tasks', { goal: 'external task' })).body.task.id;
    const response = await fetch(`${session.origin}/api/goal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'web replacement' }) });
    assert.equal(response.status, 202);
    const replacement = await response.json() as any;
    assert.equal(session.tasks.get(first).status, 'cancelled');
    assert.equal(session.tasks.get(first).supersededBy, replacement.task.id);
    assert.equal((await api('/tasks', { goal: ' ', unexpected: true })).body.error.code, 'invalid_input');
    assert.equal((await api(`/tasks/${randomUUID()}`)).body.error.code, 'task_not_found');
    assert.equal((await api('/not-a-route')).body.error.code, 'route_not_found');
    const forbidden = await api('/tasks', { goal: 'cross-origin' }, { Origin: 'https://example.test' });
    assert.equal(forbidden.status, 403); assert.equal(forbidden.body.error.code, 'forbidden_origin');
    const badJson = await fetch(`${session.origin}/api/v1/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(badJson.status, 400); assert.equal((await badJson.json() as any).error.code, 'invalid_input');
  } finally { await session.close(); }
});

test('the task archive and idempotency keys have bounded process-local retention', async () => {
  const { session, api } = await setup('idle');
  try {
    const first = (await api('/tasks', { goal: 'archive 0' }, { 'Idempotency-Key': 'archive-first' })).body.task.id;
    await api(`/tasks/${first}/stop`, {});
    for (let i = 1; i <= 32; i++) {
      const current = await api('/tasks', { goal: `archive ${i}` }); assert.equal(current.status, 202);
      await api(`/tasks/${current.body.task.id}/stop`, {});
    }
    assert.equal((await api('/tasks')).body.tasks.length, 32);
    assert.equal((await api(`/tasks/${first}`)).status, 404);
  } finally { await session.close(); }
});
