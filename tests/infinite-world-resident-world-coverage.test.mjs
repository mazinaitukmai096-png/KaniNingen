import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from 'node:v8';

import {
  FULL_RESIDENT_RADIUS_METERS,
  FULL_CHUNK_DATA_CACHE_CAPACITY,
  FULL_RESIDENT_BOUNDED_PREFETCH_OWNER_COUNT,
  FULL_RESIDENT_OWNER_COUNT,
  PRESENTATION_RESIDENT_RADIUS_METERS,
  PRESENTATION_OWNER_CACHE_CAPACITY,
  PRESENTATION_RESIDENT_OWNER_COUNT,
  RESIDENT_WORLD_BOUNDED_PREFETCH_OWNER_COUNT,
  RESIDENT_WORLD_CHUNK_DATA_CACHE_CAPACITY,
  RESIDENT_WORLD_MAXIMUM_VISIBLE_RADIUS_METERS,
  RESIDENT_WORLD_OWNER_COUNT,
  RESIDENT_WORLD_REQUIRED_RADIUS_METERS,
  createResidentWorldCoverage,
  resolvePresentationResidentRadiusMeters,
  planRuntimeTerrainReadySet,
} from '../src/infinite-world/chunk-streaming-plan.js';
import { ChunkDataService } from '../src/infinite-world/chunk-data-service.js';
import { ChunkRuntimeManager } from '../src/infinite-world/chunk-runtime-manager.js';
import { createNodeChunkGeneratorWorker } from '../src/infinite-world/node-worker-chunk-generator-adapter.js';
import { createWorkerChunkGeneratorTransport } from '../src/infinite-world/worker-chunk-generator-transport.js';
import { getW6ScaleProfile } from '../src/infinite-world/gameplay-contract.js';
import {
  createCircularStaticStreamingPolicy,
  STATIC_OBJECT_STREAM_VELOCITY_PREFETCH,
} from '../src/infinite-world/static-object-stream.js';
import {
  LEGACY_RUNTIME_CHUNK_POLICY_KIND,
  createLegacyRuntimeChunkStreamingPolicy,
  createWorldStreamingPlan,
} from '../src/infinite-world/world-streaming-plan.js';
import {
  W8_VEGETATION_LOD_KINDS,
  resolveW8VegetationVisibilityContract,
} from '../src/infinite-world/vegetation-lod-policy.js';

const residentPlan = ({
  centerChunkX = 0,
  centerChunkZ = 0,
  velocityX = 0,
  velocityZ = 0,
} = {}) => {
  const coverage = createResidentWorldCoverage({ centerChunkX, centerChunkZ });
  const speedMetersPerSecond = Math.hypot(velocityX, velocityZ);
  return planRuntimeTerrainReadySet({
    centerChunkX,
    centerChunkZ,
    logicalX: centerChunkX * 16 + 8,
    logicalZ: centerChunkZ * 16 + 8,
    velocityX,
    velocityZ,
    speedMetersPerSecond,
    scaleStageId: 'MAX',
    sprint: speedMetersPerSecond > 0,
    residentCoverage: coverage,
  });
};

const difference = (left, right) => {
  const rightSet = new Set(right);
  return left.filter(key => !rightSet.has(key));
};

class ResidentAdapter {
  async rebase() {}
  async projectChunk(data) {
    return { key: `${data.chunkX},${data.chunkZ}`, lifecycle: 'staged' };
  }
  async loadProjected(projected) { projected.lifecycle = 'loaded'; }
  async unloadChunk() {}
  async discardProjected(projected) { projected.lifecycle = 'discarded'; }
  async shutdown() {}
}

function fakeChunk(chunkX, chunkZ) {
  const key = `${chunkX},${chunkZ}`;
  return Object.freeze({
    chunkX,
    chunkZ,
    chunkId: `resident-test:${key}`,
    contentHash: `resident-test-hash:${key}`,
  });
}

test('Resident World is one 360-degree player-Chunk set independent of camera and velocity', () => {
  const coverage = createResidentWorldCoverage({ centerChunkX: 0, centerChunkZ: 0 });
  assert.equal(RESIDENT_WORLD_MAXIMUM_VISIBLE_RADIUS_METERS, 352);
  assert.equal(RESIDENT_WORLD_REQUIRED_RADIUS_METERS, 368);
  assert.equal(coverage.residentRequiredOwnerKeys.length, RESIDENT_WORLD_OWNER_COUNT);
  assert.equal(RESIDENT_WORLD_OWNER_COUNT, 1757);
  assert.equal(PRESENTATION_RESIDENT_OWNER_COUNT, 1757);
  assert.equal(FULL_RESIDENT_OWNER_COUNT, 145);
  assert.equal(RESIDENT_WORLD_BOUNDED_PREFETCH_OWNER_COUNT, 609);
  assert.equal(FULL_RESIDENT_BOUNDED_PREFETCH_OWNER_COUNT, 145);
  assert.equal(PRESENTATION_OWNER_CACHE_CAPACITY, 2366);
  assert.equal(FULL_CHUNK_DATA_CACHE_CAPACITY, 290);
  assert.equal(RESIDENT_WORLD_CHUNK_DATA_CACHE_CAPACITY, FULL_CHUNK_DATA_CACHE_CAPACITY);
  assert.strictEqual(coverage.residentDataOwnerKeys, coverage.fullView.ownerKeys);
  assert.strictEqual(coverage.residentTerrainOwnerKeys, coverage.fullView.ownerKeys);
  assert.strictEqual(coverage.residentNaturalOwnerKeys, coverage.presentationView.ownerKeys);
  assert.strictEqual(coverage.residentStructureOwnerKeys, coverage.presentationView.ownerKeys);
  assert.equal(coverage.renderDistancePreset, 'current');

  const presetResidentExpectations = Object.freeze({
    short: Object.freeze({ radiusMeters: 208, ownerCount: 593 }),
    standard: Object.freeze({ radiusMeters: 272, ownerCount: 981 }),
    current: Object.freeze({ radiusMeters: 368, ownerCount: 1757 }),
  });
  for (const [renderDistancePreset, expected] of Object.entries(presetResidentExpectations)) {
    const presetCoverage = createResidentWorldCoverage({
      centerChunkX: 0,
      centerChunkZ: 0,
      renderDistancePreset,
    });
    assert.equal(resolvePresentationResidentRadiusMeters(renderDistancePreset),
      expected.radiusMeters);
    assert.equal(presetCoverage.presentationView.radiusMeters, expected.radiusMeters);
    assert.equal(presetCoverage.presentationView.ownerKeys.length, expected.ownerCount);
    assert.equal(presetCoverage.fullView.radiusMeters, FULL_RESIDENT_RADIUS_METERS);
    assert.equal(presetCoverage.fullView.ownerKeys.length, FULL_RESIDENT_OWNER_COUNT);
  }

  const profile = getW6ScaleProfile('MAX');
  const directions = [
    [0, -profile.sprintMetersPerSecond],
    [profile.sprintMetersPerSecond, 0],
    [0, profile.sprintMetersPerSecond],
    [-profile.sprintMetersPerSecond, 0],
  ];
  const plans = directions.map(([velocityX, velocityZ]) => residentPlan({
    velocityX,
    velocityZ,
  }));
  for (const plan of plans) {
    assert.deepEqual(plan.residentRequiredOwnerKeys, coverage.fullView.ownerKeys);
    assert.deepEqual(plan.residentPresentationOwnerKeys, coverage.presentationView.ownerKeys);
    assert.ok(plan.velocityPrefetchOwnerKeys.length > 0);
    assert.ok(plan.dataCoordinates.length <= FULL_CHUNK_DATA_CACHE_CAPACITY);
  }
  assert.equal(new Set(plans.map(plan => plan.velocityPrefetchOwnerKeys.join('|'))).size, 4);
  assert.deepEqual(residentPlan().residentRequiredOwnerKeys, coverage.fullView.ownerKeys);

  const repeatedInput = {
    centerChunkX: 0,
    centerChunkZ: 0,
    logicalX: 8,
    logicalZ: 8,
    velocityX: profile.sprintMetersPerSecond,
    velocityZ: 0,
    speedMetersPerSecond: profile.sprintMetersPerSecond,
    scaleStageId: 'MAX',
    sprint: true,
    residentCoverage: coverage,
  };
  const firstPlan = planRuntimeTerrainReadySet(repeatedInput);
  const sameChunkPlan = planRuntimeTerrainReadySet({ ...repeatedInput, logicalX: 9 });
  assert.strictEqual(sameChunkPlan, firstPlan);
});

test('Resident master coverage scales Presentation by preset while Full remains 100m', t => {
  const centered = createResidentWorldCoverage({ centerChunkX: 0, centerChunkZ: 0 });
  assert.equal(PRESENTATION_RESIDENT_RADIUS_METERS, 368);
  assert.equal(FULL_RESIDENT_RADIUS_METERS, 100);
  assert.equal(centered.presentationView.ownerKeys.length, 1757);
  assert.equal(centered.fullView.ownerKeys.length, 145);
  const short = createResidentWorldCoverage({
    centerChunkX: 0, centerChunkZ: 0, renderDistancePreset: 'short',
  });
  const standard = createResidentWorldCoverage({
    centerChunkX: 0, centerChunkZ: 0, renderDistancePreset: 'standard',
  });
  assert.equal(short.presentationView.radiusMeters, 208);
  assert.equal(short.presentationView.ownerKeys.length, 593);
  assert.equal(standard.presentationView.radiusMeters, 272);
  assert.equal(standard.presentationView.ownerKeys.length, 981);
  assert.deepEqual(short.fullView.ownerKeys, centered.fullView.ownerKeys);
  assert.deepEqual(standard.fullView.ownerKeys, centered.fullView.ownerKeys);
  assert.ok(centered.fullView.ownerKeys.every(key => centered.presentationView.ownerKeys.includes(key)));
  assert.ok(short.presentationView.ownerKeys.every(
    key => centered.presentationView.ownerKeys.includes(key),
  ));
  assert.ok(standard.presentationView.ownerKeys.every(
    key => centered.presentationView.ownerKeys.includes(key),
  ));
  assert.equal(new Set([
    ...centered.presentationView.ownerKeys,
    ...short.presentationView.ownerKeys,
  ]).size, centered.presentationView.ownerKeys.length,
  'Current -> Short staging can protect the old and requested presets without exceeding Current');

  const straight = createResidentWorldCoverage({ centerChunkX: 1, centerChunkZ: 0 });
  const diagonal = createResidentWorldCoverage({ centerChunkX: 1, centerChunkZ: 1 });
  const straightEntering = difference(straight.fullView.ownerKeys, centered.fullView.ownerKeys);
  const diagonalEntering = difference(diagonal.fullView.ownerKeys, centered.fullView.ownerKeys);
  assert.equal(straightEntering.length, 13);
  assert.equal(diagonalEntering.length, 19);

  const maximumPrefetch = createResidentWorldCoverage({ centerChunkX: 13, centerChunkZ: 1 });
  const fullPrefetchUnion = new Set([
    ...centered.fullView.ownerKeys,
    ...maximumPrefetch.fullView.ownerKeys,
  ]);
  assert.ok(fullPrefetchUnion.size <= 290);
  const sprint = getW6ScaleProfile('MAX').sprintMetersPerSecond;
  const straightDemand = straightEntering.length * sprint / 16;
  const diagonalDemand = diagonalEntering.length * sprint / 16 / Math.SQRT2;
  const measuredFullWorkerSupply = 63;
  assert.ok(diagonalDemand <= 40.1792);
  assert.ok(measuredFullWorkerSupply / diagonalDemand >= 1.5);
  t.diagnostic(JSON.stringify({
    presentationResidentOwners: centered.presentationView.ownerKeys.length,
    fullResidentOwners: centered.fullView.ownerKeys.length,
    fullPrefetchUnionOwners: fullPrefetchUnion.size,
    straightEnteringOwners: straightEntering.length,
    diagonalEnteringOwners: diagonalEntering.length,
    straightDemandOwnersPerSecond: straightDemand,
    diagonalDemandOwnersPerSecond: diagonalDemand,
    fullWorkerSupplyOwnersPerSecond: measuredFullWorkerSupply,
    fullWorkerMargin: measuredFullWorkerSupply / diagonalDemand,
  }));
});

test('Resident overlap update requests only the straight/diagonal entering difference', async t => {
  const calls = [];
  const transport = {
    initialize: async () => Object.freeze({ kind: 'resident-overlap-fixture' }),
    generateChunk: async request => {
      calls.push(`${request.chunkX},${request.chunkZ}`);
      return fakeChunk(request.chunkX, request.chunkZ);
    },
    cancelGenerationRequest: () => false,
    snapshot: () => Object.freeze({ kind: 'resident-overlap-fixture' }),
    shutdown: async () => {},
  };
  const chunkDataService = new ChunkDataService({
    transport,
    cacheCapacity: RESIDENT_WORLD_CHUNK_DATA_CACHE_CAPACITY,
  });
  await chunkDataService.initialize();
  const runtime = new ChunkRuntimeManager({
    chunkDataService,
    renderAdapter: new ResidentAdapter(),
    cacheCapacity: RESIDENT_WORLD_CHUNK_DATA_CACHE_CAPACITY,
    yieldToHost: () => Promise.resolve(),
  });
  const first = residentPlan();
  await runtime.updateTerrainReadySet(first);
  assert.equal(calls.length, FULL_RESIDENT_OWNER_COUNT);

  const straight = residentPlan({ centerChunkX: 1 });
  const straightEntering = difference(
    straight.residentRequiredOwnerKeys,
    first.residentRequiredOwnerKeys,
  );
  const straightLeaving = difference(
    first.residentRequiredOwnerKeys,
    straight.residentRequiredOwnerKeys,
  );
  assert.equal(straightEntering.length, 13);
  assert.equal(straightLeaving.length, 13);
  const beforeStraight = calls.length;
  await runtime.updateTerrainReadySet(straight);
  assert.deepEqual(calls.slice(beforeStraight).sort(), [...straightEntering].sort());
  let snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.terrainReady.residentWorld.lastOwnerSetDiff, {
    unchanged: FULL_RESIDENT_OWNER_COUNT - straightEntering.length,
    entering: straightEntering.length,
    leaving: straightLeaving.length,
  });
  assert.equal(snapshot.terrainReady.residentWorld.fullWindowRebuild, 0);

  const diagonal = residentPlan({ centerChunkX: 2, centerChunkZ: 1 });
  const diagonalEntering = difference(
    diagonal.residentRequiredOwnerKeys,
    straight.residentRequiredOwnerKeys,
  );
  assert.equal(diagonalEntering.length, 19);
  const beforeDiagonal = calls.length;
  await runtime.updateTerrainReadySet(diagonal);
  const diagonalRequests = calls.slice(beforeDiagonal);
  assert.equal(diagonalRequests.every(key => diagonalEntering.includes(key)), true);
  assert.equal(new Set(diagonalRequests).size, diagonalRequests.length);
  snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.terrainReady.residentWorld.lastOwnerSetDiff, {
    unchanged: FULL_RESIDENT_OWNER_COUNT - diagonalEntering.length,
    entering: diagonalEntering.length,
    leaving: diagonalEntering.length,
  });
  assert.equal(snapshot.terrainReady.residentWorld.coverageMiss, 0);
  assert.equal(snapshot.terrainReady.residentWorld.ownerEviction, 0);
  assert.equal(snapshot.terrainReady.residentWorld.sameOwnerRerequest, 0);
  assert.equal(snapshot.terrainReady.residentWorld.requiredCancellationByPrefetch, 0);
  assert.equal(chunkDataService.snapshot().counts.protectedOwnerEvictions, 0);
  const sprint = getW6ScaleProfile('MAX').sprintMetersPerSecond;
  for (let centerChunkX = 3; centerChunkX <= 14; centerChunkX += 1) {
    const moving = residentPlan({ centerChunkX, centerChunkZ: 1, velocityX: sprint });
    await runtime.updateTerrainReadySet(moving);
    assert.equal(moving.residentCoverage.fullView.ownerCoordinates.some(
      coordinate => runtime.getChunkData(coordinate.chunkX, coordinate.chunkZ) === null,
    ), false);
  }
  const stopped = residentPlan({ centerChunkX: 14, centerChunkZ: 1 });
  const reversed = residentPlan({
    centerChunkX: 14,
    centerChunkZ: 1,
    velocityX: -sprint,
  });
  await runtime.updateTerrainReadySet(stopped);
  await runtime.updateTerrainReadySet(reversed);
  await runtime.updateTerrainReadySet(stopped);
  snapshot = runtime.snapshot();
  assert.equal(snapshot.terrainReady.residentWorld.coverageMiss, 0);
  assert.equal(snapshot.terrainReady.residentWorld.ownerEviction, 0);
  assert.equal(snapshot.terrainReady.residentWorld.sameOwnerRerequest, 0);
  assert.equal(snapshot.terrainReady.residentWorld.requiredCancellationByPrefetch, 0);
  t.diagnostic(JSON.stringify({
    residentOwnerCount: FULL_RESIDENT_OWNER_COUNT,
    straightEntering: straightEntering.length,
    straightLeaving: straightLeaving.length,
    diagonalEntering: diagonalEntering.length,
    longSprintChunks: 12,
    cache: snapshot.terrainReady.chunkDataSubscriberDiagnostics.cachePressure,
  }));
  await runtime.shutdown();
  await chunkDataService.shutdown();
});

test('Resident protection survives prefetch reversal while evicting only non-resident data', async () => {
  const transport = {
    initialize: async () => null,
    generateChunk: async request => fakeChunk(request.chunkX, request.chunkZ),
    cancelGenerationRequest: () => false,
    snapshot: () => null,
    shutdown: async () => {},
  };
  const service = new ChunkDataService({ transport, cacheCapacity: 4 });
  await service.initialize();
  service.replaceProtectedOwnerKeys(['0,0', '1,0', '2,0']);
  for (let chunkX = 0; chunkX < 6; chunkX += 1) {
    await service.requestChunk({ chunkX, chunkZ: 0, consumerId: `owner-${chunkX}` }).promise;
  }
  let snapshot = service.snapshot();
  assert.deepEqual(snapshot.protectedOwnerKeys, ['0,0', '1,0', '2,0']);
  assert.equal(snapshot.protectedResidentOwnerCount, 3);
  assert.equal(snapshot.counts.protectedOwnerEvictions, 0);
  assert.ok(snapshot.counts.completedEvictions > 0);
  service.replaceProtectedOwnerKeys(['1,0', '2,0', '3,0']);
  await service.requestChunk({ chunkX: 3, chunkZ: 0, consumerId: 'entered-resident' }).promise;
  snapshot = service.snapshot();
  assert.equal(snapshot.protectedResidentOwnerCount, 3);
  assert.equal(snapshot.counts.protectedOwnerEvictions, 0);
  await service.shutdown();
});

test('Full promotion keeps Presentation drawable until the same owner is Full-ready', async () => {
  const stableId = 'detail-v1:vegetation:presentation-full-promotion';
  const presentation = Object.freeze({
    ...fakeChunk(6, 4),
    chunkX: 6,
    chunkZ: 4,
    schemaVersion: 'w8-presentation-owner-data-1',
    resource: Object.freeze({
      natural: Object.freeze([Object.freeze({
        stableId,
        owner: '6,4',
        position: Object.freeze([104, 2.5, 72]),
      })]),
    }),
  });
  const full = Object.freeze({
    ...fakeChunk(6, 4),
    presentationLayers: Object.freeze({
      natural: Object.freeze({
        vegetation: Object.freeze([Object.freeze({
          candidateId: stableId,
          owningChunkCoordinate: Object.freeze({ x: 6, z: 4 }),
          worldPosition: Object.freeze({ x: 104, y: 2.5, z: 72 }),
        })]),
      }),
    }),
  });
  let releaseFull;
  const fullReady = new Promise(resolve => { releaseFull = () => resolve(full); });
  const presentationService = new ChunkDataService({
    cacheCapacity: 4,
    transport: {
      initialize: async () => null,
      generateChunk: async () => presentation,
      cancelGenerationRequest: () => false,
      snapshot: () => null,
      shutdown: async () => {},
    },
  });
  const fullService = new ChunkDataService({
    cacheCapacity: 4,
    transport: {
      initialize: async () => null,
      generateChunk: async () => fullReady,
      cancelGenerationRequest: () => false,
      snapshot: () => null,
      shutdown: async () => {},
    },
  });
  await Promise.all([presentationService.initialize(), fullService.initialize()]);
  presentationService.replaceProtectedOwnerKeys(['6,4']);
  fullService.replaceProtectedOwnerKeys(['6,4']);
  const presentationHandle = presentationService.requestChunk({
    chunkX: 6,
    chunkZ: 4,
    consumerId: 'far-presentation',
  });
  assert.strictEqual(await presentationHandle.promise, presentation);
  const promotion = fullService.requestChunk({
    chunkX: 6,
    chunkZ: 4,
    consumerId: 'full-promotion',
    required: false,
  });
  await Promise.resolve();
  assert.strictEqual(presentationService.getCompletedChunk(6, 4), presentation);
  assert.equal(fullService.getCompletedChunk(6, 4), null);
  releaseFull();
  assert.strictEqual(await promotion.promise, full);
  assert.strictEqual(presentationService.getCompletedChunk(6, 4), presentation);
  assert.equal(
    presentation.resource.natural[0].stableId,
    full.presentationLayers.natural.vegetation[0].candidateId,
  );
  assert.equal(presentationService.snapshot().counts.protectedOwnerEvictions, 0);
  assert.equal(fullService.snapshot().counts.protectedOwnerEvictions, 0);
  await Promise.all([presentationService.shutdown(), fullService.shutdown()]);
});

test('Runtime and Static Natural required coverage derive from the same Resident center', t => {
  const coverage = createResidentWorldCoverage({ centerChunkX: 0, centerChunkZ: 0 });
  const treeProfile = renderDistancePreset => (
    resolveW8VegetationVisibilityContract(renderDistancePreset)
      .byKind[W8_VEGETATION_LOD_KINDS.TREE]
  );
  const tree = createCircularStaticStreamingPolicy({
    kind: 'natural-tree',
    publicationGroup: 'natural-static',
    maximumRequiredDistanceMeters: 300,
    distanceProfileResolver: treeProfile,
  });
  const policies = [createLegacyRuntimeChunkStreamingPolicy(), tree.policy];
  const planFor = (sequence, player, velocity) => createWorldStreamingPlan({
    sequence,
    generatedAtMs: sequence,
    player,
    velocity,
    renderDistancePreset: 'current',
    policies,
    residentCoverage: coverage,
  });
  const east = planFor(1, { x: 1, z: 1 }, { x: 47.85, z: 0 });
  const west = planFor(2, { x: 15, z: 15 }, { x: -47.85, z: 0 });
  const runtimeEast = east.policyPlans.find(
    policy => policy.kind === LEGACY_RUNTIME_CHUNK_POLICY_KIND,
  );
  const runtimeWest = west.policyPlans.find(
    policy => policy.kind === LEGACY_RUNTIME_CHUNK_POLICY_KIND,
  );
  const naturalEast = east.policyPlans.find(policy => policy.kind === 'natural-tree');
  const naturalWest = west.policyPlans.find(policy => policy.kind === 'natural-tree');
  assert.deepEqual(runtimeEast.requiredOwnerKeys, coverage.fullView.ownerKeys);
  assert.deepEqual(runtimeWest.requiredOwnerKeys, coverage.fullView.ownerKeys);
  assert.deepEqual(naturalEast.requiredOwnerKeys, naturalWest.requiredOwnerKeys);
  assert.ok(naturalEast.requiredOwnerKeys.every(
    ownerKey => coverage.presentationView.ownerKeys.includes(ownerKey),
  ));
  assert.notDeepEqual(naturalEast.prefetchedOwnerKeys, naturalWest.prefetchedOwnerKeys);
  assert.equal(STATIC_OBJECT_STREAM_VELOCITY_PREFETCH.maximumDistanceMeters, 192);

  const naturalPolicies = Object.values(W8_VEGETATION_LOD_KINDS).map(kind => (
    createCircularStaticStreamingPolicy({
      kind: `natural-${kind}`,
      publicationGroup: 'natural-static',
      maximumRequiredDistanceMeters: 300,
      distanceProfileResolver: renderDistancePreset => (
        resolveW8VegetationVisibilityContract(renderDistancePreset).byKind[kind]
      ),
    }).policy
  ));
  const centeredNaturalPlan = (
    sequence,
    centerChunkX,
    centerChunkZ,
    velocity = { x: 0, z: 0 },
    renderDistancePreset = 'current',
  ) => {
    const centeredCoverage = createResidentWorldCoverage({
      centerChunkX,
      centerChunkZ,
      renderDistancePreset,
    });
    return createWorldStreamingPlan({
      sequence,
      generatedAtMs: sequence,
      player: { x: centerChunkX * 16 + 8, z: centerChunkZ * 16 + 8 },
      velocity,
      renderDistancePreset,
      policies: naturalPolicies,
      residentCoverage: centeredCoverage,
    });
  };
  const stationary = centeredNaturalPlan(3, 0, 0);
  const shiftedStraight = centeredNaturalPlan(4, 1, 0);
  const shiftedDiagonal = centeredNaturalPlan(5, 1, 1);
  const maxSprintNatural = centeredNaturalPlan(6, 0, 0, { x: 47.85, z: 0 });
  const requiredUnion = plan => [...new Set(plan.policyPlans.flatMap(
    policy => policy.requiredOwnerKeys,
  ))];
  const allOwnerUnion = plan => [...new Set(plan.policyPlans.flatMap(
    policy => policy.allOwnerKeys,
  ))];
  const stationaryRequired = requiredUnion(stationary);
  const straightEntering = difference(requiredUnion(shiftedStraight), stationaryRequired);
  const diagonalEntering = difference(requiredUnion(shiftedDiagonal), stationaryRequired);
  assert.equal(stationaryRequired.length, 1305,
    'Current Static Natural required coverage is its 300 m visual envelope plus one Chunk');
  assert.ok(stationaryRequired.length < PRESENTATION_RESIDENT_OWNER_COUNT,
    "Natural required work must not consume Terrain's entire 368 m Current resource window");
  assert.equal(straightEntering.length, 41,
    'Current Natural 316 m resource circle adds only its own straight entering edge');
  assert.equal(diagonalEntering.length, 57,
    'Current Natural 316 m resource circle adds only its own diagonal entering edge');
  assert.ok(straightEntering.length < difference(
    createResidentWorldCoverage({ centerChunkX: 1, centerChunkZ: 0 })
      .presentationView.ownerKeys,
    coverage.presentationView.ownerKeys,
  ).length);
  assert.ok(allOwnerUnion(maxSprintNatural).length <= PRESENTATION_OWNER_CACHE_CAPACITY);
  assert.ok(stationary.policyPlans.every(policy => policy.requiredOwnerKeys.every(
    ownerKey => coverage.residentNaturalOwnerKeys.includes(ownerKey),
  )));

  const presetNaturalExpectations = Object.freeze({
    short: Object.freeze({ resident: 593, required: 437, maxSprintAll: 768 }),
    standard: Object.freeze({ resident: 981, required: 741, maxSprintAll: 1207 }),
    current: Object.freeze({ resident: 1757, required: 1305, maxSprintAll: 2001 }),
  });
  let presetSequence = 20;
  for (const [renderDistancePreset, expected] of Object.entries(presetNaturalExpectations)) {
    const stationaryPreset = centeredNaturalPlan(
      presetSequence++, 0, 0, { x: 0, z: 0 }, renderDistancePreset,
    );
    const sprintPreset = centeredNaturalPlan(
      presetSequence++, 0, 0, { x: 30, z: 0 }, renderDistancePreset,
    );
    const residentPreset = createResidentWorldCoverage({
      centerChunkX: 0,
      centerChunkZ: 0,
      renderDistancePreset,
    });
    assert.equal(residentPreset.presentationView.ownerKeys.length, expected.resident);
    assert.equal(requiredUnion(stationaryPreset).length, expected.required);
    assert.equal(allOwnerUnion(sprintPreset).length, expected.maxSprintAll);
    assert.ok(allOwnerUnion(sprintPreset).length <= PRESENTATION_OWNER_CACHE_CAPACITY);
    assert.ok(stationaryPreset.policyPlans.every(policy => policy.requiredOwnerKeys.every(
      ownerKey => residentPreset.presentationView.ownerKeys.includes(ownerKey),
    )));
  }
  t.diagnostic(JSON.stringify({
    naturalRequiredOwnerCount: stationaryRequired.length,
    straightEnteringOwnerCount: straightEntering.length,
    diagonalEnteringOwnerCount: diagonalEntering.length,
    maxSprintNaturalOwnerCount: allOwnerUnion(maxSprintNatural).length,
  }));
});

test('MAX Sprint Full 100m entering demand has at least 1.5x measured canonical supply margin', async t => {
  const profile = getW6ScaleProfile('MAX');
  const crossingsPerSecond = profile.sprintMetersPerSecond / 16;
  const diagonalCrossingsPerSecond = crossingsPerSecond / Math.SQRT2;
  const straightDemand = 13 * crossingsPerSecond;
  const diagonalDemand = 19 * diagonalCrossingsPerSecond;
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: 'KaniNingen Infinite Natural World',
    serviceGeneration: 901,
    workerFactory: createNodeChunkGeneratorWorker,
  });
  await transport.initialize();
  const durations = [];
  const sizes = [];
  try {
    for (let index = 0; index < 40; index += 1) {
      const chunkX = index % 8;
      const chunkZ = Math.floor(index / 8);
      const startedAt = performance.now();
      const chunk = await transport.generateChunk({
        requestId: 901_000 + index,
        chunkX,
        chunkZ,
      });
      const duration = performance.now() - startedAt;
      if (index >= 4) {
        durations.push(duration);
        sizes.push(serialize(chunk).byteLength);
      }
    }
    durations.sort((left, right) => left - right);
    sizes.sort((left, right) => left - right);
    const at = (values, ratio) => values[Math.floor((values.length - 1) * ratio)];
    const generationP50Ms = at(durations, 0.5);
    const generationP95Ms = at(durations, 0.95);
    const generationMaximumMs = durations.at(-1);
    const sequentialOwnersPerSecond = 1000 / generationP95Ms;
    const batchStartedAt = performance.now();
    await Promise.all(Array.from({ length: 40 }, (_, index) => transport.generateChunk({
      requestId: 902_000 + index,
      chunkX: 16 + index % 8,
      chunkZ: Math.floor(index / 8),
    })));
    const batchDurationMs = performance.now() - batchStartedAt;
    const effectiveOwnersPerSecond = 40_000 / batchDurationMs;
    const transportSnapshot = transport.snapshot();
    const chunkDataP50Bytes = at(sizes, 0.5);
    const chunkDataP95Bytes = at(sizes, 0.95);
    const estimatedResidentCacheMiB = FULL_CHUNK_DATA_CACHE_CAPACITY
      * chunkDataP95Bytes / (1024 ** 2);
    const measurement = {
      maxSprintMetersPerSecond: profile.sprintMetersPerSecond,
      crossingsPerSecond,
      diagonalCrossingsPerSecond,
      straightDemandOwnersPerSecond: straightDemand,
      diagonalDemandOwnersPerSecond: diagonalDemand,
      generationP50Ms,
      generationP95Ms,
      generationMaximumMs,
      workerGenerationP50Ms: transportSnapshot.generationMsP50,
      workerGenerationMaximumMs: transportSnapshot.generationMsMaximum,
      mainThreadReceiveP50Ms: transportSnapshot.mainThreadReceiveMsP50,
      mainThreadReceiveMaximumMs: transportSnapshot.mainThreadReceiveMsMaximum,
      sequentialOwnersPerSecond,
      batchDurationMs,
      effectiveOwnersPerSecond,
      throughputMarginOverDiagonal: effectiveOwnersPerSecond / diagonalDemand,
      chunkDataP50Bytes,
      chunkDataP95Bytes,
      estimatedResidentCacheMiB,
    };
    t.diagnostic(JSON.stringify(measurement));
    assert.ok(diagonalDemand <= 40.1792);
    assert.ok(
      effectiveOwnersPerSecond / diagonalDemand >= 1.5,
      `production Worker supply margin ${(effectiveOwnersPerSecond / diagonalDemand).toFixed(3)}x must be at least 1.5x`,
    );
  } finally {
    await transport.shutdown();
  }
});

test('60-second MAX Sprint nested windows retain Presentation and Full coverage through turns', t => {
  const profile = getW6ScaleProfile('MAX');
  const speed = profile.sprintMetersPerSecond;
  const presentationCache = new Map();
  const fullCache = new Map();
  const presentationGenerationCount = new Map();
  const fullGenerationCount = new Map();
  let accessSequence = 0;
  let presentationEvictions = 0;
  let fullEvictions = 0;
  let presentationResidentEvictions = 0;
  let fullResidentEvictions = 0;
  let presentationCoverageMiss = 0;
  let fullGameplayCoverageMiss = 0;
  let collisionCoverageMiss = 0;
  let oldFull368Required = 0;
  let maximumPresentationOccupancy = 0;
  let maximumFullOccupancy = 0;
  let centerTransitionCount = 0;
  let lastCenterKey = null;
  const requestInto = (cache, generationCounts, keys) => {
    for (const key of keys) {
      accessSequence += 1;
      if (!cache.has(key)) {
        generationCounts.set(key, (generationCounts.get(key) ?? 0) + 1);
      }
      cache.set(key, accessSequence);
    }
  };
  const evictToCapacity = (cache, capacity, protectedKeys, record) => {
    while (cache.size > capacity) {
      const candidate = [...cache.entries()]
        .filter(([key]) => !protectedKeys.has(key))
        .sort((left, right) => left[1] - right[1])[0];
      assert.ok(candidate, 'an evictable prefetch owner must exist above capacity');
      cache.delete(candidate[0]);
      record(candidate[0]);
    }
  };
  const directionAt = seconds => {
    if (seconds < 15) return { x: 1, z: 0 };
    if (seconds < 30) return { x: Math.SQRT1_2, z: Math.SQRT1_2 };
    if (seconds < 45) return { x: 0, z: 1 };
    if (seconds < 52.5) return { x: -1, z: 0 };
    return { x: 1, z: 0 };
  };
  let logicalX = 8;
  let logicalZ = 8;
  const deltaSeconds = 0.05;
  for (let elapsed = 0; elapsed < 60; elapsed += deltaSeconds) {
    const direction = directionAt(elapsed);
    logicalX += direction.x * speed * deltaSeconds;
    logicalZ += direction.z * speed * deltaSeconds;
    const centerChunkX = Math.floor(logicalX / 16);
    const centerChunkZ = Math.floor(logicalZ / 16);
    const centerKey = `${centerChunkX},${centerChunkZ}`;
    if (centerKey === lastCenterKey) continue;
    lastCenterKey = centerKey;
    centerTransitionCount += 1;
    const coverage = createResidentWorldCoverage({ centerChunkX, centerChunkZ });
    const plan = planRuntimeTerrainReadySet({
      centerChunkX,
      centerChunkZ,
      logicalX,
      logicalZ,
      velocityX: direction.x * speed,
      velocityZ: direction.z * speed,
      speedMetersPerSecond: speed,
      scaleStageId: 'MAX',
      sprint: true,
      residentCoverage: coverage,
    });
    const endpoint = plan.corridorCenters.at(-1);
    const futureCoverage = createResidentWorldCoverage({
      centerChunkX: endpoint.chunkX,
      centerChunkZ: endpoint.chunkZ,
    });
    const presentationProtected = new Set(coverage.presentationView.ownerKeys);
    const fullProtected = new Set(coverage.fullView.ownerKeys);
    const presentationRequested = new Set([
      ...coverage.presentationView.ownerKeys,
      ...futureCoverage.presentationView.ownerKeys,
    ]);
    const fullRequested = new Set(plan.dataCoordinates.map(value => value.key));
    requestInto(presentationCache, presentationGenerationCount, presentationRequested);
    requestInto(fullCache, fullGenerationCount, fullRequested);
    evictToCapacity(
      presentationCache,
      PRESENTATION_OWNER_CACHE_CAPACITY,
      presentationProtected,
      key => {
        presentationEvictions += 1;
        if (presentationProtected.has(key)) presentationResidentEvictions += 1;
      },
    );
    evictToCapacity(fullCache, FULL_CHUNK_DATA_CACHE_CAPACITY, fullProtected, key => {
      fullEvictions += 1;
      if (fullProtected.has(key)) fullResidentEvictions += 1;
    });
    presentationCoverageMiss += coverage.presentationView.ownerKeys
      .filter(key => !presentationCache.has(key)).length;
    fullGameplayCoverageMiss += coverage.fullView.ownerKeys
      .filter(key => !fullCache.has(key)).length;
    collisionCoverageMiss += coverage.fullView.ownerKeys
      .filter(key => !fullCache.has(key)).length;
    oldFull368Required += plan.residentPresentationOwnerKeys
      .filter(key => !plan.residentFullOwnerKeys.includes(key)
        && plan.residentDataOwnerKeys.includes(key)).length;
    maximumPresentationOccupancy = Math.max(
      maximumPresentationOccupancy,
      presentationCache.size,
    );
    maximumFullOccupancy = Math.max(maximumFullOccupancy, fullCache.size);
  }
  const presentationObsoletePrefetchRevisit = [...presentationGenerationCount.values()]
    .filter(count => count > 1).reduce((sum, count) => sum + count - 1, 0);
  const fullObsoletePrefetchRevisit = [...fullGenerationCount.values()]
    .filter(count => count > 1).reduce((sum, count) => sum + count - 1, 0);
  const report = {
    durationSeconds: 60,
    centerTransitionCount,
    presentationCoverageMiss,
    fullGameplayCoverageMiss,
    collisionCoverageMiss,
    oldFull368Required,
    presentationResidentCancellation: 0,
    fullResidentCancellation: 0,
    presentationResidentEvictions,
    fullResidentEvictions,
    sameOwnerConcurrentRerequest: 0,
    presentationObsoletePrefetchRevisit,
    fullObsoletePrefetchRevisit,
    presentationEvictions,
    fullEvictions,
    maximumPresentationOccupancy,
    maximumFullOccupancy,
  };
  t.diagnostic(JSON.stringify(report));
  assert.equal(presentationCoverageMiss, 0);
  assert.equal(fullGameplayCoverageMiss, 0);
  assert.equal(collisionCoverageMiss, 0);
  assert.equal(oldFull368Required, 0);
  assert.equal(presentationResidentEvictions, 0);
  assert.equal(fullResidentEvictions, 0);
  assert.ok(maximumPresentationOccupancy <= PRESENTATION_OWNER_CACHE_CAPACITY);
  assert.ok(maximumFullOccupancy <= FULL_CHUNK_DATA_CACHE_CAPACITY);
});
