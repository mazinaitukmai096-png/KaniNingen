import test from 'node:test';
import assert from 'node:assert/strict';

import { LOGICAL_CHUNK_SIZE_METERS, logicalWorldToOwnedChunk } from '../src/infinite-world/chunk-coordinates.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { createW6ChunkGameplay } from '../src/infinite-world/gameplay-runtime.js';
import { createW8ForestHorizonManifest } from '../src/infinite-world/forest-horizon-manifest.js';
import {
  W8_CANONICAL_TREE_WORLD_DENSITY_THRESHOLD,
  W8_NATURAL_PRESENTATION_PHASE_1,
  createW8NaturalPresentationPhase1Policy,
  evaluateW8SettlementDensityFactor,
  evaluateW8SpawnDensityFactor,
  isW8NaturalCandidateVisible,
} from '../src/infinite-world/w8-natural-presentation-policy.js';
import {
  W8_PARITY_CHUNK_DATA_SCHEMA,
  W8_SPAWN_SAFETY_CONTRACT,
  createW8ParityChunkGenerator,
  hashW8ParityChunkContent,
  sampleW8SurfaceHeightMeters,
  validateW8ParityChunkData,
} from '../src/infinite-world/w8-parity-chunk-generator.js';

const seed = 'W8 parity golden seed';

test('Forest horizon manifest is a strict Tree projection of the full canonical W8 Chunk', async () => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  try {
    for (const [chunkX, chunkZ] of [[0, 0], [-2, 2], [31, 21]]) {
      const full = await generator.generateChunk(chunkX, chunkZ);
      const direct = await generator.generateForestHorizonManifest(chunkX, chunkZ);
      const projected = createW8ForestHorizonManifest(full);
      assert.equal(direct.schemaVersion, projected.schemaVersion);
      assert.equal(direct.chunkId, full.chunkId);
      assert.equal(direct.sourceW5ContentHash, full.sourceW5ContentHash);
      assert.deepEqual(direct.generatorVersion, full.generatorVersion);
      assert.deepEqual(direct.presentationLayers, projected.presentationLayers);
      assert.equal(Object.hasOwn(direct, 'terrain'), false);
      assert.equal(Object.hasOwn(direct, 'sourceChunkData'), false);
      assert.match(direct.contentHash, /^sha256:[0-9a-f]{64}$/);
      for (const tree of direct.presentationLayers.natural.vegetation) {
        assert.equal(tree.subtype === 'shrub', false);
        assert.deepEqual(tree.owningChunkCoordinate, { x: chunkX, z: chunkZ });
        assert.equal(
          tree.worldPosition.y,
          sampleW8SurfaceHeightMeters(full, tree.worldPosition.x, tree.worldPosition.z),
        );
      }
    }
  } finally {
    await generator.shutdown();
  }
});

function candidateAt({ id, x, z, subtype = 'broadleaf-tree', radius = 2, metadata = {} }) {
  return Object.freeze({
    candidateId: id,
    kind: 'vegetation',
    subtype,
    ownerChunk: Object.freeze({ chunkX: 0, chunkZ: 0 }),
    worldPosition: Object.freeze({ x, y: 0, z }),
    candidateRadius: radius,
    candidateHeight: subtype === 'shrub' ? 0.85 : 5,
    variation: 1,
    variationSeed: 0.9,
    sourceBiomeWeights: Object.freeze([
      Object.freeze({ biomeId: 'mixed-woodland', weight: 0.45 }),
      Object.freeze({ biomeId: 'wetland', weight: 0.1 }),
      Object.freeze({ biomeId: 'temperate-grassland', weight: 0.35 }),
      Object.freeze({ biomeId: 'rocky-highland', weight: 0.05 }),
    ]),
    metadata: Object.freeze({
      biomeMembership: Object.freeze({
        mixedWoodland: 0.45,
        wetland: 0.1,
        grassland: 0.35,
        rockyHighland: 0.05,
      }),
      moisture: 0.5,
      slope: 0.04,
      rockiness: 0.05,
      candidateRadiusMeters: radius,
      ...metadata,
    }),
  });
}

function stableCandidateIds(candidates) {
  return candidates.map((candidate) => candidate.candidateId).sort();
}

function connectedTreeMetrics(trees, bounds) {
  const positions = trees.map((tree) => tree.worldPosition);
  const nearest = positions.map((point, index) => {
    let distance = Number.POSITIVE_INFINITY;
    for (let otherIndex = 0; otherIndex < positions.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const other = positions[otherIndex];
      distance = Math.min(distance, Math.hypot(point.x - other.x, point.z - other.z));
    }
    return distance;
  }).filter(Number.isFinite).sort((left, right) => left - right);

  const parent = positions.map((_, index) => index);
  const root = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const join = (left, right) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < positions.length; left += 1) {
    for (let right = left + 1; right < positions.length; right += 1) {
      if (Math.hypot(
        positions[left].x - positions[right].x,
        positions[left].z - positions[right].z,
      ) <= 6) join(left, right);
    }
  }
  const componentSizes = new Map();
  for (let index = 0; index < positions.length; index += 1) {
    const component = root(index);
    componentSizes.set(component, (componentSizes.get(component) ?? 0) + 1);
  }
  const components = [...componentSizes.values()];
  let openSamples = 0;
  let sampleCount = 0;
  for (let x = bounds.minX; x <= bounds.maxX; x += 2) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += 2) {
      sampleCount += 1;
      if (!positions.some((point) => Math.hypot(point.x - x, point.z - z) <= 6)) openSamples += 1;
    }
  }
  const percentile = (fraction) => nearest.length
    ? nearest[Math.min(nearest.length - 1, Math.floor((nearest.length - 1) * fraction))]
    : null;
  return Object.freeze({
    count: trees.length,
    nearestMean: nearest.length ? nearest.reduce((total, value) => total + value, 0) / nearest.length : null,
    nearestMedian: percentile(0.5),
    nearestP10: percentile(0.1),
    nearestMinimum: nearest[0] ?? null,
    componentCount: components.length,
    singletonRate: trees.length
      ? components.filter((size) => size === 1).length / trees.length
      : 0,
    maxComponentSize: Math.max(0, ...components),
    openRate6m: sampleCount ? openSamples / sampleCount : 0,
  });
}

function rangeCounts(entries, ranges, valueForEntry, selectedForEntry) {
  return ranges.map(([label, minimum, maximum]) => {
    const matches = entries.filter((entry) => {
      const value = valueForEntry(entry);
      return value >= minimum && value < maximum;
    });
    const selected = matches.filter(selectedForEntry).length;
    return Object.freeze({
      label,
      raw: matches.length,
      selected,
      selectedRate: matches.length ? selected / matches.length : 0,
    });
  });
}

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

test('Phase 1 natural presentation policy is world-fixed, smooth, and preserves Shrub inputs', async () => {
  const policy = await createW8NaturalPresentationPhase1Policy({
    worldSeedHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  });
  const left = candidateAt({ id: 'phase-1:left', x: 31.999, z: 19 });
  const right = candidateAt({ id: 'phase-1:right', x: 32.001, z: 19 });
  const leftEvaluation = policy.evaluateTree({ candidate: left });
  const rightEvaluation = policy.evaluateTree({ candidate: right });
  assert.ok(Math.abs(leftEvaluation.macroField - rightEvaluation.macroField) < 0.001);
  assert.ok(Math.abs(leftEvaluation.groveField - rightEvaluation.groveField) < 0.001);
  assert.deepEqual(policy.evaluateTree({ candidate: left }), leftEvaluation);

  const settlement = Object.freeze({
    center: Object.freeze({ x: 0, z: 0 }),
    radiusMeters: 100,
  });
  const settlementFactors = [0, 0.65, 0.725, 0.8, 0.9, 1, 1.125, 1.25, 1.5]
    .map(q => evaluateW8SettlementDensityFactor([settlement], { x: q * 100, z: 0 }));
  assert.equal(settlementFactors[0], 0.18);
  assert.equal(settlementFactors.at(-1), 1);
  for (let index = 1; index < settlementFactors.length; index += 1) {
    assert.ok(settlementFactors[index] >= settlementFactors[index - 1]);
  }

  const spawn = Object.freeze({ x: 0, z: 0, facingY: 0 });
  const spawnFactorAt = (outsideMeters) => evaluateW8SpawnDensityFactor({
    candidate: candidateAt({
      id: `phase-1:spawn:${outsideMeters}`,
      x: 12.625 + outsideMeters,
      z: 6,
      radius: 0.625,
    }),
    experienceSpawn: spawn,
    introDistanceMeters: 12,
  });
  assert.equal(spawnFactorAt(0), 0);
  assert.equal(spawnFactorAt(W8_NATURAL_PRESENTATION_PHASE_1.spawnFeatherMeters), 1);
  assert.ok(spawnFactorAt(6) > 0 && spawnFactorAt(6) < 1);

  const shrub = candidateAt({ id: 'phase-1:shrub', x: 100, z: 100, subtype: 'shrub' });
  const tree = candidateAt({ id: 'phase-1:tree', x: 100, z: 100 });
  const selected = policy.selectVegetation({ candidates: [shrub, tree] });
  assert.equal(selected.includes(shrub), true);
  assert.equal(selected.filter(candidate => candidate.subtype === 'shrub').length, 1);
});

test('Phase 1 applies one immutable 50 percent Tree world sample', async () => {
  assert.equal(W8_CANONICAL_TREE_WORLD_DENSITY_THRESHOLD, 0.5);
  const policy = await createW8NaturalPresentationPhase1Policy({
    worldSeedHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  });
  const evaluations = Array.from({ length: 512 }, (_, index) => policy.evaluateTree({
    candidate: candidateAt({
      id: `phase-1:world-density:${index}`,
      x: 100,
      z: 100,
    }),
  }));
  const habitatAccepted = evaluations.filter(evaluation => (
    evaluation.rank < evaluation.acceptance
  ));
  const worldAccepted = evaluations.filter(evaluation => evaluation.accepted);

  assert.ok(worldAccepted.length > 0);
  assert.ok(worldAccepted.length < habitatAccepted.length,
    'world sampling must reduce the Phase 1 habitat-accepted Tree set');
  assert.ok(habitatAccepted.some(evaluation => (
    evaluation.densityRank >= W8_CANONICAL_TREE_WORLD_DENSITY_THRESHOLD
  )), 'the fixture must include Trees rejected only by immutable world sampling');
  assert.equal(evaluations.every(evaluation => evaluation.accepted === (
    evaluation.rank < evaluation.acceptance
      && evaluation.densityRank < W8_CANONICAL_TREE_WORLD_DENSITY_THRESHOLD
  )), true);
});

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
  const sourceVegetationById = new Map(parity.sourceChunkData.vegetationCandidates
    .map(candidate => [candidate.candidateId, candidate]));
  assert.equal(parity.presentationLayers.natural.vegetation.every(candidate => {
    const sourceCandidate = sourceVegetationById.get(candidate.candidateId);
    return sourceCandidate
      && sourceCandidate.worldPosition.x === candidate.worldPosition.x
      && sourceCandidate.worldPosition.z === candidate.worldPosition.z;
  }), true, 'Natural selection preserves formal identity/XZ while canonical Y follows finalGround');
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

test('Settlement presentation template exposes the exact multi-owner W8 Building Stable ID set', async () => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const candidates = await generator.distributor.findSettlementsNear(
    generator.reviewSpawn.x,
    generator.reviewSpawn.z,
    350,
  );
  const candidate = candidates.find(value => value.settlementId === generator.reviewSpawn.settlementId)
    ?? candidates[0];
  assert.ok(candidate);
  const template = await generator.resolveSettlementPresentationTemplate({ candidate });
  assert.equal(template.schemaVersion, 'w8-settlement-presentation-template-1');
  assert.equal(template.canonicalBuildingCount, template.buildings.length);
  assert.equal(new Set(template.buildings.map(building => building.stableId)).size,
    template.buildings.length);
  const owners = new Map(template.buildings.map(building => [
    `${building.owningChunkCoordinate.x},${building.owningChunkCoordinate.z}`,
    building.owningChunkCoordinate,
  ]));
  assert.ok(owners.size > 1);
  const chunks = await Promise.all([...owners.values()].map(owner => (
    generator.generateChunk(owner.x, owner.z)
  )));
  const projectedStableIds = chunks.flatMap(chunk => chunk.settlementFeatures)
    .filter(feature => feature.featureType === 'settlement-building'
      && feature.settlementId === candidate.settlementId)
    .map(feature => feature.stableId)
    .sort();
  assert.deepEqual(projectedStableIds, template.buildings.map(building => building.stableId).sort());
  for (const building of template.buildings) {
    const projected = chunks.flatMap(chunk => chunk.settlementFeatures)
      .find(feature => feature.stableId === building.stableId);
    assert.ok(projected);
    assert.deepEqual(projected.owningChunkCoordinate, building.owningChunkCoordinate);
    assert.equal(projected.worldPosition.x, building.x);
    assert.equal(projected.worldPosition.z, building.z);
    assert.equal(projected.rotationY, building.rotationY);
    assert.equal(projected.widthMeters, building.widthMeters);
    assert.equal(projected.heightMeters, building.heightMeters);
    assert.equal(projected.depthMeters, building.depthMeters);
  }
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

test('W8 selects a deterministic pond start and every surface consumer uses the canonical surface policy', async () => {
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
  assert.equal(height, sampleW8SurfaceHeightMeters(
    chunk,
    generator.experienceSpawn.x,
    generator.experienceSpawn.z,
  ));
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
    assert.deepEqual(
      stableCandidateIds(other.presentationLayers.natural.vegetation),
      stableCandidateIds(chunk.presentationLayers.natural.vegetation),
    );
  }
  for (const generator of [first, second]) {
    const snapshot = generator.snapshot();
    assert.equal(snapshot.warmSourceChunkCacheCapacity, 256);
    assert.ok(snapshot.warmSourceChunkCacheSize <= 256);
    assert.equal(snapshot.warmSourceChunkPendingCount, 0);
  }
});

test('Phase 1 creates deterministic meadow and grove diagnostics from the legacy-visible Tree set', async (t) => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const owner = logicalWorldToOwnedChunk(generator.experienceSpawn.x, generator.experienceSpawn.z);
  const coordinates = [];
  for (let chunkX = owner.chunkX - 4; chunkX <= owner.chunkX + 4; chunkX += 1) {
    for (let chunkZ = owner.chunkZ - 4; chunkZ <= owner.chunkZ + 4; chunkZ += 1) {
      coordinates.push([chunkX, chunkZ]);
    }
  }
  const chunks = await Promise.all(coordinates.map(([chunkX, chunkZ]) => generator.generateChunk(chunkX, chunkZ)));
  const rawEntries = chunks.flatMap(chunk => chunk.sourceChunkData.vegetationCandidates
    .filter(candidate => candidate.subtype !== 'shrub' && isW8NaturalCandidateVisible(candidate))
    .map(candidate => Object.freeze({ candidate, settlementReferences: chunk.settlementReferences })));
  const selectedCandidates = chunks.flatMap(chunk => chunk.presentationLayers.natural.vegetation)
    .filter(candidate => candidate.subtype !== 'shrub' && isW8NaturalCandidateVisible(candidate));
  const selectedIds = new Set(selectedCandidates.map(candidate => candidate.candidateId));
  const rawById = new Map(rawEntries.map(entry => [entry.candidate.candidateId, entry.candidate]));
  for (const candidate of selectedCandidates) {
    const raw = rawById.get(candidate.candidateId);
    assert.ok(raw);
    assert.equal(raw.worldPosition.x, candidate.worldPosition.x);
    assert.equal(raw.worldPosition.z, candidate.worldPosition.z);
    assert.equal(raw.subtype, candidate.subtype);
    assert.equal(raw.variationSeed, candidate.variationSeed);
    assert.equal(raw.orientationSeed, candidate.orientationSeed);
  }

  const bounds = Object.freeze({
    minX: (owner.chunkX - 4) * LOGICAL_CHUNK_SIZE_METERS,
    maxX: (owner.chunkX + 5) * LOGICAL_CHUNK_SIZE_METERS,
    minZ: (owner.chunkZ - 4) * LOGICAL_CHUNK_SIZE_METERS,
    maxZ: (owner.chunkZ + 5) * LOGICAL_CHUNK_SIZE_METERS,
  });
  const baseline = connectedTreeMetrics(rawEntries.map(entry => entry.candidate), bounds);
  const phase1 = connectedTreeMetrics(selectedCandidates, bounds);
  assert.ok(phase1.openRate6m > baseline.openRate6m);
  assert.ok(phase1.maxComponentSize < baseline.maxComponentSize);

  const settlementDistance = (entry) => Math.min(...(entry.settlementReferences ?? []).map(reference => (
    Math.hypot(
      entry.candidate.worldPosition.x - reference.center.x,
      entry.candidate.worldPosition.z - reference.center.z,
    ) / reference.radiusMeters
  )), Number.POSITIVE_INFINITY);
  const settlementBands = rangeCounts(
    rawEntries,
    [
      ['0-0.65r', 0, 0.65],
      ['0.65-0.8r', 0.65, 0.8],
      ['0.8-1.0r', 0.8, 1],
      ['1.0-1.25r', 1, 1.25],
      ['1.25r+', 1.25, Number.POSITIVE_INFINITY],
    ],
    settlementDistance,
    entry => selectedIds.has(entry.candidate.candidateId),
  );
  const introEnd = Object.freeze({
    x: generator.experienceSpawn.x
      + Math.sin(generator.experienceSpawn.facingY) * W8_SPAWN_SAFETY_CONTRACT.introDistanceMeters,
    z: generator.experienceSpawn.z
      + Math.cos(generator.experienceSpawn.facingY) * W8_SPAWN_SAFETY_CONTRACT.introDistanceMeters,
  });
  const spawnSignedDistance = (entry) => distanceToSegment(
    entry.candidate.worldPosition,
    generator.experienceSpawn,
    introEnd,
  ) - ((entry.candidate.metadata?.candidateRadiusMeters ?? 0.625)
    + W8_NATURAL_PRESENTATION_PHASE_1.spawnHardClearanceMeters);
  const spawnBands = rangeCounts(
    rawEntries,
    [
      ['0-3m', 0, 3],
      ['3-6m', 3, 6],
      ['6-12m', 6, 12],
      ['12-18m', 12, 18],
      ['18m+', 18, Number.POSITIVE_INFINITY],
    ],
    spawnSignedDistance,
    entry => selectedIds.has(entry.candidate.candidateId),
  );
  t.diagnostic(JSON.stringify({
    baseline,
    phase1,
    settlementBands,
    spawnBands,
  }));

  const policy = await createW8NaturalPresentationPhase1Policy({ worldSeedHash: generator.worldSeedHash });
  const shrubInputs = rawEntries.slice(0, 4).map(entry => Object.freeze({
    ...entry.candidate,
    candidateId: `${entry.candidate.candidateId}:shrub-fixture`,
    subtype: 'shrub',
  }));
  assert.deepEqual(
    stableCandidateIds(policy.selectVegetation({ candidates: shrubInputs })),
    stableCandidateIds(shrubInputs),
  );
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
