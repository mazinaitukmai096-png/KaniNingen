import assert from 'node:assert/strict';
import test from 'node:test';
import { orientedRectanglesOverlap } from '../src/building-lot.js';
import { SETTLEMENT_TYPES } from '../src/settlement-type.js';
import { logicalWorldToOwnedChunk } from '../src/infinite-world/chunk-coordinates.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { W5_SETTLEMENT_DISTRIBUTION } from '../src/infinite-world/settlement-distributor.js';
import {
  createW8ParityChunkGenerator,
  roadIntersectsSettlementBuilding,
} from '../src/infinite-world/w8-parity-chunk-generator.js';
import { createW8SettlementParityOverlay } from '../src/infinite-world/w8-settlement-parity-overlay.js';
import { sampleW8DistantTerrainAt } from '../src/infinite-world/render/w8-distant-presentation.js';
import {
  FINITE_WORLD_UNITS_PER_METER,
  MIGRATED_SETTLEMENT_PROFILES,
  createMigratedSettlementTemplate,
} from '../src/infinite-world/single-rural-settlement.js';
import {
  W8_SURFACE_POLICY_IDS,
  createSettlementSurfacePolicy,
  finiteSettlementSurfaceColorRgb,
  resolveCanonicalGroundSurface,
} from '../src/infinite-world/w8-surface-policy.js';

const seed = 'W8 parity golden seed';
const allowedTownTypes = Object.freeze({
  [SETTLEMENT_TYPES.CITY]: new Set(['capital']),
  [SETTLEMENT_TYPES.TOWN]: new Set(['church_town', 'school_town']),
  [SETTLEMENT_TYPES.RURAL]: new Set(['residential', 'military', 'suburb']),
});

function fakeTerrainChunk(reference, worldX = reference.center.x, worldZ = reference.center.z) {
  const owner = logicalWorldToOwnedChunk(worldX, worldZ);
  const terrain = {
    resolution: { x: 2, z: 2 },
    heightUnitMeters: 1,
    heights: [3, 3, 3, 3],
    materialWeights: Array(20).fill(0),
  };
  return {
    chunkX: owner.chunkX,
    chunkZ: owner.chunkZ,
    terrain,
    canonicalSurfacePolicy: createSettlementSurfacePolicy([reference]),
  };
}

test('corrected Phase 5 uses the biome/region distributor and never injects a six-town cluster', async () => {
  const base = await createDistributedSettlementChunkGenerator({ worldSeed: seed });
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const [baseCandidates, w8Candidates] = await Promise.all([
    base.distributor.findInMacroRange(-8, 8, -8, 8),
    generator.distributor.findInMacroRange(-8, 8, -8, 8),
  ]);
  assert.deepEqual(w8Candidates, baseCandidates);
  assert.ok(baseCandidates.length > 1);
  assert.ok(baseCandidates.every(candidate =>
    allowedTownTypes[candidate.settlementType]?.has(candidate.townType)));
  assert.ok(baseCandidates.every(candidate => {
    const expectedType = candidate.urbanization >= W5_SETTLEMENT_DISTRIBUTION.urbanizationThresholds.city
      ? SETTLEMENT_TYPES.CITY
      : candidate.urbanization >= W5_SETTLEMENT_DISTRIBUTION.urbanizationThresholds.town
        ? SETTLEMENT_TYPES.TOWN : SETTLEMENT_TYPES.RURAL;
    return candidate.settlementType === expectedType
      && candidate.terrainSuitability >= W5_SETTLEMENT_DISTRIBUTION.minimumTerrainSuitability;
  }));
  assert.ok(baseCandidates.every(candidate => candidate.canonicalStartRegion !== true));
  const roleCounts = new Map();
  for (const candidate of baseCandidates) {
    roleCounts.set(candidate.townType, (roleCounts.get(candidate.townType) ?? 0) + 1);
  }
  assert.ok([...roleCounts.values()].some(count => count !== 1));
  assert.equal(generator.reviewSpawn.settlementId, base.reviewSpawn.settlementId);
  assert.deepEqual(generator.reviewSpawn, base.reviewSpawn);
  const audit = await generator.auditSettlementsNear(
    generator.reviewSpawn.x,
    generator.reviewSpawn.z,
    W5_SETTLEMENT_DISTRIBUTION.minimumDistanceMeters[SETTLEMENT_TYPES.CITY],
  );
  assert.ok(audit.length >= 1);
  assert.ok(audit.every(value => value.finiteLocalCenter === null
    && value.buildingCount > 0
    && value.ownerRegion
    && Number.isFinite(value.radiusMeters)));
});

test('distributed Settlements retain finite type profiles without overlap or coordinate translation', async () => {
  const base = await createDistributedSettlementChunkGenerator({ worldSeed: seed });
  const candidates = await base.distributor.findInMacroRange(-8, 8, -8, 8);
  const templates = await Promise.all(candidates.slice(0, 12)
    .map(candidate => createMigratedSettlementTemplate({ candidate })));
  for (let index = 0; index < templates.length; index += 1) {
    const template = templates[index];
    const candidate = candidates[index];
    const profile = MIGRATED_SETTLEMENT_PROFILES[candidate.townType];
    assert.deepEqual(template.center, candidate.center);
    assert.equal(template.radiusMeters, profile.radius / FINITE_WORLD_UNITS_PER_METER);
    assert.equal(template.coreRadiusMeters, profile.coreRadius / FINITE_WORLD_UNITS_PER_METER);
    assert.ok(template.buildings.every(building =>
      Math.hypot(building.x - candidate.center.x, building.z - candidate.center.z)
        <= template.radiusMeters));
  }
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      const leftRadius = MIGRATED_SETTLEMENT_PROFILES[left.townType].radius
        / FINITE_WORLD_UNITS_PER_METER;
      const rightRadius = MIGRATED_SETTLEMENT_PROFILES[right.townType].radius
        / FINITE_WORLD_UNITS_PER_METER;
      assert.ok(Math.hypot(left.center.x - right.center.x, left.center.z - right.center.z)
        > leftRadius + rightRadius);
    }
  }
});

test('each Settlement owns one local road hierarchy and overlay density never adds roads or crosses a Building', async () => {
  const base = await createDistributedSettlementChunkGenerator({ worldSeed: seed });
  const candidates = await base.distributor.findInMacroRange(-6, 6, -6, 6);
  for (const candidate of candidates.slice(0, 8)) {
    const template = await createMigratedSettlementTemplate({ candidate });
    const overlay = await createW8SettlementParityOverlay({
      candidate,
      worldSeedHash: base.worldSeedHash,
    });
    assert.ok(template.roads.length > 0);
    assert.equal(template.roads.some(road => road.roadKind === 'MAJOR'), false);
    assert.equal(new Set(template.roads.map(road => road.stableId)).size, template.roads.length);
    assert.equal(overlay.buildings.some(value => value.featureType === 'settlement-road'), false);
    const allBuildings = [...template.buildings, ...overlay.buildings];
    assert.equal(new Set(allBuildings.map(value => value.stableId)).size, allBuildings.length);
    const retainedRoads = template.roads.filter(road => !allBuildings.some(building =>
      roadIntersectsSettlementBuilding(road, building)));
    assert.ok(retainedRoads.length > 0);
    for (const road of retainedRoads) {
      for (const building of allBuildings) assert.equal(
        roadIntersectsSettlementBuilding(road, building),
        false,
        `${candidate.townType}:${building.stableId}:${road.stableId}`,
      );
    }
  }
});

test('role contracts do not create Military Base, Farm, or Factory in unrelated Settlement types', async () => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const candidates = await generator.distributor.findInMacroRange(-12, 12, -12, 12);
  const byTownType = new Map();
  for (const candidate of candidates) if (!byTownType.has(candidate.townType)) {
    byTownType.set(candidate.townType, candidate);
  }
  for (const [townType, candidate] of byTownType) {
    const owner = logicalWorldToOwnedChunk(candidate.center.x, candidate.center.z);
    const chunk = await generator.generateChunk(owner.chunkX, owner.chunkZ);
    const landmarks = chunk.settlementLandmarks
      .filter(value => value.parentSettlementId === candidate.settlementId)
      .map(value => value.landmarkType);
    assert.equal(landmarks.includes('militaryBase'), townType === 'military');
    assert.equal(landmarks.includes('barn'), townType === 'residential');
    assert.equal(landmarks.includes('factory'), townType === 'suburb');
    if (townType !== 'residential') {
      assert.equal(landmarks.includes('haystack') || landmarks.includes('cow'), false);
    }
    const template = await createMigratedSettlementTemplate({ candidate });
    const buildingTypes = new Set(template.buildings.map(value => value.buildingType));
    if (townType === 'capital') assert.ok(buildingTypes.has('tower'));
    if (townType === 'church_town') assert.ok(buildingTypes.has('church'));
    if (townType === 'school_town') assert.ok(buildingTypes.has('school'));
  }
});

test('surface grading follows actual Settlement profiles and preserves source terrain metadata', async () => {
  const base = await createDistributedSettlementChunkGenerator({ worldSeed: seed });
  const candidate = await base.distributor.findNearestSettlement(0, 0);
  const reference = {
    ...candidate,
    radiusMeters: MIGRATED_SETTLEMENT_PROFILES[candidate.townType].radius
      / FINITE_WORLD_UNITS_PER_METER,
  };
  const chunk = fakeTerrainChunk(reference);
  const sourceBefore = structuredClone(chunk.terrain);
  const region = chunk.canonicalSurfacePolicy.regions[0];
  const center = resolveCanonicalGroundSurface({
    chunkData: chunk,
    worldX: reference.center.x,
    worldZ: reference.center.z,
  });
  assert.equal(center.policyId, W8_SURFACE_POLICY_IDS.SETTLEMENT_GRADED);
  assert.equal(center.finiteWeight, 1);
  assert.equal(center.naturalWeight, 0);
  assert.equal(center.heightMeters, 0);
  const middleX = reference.center.x + region.flatCoreRadiusMeters
    + region.transitionWidthMeters / 2;
  const middle = resolveCanonicalGroundSurface({
    chunkData: fakeTerrainChunk(reference, middleX, reference.center.z),
    worldX: middleX,
    worldZ: reference.center.z,
  });
  assert.equal(middle.naturalWeight, 0.5);
  const outsideX = reference.center.x + region.flatCoreRadiusMeters + region.transitionWidthMeters;
  const outside = resolveCanonicalGroundSurface({
    chunkData: fakeTerrainChunk(reference, outsideX, reference.center.z),
    worldX: outsideX,
    worldZ: reference.center.z,
  });
  assert.equal(outside.policyId, W8_SURFACE_POLICY_IDS.NATURAL_TERRAIN);
  assert.equal(outside.finiteWeight, 0);
  assert.deepEqual(chunk.terrain, sourceBefore);
  const finiteColor = finiteSettlementSurfaceColorRgb(reference.center.x, reference.center.z);
  assert.ok(finiteColor.every(channel => channel >= 0 && channel <= 1));
  assert.ok(Math.max(...finiteColor) < 0.4, 'finite sRGB palette must be converted to linear vertex color');
});

test('Near and Distant terrain resolve the same finite palette inside an actual Settlement core', async () => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const candidate = await generator.distributor.findNearestSettlement(0, 0);
  const owner = logicalWorldToOwnedChunk(candidate.center.x, candidate.center.z);
  const chunk = await generator.generateChunk(owner.chunkX, owner.chunkZ);
  const surface = resolveCanonicalGroundSurface({
    chunkData: chunk,
    worldX: candidate.center.x,
    worldZ: candidate.center.z,
  });
  assert.equal(surface.finiteWeight, 1);
  const distant = sampleW8DistantTerrainAt(chunk, candidate.center.x, candidate.center.z);
  assert.deepEqual(distant.color, finiteSettlementSurfaceColorRgb(candidate.center.x, candidate.center.z));
  assert.equal(distant.height, 0);
});

test('the withdrawn fixed Water/Road/Bridge overlay cannot leave crossings or orphan Bridges', async () => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const chunks = await Promise.all(generator.experienceSpawn.spawnSafety.preparedChunkKeys
    .map(key => key.split(',').map(Number))
    .map(([chunkX, chunkZ]) => generator.generateChunk(chunkX, chunkZ)));
  for (const chunk of chunks) {
    assert.equal(chunk.bridges, undefined);
    assert.equal(chunk.presentationLayers.bridges, undefined);
    const roads = chunk.settlementFeatures.filter(value => value.featureType === 'settlement-road');
    for (const road of roads) {
      const dx = road.end.x - road.start.x;
      const dz = road.end.z - road.start.z;
      const rectangle = {
        centerX: (road.start.x + road.end.x) / 2,
        centerZ: (road.start.z + road.end.z) / 2,
        rotationY: Math.atan2(dx, dz),
        width: road.widthMeters,
        depth: Math.hypot(dx, dz),
      };
      for (const water of chunk.waterSurfaces) {
        assert.equal(orientedRectanglesOverlap(rectangle, {
          centerX: water.worldPosition.x,
          centerZ: water.worldPosition.z,
          rotationY: 0,
          width: water.widthMeters,
          depth: water.depthMeters,
        }), false);
      }
    }
  }
});

test('restart and repeated projection retain Stable IDs, owners, local roads, and diagnostics without growth', async () => {
  const first = await createW8ParityChunkGenerator({ worldSeed: seed });
  const second = await createW8ParityChunkGenerator({ worldSeed: seed });
  const owner = logicalWorldToOwnedChunk(first.reviewSpawn.x, first.reviewSpawn.z);
  const [firstChunk, repeatedChunk, secondChunk] = await Promise.all([
    first.generateChunk(owner.chunkX, owner.chunkZ),
    first.generateChunk(owner.chunkX, owner.chunkZ),
    second.generateChunk(owner.chunkX, owner.chunkZ),
  ]);
  assert.equal(firstChunk.contentHash, repeatedChunk.contentHash);
  assert.equal(firstChunk.contentHash, secondChunk.contentHash);
  assert.deepEqual(
    firstChunk.settlementFeatures.map(value => [value.stableId, value.owningChunkCoordinate]),
    secondChunk.settlementFeatures.map(value => [value.stableId, value.owningChunkCoordinate]),
  );
  assert.equal(firstChunk.settlementReferences.some(value => value.canonicalStartRegion), false);
  assert.equal(firstChunk.bridges, undefined);
  const diagnostics = first.snapshot().observedSettlementDiagnostics;
  assert.ok(diagnostics.length >= 1);
  assert.ok(diagnostics.every(value => value.buildingCount >= value.sourceBuildingCount));
});
