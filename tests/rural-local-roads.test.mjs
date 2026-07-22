import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ROAD_KINDS, buildRoadHierarchy } from '../src/road-town-structure.js';
import { getSettlementRoadParameters } from '../src/settlement-road-parameters.js';
import { getSettlementTypeForTownType } from '../src/settlement-type.js';

const repoRoot = resolve(import.meta.dirname, '..');
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
  { x: -7500, z: -8250, radius: 65, type: 'militaryBase' },
  { x: 0, z: 11250, radius: 115 },
];
const hierarchy = buildRoadHierarchy({ townCenters, waterZones, exclusionZones });
const repeatedHierarchy = buildRoadHierarchy({
  townCenters: structuredClone(townCenters),
  waterZones: structuredClone(waterZones),
  exclusionZones: structuredClone(exclusionZones),
});
const preRuralHierarchy = buildRoadHierarchy({
  townCenters: townCenters.map(town => (
    town.settlementType === 'RURAL'
      ? Object.fromEntries(Object.entries(town).filter(([key]) => key !== 'settlementType'))
      : structuredClone(town)
  )),
  waterZones: structuredClone(waterZones),
  exclusionZones: structuredClone(exclusionZones),
});
const ruralTownIds = new Map([
  ['town-3-residential', 'residential'],
  ['town-4-military', 'military'],
  ['town-5-suburb', 'suburb'],
]);
const roadsById = new Map(hierarchy.roads.map(road => [road.roadId, road]));

function ruralRoads(townId) {
  return hierarchy.roads.filter(road => (
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

function undirectedAngle(first, second) {
  const dot = Math.abs(first.x * second.x + first.z * second.z);
  return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

test('only residential, military, and suburb use the RURAL LOCAL and ALLEY contract', () => {
  const parameters = getSettlementRoadParameters('RURAL');
  for (const [townId] of ruralTownIds) {
    const roads = ruralRoads(townId);
    assert.ok(roads.length > 0);
    for (const road of roads) {
      assert.equal(road.width, road.kind === ROAD_KINDS.LOCAL
        ? parameters.localWidth
        : parameters.alleyWidth);
      assert.equal(road.sampleSpacing, parameters.sampleSpacing);
      assert.equal(road.roadPattern, parameters.roadPattern);
      assert.equal(road.roadSurfaceOverlap, parameters.roadSurfaceOverlap);
    }
  }
  for (const road of hierarchy.roads.filter(road => road.townId === 'town-0-capital')) {
    if (road.kind === ROAD_KINDS.LOCAL && !road.isCivicAccess) assert.equal(road.width, 74);
    if (road.kind === ROAD_KINDS.ALLEY) assert.equal(road.width, 48);
  }
  for (const road of hierarchy.roads.filter(road => (
    road.townId === 'town-1-church_town' || road.townId === 'town-2-school_town'
  ))) {
    if (road.kind === ROAD_KINDS.LOCAL) assert.equal(road.width, 66);
    if (road.kind === ROAD_KINDS.ALLEY) assert.equal(road.width, 45);
  }
});

test('each RURAL town has one gently curving spine, three branch targets, and three alley targets', () => {
  const parameters = getSettlementRoadParameters('RURAL');
  for (const [townId] of ruralTownIds) {
    const routes = routesFor(ruralRoads(townId));
    assert.equal([...routes.keys()].filter(routeId => routeId.includes('-spine-')).length, 1);
    const branchCount = [...routes.keys()].filter(routeId => routeId.includes('-branch-')).length;
    const omittedBranches = hierarchy.omittedRoutes.filter(route => (
      route.routeId.includes(townId) && route.routeId.includes('-branch-')
    )).length;
    assert.equal(branchCount + omittedBranches, parameters.localBranchCount);
    const alleyCount = [...routes.values()].filter(route => route[0].kind === ROAD_KINDS.ALLEY).length;
    const omittedAlleys = hierarchy.omittedRoutes.filter(route => (
      route.routeId.startsWith(`alley-${townId}-`)
    )).length;
    assert.equal(alleyCount + omittedAlleys, parameters.alleyCount);
    for (const route of routes.values()) {
      let directionChanges = 0;
      let previousSign = 0;
      for (let segmentIndex = 1; segmentIndex < route.length; segmentIndex++) {
        const previous = route[segmentIndex - 1];
        const current = route[segmentIndex];
        const angle = undirectedAngle(
          { x: previous.tangentX, z: previous.tangentZ },
          { x: current.tangentX, z: current.tangentZ },
        );
        assert.ok(angle <= 25, `${route[0].routeId} bends ${angle} degrees`);
        const cross = previous.tangentX * current.tangentZ - previous.tangentZ * current.tangentX;
        const sign = Math.abs(cross) <= 1e-9 ? 0 : Math.sign(cross);
        if (sign && previousSign && sign !== previousSign) directionChanges++;
        if (sign) previousSign = sign;
      }
      assert.ok(directionChanges <= 2, `${route[0].routeId} has micro-zigzag direction changes`);
    }
  }
});

test('RURAL LOCAL branches use valid angles and a two-width straight lead', () => {
  const parameters = getSettlementRoadParameters('RURAL');
  for (const junction of hierarchy.junctions) {
    const parent = roadsById.get(junction.parentRoadId);
    const child = roadsById.get(junction.childRoadId);
    if (!parent || !child || !ruralTownIds.has(child.townId) || !child.routeId.includes('-branch-')) continue;
    const angle = undirectedAngle(
      { x: parent.tangentX, z: parent.tangentZ },
      { x: child.tangentX, z: child.tangentZ },
    );
    assert.ok(angle >= parameters.hardBranchAngleMin && angle <= parameters.hardBranchAngleMax);
    assert.ok(angle >= parameters.preferredBranchAngleMin && angle <= parameters.preferredBranchAngleMax);
    assert.ok(Math.hypot(
      child.end.x - child.start.x,
      child.end.z - child.start.z,
    ) >= parameters.localWidth * 2 - 1e-9);
  }
});

test('RURAL alleys start from LOCAL roads, remain long enough, and end outward', () => {
  const parameters = getSettlementRoadParameters('RURAL');
  for (const [townId, townType] of ruralTownIds) {
    const town = townCenters.find(candidate => candidate.type === townType);
    for (const route of routesFor(ruralRoads(townId)).values()) {
      if (route[0].kind !== ROAD_KINDS.ALLEY) continue;
      const parent = roadsById.get(route[0].parentRoadId);
      assert.equal(parent.kind, ROAD_KINDS.LOCAL);
      const length = route.reduce((total, road) => (
        total + Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z)
      ), 0);
      assert.ok(length >= parameters.alleyWidth * 3);
      assert.ok(Math.hypot(route.at(-1).end.x - town.x, route.at(-1).end.z - town.z)
        > Math.hypot(route[0].start.x - town.x, route[0].start.z - town.z));
    }
  }
});

test('RURAL junctions remain degree three or lower with formal minimum spacing', () => {
  const parameters = getSettlementRoadParameters('RURAL');
  const minimumSpacing = parameters.localWidth * 1.5 * parameters.junctionSpacingMultiplier;
  for (const [townId] of ruralTownIds) {
    const roadIds = new Set(ruralRoads(townId).map(road => road.roadId));
    const junctions = hierarchy.junctions.filter(junction => (
      junction.roadIds.some(roadId => roadIds.has(roadId))
    ));
    assert.ok(junctions.every(junction => junction.degree <= 3 && !junction.isHub));
    for (let firstIndex = 0; firstIndex < junctions.length; firstIndex++) {
      for (let secondIndex = firstIndex + 1; secondIndex < junctions.length; secondIndex++) {
        const distance = Math.hypot(
          junctions[firstIndex].x - junctions[secondIndex].x,
          junctions[firstIndex].z - junctions[secondIndex].z,
        );
        assert.ok(distance >= minimumSpacing - 1e-9);
      }
    }
  }
});

test('RURAL segments, samples, surfaces, and summaries carry formal finite values', () => {
  assert.equal(hierarchy.ruralRoadSummary.length, 3);
  for (const [townId, townType] of ruralTownIds) {
    const roads = ruralRoads(townId);
    const roadIds = new Set(roads.map(road => road.roadId));
    const samples = hierarchy.pathSamples.filter(sample => roadIds.has(sample.roadId));
    const surfaces = hierarchy.roadSurfaces.filter(surface => roadIds.has(surface.roadId));
    assert.ok(samples.length > 0 && surfaces.length > 0);
    assert.ok(samples.every(sample => (
      sample.width === roadsById.get(sample.roadId).width
      && Number.isFinite(sample.tangentX)
      && Number.isFinite(sample.normalX)
    )));
    assert.ok(surfaces.every(surface => (
      surface.width === roadsById.get(surface.roadId).width
      && surface.length > 0
      && Number.isFinite(surface.length)
    )));
    const summary = hierarchy.ruralRoadSummary.find(candidate => candidate.townType === townType);
    assert.ok(summary);
    assert.equal(summary.localRouteCount, new Set(roads
      .filter(road => road.kind === ROAD_KINDS.LOCAL)
      .map(road => road.routeId)).size);
    assert.equal(summary.alleyRouteCount, new Set(roads
      .filter(road => road.kind === ROAD_KINDS.ALLEY)
      .map(road => road.routeId)).size);
    assert.ok(summary.minimumJunctionSpacing > 0);
    assert.equal(summary.maximumRouteCurvature, 0.16);
    assert.ok(summary.outerDirectionRatio >= 0 && summary.outerDirectionRatio <= 1);
  }
});

test('RURAL roads avoid water, landmarks, and the Military Base exclusion', () => {
  const ruralRoadIds = new Set([...ruralTownIds.keys()].flatMap(townId => (
    ruralRoads(townId).map(road => road.roadId)
  )));
  const samples = hierarchy.allPathSamples.filter(sample => ruralRoadIds.has(sample.roadId));
  assert.ok(samples.length > 0);
  assert.ok(samples.every(sample => !sample.isWater && !sample.isBlocked));
});

test('MAJOR, START_APPROACH, Bridge, and settlement road scopes remain fixed', () => {
  assert.equal(hierarchy.majorConnections.length, 5);
  assert.equal(new Set(hierarchy.roads
    .filter(road => road.kind === ROAD_KINDS.MAJOR)
    .map(road => road.routeId)).size, 5);
  assert.ok(hierarchy.roads
    .filter(road => road.kind === ROAD_KINDS.MAJOR)
    .every(road => road.width === 90));
  assert.equal(new Set(hierarchy.roads
    .filter(road => road.kind === ROAD_KINDS.START_APPROACH)
    .map(road => road.routeId)).size, 2);
  assert.ok(hierarchy.roads
    .filter(road => road.kind === ROAD_KINDS.START_APPROACH)
    .every(road => road.width === 56));
  assert.ok(hierarchy.bridgeSpans.length > 0);
});

test('CITY and TOWN road fixtures remain identical when only RURAL processing is enabled', () => {
  const fixedTownIds = new Set([
    'town-0-capital',
    'town-1-church_town',
    'town-2-school_town',
  ]);
  const roadShape = road => ({
    routeId: road.routeId,
    routeOrder: road.routeOrder,
    kind: road.kind,
    townId: road.townId,
    start: road.start,
    end: road.end,
    width: road.width,
    tangentX: road.tangentX,
    tangentZ: road.tangentZ,
    parentRoadId: road.parentRoadId,
  });
  const fixedRoad = road => fixedTownIds.has(road.townId)
    && (road.kind === ROAD_KINDS.LOCAL || road.kind === ROAD_KINDS.ALLEY);
  assert.deepEqual(
    hierarchy.roads.filter(fixedRoad).map(roadShape),
    preRuralHierarchy.roads.filter(fixedRoad).map(roadShape),
  );
});

test('RURAL hierarchy is deterministic and does not introduce random or Seed coupling', () => {
  assert.deepEqual(repeatedHierarchy, hierarchy);
  const source = readFileSync(resolve(repoRoot, 'src/road-town-structure.js'), 'utf8');
  assert.doesNotMatch(source, /Math\.random\s*\(/);
  assert.doesNotMatch(source, /\bSeed\b|seeded|seedValue/);
});

test('game integration exposes the RURAL summary and keeps parks off RURAL road surfaces', () => {
  const source = readFileSync(resolve(repoRoot, 'src/game.js'), 'utf8');
  assert.match(source, /scene\.userData\.settlementRuralRoadSummary\s*=\s*roadHierarchy\.ruralRoadSummary/);
  assert.match(source, /tc\.settlementType\s*===\s*SETTLEMENT_TYPES\.RURAL[\s\S]*circleIntersectsOrientedSurface/);
});

test('game imports ROAD_KINDS from the road module for RURAL park avoidance', () => {
  const source = readFileSync(resolve(repoRoot, 'src/game.js'), 'utf8');
  assert.match(source, /import\s*\{[\s\S]*ROAD_KINDS,[\s\S]*buildRoadHierarchy,[\s\S]*\}\s*from\s*['"]\.\/road-town-structure\.js['"]/);
  assert.match(source, /road\.kind\s*===\s*ROAD_KINDS\.LOCAL/);
  assert.match(source, /road\.kind\s*===\s*ROAD_KINDS\.ALLEY/);
  assert.doesNotMatch(source, /const\s+ROAD_KINDS\s*=/);
  assert.equal(ROAD_KINDS.LOCAL, 'LOCAL');
  assert.equal(ROAD_KINDS.ALLEY, 'ALLEY');
});
