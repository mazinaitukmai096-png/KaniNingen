import assert from 'node:assert/strict';
import test from 'node:test';
import { ChunkDataService } from '../src/infinite-world/chunk-data-service.js';
import { CHUNK_DATA_PRIORITY } from '../src/infinite-world/chunk-data-service-protocol.js';

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

test('ChunkDataService cancels a required lookahead without duplicate, stale, or orphan state', async () => {
  const transport = deferredTransport();
  const service = new ChunkDataService({ transport });
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
