import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionRuntime, AgentError } from '../src/index.js';
import { room, scope } from './fixture.js';

test('move, inspect and use have separate lifecycle and effects', () => {
  const f = room(), body = new ActionRuntime({ capabilities: f.capabilities, id: f.id });
  assert.throws(() => body.start({ capability: 'inspect', target: 'bed' }, scope(), f.state), AgentError);
  const moving = body.start({ capability: 'move_to', target: 'bed' }, scope(), f.state);
  assert.equal(moving.status, 'running'); assert.equal(f.state.position, 0);
  assert.equal(body.tick(f.state, 1), null); assert.equal(f.state.position, 2);
  const arrived = body.tick(f.state, 1)!;
  assert.equal(arrived.status, 'completed'); assert.equal(f.state.energy, 30);
  assert.deepEqual(arrived.result, { arrived: 'bed' });
  body.start({ capability: 'inspect', target: 'bed' }, scope(), f.state);
  assert.deepEqual(body.tick(f.state, 0.1)?.result, { color: 'brown', object: 'bed' });
  body.start({ capability: 'use', target: 'bed' }, scope(), f.state);
  body.tick(f.state, 1); assert.equal(f.state.energy, 30);
  body.tick(f.state, 1); assert.equal(f.state.energy, 50);
  body.tick(f.state, 100); assert.equal(f.state.completedUses, 1);
  assert.equal(body.history.length, 3);
});

test('invalid replacement preserves the current execution; cancellation never grants use effects', () => {
  const f = room(), body = new ActionRuntime({ capabilities: f.capabilities, id: f.id });
  const original = body.start({ capability: 'move_to', target: 'bed' }, scope(), f.state);
  body.tick(f.state, 0.5);
  assert.throws(() => body.start({ capability: 'use', target: 'bed' }, scope('new'), f.state), AgentError);
  assert.equal(body.current?.id, original.id); assert.equal(f.state.position, 1);
  body.start({ capability: 'move_to', target: 'bookshelf' }, scope('new'), f.state);
  assert.equal(body.history[0].status, 'cancelled'); assert.equal(f.state.energy, 30);
  body.tick(f.state, 0.5); assert.equal(f.state.position, 0);
  assert.equal(body.current?.call.target, 'bookshelf');
});

test('attention holds preserve progress and do not consume execution timeout', () => {
  const f = room(), body = new ActionRuntime({ capabilities: f.capabilities, maxExecutionSeconds: 3 });
  body.start({ capability: 'move_to', target: 'bed' }, scope(), f.state);
  body.tick(f.state, 0.5); body.hold(); body.tick(f.state, 500);
  assert.equal(f.state.position, 1); assert.equal(body.current?.elapsedSeconds, 0.5);
  body.continue(scope('turn-2')); assert.equal(body.tick(f.state, 1.5)?.status, 'completed');
  assert.equal(body.history[0].scope.turnId, 'turn-2');
});

test('completed receipt snapshots cannot forge future state or repeat effects', () => {
  const f = room(), body = new ActionRuntime({ capabilities: f.capabilities });
  body.start({ capability: 'move_to', target: 'bed' }, scope(), f.state);
  const snapshot = body.current!; snapshot.status = 'completed'; snapshot.call.target = 'bookshelf';
  assert.equal(body.current?.status, 'running'); assert.equal(body.current?.call.target, 'bed');
  body.tick(f.state, 2); body.history[0].scope.turnId = 'forged';
  assert.equal(body.history[0].scope.turnId, 'turn-1');
});

test('timeouts, executor errors and bad progress produce sanitized failures', () => {
  for (const failure of ['timeout', 'throw', 'progress']) {
    const f = room();
    const body = new ActionRuntime({ maxExecutionSeconds: 1, capabilities: [{ id: 'test', prepare: () => ({
      step() {
        if (failure === 'throw') throw new Error('private-secret');
        return { status: 'running' as const, progress: failure === 'progress' ? NaN : 0 };
      },
    }) }] });
    body.start({ capability: 'test' }, scope(), f.state);
    const ended = body.tick(f.state, failure === 'timeout' ? 2 : 0.1);
    assert.equal(ended?.status, 'failed'); assert.equal(body.current, null);
    assert.equal(JSON.stringify(ended).includes('private-secret'), false);
  }
});

test('failed cancellation never starts an overlapping replacement', () => {
  let starts = 0;
  const body = new ActionRuntime({ capabilities: [{ id: 'device', prepare: () => ({
    start() { starts++; }, step() { return { status: 'running' }; }, cancel() { throw new Error('device did not stop'); },
  }) }] });
  body.start({ capability: 'device', target: 'first' }, scope(), {});
  assert.throws(() => body.start({ capability: 'device', target: 'second' }, scope(), {}), AgentError);
  assert.equal(starts, 1); assert.equal(body.current?.status, 'failed');
  assert.throws(() => body.start({ capability: 'device', target: 'third' }, scope(), {}), AgentError);
  assert.equal(starts, 1);
});

test('unregistered capabilities and invalid time deltas fail before changing the world', () => {
  const f = room(), body = new ActionRuntime({ capabilities: f.capabilities });
  assert.throws(() => body.start({ capability: 'teleport' }, scope(), f.state), AgentError);
  assert.throws(() => body.tick(f.state, NaN), AgentError);
  assert.throws(() => body.tick(f.state, -1), AgentError);
  assert.equal(f.state.position, 0);
});
