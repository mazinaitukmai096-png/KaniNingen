import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CIVIC_SPACE_MATERIALS,
  CIVIC_SPACE_STATUS,
  CIVIC_SPACE_TYPES,
  circleIntersectsCivicSpaceReservation,
  civicSpaceToAccessRectangle,
  civicSpaceToBodyRectangle,
  createCivicSpaceReservations,
  createCivicSpaceSurfaces,
  orientedRectanglesOverlap,
  validateCivicSpace,
} from '../src/civic-space.js';
import { buildRoadHierarchy } from '../src/road-town-structure.js';
import { getSettlementTypeForTownType } from '../src/settlement-type.js';
import { getWorldDetailCounts, getWorldDetailInstanceCount } from '../src/world-scale-rebalance.js';

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
const hierarchy = buildRoadHierarchy({ townCenters, waterZones, exclusionZones });

function createFixture() {
  return createCivicSpaceReservations({
    townCenters: structuredClone(townCenters),
    landmarks: structuredClone(landmarks),
    roads: hierarchy.roads,
    roadSurfaces: hierarchy.roadSurfaces,
    junctionSurfaces: hierarchy.junctionSurfaces,
    bridgeSpans: hierarchy.bridgeSpans,
    capitalCivicCore: hierarchy.capitalCivicCore,
    waterZones: structuredClone(waterZones),
    exclusionZones: structuredClone(exclusionZones),
  });
}

const civicSpaces = createFixture();
const spacesByType = new Map(civicSpaces.map(space => [space.civicSpaceType, space]));
const surfaces = createCivicSpaceSurfaces(civicSpaces);

function surfaceToRectangle(surface) {
  return {
    centerX: surface.x,
    centerZ: surface.z,
    rotationY: Math.atan2(surface.tangentX ?? 0, surface.tangentZ ?? 1),
    width: surface.width,
    depth: surface.length,
  };
}

test('Civic Space contract targets only CITY, CHURCH, and SCHOOL squares', () => {
  assert.deepEqual(Object.values(CIVIC_SPACE_TYPES), [
    'CITY_SQUARE',
    'CHURCH_SQUARE',
    'SCHOOL_SQUARE',
  ]);
  assert.equal(civicSpaces.length, 3);
  assert.deepEqual(civicSpaces.map(space => space.townType), [
    'capital',
    'church_town',
    'school_town',
  ]);
  assert.equal(civicSpaces.some(space => ['residential', 'military', 'suburb'].includes(space.townType)), false);
  assert.equal(civicSpaces.every(space => validateCivicSpace(space).valid), true);
  assert.equal(civicSpaces.every(space => space.status === CIVIC_SPACE_STATUS.ACTIVE), true);
});

test('CITY_SQUARE stays inside the Capital Civic Core and uses only Civic Access', () => {
  const city = spacesByType.get(CIVIC_SPACE_TYPES.CITY_SQUARE);
  assert.deepEqual([city.centerX, city.centerZ, city.rotationY, city.width, city.depth], [0, -10, 0, 260, 200]);
  const body = civicSpaceToBodyRectangle(city);
  assert.ok(Math.abs(body.centerX - hierarchy.capitalCivicCore.centerX) + body.width / 2
    <= hierarchy.capitalCivicCore.halfWidth - hierarchy.capitalCivicCore.clearance);
  assert.ok(Math.abs(body.centerZ - hierarchy.capitalCivicCore.centerZ) + body.depth / 2
    <= hierarchy.capitalCivicCore.halfDepth - hierarchy.capitalCivicCore.clearance);
  const accessRoad = hierarchy.roads.find(road => road.roadId === city.accessRoadId);
  assert.ok(accessRoad?.isCivicAccess);
  assert.equal(hierarchy.roads.filter(road => road.isCivicAccess).length, 1);
  assert.deepEqual([city.accessStartX, city.accessStartZ, city.accessEndX, city.accessEndZ], [0, -110, 0, -210]);
});

test('Landmark squares are on the real front side and retain landmark rotation', () => {
  for (const [spaceType, townType, landmarkType] of [
    [CIVIC_SPACE_TYPES.CHURCH_SQUARE, 'church_town', 'church'],
    [CIVIC_SPACE_TYPES.SCHOOL_SQUARE, 'school_town', 'school'],
  ]) {
    const civicSpace = spacesByType.get(spaceType);
    const landmark = landmarks.find(candidate => (
      candidate.townType === townType && candidate.type === landmarkType
    ));
    const frontX = Math.sin(landmark.rotationY);
    const frontZ = Math.cos(landmark.rotationY);
    const forward = (civicSpace.centerX - landmark.x) * frontX
      + (civicSpace.centerZ - landmark.z) * frontZ;
    assert.ok(forward > 0);
    assert.equal(civicSpace.rotationY, landmark.rotationY);
    assert.equal(Math.abs(civicSpace.rotationY - landmark.rotationY) * 180 / Math.PI, 0);
    assert.ok(hierarchy.roads.some(road => road.roadId === civicSpace.accessRoadId));
  }
});

test('formal dimensions and access widths stay in the approved ranges', () => {
  const city = spacesByType.get(CIVIC_SPACE_TYPES.CITY_SQUARE);
  const church = spacesByType.get(CIVIC_SPACE_TYPES.CHURCH_SQUARE);
  const school = spacesByType.get(CIVIC_SPACE_TYPES.SCHOOL_SQUARE);
  assert.ok(city.width >= 240 && city.width <= 280 && city.depth >= 180 && city.depth <= 220);
  assert.ok(church.width >= 180 && church.width <= 220 && church.depth >= 140 && church.depth <= 180);
  assert.ok(school.width >= 200 && school.width <= 240 && school.depth >= 150 && school.depth <= 190);
  assert.equal(civicSpaces.every(space => space.accessWidth >= 24 && space.accessWidth <= 40), true);
  const schoolRoad = hierarchy.roads.find(road => road.roadId === school.accessRoadId);
  assert.ok(school.accessWidth < schoolRoad.width);
});

test('each active square has one continuous body and one bounded access surface', () => {
  assert.equal(surfaces.bodySurfaces.length, 3);
  assert.equal(surfaces.accessSurfaces.length, 3);
  assert.equal(surfaces.surfaceInstanceCount, 6);
  for (const civicSpace of civicSpaces) {
    const bodySurface = surfaces.bodySurfaces.find(surface => surface.civicSpaceId === civicSpace.civicSpaceId);
    const accessSurface = surfaces.accessSurfaces.find(surface => surface.civicSpaceId === civicSpace.civicSpaceId);
    assert.ok(bodySurface);
    assert.ok(accessSurface);
    const dx = civicSpace.accessStartX - civicSpace.centerX;
    const dz = civicSpace.accessStartZ - civicSpace.centerZ;
    const rightX = Math.cos(civicSpace.rotationY);
    const rightZ = -Math.sin(civicSpace.rotationY);
    const frontX = Math.sin(civicSpace.rotationY);
    const frontZ = Math.cos(civicSpace.rotationY);
    const boundaryRatio = Math.max(
      Math.abs(dx * rightX + dz * rightZ) / (civicSpace.width / 2),
      Math.abs(dx * frontX + dz * frontZ) / (civicSpace.depth / 2),
    );
    assert.ok(Math.abs(boundaryRatio - 1) < 1e-8);
    assert.ok(accessSurface.depth > 0 && accessSurface.depth <= 520);
  }
});

test('square bodies do not overlap Road, Junction, or Bridge surfaces', () => {
  for (const civicSpace of civicSpaces) {
    const body = civicSpaceToBodyRectangle(civicSpace);
    assert.equal(hierarchy.roadSurfaces.some(surface => (
      orientedRectanglesOverlap(body, surfaceToRectangle(surface))
    )), false, civicSpace.civicSpaceId);
    assert.equal(hierarchy.junctionSurfaces.some(surface => (
      orientedRectanglesOverlap(body, surfaceToRectangle(surface))
    )), false, civicSpace.civicSpaceId);
    assert.equal(hierarchy.bridgeSpans.some(bridge => orientedRectanglesOverlap(body, {
      centerX: (bridge.start.x + bridge.end.x) / 2,
      centerZ: (bridge.start.z + bridge.end.z) / 2,
      rotationY: Math.atan2(bridge.end.x - bridge.start.x, bridge.end.z - bridge.start.z),
      width: bridge.width,
      depth: Math.hypot(bridge.end.x - bridge.start.x, bridge.end.z - bridge.start.z),
    })), false, civicSpace.civicSpaceId);
  }
});

test('access surfaces touch only their selected road and do not cross another road', () => {
  for (const civicSpace of civicSpaces) {
    const access = civicSpaceToAccessRectangle(civicSpace);
    assert.equal(hierarchy.roadSurfaces.some(surface => (
      surface.roadId !== civicSpace.accessRoadId
      && orientedRectanglesOverlap(access, surfaceToRectangle(surface), 1)
    )), false, civicSpace.civicSpaceId);
    assert.equal(hierarchy.junctionSurfaces.some(surface => (
      orientedRectanglesOverlap(access, surfaceToRectangle(surface), 1)
    )), false, civicSpace.civicSpaceId);
  }
});

test('all squares stay inside town bounds and outside water and protected landmarks', () => {
  for (const civicSpace of civicSpaces) {
    const town = townCenters.find(candidate => candidate.type === civicSpace.townType);
    assert.ok(Math.hypot(civicSpace.centerX - town.x, civicSpace.centerZ - town.z)
      + Math.hypot(civicSpace.width / 2, civicSpace.depth / 2) <= town.radius);
    for (const zone of [...waterZones, ...exclusionZones]) {
      assert.equal(circleIntersectsCivicSpaceReservation(
        zone.x,
        zone.z,
        zone.radius,
        civicSpace,
      ), false, `${civicSpace.civicSpaceId}:${zone.type ?? 'water'}`);
    }
  }
});

test('materials are shared by type, low-saturation, and distinct from the road color', () => {
  assert.equal(Object.keys(CIVIC_SPACE_MATERIALS).length, 3);
  const colors = Object.values(CIVIC_SPACE_MATERIALS).map(material => material.color);
  assert.equal(new Set(colors).size, 3);
  assert.equal(colors.includes(0xc2a878), false);
  assert.equal(colors.every(color => color !== 0xffffff && color !== 0x000000), true);
});

test('game integration reserves spaces before normal buildings and reuses shared rendering resources', () => {
  const game = readFileSync(resolve(repoRoot, 'src/game.js'), 'utf8').replace(/\r\n/g, '\n');
  const reservationIndex = game.indexOf('const civicSpaces = createCivicSpaceReservations({');
  const buildingIndex = game.indexOf('const placedTownSpots = []');
  assert.ok(reservationIndex > 0 && reservationIndex < buildingIndex);
  assert.match(game, /new THREE\.InstancedMesh\(\s*geometries\.roadPlane,\s*civicSpaceMaterialByType/);
  assert.match(game, /civicSpaceBuildingCandidateRejectedCount\+\+/);
  assert.match(game, /civicSpaceParkRetryCount\+\+/);
  assert.match(game, /civicSpaceWorldDetailSummary/);
  assert.match(game, /civicSpaceVegetationRejectedCount\+\+/);
  assert.match(game, /scene\.userData\.civicSpaceSummary = Object\.freeze/);
  assert.equal(Object.values(getWorldDetailCounts(6, 2)).reduce((sum, value) => sum + value, 0), 96);
  assert.equal(getWorldDetailInstanceCount(6, 2), 258);
});

test('Road, Core, Frontage, Lot, visuals, and gameplay modules remain byte-identical to the Civic Core HEAD', () => {
  for (const path of [
    'src/capital-civic-core.js',
    'src/road-town-structure.js',
    'src/building-frontage.js',
    'src/building-lot.js',
    'src/settlement-building-visuals.js',
    'src/world-scale-rebalance.js',
    'src/scale-sandbox.js',
    'src/constants.js',
  ]) {
    const current = readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
    const baseline = execFileSync('git', ['show', `HEAD:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).replace(/\r\n/g, '\n');
    assert.equal(current, baseline, path);
  }
});

test('same input is deterministic without Math.random, Seed, or a generic Zone framework', () => {
  assert.deepEqual(createFixture(), civicSpaces);
  const source = readFileSync(resolve(repoRoot, 'src/civic-space.js'), 'utf8');
  assert.doesNotMatch(source, /Math\.random|\bseed\b|terrain|chunk|query|growth|threat|wanted|perk|worldstate/i);
  assert.doesNotMatch(source, /class\s+(?:Zone|District|Parcel)|createGenericZone/i);
});
