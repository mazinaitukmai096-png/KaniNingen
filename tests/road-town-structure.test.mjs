import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ROAD_KIND_LIST,
  ROAD_KINDS,
  ROAD_WIDTH_RANGES,
  ROAD_WIDTHS,
  buildRoadHierarchy,
  getRoadKindCounts,
} from '../src/road-town-structure.js';
import {
  TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES,
  getWorldDetailCounts,
  getWorldDetailInstanceCount,
} from '../src/world-scale-rebalance.js';

const PHASE2_BASELINE_COMMIT = 'e3b04fc';
const repoRoot = resolve(import.meta.dirname, '..');
const game = readFileSync(resolve(repoRoot, 'src/game.js'), 'utf8').replace(/\r\n/g, '\n');
const roadModule = readFileSync(resolve(repoRoot, 'src/road-town-structure.js'), 'utf8').replace(/\r\n/g, '\n');
const baselineGame = execFileSync('git', ['show', `${PHASE2_BASELINE_COMMIT}:src/game.js`], {
  cwd: repoRoot,
  encoding: 'utf8',
}).replace(/\r\n/g, '\n');

const townCenters = [
  { x: 0, z: 0, radius: 4860, coreRadius: 2700, type: 'capital' },
  { x: 7500, z: 7500, radius: 3780, coreRadius: 2100, type: 'church_town' },
  { x: -8250, z: 6750, radius: 3780, coreRadius: 2100, type: 'school_town' },
  { x: 7500, z: -7500, radius: 3510, coreRadius: 1950, type: 'residential' },
  { x: -7500, z: -8250, radius: 3510, coreRadius: 1950, type: 'military' },
  { x: 0, z: 11250, radius: 3240, coreRadius: 1800, type: 'suburb' },
];

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

const originalTowns = structuredClone(townCenters);
const originalWater = structuredClone(waterZones);
const hierarchy = buildRoadHierarchy({ townCenters, waterZones, exclusionZones });

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const openBrace = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = openBrace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated function: ${name}`);
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function groupRoadsByRoute(roads) {
  const routes = new Map();
  for (const road of roads) {
    if (!routes.has(road.routeId)) routes.set(road.routeId, []);
    routes.get(road.routeId).push(road);
  }
  for (const routeRoads of routes.values()) routeRoads.sort((a, b) => a.routeOrder - b.routeOrder);
  return routes;
}

function connectionAngleDegrees(parent, child) {
  const dot = Math.max(-1, Math.min(1,
    parent.tangentX * child.tangentX + parent.tangentZ * child.tangentZ));
  return Math.acos(dot) * 180 / Math.PI;
}

function distanceToSegment(point, road) {
  const dx = road.end.x - road.start.x;
  const dz = road.end.z - road.start.z;
  const lengthSq = dx * dx + dz * dz;
  const t = Math.max(0, Math.min(1,
    ((point.x - road.start.x) * dx + (point.z - road.start.z) * dz) / lengthSq));
  return Math.hypot(
    point.x - (road.start.x + dx * t),
    point.z - (road.start.z + dz * t),
  );
}

const roadsById = new Map(hierarchy.roads.map(road => [road.roadId, road]));
const roadsByRoute = groupRoadsByRoute(hierarchy.roads);

test('the six town anchors and existing five inter-town connections remain unchanged', () => {
  assert.deepEqual(townCenters, originalTowns);
  assert.deepEqual(waterZones, originalWater);
  assert.equal(townCenters.length, 6);
  assert.deepEqual(
    hierarchy.majorConnections.map(({ fromIndex, toIndex }) => [fromIndex, toIndex]),
    [[0, 1], [0, 2], [0, 3], [1, 5], [2, 5]],
  );
});

test('Road Segment hierarchy exposes exactly four kinds with stable counts', () => {
  assert.deepEqual(ROAD_KIND_LIST, ['MAJOR', 'LOCAL', 'ALLEY', 'START_APPROACH']);
  assert.deepEqual(getRoadKindCounts(hierarchy.roads), {
    MAJOR: 45,
    LOCAL: 102,
    ALLEY: 16,
    START_APPROACH: 6,
  });
  assert.equal(hierarchy.roads.length, 169);
  assert.deepEqual(
    Object.fromEntries(ROAD_KIND_LIST.map(kind => [
      kind,
      [...roadsByRoute.values()].filter(routeRoads => routeRoads[0].kind === kind).length,
    ])),
    { MAJOR: 5, LOCAL: 24, ALLEY: 8, START_APPROACH: 2 },
  );

  const roadIds = hierarchy.roads.map(road => road.roadId);
  assert.equal(new Set(roadIds).size, roadIds.length);
  for (const road of hierarchy.roads) {
    assert.ok(ROAD_KIND_LIST.includes(road.kind));
    assert.ok(road.start && road.end);
    assert.ok(Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z) >= road.width);
    for (const value of [
      road.start.x,
      road.start.z,
      road.end.x,
      road.end.z,
      road.width,
      road.tangentX,
      road.tangentZ,
      road.normalX,
      road.normalZ,
    ]) assert.equal(Number.isFinite(value), true);
  }
});

test('width, tangent, normal, and parent relationships are valid', () => {
  const roadsById = new Map(hierarchy.roads.map(road => [road.roadId, road]));
  for (const road of hierarchy.roads) {
    const range = ROAD_WIDTH_RANGES[road.kind];
    assert.ok(road.width >= range.min && road.width <= range.max);
    assert.equal(road.width, ROAD_WIDTHS[road.kind]);
    assert.ok(Math.abs(Math.hypot(road.tangentX, road.tangentZ) - 1) < 1e-12);
    assert.ok(Math.abs(Math.hypot(road.normalX, road.normalZ) - 1) < 1e-12);
    assert.ok(Math.abs(road.tangentX * road.normalX + road.tangentZ * road.normalZ) < 1e-12);

    const parent = road.parentRoadId ? roadsById.get(road.parentRoadId) : null;
    if (road.kind === ROAD_KINDS.ALLEY) {
      let ancestor = parent;
      while (ancestor?.kind === ROAD_KINDS.ALLEY) ancestor = roadsById.get(ancestor.parentRoadId);
      assert.equal(ancestor?.kind, ROAD_KINDS.LOCAL);
    }
    if (road.kind === ROAD_KINDS.START_APPROACH) {
      let ancestor = parent;
      while (ancestor?.kind === ROAD_KINDS.START_APPROACH) ancestor = roadsById.get(ancestor.parentRoadId);
      assert.ok(ancestor?.kind === ROAD_KINDS.MAJOR || ancestor?.kind === ROAD_KINDS.LOCAL);
    }
    if (road.kind === ROAD_KINDS.LOCAL && !road.isTownSpine) assert.ok(parent);
  }
});

test('LOCAL forms explicit T junctions and ALLEY never begins at a town center', () => {
  assert.ok(hierarchy.junctions.filter(junction => junction.type === 'T').length >= 30);
  const alleyOrigins = new Map();
  for (const alley of hierarchy.roads.filter(road => road.kind === ROAD_KINDS.ALLEY)) {
    const current = alleyOrigins.get(alley.routeId);
    if (!current || alley.routeOrder < current.routeOrder) alleyOrigins.set(alley.routeId, alley);
  }
  for (const alley of alleyOrigins.values()) {
    const town = townCenters.find(candidate => candidate.type === alley.town.type);
    assert.ok(Math.hypot(alley.start.x - town.x, alley.start.z - town.z) > 1);
  }
  for (const town of townCenters) {
    assert.ok([...alleyOrigins.values()].some(alley => alley.town.type === town.type));
  }
});

test('START_APPROACH begins outside each pond shore and points toward an existing road', () => {
  const approaches = hierarchy.roads.filter(road => road.kind === ROAD_KINDS.START_APPROACH);
  assert.equal(new Set(approaches.map(road => road.routeId)).size, 2);
  for (let pondIndex = 0; pondIndex < 2; pondIndex++) {
    const pond = waterZones.filter(zone => zone.isPond)[pondIndex];
    const approach = approaches.find(road => (
      road.routeId === `start-approach-${pondIndex}` && road.routeOrder === 0
    ));
    assert.ok(approach);
    assert.ok(Math.hypot(approach.start.x - pond.x, approach.start.z - pond.z) > pond.radius);
    assert.ok(approach.parentRoadId);
  }
});

test('junction topology has bounded degree, spacing, and natural branch angles', () => {
  assert.equal(hierarchy.junctions.length, 38);
  assert.equal(hierarchy.junctionSurfaces.length, hierarchy.junctions.length);
  const positions = new Set();
  const angles = [];
  for (const junction of hierarchy.junctions) {
    assert.equal(junction.type, 'T');
    assert.equal(junction.degree, 3);
    assert.equal(junction.isHub, false);
    assert.ok(Number.isFinite(junction.x));
    assert.ok(Number.isFinite(junction.z));
    const positionKey = `${junction.x.toFixed(6)}:${junction.z.toFixed(6)}`;
    assert.equal(positions.has(positionKey), false);
    positions.add(positionKey);

    const parent = roadsById.get(junction.parentRoadId);
    const child = roadsById.get(junction.childRoadId);
    assert.ok(parent);
    assert.ok(child);
    const angle = connectionAngleDegrees(parent, child);
    angles.push(angle);
    assert.ok(angle >= 55 && angle <= 125, `${junction.junctionId}: ${angle}`);
  }
  assert.ok(Math.min(...angles) >= 75);
  assert.ok(Math.max(...angles) <= 105);

  for (let firstIndex = 0; firstIndex < hierarchy.junctions.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < hierarchy.junctions.length; secondIndex++) {
      const first = hierarchy.junctions[firstIndex];
      const second = hierarchy.junctions[secondIndex];
      const distance = Math.hypot(first.x - second.x, first.z - second.z);
      assert.ok(distance + 1e-8 >= Math.max(first.width, second.width) * 1.5);
    }
  }
});

test('child routes preserve a straight two-width lead and all retained routes exceed minimum length', () => {
  for (const [routeId, routeRoads] of roadsByRoute) {
    const kind = routeRoads[0].kind;
    const routeLength = routeRoads.reduce((sum, road) => (
      sum + Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z)
    ), 0);
    if (kind === ROAD_KINDS.ALLEY) assert.ok(routeLength >= ROAD_WIDTHS[kind] * 3, routeId);
    if (kind === ROAD_KINDS.LOCAL && routeId.includes('-branch-')) {
      assert.ok(routeLength >= ROAD_WIDTHS[kind] * 3, routeId);
    }
    if (kind === ROAD_KINDS.ALLEY
        || kind === ROAD_KINDS.START_APPROACH
        || (kind === ROAD_KINDS.LOCAL && routeId.includes('-branch-'))) {
      const firstLength = Math.hypot(
        routeRoads[0].end.x - routeRoads[0].start.x,
        routeRoads[0].end.z - routeRoads[0].start.z,
      );
      assert.ok(firstLength + 1e-8 >= ROAD_WIDTHS[kind] * 2, routeId);
    }
  }

  assert.equal(hierarchy.omittedRoutes.length, 10);
  assert.equal(hierarchy.omittedRoutes.filter(route => route.kind === ROAD_KINDS.LOCAL).length, 6);
  assert.equal(hierarchy.omittedRoutes.filter(route => route.kind === ROAD_KINDS.ALLEY).length, 4);
  assert.equal(hierarchy.omittedRoutes.some(route => route.reason === 'TOO_SHORT'), false);
});

test('Segment road surfaces are finite aligned rectangles with flat ends', () => {
  assert.equal(hierarchy.roadSurfaces.length, 164);
  for (const surface of hierarchy.roadSurfaces) {
    const centerlineLength = Math.hypot(
      surface.end.x - surface.start.x,
      surface.end.z - surface.start.z,
    );
    assert.ok(centerlineLength > 0);
    assert.ok(Math.abs(surface.length - centerlineLength) < 1e-8);
    assert.ok(Math.abs(surface.x - (surface.start.x + surface.end.x) / 2) < 1e-8);
    assert.ok(Math.abs(surface.z - (surface.start.z + surface.end.z) / 2) < 1e-8);
    assert.ok(Math.abs(Math.hypot(surface.tangentX, surface.tangentZ) - 1) < 1e-12);
    assert.equal(surface.width, ROAD_WIDTHS[surface.kind]);
    assert.equal(surface.startCap, 'FLAT');
    assert.equal(surface.endCap, 'FLAT');
    for (const value of [surface.x, surface.z, surface.width, surface.length]) {
      assert.equal(Number.isFinite(value), true);
    }
  }
});

test('Junction Surfaces are bounded non-degenerate rectangles without triangle spikes', () => {
  for (const surface of hierarchy.junctionSurfaces) {
    assert.equal(surface.shape, 'RECTANGLE');
    assert.equal(surface.vertices.length, 4);
    assert.equal(surface.triangles.length, 2);
    assert.ok(Number.isFinite(surface.x));
    assert.ok(Number.isFinite(surface.z));
    const outerDistance = Math.max(...surface.vertices.map(vertex => Math.hypot(vertex.x, vertex.z)));
    assert.ok(outerDistance <= surface.maxRoadWidth * 0.75 + 1e-8);
    for (const triangle of surface.triangles) {
      const [a, b, c] = triangle.map(index => surface.vertices[index]);
      const twiceArea = Math.abs(
        (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x),
      );
      assert.ok(twiceArea > 1e-8);
    }
  }
});

test('flat road ends do not stop immediately before an unrelated road', () => {
  assert.equal(hierarchy.roadEnds.every(end => end.style === 'FLAT'), true);
  for (const end of hierarchy.roadEnds) {
    for (const road of hierarchy.roads) {
      if (road.routeId === end.routeId) continue;
      const distance = distanceToSegment(end, road);
      assert.ok(distance + 1e-8 >= (end.width + road.width) / 2 + 8);
    }
  }
});

test('pathSamples retain compatibility fields, stable order, and continuous segment coverage', () => {
  const requiredFields = [
    'x', 'z', 'tc', 'roadId', 'kind', 'width',
    'tangentX', 'tangentZ', 'normalX', 'normalZ',
  ];
  let previousSequence = -1;
  const samplesByRoad = new Map();
  for (const sample of hierarchy.pathSamples) {
    for (const field of requiredFields) assert.ok(field in sample, `missing pathSamples.${field}`);
    assert.ok(sample.sequence > previousSequence);
    previousSequence = sample.sequence;
    if (!samplesByRoad.has(sample.roadId)) samplesByRoad.set(sample.roadId, []);
    samplesByRoad.get(sample.roadId).push(sample);
  }
  for (const samples of samplesByRoad.values()) {
    for (let index = 1; index < samples.length; index++) {
      const previous = samples[index - 1];
      const current = samples[index];
      if (current.sampleIndex !== previous.sampleIndex + 1) continue;
      const centerDistance = Math.hypot(current.x - previous.x, current.z - previous.z);
      assert.ok(centerDistance <= (previous.length + current.length) / 2 + 1e-8);
    }
  }
});

test('road surface samples stay out of water and water crossings become Bridge spans', () => {
  for (const sample of hierarchy.pathSamples) {
    for (const zone of waterZones) {
      const distance = Math.hypot(sample.x - zone.x, sample.z - zone.z);
      assert.ok(distance >= zone.radius + sample.width / 2);
    }
  }
  for (const surface of hierarchy.roadSurfaces) {
    for (const zone of waterZones) {
      assert.ok(distanceToSegment(zone, surface) >= zone.radius + surface.width / 2);
    }
  }
  assert.ok(hierarchy.allPathSamples.some(sample => sample.isWater));
  assert.ok(hierarchy.bridgeSpans.length > 0);
  for (const bridge of hierarchy.bridgeSpans) {
    assert.ok(Math.hypot(bridge.end.x - bridge.start.x, bridge.end.z - bridge.start.z) > 0);
    assert.ok(bridge.width >= 110);
  }
});

test('road surfaces and Junction patches stay outside fixed Landmark exclusion zones', () => {
  for (const sample of hierarchy.pathSamples) {
    for (const zone of exclusionZones) {
      const distance = Math.hypot(sample.x - zone.x, sample.z - zone.z);
      assert.ok(distance >= zone.radius + sample.width / 2 + 8);
    }
  }
  for (const surface of hierarchy.roadSurfaces) {
    for (const zone of exclusionZones) {
      assert.ok(distanceToSegment(zone, surface) >= zone.radius + surface.width / 2 + 8);
    }
  }
  for (const junction of hierarchy.junctions) {
    for (const zone of exclusionZones) {
      const distance = Math.hypot(junction.x - zone.x, junction.z - zone.z);
      assert.ok(distance >= zone.radius + junction.width / 2 + 8);
    }
  }
});

test('the same inputs produce an identical hierarchy without a Seed system', () => {
  const repeated = buildRoadHierarchy({
    townCenters: structuredClone(townCenters),
    waterZones: structuredClone(waterZones),
    exclusionZones: structuredClone(exclusionZones),
  });
  assert.equal(JSON.stringify(repeated), JSON.stringify(hierarchy));
  assert.doesNotMatch(roadModule, /Math\.random|Seed|Chunk|Query|Terrain|Growth|Threat|Wanted|Perk/i);
});

test('game integration renders Segment and Junction rectangles through one shared InstancedMesh', () => {
  assert.match(game, /import \{ buildRoadHierarchy \} from '\.\/road-town-structure\.js';/);
  const roadBlock = sliceBetween(
    game,
    '// --- 街道（道と橋）の生成（人間の営みロジック） ---',
    '// --- 建物クラスターの生成',
  );
  assert.match(roadBlock, /const roadHierarchy = buildRoadHierarchy\(\{[\s\S]*?townCenters,[\s\S]*?waterZones,[\s\S]*?exclusionZones: roadExclusionZones,[\s\S]*?\}\);/);
  assert.match(roadBlock, /const pathSamples = roadHierarchy\.pathSamples;/);
  assert.match(roadBlock, /const pathTiles = pathSamples;/);
  assert.match(roadBlock, /\.\.\.roadHierarchy\.roadSurfaces\.map/);
  assert.match(roadBlock, /\.\.\.roadHierarchy\.junctionSurfaces\.map/);
  assert.match(roadBlock, /new THREE\.InstancedMesh\([\s\S]*?geometries\.roadPlane,[\s\S]*?materials\.road,/);
  assert.match(roadBlock, /Math\.atan2\(surface\.tangentX, surface\.tangentZ\)/);
  assert.match(roadBlock, /roadSurfaceTransform\.scale\.set\(surface\.width, surface\.length, 1\);/);
  assert.doesNotMatch(roadBlock, /new THREE\.Mesh\(geometries\.roadPlane/);
  assert.doesNotMatch(roadBlock, /geometries\.circleUnit, materials\.road/);
  assert.doesNotMatch(roadBlock, /new THREE\.(?:PlaneGeometry|MeshPhongMaterial)/);
  assert.doesNotMatch(roadBlock, /Math\.random/);
});

test('building placement, Player start, and World Interaction Phase2 remain at baseline', () => {
  assert.equal(extractFunction(game, 'spawnEntity'), extractFunction(baselineGame, 'spawnEntity'));
  assert.equal(extractFunction(game, 'populateWorldScaleDetails'), extractFunction(baselineGame, 'populateWorldScaleDetails'));
  assert.equal(extractFunction(game, 'findLandingSpot'), extractFunction(baselineGame, 'findLandingSpot'));
  assert.equal(
    sliceBetween(game, 'const placedTownSpots = []', 'populateWorldScaleDetails('),
    sliceBetween(baselineGame, 'const placedTownSpots = []', 'populateWorldScaleDetails('),
  );
  assert.equal(Object.values(getWorldDetailCounts(6, 2)).reduce((sum, count) => sum + count, 0), 96);
  assert.equal(getWorldDetailInstanceCount(6, 2), 258);
  assert.deepEqual(TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES, ['trashBin', 'roadSign', 'bench', 'planter']);
});
