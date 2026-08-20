import assert from 'node:assert/strict';
import test from 'node:test';

import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { createInlineChunkGeneratorTransport } from '../src/infinite-world/inline-chunk-generator-transport.js';
import {
  W8_PARITY_CACHE_CAPACITIES,
  createPendingSafeLruCache,
  createW8ParityChunkGenerator,
} from '../src/infinite-world/w8-parity-chunk-generator.js';

const defaultSeed = 'KaniNingen Infinite Natural World';
const chunksPerMacroRegion = 768 / 16;
const requestOrderFixtureOwner = Object.freeze({ x: 55, z: 77 });
const requestOrderFixtureCenter = Object.freeze({
  x: (requestOrderFixtureOwner.x + 0.5) * 16,
  z: (requestOrderFixtureOwner.z + 0.5) * 16,
});

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

function collectCanonicalEntries(value, select, path = '$', entries = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectCanonicalEntries(entry, select, `${path}[${index}]`, entries);
    });
    return entries;
  }
  if (!value || typeof value !== 'object') return entries;
  const selected = select(value, path);
  if (selected !== null && selected !== undefined) entries.push(selected);
  for (const [key, entry] of Object.entries(value)) {
    collectCanonicalEntries(entry, select, `${path}.${key}`, entries);
  }
  return entries;
}

function canonicalStableIds(value) {
  const idKeys = new Set([
    'candidateId',
    'settlementId',
    'sourceSegmentStableId',
    'sourceStableId',
    'stableId',
  ]);
  const entries = [];
  const visit = (current, path = '$') => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, entry] of Object.entries(current)) {
      const entryPath = `${path}.${key}`;
      if (idKeys.has(key) && typeof entry === 'string') {
        entries.push(Object.freeze({ path: entryPath, id: entry }));
      }
      visit(entry, entryPath);
    }
  };
  visit(value);
  return Object.freeze(entries);
}

function canonicalCoordinates(value) {
  return Object.freeze(collectCanonicalEntries(value, (entry, path) => {
    if (!Number.isFinite(entry.x) || !Number.isFinite(entry.z)) return null;
    if (Object.hasOwn(entry, 'y')) {
      assert.ok(Number.isFinite(entry.y), `${path}.y must be a finite canonical Terrain Y`);
    }
    return Object.freeze({
      path,
      x: entry.x,
      y: Object.hasOwn(entry, 'y') ? entry.y : null,
      z: entry.z,
    });
  }));
}

function canonicalOwnerIdentities(value) {
  const ownerKeys = new Set([
    'macroRegion',
    'ownerChunk',
    'ownerRegion',
    'owningChunkCoordinate',
  ]);
  const entries = [];
  const visit = (current, path = '$') => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, entry] of Object.entries(current)) {
      const entryPath = `${path}.${key}`;
      if (ownerKeys.has(key) && Number.isFinite(entry?.x) && Number.isFinite(entry?.z)) {
        entries.push(Object.freeze({ path: entryPath, x: entry.x, z: entry.z }));
      }
      visit(entry, entryPath);
    }
  };
  visit(value);
  return Object.freeze(entries);
}

function canonicalFeatureRecords(value, kind) {
  return Object.freeze(collectCanonicalEntries(value, (entry, path) => {
    if (typeof entry.stableId !== 'string') return null;
    const featureType = `${entry.featureType ?? ''}`.toLowerCase();
    const matches = kind === 'Road'
      ? entry.canonicalMajorRoad === true || featureType.includes('road')
      : featureType.includes('building') || typeof entry.buildingType === 'string';
    return matches ? Object.freeze({ path, record: entry }) : null;
  }));
}

function assertFiniteSettlementMetadata(world, label) {
  const references = world.chunk.settlementReferences ?? [];
  assert.ok(references.length > 0, `${label}: fixture must contain a Settlement reference`);
  const metadata = [...references, world.template];
  for (const entry of metadata) {
    const prefix = `${label}: ${entry.settlementId ?? entry.stableId}`;
    assert.equal(typeof entry.settlementId, 'string', `${prefix} Settlement ID`);
    assert.ok(Number.isFinite(entry.center?.x), `${prefix} center.x`);
    assert.ok(Number.isFinite(entry.center?.z), `${prefix} center.z`);
    assert.ok(Number.isFinite(entry.radiusMeters), `${prefix} radiusMeters`);
    assert.ok(Number.isFinite(entry.urbanization), `${prefix} urbanization`);
    assert.ok(Number.isFinite(entry.terrainSuitability), `${prefix} terrainSuitability`);
    assert.ok(Number.isSafeInteger(entry.macroRegion?.x), `${prefix} macroRegion.x`);
    assert.ok(Number.isSafeInteger(entry.macroRegion?.z), `${prefix} macroRegion.z`);
  }
}

function assertCanonicalWorldMatches(actual, expected, label) {
  assertFiniteSettlementMetadata(actual, label);
  assert.equal(actual.chunk.contentHash, expected.chunk.contentHash,
    `${label}: W8 content hash`);
  assert.equal(actual.chunk.sourceW5ContentHash, expected.chunk.sourceW5ContentHash,
    `${label}: source W5 content hash`);
  assert.equal(actual.chunk.sourceChunkData.contentHash, expected.chunk.sourceChunkData.contentHash,
    `${label}: embedded source content hash`);
  assert.equal(actual.chunk.sourceChunkData.contentHash, actual.chunk.sourceW5ContentHash,
    `${label}: embedded source identity`);
  assert.deepEqual(canonicalStableIds(actual), canonicalStableIds(expected),
    `${label}: Stable IDs`);
  assert.deepEqual(canonicalCoordinates(actual), canonicalCoordinates(expected),
    `${label}: canonical XYZ and Terrain Y`);
  assert.deepEqual(actual.chunk.terrain.heights, expected.chunk.terrain.heights,
    `${label}: canonical Terrain height samples`);
  assert.deepEqual(actual.chunk.terrain.heightRangeMeters,
    expected.chunk.terrain.heightRangeMeters, `${label}: canonical Terrain height range`);
  assert.deepEqual(
    (actual.chunk.settlementReferences ?? []).map(reference => Object.freeze({
      settlementId: reference.settlementId,
      settlementType: reference.settlementType,
      townType: reference.townType,
      macroRegion: reference.macroRegion,
      center: reference.center,
      radiusMeters: reference.radiusMeters,
      urbanization: reference.urbanization,
      terrainSuitability: reference.terrainSuitability,
    })),
    (expected.chunk.settlementReferences ?? []).map(reference => Object.freeze({
      settlementId: reference.settlementId,
      settlementType: reference.settlementType,
      townType: reference.townType,
      macroRegion: reference.macroRegion,
      center: reference.center,
      radiusMeters: reference.radiusMeters,
      urbanization: reference.urbanization,
      terrainSuitability: reference.terrainSuitability,
    })),
    `${label}: Settlement metadata`,
  );
  assert.deepEqual(canonicalFeatureRecords(actual, 'Road'),
    canonicalFeatureRecords(expected, 'Road'), `${label}: canonical Road records`);
  assert.deepEqual(canonicalFeatureRecords(actual, 'Building'),
    canonicalFeatureRecords(expected, 'Building'), `${label}: canonical Building records`);
  assert.deepEqual(canonicalOwnerIdentities(actual), canonicalOwnerIdentities(expected),
    `${label}: canonical owner identity`);
  assert.deepEqual(actual.template, expected.template,
    `${label}: complete Settlement presentation template`);
  assert.deepEqual(actual.presentationOwner, expected.presentationOwner,
    `${label}: complete PresentationOwner`);
  assert.deepEqual(actual.chunk, expected.chunk, `${label}: complete ChunkData`);
}

async function withInlineW8Generator(options, operation) {
  const generator = await createW8ParityChunkGenerator({
    worldSeed: defaultSeed,
    ...(options ?? {}),
  });
  const transport = createInlineChunkGeneratorTransport({ generator });
  try {
    await transport.initialize();
    return await operation({ generator, transport });
  } finally {
    await transport.shutdown();
  }
}

function canonicalPresentationOwner(owner) {
  return Object.freeze({
    schemaVersion: owner.schemaVersion,
    chunkId: owner.chunkId,
    contentHash: owner.contentHash,
    chunkX: owner.chunkX,
    chunkZ: owner.chunkZ,
    resource: owner.resource,
    canonicalSurfacePolicy: owner.canonicalSurfacePolicy,
    riverProjection: owner.riverProjection,
  });
}

async function collectCanonicalWorld({
  transport,
  candidate,
  chunk = null,
  template = null,
  presentationOwner = null,
}) {
  const resolvedChunk = chunk ?? await transport.generateChunk({
    chunkX: requestOrderFixtureOwner.x,
    chunkZ: requestOrderFixtureOwner.z,
  });
  const resolvedTemplate = template ?? await transport.resolveSettlementPresentationTemplate({
    candidate,
  });
  const resolvedPresentationOwner = presentationOwner
    ?? await transport.generatePresentationOwner({
      chunkX: requestOrderFixtureOwner.x,
      chunkZ: requestOrderFixtureOwner.z,
    });
  return Object.freeze({
    chunk: resolvedChunk,
    template: resolvedTemplate,
    // CPU diagnostics are intentionally run-dependent and are not World content.
    presentationOwner: canonicalPresentationOwner(resolvedPresentationOwner),
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

test('P0 source template cache rejects missing or non-finite identity before lookup', async () => {
  const source = await createDistributedSettlementChunkGenerator({ worldSeed: defaultSeed });
  try {
    const candidate = await source.distributor.findHomeSettlement(0, 0);
    const before = source.snapshot();
    await assert.rejects(
      source.resolveSettlementTemplate({ candidate: null }),
      /Settlement candidate is required/,
    );
    await assert.rejects(
      source.resolveSettlementTemplate({
        candidate: Object.freeze({ ...candidate, terrainSuitability: null }),
      }),
      /finite canonical metadata/,
    );
    const after = source.snapshot();
    assert.equal(after.templateCacheSize, before.templateCacheSize);
    assert.equal(after.templateCachePendingCount, before.templateCachePendingCount);
    assert.equal(after.templateCacheHits, before.templateCacheHits);
    assert.equal(after.templateCacheMisses, before.templateCacheMisses);
    assert.equal(after.templatesMaterialized, before.templatesMaterialized);
  } finally {
    await source.shutdown();
  }
});

test('P0 source template cache rejects changed finite metadata for a cached Settlement ID',
  async () => {
    const source = await createDistributedSettlementChunkGenerator({ worldSeed: defaultSeed });
    try {
      const candidate = await source.distributor.findHomeSettlement(0, 0);
      await source.resolveSettlementTemplate({ candidate });
      const beforeConflict = source.snapshot();
      const changed = Object.freeze({
        ...candidate,
        urbanization: candidate.urbanization + 0.000001,
      });
      await assert.rejects(
        source.resolveSettlementTemplate({ candidate: changed }),
        new RegExp(`candidate identity conflict for ${candidate.settlementId}`),
      );
      const afterConflict = source.snapshot();
      assert.equal(afterConflict.templateCacheSize, 1);
      assert.equal(afterConflict.templateCachePendingCount, 0);
      assert.equal(afterConflict.templateCacheHits, beforeConflict.templateCacheHits);
      assert.equal(afterConflict.templateCacheMisses, beforeConflict.templateCacheMisses);
      assert.equal(afterConflict.templatesMaterialized, beforeConflict.templatesMaterialized);
    } finally {
      await source.shutdown();
    }
  });

test('P0 source template cache rejects a simultaneous same-ID different identity', async () => {
  const source = await createDistributedSettlementChunkGenerator({ worldSeed: defaultSeed });
  try {
    const candidate = await source.distributor.findHomeSettlement(0, 0);
    const pending = source.resolveSettlementTemplate({ candidate });
    const changed = Object.freeze({
      ...candidate,
      terrainSuitability: candidate.terrainSuitability + 0.000001,
    });
    await assert.rejects(
      source.resolveSettlementTemplate({ candidate: changed }),
      new RegExp(`Pending Settlement template candidate identity conflict for ${candidate.settlementId}`),
    );
    const template = await pending;
    assert.equal(template.settlementId, candidate.settlementId);
    const snapshot = source.snapshot();
    assert.equal(snapshot.templateCacheSize, 1);
    assert.equal(snapshot.templateCachePendingCount, 0);
    assert.equal(snapshot.templateCacheMisses, 1);
    assert.equal(snapshot.templatesMaterialized, 1);
  } finally {
    await source.shutdown();
  }
});

test('P0 source template generation snapshots a mutable candidate before its first await',
  async () => {
    const source = await createDistributedSettlementChunkGenerator({ worldSeed: defaultSeed });
    try {
      const candidate = await source.distributor.findHomeSettlement(0, 0);
      const mutable = {
        ...candidate,
        macroRegion: { ...candidate.macroRegion },
        center: { ...candidate.center },
      };
      const pending = source.resolveSettlementTemplate({ candidate: mutable });
      mutable.settlementId = `${candidate.settlementId}:mutated`;
      mutable.macroRegion.x += 1;
      mutable.center.x += 1_000;
      mutable.urbanization += 0.1;
      mutable.terrainSuitability -= 0.1;

      const first = await pending;
      assert.equal(first.settlementId, candidate.settlementId);
      assert.deepEqual(first.center, candidate.center);
      assert.equal(first.urbanization, candidate.urbanization);
      assert.equal(first.terrainSuitability, candidate.terrainSuitability);
      assert.deepEqual(
        await source.resolveSettlementTemplate({ candidate }),
        first,
        'the cached template must retain the pre-await canonical snapshot',
      );
      const snapshot = source.snapshot();
      assert.equal(snapshot.templateCacheSize, 1);
      assert.equal(snapshot.templatesMaterialized, 1);
    } finally {
      await source.shutdown();
    }
  });

test('P0 W8 public template resolution snapshots mutable candidate input end-to-end', async () => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: defaultSeed });
  try {
    const candidate = await generator.distributor.findHomeSettlement(0, 0);
    const mutable = {
      ...candidate,
      macroRegion: { ...candidate.macroRegion },
      center: { ...candidate.center },
    };
    const pending = generator.resolveSettlementPresentationTemplate({ candidate: mutable });
    mutable.settlementId = `${candidate.settlementId}:mutated`;
    mutable.macroRegion.z += 1;
    mutable.center.z -= 1_000;
    mutable.urbanization += 0.1;
    mutable.terrainSuitability -= 0.1;

    const first = await pending;
    assert.equal(first.settlementId, candidate.settlementId);
    assert.deepEqual(first.center, candidate.center);
    assert.equal(first.urbanization, candidate.urbanization);
    assert.equal(first.terrainSuitability, candidate.terrainSuitability);
    assert.deepEqual(
      await generator.resolveSettlementPresentationTemplate({ candidate }),
      first,
      'the W8 overlay and source cache must retain the same pre-await snapshot',
    );
  } finally {
    await generator.shutdown();
  }
});

test('P0 resident W8 identity rejects a changed candidate before an evicted source can be poisoned', {
  timeout: 60_000,
}, async () => {
  const generator = await createW8ParityChunkGenerator({
    worldSeed: defaultSeed,
    cacheCapacities: Object.freeze({
      ...W8_PARITY_CACHE_CAPACITIES,
      settlementOverlay: 129,
    }),
  });
  try {
    const target = await generator.distributor.findHomeSettlement(0, 0);
    const expected = await generator.resolveSettlementPresentationTemplate({ candidate: target });
    const initial = generator.snapshot();
    const sourceCapacity = initial.source.templateCacheCapacity;
    assert.equal(sourceCapacity, 128);
    assert.ok(initial.settlementOverlayCacheCapacity > sourceCapacity);
    const candidates = await generator.distributor.findSettlementsNear(0, 0, 8_000);
    const fillers = candidates.filter(candidate => candidate.settlementId !== target.settlementId)
      .slice(0, sourceCapacity);
    assert.equal(fillers.length, sourceCapacity,
      'fixture must fill the production source cache while retaining the target W8 overlay');
    for (const candidate of fillers) {
      await generator.resolveSettlementPresentationTemplate({ candidate });
    }
    const beforeConflict = generator.snapshot();
    assert.equal(beforeConflict.source.templateCacheSize, sourceCapacity);
    assert.equal(beforeConflict.settlementOverlayCacheSize, sourceCapacity + 1);

    const changed = Object.freeze({
      ...target,
      urbanization: target.urbanization + 0.000001,
    });
    await assert.rejects(
      generator.resolveSettlementPresentationTemplate({ candidate: changed }),
      new RegExp(`Settlement overlay candidate identity conflict for ${target.settlementId}`),
    );
    const afterConflict = generator.snapshot();
    assert.equal(afterConflict.source.templateCacheHits,
      beforeConflict.source.templateCacheHits);
    assert.equal(afterConflict.source.templateCacheMisses,
      beforeConflict.source.templateCacheMisses);
    assert.equal(afterConflict.source.templatesMaterialized,
      beforeConflict.source.templatesMaterialized);
    assert.equal(afterConflict.settlementOverlayCacheSize,
      beforeConflict.settlementOverlayCacheSize);
    assert.equal(afterConflict.settlementOverlayCacheEvictionCount,
      beforeConflict.settlementOverlayCacheEvictionCount);
    assert.equal(afterConflict.canonicalMajorRoad.settlementTemplateRequests,
      beforeConflict.canonicalMajorRoad.settlementTemplateRequests);

    const recovered = await generator.resolveSettlementPresentationTemplate({ candidate: target });
    assert.deepEqual(recovered, expected,
      'a rejected conflict must not poison the next canonical source-cache rebuild');
    const afterRecovery = generator.snapshot();
    assert.equal(afterRecovery.source.templateCacheMisses,
      beforeConflict.source.templateCacheMisses + 1);
    assert.equal(afterRecovery.source.templatesMaterialized,
      beforeConflict.source.templatesMaterialized + 1);
    assert.equal(afterRecovery.canonicalMajorRoad.settlementTemplateCacheHits,
      beforeConflict.canonicalMajorRoad.settlementTemplateCacheHits + 1);
  } finally {
    await generator.shutdown();
  }
});

test('P0 Inline canonical World content is independent of request order and cache history', {
  timeout: 180_000,
}, async t => {
  const timings = {};
  const freshStartedAt = performance.now();
  const fresh = await withInlineW8Generator(null, async ({ transport }) => {
    const chunk = await transport.generateChunk({
      chunkX: requestOrderFixtureOwner.x,
      chunkZ: requestOrderFixtureOwner.z,
    });
    const settlementId = chunk.settlementReferences?.[0]?.settlementId;
    assert.equal(typeof settlementId, 'string',
      'request-order fixture must expose its canonical Settlement reference');
    const candidates = await transport.findSettlementsNear(
      requestOrderFixtureCenter.x,
      requestOrderFixtureCenter.z,
      256,
    );
    const candidate = candidates.find(value => value.settlementId === settlementId);
    assert.ok(candidate, `missing canonical candidate ${settlementId}`);
    return Object.freeze({
      candidate,
      world: await collectCanonicalWorld({ transport, candidate, chunk }),
    });
  });
  timings.freshMs = performance.now() - freshStartedAt;
  assertCanonicalWorldMatches(fresh.world, fresh.world, 'fresh');
  assert.ok(canonicalFeatureRecords(fresh.world, 'Road').length > 0,
    'fixture must compare canonical Road records');
  assert.ok(canonicalFeatureRecords(fresh.world, 'Building').length > 0,
    'fixture must compare canonical Building records');

  const coverageRequest = transport => transport.resolveCanonicalMajorRoadOwnerCoverage({
    centerWorldX: requestOrderFixtureCenter.x,
    centerWorldZ: requestOrderFixtureCenter.z,
    radiusMeters: 0,
  });
  const generateFixtureChunk = transport => transport.generateChunk({
    chunkX: requestOrderFixtureOwner.x,
    chunkZ: requestOrderFixtureOwner.z,
  });
  const generateFixtureOwner = transport => transport.generatePresentationOwner({
    chunkX: requestOrderFixtureOwner.x,
    chunkZ: requestOrderFixtureOwner.z,
  });
  const resolveFixtureTemplate = transport => (
    transport.resolveSettlementPresentationTemplate({ candidate: fresh.candidate })
  );

  const scenarios = Object.freeze([
    Object.freeze({
      name: 'coverage-first',
      run: async transport => {
        const coverage = await coverageRequest(transport);
        assert.ok(coverage.roadCount > 0, 'coverage-first must exercise canonical MAJOR Roads');
        return collectCanonicalWorld({ transport, candidate: fresh.candidate });
      },
    }),
    Object.freeze({
      name: 'template-first',
      run: async transport => {
        const template = await resolveFixtureTemplate(transport);
        return collectCanonicalWorld({ transport, candidate: fresh.candidate, template });
      },
    }),
    Object.freeze({
      name: 'PresentationOwner-first',
      run: async transport => {
        const presentationOwner = await generateFixtureOwner(transport);
        return collectCanonicalWorld({
          transport,
          candidate: fresh.candidate,
          presentationOwner,
        });
      },
    }),
    Object.freeze({
      name: 'parallel',
      repeat: 5,
      run: async transport => {
        const [coverage, template, presentationOwner, chunk, duplicateChunk] = await Promise.all([
          coverageRequest(transport),
          resolveFixtureTemplate(transport),
          generateFixtureOwner(transport),
          generateFixtureChunk(transport),
          generateFixtureChunk(transport),
        ]);
        assert.ok(coverage.roadCount > 0, 'parallel must exercise canonical MAJOR Roads');
        assert.deepEqual(duplicateChunk, chunk,
          'parallel duplicate Full requests must resolve identical ChunkData');
        return collectCanonicalWorld({
          transport,
          candidate: fresh.candidate,
          chunk,
          template,
          presentationOwner,
        });
      },
    }),
    Object.freeze({
      name: 'reverse',
      run: async transport => {
        const presentationOwner = await generateFixtureOwner(transport);
        const template = await resolveFixtureTemplate(transport);
        const coverage = await coverageRequest(transport);
        assert.ok(coverage.roadCount > 0, 'reverse must exercise canonical MAJOR Roads');
        const chunk = await generateFixtureChunk(transport);
        return collectCanonicalWorld({
          transport,
          candidate: fresh.candidate,
          chunk,
          template,
          presentationOwner,
        });
      },
    }),
  ]);

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const runTimes = [];
      for (let iteration = 0; iteration < (scenario.repeat ?? 1); iteration += 1) {
        const startedAt = performance.now();
        const actual = await withInlineW8Generator(null, ({ transport }) => (
          scenario.run(transport)
        ));
        runTimes.push(performance.now() - startedAt);
        assertCanonicalWorldMatches(actual, fresh.world,
          `${scenario.name} run ${iteration + 1}`);
      }
      timings[`${scenario.name}Ms`] = scenario.repeat
        ? Object.freeze(runTimes)
        : runTimes[0];
    });
  }

  await t.test('cache eviction and revisit', async () => {
    const startedAt = performance.now();
    const smallCapacities = Object.freeze(Object.fromEntries(
      Object.keys(W8_PARITY_CACHE_CAPACITIES).map(key => [key, 1]),
    ));
    const revisited = await withInlineW8Generator({
      cacheCapacities: smallCapacities,
    }, async ({ generator, transport }) => {
      const initial = await collectCanonicalWorld({
        transport,
        candidate: fresh.candidate,
      });
      assertCanonicalWorldMatches(initial, fresh.world, 'pre-eviction');
      // Touch the target last, then materialize enough distinct canonical
      // templates to force both W8 overlay eviction and the source LRU past it.
      await resolveFixtureTemplate(transport);
      const beforeFill = generator.snapshot();
      const sourceCapacity = beforeFill.source.templateCacheCapacity;
      const candidates = await transport.findSettlementsNear(
        requestOrderFixtureCenter.x,
        requestOrderFixtureCenter.z,
        8_000,
      );
      const requiredFillerCount = sourceCapacity + beforeFill.source.templateCacheSize + 1;
      const fillers = candidates.filter(candidate => (
        candidate.settlementId !== fresh.candidate.settlementId
      )).slice(0, requiredFillerCount);
      assert.equal(fillers.length, requiredFillerCount,
        'fixture must contain enough distinct Settlements for real source-cache eviction');
      for (const candidate of fillers) {
        await transport.resolveSettlementPresentationTemplate({ candidate });
      }
      const afterFill = generator.snapshot();
      assert.ok(afterFill.settlementOverlayCacheEvictionCount
        > beforeFill.settlementOverlayCacheEvictionCount,
      'the W8 Settlement overlay LRU must actually evict entries');
      assert.equal(afterFill.source.templateCacheSize, sourceCapacity,
        'the source Settlement template LRU must reach its bounded capacity');

      await transport.generateChunk({
        chunkX: requestOrderFixtureOwner.x + chunksPerMacroRegion * 8,
        chunkZ: requestOrderFixtureOwner.z + chunksPerMacroRegion * 5,
      });
      const beforeRevisit = generator.snapshot();
      assert.ok(beforeRevisit.canonicalOwnerCache.counts.evictions > 0,
        'the W8 canonical owner cache must actually evict the target owner');
      const result = await collectCanonicalWorld({
        transport,
        candidate: fresh.candidate,
      });
      const afterRevisit = generator.snapshot();
      assert.ok(afterRevisit.source.templateCacheMisses
        > beforeRevisit.source.templateCacheMisses,
      'revisit must miss the underlying source template cache, not reuse the target');
      assert.ok(afterRevisit.canonicalOwnerCache.counts.loads
        > beforeRevisit.canonicalOwnerCache.counts.loads,
      'revisit must rebuild the evicted canonical owner');
      return result;
    });
    timings.cacheEvictionRevisitMs = performance.now() - startedAt;
    assertCanonicalWorldMatches(revisited, fresh.world, 'cache eviction and revisit');
  });

  t.diagnostic(JSON.stringify({
    owner: requestOrderFixtureOwner,
    contentHash: fresh.world.chunk.contentHash,
    sourceW5ContentHash: fresh.world.chunk.sourceW5ContentHash,
    timings,
  }));
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
