import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BUILDING_FRONTAGE_PROFILES,
  FRONTAGE_BUILDING_TYPES,
  buildFrontageAnchorPlan,
  circleIntersectsBridge,
  circleIntersectsCircle,
  circleIntersectsOrientedSurface,
  createFrontageCandidatePlacements,
  createFrontagePlacement,
  frontageSpotsConflict,
  getFrontagePairGaps,
  getMaximumAlongRoadGap,
  selectFrontageAnchorSample,
  selectFrontageRoad,
} from '../src/building-frontage.js';
import { ROAD_KINDS, buildRoadHierarchy } from '../src/road-town-structure.js';

const repoRoot = resolve(import.meta.dirname, '..');
const gamePath = resolve(repoRoot, 'src/game.js');
const game = readFileSync(gamePath, 'utf8').replace(/\r\n/g, '\n');

const makeRoad = ({
  roadId,
  kind,
  start,
  end,
  townId = 'town-0-capital',
  routeId = `${roadId}-route`,
  routeOrder = 0,
  isTownSpine = false,
  width = kind === ROAD_KINDS.MAJOR ? 90 : kind === ROAD_KINDS.ALLEY ? 44 : 64,
}) => {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  const tangentX = dx / length;
  const tangentZ = dz / length;
  return {
    roadId,
    routeId,
    routeOrder,
    isTownSpine,
    kind,
    townId,
    start,
    end,
    width,
    tangentX,
    tangentZ,
    normalX: -tangentZ,
    normalZ: tangentX,
  };
};

const diagonalLocal = makeRoad({
  roadId: 'road-010',
  kind: ROAD_KINDS.LOCAL,
  start: { x: -200, z: -200 },
  end: { x: 200, z: 200 },
});

test('frontage scope and type-specific setback profiles are explicit and bounded', () => {
  assert.deepEqual(FRONTAGE_BUILDING_TYPES, ['house', 'tower', 'school', 'church']);
  assert.deepEqual(Object.keys(BUILDING_FRONTAGE_PROFILES), FRONTAGE_BUILDING_TYPES);
  assert.deepEqual(
    Object.fromEntries(FRONTAGE_BUILDING_TYPES.map(type => [
      type,
      [BUILDING_FRONTAGE_PROFILES[type].minSetback, BUILDING_FRONTAGE_PROFILES[type].maxSetback],
    ])),
    {
      house: [20, 45],
      tower: [25, 50],
      school: [45, 80],
      church: [50, 90],
    },
  );
  for (const profile of Object.values(BUILDING_FRONTAGE_PROFILES)) {
    assert.ok(profile.variation <= 0.15);
    assert.equal(profile.frontRotationOffset, 0);
    assert.ok(profile.frontExtent > 0);
  }
  assert.equal(BUILDING_FRONTAGE_PROFILES.house.setback, 26);
  assert.equal(BUILDING_FRONTAGE_PROFILES.house.variation, 0.10);
  assert.equal(BUILDING_FRONTAGE_PROFILES.tower.setback, 38);
  assert.equal(BUILDING_FRONTAGE_PROFILES.school.setback, 64);
  assert.equal(BUILDING_FRONTAGE_PROFILES.church.setback, 70);
});

test('nearest road selection excludes START_APPROACH and combines real distance with kind preference', () => {
  const roads = [
    makeRoad({ roadId: 'road-001', kind: ROAD_KINDS.START_APPROACH, start: { x: -100, z: 0 }, end: { x: 100, z: 0 }, width: 56 }),
    makeRoad({ roadId: 'road-002', kind: ROAD_KINDS.MAJOR, start: { x: -100, z: 10 }, end: { x: 100, z: 10 } }),
    makeRoad({ roadId: 'road-003', kind: ROAD_KINDS.LOCAL, start: { x: -100, z: 55 }, end: { x: 100, z: 55 } }),
    makeRoad({ roadId: 'road-004', kind: ROAD_KINDS.ALLEY, start: { x: -100, z: 120 }, end: { x: 100, z: 120 } }),
  ];
  const selected = selectFrontageRoad({ x: 0, z: 0, roads, townId: 'town-0-capital' });
  assert.equal(selected.roadId, 'road-003');
  assert.equal(selected.kind, ROAD_KINDS.LOCAL);

  const clearlyCloserAlley = selectFrontageRoad({ x: 0, z: 119, roads, townId: 'town-0-capital' });
  assert.equal(clearlyCloserAlley.roadId, 'road-004');
  assert.equal(clearlyCloserAlley.kind, ROAD_KINDS.ALLEY);

  const majorFallback = selectFrontageRoad({
    x: 0,
    z: 0,
    roads: [
      makeRoad({ roadId: 'road-005', kind: ROAD_KINDS.MAJOR, start: { x: -100, z: 0 }, end: { x: 100, z: 0 } }),
      makeRoad({ roadId: 'road-006', kind: ROAD_KINDS.LOCAL, start: { x: -100, z: 500 }, end: { x: 100, z: 500 } }),
    ],
    townId: 'town-0-capital',
  });
  assert.equal(majorFallback.roadId, 'road-005');
  assert.equal(majorFallback.kind, ROAD_KINDS.MAJOR);
});

test('road selection is deterministic and breaks equal scores by roadId', () => {
  const roads = [
    makeRoad({ roadId: 'road-020', kind: ROAD_KINDS.LOCAL, start: { x: -100, z: 20 }, end: { x: 100, z: 20 } }),
    makeRoad({ roadId: 'road-019', kind: ROAD_KINDS.LOCAL, start: { x: -100, z: -20 }, end: { x: 100, z: -20 } }),
  ];
  const first = selectFrontageRoad({ x: 0, z: 0, roads, townId: 'town-0-capital' });
  const repeated = selectFrontageRoad({ x: 0, z: 0, roads: [...roads].reverse(), townId: 'town-0-capital' });
  assert.equal(first.roadId, 'road-019');
  assert.deepEqual(repeated, first);
  assert.equal(selectFrontageRoad({ x: 0, z: 0, roads, townId: 'another-town' }), null);
});

test('every supported building faces the selected diagonal road without 90-degree snapping', () => {
  const road = selectFrontageRoad({ x: 0, z: 0, roads: [diagonalLocal], townId: 'town-0-capital' });
  for (const [buildingIndex, type] of FRONTAGE_BUILDING_TYPES.entries()) {
    const placement = createFrontagePlacement({ type, road, buildingIndex, townId: 'town-0-capital' });
    const frontX = Math.sin(placement.rotationY);
    const frontZ = Math.cos(placement.rotationY);
    const towardRoadX = placement.frontageX - placement.x;
    const towardRoadZ = placement.frontageZ - placement.z;
    const towardLength = Math.hypot(towardRoadX, towardRoadZ);
    assert.ok(Math.abs(frontX - towardRoadX / towardLength) < 1e-12);
    assert.ok(Math.abs(frontZ - towardRoadZ / towardLength) < 1e-12);
    assert.ok(frontX * (towardRoadX / towardLength) + frontZ * (towardRoadZ / towardLength) > 0.999999);
    assert.ok(Math.abs(placement.rotationY / (Math.PI / 2) - Math.round(placement.rotationY / (Math.PI / 2))) > 0.1);
    assert.ok(placement.setback >= BUILDING_FRONTAGE_PROFILES[type].minSetback);
    assert.ok(placement.setback <= BUILDING_FRONTAGE_PROFILES[type].maxSetback);
    assert.ok(Math.abs(
      Math.hypot(placement.x - placement.frontageX, placement.z - placement.frontageZ)
      - placement.centerDistance
    ) < 1e-10);
    assert.equal(placement.frontageRoadId, diagonalLocal.roadId);
    assert.equal(Math.abs(Math.hypot(placement.frontageNormalX, placement.frontageNormalZ) - 1) < 1e-12, true);
    for (const value of [
      placement.x,
      placement.z,
      placement.rotationY,
      placement.frontageX,
      placement.frontageZ,
      placement.frontageNormalX,
      placement.frontageNormalZ,
      placement.setback,
    ]) assert.equal(Number.isFinite(value), true);

    const roadSurface = {
      x: 0,
      z: 0,
      width: diagonalLocal.width,
      length: Math.hypot(
        diagonalLocal.end.x - diagonalLocal.start.x,
        diagonalLocal.end.z - diagonalLocal.start.z,
      ),
      tangentX: diagonalLocal.tangentX,
      tangentZ: diagonalLocal.tangentZ,
    };
    assert.equal(circleIntersectsOrientedSurface(
      placement.x,
      placement.z,
      BUILDING_FRONTAGE_PROFILES[type].frontExtent,
      roadSurface,
    ), false);
    assert.ok(
      placement.centerDistance - diagonalLocal.width / 2 - BUILDING_FRONTAGE_PROFILES[type].frontExtent
      >= BUILDING_FRONTAGE_PROFILES[type].minSetback,
    );
  }
});

test('side and setback variation are deterministic, limited, and use stable identity inputs', () => {
  const road = selectFrontageRoad({ x: 0, z: 0, roads: [diagonalLocal], townId: 'town-0-capital' });
  const placements = Array.from({ length: 32 }, (_, buildingIndex) => (
    createFrontagePlacement({ type: 'house', road, buildingIndex, townId: 'town-0-capital' })
  ));
  assert.deepEqual(
    placements,
    Array.from({ length: 32 }, (_, buildingIndex) => (
      createFrontagePlacement({ type: 'house', road, buildingIndex, townId: 'town-0-capital' })
    )),
  );
  assert.deepEqual(new Set(placements.map(placement => placement.side)), new Set([-1, 1]));
  for (const placement of placements) {
    const ratio = Math.abs(placement.setback / BUILDING_FRONTAGE_PROFILES.house.setback - 1);
    assert.ok(ratio <= BUILDING_FRONTAGE_PROFILES.house.variation + 1e-12);
  }
});

test('candidate search follows deterministic 0,+1,-1 slots, retries both sides, and crosses adjacent route segments', () => {
  const roads = [
    makeRoad({
      roadId: 'road-100',
      routeId: 'local-route',
      routeOrder: 0,
      kind: ROAD_KINDS.LOCAL,
      start: { x: 0, z: 0 },
      end: { x: 400, z: 0 },
    }),
    makeRoad({
      roadId: 'road-101',
      routeId: 'local-route',
      routeOrder: 1,
      kind: ROAD_KINDS.LOCAL,
      start: { x: 400, z: 0 },
      end: { x: 800, z: 0 },
    }),
  ];
  const selected = selectFrontageRoad({ x: 350, z: 0, roads, townId: 'town-0-capital' });
  const result = createFrontageCandidatePlacements({
    type: 'house',
    road: selected,
    roads,
    buildingIndex: 7,
    townId: 'town-0-capital',
  });
  assert.deepEqual(result.placements.slice(0, 6).map(candidate => candidate.slotOffset), [0, 0, 1, 1, -1, -1]);
  for (let index = 0; index < result.placements.length; index += 2) {
    const primary = result.placements[index];
    const opposite = result.placements[index + 1];
    assert.equal(primary.sideAttempt, 0);
    assert.equal(opposite.sideAttempt, 1);
    assert.equal(opposite.side, -primary.side);
    assert.equal(primary.frontageAlong, opposite.frontageAlong);
  }
  assert.ok(result.placements.some(candidate => candidate.frontageRoadId === 'road-101'));
  assert.deepEqual(
    createFrontageCandidatePlacements({ type: 'house', road: selected, roads, buildingIndex: 7, townId: 'town-0-capital' }),
    result,
  );
});

test('candidate validation can fall back to the opposite side without duplicating a building', () => {
  const road = makeRoad({
    roadId: 'road-110',
    kind: ROAD_KINDS.LOCAL,
    start: { x: -500, z: 0 },
    end: { x: 500, z: 0 },
  });
  const selected = selectFrontageRoad({ x: 0, z: 0, roads: [road], townId: 'town-0-capital' });
  const candidates = createFrontageCandidatePlacements({
    type: 'tower',
    road: selected,
    roads: [road],
    buildingIndex: 2,
    townId: 'town-0-capital',
    maximumSlotOffset: 0,
  }).placements;
  const blockedSide = candidates[0].side;
  const accepted = candidates.find(candidate => candidate.side !== blockedSide);
  assert.ok(accepted);
  assert.equal(accepted.sideAttempt, 1);
  assert.equal(candidates.filter(candidate => candidate.side === accepted.side).length, 1);
});

test('House and Tower use compact pair gaps while School and Church retain legacy clearance', () => {
  assert.deepEqual(getFrontagePairGaps('house', 'house'), { passageGap: 35, alongGap: 20 });
  assert.deepEqual(getFrontagePairGaps('house', 'tower'), { passageGap: 42, alongGap: 20 });
  assert.deepEqual(getFrontagePairGaps('tower', 'tower'), { passageGap: 48, alongGap: 20 });
  for (const pair of [['house', 'school'], ['tower', 'church'], ['school', 'church']]) {
    assert.deepEqual(getFrontagePairGaps(...pair), { passageGap: 75, alongGap: 30 });
  }

  const first = { x: 0, z: 0, radius: 90, type: 'house', frontageRoadId: 'road-1', frontageRouteId: 'route-1', frontageAlong: 0 };
  assert.equal(frontageSpotsConflict(
    { x: 214, z: 0, radius: 90, type: 'house', frontageRoadId: 'road-1', frontageRouteId: 'route-1', frontageAlong: 214 },
    first,
  ), true);
  assert.equal(frontageSpotsConflict(
    { x: 215, z: 0, radius: 90, type: 'house', frontageRoadId: 'road-1', frontageRouteId: 'route-1', frontageAlong: 215 },
    first,
  ), false);
});

test('anchor plan applies a deterministic 40/45/15 Core-Middle-Outer request pattern with LOCAL spine priority', () => {
  const roads = [
    makeRoad({ roadId: 'road-core', routeId: 'core-route', kind: ROAD_KINDS.LOCAL, start: { x: 0, z: 0 }, end: { x: 100, z: 0 }, isTownSpine: true }),
    makeRoad({ roadId: 'road-middle', routeId: 'middle-route', kind: ROAD_KINDS.LOCAL, start: { x: 500, z: 0 }, end: { x: 600, z: 0 } }),
    makeRoad({ roadId: 'road-outer', routeId: 'outer-route', kind: ROAD_KINDS.ALLEY, start: { x: 850, z: 0 }, end: { x: 950, z: 0 } }),
  ];
  const samples = roads.map((road, index) => ({
    x: road.start.x,
    z: road.start.z,
    roadId: road.roadId,
    sampleIndex: index,
  }));
  const plan = buildFrontageAnchorPlan({ samples, roads, town: { x: 0, z: 0, radius: 1000 } });
  assert.equal(plan.CORE[0].roadId, 'road-core');
  const selectedRegions = Array.from({ length: 20 }, (_, index) => {
    const selected = selectFrontageAnchorSample({
      plan,
      buildingIndex: index + 1,
      type: 'house',
      townId: 'town-0-capital',
    });
    return selected.roadId === 'road-core' ? 'CORE'
      : selected.roadId === 'road-middle' ? 'MIDDLE' : 'OUTER';
  });
  assert.deepEqual(
    Object.fromEntries(['CORE', 'MIDDLE', 'OUTER'].map(region => [
      region,
      selectedRegions.filter(candidate => candidate === region).length,
    ])),
    { CORE: 8, MIDDLE: 9, OUTER: 3 },
  );
});

test('representative fixture places at least as many residential buildings, uses no fewer roads, and shortens the maximum gap', () => {
  const roads = [
    makeRoad({ roadId: 'road-a', routeId: 'route-a', kind: ROAD_KINDS.LOCAL, start: { x: 0, z: 0 }, end: { x: 1000, z: 0 } }),
    makeRoad({ roadId: 'road-b', routeId: 'route-b', kind: ROAD_KINDS.LOCAL, start: { x: 0, z: 600 }, end: { x: 1000, z: 600 } }),
  ];
  const attempts = ['road-a', 'road-a', 'road-a', 'road-a', 'road-b', 'road-b'];

  const simulate = expanded => {
    const placed = [];
    for (let index = 0; index < attempts.length; index++) {
      const segment = roads.find(road => road.roadId === attempts[index]);
      const selected = selectFrontageRoad({
        x: 300,
        z: segment.start.z,
        roads: [segment],
        townId: 'town-0-capital',
      });
      const candidates = expanded
        ? createFrontageCandidatePlacements({
          type: 'house',
          road: selected,
          roads,
          buildingIndex: index + 1,
          townId: 'town-0-capital',
        }).placements
        : [createFrontagePlacement({
          type: 'house',
          road: selected,
          buildingIndex: index + 1,
          townId: 'town-0-capital',
        })];
      const accepted = candidates.find(candidate => !placed.some(existing => frontageSpotsConflict(
        { ...candidate, radius: 90, type: 'house', frontageRouteId: candidate.frontageRouteId ?? selected.routeId },
        existing,
      )));
      if (accepted) placed.push({
        ...accepted,
        radius: 90,
        type: 'house',
        frontageRouteId: accepted.frontageRouteId ?? selected.routeId,
      });
    }
    const usedRoutes = new Set(placed.map(candidate => candidate.frontageRouteId));
    const maximumGap = Math.max(...[...usedRoutes].map(routeId => getMaximumAlongRoadGap(
      placed.filter(candidate => candidate.frontageRouteId === routeId).map(candidate => candidate.frontageAlong),
      1000,
    )));
    return {
      placedCount: placed.length,
      shortageCount: attempts.length - placed.length,
      usedRoadCount: usedRoutes.size,
      maximumGap,
    };
  };

  const phase2A = simulate(false);
  const corrected = simulate(true);
  assert.ok(corrected.placedCount >= phase2A.placedCount);
  assert.ok(corrected.shortageCount <= phase2A.shortageCount);
  assert.ok(corrected.usedRoadCount >= phase2A.usedRoadCount);
  assert.ok(corrected.maximumGap <= phase2A.maximumGap);
  assert.ok(corrected.placedCount > phase2A.placedCount);
  assert.ok(corrected.maximumGap < phase2A.maximumGap);
});

test('road, junction, and bridge surface collision helpers preserve clearance', () => {
  const surface = { x: 0, z: 0, width: 60, length: 200, tangentX: 1, tangentZ: 0 };
  assert.equal(circleIntersectsOrientedSurface(0, 0, 10, surface), true);
  assert.equal(circleIntersectsOrientedSurface(0, 45, 10, surface), false);
  assert.equal(circleIntersectsOrientedSurface(0, 45, 10, surface, 6), true);
  const bridge = { x: 0, z: 0, angle: Math.PI / 2, halfWidth: 30, halfLength: 100 };
  assert.equal(circleIntersectsBridge(0, 0, 10, bridge), true);
  assert.equal(circleIntersectsBridge(0, 45, 10, bridge), false);
  assert.equal(circleIntersectsCircle(0, 0, 20, { x: 35, z: 0, radius: 10 }, 6), true);
  assert.equal(circleIntersectsCircle(0, 0, 20, { x: 36, z: 0, radius: 10 }, 6), false);
});

test('building spacing rejects overlap and short same-road gaps without forbidding opposite sides', () => {
  const first = { x: 0, z: 150, radius: 50, frontageRoadId: 'road-010', frontageAlong: 100 };
  assert.equal(frontageSpotsConflict(
    { x: 100, z: 150, radius: 50, frontageRoadId: 'road-011', frontageAlong: 100 },
    first,
  ), true);
  assert.equal(frontageSpotsConflict(
    { x: 0, z: -150, radius: 50, frontageRoadId: 'road-010', frontageAlong: 200 },
    first,
  ), true);
  assert.equal(frontageSpotsConflict(
    { x: 0, z: -150, radius: 50, frontageRoadId: 'road-010', frontageAlong: 240 },
    first,
  ), false);
});

test('all six towns retain eligible formal frontage roads', () => {
  const townCenters = [
    { x: 0, z: 0, radius: 4860, coreRadius: 2700, type: 'capital' },
    { x: 7500, z: 7500, radius: 3780, coreRadius: 2100, type: 'church_town' },
    { x: -8250, z: 6750, radius: 3780, coreRadius: 2100, type: 'school_town' },
    { x: 7500, z: -7500, radius: 3510, coreRadius: 1950, type: 'residential' },
    { x: -7500, z: -8250, radius: 3510, coreRadius: 1950, type: 'military' },
    { x: 0, z: 11250, radius: 3240, coreRadius: 1800, type: 'suburb' },
  ];
  const hierarchy = buildRoadHierarchy({ townCenters, waterZones: [], exclusionZones: [] });
  for (let townIndex = 0; townIndex < townCenters.length; townIndex++) {
    const town = townCenters[townIndex];
    const townId = `town-${townIndex}-${town.type}`;
    const roads = hierarchy.roads.filter(road => road.townId === townId);
    assert.ok(roads.some(road => road.kind !== ROAD_KINDS.START_APPROACH));
    assert.ok(selectFrontageRoad({ x: town.x, z: town.z, roads, townId }));
  }
});

test('game integration targets only normal town buildings and records bounded shortages', () => {
  assert.match(game, /const frontageBuildingTypes = new Set\(FRONTAGE_BUILDING_TYPES\);/);
  assert.match(game, /frontageBuildingTypes\.has\(spawnType\)/);
  assert.match(game, /townId: frontageTownId/);
  assert.match(game, /circleIntersectsOrientedSurface\(candidate\.x, candidate\.z, newApproxRadius, surface, 8\)/);
  assert.match(game, /circleIntersectsOrientedSurface\(candidate\.x, candidate\.z, newApproxRadius, surface, 12\)/);
  assert.match(game, /circleIntersectsBridge\(candidate\.x, candidate\.z, newApproxRadius, bridge, 20\)/);
  assert.match(game, /frontagePlacementSummary = Object\.freeze\(\{/);
  assert.match(game, /shortageCount: Math\.max\(0, targetCount - placed\)/);
  assert.match(game, /usedRoadCount: usedRoadIds\.size/);
  assert.match(game, /unusedLocalCount:/);
  assert.match(game, /unusedAlleyCount:/);
  assert.match(game, /maximumAlongRoadGap,/);
  assert.match(game, /rejectedCandidateCounts: Object\.freeze/);
  assert.match(game, /Object\.assign\(spawned, frontage\)/);
  assert.match(game, /const targetCount = Math\.round\(\(tc\.coreRadius \* tc\.coreRadius\) \/ 36000\)/);
  assert.match(game, /attempts < targetCount \* 18/);
  assert.deepEqual([2700, 2100, 2100, 1950, 1950, 1800].map(
    coreRadius => Math.round(coreRadius * coreRadius / 36000),
  ), [203, 123, 123, 106, 106, 90]);
  for (const ratioRule of [
    'if (r < 0.60) plannedBuildingType = selectSettlementBuildingType({',
    'if (r < 0.50) plannedBuildingType = selectSettlementBuildingType({',
    'if (r < 0.78) plannedBuildingType = selectSettlementBuildingType({',
    'if (plannedBuildingType) spawnType = plannedBuildingType;',
  ]) assert.ok(game.includes(ratioRule));
  assert.doesNotMatch(game, /frontageBuildingTypes\.add/);

  for (const fixedCall of [
    "spawnEntity('school', tc.x - 400, tc.z, 0);",
    "spawnEntity('church', tc.x + 500, tc.z, Math.PI / 2);",
    "spawnEntity('tower', tc.x, tc.z - 550, 0);",
    "spawnEntity('militaryBase', tc.baseX, tc.baseZ, baseAngle);",
    "spawnEntity('factory', sx, sz, Math.random() * Math.PI * 2);",
  ]) assert.ok(game.includes(fixedCall));
});

test('model-local +Z front features justify zero rotation offsets', () => {
  for (const snippet of [
    'door.position.set(-60, 25, 66)',
    'porchRoof.position.set(0, 60, 78)',
    'tower.position.set(0, 125, 155)',
    'clockFace.position.set(0, 180, 31)',
    'porch.position.set(0, 25, 80)',
  ]) assert.ok(game.includes(snippet));
});

test('Phase 2A adds no forbidden world or progression system', () => {
  const moduleSource = readFileSync(resolve(repoRoot, 'src/building-frontage.js'), 'utf8');
  assert.doesNotMatch(moduleSource, /Math\.random|Terrain|Chunk|Query|Seed|Growth|Threat|Wanted|Perk|LevelUp|Save/i);
  assert.doesNotMatch(moduleSource, /\b(?:Lot|Parcel|Zoning|District|Address|Ownership|Driveway)\b/i);
  execFileSync(process.execPath, ['--check', resolve(repoRoot, 'src/building-frontage.js')], { cwd: repoRoot, stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', gamePath], { cwd: repoRoot, stdio: 'pipe' });
  execFileSync('git', ['diff', '--check'], { cwd: repoRoot, stdio: 'pipe' });
});
