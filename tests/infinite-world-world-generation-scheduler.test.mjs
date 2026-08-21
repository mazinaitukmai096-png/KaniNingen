import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORLD_GENERATION_PRIORITY_CLASS,
  WORLD_GENERATION_REQUEST_SCHEMA,
  WORLD_GENERATION_SCHEDULER_SCHEMA,
  WORLD_GENERATION_STATE,
  createWorldGenerationRequestEnvelope,
  createWorldGenerationScheduler,
} from '../src/infinite-world/world-generation-scheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
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

test('overdue optional prefetch cannot cross fresh safety, coarse, or gameplay semantic work', async () => {
  let now = 0;
  const gate = deferred();
  const order = [];
  const scheduler = createWorldGenerationScheduler({ clock: () => now });
  const blocker = scheduler.schedule({
    envelope: envelope(1, { priority: 1 }),
    execute: () => gate.promise,
  });
  await drain();
  const prefetch = scheduler.schedule({
    envelope: envelope(2, {
      priority: 5,
      priorityClass: WORLD_GENERATION_PRIORITY_CLASS.PREFETCH,
      required: false,
      deadlineAtMs: 10,
    }),
    execute: async () => { order.push('overdue-prefetch'); },
  });
  now = 20;
  const gameplay = scheduler.schedule({
    envelope: envelope(3, {
      priority: 3,
      priorityClass: WORLD_GENERATION_PRIORITY_CLASS.GAMEPLAY_FULL,
      createdAtMs: now,
    }),
    execute: async () => { order.push('gameplay'); },
  });
  const coarse = scheduler.schedule({
    envelope: envelope(4, {
      priority: 2,
      priorityClass: WORLD_GENERATION_PRIORITY_CLASS.COARSE_EXISTENCE,
      createdAtMs: now,
    }),
    execute: async () => { order.push('coarse'); },
  });
  const safety = scheduler.schedule({
    envelope: envelope(5, {
      priority: 1,
      priorityClass: WORLD_GENERATION_PRIORITY_CLASS.DEADLINE_SAFETY,
      createdAtMs: now,
    }),
    execute: async () => { order.push('safety'); },
  });
  gate.resolve();
  await Promise.all([
    blocker.promise,
    prefetch.promise,
    gameplay.promise,
    coarse.promise,
    safety.promise,
  ]);
  assert.deepEqual(order, ['safety', 'coarse', 'gameplay', 'overdue-prefetch']);
  await scheduler.shutdown();
});

test('deadline urgency still orders work inside the same semantic class', async () => {
  let now = 0;
  const gate = deferred();
  const order = [];
  const scheduler = createWorldGenerationScheduler({ clock: () => now });
  const blocker = scheduler.schedule({
    envelope: envelope(1, { priority: 1 }),
    execute: () => gate.promise,
  });
  await drain();
  const normal = scheduler.schedule({
    envelope: envelope(2, {
      priority: 2,
      priorityClass: WORLD_GENERATION_PRIORITY_CLASS.COARSE_EXISTENCE,
    }),
    execute: async () => { order.push('normal'); },
  });
  const imminent = scheduler.schedule({
    envelope: envelope(3, {
      priority: 2,
      priorityClass: WORLD_GENERATION_PRIORITY_CLASS.COARSE_EXISTENCE,
      deadlineAtMs: 25,
    }),
    execute: async () => { order.push('imminent'); },
  });
  const missed = scheduler.schedule({
    envelope: envelope(4, {
      priority: 2,
      priorityClass: WORLD_GENERATION_PRIORITY_CLASS.COARSE_EXISTENCE,
      deadlineAtMs: 10,
    }),
    execute: async () => { order.push('missed'); },
  });
  now = 20;
  gate.resolve();
  await Promise.all([blocker.promise, normal.promise, imminent.promise, missed.promise]);
  assert.deepEqual(order, ['missed', 'imminent', 'normal']);
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
  let now = 0;
  const gate = deferred();
  const events = [];
  const scheduler = createWorldGenerationScheduler({
    clock: () => now,
    onEvent: event => events.push(event),
  });
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
  now = 7;
  gate.resolve();
  const result = await active.promise;
  assert.equal(result.state, WORLD_GENERATION_STATE.CANCELLED);
  assert.equal(result.value, null);
  assert.equal(result.cancellationAcknowledgedAtCheckpoint, true);
  assert.equal(result.cancellationAcknowledgementMs, 7);
  assert.equal(events.filter(event => event.type === 'cancel-requested').length, 1);
  assert.equal(events.filter(event => event.type === 'cancel-acknowledged').length, 1);
  assert.equal(scheduler.snapshot().counts.inFlightCancelled, 1);
  await scheduler.shutdown();
});

test('a real execution ERROR wins a simultaneous cancellation and emits one failed terminal', async () => {
  const gate = deferred();
  const events = [];
  const scheduler = createWorldGenerationScheduler({
    clock: () => 10,
    onEvent: event => events.push(event),
  });
  const active = scheduler.schedule({
    envelope: envelope(1),
    execute: async () => gate.promise,
  });
  await drain();
  assert.equal(active.cancel('cancel-raced-error'), true);
  gate.reject(new Error('authoritative-generation-error'));

  const result = await active.promise;
  assert.equal(result.state, WORLD_GENERATION_STATE.FAILED);
  assert.match(result.error.message, /authoritative-generation-error/);
  assert.deepEqual(
    events.filter(event => event.type === 'terminal').map(event => event.state),
    [WORLD_GENERATION_STATE.FAILED],
  );
  assert.equal(events.filter(event => event.type === 'cancel-acknowledged').length, 0);
  assert.equal(scheduler.snapshot().counts.failed, 1);
  assert.equal(scheduler.snapshot().counts.cancelled, 0);
  await scheduler.shutdown();
});

test('scheduler shutdown requests cancellation and reports a bounded drain timeout', async () => {
  const gate = deferred();
  const scheduler = createWorldGenerationScheduler({
    clock: () => 0,
    shutdownDrainTimeoutMs: 5,
  });
  const active = scheduler.schedule({
    envelope: envelope(1),
    execute: async ({ checkpoint }) => {
      await gate.promise;
      checkpoint();
    },
  });
  await drain();
  assert.equal(await scheduler.shutdown({ reason: 'bounded-test-shutdown' }), false);
  assert.equal(scheduler.snapshot().counts.shutdownDrainTimeouts, 1);
  assert.equal(scheduler.snapshot().inFlight.cancelRequested, true);
  gate.resolve();
  assert.equal((await active.promise).state, WORLD_GENERATION_STATE.CANCELLED);
});

test('a required higher-rank request preempts optional active work at its next checkpoint', async () => {
  let now = 0;
  const gate = deferred();
  const events = [];
  const order = [];
  const scheduler = createWorldGenerationScheduler({
    clock: () => now,
    onEvent: event => events.push(event),
  });
  const optional = scheduler.schedule({
    envelope: envelope(1, {
      priority: 5,
      priorityClass: WORLD_GENERATION_PRIORITY_CLASS.PREFETCH,
      required: false,
    }),
    execute: async ({ checkpoint }) => {
      order.push('optional-start');
      await gate.promise;
      checkpoint();
      order.push('optional-after-checkpoint');
    },
  });
  await drain();
  now = 3;
  const required = scheduler.schedule({
    envelope: envelope(2, {
      priority: 1,
      priorityClass: WORLD_GENERATION_PRIORITY_CLASS.DEADLINE_SAFETY,
      required: true,
      createdAtMs: now,
    }),
    execute: async () => { order.push('required'); return 'current'; },
  });
  assert.equal(scheduler.snapshot().inFlight.cancelRequested, true);
  assert.equal(scheduler.snapshot().inFlight.preemptedByRequestId, 2);
  now = 11;
  gate.resolve();
  const [optionalResult, requiredResult] = await Promise.all([
    optional.promise,
    required.promise,
  ]);
  assert.equal(optionalResult.state, WORLD_GENERATION_STATE.CANCELLED);
  assert.equal(optionalResult.preemptedByRequestId, 2);
  assert.equal(optionalResult.cancellationAcknowledgementMs, 8);
  assert.equal(optionalResult.cancellationAcknowledgedAtCheckpoint, true);
  assert.equal(requiredResult.state, WORLD_GENERATION_STATE.COMPLETED);
  assert.equal(requiredResult.value, 'current');
  assert.deepEqual(order, ['optional-start', 'required']);
  assert.equal(events.filter(event => event.type === 'cancel-requested').length, 1);
  assert.equal(events.filter(event => event.type === 'cancel-acknowledged').length, 1);
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.counts.preemptionRequests, 1);
  assert.equal(snapshot.counts.preemptionAcknowledgements, 1);
  await scheduler.shutdown();
});

test('required active work is never auto-preempted by another required request', async () => {
  const gate = deferred();
  const order = [];
  const scheduler = createWorldGenerationScheduler({ clock: () => 0 });
  const active = scheduler.schedule({
    envelope: envelope(1, {
      priority: 4,
      priorityClass: WORLD_GENERATION_PRIORITY_CLASS.DETAIL,
      required: true,
    }),
    execute: async ({ checkpoint }) => {
      order.push('resident-start');
      await gate.promise;
      checkpoint();
      order.push('resident-finish');
    },
  });
  await drain();
  const safety = scheduler.schedule({
    envelope: envelope(2, {
      priority: 1,
      priorityClass: WORLD_GENERATION_PRIORITY_CLASS.DEADLINE_SAFETY,
      required: true,
    }),
    execute: async () => { order.push('safety'); },
  });
  assert.equal(scheduler.snapshot().inFlight.cancelRequested, false);
  gate.resolve();
  assert.equal((await active.promise).state, WORLD_GENERATION_STATE.COMPLETED);
  assert.equal((await safety.promise).state, WORLD_GENERATION_STATE.COMPLETED);
  assert.deepEqual(order, ['resident-start', 'resident-finish', 'safety']);
  assert.equal(scheduler.snapshot().counts.preemptionRequests, 0);
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
    cancelRequests: 1,
    checkpointCancelAcknowledgements: 1,
    cancellationsSettledWithoutCheckpoint: 0,
    preemptionRequests: 0,
    preemptionAcknowledgements: 0,
    shutdownDrainTimeouts: 0,
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
