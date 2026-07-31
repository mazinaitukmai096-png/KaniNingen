import assert from 'node:assert/strict';
import test from 'node:test';

import { ChunkDataService } from '../src/infinite-world/chunk-data-service.js';
import { InfiniteWorldState, encodeInfiniteWorldSave } from '../src/infinite-world/world-state-store.js';
import {
  WORLD_STREAMING_EVENT,
  WORLD_STREAMING_STREAM,
  WORLD_STREAMING_TARGET,
  WORLD_STREAMING_TELEMETRY_SCHEMA,
  createWorldStreamingTelemetry,
  worldStreamingTargetForCanonicalObject,
} from '../src/infinite-world/world-streaming-telemetry.js';

const requestDetails = Object.freeze({
  target: WORLD_STREAMING_TARGET.TREE,
  stream: WORLD_STREAMING_STREAM.DISTANT,
  resourceKey: '4,-2',
  ownerKey: '4,-2',
  stableId: 'wf1:tree:phase-1',
});

test('World Streaming Telemetry exposes the complete Phase 1 target and event taxonomy', () => {
  assert.deepEqual(Object.values(WORLD_STREAMING_TARGET).sort(), [
    'building', 'bush', 'distant', 'gameplay', 'grass',
    'near', 'rock', 'settlement', 'tree',
  ]);
  assert.deepEqual(Object.values(WORLD_STREAMING_EVENT).sort(), [
    'cache-hit', 'cache-miss', 'cancelled', 'failed', 'first-draw',
    'player-arrival', 'publish', 'request', 'worker-complete', 'worker-start',
  ]);
});

test('World Streaming Telemetry records ordered request-to-arrival lifecycle events', () => {
  let now = 0;
  const telemetry = createWorldStreamingTelemetry({
    enabled: true,
    capacity: 32,
    clock: () => now,
    sessionId: 'ordered',
  });
  const correlationId = telemetry.beginRequest(requestDetails);
  for (const type of [
    WORLD_STREAMING_EVENT.CACHE_MISS,
    WORLD_STREAMING_EVENT.WORKER_START,
    WORLD_STREAMING_EVENT.WORKER_COMPLETE,
    WORLD_STREAMING_EVENT.PUBLISH,
    WORLD_STREAMING_EVENT.FIRST_DRAW,
    WORLD_STREAMING_EVENT.PLAYER_ARRIVAL,
  ]) {
    now += 5;
    telemetry.record(type, { ...requestDetails, correlationId });
  }

  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.schemaVersion, WORLD_STREAMING_TELEMETRY_SCHEMA);
  assert.deepEqual(snapshot.events.map(event => event.type), [
    'request', 'cache-miss', 'worker-start', 'worker-complete',
    'publish', 'first-draw', 'player-arrival',
  ]);
  assert.deepEqual(snapshot.events.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(snapshot.orderViolationCount, 0);
  assert.equal(snapshot.lifecycles.length, 1);
  assert.equal(snapshot.lifecycles[0].requestToFirstDrawMs, 25);
  assert.equal(snapshot.lifecycles[0].firstDrawToPlayerArrivalMs, 5);
});

test('disabled World Streaming Telemetry is a complete no-op and never reads its clock', () => {
  let clockReads = 0;
  const telemetry = createWorldStreamingTelemetry({
    enabled: false,
    capacity: 0,
    clock: () => { clockReads += 1; throw new Error('disabled clock read'); },
  });
  assert.equal(telemetry.enabled, false);
  assert.equal(telemetry.beginRequest(requestDetails), null);
  assert.equal(telemetry.record(WORLD_STREAMING_EVENT.REQUEST, requestDetails), null);
  assert.equal(clockReads, 0);
  assert.deepEqual(telemetry.snapshot(), {
    schemaVersion: WORLD_STREAMING_TELEMETRY_SCHEMA,
    enabled: false,
    capacity: 0,
    size: 0,
    droppedEventCount: 0,
    orderViolationCount: 0,
    resourceIndexSize: 0,
    events: [],
    lifecycles: [],
  });
});

test('World Streaming Telemetry enforces a strict event and lifecycle capacity', () => {
  let now = 0;
  const telemetry = createWorldStreamingTelemetry({
    enabled: true,
    capacity: 3,
    clock: () => ++now,
    sessionId: 'bounded',
  });
  for (let index = 0; index < 5; index += 1) {
    telemetry.beginRequest({
      target: WORLD_STREAMING_TARGET.NEAR,
      stream: WORLD_STREAMING_STREAM.NEAR,
      resourceKey: `${index},0`,
      ownerKey: `${index},0`,
    });
  }
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.capacity, 3);
  assert.equal(snapshot.size, 3);
  assert.equal(snapshot.droppedEventCount, 2);
  assert.deepEqual(snapshot.events.map(event => event.sequence), [3, 4, 5]);
  assert.equal(snapshot.lifecycles.length, 3);
  assert.ok(snapshot.resourceIndexSize <= snapshot.capacity * 3);
});

test('request and first draw correlate by stream, target, and owner resource', () => {
  let now = 100;
  const telemetry = createWorldStreamingTelemetry({
    enabled: true,
    clock: () => now,
    sessionId: 'correlation',
  });
  const correlationId = telemetry.beginRequest(requestDetails);
  now = 145;
  const publish = telemetry.record(WORLD_STREAMING_EVENT.PUBLISH, requestDetails);
  now = 160;
  const firstDraw = telemetry.record(WORLD_STREAMING_EVENT.FIRST_DRAW, requestDetails);
  assert.equal(publish.correlationId, correlationId);
  assert.equal(firstDraw.correlationId, correlationId);
  assert.equal(telemetry.snapshot().lifecycles[0].requestToFirstDrawMs, 60);
});

test('failed lifecycle is retained as an explicit terminal event', () => {
  const telemetry = createWorldStreamingTelemetry({ enabled: true, clock: () => 1 });
  const correlationId = telemetry.beginRequest(requestDetails);
  telemetry.record(WORLD_STREAMING_EVENT.FAILED, {
    ...requestDetails,
    correlationId,
    metadata: { name: 'Error', message: 'injected' },
  });
  const snapshot = telemetry.snapshot();
  assert.deepEqual(snapshot.events.map(event => event.type), ['request', 'failed']);
  assert.equal(snapshot.lifecycles[0].terminalType, 'failed');
});

test('ChunkDataService emits request, cache, Worker-boundary, completion, and cancellation events', async () => {
  let resolveGeneration;
  const transport = {
    initialize: async () => ({}),
    generateChunk: async ({ chunkX, chunkZ }) => new Promise(resolve => {
      resolveGeneration = () => resolve(Object.freeze({
        chunkX,
        chunkZ,
        chunkId: `chunk:${chunkX},${chunkZ}`,
        contentHash: `sha256:${'a'.repeat(64)}`,
      }));
    }),
    shutdown: async () => {},
  };
  let now = 0;
  const telemetry = createWorldStreamingTelemetry({ enabled: true, clock: () => ++now });
  const service = new ChunkDataService({ transport, telemetry });
  const generated = service.requestChunk({ chunkX: 2, chunkZ: 3, consumerId: 'phase-1' });
  await new Promise(resolve => setImmediate(resolve));
  resolveGeneration();
  await generated.promise;
  await service.requestChunk({ chunkX: 2, chunkZ: 3, consumerId: 'phase-1-cache' }).promise;
  const cancelled = service.requestChunk({ chunkX: 8, chunkZ: 9, consumerId: 'phase-1-cancel' });
  cancelled.cancel();
  await cancelled.promise;

  const types = telemetry.snapshot().events.map(event => event.type);
  assert.deepEqual(types.slice(0, 4), [
    'request', 'cache-miss', 'worker-start', 'worker-complete',
  ]);
  assert.deepEqual(types.slice(4), ['request', 'cache-hit', 'request', 'cache-miss', 'cancelled']);
  const events = telemetry.snapshot().events;
  const workerStart = events.find(event => event.type === WORLD_STREAMING_EVENT.WORKER_START);
  const workerComplete = events.find(event => event.type === WORLD_STREAMING_EVENT.WORKER_COMPLETE);
  const cancelledEvent = events.find(event => event.type === WORLD_STREAMING_EVENT.CANCELLED);
  assert.equal(Number.isFinite(workerStart.metadata.queueTimeMs), true);
  assert.equal(Number.isFinite(workerStart.metadata.startTimeMs), true);
  assert.equal(workerStart.metadata.terminalState, null);
  assert.equal(workerStart.metadata.cancellationReason, null);
  assert.equal(typeof workerStart.metadata.deadlineMiss, 'boolean');
  assert.equal(Number.isSafeInteger(workerStart.metadata.priorityAging), true);
  assert.equal(Number.isSafeInteger(workerStart.metadata.backlog), true);
  assert.equal(workerComplete.metadata.terminalState, 'completed');
  assert.equal(workerComplete.metadata.cancellationReason, null);
  assert.equal(cancelledEvent.metadata.terminalState, 'cancelled');
  assert.equal(cancelledEvent.metadata.cancellationReason, 'consumer-cancelled');
  await service.shutdown();
});

test('Telemetry is not serialized and observes Stable IDs without changing them', async () => {
  const state = new InfiniteWorldState({
    worldSeed: 'Phase 1 Save Isolation',
    worldSeedHash: `sha256:${'1'.repeat(64)}`,
    playerSpawn: { x: 0, z: 0 },
  });
  const canonical = Object.freeze({ objectType: 'tree', stableId: requestDetails.stableId });
  const telemetry = createWorldStreamingTelemetry({ enabled: true, clock: () => 1 });
  telemetry.beginRequest({ ...requestDetails, stableId: canonical.stableId });
  const serialized = await encodeInfiniteWorldSave(state.createSaveSnapshot());

  assert.equal(canonical.stableId, requestDetails.stableId);
  assert.equal(telemetry.snapshot().events[0].stableId, canonical.stableId);
  assert.doesNotMatch(serialized, /streaming|telemetry|manifest|publication/i);
  assert.equal(worldStreamingTargetForCanonicalObject(canonical), WORLD_STREAMING_TARGET.TREE);
  assert.equal(worldStreamingTargetForCanonicalObject({ objectType: 'shrub' }), WORLD_STREAMING_TARGET.BUSH);
  assert.equal(worldStreamingTargetForCanonicalObject({ objectType: 'grass' }), WORLD_STREAMING_TARGET.GRASS);
  assert.equal(worldStreamingTargetForCanonicalObject({ objectType: 'rock' }), WORLD_STREAMING_TARGET.ROCK);
  assert.equal(worldStreamingTargetForCanonicalObject({ objectType: 'building' }), WORLD_STREAMING_TARGET.BUILDING);
});
