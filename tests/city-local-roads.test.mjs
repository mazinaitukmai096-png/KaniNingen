import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ROAD_KINDS,
  buildRoadHierarchy,
  getRoadKindCounts,
} from '../src/road-town-structure.js';
import { getSettlementTypeForTownType } from '../src/settlement-type.js';
import { getSettlementRoadParameters } from '../src/settlement-road-parameters.js';

const PHASE3A1_COMMIT = '33e0bdcf8b26d654671a7f9f9bf438e206da9ac6';
const repoRoot = resolve(import.meta.dirname, '..');
const capitalTownId = 'town-0-capital';

const legacyTownCenters = [
  { x: 0, z: 0, radius: 4860, coreRadius: 2700, type: 'capital' },
  { x: 7500, z: 7500, radius: 3780, coreRadius: 2100, type: 'church_town' },
  { x: -8250, z: 6750, radius: 3780, coreRadius: 2100, type: 'school_town' },
  { x: 7500, z: -7500, radius: 3510, coreRadius: 1950, type: 'residential' },
  { x: -7500, z: -8250, radius: 3510, coreRadius: 1950, type: 'military' },
  { x: 0, z: 11250, radius: 3240, coreRadius: 1800, type: 'suburb' },
];
const typedTownCenters = legacyTownCenters.map(town => ({
  ...town,
  settlementType: getSettlementTypeForTownType(town.type),
}));
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

const hierarchy = buildRoadHierarchy({
  townCenters: typedTownCenters,
  waterZones,
  exclusionZones,
});
const legacyHierarchy = buildRoadHierarchy({
  townCenters: legacyTownCenters,
  waterZones,
  exclusionZones,
});
const roadsById = new Map(hierarchy.roads.map(road => [road.roadId, road]));
const capitalLocalRoads = hierarchy.roads.filter(road => (
  road.townId === capitalTownId
  && (road.kind === ROAD_KINDS.LOCAL || road.kind === ROAD_KINDS.ALLEY)
));
const capitalRoadIds = new Set(capitalLocalRoads.map(road => road.roadId));

function routesFor(roads) {
  const routes = new Map();
  for (const road of roads) {
    if (!routes.has(road.routeId)) routes.set(road.routeId, []);
    routes.get(road.routeId).push(road);
  }
  for (const route of routes.values()) route.sort((first, second) => first.routeOrder - second.routeOrder);
  return routes;
}

function roadShape(road) {
  return {
    routeId: road.routeId,
    routeOrder: road.routeOrder,
    kind: road.kind,
    townId: road.townId,
    start: road.start,
    end: road.end,
    width: road.width,
    tangentX: road.tangentX,
    tangentZ: road.tangentZ,
    normalX: road.normalX,
    normalZ: road.normalZ,
  };
}

function junctionShape(junction, roadIndex) {
  const attached = junction.roadIds.map(roadId => roadIndex.get(roadId));
  return {
    type: junction.type,
    x: junction.x,
    z: junction.z,
    width: junction.width,
    degree: junction.degree,
    isHub: junction.isHub,
    routeIds: attached.map(road => road.routeId).sort(),
  };
}

test('only the capital CITY consumes the Phase 3A-1 LOCAL and ALLEY parameters', () => {
  const city = getSettlementRoadParameters('CITY');
  assert.equal(typedTownCenters.filter(town => town.settlementType === 'CITY').length, 1);
  assert.equal(typedTownCenters[0].type, 'capital');

  for (const road of capitalLocalRoads) {
    assert.equal(road.width, road.kind === ROAD_KINDS.LOCAL ? city.localWidth : city.alleyWidth);
    assert.equal(road.sampleSpacing, city.sampleSpacing);
    assert.equal(road.roadPattern, city.roadPattern);
    assert.equal(road.roadSurfaceOverlap, city.roadSurfaceOverlap);
  }
  for (const road of hierarchy.roads.filter(road => road.townId !== capitalTownId)) {
    if (road.kind === ROAD_KINDS.LOCAL) assert.equal(road.width, 64);
    if (road.kind === ROAD_KINDS.ALLEY) assert.equal(road.width, 44);
  }
});

test('Capital generates exactly two LOCAL spines, six LOCAL branches, and two ALLEY routes', () => {
  const routes = routesFor(capitalLocalRoads);
  const spineRoutes = [...routes].filter(([routeId]) => routeId.includes('-spine-'));
  const branchRoutes = [...routes].filter(([routeId]) => routeId.includes('-branch-'));
  const connectorRoutes = [...routes].filter(([routeId]) => routeId.includes('-major-connector-'));
  const alleyRoutes = [...routes].filter(([, roads]) => roads[0].kind === ROAD_KINDS.ALLEY);

  assert.equal(spineRoutes.length, 2);
  assert.equal(branchRoutes.length, 6);
  assert.equal(connectorRoutes.length, 3);
  assert.equal(alleyRoutes.length, 2);
  assert.equal(capitalLocalRoads.filter(road => road.kind === ROAD_KINDS.LOCAL).length, 43);
  assert.equal(capitalLocalRoads.filter(road => road.kind === ROAD_KINDS.ALLEY).length, 6);
  assert.equal(hierarchy.omittedRoutes.filter(route => route.routeId.includes(capitalTownId)).length, 0);
  for (const [, roads] of connectorRoutes) {
    const length = roads.reduce((total, road) => (
      total + Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z)
    ), 0);
    assert.ok(length <= getSettlementRoadParameters('CITY').localWidth * 6);
  }
});

test('Capital grid is deterministic, orthogonal, and remains within the ten-degree visual tolerance', () => {
  const main = capitalLocalRoads.find(road => road.routeId === `local-${capitalTownId}-spine-0`);
  const secondary = capitalLocalRoads.find(road => road.routeId === `local-${capitalTownId}-spine-1`);
  assert.ok(main);
  assert.ok(secondary);
  assert.ok(Math.abs(main.tangentX) < 1e-12 && Math.abs(Math.abs(main.tangentZ) - 1) < 1e-12);
  assert.ok(Math.abs(secondary.tangentZ) < 1e-12 && Math.abs(Math.abs(secondary.tangentX) - 1) < 1e-12);
  const cross = { x: -main.tangentZ, z: main.tangentX };
  let maximumDeviation = 0;

  for (const road of capitalLocalRoads.filter(road => !road.routeId.includes('-major-connector-'))) {
    const mainDot = Math.abs(road.tangentX * main.tangentX + road.tangentZ * main.tangentZ);
    const crossDot = Math.abs(road.tangentX * cross.x + road.tangentZ * cross.z);
    const angle = Math.acos(Math.max(-1, Math.min(1, Math.max(mainDot, crossDot)))) * 180 / Math.PI;
    maximumDeviation = Math.max(maximumDeviation, angle);
  }
  assert.ok(maximumDeviation <= 10, `maximum grid deviation: ${maximumDeviation}`);

  const repeated = buildRoadHierarchy({
    townCenters: structuredClone(typedTownCenters),
    waterZones: structuredClone(waterZones),
    exclusionZones: structuredClone(exclusionZones),
  });
  assert.deepEqual(repeated.roads.map(roadShape), hierarchy.roads.map(roadShape));
});

test('Capital uses bounded T junctions plus one explicit degree-four CITY HUB', () => {
  const capitalJunctions = hierarchy.junctions.filter(junction => (
    junction.roadIds.some(roadId => capitalRoadIds.has(roadId))
  ));
  const hubs = capitalJunctions.filter(junction => junction.isHub);
  assert.equal(hubs.length, 1);
  assert.equal(hubs[0].type, 'HUB');
  assert.equal(hubs[0].degree, 4);

  for (const junction of capitalJunctions.filter(junction => !junction.isHub)) {
    if (junction.type === 'CONNECTOR') assert.equal(junction.degree, 2);
    else {
      assert.equal(junction.type, 'T');
      assert.equal(junction.degree, 3);
    }
  }
  for (let firstIndex = 0; firstIndex < capitalJunctions.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < capitalJunctions.length; secondIndex++) {
      const first = capitalJunctions[firstIndex];
      const second = capitalJunctions[secondIndex];
      const distance = Math.hypot(first.x - second.x, first.z - second.z);
      assert.ok(distance + 1 >= Math.max(first.width, second.width) * 1.5);
    }
  }
});

test('Capital LOCAL and ALLEY branches connect within the preferred CITY angle range', () => {
  const city = getSettlementRoadParameters('CITY');
  const branchJunctions = hierarchy.junctions.filter(junction => {
    const parent = roadsById.get(junction.parentRoadId);
    const child = roadsById.get(junction.childRoadId);
    return junction.type === 'T'
      && parent?.townId === capitalTownId
      && child?.townId === capitalTownId
      && parent.kind === ROAD_KINDS.LOCAL
      && (child.routeId.includes('-branch-') || child.kind === ROAD_KINDS.ALLEY);
  });
  assert.equal(branchJunctions.length, 8);
  for (const junction of branchJunctions) {
    const parent = roadsById.get(junction.parentRoadId);
    const child = roadsById.get(junction.childRoadId);
    const dot = Math.abs(parent.tangentX * child.tangentX + parent.tangentZ * child.tangentZ);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
    assert.ok(angle >= city.preferredBranchAngleMin && angle <= city.preferredBranchAngleMax, `${junction.junctionId}: ${angle}`);
  }
});

test('Capital segments, samples, road surfaces, and junction surfaces retain valid CITY widths', () => {
  const capitalSurfaces = hierarchy.roadSurfaces.filter(surface => capitalRoadIds.has(surface.roadId));
  const capitalSamples = hierarchy.pathSamples.filter(sample => capitalRoadIds.has(sample.roadId));
  assert.equal(capitalSurfaces.length, 49);
  assert.equal(capitalSamples.length, 214);

  for (const road of capitalLocalRoads) {
    assert.ok(Number.isFinite(road.start.x) && Number.isFinite(road.start.z));
    assert.ok(Number.isFinite(road.end.x) && Number.isFinite(road.end.z));
    assert.ok(Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z) > 0);
  }
  for (const sample of capitalSamples) {
    assert.equal(sample.width, roadsById.get(sample.roadId).width);
    assert.ok(Number.isFinite(sample.tangentX) && Number.isFinite(sample.normalX));
  }
  for (const surface of capitalSurfaces) {
    assert.equal(surface.width, roadsById.get(surface.roadId).width);
    assert.ok(surface.length > 0 && Number.isFinite(surface.length));
  }
  for (const surface of hierarchy.junctionSurfaces) {
    const junction = hierarchy.junctions.find(candidate => candidate.junctionId === surface.junctionId);
    if (!junction?.roadIds.some(roadId => capitalRoadIds.has(roadId))) continue;
    assert.ok(surface.width <= junction.width);
    assert.ok(surface.length > 0);
  }
});

test('Capital LOCAL and ALLEY routes avoid water and protected exclusions', () => {
  const capitalSamples = hierarchy.allPathSamples.filter(sample => capitalRoadIds.has(sample.roadId));
  assert.ok(capitalSamples.length > 0);
  assert.ok(capitalSamples.every(sample => !sample.isWater && !sample.isBlocked));
});

test('MAJOR, START_APPROACH, Bridge, and all non-Capital roads remain exact legacy fixtures', () => {
  const fixedRoad = road => (
    road.kind === ROAD_KINDS.MAJOR
    || road.kind === ROAD_KINDS.START_APPROACH
    || road.townId !== capitalTownId
  );
  assert.deepEqual(
    hierarchy.roads.filter(fixedRoad).map(roadShape),
    legacyHierarchy.roads.filter(fixedRoad).map(roadShape),
  );

  const bridgeShape = bridge => ({
    routeId: bridge.routeId,
    kind: bridge.kind,
    start: bridge.start,
    end: bridge.end,
    width: bridge.width,
    tangentX: bridge.tangentX,
    tangentZ: bridge.tangentZ,
  });
  assert.deepEqual(hierarchy.bridgeSpans.map(bridgeShape), legacyHierarchy.bridgeSpans.map(bridgeShape));
  assert.equal(getRoadKindCounts(hierarchy.roads).MAJOR, 45);
  assert.equal(getRoadKindCounts(hierarchy.roads).START_APPROACH, 6);
});

test('TOWN and RURAL junction topology remains identical to the Phase 1 fixture', () => {
  const legacyRoadsById = new Map(legacyHierarchy.roads.map(road => [road.roadId, road]));
  const fixedJunction = (junction, roadIndex) => junction.roadIds
    .map(roadId => roadIndex.get(roadId))
    .every(road => road.townId !== capitalTownId);
  assert.deepEqual(
    hierarchy.junctions.filter(junction => fixedJunction(junction, roadsById)).map(junction => junctionShape(junction, roadsById)),
    legacyHierarchy.junctions
      .filter(junction => fixedJunction(junction, legacyRoadsById))
      .map(junction => junctionShape(junction, legacyRoadsById)),
  );
});

test('building, Frontage, Lot, world detail, and Gameplay source remain at Phase 3A-1', () => {
  for (const path of [
    'src/game.js',
    'src/building-frontage.js',
    'src/building-lot.js',
    'src/world-scale-rebalance.js',
    'src/settlement-type.js',
  ]) {
    const current = readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
    const baseline = execFileSync('git', ['show', `${PHASE3A1_COMMIT}:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).replace(/\r\n/g, '\n');
    assert.equal(current, baseline, path);
  }
});

test('CITY connection adds no random, Seed, Terrain, Chunk, Query, Growth, Threat, or Wanted system', () => {
  const source = readFileSync(resolve(repoRoot, 'src/road-town-structure.js'), 'utf8');
  assert.doesNotMatch(source, /Math\.random\s*\(/);
  assert.doesNotMatch(source, /\b(seed|terrain|chunk|query|growth|threat|wanted|worldstate)\b/i);
});
