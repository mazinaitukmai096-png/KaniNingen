import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createFrontagePlacement } from '../src/building-frontage.js';
import {
  BUILDING_LOT_PROFILES,
  createBuildingLot,
  orientedRectanglesOverlap,
  roadSurfaceToRectangle,
} from '../src/building-lot.js';
import { ROAD_KINDS, buildRoadHierarchy } from '../src/road-town-structure.js';
import { getSettlementRoadParameters } from '../src/settlement-road-parameters.js';
import { getSettlementTypeForTownType } from '../src/settlement-type.js';

const PHASE3A2A_COMMIT = 'ed4845d748db6c043512504f71b9c031d44af921';
const repoRoot = resolve(import.meta.dirname, '..');
const townIds = Object.freeze([
  'town-1-church_town',
  'town-2-school_town',
]);
const ruralTownIds = new Set([
  'town-3-residential',
  'town-4-military',
  'town-5-suburb',
]);
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

const createHierarchy = townCenters => buildRoadHierarchy({
  townCenters,
  waterZones,
  exclusionZones,
});
const hierarchy = createHierarchy(typedTownCenters);
const legacyHierarchy = createHierarchy(legacyTownCenters);
const roadsById = new Map(hierarchy.roads.map(road => [road.roadId, road]));

function townRoads(hierarchyValue, townId) {
  return hierarchyValue.roads.filter(road => (
    road.townId === townId
    && (road.kind === ROAD_KINDS.LOCAL || road.kind === ROAD_KINDS.ALLEY)
  ));
}

function routesFor(roads) {
  const routes = new Map();
  for (const road of roads) {
    if (!routes.has(road.routeId)) routes.set(road.routeId, []);
    routes.get(road.routeId).push(road);
  }
  for (const route of routes.values()) route.sort((first, second) => first.routeOrder - second.routeOrder);
  return routes;
}

function semanticRoadShape(road) {
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
    isTownSpine: road.isTownSpine,
  };
}

function undirectedAngle(first, second) {
  const dot = Math.abs(first.x * second.x + first.z * second.z);
  return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

function routeAxis(route) {
  const directionX = route.at(-1).end.x - route[0].start.x;
  const directionZ = route.at(-1).end.z - route[0].start.z;
  const length = Math.hypot(directionX, directionZ);
  return { x: directionX / length, z: directionZ / length };
}

function signedUndirectedOffset(first, second) {
  let difference = (Math.atan2(first.x, first.z) - Math.atan2(second.x, second.z)) * 180 / Math.PI;
  while (difference > 90) difference -= 180;
  while (difference < -90) difference += 180;
  return difference;
}

test('only church_town and school_town consume the TOWN LOCAL and ALLEY contract', () => {
  const parameters = getSettlementRoadParameters('TOWN');
  for (const townId of townIds) {
    for (const road of townRoads(hierarchy, townId)) {
      assert.equal(road.width, road.kind === ROAD_KINDS.LOCAL ? 66 : 45);
      assert.equal(road.sampleSpacing, parameters.sampleSpacing);
      assert.equal(road.roadPattern, 'SEMI_GRID');
      assert.equal(road.roadSurfaceOverlap, 0);
    }
  }
  for (const road of hierarchy.roads.filter(road => ruralTownIds.has(road.townId))) {
    if (road.kind === ROAD_KINDS.LOCAL) assert.equal(road.width, 64);
    if (road.kind === ROAD_KINDS.ALLEY) assert.equal(road.width, 44);
    assert.notEqual(road.roadPattern, 'SEMI_GRID');
  }
  for (const road of hierarchy.roads.filter(road => road.townId === capitalTownId)) {
    if (road.kind === ROAD_KINDS.LOCAL) assert.equal(road.width, 74);
    if (road.kind === ROAD_KINDS.ALLEY) assert.equal(road.width, 48);
    assert.notEqual(road.roadPattern, 'SEMI_GRID');
  }
});

test('each TOWN targets one spine, five branches, and one alley with explicit omission reasons', () => {
  for (const townId of townIds) {
    const routes = routesFor(townRoads(hierarchy, townId));
    assert.equal([...routes.keys()].filter(routeId => routeId.includes('-spine-')).length, 1);
    assert.ok([...routes.keys()].filter(routeId => routeId.includes('-branch-')).length > 0);
    assert.equal([...routes.values()].filter(route => route[0].kind === ROAD_KINDS.ALLEY).length, 1);
    assert.equal([...routes.keys()].filter(routeId => routeId.includes('-major-connector-')).length, 2);
    for (const [routeId, route] of routes) {
      const length = route.reduce((total, road) => (
        total + Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z)
      ), 0);
      if (routeId.includes('-major-connector-')) assert.ok(length >= 66 * 2);
      if (route[0].kind === ROAD_KINDS.ALLEY) assert.ok(length >= 45 * 3);
    }
    const branchActual = [...routes.keys()].filter(routeId => routeId.includes('-branch-')).length;
    const branchOmitted = hierarchy.omittedRoutes.filter(route => (
      route.routeId.includes(townId) && route.routeId.includes('-branch-')
    ));
    assert.equal(branchActual + branchOmitted.length, 5);
    assert.ok(branchOmitted.every(route => typeof route.reason === 'string' && route.reason.length > 0));
  }
});

test('TOWN spines use distinct deterministic plus-eight and minus-eight degree semi-grid axes', () => {
  const expectedMagnitudes = new Map([
    ['town-1-church_town', 8],
    ['town-2-school_town', 8],
  ]);
  const expectedSignedOffsets = new Map([
    ['town-1-church_town', 8],
    ['town-2-school_town', -8],
  ]);
  const axes = [];
  for (const townId of townIds) {
    const currentSpine = routesFor(townRoads(hierarchy, townId)).get(`local-${townId}-spine-0`);
    const legacySpine = routesFor(townRoads(legacyHierarchy, townId)).get(`local-${townId}-spine`);
    const currentAxis = routeAxis(currentSpine);
    const legacyAxis = routeAxis(legacySpine);
    assert.ok(Math.abs(undirectedAngle(currentAxis, legacyAxis) - expectedMagnitudes.get(townId)) < 1e-9);
    assert.ok(Math.abs(signedUndirectedOffset(currentAxis, legacyAxis) - expectedSignedOffsets.get(townId)) < 1e-9);
    axes.push(currentAxis);
  }
  assert.ok(undirectedAngle(axes[0], axes[1]) > 20);
});

test('TOWN branches stay in hard angle bounds and generated LOCAL branches remain preferred', () => {
  const parameters = getSettlementRoadParameters('TOWN');
  for (const townId of townIds) {
    const roadIds = new Set(townRoads(hierarchy, townId).map(road => road.roadId));
    const junctions = hierarchy.junctions.filter(junction => (
      junction.roadIds.some(roadId => roadIds.has(roadId)) && junction.type === 'T'
    ));
    for (const junction of junctions) {
      const parent = roadsById.get(junction.parentRoadId);
      const child = roadsById.get(junction.childRoadId);
      if (!parent || !child || !child.routeId.includes('-branch-')) continue;
      const angle = undirectedAngle(
        { x: parent.tangentX, z: parent.tangentZ },
        { x: child.tangentX, z: child.tangentZ },
      );
      assert.ok(angle >= parameters.hardBranchAngleMin && angle <= parameters.hardBranchAngleMax);
      assert.ok(angle >= parameters.preferredBranchAngleMin && angle <= parameters.preferredBranchAngleMax);
    }
  }
});

test('TOWN curves use formal metadata and a single gentle arc without random-walk waves', () => {
  const parameters = getSettlementRoadParameters('TOWN');
  for (const townId of townIds) {
    const routes = routesFor(townRoads(hierarchy, townId));
    for (const route of routes.values()) {
      for (const road of route) {
        assert.equal(road.curvature, road.kind === ROAD_KINDS.LOCAL
          ? parameters.localCurvature
          : parameters.alleyCurvature);
      }
    }
    const spine = routes.get(`local-${townId}-spine-0`);
    const turnSigns = new Set();
    let maximumTurn = 0;
    for (let index = 1; index < spine.length; index++) {
      const previous = spine[index - 1];
      const current = spine[index];
      const cross = previous.tangentX * current.tangentZ - previous.tangentZ * current.tangentX;
      if (Math.abs(cross) > 1e-9) turnSigns.add(Math.sign(cross));
      maximumTurn = Math.max(maximumTurn, undirectedAngle(
        { x: previous.tangentX, z: previous.tangentZ },
        { x: current.tangentX, z: current.tangentZ },
      ));
    }
    assert.ok(turnSigns.size <= 1);
    assert.ok(maximumTurn < 12);
  }
  const source = readFileSync(resolve(repoRoot, 'src/road-town-structure.js'), 'utf8');
  assert.doesNotMatch(source, /Math\.random\s*\(/);
  assert.doesNotMatch(source, /\bseed\b/i);
});

test('TOWN junctions stay degree three or lower with expanded generated-junction spacing', () => {
  const minimumGeneratedSpacing = 66 * 1.5 * 1.10;
  for (const townId of townIds) {
    const roadIds = new Set(townRoads(hierarchy, townId).map(road => road.roadId));
    const junctions = hierarchy.junctions.filter(junction => junction.roadIds.some(roadId => roadIds.has(roadId)));
    assert.ok(junctions.every(junction => junction.degree <= 3 && !junction.isHub));
    const generated = junctions.filter(junction => junction.type !== 'CONNECTOR');
    for (let firstIndex = 0; firstIndex < generated.length; firstIndex++) {
      for (let secondIndex = firstIndex + 1; secondIndex < generated.length; secondIndex++) {
        const first = generated[firstIndex];
        const second = generated[secondIndex];
        const bothMajorPorts = first.width === 90 && second.width === 90;
        if (bothMajorPorts) continue;
        assert.ok(Math.hypot(first.x - second.x, first.z - second.z) >= minimumGeneratedSpacing - 1e-9);
      }
    }
  }
});

test('TOWN segments, samples, surfaces, and junction surfaces are finite and width-consistent', () => {
  for (const townId of townIds) {
    const roads = townRoads(hierarchy, townId);
    const roadIds = new Set(roads.map(road => road.roadId));
    for (const road of roads) {
      const length = Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z);
      assert.ok(Number.isFinite(length) && length > 1);
    }
    const samples = hierarchy.allPathSamples.filter(sample => roadIds.has(sample.roadId));
    assert.ok(samples.length > 0);
    assert.ok(samples.every(sample => (
      Number.isFinite(sample.x) && Number.isFinite(sample.z) && sample.length > 0
      && sample.width === roadsById.get(sample.roadId).width
      && Math.abs(Math.hypot(sample.tangentX, sample.tangentZ) - 1) < 1e-9
      && Math.abs(Math.hypot(sample.normalX, sample.normalZ) - 1) < 1e-9
      && Math.abs(sample.tangentX * sample.normalX + sample.tangentZ * sample.normalZ) < 1e-9
      && !sample.isWater && !sample.isBlocked
    )));
    const surfaces = hierarchy.roadSurfaces.filter(surface => roadIds.has(surface.roadId));
    assert.ok(surfaces.length > 0);
    assert.ok(surfaces.every(surface => surface.width === roadsById.get(surface.roadId).width));
    for (const surface of hierarchy.junctionSurfaces) {
      const junction = hierarchy.junctions.find(candidate => candidate.junctionId === surface.junctionId);
      if (!junction?.roadIds.some(roadId => roadIds.has(roadId))) continue;
      const parent = roadsById.get(junction.parentRoadId);
      const child = roadsById.get(junction.childRoadId);
      const connected = junction.roadIds.map(roadId => roadsById.get(roadId));
      assert.equal(surface.width, parent.width);
      assert.equal(surface.length, Math.min(parent.width, child.width));
      assert.equal(surface.maxRoadWidth, Math.max(...connected.map(road => road.width)));
    }
  }
});

test('TOWN frontage and Lot references resolve to real roads without placing the fixture building on its road', () => {
  for (const townId of townIds) {
    const sample = hierarchy.pathSamples.find(candidate => (
      candidate.routeId === `local-${townId}-spine-0`
    ));
    const road = roadsById.get(sample.roadId);
    const roadAtSample = {
      ...road,
      closestX: sample.x,
      closestZ: sample.z,
      roadT: 0.5,
      roadLength: Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z),
    };
    const frontage = createFrontagePlacement({
      type: 'house',
      road: roadAtSample,
      buildingIndex: 1,
      townId,
    });
    const lot = createBuildingLot({
      buildingType: 'house',
      buildingIndex: 1,
      buildingX: frontage.x,
      buildingZ: frontage.z,
      rotationY: frontage.rotationY,
      frontage,
      road,
    });
    assert.equal(frontage.frontageRoadId, road.roadId);
    assert.equal(lot.frontageRoadId, road.roadId);
    assert.ok(roadsById.has(lot.frontageRoadId));
    const roadSurface = hierarchy.roadSurfaces.find(surface => surface.roadId === road.roadId);
    const profile = BUILDING_LOT_PROFILES.house;
    const buildingRectangle = {
      centerX: frontage.x,
      centerZ: frontage.z,
      rotationY: frontage.rotationY,
      width: profile.footprintWidth,
      depth: profile.footprintDepth,
    };
    assert.equal(orientedRectanglesOverlap(buildingRectangle, roadSurfaceToRectangle(roadSurface)), false);
  }
});

test('Capital, RURAL, MAJOR, START_APPROACH, and Bridge fixtures remain unchanged', () => {
  const currentCapital = townRoads(hierarchy, capitalTownId);
  assert.equal(currentCapital.filter(road => road.kind === ROAD_KINDS.LOCAL).length, 43);
  assert.equal(currentCapital.filter(road => road.kind === ROAD_KINDS.ALLEY).length, 6);
  assert.equal(hierarchy.roadSurfaces.filter(surface => currentCapital.some(road => road.roadId === surface.roadId)).length, 49);

  const fixedRoad = road => (
    road.kind === ROAD_KINDS.MAJOR
    || road.kind === ROAD_KINDS.START_APPROACH
    || ruralTownIds.has(road.townId)
  );
  assert.deepEqual(
    hierarchy.roads.filter(fixedRoad).map(semanticRoadShape),
    legacyHierarchy.roads.filter(fixedRoad).map(semanticRoadShape),
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
  assert.equal(hierarchy.majorConnections.length, 5);
  assert.equal(new Set(hierarchy.roads
    .filter(road => road.kind === ROAD_KINDS.START_APPROACH)
    .map(road => road.routeId)).size, 2);
  assert.ok(hierarchy.roads.filter(road => road.kind === ROAD_KINDS.MAJOR).every(road => road.width === 90));
  assert.ok(hierarchy.roads.filter(road => road.kind === ROAD_KINDS.START_APPROACH).every(road => road.width === 56));
});

test('Frontage, Lot, and world interaction modules stay at Phase 3A-2A', () => {
  for (const path of [
    'src/building-frontage.js',
    'src/building-lot.js',
    'src/world-scale-rebalance.js',
  ]) {
    const current = readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
    const baseline = execFileSync('git', ['show', `${PHASE3A2A_COMMIT}:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).replace(/\r\n/g, '\n');
    assert.equal(current, baseline, path);
  }
});

test('the same TOWN input produces the same road hierarchy without connecting RURAL parameters', () => {
  const repeated = createHierarchy(structuredClone(typedTownCenters));
  assert.deepEqual(repeated.roads.map(semanticRoadShape), hierarchy.roads.map(semanticRoadShape));
  assert.deepEqual(repeated.omittedRoutes, hierarchy.omittedRoutes);
  assert.deepEqual(repeated.pathSamples, hierarchy.pathSamples);
});
