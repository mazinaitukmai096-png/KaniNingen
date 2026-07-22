import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CAPITAL_CIVIC_CORE_DIMENSIONS,
  circleIntersectsCapitalCivicCore,
  createCapitalCivicCore,
  isPointInCapitalCivicCore,
  segmentIntersectsCapitalCivicCore,
} from '../src/capital-civic-core.js';
import { ROAD_KINDS, buildRoadHierarchy } from '../src/road-town-structure.js';
import { getSettlementTypeForTownType } from '../src/settlement-type.js';
import {
  getWorldDetailCounts,
  getWorldDetailInstanceCount,
} from '../src/world-scale-rebalance.js';

const repoRoot = resolve(import.meta.dirname, '..');
const capitalTownId = 'town-0-capital';
const townCenters = [
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
  { x: -400, z: 0, radius: 145 },
  { x: 500, z: 0, radius: 115 },
  { x: 0, z: -550, radius: 65 },
  { x: 7500, z: 7500, radius: 115 },
  { x: 7100, z: 7800, radius: 65 },
  { x: -8250, z: 6750, radius: 145 },
  { x: -7500, z: -8250, radius: 65 },
  { x: 0, z: 11250, radius: 115 },
];
const hierarchy = buildRoadHierarchy({ townCenters, waterZones, exclusionZones });
const capitalRoads = hierarchy.roads.filter(road => road.townId === capitalTownId);
const capitalRoadIds = new Set(capitalRoads.map(road => road.roadId));

function routesFor(roads) {
  const routes = new Map();
  for (const road of roads) {
    if (!routes.has(road.routeId)) routes.set(road.routeId, []);
    routes.get(road.routeId).push(road);
  }
  for (const route of routes.values()) route.sort((first, second) => first.routeOrder - second.routeOrder);
  return routes;
}

function pointInTriangle(point, first, second, third) {
  const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const firstSign = cross(first, second, point);
  const secondSign = cross(second, third, point);
  const thirdSign = cross(third, first, point);
  return (firstSign >= -1e-9 && secondSign >= -1e-9 && thirdSign >= -1e-9)
    || (firstSign <= 1e-9 && secondSign <= 1e-9 && thirdSign <= 1e-9);
}

test('Capital Civic Core is a finite Capital-only 520 by 420 contract', () => {
  assert.deepEqual(CAPITAL_CIVIC_CORE_DIMENSIONS, {
    halfWidth: 260,
    halfDepth: 210,
    rotationY: 0,
    clearance: 18,
    accessSide: 'SOUTH',
  });
  assert.deepEqual(hierarchy.capitalCivicCore, {
    centerX: 0,
    centerZ: 0,
    halfWidth: 260,
    halfDepth: 210,
    rotationY: 0,
    clearance: 18,
    accessSide: 'SOUTH',
    accessRoadId: hierarchy.capitalTopology.civicAccessRoadId,
  });
  for (const value of Object.values(hierarchy.capitalCivicCore).filter(value => typeof value === 'number')) {
    assert.equal(Number.isFinite(value), true);
  }
  assert.throws(
    () => createCapitalCivicCore({ x: 0, z: 0, type: 'church_town' }),
    /only be created for the capital/,
  );
  const untyped = buildRoadHierarchy({
    townCenters: townCenters.map(({ settlementType, ...town }) => town),
    waterZones,
    exclusionZones,
  });
  assert.equal(untyped.capitalCivicCore, null);
});

test('only one short LOCAL Civic Access reaches the Core boundary', () => {
  const accessRoads = capitalRoads.filter(road => road.isCivicAccess);
  assert.equal(accessRoads.length, 1);
  const access = accessRoads[0];
  assert.equal(access.kind, ROAD_KINDS.LOCAL);
  assert.equal(access.width, 32);
  assert.ok(access.width <= 74);
  assert.equal(access.routeId, 'local-town-0-capital-civic-access');
  assert.equal(access.roadId, hierarchy.capitalCivicCore.accessRoadId);
  assert.equal(access.parentRoadId, hierarchy.capitalTopology.ports.find(port => (
    port.otherTownType === 'residential'
  )).roadId);
  assert.equal(Math.hypot(access.end.x - access.start.x, access.end.z - access.start.z), 47);
  assert.deepEqual(access.end, { x: 0, z: -210 });
  assert.equal(isPointInCapitalCivicCore(access.end.x, access.end.z, hierarchy.capitalCivicCore), true);
  assert.equal(capitalRoads.some(road => road.isCivicAccess && road.kind !== ROAD_KINDS.LOCAL), false);
});

test('normal roads, Junctions, branches, and alleys stay outside the Core', () => {
  const normalCoreRoads = capitalRoads.filter(road => (
    !road.isCivicAccess
    && segmentIntersectsCapitalCivicCore(
      road.start,
      road.end,
      road.width,
      hierarchy.capitalCivicCore,
    )
  ));
  assert.deepEqual(normalCoreRoads, []);
  assert.equal(hierarchy.capitalCivicCoreSummary.normalCoreRoadCount, 0);
  assert.equal(hierarchy.capitalCivicCoreSummary.coreInternalJunctionCount, 0);
  assert.equal(hierarchy.junctions.some(junction => (
    isPointInCapitalCivicCore(junction.x, junction.z, hierarchy.capitalCivicCore)
  )), false);
  for (const road of capitalRoads.filter(road => (
    road.routeId.includes('-branch-') || road.kind === ROAD_KINDS.ALLEY
  ))) {
    assert.equal(segmentIntersectsCapitalCivicCore(
      road.start,
      road.end,
      road.width,
      hierarchy.capitalCivicCore,
    ), false, road.routeId);
  }
});

test('three deterministic MAJOR ports stay outside the Core with at least 180 spacing', () => {
  const ports = hierarchy.capitalTopology.ports;
  assert.equal(ports.length, 3);
  assert.deepEqual(ports.map(port => [port.otherTownType, port.x, port.z]), [
    ['church_town', 700, 280],
    ['school_town', -360, -257],
    ['residential', 0, -257],
  ]);
  assert.equal(hierarchy.capitalCivicCoreSummary.minimumPortSpacing, 360);
  for (let firstIndex = 0; firstIndex < ports.length; firstIndex++) {
    assert.equal(isPointInCapitalCivicCore(ports[firstIndex].x, ports[firstIndex].z, hierarchy.capitalCivicCore), false);
    for (let secondIndex = firstIndex + 1; secondIndex < ports.length; secondIndex++) {
      assert.ok(Math.hypot(
        ports[firstIndex].x - ports[secondIndex].x,
        ports[firstIndex].z - ports[secondIndex].z,
      ) >= 180);
    }
  }
  const majorRoutes = routesFor(hierarchy.roads.filter(road => road.kind === ROAD_KINDS.MAJOR));
  assert.equal(majorRoutes.size, 5);
  assert.equal([...majorRoutes.keys()].filter(routeId => routeId.includes(capitalTownId)).length, 3);
  for (const port of ports) {
    const firstRoad = hierarchy.roads.find(road => road.roadId === port.roadId);
    assert.ok(firstRoad);
    assert.ok(firstRoad.tangentX * port.outwardX + firstRoad.tangentZ * port.outwardZ > 0.999999);
  }
});

test('the Capital collector is a minimal L with one degree-four boundary hub', () => {
  const collector = capitalRoads.filter(road => road.isCapitalCollector);
  assert.equal(hierarchy.capitalTopology.collectorShape, 'L');
  assert.equal(hierarchy.capitalTopology.collectorStraightLegCount, 2);
  assert.equal(collector.length, 3);
  assert.equal(collector.every(road => road.width === 74), true);
  assert.equal(collector.every(road => !segmentIntersectsCapitalCivicCore(
    road.start,
    road.end,
    road.width,
    hierarchy.capitalCivicCore,
  )), true);
  const hub = hierarchy.junctions.find(junction => junction.junctionId === hierarchy.capitalTopology.mainHubId);
  assert.ok(hub);
  assert.equal(hub.type, 'HUB');
  assert.equal(hub.isHub, true);
  assert.equal(hub.degree, 4);
  assert.deepEqual([hub.x, hub.z], [0, -257]);
  assert.equal(hierarchy.junctions.filter(junction => junction.isHub).length, 1);
  assert.equal(hierarchy.capitalCivicCoreSummary.junctionCountWithin150, 0);
  assert.equal(hierarchy.capitalCivicCoreSummary.junctionCountWithin300, 1);
});

test('two spines, six branches, and two outward alleys originate away from the Civic Access', () => {
  const routes = routesFor(capitalRoads.filter(road => (
    road.kind === ROAD_KINDS.LOCAL || road.kind === ROAD_KINDS.ALLEY
  )));
  const spines = [...routes].filter(([routeId]) => routeId.includes('-spine-'));
  const branches = [...routes].filter(([routeId]) => routeId.includes('-branch-'));
  const alleys = [...routes].filter(([, roads]) => roads[0].kind === ROAD_KINDS.ALLEY);
  assert.equal(spines.length, 2);
  assert.equal(branches.length, 6);
  assert.equal(alleys.length, 2);
  assert.notDeepEqual(spines[0][1][0].start, spines[1][1][0].start);
  const roadsById = new Map(hierarchy.roads.map(road => [road.roadId, road]));
  for (const [, roads] of branches) {
    const parent = roadsById.get(roads[0].parentRoadId);
    assert.ok(parent?.isTownSpine);
    assert.equal(parent?.isCivicAccess, false);
  }
  for (const [, roads] of alleys) {
    const parent = roadsById.get(roads[0].parentRoadId);
    assert.match(parent.routeId, /-branch-/);
    const startDistance = Math.hypot(roads[0].start.x, roads[0].start.z);
    const end = roads.at(-1).end;
    assert.ok(Math.hypot(end.x, end.z) > startDistance);
  }
  assert.equal(hierarchy.capitalTopology.branchGenerated, 6);
  assert.equal(hierarchy.capitalTopology.alleyGenerated, 2);
  assert.equal(hierarchy.omittedRoutes.some(route => route.routeId.includes(capitalTownId)), false);
});

test('the main junction union has continuous, bounded, non-degenerate geometry', () => {
  const surface = hierarchy.junctionSurfaces.find(candidate => (
    candidate.junctionId === hierarchy.capitalTopology.mainHubId
  ));
  assert.equal(surface.shape, 'ATTACHED_ROAD_UNION');
  assert.equal(surface.sourceRoadIds.length, 4);
  assert.equal(surface.patches.length, 4);
  assert.equal(surface.width, 90);
  assert.equal(surface.length, 82);
  assert.ok(surface.width <= surface.maxRoadWidth);
  assert.ok(surface.length <= surface.maxRoadWidth);
  for (const triangle of surface.triangles) {
    const [first, second, third] = triangle.map(index => surface.vertices[index]);
    const twiceArea = Math.abs(
      (second.x - first.x) * (third.z - first.z)
      - (second.z - first.z) * (third.x - first.x)
    );
    assert.ok(twiceArea > 1e-8);
    const longestEdgeSquared = Math.max(
      (second.x - first.x) ** 2 + (second.z - first.z) ** 2,
      (third.x - second.x) ** 2 + (third.z - second.z) ** 2,
      (first.x - third.x) ** 2 + (first.z - third.z) ** 2,
    );
    assert.ok(longestEdgeSquared / twiceArea < 6);
  }
  for (const patch of surface.patches) {
    const midpoint = { x: (patch.minX + patch.maxX) / 2, z: (patch.minZ + patch.maxZ) / 2 };
    assert.equal(surface.triangles.some(triangle => pointInTriangle(
      midpoint,
      ...triangle.map(index => surface.vertices[index]),
    )), true, patch.roadId);
  }
  assert.equal(hierarchy.capitalCivicCoreSummary.mainJunctionMinimumTwiceArea, 64);
  assert.ok(hierarchy.capitalCivicCoreSummary.mainJunctionMaximumNeedleRatio < 6);
});

test('special hub roads stop at the union boundary without long overlap or a gap', () => {
  const hub = hierarchy.junctions.find(junction => junction.junctionId === hierarchy.capitalTopology.mainHubId);
  for (const roadId of hub.roadIds) {
    const road = hierarchy.roads.find(candidate => candidate.roadId === roadId);
    const surface = hierarchy.roadSurfaces.find(candidate => candidate.roadId === roadId);
    assert.ok(surface, roadId);
    const roadStartsAtHub = Math.hypot(road.start.x - hub.x, road.start.z - hub.z) < 1e-8;
    const boundaryPoint = roadStartsAtHub ? surface.start : surface.end;
    assert.ok(Math.abs(Math.hypot(boundaryPoint.x - hub.x, boundaryPoint.z - hub.z) - road.width / 2) < 1e-8);
  }
});

test('building target, park, Lot, street object, and vegetation Core guards are integrated', () => {
  const game = readFileSync(resolve(repoRoot, 'src/game.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(game, /const targetCount = Math\.round\(\(tc\.coreRadius \* tc\.coreRadius\) \/ 36000\)/);
  assert.equal(Math.round((2700 * 2700) / 36000), 203);
  assert.match(game, /parkCandidateIndex < 8/);
  assert.match(game, /tc\.type === 'capital' && circleIntersectsCapitalCivicCore/);
  assert.match(game, /civicCoreCollision: 0/);
  assert.match(game, /orientedRectanglesOverlap\(lot, civicCoreRectangle, civicCore\.clearance\)/);
  assert.match(game, /WORLD_DETAIL_INTERACTION_RADII\[detailType\]/);
  assert.match(game, /capitalCivicCoreVegetationRejectedCount\+\+/);
  assert.match(game, /scene\.userData\.capitalCivicCoreWorldDetailSummary/);
  assert.match(game, /scene\.userData\.capitalCivicCoreVegetationSummary/);
  assert.equal(Object.values(getWorldDetailCounts(6, 2)).reduce((total, count) => total + count, 0), 96);
  assert.equal(getWorldDetailInstanceCount(6, 2), 258);
  assert.doesNotMatch(game, /from '\.\/civic-space\.js'/);
});

test('Frontage, Lot, visuals, gameplay constants, and unrelated modules remain byte-identical to HEAD', () => {
  for (const path of [
    'src/building-frontage.js',
    'src/building-lot.js',
    'src/settlement-building-visuals.js',
    'src/world-scale-rebalance.js',
    'src/scale-sandbox.js',
    'src/constants.js',
    'src/core/input.js',
    'src/core/renderer.js',
  ]) {
    const current = readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
    const baseline = execFileSync('git', ['show', `HEAD:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).replace(/\r\n/g, '\n');
    assert.equal(current, baseline, path);
  }
});

test('Capital topology is deterministic and adds no random, Seed, Terrain, or progression dependency', () => {
  const repeated = buildRoadHierarchy({
    townCenters: structuredClone(townCenters),
    waterZones: structuredClone(waterZones),
    exclusionZones: structuredClone(exclusionZones),
  });
  assert.deepEqual(repeated, hierarchy);
  const coreSource = readFileSync(resolve(repoRoot, 'src/capital-civic-core.js'), 'utf8');
  const roadSource = readFileSync(resolve(repoRoot, 'src/road-town-structure.js'), 'utf8');
  assert.doesNotMatch(coreSource, /Math\.random|\bseed\b|terrain|chunk|query|growth|threat|wanted|perk/i);
  assert.doesNotMatch(roadSource, /Math\.random|\bseed\b|terrain|chunk|query|growth|threat|wanted|perk/i);
});
