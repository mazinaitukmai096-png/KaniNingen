import assert from 'node:assert/strict';
import test from 'node:test';

import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import {
  W8_PARITY_CACHE_CAPACITIES,
  createPendingSafeLruCache,
  createW8ParityChunkGenerator,
} from '../src/infinite-world/w8-parity-chunk-generator.js';

const defaultSeed = 'KaniNingen Infinite Natural World';
const chunksPerMacroRegion = 768 / 16;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(turns = 4) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

function emptyConnectivityGraph(centerWorldX, centerWorldZ, radiusMeters) {
  return Object.freeze({
    schemaVersion: 'w5-settlement-connectivity-graph-1',
    center: Object.freeze({ x: centerWorldX, z: centerWorldZ }),
    radiusMeters,
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
  });
}

async function createEmptyConnectivityBase({ worldSeed }) {
  const base = await createDistributedSettlementChunkGenerator({ worldSeed });
  const distributor = Object.freeze({
    ...base.distributor,
    buildConnectivityGraphNear: async (centerWorldX, centerWorldZ, radiusMeters) => (
      emptyConnectivityGraph(centerWorldX, centerWorldZ, radiusMeters)
    ),
  });
  return Object.freeze({ ...base, distributor });
}

function syntheticConnectivityFixture(regionX, regionZ) {
  const regionSizeMeters = chunksPerMacroRegion * 16;
  const centerX = regionX * regionSizeMeters;
  const centerZ = regionZ * regionSizeMeters + 8;
  const firstId = `gp-str:${regionX},${regionZ}:a`;
  const secondId = `gp-str:${regionX},${regionZ}:b`;
  const ownerRegion = Object.freeze({ x: regionX, z: regionZ });
  const createNode = (stableId, x) => Object.freeze({
    stableId,
    ownerRegion,
    settlementType: 'RURAL',
    role: 'suburb',
    center: Object.freeze({ x, z: centerZ }),
    radiusMeters: 96,
    connectivityTier: 'LOCAL',
    candidateNeighborIds: Object.freeze([]),
  });
  const nodes = Object.freeze([
    createNode(firstId, centerX - 220),
    createNode(secondId, centerX + 220),
  ]);
  const edge = Object.freeze({
    schemaVersion: 'w5-settlement-connectivity-edge-1',
    stableId: `gp-str:${regionX},${regionZ}:edge`,
    settlementIds: Object.freeze([firstId, secondId]),
    ownerRegion,
    distanceMeters: 440,
  });
  const candidates = Object.freeze(nodes.map(node => Object.freeze({
    settlementId: node.stableId,
    macroRegion: node.ownerRegion,
    settlementType: node.settlementType,
    townType: node.role,
    center: node.center,
    radiusMeters: node.radiusMeters,
    urbanization: 0.5,
    terrainSuitability: 0.5,
  })));
  return Object.freeze({
    graph: Object.freeze({
      schemaVersion: 'w5-settlement-connectivity-graph-1',
      center: Object.freeze({ x: centerX, z: centerZ }),
      radiusMeters: 768,
      nodes,
      edges: Object.freeze([edge]),
    }),
    candidates,
  });
}

async function createSyntheticConnectivityBase({ worldSeed }) {
  const base = await createDistributedSettlementChunkGenerator({ worldSeed });
  const regionFor = (worldX, worldZ) => Object.freeze({
    x: Math.floor(worldX / (chunksPerMacroRegion * 16)),
    z: Math.floor(worldZ / (chunksPerMacroRegion * 16)),
  });
  const distributor = Object.freeze({
    ...base.distributor,
    buildConnectivityGraphNear: async (centerWorldX, centerWorldZ) => {
      const region = regionFor(centerWorldX, centerWorldZ);
      return syntheticConnectivityFixture(region.x, region.z).graph;
    },
    findSettlementCentersNear: async (centerWorldX, centerWorldZ) => {
      const region = regionFor(centerWorldX, centerWorldZ);
      return syntheticConnectivityFixture(region.x, region.z).candidates;
    },
  });
  return Object.freeze({ ...base, distributor });
}

function stableOwnerRecords(chunk) {
  const collections = [
    chunk.vegetationCandidates,
    chunk.rockCandidates,
    chunk.settlementReferences,
    chunk.settlementFeatures,
    chunk.waterSurfaces,
    chunk.ambientDetails,
    chunk.settlementLandmarks,
    chunk.streetDetails,
    chunk.riverRoadCrossings,
  ];
  return collections.flatMap(values => values ?? []).map(value => Object.freeze({
    stableId: value.stableId ?? value.candidateId ?? value.settlementId,
    owner: value.owningChunkCoordinate ?? value.ownerChunk ?? value.ownerRegion
      ?? value.metadata?.ownerChunk ?? null,
  })).filter(value => typeof value.stableId === 'string')
    .sort((left, right) => left.stableId.localeCompare(right.stableId));
}

function chunkIdentity(chunk) {
  return Object.freeze({
    chunkId: chunk.chunkId,
    contentHash: chunk.contentHash,
    sourceW5ContentHash: chunk.sourceW5ContentHash,
    stableOwners: stableOwnerRecords(chunk),
    riverPorts: (chunk.riverPorts ?? []).map(port => Object.freeze({ ...port })),
  });
}

function assertRoadCachesBounded(snapshot, capacities) {
  const road = snapshot.canonicalMajorRoad;
  for (const [prefix, capacityKey] of [
    ['graph', 'majorRoadGraph'],
    ['route', 'majorRoadRoute'],
    ['obstacle', 'majorRoadObstacle'],
    ['preparation', 'majorRoadPreparation'],
    ['sourceHash', 'majorRoadSourceHash'],
  ]) {
    assert.equal(road[`${prefix}CacheCapacity`], capacities[capacityKey]);
    assert.ok(road[`${prefix}CacheSize`] <= capacities[capacityKey]);
    assert.equal(road[`${prefix}CachePendingCount`], 0);
    assert.ok(road[`${prefix}CacheEvictionCount`] >= 0);
  }
  assert.ok(road.routeKeyIndexSize <= road.routeCacheSize);
  assert.ok(road.obstacleKeyIndexSize <= road.obstacleCacheSize);
}

function assertSettlementCachesBounded(snapshot, capacities) {
  assert.equal(snapshot.settlementOverlayCacheCapacity, capacities.settlementOverlay);
  assert.ok(snapshot.settlementOverlayCacheSize <= capacities.settlementOverlay);
  assert.equal(snapshot.settlementOverlayCachePendingCount, 0);
  assert.ok(snapshot.settlementOverlayCacheEvictionCount >= 0);
  assert.equal(snapshot.settlementDiagnosticCacheCapacity, capacities.settlementDiagnostics);
  assert.ok(snapshot.settlementDiagnosticCacheSize <= capacities.settlementDiagnostics);
  assert.equal(snapshot.observedSettlementDiagnostics.length,
    snapshot.settlementDiagnosticCacheSize);
}

test('GP-STR-01 pending-safe LRU stays bounded across 320 Macro Region keys', async () => {
  const capacity = 32;
  const removed = [];
  const cache = createPendingSafeLruCache({
    capacity,
    onRemove: (key, meta, reason) => removed.push({ key, meta, reason }),
  });

  for (let regionX = 0; regionX < 320; regionX += 1) {
    const key = `${regionX},${regionX % 7}`;
    const value = await cache.getOrCreate(key, async () => Object.freeze({ key }), { regionX });
    assert.equal(value.key, key);
    const snapshot = cache.snapshot();
    assert.ok(snapshot.size <= capacity);
    assert.equal(snapshot.pendingCount, 0);
  }

  const snapshot = cache.snapshot();
  assert.deepEqual(snapshot, {
    capacity,
    size: capacity,
    pendingCount: 0,
    evictionCount: 320 - capacity,
    closed: false,
  });
  assert.equal(cache.has('0,0'), false);
  assert.equal(cache.has('319,4'), true);
  assert.equal(removed.filter(value => value.reason === 'capacity').length, 320 - capacity);
  assert.deepEqual(removed[0], {
    key: '0,0',
    meta: { regionX: 0 },
    reason: 'capacity',
  });
});

test('GP-STR-01 pending-safe LRU protects pending work and deduplicates its loader', async () => {
  const cache = createPendingSafeLruCache({ capacity: 2 });
  const gate = deferred();
  let loaderCalls = 0;
  const pending = cache.getOrCreate('pending', () => {
    loaderCalls += 1;
    return gate.promise;
  });
  const duplicate = cache.getOrCreate('pending', () => {
    loaderCalls += 1;
    return Promise.resolve('duplicate');
  });
  assert.equal(duplicate, pending);

  await cache.getOrCreate('settled-a', async () => 'a');
  await cache.getOrCreate('settled-b', async () => 'b');
  const whilePending = cache.snapshot();
  assert.equal(loaderCalls, 1);
  assert.equal(cache.has('pending'), true);
  assert.equal(whilePending.pendingCount, 1);
  assert.ok(whilePending.size <= whilePending.capacity + whilePending.pendingCount);
  assert.ok(whilePending.evictionCount >= 1);

  gate.resolve('resolved');
  assert.equal(await pending, 'resolved');
  await drainMicrotasks();
  const settled = cache.snapshot();
  assert.equal(settled.pendingCount, 0);
  assert.ok(settled.size <= settled.capacity);
});

test('GP-STR-01 closing a pending-safe LRU drops entries and ignores late settlement', async () => {
  const removed = [];
  const cache = createPendingSafeLruCache({
    capacity: 2,
    onRemove: (key, meta, reason) => removed.push({ key, meta, reason }),
  });
  const gate = deferred();
  const pending = cache.getOrCreate('late', () => gate.promise, { generation: 1 });

  cache.close();
  assert.deepEqual(cache.snapshot(), {
    capacity: 2,
    size: 0,
    pendingCount: 0,
    evictionCount: 0,
    closed: true,
  });
  assert.deepEqual(removed, [{
    key: 'late',
    meta: { generation: 1 },
    reason: 'closed',
  }]);
  assert.throws(
    () => cache.getOrCreate('after-close', async () => 'never'),
    /closed/,
  );

  gate.resolve('late-result');
  assert.equal(await pending, 'late-result');
  await drainMicrotasks();
  assert.equal(cache.size, 0);
  assert.equal(cache.pendingCount, 0);
  assert.equal(cache.closed, true);
});

test('GP-STR-01 source shutdown cannot let an in-flight template repopulate its caches', async () => {
  const source = await createDistributedSettlementChunkGenerator({ worldSeed: defaultSeed });
  const candidate = await source.distributor.findHomeSettlement(0, 0);
  const pendingTemplate = source.resolveSettlementTemplate({ candidate });

  await source.shutdown();
  const template = await pendingTemplate;
  assert.equal(template.settlementId, candidate.settlementId);
  const snapshot = source.snapshot();
  assert.equal(snapshot.isShutdown, true);
  assert.equal(snapshot.templateCacheSize, 0);
  assert.equal(snapshot.distributor.rawCacheSize, 0);
  assert.equal(snapshot.distributor.acceptedCacheSize, 0);
  assert.equal(snapshot.distributor.connectivityNeighborCacheSize, 0);
  await assert.rejects(source.resolveSettlementTemplate({ candidate }), /shut down/);
});

test('GP-STR-01 320-Macro-Region traversal keeps real W8 generation caches bounded', {
  timeout: 30_000,
}, async t => {
  const generator = await createW8ParityChunkGenerator({
    worldSeed: defaultSeed,
    baseGeneratorFactory: createEmptyConnectivityBase,
  });
  const generationTimes = [];
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;

  for (let region = 0; region < 320; region += 1) {
    const startedAt = performance.now();
    await generator.generateChunk(
      region * chunksPerMacroRegion,
      (region % 7) * chunksPerMacroRegion,
    );
    generationTimes.push(performance.now() - startedAt);
    const snapshot = generator.snapshot();
    assert.ok(snapshot.warmSourceChunkCacheSize <= W8_PARITY_CACHE_CAPACITIES.warmSourceChunk);
    assertSettlementCachesBounded(snapshot, W8_PARITY_CACHE_CAPACITIES);
    assertRoadCachesBounded(snapshot, W8_PARITY_CACHE_CAPACITIES);
  }

  globalThis.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  const snapshot = generator.snapshot();
  assert.equal(snapshot.warmSourceChunkCacheSize, W8_PARITY_CACHE_CAPACITIES.warmSourceChunk);
  assert.equal(snapshot.warmSourceChunkPendingCount, 0);
  assert.equal(snapshot.canonicalMajorRoad.graphCacheSize,
    W8_PARITY_CACHE_CAPACITIES.majorRoadGraph);
  assert.equal(snapshot.canonicalMajorRoad.graphsBuilt, 320);
  assert.equal(snapshot.canonicalMajorRoad.graphCacheMisses, 320);
  assert.equal(snapshot.canonicalMajorRoad.graphCacheHits, 0);
  assert.equal(snapshot.canonicalMajorRoad.graphCacheEvictionCount,
    320 - W8_PARITY_CACHE_CAPACITIES.majorRoadGraph);
  assert.ok(snapshot.experienceSpawnCacheSize <= snapshot.experienceSpawnCacheCapacity);
  assertSettlementCachesBounded(snapshot, W8_PARITY_CACHE_CAPACITIES);
  assertRoadCachesBounded(snapshot, W8_PARITY_CACHE_CAPACITIES);
  assert.ok(snapshot.source.templateCacheSize <= snapshot.source.templateCacheCapacity);
  assert.ok(snapshot.source.distributor.rawCacheSize
    <= snapshot.source.distributor.rawCacheCapacity);
  assert.ok(snapshot.source.distributor.acceptedCacheSize
    <= snapshot.source.distributor.acceptedCacheCapacity);
  assert.ok(snapshot.source.distributor.connectivityNeighborCacheSize
    <= snapshot.source.distributor.connectivityNeighborCacheCapacity);

  t.diagnostic(JSON.stringify({
    regions: 320,
    heapBefore,
    heapAfter,
    heapDelta: heapAfter - heapBefore,
    first64P95Ms: percentile(generationTimes.slice(0, 64), 0.95),
    last64P95Ms: percentile(generationTimes.slice(-64), 0.95),
    maximumMs: Math.max(...generationTimes),
    warmSourceChunkCacheSize: snapshot.warmSourceChunkCacheSize,
    graphCacheSize: snapshot.canonicalMajorRoad.graphCacheSize,
  }));

  await generator.shutdown();
});

test('GP-STR-01 eviction preserves W8 content hash, Stable IDs, and boundary ownership on revisit', {
  timeout: 30_000,
}, async () => {
  const cacheCapacities = Object.freeze(Object.fromEntries(
    Object.keys(W8_PARITY_CACHE_CAPACITIES).map(key => [
      key,
      key === 'warmSourceChunk' ? 4 : 2,
    ]),
  ));
  const generator = await createW8ParityChunkGenerator({
    worldSeed: defaultSeed,
    baseGeneratorFactory: createSyntheticConnectivityBase,
    cacheCapacities,
  });
  const boundaryCoordinates = Object.freeze([[0, 0], [1, 0]]);
  const before = new Map();
  for (const [chunkX, chunkZ] of boundaryCoordinates) {
    const chunk = await generator.generateChunk(chunkX, chunkZ);
    before.set(`${chunkX},${chunkZ}`, chunkIdentity(chunk));
  }

  for (let region = 10; region < 18; region += 1) {
    await generator.generateChunk(region * chunksPerMacroRegion, 0);
  }
  const evicted = generator.snapshot();
  assert.equal(evicted.warmSourceChunkCacheSize, cacheCapacities.warmSourceChunk);
  assert.equal(evicted.canonicalMajorRoad.graphCacheSize, cacheCapacities.majorRoadGraph);
  assert.ok(evicted.canonicalMajorRoad.graphCacheEvictionCount > 0);
  assert.ok(evicted.settlementOverlayCacheEvictionCount > 0);
  for (const prefix of ['route', 'obstacle', 'preparation', 'sourceHash']) {
    assert.equal(evicted.canonicalMajorRoad[`${prefix}CacheSize`],
      evicted.canonicalMajorRoad[`${prefix}CacheCapacity`]);
    assert.ok(evicted.canonicalMajorRoad[`${prefix}CacheEvictionCount`] > 0);
  }
  assertSettlementCachesBounded(evicted, cacheCapacities);
  assertRoadCachesBounded(evicted, cacheCapacities);
  const graphMissesBeforeRevisit = evicted.canonicalMajorRoad.graphCacheMisses;

  for (const [chunkX, chunkZ] of boundaryCoordinates) {
    const revisited = await generator.generateChunk(chunkX, chunkZ);
    assert.deepEqual(chunkIdentity(revisited), before.get(`${chunkX},${chunkZ}`));
  }
  const revisitedSnapshot = generator.snapshot();
  assert.equal(revisitedSnapshot.warmSourceChunkPendingCount, 0);
  assert.equal(revisitedSnapshot.canonicalMajorRoad.graphCacheMisses,
    graphMissesBeforeRevisit + 1);
  assertSettlementCachesBounded(revisitedSnapshot, cacheCapacities);
  assertRoadCachesBounded(revisitedSnapshot, cacheCapacities);

  await generator.shutdown();
});

test('GP-STR-01 generator shutdown releases every retained cache and rejects later generation', async () => {
  const generator = await createW8ParityChunkGenerator({
    worldSeed: defaultSeed,
    baseGeneratorFactory: createEmptyConnectivityBase,
    cacheCapacities: Object.freeze(Object.fromEntries(
      Object.keys(W8_PARITY_CACHE_CAPACITIES).map(key => [key, 2]),
    )),
  });
  await generator.generateChunk(0, 0);
  await generator.generateChunk(chunksPerMacroRegion, 0);
  await generator.shutdown();

  const snapshot = generator.snapshot();
  assert.equal(snapshot.isShutdown, true);
  assert.equal(snapshot.warmSourceChunkCacheSize, 0);
  assert.equal(snapshot.warmSourceChunkPendingCount, 0);
  assert.equal(snapshot.settlementOverlayCacheSize, 0);
  assert.equal(snapshot.settlementOverlayCachePendingCount, 0);
  assert.equal(snapshot.settlementDiagnosticCacheSize, 0);
  assert.equal(snapshot.observedSettlementDiagnostics.length, 0);
  assert.equal(snapshot.source.templateCacheSize, 0);
  assert.equal(snapshot.source.distributor.rawCacheSize, 0);
  assert.equal(snapshot.source.distributor.acceptedCacheSize, 0);
  assert.equal(snapshot.source.distributor.connectivityNeighborCacheSize, 0);
  assert.ok(snapshot.experienceSpawnCacheSize <= snapshot.experienceSpawnCacheCapacity);
  const road = snapshot.canonicalMajorRoad;
  for (const prefix of ['graph', 'route', 'obstacle', 'preparation', 'sourceHash']) {
    assert.equal(road[`${prefix}CacheSize`], 0);
    assert.equal(road[`${prefix}CachePendingCount`], 0);
  }
  assert.equal(road.routeKeyIndexSize, 0);
  assert.equal(road.obstacleKeyIndexSize, 0);
  await assert.rejects(generator.generateChunk(0, 0), /shut down/);
});
