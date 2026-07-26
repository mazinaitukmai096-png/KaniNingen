import test from 'node:test';
import assert from 'node:assert/strict';

import { logicalWorldToOwnedChunk } from '../src/infinite-world/chunk-coordinates.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { createW6ChunkGameplay } from '../src/infinite-world/gameplay-runtime.js';
import { isW8NaturalCandidateVisible } from '../src/infinite-world/w8-natural-presentation-policy.js';
import {
  W8_PARITY_CHUNK_DATA_SCHEMA,
  W8_SPAWN_SAFETY_CONTRACT,
  createW8ParityChunkGenerator,
  hashW8ParityChunkContent,
  sampleW8SurfaceHeightMeters,
  validateW8ParityChunkData,
} from '../src/infinite-world/w8-parity-chunk-generator.js';

const seed = 'W8 parity golden seed';

function pointToRotatedRectangleDistance(point, rectangle) {
  const cosine = Math.cos(-(rectangle.rotationY ?? 0));
  const sine = Math.sin(-(rectangle.rotationY ?? 0));
  const dx = point.x - rectangle.x;
  const dz = point.z - rectangle.z;
  const localX = dx * cosine - dz * sine;
  const localZ = dx * sine + dz * cosine;
  return Math.hypot(
    Math.max(Math.abs(localX) - rectangle.width / 2, 0),
    Math.max(Math.abs(localZ) - rectangle.depth / 2, 0),
  );
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared <= 1e-12 ? 0 : Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared));
  return Math.hypot(point.x - start.x - dx * t, point.z - start.z - dz * t);
}

test('W8 wraps byte-identical W5 output and publishes sorted deterministic overlays', async () => {
  const [w5, w8] = await Promise.all([
    createDistributedSettlementChunkGenerator({ worldSeed: seed }),
    createW8ParityChunkGenerator({ worldSeed: seed }),
  ]);
  const [source, parity] = await Promise.all([w5.generateChunk(-3, 5), w8.generateChunk(-3, 5)]);
  assert.equal(parity.schemaVersion, W8_PARITY_CHUNK_DATA_SCHEMA);
  assert.equal(parity.sourceW5ContentHash, source.contentHash);
  assert.deepEqual(parity.sourceChunkData, source);
  assert.equal(parity.terrain, parity.sourceChunkData.terrain);
  assert.equal(parity.presentationLayers.heightSource.sourceW5ContentHash, source.contentHash);
  assert.equal(parity.presentationLayers.heightSource.verticalScale, 1);
  assert.deepEqual(parity.presentationLayers.integrationOrder, [
    'terrain', 'roads', 'intersections', 'lots', 'buildings', 'water',
    'landmarks', 'street-details', 'natural', 'ambient-details',
  ]);
  assert.equal(parity.presentationLayers.natural.vegetation.every(candidate =>
    parity.sourceChunkData.vegetationCandidates.includes(candidate)), true);
  assert.equal((await hashW8ParityChunkContent(parity)), parity.contentHash);
  assert.deepEqual(validateW8ParityChunkData(parity), { valid: true, errors: [] });
  const cacheSnapshot = w8.snapshot();
  assert.equal(cacheSnapshot.warmSourceChunkCacheCapacity, 256);
  assert.ok(cacheSnapshot.warmSourceChunkCacheSize <= 256);
  assert.equal(cacheSnapshot.warmSourceChunkPendingCount, 0);
  for (const name of ['waterSurfaces', 'ambientDetails', 'settlementLandmarks', 'streetDetails']) {
    assert.deepEqual(parity[name].map(value => value.stableId),
      parity[name].map(value => value.stableId).toSorted());
  }
  assert.ok(parity.ambientDetails.length > 8);
});

test('the reported 31,21 boundary resident has one canonical Gameplay owner', async () => {
  const generator = await createW8ParityChunkGenerator();
  const chunks = await Promise.all([
    generator.generateChunk(31, 21),
    generator.generateChunk(32, 21),
  ]);
  const models = await Promise.all(chunks.map(chunkData => createW6ChunkGameplay({
    chunkData,
    worldSeedHash: generator.worldSeedHash,
    generatorMajor: generator.generatorVersion.major,
  })));
  const stableId = 'wf1:human:de6f08ad3426dd2ad7bef1499769579c';
  const descriptors = models.flatMap(model => model.entityDescriptors)
    .filter(descriptor => descriptor.stableId === stableId);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].ownerChunkKey, '31,21');
  assert.equal(logicalWorldToOwnedChunk(descriptors[0].x, descriptors[0].z).key, '31,21');
});

test('W8 selects a deterministic pond start and every surface consumer retains the W5 height value and scale', async () => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const owner = logicalWorldToOwnedChunk(generator.experienceSpawn.x, generator.experienceSpawn.z);
  const chunk = await generator.generateChunk(owner.chunkX, owner.chunkZ);
  const pond = chunk.waterSurfaces.find(surface => surface.stableId === generator.experienceSpawn.pondStableId);
  assert.ok(pond);
  assert.equal(generator.experienceSpawn.x, pond.worldPosition.x);
  assert.equal(generator.experienceSpawn.z, pond.worldPosition.z);
  assert.equal(generator.experienceSpawn.y, pond.worldPosition.y);
  assert.equal(generator.experienceSpawn.spawnSafety.safe, true);
  assert.equal(generator.experienceSpawn.spawnSafety.introPathClear, true);
  assert.equal(generator.experienceSpawn.spawnSafety.introCameraPathClear, true);
  assert.equal(generator.experienceSpawn.spawnSafety.preparedChunkKeys.length, 25);
  assert.equal(Number.isFinite(generator.experienceSpawn.facingY), true);
  assert.equal(Number.isFinite(generator.experienceSpawn.cameraYaw), true);
  const preparedChunks = await Promise.all(generator.experienceSpawn.spawnSafety.preparedChunkKeys
    .map(key => key.split(',').map(Number))
    .map(([chunkX, chunkZ]) => generator.generateChunk(chunkX, chunkZ)));
  const spawnPoint = generator.experienceSpawn;
  for (const prepared of preparedChunks) {
    for (const feature of prepared.settlementFeatures ?? []) {
      if (feature.featureType === 'settlement-road') {
        assert.ok(distanceToSegment(spawnPoint, feature.start, feature.end)
          >= feature.widthMeters / 2 + W8_SPAWN_SAFETY_CONTRACT.roadClearanceMeters);
      } else if (feature.featureType === 'settlement-building') {
        assert.ok(pointToRotatedRectangleDistance(spawnPoint, {
          x: feature.worldPosition.x, z: feature.worldPosition.z,
          width: feature.widthMeters, depth: feature.depthMeters,
          rotationY: feature.rotationY,
        }) >= W8_SPAWN_SAFETY_CONTRACT.playerClearanceMeters);
        if (feature.lot) assert.ok(pointToRotatedRectangleDistance(spawnPoint, {
          x: feature.lot.centerX, z: feature.lot.centerZ,
          width: feature.lot.widthMeters, depth: feature.lot.depthMeters,
          rotationY: feature.rotationY,
        }) >= W8_SPAWN_SAFETY_CONTRACT.playerClearanceMeters);
      }
    }
    for (const landmark of prepared.settlementLandmarks ?? []) {
      assert.ok(pointToRotatedRectangleDistance(spawnPoint, {
        x: landmark.worldPosition.x, z: landmark.worldPosition.z,
        width: landmark.widthMeters, depth: landmark.depthMeters,
        rotationY: landmark.rotationY,
      }) >= W8_SPAWN_SAFETY_CONTRACT.playerClearanceMeters);
    }
    for (const candidate of prepared.presentationLayers.natural.vegetation) {
      const radius = candidate.metadata?.candidateRadiusMeters ?? 0.625;
      for (const feature of prepared.settlementFeatures ?? []) {
        if (feature.featureType === 'settlement-road') {
          assert.ok(distanceToSegment(candidate.worldPosition, feature.start, feature.end)
            > feature.widthMeters / 2 + radius);
          continue;
        }
        if (feature.featureType !== 'settlement-building') continue;
        assert.ok(pointToRotatedRectangleDistance(candidate.worldPosition, {
          x: feature.worldPosition.x, z: feature.worldPosition.z,
          width: feature.widthMeters, depth: feature.depthMeters,
          rotationY: feature.rotationY,
        }) > radius);
        for (const surface of [feature.lot?.path, feature.lot?.forecourt]) {
          if (!surface) continue;
          assert.ok(pointToRotatedRectangleDistance(candidate.worldPosition, {
            x: surface.centerX, z: surface.centerZ,
            width: surface.width, depth: surface.depth,
            rotationY: surface.rotationY,
          }) > radius);
        }
      }
    }
  }
  const gameplayModels = await Promise.all(preparedChunks.map(prepared => createW6ChunkGameplay({
    chunkData: prepared,
    worldSeedHash: generator.worldSeedHash,
    generatorMajor: generator.generatorVersion.major,
  })));
  const presentationTreeIds = preparedChunks.flatMap(prepared => (
    prepared.presentationLayers.natural.vegetation
      .filter(isW8NaturalCandidateVisible)
      .map(candidate => candidate.candidateId)
  )).sort();
  const gameplayTreeIds = gameplayModels.flatMap(model => model.staticTargets
    .filter(target => target.type === 'tree')
    .map(target => target.stableId)).sort();
  assert.ok(presentationTreeIds.length > 0);
  assert.deepEqual(gameplayTreeIds, presentationTreeIds);
  const height = sampleW8SurfaceHeightMeters(
    chunk,
    generator.experienceSpawn.x,
    generator.experienceSpawn.z,
  );
  assert.equal(Number.isFinite(height), true);
  assert.equal(chunk.terrain.heightUnitMeters, chunk.sourceChunkData.terrain.heightUnitMeters);
  assert.equal(chunk.terrain.heights, chunk.sourceChunkData.terrain.heights);
  for (const building of chunk.settlementFeatures.filter(value => value.featureType === 'settlement-building')) {
    assert.equal(
      building.worldPosition.y,
      sampleW8SurfaceHeightMeters(chunk, building.worldPosition.x, building.worldPosition.z),
    );
  }
});

test('W8 generation is invariant under reverse and parallel request order', async () => {
  const coordinates = [[0, 0], [1, -1], [-2, 3], [4, 2], [-3, -4]];
  const first = await createW8ParityChunkGenerator({ worldSeed: seed });
  const second = await createW8ParityChunkGenerator({ worldSeed: seed });
  const pendingA = first.generateChunk(17, -19);
  const pendingB = first.generateChunk(17, -19);
  const pendingSnapshot = first.snapshot();
  assert.equal(pendingSnapshot.warmSourceChunkCacheCapacity, 256);
  assert.equal(pendingSnapshot.warmSourceChunkPendingCount, 1);
  const [duplicateA, duplicateB] = await Promise.all([pendingA, pendingB]);
  assert.equal(duplicateA.sourceChunkData, duplicateB.sourceChunkData);
  assert.equal(duplicateA.contentHash, duplicateB.contentHash);
  assert.equal(first.snapshot().warmSourceChunkPendingCount, 0);
  const parallel = await Promise.all(coordinates.map(([x, z]) => first.generateChunk(x, z)));
  const reverse = [];
  for (const [x, z] of coordinates.toReversed()) reverse.push(await second.generateChunk(x, z));
  const byCoordinate = new Map(reverse.map(chunk => [`${chunk.chunkX},${chunk.chunkZ}`, chunk]));
  for (const chunk of parallel) {
    const other = byCoordinate.get(`${chunk.chunkX},${chunk.chunkZ}`);
    assert.equal(other.contentHash, chunk.contentHash);
    assert.deepEqual(other.waterSurfaces, chunk.waterSurfaces);
    assert.deepEqual(other.ambientDetails, chunk.ambientDetails);
    assert.deepEqual(other.settlementLandmarks, chunk.settlementLandmarks);
    assert.deepEqual(other.streetDetails, chunk.streetDetails);
  }
  for (const generator of [first, second]) {
    const snapshot = generator.snapshot();
    assert.equal(snapshot.warmSourceChunkCacheCapacity, 256);
    assert.ok(snapshot.warmSourceChunkCacheSize <= 256);
    assert.equal(snapshot.warmSourceChunkPendingCount, 0);
  }
});

test('Settlement center ownership deterministically adds finite-language landmarks', async () => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const candidates = await generator.distributor.findInMacroRange(-8, 8, -8, 8);
  for (const townType of ['military', 'residential', 'suburb']) {
    const candidate = candidates.find(value => value.townType === townType);
    assert.ok(candidate, `${townType} fixture is required`);
    const owner = logicalWorldToOwnedChunk(candidate.center.x, candidate.center.z);
    const chunk = await generator.generateChunk(owner.chunkX, owner.chunkZ);
    const expected = { military: 'militaryBase', residential: 'barn', suburb: 'factory' }[townType];
    assert.ok(chunk.settlementLandmarks.some(value => value.parentSettlementId === candidate.settlementId
      && value.landmarkType === expected));
    assert.equal(chunk.settlementLandmarks.every(value =>
      value.owningChunkCoordinate.x === owner.chunkX
      && value.owningChunkCoordinate.z === owner.chunkZ), true);
  }
});
