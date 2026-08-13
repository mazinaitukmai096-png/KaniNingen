import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORLD_GENERATION_REQUEST_SCHEMA,
  WORLD_GENERATION_SCHEDULER_SCHEMA,
  WORLD_GENERATION_STATE,
  createWorldGenerationRequestEnvelope,
  createWorldGenerationScheduler,
} from '../src/infinite-world/world-generation-scheduler.js';

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

async function drain() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

function envelope(requestId, {
  priority = 3,
  required = priority <= 3,
  createdAtMs = 0,
  deadlineAtMs = null,
  operationKind = 'test',
  priorityClass = null,
  ownerKey = null,
  resourceKind = null,
  representationClass = null,
  sequence = null,
  subscriberIdentity = null,
} = {}) {
  return createWorldGenerationRequestEnvelope({
    requestId,
    operationKind,
    priority,
    priorityClass,
    required,
    createdAtMs,
    deadlineAtMs,
    firstVisibleDeadlineMs: deadlineAtMs,
    ownerKey,
    resourceKind,
    representationClass,
    sequence,
    subscriberIdentity,
    consumerId: 'phase-4-test',
    epoch: 1,
  });
}

test('unified request envelope is immutable and carries global owner ordering identity', () => {
  const value = envelope(1, {
    priority: 2,
    priorityClass: 1,
    deadlineAtMs: 100,
    ownerKey: '3,-4',
    resourceKind: 'full',
    representationClass: 'detail',
    sequence: 9,
    subscriberIdentity: 'runtime:7',
  });
  assert.equal(value.schemaVersion, WORLD_GENERATION_REQUEST_SCHEMA);
  assert.equal(value.operationKind, 'test');
  assert.equal(value.priority, 2);
  assert.equal(value.required, true);
  assert.equal(value.deadlineAtMs, 100);
  assert.equal(value.firstVisibleDeadlineMs, 100);
  assert.equal(value.ownerKey, '3,-4');
  assert.equal(value.resourceKind, 'full');
  assert.equal(value.representationClass, 'detail');
  assert.equal(value.priorityClass, 1);
  assert.equal(value.sequence, 9);
  assert.equal(value.subscriberIdentity, 'runtime:7');
  assert.equal(Object.isFrozen(value), true);
  assert.throws(() => envelope(2, { priority: 0 }), /priority/);
  assert.throws(() => envelope(3, { deadlineAtMs: -1 }), /deadlineAtMs/);
});

test('single Worker scheduler dispatches strict priority order with FIFO ties', async () => {
  const order = [];
  const scheduler = createWorldGenerationScheduler({ clock: () => 0 });
  const requests = [5, 3, 1, 2, 1].map((priority, index) => scheduler.schedule({
    envelope: envelope(index + 1, { priority }),
    execute: async () => { order.push(`${priority}:${index}`); return index; },
  }));
  const results = await Promise.all(requests.map(request => request.promise));
  assert.deepEqual(order, ['1:2', '1:4', '2:3', '3:1', '5:0']);
  assert.deepEqual(results.map(result => result.state), Array(5).fill(WORLD_GENERATION_STATE.COMPLETED));
  assert.equal(scheduler.snapshot().workerCount, 1);
  await scheduler.shutdown();
});

test('priority aging lets an older warm request run before a continuous new required request', async () => {
  let now = 0;
  const gate = deferred();
  const order = [];
  const scheduler = createWorldGenerationScheduler({
    clock: () => now,
    agingIntervalMs: 100,
  });
  const blocker = scheduler.schedule({
    envelope: envelope(1, { priority: 1 }),
    execute: async () => { order.push('blocker'); await gate.promise; },
  });
  await drain();
  const warm = scheduler.schedule({
    envelope: envelope(2, { priority: 5, required: false, createdAtMs: now }),
    execute: async () => { order.push('aged-warm'); },
  });
  now = 500;
  const required = scheduler.schedule({
    envelope: envelope(3, { priority: 1, createdAtMs: now }),
    execute: async () => { order.push('new-required'); },
  });
  gate.resolve();
  await Promise.all([blocker.promise, warm.promise, required.promise]);
  assert.deepEqual(order, ['blocker', 'aged-warm', 'new-required']);
  assert.equal(warm.promise.then instanceof Function, true);
  const snapshot = scheduler.snapshot();
  assert.ok(snapshot.counts.agedStarts >= 1);
  assert.ok(snapshot.counts.agingSteps >= 5);
  await scheduler.shutdown();
});

test('global semantic classes prevent aged prefetch from crossing Terrain safety', async () => {
  let now = 0;
  const gate = deferred();
  const order = [];
  const scheduler = createWorldGenerationScheduler({ clock: () => now, agingIntervalMs: 10 });
  const blocker = scheduler.schedule({
    envelope: envelope(1, { priority: 1 }),
    execute: () => gate.promise,
  });
  await drain();
  const prefetch = scheduler.schedule({
    envelope: envelope(2, {
      priority: 5,
      priorityClass: 5,
      required: false,
      createdAtMs: 0,
      ownerKey: '9,9',
      resourceKind: 'presentation',
      representationClass: 'coarse',
      sequence: 2,
    }),
    execute: async () => { order.push('prefetch'); },
  });
  now = 1_000;
  const terrain = scheduler.schedule({
    envelope: envelope(3, {
      priority: 2,
      priorityClass: 1,
      createdAtMs: now,
      ownerKey: '0,0',
      resourceKind: 'full',
      representationClass: 'detail',
      sequence: 3,
    }),
    execute: async () => { order.push('terrain'); },
  });
  gate.resolve();
  await Promise.all([blocker.promise, prefetch.promise, terrain.promise]);
  assert.deepEqual(order, ['terrain', 'prefetch']);
  await scheduler.shutdown();
});

test('a missed deadline is dispatched before non-expired queued work and is counted', async () => {
  let now = 0;
  const gate = deferred();
  const order = [];
  const scheduler = createWorldGenerationScheduler({ clock: () => now });
  const blocker = scheduler.schedule({
    envelope: envelope(1, { priority: 1 }),
    execute: async () => gate.promise,
  });
  await drain();
  const normal = scheduler.schedule({
    envelope: envelope(2, { priority: 1 }),
    execute: async () => { order.push('normal'); },
  });
  const deadline = scheduler.schedule({
    envelope: envelope(3, { priority: 5, required: false, deadlineAtMs: 10 }),
    execute: async () => { order.push('deadline'); },
  });
  now = 20;
  gate.resolve();
  await Promise.all([blocker.promise, normal.promise, deadline.promise]);
  assert.deepEqual(order, ['deadline', 'normal']);
  assert.ok(scheduler.snapshot().counts.deadlineMisses >= 1);
  await scheduler.shutdown();
});

test('queued cancellation never executes and reaches a bounded terminal state', async () => {
  let now = 0;
  const gate = deferred();
  const scheduler = createWorldGenerationScheduler({
    clock: () => now,
    terminalRetentionMs: 50,
  });
  const blocker = scheduler.schedule({
    envelope: envelope(1),
    execute: async () => gate.promise,
  });
  await drain();
  let executed = false;
  const queued = scheduler.schedule({
    envelope: envelope(2),
    execute: async () => { executed = true; },
  });
  assert.equal(queued.cancel('stale-plan'), true);
  const result = await queued.promise;
  assert.equal(result.state, WORLD_GENERATION_STATE.CANCELLED);
  assert.equal(result.cancellationReason, 'stale-plan');
  assert.equal(executed, false);
  assert.equal(scheduler.snapshot().counts.queuedCancelled, 1);
  gate.resolve();
  await blocker.promise;
  now = 51;
  assert.equal(scheduler.snapshot().terminal.length, 0);
  await scheduler.shutdown();
});

test('in-flight cancellation is observed at a cooperative checkpoint', async () => {
  const gate = deferred();
  const scheduler = createWorldGenerationScheduler({ clock: () => 0 });
  let cancelReason = null;
  const active = scheduler.schedule({
    envelope: envelope(1),
    execute: async ({ checkpoint }) => {
      await gate.promise;
      checkpoint();
      return 'must-not-complete';
    },
    onCancel: reason => { cancelReason = reason; },
  });
  await drain();
  assert.equal(active.state, WORLD_GENERATION_STATE.IN_FLIGHT);
  assert.equal(active.cancel('owner-superseded'), true);
  assert.equal(cancelReason, 'owner-superseded');
  gate.resolve();
  const result = await active.promise;
  assert.equal(result.state, WORLD_GENERATION_STATE.CANCELLED);
  assert.equal(result.value, null);
  assert.equal(scheduler.snapshot().counts.inFlightCancelled, 1);
  await scheduler.shutdown();
});

test('failed, completed, and shutdown-cancelled operations have explicit terminal states', async () => {
  const gate = deferred();
  const scheduler = createWorldGenerationScheduler({ clock: () => 0 });
  const completed = scheduler.schedule({
    envelope: envelope(1),
    execute: async () => 'ok',
  });
  assert.equal((await completed.promise).state, WORLD_GENERATION_STATE.COMPLETED);
  const failed = scheduler.schedule({
    envelope: envelope(2),
    execute: async () => { throw new Error('injected'); },
  });
  const failedResult = await failed.promise;
  assert.equal(failedResult.state, WORLD_GENERATION_STATE.FAILED);
  assert.match(failedResult.error.message, /injected/);
  const active = scheduler.schedule({
    envelope: envelope(3),
    execute: async ({ checkpoint }) => { await gate.promise; checkpoint(); },
  });
  await drain();
  const shutdown = scheduler.shutdown({ reason: 'test-shutdown' });
  gate.resolve();
  await shutdown;
  assert.equal((await active.promise).state, WORLD_GENERATION_STATE.CANCELLED);
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.schemaVersion, WORLD_GENERATION_SCHEDULER_SCHEMA);
  assert.equal(snapshot.isShutdown, true);
  assert.equal(snapshot.backlog, 0);
  assert.deepEqual(snapshot.counts, {
    scheduled: 3,
    started: 3,
    completed: 1,
    cancelled: 1,
    failed: 1,
    queuedCancelled: 0,
    inFlightCancelled: 1,
    deadlineMisses: 0,
    agedStarts: 0,
    agingSteps: 0,
  });
});

test('request execution order never changes deterministic content identity', async () => {
  const run = async priorities => {
    const scheduler = createWorldGenerationScheduler({ clock: () => 0 });
    const handles = priorities.map(({ requestId, priority, owner }) => scheduler.schedule({
      envelope: envelope(requestId, { priority }),
      execute: async () => Object.freeze({
        owner,
        contentHash: `sha256:${owner.padEnd(64, '0')}`,
      }),
    }));
    const values = (await Promise.all(handles.map(handle => handle.promise)))
      .map(result => result.value)
      .sort((left, right) => left.owner.localeCompare(right.owner));
    await scheduler.shutdown();
    return values;
  };
  const forward = await run([
    { requestId: 1, priority: 5, owner: '0,0' },
    { requestId: 2, priority: 1, owner: '1,0' },
  ]);
  const reverse = await run([
    { requestId: 3, priority: 1, owner: '1,0' },
    { requestId: 4, priority: 5, owner: '0,0' },
  ]);
  assert.deepEqual(reverse, forward);
});
