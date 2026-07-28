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
  return {
    calls,
    pending,
    async generateChunk(request) {
      calls.push(request);
      return new Promise((resolve, reject) => pending.push({ request, resolve, reject }));
    },
    snapshot: () => Object.freeze({ kind: 'test' }),
    async shutdown() {},
  };
}

async function nextDispatch() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
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
  for (const expectedX of [1, 2, 0, 3, 4, 5]) {
    await nextDispatch();
    assert.equal(transport.calls.at(-1).chunkX, expectedX);
    transport.pending.shift().resolve(chunk(expectedX, 0));
  }
  const values = await Promise.all(requests.map(request => request.promise));
  assert.deepEqual(values.map(value => value.chunkX), [5, 4, 3, 1, 2, 0]);
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
  transport.pending.shift().resolve(chunk(2, 2));
  assert.equal(await inflight.promise, null);
  await nextDispatch();
  assert.equal(service.snapshot().completedCacheSize, 1);
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
