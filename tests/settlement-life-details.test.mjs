import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CIVIC_SPACE_STATUS,
  createCivicSpaceReservations,
} from '../src/civic-space.js';
import { buildRoadHierarchy } from '../src/road-town-structure.js';
import {
  SETTLEMENT_LIFE_DETAIL_CONTEXTS,
  SETTLEMENT_LIFE_DETAIL_PLACEMENT_RADII,
  SETTLEMENT_LIFE_DETAIL_TOWN_COUNTS,
  SETTLEMENT_LIFE_DETAIL_TYPE_COUNTS_BY_TOWN,
  createSettlementLifeDetailCollisionContext,
  createSettlementLifeDetailPlacements,
  getSettlementLifeDetailBaselineTypeCounts,
  getSettlementLifeDetailCollisionReason,
} from '../src/settlement-life-details.js';
import { getSettlementTypeForTownType } from '../src/settlement-type.js';
import {
  TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES,
  WORLD_DETAIL_INSTANCE_CAPACITY,
  WORLD_DETAIL_PARTS,
  canStageDestroyWorldDetail,
  getWorldDetailCounts,
} from '../src/world-scale-rebalance.js';

const repoRoot = resolve(import.meta.dirname, '..');
const game = readFileSync(resolve(repoRoot, 'src/game.js'), 'utf8').replace(/\r\n/g, '\n');
const source = readFileSync(resolve(repoRoot, 'src/settlement-life-details.js'), 'utf8');
const towns = [
  { x: 0, z: 0, radius: 4860, coreRadius: 2700, type: 'capital' },
  { x: 7500, z: 7500, radius: 3780, coreRadius: 2100, type: 'church_town' },
  { x: -8250, z: 6750, radius: 3780, coreRadius: 2100, type: 'school_town' },
  { x: 7500, z: -7500, radius: 3510, coreRadius: 1950, type: 'residential' },
  { x: -7500, z: -8250, radius: 3510, coreRadius: 1950, type: 'military' },
  { x: 0, z: 11250, radius: 3240, coreRadius: 1800, type: 'suburb' },
].map(town => ({ ...town, settlementType: getSettlementTypeForTownType(town.type) }));
const waterZones = [
  { x: 3800, z: 3800, radius: 360 },
  { x: 5200, z: -1200, radius: 320, isPond: true },
  { x: -5200, z: -900, radius: 340, isPond: true },
];
const exclusionZones = [
  { x: -400, z: 0, radius: 145, type: 'school' },
  { x: 500, z: 0, radius: 115, type: 'church' },
  { x: 0, z: -550, radius: 65, type: 'tower' },
  { x: 7500, z: 7500, radius: 115, type: 'church' },
  { x: 7100, z: 7800, radius: 65, type: 'tower' },
  { x: -8250, z: 6750, radius: 145, type: 'school' },
  { x: -7500, z: -8250, radius: 65, type: 'tower' },
  { x: 0, z: 11250, radius: 115, type: 'church' },
];
const landmarks = [
  { townType: 'capital', type: 'school', x: -400, z: 0, rotationY: 0, radius: 145 },
  { townType: 'capital', type: 'church', x: 500, z: 0, rotationY: Math.PI / 2, radius: 115 },
  { townType: 'capital', type: 'tower', x: 0, z: -550, rotationY: 0, radius: 65 },
  { townType: 'church_town', type: 'church', x: 7500, z: 7500, rotationY: 0, radius: 115 },
  { townType: 'church_town', type: 'tower', x: 7100, z: 7800, rotationY: Math.PI / 4, radius: 65 },
  { townType: 'school_town', type: 'school', x: -8250, z: 6750, rotationY: 0, radius: 145 },
];
const hierarchy = buildRoadHierarchy({ townCenters: towns, waterZones, exclusionZones });
const civicSpaces = createCivicSpaceReservations({
  townCenters: towns,
  landmarks,
  roads: hierarchy.roads,
  roadSurfaces: hierarchy.roadSurfaces,
  junctionSurfaces: hierarchy.junctionSurfaces,
  bridgeSpans: hierarchy.bridgeSpans,
  capitalCivicCore: hierarchy.capitalCivicCore,
  waterZones,
  exclusionZones,
});
const parkZones = towns.map((town, townIndex) => ({
  x: town.x + 1400,
  z: town.z + (townIndex % 2 === 0 ? -1300 : 1300),
  radius: 180,
  tc: town,
}));
const buildingLots = towns.flatMap((town, townIndex) => Array.from({ length: 5 }, (_, lotIndex) => {
  const frontSign = townIndex % 2 === 0 ? 1 : -1;
  const rotationY = frontSign === 1 ? 0 : Math.PI;
  const centerX = town.x - 1000 + lotIndex * 480;
  const centerZ = town.z + frontSign * -1100;
  return {
    lotStatus: 'ACTIVE',
    lotId: `fixture-lot-${townIndex}-${lotIndex}`,
    buildingIndex: townIndex * 5 + lotIndex,
    buildingType: lotIndex % 2 === 0 ? 'tower' : 'house',
    centerX,
    centerZ,
    rotationY,
    width: 220,
    depth: 180,
    entranceX: centerX,
    entranceZ: centerZ + frontSign * 70,
    roadAccessX: centerX,
    roadAccessZ: centerZ + frontSign * 170,
    frontageRoadId: hierarchy.roads.find(road => road.town?.type === town.type)?.roadId ?? null,
    pathWidth: 14,
    pathRectangle: {
      centerX,
      centerZ: centerZ + frontSign * 125,
      rotationY,
      width: 14,
      depth: 110,
    },
    forecourtRectangle: {
      centerX,
      centerZ: centerZ + frontSign * 78,
      rotationY,
      width: 90,
      depth: 30,
    },
  };
}));
const militaryBaseZones = [
  { x: -7500 + 3860, z: -8250, radius: 160, type: 'militaryBase' },
];
const fixtureInput = {
  towns,
  civicSpaces,
  buildingLots,
  parkZones,
  roads: hierarchy.roads,
  pathSamples: hierarchy.pathSamples,
  junctions: hierarchy.junctions,
  roadSurfaces: hierarchy.roadSurfaces,
  junctionSurfaces: hierarchy.junctionSurfaces,
  bridges: hierarchy.bridgeSpans,
  waterZones,
  exclusionZones,
  buildingSpots: [],
  militaryBaseZones,
};
const result = createSettlementLifeDetailPlacements(fixtureInput);
const collisionContext = createSettlementLifeDetailCollisionContext(fixtureInput);

test('the Phase 4A contract uses only the eight existing types and eight approved contexts', () => {
  assert.deepEqual(Object.values(SETTLEMENT_LIFE_DETAIL_CONTEXTS), [
    'CIVIC_SPACE',
    'BUILDING_ENTRANCE',
    'PARK_EDGE',
    'MAJOR_ROAD',
    'LOCAL_ROAD',
    'INTERSECTION',
    'RURAL_EDGE',
    'MILITARY_EDGE',
  ]);
  assert.deepEqual(Object.keys(getSettlementLifeDetailBaselineTypeCounts()), [
    'streetLamp', 'bench', 'trashBin', 'roadSign',
    'planter', 'vendingMachine', 'parkedCar', 'fence',
  ]);
  assert.deepEqual(getSettlementLifeDetailBaselineTypeCounts(), getWorldDetailCounts(6, 2));
  assert.equal(Object.keys(SETTLEMENT_LIFE_DETAIL_PLACEMENT_RADII).length, 8);
});

test('town allocation is exactly 30, 18, 18, 10, 10, 10 without changing type totals', () => {
  assert.deepEqual(result.summary.townCounts, SETTLEMENT_LIFE_DETAIL_TOWN_COUNTS);
  assert.deepEqual(result.summary.typeCounts, getWorldDetailCounts(6, 2));
  for (const [townType, typeCounts] of Object.entries(SETTLEMENT_LIFE_DETAIL_TYPE_COUNTS_BY_TOWN)) {
    assert.equal(Object.values(typeCounts).reduce((sum, count) => sum + count, 0), SETTLEMENT_LIFE_DETAIL_TOWN_COUNTS[townType]);
    const actual = Object.fromEntries(Object.keys(typeCounts).map(type => [
      type,
      result.placements.filter(placement => placement.relatedTownType === townType && placement.type === type).length,
    ]));
    assert.deepEqual(actual, typeCounts, townType);
  }
});

test('object, instance, capacity, Geometry, Material, and draw-call contracts stay fixed', () => {
  assert.equal(result.summary.totalObjectCount, 96);
  assert.equal(result.summary.totalInstanceCount, 258);
  assert.equal(result.summary.capacity, 320);
  assert.equal(WORLD_DETAIL_INSTANCE_CAPACITY, 320);
  assert.equal(result.placements.reduce((sum, placement) => sum + WORLD_DETAIL_PARTS[placement.type].length, 0), 258);
  assert.match(game, /worldDetailInstancedMesh = new THREE\.InstancedMesh\(\s*geometries\.box,\s*materials\.worldDetail,\s*WORLD_DETAIL_INSTANCE_CAPACITY/s);
  assert.equal((game.match(/worldDetail: new THREE\.MeshPhongMaterial/g) || []).length, 1);
  assert.doesNotMatch(source, /new THREE\.|Geometry|Material|InstancedMesh/);
});

test('every placement is outside protected surfaces and maintains object spacing', () => {
  for (const placement of result.placements) {
    assert.equal(
      getSettlementLifeDetailCollisionReason(
        placement,
        SETTLEMENT_LIFE_DETAIL_PLACEMENT_RADII[placement.type],
        collisionContext,
      ),
      null,
      `${placement.relatedTownType}:${placement.type}:${placement.placementContext}`,
    );
  }
  for (let firstIndex = 0; firstIndex < result.placements.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < result.placements.length; secondIndex++) {
      const first = result.placements[firstIndex];
      const second = result.placements[secondIndex];
      assert.ok(Math.hypot(first.x - second.x, first.z - second.z) >= Math.max(
        first.placementRadius + second.placementRadius + 10,
        50,
      ));
    }
  }
});

test('Civic Space rules keep centers clear and preserve each approved square fixture', () => {
  assert.equal(civicSpaces.every(space => space.status === CIVIC_SPACE_STATUS.ACTIVE), true);
  for (const civicSpace of civicSpaces) {
    const civicPlacements = result.placements.filter(placement => placement.relatedCivicSpaceId === civicSpace.civicSpaceId);
    assert.ok(civicPlacements.length > 0, civicSpace.civicSpaceId);
    assert.equal(civicPlacements.every(placement => placement.placementContext === 'CIVIC_SPACE'), true);
    assert.equal(civicPlacements.every(placement => Math.hypot(
      placement.x - civicSpace.centerX,
      placement.z - civicSpace.centerZ,
    ) > Math.min(civicSpace.width, civicSpace.depth) / 2), true);
  }
  const typesForTownSquare = townType => {
    const civicSpaceId = civicSpaces.find(space => space.townType === townType).civicSpaceId;
    return result.placements.filter(placement => placement.relatedCivicSpaceId === civicSpaceId).map(placement => placement.type);
  };
  const cityTypes = typesForTownSquare('capital');
  const churchTypes = typesForTownSquare('church_town');
  const schoolTypes = typesForTownSquare('school_town');
  assert.equal(cityTypes.some(type => type === 'parkedCar' || type === 'fence'), false);
  assert.equal(churchTypes.some(type => ['vendingMachine', 'parkedCar', 'fence'].includes(type)), false);
  assert.equal(schoolTypes.some(type => type === 'parkedCar' || type === 'fence'), false);
});

test('context semantics cover entrances, parks, intersections, rural edges, and the Military edge', () => {
  for (const context of ['BUILDING_ENTRANCE', 'PARK_EDGE', 'INTERSECTION', 'RURAL_EDGE', 'MILITARY_EDGE']) {
    assert.ok(result.summary.contextCounts[context] > 0, context);
  }
  assert.ok(result.placements.some(placement => placement.type === 'roadSign' && placement.placementContext === 'INTERSECTION'));
  assert.equal(result.placements.filter(placement => placement.type === 'vendingMachine').every(placement => (
    ['BUILDING_ENTRANCE', 'CIVIC_SPACE', 'PARK_EDGE'].includes(placement.placementContext)
  )), true);
  assert.equal(result.placements.filter(placement => placement.placementContext === 'MILITARY_EDGE').every(placement => (
    placement.relatedTownType === 'military'
  )), true);
  assert.equal(Object.values(result.summary.buildingEntranceObjectCounts).reduce((sum, count) => sum + count, 0), result.summary.contextCounts.BUILDING_ENTRANCE);
  assert.equal(Object.values(result.summary.parkEdgeObjectCounts).reduce((sum, count) => sum + count, 0), result.summary.contextCounts.PARK_EDGE);
});

test('unsafe or unavailable entrance candidates retry another context in the same town', () => {
  const withoutLots = createSettlementLifeDetailPlacements({ ...fixtureInput, buildingLots: [] });
  assert.equal(withoutLots.summary.totalObjectCount, 96);
  assert.deepEqual(withoutLots.summary.townCounts, SETTLEMENT_LIFE_DETAIL_TOWN_COUNTS);
  assert.deepEqual(withoutLots.summary.typeCounts, getWorldDetailCounts(6, 2));
  assert.equal(withoutLots.summary.contextCounts.BUILDING_ENTRANCE, 0);
});

test('type orientation rules face activity or align with roads and boundaries', () => {
  for (const placement of result.placements) {
    if (placement.type === 'bench') assert.equal(placement.orientationRule, 'FACE_ACTIVITY_CENTER');
    if (placement.type === 'parkedCar') assert.equal(placement.orientationRule, 'PARALLEL_TO_ROAD_TANGENT');
    if (placement.type === 'roadSign') assert.equal(placement.orientationRule, 'ALIGN_TO_ROAD_DIRECTION');
    if (placement.type === 'streetLamp') assert.equal(placement.orientationRule, 'FACE_ROAD_OR_SPACE');
    if (placement.type === 'planter') assert.equal(placement.orientationRule, 'FACE_ENTRANCE_OR_SPACE');
    if (placement.type === 'fence') assert.equal(placement.orientationRule, 'PARALLEL_TO_BOUNDARY');
  }
});

test('clusters are meaningful groups of two to four while leaving unclustered space', () => {
  assert.ok(result.summary.clusterCount > 0);
  assert.equal(result.summary.clusterSizes.every(size => size >= 2 && size <= 4), true);
  assert.ok(result.placements.some(placement => placement.clusterId === null));
  const clusterIds = new Set(result.placements.map(placement => placement.clusterId).filter(Boolean));
  assert.equal(clusterIds.size, result.summary.clusterCount);
});

test('Tiny destruction still targets exactly four existing types and hides all parts once', () => {
  assert.deepEqual(TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES, ['trashBin', 'roadSign', 'bench', 'planter']);
  for (const type of TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES) {
    assert.equal(canStageDestroyWorldDetail('TINY', type), true);
  }
  assert.match(game, /for \(const instanceIndex of prop\.instanceIndices\)/);
  assert.match(game, /prop\.destroyed = true;/);
  assert.match(game, /if \(prop\.destroyed \|\| !canStageDestroyWorldDetail/);
  assert.equal((game.match(/damageWorldDetailsAt\(/g) || []).length, 4);
});

test('same input is deterministic without random, Seed, generic Zones, HUD, or console output', () => {
  assert.deepEqual(createSettlementLifeDetailPlacements(structuredClone(fixtureInput)), result);
  assert.doesNotMatch(source, /Math\.random|\bseed\b|terrain|chunk|query|growth|threat|wanted|perk|worldstate/i);
  assert.doesNotMatch(source, /class\s+(?:Zone|District|Parcel)|createGenericZone/i);
  assert.doesNotMatch(source, /console\.|document\.|HUD/i);
});

test('locked Civic Space, building visual, Frontage, Lot, and gameplay modules are unchanged', () => {
  for (const path of [
    'src/civic-space.js',
    'src/capital-civic-core.js',
    'src/building-frontage.js',
    'src/building-lot.js',
    'src/settlement-building-visuals.js',
    'src/world-scale-rebalance.js',
    'src/scale-sandbox.js',
    'src/constants.js',
  ]) {
    const current = readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
    const baseline = execFileSync('git', ['show', `HEAD:${path}`], { cwd: repoRoot, encoding: 'utf8' }).replace(/\r\n/g, '\n');
    assert.equal(current, baseline, path);
  }
});
