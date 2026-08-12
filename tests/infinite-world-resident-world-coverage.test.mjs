import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from 'node:v8';

import {
  FULL_RESIDENT_RADIUS_METERS,
  PRESENTATION_RESIDENT_RADIUS_METERS,
  RESIDENT_WORLD_BOUNDED_PREFETCH_OWNER_COUNT,
  RESIDENT_WORLD_CHUNK_DATA_CACHE_CAPACITY,
  RESIDENT_WORLD_MAXIMUM_VISIBLE_RADIUS_METERS,
  RESIDENT_WORLD_OWNER_COUNT,
  RESIDENT_WORLD_REQUIRED_RADIUS_METERS,
  createResidentWorldCoverage,
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
  assert.equal(RESIDENT_WORLD_BOUNDED_PREFETCH_OWNER_COUNT, 609);
  assert.equal(RESIDENT_WORLD_CHUNK_DATA_CACHE_CAPACITY, 2366);
  assert.strictEqual(coverage.residentDataOwnerKeys, coverage.residentRequiredOwnerKeys);
  assert.strictEqual(coverage.residentTerrainOwnerKeys, coverage.residentRequiredOwnerKeys);
  assert.strictEqual(coverage.residentNaturalOwnerKeys, coverage.residentRequiredOwnerKeys);
  assert.strictEqual(coverage.residentStructureOwnerKeys, coverage.residentRequiredOwnerKeys);

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
    assert.deepEqual(plan.residentRequiredOwnerKeys, coverage.residentRequiredOwnerKeys);
    assert.ok(plan.velocityPrefetchOwnerKeys.length > 0);
    assert.ok(plan.dataCoordinates.length <= RESIDENT_WORLD_CHUNK_DATA_CACHE_CAPACITY);
  }
  assert.equal(new Set(plans.map(plan => plan.velocityPrefetchOwnerKeys.join('|'))).size, 4);
  assert.deepEqual(residentPlan().residentRequiredOwnerKeys, coverage.residentRequiredOwnerKeys);

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

test('one Resident master coverage exposes nested Presentation 368m and Full 100m views', t => {
  const centered = createResidentWorldCoverage({ centerChunkX: 0, centerChunkZ: 0 });
  assert.equal(PRESENTATION_RESIDENT_RADIUS_METERS, 368);
  assert.equal(FULL_RESIDENT_RADIUS_METERS, 100);
  assert.equal(centered.presentationView.ownerKeys.length, 1757);
  assert.equal(centered.fullView.ownerKeys.length, 145);
  assert.ok(centered.fullView.ownerKeys.every(key => centered.presentationView.ownerKeys.includes(key)));

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
  assert.equal(calls.length, RESIDENT_WORLD_OWNER_COUNT);

  const straight = residentPlan({ centerChunkX: 1 });
  const straightEntering = difference(
    straight.residentRequiredOwnerKeys,
    first.residentRequiredOwnerKeys,
  );
  const straightLeaving = difference(
    first.residentRequiredOwnerKeys,
    straight.residentRequiredOwnerKeys,
  );
  assert.equal(straightEntering.length, 47);
  assert.equal(straightLeaving.length, 47);
  const beforeStraight = calls.length;
  await runtime.updateTerrainReadySet(straight);
  assert.deepEqual(calls.slice(beforeStraight).sort(), [...straightEntering].sort());
  let snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.terrainReady.residentWorld.lastOwnerSetDiff, {
    unchanged: 1710,
    entering: 47,
    leaving: 47,
  });
  assert.equal(snapshot.terrainReady.residentWorld.fullWindowRebuild, 0);

  const diagonal = residentPlan({ centerChunkX: 2, centerChunkZ: 1 });
  const diagonalEntering = difference(
    diagonal.residentRequiredOwnerKeys,
    straight.residentRequiredOwnerKeys,
  );
  assert.equal(diagonalEntering.length, 67);
  const beforeDiagonal = calls.length;
  await runtime.updateTerrainReadySet(diagonal);
  const diagonalRequests = calls.slice(beforeDiagonal);
  assert.equal(diagonalRequests.every(key => diagonalEntering.includes(key)), true);
  assert.equal(new Set(diagonalRequests).size, diagonalRequests.length);
  snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.terrainReady.residentWorld.lastOwnerSetDiff, {
    unchanged: 1690,
    entering: 67,
    leaving: 67,
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
    assert.equal(moving.residentCoverage.ownerCoordinates.some(
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
    residentOwnerCount: RESIDENT_WORLD_OWNER_COUNT,
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
  assert.deepEqual(runtimeEast.requiredOwnerKeys, coverage.residentRequiredOwnerKeys);
  assert.deepEqual(runtimeWest.requiredOwnerKeys, coverage.residentRequiredOwnerKeys);
  assert.deepEqual(naturalEast.requiredOwnerKeys, naturalWest.requiredOwnerKeys);
  assert.ok(naturalEast.requiredOwnerKeys.every(
    ownerKey => coverage.residentRequiredOwnerKeys.includes(ownerKey),
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
  ) => {
    const centeredCoverage = createResidentWorldCoverage({ centerChunkX, centerChunkZ });
    return createWorldStreamingPlan({
      sequence,
      generatedAtMs: sequence,
      player: { x: centerChunkX * 16 + 8, z: centerChunkZ * 16 + 8 },
      velocity,
      renderDistancePreset: 'current',
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
  assert.equal(stationaryRequired.length, 1305);
  assert.equal(straightEntering.length, 41);
  assert.equal(diagonalEntering.length, 57);
  assert.ok(allOwnerUnion(maxSprintNatural).length <= RESIDENT_WORLD_CHUNK_DATA_CACHE_CAPACITY);
  assert.ok(stationary.policyPlans.every(policy => policy.requiredOwnerKeys.every(
    ownerKey => coverage.residentNaturalOwnerKeys.includes(ownerKey),
  )));
  t.diagnostic(JSON.stringify({
    naturalRequiredOwnerCount: stationaryRequired.length,
    straightEnteringOwnerCount: straightEntering.length,
    diagonalEnteringOwnerCount: diagonalEntering.length,
    maxSprintNaturalOwnerCount: allOwnerUnion(maxSprintNatural).length,
  }));
});

test('MAX Sprint Resident entering demand remains below measured canonical generation supply', async t => {
  const profile = getW6ScaleProfile('MAX');
  const crossingsPerSecond = profile.sprintMetersPerSecond / 16;
  const diagonalCrossingsPerSecond = crossingsPerSecond / Math.SQRT2;
  const straightDemand = 47 * crossingsPerSecond;
  const diagonalDemand = 67 * diagonalCrossingsPerSecond;
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
    const estimatedResidentCacheMiB = RESIDENT_WORLD_CHUNK_DATA_CACHE_CAPACITY
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
    assert.ok(
      effectiveOwnersPerSecond > diagonalDemand,
      `production Worker supply ${effectiveOwnersPerSecond.toFixed(3)} owner/s must exceed ${diagonalDemand.toFixed(3)} owner/s`,
    );
  } finally {
    await transport.shutdown();
  }
});
