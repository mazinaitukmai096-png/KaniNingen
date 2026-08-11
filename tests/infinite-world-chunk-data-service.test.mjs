import assert from 'node:assert/strict';
import test from 'node:test';
import { ChunkDataService } from '../src/infinite-world/chunk-data-service.js';
import { CHUNK_DATA_PRIORITY } from '../src/infinite-world/chunk-data-service-protocol.js';
import {
  createWorldGenerationRequestEnvelope,
  createWorldGenerationScheduler,
} from '../src/infinite-world/world-generation-scheduler.js';

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

async function terrainDependencyCompetitionFixture(requiredLookaheadCapacity) {
  let now = 100;
  let releaseBlocker;
  const blockerGate = new Promise(resolve => { releaseBlocker = resolve; });
  const workerTimeline = [];
  const ownerTimeline = new Map();
  let externalRequestId = 1_000;
  let timelineSequence = 0;
  const recordOwner = (ownerKey, event) => {
    let timeline = ownerTimeline.get(ownerKey);
    if (!timeline) {
      timeline = { ownerKey, queued: null, started: null, completed: null };
      ownerTimeline.set(ownerKey, timeline);
    }
    timeline[event] = ++timelineSequence;
  };
  const workerScheduler = createWorldGenerationScheduler({
    clock: () => now,
    agingIntervalMs: 100_000,
  });
  const transport = {
    async generateChunk(request) {
      const ownerKey = `${request.chunkX},${request.chunkZ}`;
      const handle = workerScheduler.schedule({
        envelope: request.scheduler,
        execute: async () => {
          workerTimeline.push(`terrain:${ownerKey}`);
          recordOwner(ownerKey, 'started');
          recordOwner(ownerKey, 'completed');
          return chunk(request.chunkX, request.chunkZ);
        },
      });
      const result = await handle.promise;
      // Model the Worker -> main-thread task boundary: the Worker selects its
      // next queued operation before ChunkDataService can feed another owner.
      return new Promise(resolve => setImmediate(() => resolve(result.value)));
    },
    snapshot: () => workerScheduler.snapshot(),
    async shutdown() { await workerScheduler.shutdown(); },
  };
  const blocker = workerScheduler.schedule({
    envelope: createWorldGenerationRequestEnvelope({
      requestId: ++externalRequestId,
      operationKind: 'forest-horizon',
      priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
      required: true,
      createdAtMs: now,
      deadlineAtMs: 0,
      consumerId: 'existing-worker-operation',
    }),
    execute: async () => { await blockerGate; },
  });
  await new Promise(resolve => setImmediate(resolve));

  const service = new ChunkDataService({
    transport,
    clock: () => now,
    agingIntervalMs: 100_000,
    requiredLookaheadCapacity,
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

  const natural = Array.from({ length: 20 }, (_, index) => workerScheduler.schedule({
    envelope: createWorldGenerationRequestEnvelope({
      requestId: ++externalRequestId,
      operationKind: 'forest-horizon',
      priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
      required: true,
      createdAtMs: now,
      deadlineAtMs: 0,
      consumerId: 'static-object-stream:natural-static',
    }),
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

test('ChunkDataService keeps exactly one required lookahead queued without publishing out of order', async () => {
  const transport = deferredTransport();
  const readyOrder = [];
  const service = new ChunkDataService({
    transport,
    requiredLookaheadCapacity: 1,
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
  assert.deepEqual(transport.calls.map(value => value.chunkX), [0, 1]);
  assert.equal(service.snapshot().inFlightCount, 2);
  assert.equal(service.snapshot().inFlightKey, '0,0');
  assert.equal(service.snapshot().requiredLookaheadKey, '1,0');

  let secondDelivered = false;
  void second.promise.then(() => { secondDelivered = true; });
  resolvePending(transport, 1);
  await nextDispatch();
  assert.equal(secondDelivered, false, 'lookahead completion must not publish before the active owner');
  assert.equal(service.snapshot().completedCacheSize, 0);

  resolvePending(transport, 0);
  assert.equal((await first.promise).chunkX, 0);
  assert.equal((await second.promise).chunkX, 1);
  await nextDispatch();
  assert.deepEqual(readyOrder, [0, 1]);
  assert.deepEqual(transport.calls.map(value => value.chunkX), [0, 1, 2]);
  assert.equal(service.snapshot().inFlightCount, 1,
    'non-required work must not occupy the required lookahead slot');

  resolvePending(transport, 2);
  assert.equal((await third.promise).chunkX, 2);
  await nextDispatch();
  assert.deepEqual(transport.calls.map(value => value.chunkX), [0, 1, 2, 3]);
  resolvePending(transport, 3);
  assert.equal((await warm.promise).chunkX, 3);
  await nextDispatch();

  const snapshot = service.snapshot();
  assert.deepEqual(readyOrder, [0, 1, 2, 3]);
  assert.equal(new Set(transport.calls.map(value => value.requestId)).size, 4);
  assert.equal(snapshot.pendingCount, 0);
  assert.equal(snapshot.inFlightCount, 0);
  assert.equal(snapshot.counts.pendingDedupeHits, 0);
  assert.equal(snapshot.counts.staleSubscriberResults, 0);
});

test('ChunkDataService exposes the complete 25-owner Terrain dependency batch to the shared Worker priority queue', async () => {
  const serialLookahead = await terrainDependencyCompetitionFixture(1);
  assert.equal(serialLookahead.supplyBeforeRelease.scheduler.workerCount, 1);
  assert.equal(serialLookahead.supplyBeforeRelease.inFlightCount, 2);
  assert.equal(serialLookahead.supplyBeforeRelease.queuedCount, 23);
  assert.equal(serialLookahead.naturalBeforeThirdTerrain, 20);

  const batchLookahead = await terrainDependencyCompetitionFixture(25);
  assert.equal(batchLookahead.supplyBeforeRelease.scheduler.workerCount, 1,
    'the fix must not increase Worker concurrency');
  assert.equal(batchLookahead.supplyBeforeRelease.inFlightCount, 25);
  assert.equal(batchLookahead.supplyBeforeRelease.requiredLookaheadCount, 24);
  assert.equal(batchLookahead.supplyBeforeRelease.queuedCount, 0);
  assert.equal(batchLookahead.naturalBeforeThirdTerrain, 0);
  assert.equal(batchLookahead.terrainBeforeFirstNatural, 25);
  assert.equal(batchLookahead.ownerTimeline.length, 25);
  for (const owner of batchLookahead.ownerTimeline) {
    assert.ok(owner.queued < owner.started, `${owner.ownerKey} must start after queue registration`);
    assert.ok(owner.started < owner.completed, `${owner.ownerKey} must complete after starting`);
  }
});

test('ChunkDataService cancels a required lookahead without duplicate, stale, or orphan state', async () => {
  const transport = deferredTransport();
  const service = new ChunkDataService({ transport, requiredLookaheadCapacity: 1 });
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
  assert.deepEqual(transport.calls.map(value => value.chunkX), [10, 11]);
  assert.equal(cancelled.cancel(), true);
  assert.deepEqual(transport.cancelCalls, [{
    requestId: 2,
    reason: 'no-active-subscribers',
  }]);
  resolvePending(transport, 11);
  resolvePending(transport, 10);
  assert.equal((await first.promise).chunkX, 10);
  assert.equal(await cancelled.promise, null);

  await nextDispatch();
  assert.deepEqual(transport.calls.map(value => value.chunkX), [10, 11, 12]);
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
