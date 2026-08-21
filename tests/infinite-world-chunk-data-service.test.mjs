import assert from 'node:assert/strict';
import test from 'node:test';
import { ChunkDataService } from '../src/infinite-world/chunk-data-service.js';
import { CHUNK_DATA_PRIORITY } from '../src/infinite-world/chunk-data-service-protocol.js';
import {
  createOwnerGenerationCoordinator,
  defaultOwnerGenerationPriorityClass,
} from '../src/infinite-world/owner-generation-coordinator.js';

function chunk(chunkX, chunkZ, revision = 'a') {
  return Object.freeze({
    chunkX,
    chunkZ,
    chunkId: `chunk:${chunkX},${chunkZ}:${revision}`,
    contentHash: `sha256:${`${chunkX},${chunkZ}:${revision}`.padEnd(64, '0')}`,
  });
}

function deferredTransport() {
  const calls = [];
  const pending = [];
  const cancelCalls = [];
  return {
    calls,
    pending,
    cancelCalls,
    async generateChunk(request) {
      calls.push(request);
      return new Promise((resolve, reject) => pending.push({ request, resolve, reject }));
    },
    snapshot: () => Object.freeze({ kind: 'test' }),
    cancelGenerationRequest(request) {
      cancelCalls.push(request);
      return true;
    },
    async shutdown() {},
  };
}

async function nextDispatch() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

function resolvePending(transport, chunkX, chunkZ = 0, revision = 'a') {
  const index = transport.pending.findIndex(value => (
    value.request.chunkX === chunkX && value.request.chunkZ === chunkZ
  ));
  assert.notEqual(index, -1, `missing pending transport request for ${chunkX},${chunkZ}`);
  const [pending] = transport.pending.splice(index, 1);
  pending.resolve(chunk(chunkX, chunkZ, revision));
}

async function terrainDependencyCompetitionFixture() {
  let now = 100;
  let releaseBlocker;
  const blockerGate = new Promise(resolve => { releaseBlocker = resolve; });
  const workerTimeline = [];
  const ownerTimeline = new Map();
  let timelineSequence = 0;
  const recordOwner = (ownerKey, event) => {
    let timeline = ownerTimeline.get(ownerKey);
    if (!timeline) {
      timeline = { ownerKey, queued: null, started: null, completed: null };
      ownerTimeline.set(ownerKey, timeline);
    }
    timeline[event] = ++timelineSequence;
  };
  const coordinator = createOwnerGenerationCoordinator({
    clock: () => now,
    maximumConcurrentRequests: 1,
    agingIntervalMs: 100_000,
  });
  const transport = {
    async generateChunk(request) {
      const ownerKey = `${request.chunkX},${request.chunkZ}`;
      workerTimeline.push(`terrain:${ownerKey}`);
      recordOwner(ownerKey, 'started');
      await Promise.resolve();
      recordOwner(ownerKey, 'completed');
      return chunk(request.chunkX, request.chunkZ);
    },
    snapshot: () => Object.freeze({ kind: 'single-worker-test' }),
    async shutdown() {},
  };
  const blocker = coordinator.schedule({
    ownerKey: 'blocker',
    resourceKind: 'control',
    operationKind: 'test-blocker',
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    priorityClass: 1,
    required: true,
    createdAtMs: now,
    firstVisibleDeadlineMs: 0,
    representationClass: 'detail',
    subscriberIdentity: 'existing-worker-operation',
    execute: () => blockerGate,
  });
  await nextDispatch();

  const service = new ChunkDataService({
    transport,
    clock: () => now,
    agingIntervalMs: 100_000,
    coordinator,
    onPipelineEvent(type, details) {
      if (type === 'chunk-request-queued') recordOwner(details.ownerKey, 'queued');
    },
  });
  const terrain = Array.from({ length: 25 }, (_, index) => service.requestChunk({
    chunkX: index,
    chunkZ: 0,
    priority: index === 0
      ? CHUNK_DATA_PRIORITY.PLAYER_DATA
      : index < 9 ? CHUNK_DATA_PRIORITY.PLAYER_RENDER : CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
    required: true,
    deadlineAtMs: 0,
    consumerId: `runtime-terrain-ready-owner:${index},0`,
  }));
  await new Promise(resolve => setImmediate(resolve));
  const supplyBeforeRelease = service.snapshot();

  const natural = Array.from({ length: 20 }, (_, index) => coordinator.schedule({
    ownerKey: `natural:${index}`,
    resourceKind: 'presentation',
    operationKind: 'presentation-owner',
    priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
    priorityClass: 2,
    required: true,
    createdAtMs: now,
    representationClass: 'coarse',
    subscriberIdentity: `static-object-stream:natural-static:${index}`,
    execute: async () => { workerTimeline.push(`natural:${index}`); },
  }));
  releaseBlocker();
  await Promise.all([
    blocker.promise,
    ...natural.map(handle => handle.promise),
    ...terrain.map(handle => handle.promise),
  ]);
  const thirdTerrainIndex = workerTimeline.indexOf('terrain:2,0');
  const firstNaturalIndex = workerTimeline.findIndex(value => value.startsWith('natural:'));
  const result = Object.freeze({
    supplyBeforeRelease,
    naturalBeforeThirdTerrain: workerTimeline.slice(0, thirdTerrainIndex)
      .filter(value => value.startsWith('natural:')).length,
    terrainBeforeFirstNatural: workerTimeline.slice(0, firstNaturalIndex)
      .filter(value => value.startsWith('terrain:')).length,
    ownerTimeline: Object.freeze([...ownerTimeline.values()].map(value => Object.freeze({ ...value }))),
  });
  await service.shutdown();
  await coordinator.shutdown();
  return result;
}

test('ChunkDataService dispatches priority 1 through 5 and preserves FIFO within a priority', async () => {
  const transport = deferredTransport();
  const service = new ChunkDataService({ transport });
  const requests = [
    service.requestChunk({ chunkX: 5, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.ULTRA_WARM, consumerId: 'u' }),
    service.requestChunk({ chunkX: 4, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER, consumerId: 'd' }),
    service.requestChunk({ chunkX: 3, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED, consumerId: 'g' }),
    service.requestChunk({ chunkX: 1, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.PLAYER_DATA, consumerId: 'p1' }),
    service.requestChunk({ chunkX: 2, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.PLAYER_DATA, consumerId: 'p2' }),
    service.requestChunk({ chunkX: 0, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.PLAYER_RENDER, consumerId: 'r' }),
  ];
  const dispatchOrder = [1, 2, 0, 3, 4, 5];
  for (let index = 0; index < dispatchOrder.length; index += 1) {
    const expectedX = dispatchOrder[index];
    await nextDispatch();
    assert.equal(transport.calls[index].chunkX, expectedX);
    resolvePending(transport, expectedX);
  }
  const values = await Promise.all(requests.map(request => request.promise));
  assert.deepEqual(values.map(value => value.chunkX), [5, 4, 3, 1, 2, 0]);
});

test('one global owner queue orders Full and Presentation by deadline and semantic class', async () => {
  let now = 100;
  let releaseBlocker;
  const blockerGate = new Promise(resolve => { releaseBlocker = resolve; });
  const coordinator = createOwnerGenerationCoordinator({
    clock: () => now,
    maximumConcurrentRequests: 1,
  });
  const calls = [];
  const pending = [];
  const transportFor = resourceKind => ({
    generateChunk(request) {
      calls.push({ resourceKind, request });
      return new Promise(resolve => pending.push({ resourceKind, request, resolve }));
    },
    async shutdown() {},
  });
  const full = new ChunkDataService({
    transport: transportFor('full'),
    coordinator,
    resourceKind: 'full',
  });
  const presentation = new ChunkDataService({
    transport: transportFor('presentation'),
    coordinator,
    resourceKind: 'presentation',
    representationClass: 'coarse',
    operationKind: 'presentation-owner',
  });
  const blocker = coordinator.schedule({
    ownerKey: 'blocker',
    resourceKind: 'control',
    operationKind: 'test-blocker',
    priority: 1,
    priorityClass: 1,
    required: true,
    representationClass: 'detail',
    execute: () => blockerGate,
  });
  await nextDispatch();

  const handles = [
    presentation.requestChunk({ chunkX: 5, chunkZ: 0, priority: 5, required: false, consumerId: 'prefetch' }),
    full.requestChunk({ chunkX: 4, chunkZ: 0, priority: 4, required: true, consumerId: 'detail' }),
    full.requestChunk({ chunkX: 3, chunkZ: 0, priority: 3, required: true, consumerId: 'gameplay' }),
    presentation.requestChunk({ chunkX: 2, chunkZ: 0, priority: 4, required: true, consumerId: 'coarse' }),
    full.requestChunk({
      chunkX: 1,
      chunkZ: 0,
      priority: 5,
      required: false,
      deadlineAtMs: now,
      consumerId: 'visual-deadline',
    }),
  ];
  assert.equal(coordinator.snapshot().queuedCount, 5);
  releaseBlocker();
  await blocker.promise;

  const expected = [
    ['presentation', 2],
    ['full', 3],
    ['full', 4],
    ['full', 1],
    ['presentation', 5],
  ];
  for (const [resourceKind, chunkX] of expected) {
    await nextDispatch();
    const call = calls.at(-1);
    assert.deepEqual([call.resourceKind, call.request.chunkX], [resourceKind, chunkX]);
    const operation = pending.shift();
    operation.resolve(chunk(operation.request.chunkX, operation.request.chunkZ));
  }
  await Promise.all(handles.map(handle => handle.promise));
  assert.deepEqual(calls.map(call => [call.resourceKind, call.request.chunkX]), expected);
  assert.deepEqual(calls.map(call => call.request.scheduler.sequence), [5, 4, 3, 6, 2]);
  assert.deepEqual(calls.map(call => call.request.scheduler.resourceKind), expected.map(([kind]) => kind));
  assert.equal(coordinator.snapshot().queuedCount, 0);
  await presentation.shutdown();
  await coordinator.shutdown();
  await full.shutdown();
});

test('global owner admission preempts only optional lower-rank active work', async () => {
  let now = 0;
  let releaseOptional;
  const optionalGate = new Promise(resolve => { releaseOptional = resolve; });
  const order = [];
  const events = [];
  const coordinator = createOwnerGenerationCoordinator({
    clock: () => now,
    maximumConcurrentRequests: 1,
    onEvent: event => events.push(event),
  });
  const optional = coordinator.schedule({
    ownerKey: 'optional-background',
    resourceKind: 'control',
    operationKind: 'optional-background',
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    priorityClass: 5,
    required: false,
    representationClass: 'detail',
    execute: async () => {
      order.push('optional-start');
      return optionalGate;
    },
    onCancel: reason => {
      order.push(`optional-cancel:${reason}`);
      releaseOptional(null);
    },
  });
  await nextDispatch();
  now = 4;
  const required = coordinator.schedule({
    ownerKey: 'required-current',
    resourceKind: 'full',
    operationKind: 'chunk',
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    priorityClass: 1,
    required: true,
    representationClass: 'detail',
    execute: async () => {
      order.push('required');
      return 'current';
    },
  });
  assert.equal(optional.state, 'in-flight');
  assert.equal(optional.envelope.required, false);
  now = 9;
  assert.equal(await optional.promise, null);
  assert.equal(await required.promise, 'current');
  assert.deepEqual(order, [
    'optional-start',
    'optional-cancel:preempted-by-higher-priority:2',
    'required',
  ]);
  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.counts.preemptionRequests, 1);
  assert.equal(snapshot.counts.preemptionAcknowledgements, 1);
  assert.equal(snapshot.counts.cancelRequests, 1);
  assert.equal(snapshot.counts.cancelAcknowledgements, 1);
  assert.equal(events.filter(event => event.type === 'cancel-requested').length, 1);
  assert.equal(events.filter(event => event.type === 'cancel-acknowledged').length, 1);
  await coordinator.shutdown();
});

test('owner cancellation callback failures are surfaced as failed terminals', async () => {
  let releaseOptional;
  const optionalGate = new Promise(resolve => { releaseOptional = resolve; });
  const events = [];
  const coordinator = createOwnerGenerationCoordinator({
    clock: () => 0,
    maximumConcurrentRequests: 1,
    onEvent: event => events.push(event),
  });
  const optional = coordinator.schedule({
    ownerKey: 'optional-callback-failure',
    resourceKind: 'control',
    operationKind: 'optional-callback-failure',
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    priorityClass: 5,
    required: false,
    representationClass: 'detail',
    execute: async () => optionalGate,
    onCancel: () => {
      releaseOptional('must-not-publish');
      throw new Error('injected-cancel-callback-failure');
    },
  });
  await nextDispatch();
  const optionalOutcome = assert.rejects(
    optional.promise,
    /injected-cancel-callback-failure/,
  );
  const required = coordinator.schedule({
    ownerKey: 'required-after-callback-failure',
    resourceKind: 'full',
    operationKind: 'chunk',
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    priorityClass: 1,
    required: true,
    representationClass: 'detail',
    execute: async () => 'required-result',
  });
  await optionalOutcome;
  assert.equal(await required.promise, 'required-result');
  assert.equal(optional.state, 'failed');
  assert.equal(events.filter(event => event.type === 'cancel-callback-failed').length, 1);
  const terminal = events.find(event => (
    event.type === 'terminal' && event.envelope.requestId === optional.requestId
  ));
  assert.equal(terminal.state, 'failed');
  assert.match(terminal.error.message, /injected-cancel-callback-failure/);
  assert.equal(coordinator.snapshot().counts.cancelCallbackFailures, 1);
  await coordinator.shutdown();
});

test('owner execution ERROR wins a cancellation race and emits one failed terminal', async () => {
  let rejectOptional;
  const optionalGate = new Promise((resolve, reject) => { rejectOptional = reject; });
  const events = [];
  const coordinator = createOwnerGenerationCoordinator({
    clock: () => 0,
    maximumConcurrentRequests: 1,
    onEvent: event => events.push(event),
  });
  const optional = coordinator.schedule({
    ownerKey: 'optional-error-race',
    resourceKind: 'presentation',
    operationKind: 'presentation-owner',
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    priorityClass: 5,
    required: false,
    representationClass: 'coarse',
    execute: () => optionalGate,
  });
  await nextDispatch();
  const optionalOutcome = assert.rejects(optional.promise, /authoritative-owner-error/);
  const required = coordinator.schedule({
    ownerKey: 'required-after-error-race',
    resourceKind: 'full',
    operationKind: 'chunk',
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    priorityClass: 1,
    required: true,
    representationClass: 'detail',
    execute: async () => 'required-result',
  });
  rejectOptional(new Error('authoritative-owner-error'));

  await optionalOutcome;
  assert.equal(await required.promise, 'required-result');
  assert.equal(optional.state, 'failed');
  assert.deepEqual(
    events.filter(event => (
      event.type === 'terminal' && event.envelope.requestId === optional.requestId
    )).map(event => event.state),
    ['failed'],
  );
  assert.equal(events.filter(event => (
    event.type === 'cancel-acknowledged' && event.envelope.requestId === optional.requestId
  )).length, 0);
  assert.equal(coordinator.snapshot().counts.failed, 1);
  assert.equal(coordinator.snapshot().counts.cancelled, 0);
  await coordinator.shutdown();
});

test('owner shutdown cancels active work and bounds the acknowledgement drain', async () => {
  let releaseActive;
  const activeGate = new Promise(resolve => { releaseActive = resolve; });
  const coordinator = createOwnerGenerationCoordinator({
    maximumConcurrentRequests: 1,
    shutdownDrainTimeoutMs: 5,
  });
  const active = coordinator.schedule({
    ownerKey: 'shutdown-owner',
    resourceKind: 'presentation',
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    priorityClass: 5,
    required: false,
    representationClass: 'coarse',
    execute: () => activeGate,
  });
  await nextDispatch();

  assert.equal(await coordinator.shutdown({ reason: 'bounded-owner-shutdown' }), false);
  assert.equal(coordinator.snapshot().counts.shutdownDrainTimeouts, 1);
  assert.equal(coordinator.snapshot().inFlight[0].cancelRequested, true);
  releaseActive('completed-after-cancel-timeout');
  assert.equal(await active.promise, 'completed-after-cancel-timeout');
});

test('deadline-bound required Full coverage remains in the Terrain safety class', () => {
  assert.equal(defaultOwnerGenerationPriorityClass({
    resourceKind: 'full',
    priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
    required: true,
    firstVisibleDeadlineMs: 1_000,
  }), 1);
  assert.equal(defaultOwnerGenerationPriorityClass({
    resourceKind: 'full',
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    required: false,
    firstVisibleDeadlineMs: 1_000,
  }), 5);
});

test('global owner queue coalesces one composite resource key but keeps Full and Presentation distinct', async () => {
  const coordinator = createOwnerGenerationCoordinator({ maximumConcurrentRequests: 3 });
  const executions = [];
  const schedule = (resourceKind, subscriberIdentity) => coordinator.schedule({
    ownerKey: '7,-2',
    resourceKind,
    priority: resourceKind === 'presentation' ? 4 : 3,
    priorityClass: resourceKind === 'presentation' ? 2 : 3,
    required: true,
    representationClass: resourceKind === 'presentation' ? 'coarse' : 'detail',
    subscriberIdentity,
    execute: async () => {
      executions.push(resourceKind);
      return `${resourceKind}:value`;
    },
  });
  const fullA = schedule('full', 'full-a');
  const fullB = schedule('full', 'full-b');
  const presentation = schedule('presentation', 'presentation-a');
  assert.equal(fullA.requestId, fullB.requestId);
  assert.notEqual(fullA.requestId, presentation.requestId);
  assert.equal(fullA.cancel('subscriber-left'), true,
    'one coalesced subscriber may leave without cancelling the owner operation');
  assert.equal(await fullA.promise, null);
  assert.equal(await fullB.promise, 'full:value');
  assert.equal(await presentation.promise, 'presentation:value');
  assert.deepEqual(executions.sort(), ['full', 'presentation']);
  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.counts.scheduled, 2);
  assert.equal(snapshot.counts.deduplicated, 1);
  await coordinator.shutdown();
});

test('cancelled in-flight composite keys cannot erase or absorb their successor generation', async () => {
  const coordinator = createOwnerGenerationCoordinator({ maximumConcurrentRequests: 2 });
  let resolveOld;
  let resolveSuccessor;
  const executions = [];
  const schedule = (name, execute) => coordinator.schedule({
    ownerKey: '4,9',
    resourceKind: 'presentation',
    priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
    priorityClass: 2,
    required: true,
    representationClass: 'coarse',
    subscriberIdentity: name,
    execute,
  });

  const old = schedule('old', async () => {
    executions.push('old');
    return new Promise(resolve => { resolveOld = resolve; });
  });
  await nextDispatch();
  assert.equal(old.state, 'in-flight');
  assert.equal(old.cancel('superseded'), true);

  const successor = schedule('successor', async () => {
    executions.push('successor');
    return new Promise(resolve => { resolveSuccessor = resolve; });
  });
  await nextDispatch();
  assert.notEqual(successor.requestId, old.requestId);
  assert.deepEqual(executions, ['old', 'successor']);

  resolveOld('obsolete');
  await nextDispatch();
  const joined = schedule('joined', async () => {
    executions.push('incorrect-third-generation');
    return 'incorrect';
  });
  assert.equal(joined.requestId, successor.requestId,
    'the old terminal token must not delete the live successor composite mapping');
  resolveSuccessor('current');

  assert.equal(await old.promise, null);
  assert.equal(await successor.promise, 'current');
  assert.equal(await joined.promise, 'current');
  assert.deepEqual(executions, ['old', 'successor']);
  await coordinator.shutdown();
});

test('ChunkDataService starts a successor instead of subscribing to a cancelled in-flight tombstone', async () => {
  const transport = deferredTransport();
  const service = new ChunkDataService({ transport });
  const old = service.requestChunk({
    chunkX: 4, chunkZ: 9, consumerId: 'old', epoch: 1,
  });
  await nextDispatch();
  assert.equal(old.cancel(), true);
  assert.equal(await old.promise, null);

  const successor = service.requestChunk({
    chunkX: 4, chunkZ: 9, consumerId: 'successor', epoch: 1,
  });
  await nextDispatch();
  assert.equal(transport.calls.length, 1,
    'the successor waits behind the cancelled transport operation in the serial queue');

  const oldPendingIndex = transport.pending.findIndex(({ request }) => (
    request.requestId === transport.calls[0].requestId
  ));
  const [oldPending] = transport.pending.splice(oldPendingIndex, 1);
  oldPending.resolve(chunk(4, 9, 'obsolete'));
  await nextDispatch();
  assert.equal(transport.calls.length, 2);
  assert.notEqual(transport.calls[0].requestId, transport.calls[1].requestId);
  assert.equal(service.snapshot().pendingCount, 1,
    'the obsolete terminal must not delete the successor service entry');
  assert.equal(service.snapshot().completedCacheSize, 0);

  const joined = service.requestChunk({
    chunkX: 4, chunkZ: 9, consumerId: 'joined', epoch: 1,
  });
  await nextDispatch();
  assert.equal(transport.calls.length, 2,
    'a third subscriber must coalesce with the live successor');
  const successorPendingIndex = transport.pending.findIndex(({ request }) => (
    request.requestId === transport.calls[1].requestId
  ));
  const [successorPending] = transport.pending.splice(successorPendingIndex, 1);
  const current = chunk(4, 9, 'current');
  successorPending.resolve(current);

  assert.equal(await successor.promise, current);
  assert.equal(await joined.promise, current);
  await nextDispatch();
  assert.equal(service.snapshot().completedCacheSize, 1);
  await service.shutdown();
});

test('ChunkDataService publishes fast B/C completions without waiting for slow A', async () => {
  const transport = deferredTransport();
  const readyOrder = [];
  const coordinator = createOwnerGenerationCoordinator({ maximumConcurrentRequests: 4 });
  const service = new ChunkDataService({
    transport,
    coordinator,
    onPipelineEvent(type, details) {
      if (type === 'chunk-owner-ready') readyOrder.push(details.chunkX);
    },
  });
  const first = service.requestChunk({
    chunkX: 0, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.PLAYER_DATA, consumerId: 'first',
  });
  const second = service.requestChunk({
    chunkX: 1, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.PLAYER_DATA, consumerId: 'second',
  });
  const third = service.requestChunk({
    chunkX: 2, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED, consumerId: 'third',
  });
  const warm = service.requestChunk({
    chunkX: 3, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER, consumerId: 'warm',
  });

  await nextDispatch();
  assert.deepEqual(transport.calls.map(value => value.chunkX), [0, 1, 2, 3]);
  assert.equal(service.snapshot().inFlightCount, 4);

  let secondDelivered = false;
  void second.promise.then(() => { secondDelivered = true; });
  resolvePending(transport, 1);
  resolvePending(transport, 2);
  resolvePending(transport, 3);
  await nextDispatch();
  assert.equal(secondDelivered, true, 'B must publish independently while A remains slow');
  assert.deepEqual(readyOrder, [1, 2, 3]);
  assert.equal(service.snapshot().completedCacheSize, 3);
  assert.equal(service.snapshot().inFlightKey, '0,0');

  resolvePending(transport, 0);
  assert.equal((await first.promise).chunkX, 0);
  assert.equal((await second.promise).chunkX, 1);
  assert.equal((await third.promise).chunkX, 2);
  assert.equal((await warm.promise).chunkX, 3);
  await nextDispatch();

  const snapshot = service.snapshot();
  assert.deepEqual(readyOrder, [1, 2, 3, 0]);
  assert.equal(new Set(transport.calls.map(value => value.requestId)).size, 4);
  assert.equal(snapshot.pendingCount, 0);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.counts.pendingDedupeHits, 0);
  assert.equal(snapshot.counts.staleSubscriberResults, 0);
  await coordinator.shutdown();
});

test('ChunkDataService registers the complete 25-owner Terrain batch in the sole owner queue before Worker selection', async () => {
  const batchLookahead = await terrainDependencyCompetitionFixture();
  assert.equal(batchLookahead.supplyBeforeRelease.scheduler.workerCount, 1,
    'the fix must not increase Worker concurrency');
  assert.equal(batchLookahead.supplyBeforeRelease.inFlightCount, 0);
  assert.equal(batchLookahead.supplyBeforeRelease.queuedCount, 25);
  assert.equal(batchLookahead.supplyBeforeRelease.coordinator.inFlightCount, 1,
    'only the control blocker may have crossed the transport boundary');
  assert.equal(batchLookahead.naturalBeforeThirdTerrain, 0);
  assert.equal(batchLookahead.terrainBeforeFirstNatural, 25);
  assert.equal(batchLookahead.ownerTimeline.length, 25);
  for (const owner of batchLookahead.ownerTimeline) {
    assert.ok(owner.queued < owner.started, `${owner.ownerKey} must start after queue registration`);
    assert.ok(owner.started < owner.completed, `${owner.ownerKey} must complete after starting`);
  }
});

test('ChunkDataService cancels an admitted owner without duplicate, stale, or orphan state', async () => {
  const transport = deferredTransport();
  const coordinator = createOwnerGenerationCoordinator({ maximumConcurrentRequests: 3 });
  const service = new ChunkDataService({ transport, coordinator });
  const first = service.requestChunk({
    chunkX: 10, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.PLAYER_DATA, consumerId: 'first',
  });
  const cancelled = service.requestChunk({
    chunkX: 11, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.PLAYER_DATA, consumerId: 'cancelled',
  });
  const third = service.requestChunk({
    chunkX: 12, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED, consumerId: 'third',
  });

  await nextDispatch();
  assert.deepEqual(transport.calls.map(value => value.chunkX), [10, 11, 12]);
  assert.equal(cancelled.cancel(), true);
  assert.deepEqual(transport.cancelCalls, [{
    requestId: 2,
    reason: 'no-active-subscribers',
  }]);
  resolvePending(transport, 11);
  resolvePending(transport, 10);
  assert.equal((await first.promise).chunkX, 10);
  assert.equal(await cancelled.promise, null);

  resolvePending(transport, 12);
  assert.equal((await third.promise).chunkX, 12);
  await nextDispatch();

  const snapshot = service.snapshot();
  assert.equal(new Set(transport.calls.map(value => value.requestId)).size, 3);
  assert.equal(snapshot.pendingCount, 0);
  assert.equal(snapshot.queuedCount, 0);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.counts.cancelledOperations, 1);
  assert.equal(snapshot.counts.staleSubscriberResults, 0);
  await coordinator.shutdown();
});

test('ChunkDataService dedupes Runtime, Gameplay, and Distant consumers, promotes queued work, and returns one canonical object reference', async () => {
  const transport = deferredTransport();
  const service = new ChunkDataService({ transport });
  const active = service.requestChunk({ chunkX: 9, chunkZ: 0, priority: 1, consumerId: 'active' });
  await nextDispatch();
  const ultra = service.requestChunk({ chunkX: 4, chunkZ: 0, priority: 5, consumerId: 'distant' });
  const player = service.requestChunk({ chunkX: 4, chunkZ: 0, priority: 1, consumerId: 'runtime' });
  const gameplay = service.requestChunk({ chunkX: 4, chunkZ: 0, priority: 3, consumerId: 'gameplay' });
  assert.equal(service.snapshot().queued[0].priority, CHUNK_DATA_PRIORITY.PLAYER_DATA);
  transport.pending.shift().resolve(chunk(9, 0));
  await nextDispatch();
  assert.equal(transport.calls.length, 2);
  transport.pending.shift().resolve(chunk(4, 0));
  const [first, second, third] = await Promise.all([ultra.promise, player.promise, gameplay.promise]);
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(service.snapshot().counts.transportCalls, 2);
  assert.equal(service.snapshot().counts.pendingDedupeHits, 2);
  await active.promise;
});

test('same-owner required subscriber promotes an active future-Full request in place', async () => {
  const transport = deferredTransport();
  const service = new ChunkDataService({ transport });
  const future = service.requestChunk({
    chunkX: 14,
    chunkZ: 9,
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    required: false,
    consumerId: 'future-full',
  });
  await nextDispatch();
  assert.equal(transport.calls.length, 1);
  const required = service.requestChunk({
    chunkX: 14,
    chunkZ: 9,
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    required: true,
    deadlineAtMs: 250,
    consumerId: 'runtime-required',
  });
  const active = service.snapshot().coordinator.inFlight[0];
  assert.equal(active.ownerKey, '14,9');
  assert.equal(active.priority, CHUNK_DATA_PRIORITY.PLAYER_DATA);
  assert.equal(active.required, true);
  assert.equal(active.firstVisibleDeadlineMs, 250);
  assert.equal(transport.calls.length, 1,
    'same canonical owner must not be cancelled or regenerated for promotion');
  resolvePending(transport, 14, 9);
  const [futureResult, requiredResult] = await Promise.all([future.promise, required.promise]);
  assert.equal(futureResult, requiredResult);
  assert.equal(service.snapshot().counts.priorityPromotions, 1);
  await service.shutdown();
});

test('an existing owner handle promotes queued or in-flight metadata monotonically without changing request identity', async () => {
  const transport = deferredTransport();
  const service = new ChunkDataService({ transport });
  const future = service.requestChunk({
    chunkX: 15,
    chunkZ: 9,
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    required: false,
    deadlineAtMs: 900,
    consumerId: 'future-full',
    epoch: 7,
  });
  await nextDispatch();
  const before = service.snapshot().coordinator.inFlight[0];

  assert.equal(future.promote({
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    required: true,
    deadlineAtMs: 250,
  }), true);
  let active = service.snapshot().coordinator.inFlight[0];
  assert.equal(active.requestId, before.requestId);
  assert.deepEqual(active.subscriberIdentities, before.subscriberIdentities);
  assert.deepEqual(active.subscriberIdentities, ['full:future-full:7']);
  assert.equal(active.priority, CHUNK_DATA_PRIORITY.PLAYER_DATA);
  assert.equal(active.required, true);
  assert.equal(active.firstVisibleDeadlineMs, 250);

  assert.equal(future.promote({
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    required: false,
    deadlineAtMs: 1_200,
  }), true);
  active = service.snapshot().coordinator.inFlight[0];
  assert.equal(active.requestId, before.requestId);
  assert.equal(active.priority, CHUNK_DATA_PRIORITY.PLAYER_DATA);
  assert.equal(active.required, true);
  assert.equal(active.firstVisibleDeadlineMs, 250);
  assert.equal(transport.calls.length, 1);

  resolvePending(transport, 15, 9);
  assert.equal((await future.promise).chunkX, 15);
  await service.shutdown();
});

test('ChunkDataService reports subscriber-only cancellation while another consumer keeps the Worker request alive', async () => {
  const transport = deferredTransport();
  const service = new ChunkDataService({ transport });
  const terrain = service.requestChunk({
    chunkX: 6, chunkZ: 4, priority: 1, consumerId: 'terrain-owner', epoch: 1,
  });
  const collision = service.requestChunk({
    chunkX: 6, chunkZ: 4, priority: 3, consumerId: 'collision-owner', epoch: 1,
  });
  await nextDispatch();
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(terrain.cancelWithDetails(), {
    subscriberCancelled: true,
    underlyingRequestCancelled: false,
    workerCancelRequested: false,
  });
  assert.equal(transport.cancelCalls.length, 0);
  resolvePending(transport, 6, 4);
  assert.equal(await terrain.promise, null);
  assert.equal((await collision.promise).chunkX, 6);
  const snapshot = service.snapshot();
  assert.equal(snapshot.counts.transportCalls, 1);
  assert.equal(snapshot.counts.completedOperations, 1);
  assert.equal(snapshot.counts.inFlightOperationCancels, 0);
});

test('ChunkDataService cancels queued and in-flight subscribers without delivering stale data', async () => {
  const transport = deferredTransport();
  const service = new ChunkDataService({ transport });
  const queued = service.requestChunk({ chunkX: 1, chunkZ: 1, priority: 5, consumerId: 'queued' });
  assert.equal(queued.cancel(), true);
  await nextDispatch();
  assert.equal(transport.calls.length, 0);
  assert.equal(await queued.promise, null);

  const inflight = service.requestChunk({ chunkX: 2, chunkZ: 2, priority: 1, consumerId: 'inflight' });
  await nextDispatch();
  assert.equal(transport.calls.length, 1);
  assert.equal(inflight.cancel(), true);
  assert.deepEqual(transport.cancelCalls, [{
    requestId: 2,
    reason: 'no-active-subscribers',
  }]);
  transport.pending.shift().resolve(chunk(2, 2));
  assert.equal(await inflight.promise, null);
  await nextDispatch();
  assert.equal(service.snapshot().completedCacheSize, 0);
  assert.equal(service.snapshot().counts.cancelledOperations, 2);
});

test('ChunkDataService treats consumer epochs as subscriber ownership and shares cache results', async () => {
  const transport = deferredTransport();
  const service = new ChunkDataService({ transport });
  const stale = service.requestChunk({ chunkX: 7, chunkZ: 3, priority: 4, consumerId: 'distant', epoch: 1 });
  const current = service.requestChunk({ chunkX: 7, chunkZ: 3, priority: 4, consumerId: 'distant', epoch: 2 });
  await nextDispatch();
  assert.equal(transport.calls.length, 1);
  transport.pending.shift().resolve(chunk(7, 3));
  assert.equal(await stale.promise, null);
  const data = await current.promise;
  const cached = service.requestChunk({ chunkX: 7, chunkZ: 3, priority: 1, consumerId: 'runtime', epoch: 0 });
  assert.equal(await cached.promise, data);
  assert.equal(service.snapshot().counts.transportCalls, 1);
});

test('ChunkDataService enforces completed LRU capacity, identity audit, and shutdown late-result discard', async () => {
  const transport = deferredTransport();
  const service = new ChunkDataService({ transport, cacheCapacity: 81 });
  for (let index = 0; index < 82; index += 1) {
    const request = service.requestChunk({ chunkX: index, chunkZ: 0, priority: 1, consumerId: `runtime-${index}` });
    await nextDispatch();
    transport.pending.shift().resolve(chunk(index, 0));
    await request.promise;
  }
  assert.equal(service.snapshot().completedCacheSize, 81);
  const regenerated = service.requestChunk({ chunkX: 0, chunkZ: 0, priority: 1, consumerId: 'identity' });
  await nextDispatch();
  transport.pending.shift().resolve(chunk(0, 0, 'different'));
  await assert.rejects(regenerated.promise, /identity\/content/);

  const late = service.requestChunk({ chunkX: 200, chunkZ: 0, priority: 1, consumerId: 'late' });
  await nextDispatch();
  const shutdown = service.shutdown();
  transport.pending.shift().resolve(chunk(200, 0));
  await shutdown;
  assert.equal(await late.promise, null);
});
