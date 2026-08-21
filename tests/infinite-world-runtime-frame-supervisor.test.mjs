import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeFrameSupervisor } from '../src/infinite-world/runtime-frame-supervisor.js';

function createFrameQueue() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    request(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
    runNext(now) {
      const entry = callbacks.entries().next().value;
      assert.ok(entry, 'one pending animation callback is required');
      callbacks.delete(entry[0]);
      entry[1](now);
    },
    get pendingCount() {
      return callbacks.size;
    },
  };
}

test('runtime frame supervisor keeps exactly one callback after a fatal frame fault', () => {
  const queue = createFrameQueue();
  const observed = [];
  const supervisor = createRuntimeFrameSupervisor({
    requestAnimationFrame: callback => queue.request(callback),
    cancelAnimationFrame: id => queue.cancel(id),
    onFrame() {
      throw new Error('injected frame fault');
    },
    onFault: error => observed.push(error.message),
  });

  assert.equal(supervisor.start(), true);
  assert.equal(queue.pendingCount, 1);
  queue.runNext(16.67);
  assert.equal(queue.pendingCount, 1);
  assert.deepEqual(observed, ['injected frame fault']);
  assert.deepEqual(supervisor.snapshot(), {
    schemaVersion: 'runtime-frame-supervisor-1',
    running: true,
    faulted: true,
    pending: true,
    dispatchCount: 1,
    completedFrameCount: 0,
    fault: { name: 'Error', message: 'injected frame fault' },
    faultHandlerError: null,
  });

  queue.runNext(33.34);
  assert.equal(queue.pendingCount, 1);
  assert.equal(supervisor.snapshot().dispatchCount, 2);
  assert.deepEqual(observed, ['injected frame fault']);
});

test('runtime frame supervisor schedules once per completed frame and cancels shutdown work', () => {
  const queue = createFrameQueue();
  const frames = [];
  const supervisor = createRuntimeFrameSupervisor({
    requestAnimationFrame: callback => queue.request(callback),
    cancelAnimationFrame: id => queue.cancel(id),
    onFrame: now => frames.push(now),
    onFault() {
      assert.fail('normal frames must not report a fault');
    },
  });

  supervisor.start();
  queue.runNext(10);
  queue.runNext(20);
  assert.deepEqual(frames, [10, 20]);
  assert.equal(queue.pendingCount, 1);
  assert.equal(supervisor.stop(), true);
  assert.equal(queue.pendingCount, 0);
  assert.equal(supervisor.snapshot().running, false);
});

test('fault reporting failures cannot terminate the supervisor callback chain', () => {
  const queue = createFrameQueue();
  const supervisor = createRuntimeFrameSupervisor({
    requestAnimationFrame: callback => queue.request(callback),
    cancelAnimationFrame: id => queue.cancel(id),
    onFrame() {
      throw new TypeError('world tick failed');
    },
    onFault() {
      throw new Error('fault observer failed');
    },
  });

  supervisor.start();
  queue.runNext(1);
  assert.equal(queue.pendingCount, 1);
  assert.deepEqual(supervisor.snapshot().faultHandlerError, {
    name: 'Error', message: 'fault observer failed',
  });
});
