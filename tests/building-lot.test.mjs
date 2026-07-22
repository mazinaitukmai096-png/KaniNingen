import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PLAYER_RADIUS } from '../src/constants.js';
import {
  BUILDING_LOT_PROFILES,
  LOT_BUILDING_TYPES,
  LOT_STATUS,
  TINY_MINIMUM_LOT_PASSAGE,
  bridgeToRectangle,
  createBuildingLot,
  getLotSurfaceDescriptors,
  lotContainsBuildingFootprint,
  omitBuildingLot,
  orientedRectangleIntersectsCircle,
  orientedRectanglesOverlap,
  pointInOrientedRectangle,
  roadSurfaceToRectangle,
} from '../src/building-lot.js';
import { ROAD_KINDS } from '../src/road-town-structure.js';

const repoRoot = resolve(import.meta.dirname, '..');
const game = readFileSync(resolve(repoRoot, 'src/game.js'), 'utf8').replace(/\r\n/g, '\n');

function makeFixture(buildingType = 'house', overrides = {}) {
  const profile = BUILDING_LOT_PROFILES[buildingType];
  const road = {
    roadId: 'road-local-001',
    kind: ROAD_KINDS.LOCAL,
    width: 100,
    start: { x: -500, z: 0 },
    end: { x: 500, z: 0 },
    tangentX: 1,
    tangentZ: 0,
  };
  const setback = overrides.setback ?? 40;
  const buildingX = overrides.buildingX ?? 0;
  const buildingZ = overrides.buildingZ ?? (road.width / 2 + profile.entranceOffset + setback);
  const frontage = {
    frontageRoadId: road.roadId,
    frontageRoadKind: road.kind,
    frontageX: buildingX,
    frontageZ: 0,
    frontageNormalX: 0,
    frontageNormalZ: -1,
    setback,
  };
  return {
    road,
    frontage,
    input: {
      buildingType,
      buildingIndex: overrides.buildingIndex ?? 3,
      buildingX,
      buildingZ,
      rotationY: Math.PI,
      frontage,
      road,
    },
  };
}

test('Lot scope is exactly house, tower, school, and church', () => {
  assert.deepEqual(LOT_BUILDING_TYPES, ['house', 'tower', 'school', 'church']);
  for (const excluded of ['militaryBase', 'factory', 'barn', 'human', 'tank', 'boss', 'bridge']) {
    assert.equal(LOT_BUILDING_TYPES.includes(excluded), false);
  }
});

test('type profiles keep bounded margins, entrance offsets, and Tiny-readable path widths', () => {
  const bounds = {
    house: { side: [12, 25], front: [25, 45], back: [10, 30], path: [10, 16] },
    tower: { side: [8, 18], front: [18, 32], back: [8, 26], path: [9, 14] },
    school: { side: [30, 55], front: [55, 90], back: [20, 40], path: [18, 28] },
    church: { side: [35, 55], front: [65, 110], back: [25, 45], path: [20, 32] },
  };
  for (const [type, profile] of Object.entries(BUILDING_LOT_PROFILES)) {
    const expected = bounds[type];
    assert.ok(profile.sideMargin >= expected.side[0] && profile.sideMargin <= expected.side[1]);
    assert.ok(profile.frontMargin >= expected.front[0] && profile.frontMargin <= expected.front[1]);
    assert.ok(profile.backMargin >= expected.back[0] && profile.backMargin <= expected.back[1]);
    assert.ok(profile.pathWidth >= expected.path[0] && profile.pathWidth <= expected.path[1]);
    assert.ok(profile.entranceOffset > 0);
  }
});

test('Lot values are finite, deterministic, and retain the required data shape', () => {
  const fixture = makeFixture();
  const first = createBuildingLot(fixture.input);
  const second = createBuildingLot(fixture.input);
  assert.deepEqual(first, second);
  for (const key of [
    'lotId', 'buildingIndex', 'buildingType', 'frontageRoadId', 'centerX', 'centerZ',
    'rotationY', 'width', 'depth', 'frontX', 'frontZ', 'entranceX', 'entranceZ',
    'roadAccessX', 'roadAccessZ', 'frontageNormalX', 'frontageNormalZ',
    'hasEntrancePath', 'lotStatus',
  ]) assert.ok(Object.hasOwn(first, key), `missing ${key}`);
  for (const value of [
    first.centerX, first.centerZ, first.rotationY, first.width, first.depth,
    first.entranceX, first.entranceZ, first.roadAccessX, first.roadAccessZ,
  ]) assert.ok(Number.isFinite(value));
});

test('Lot rotation and front direction remain identical to Phase 2A frontage', () => {
  const lot = createBuildingLot(makeFixture().input);
  assert.equal(lot.rotationY, Math.PI);
  assert.ok(Math.abs(lot.frontX) < 1e-12);
  assert.equal(lot.frontZ, -1);
  assert.equal(lot.frontageNormalX, lot.frontX);
  assert.equal(lot.frontageNormalZ, lot.frontZ);
});

test('Lot contains its canonical building footprint and entrance on the frontage side', () => {
  for (const type of LOT_BUILDING_TYPES) {
    const lot = createBuildingLot(makeFixture(type).input);
    const profile = BUILDING_LOT_PROFILES[type];
    assert.equal(lotContainsBuildingFootprint(lot), true);
    assert.equal(pointInOrientedRectangle(lot.entranceX, lot.entranceZ, lot), true);
    assert.ok((lot.entranceX - makeFixture(type).input.buildingX) * lot.frontX
      + (lot.entranceZ - makeFixture(type).input.buildingZ) * lot.frontZ > 0);
    assert.ok(lot.width >= profile.footprintWidth + profile.sideMargin * 2);
  }
});

test('roadAccess reaches the matching road edge without overlapping the road surface', () => {
  const fixture = makeFixture();
  const lot = createBuildingLot(fixture.input);
  const roadRectangle = {
    centerX: 0,
    centerZ: 0,
    rotationY: Math.PI / 2,
    width: fixture.road.width,
    depth: 1000,
  };
  assert.equal(lot.frontageRoadId, fixture.road.roadId);
  assert.equal(pointInOrientedRectangle(lot.roadAccessX, lot.roadAccessZ, roadRectangle, 1), true);
  assert.equal(orientedRectanglesOverlap(lot, roadRectangle), false);
  assert.equal(orientedRectanglesOverlap(lot.pathRectangle, roadRectangle), false);
});

test('entrance path directly connects entrance and roadAccess along the frontage normal', () => {
  for (const type of LOT_BUILDING_TYPES) {
    const lot = createBuildingLot(makeFixture(type).input);
    assert.equal(lot.hasEntrancePath, true);
    assert.ok(lot.pathLength > 0);
    assert.equal(lot.pathRectangle.width, BUILDING_LOT_PROFILES[type].pathWidth);
    assert.ok(Math.abs(lot.pathRectangle.depth - lot.pathLength) < 1e-9);
    const startX = lot.pathRectangle.centerX - lot.frontX * lot.pathLength / 2;
    const startZ = lot.pathRectangle.centerZ - lot.frontZ * lot.pathLength / 2;
    const endX = lot.pathRectangle.centerX + lot.frontX * lot.pathLength / 2;
    const endZ = lot.pathRectangle.centerZ + lot.frontZ * lot.pathLength / 2;
    assert.ok(Math.hypot(startX - lot.entranceX, startZ - lot.entranceZ) < 1e-9);
    assert.ok(Math.hypot(endX - lot.roadAccessX, endZ - lot.roadAccessZ) < 1e-9);
  }
});

test('diagonal buildings preserve their diagonal Lot and entrance alignment', () => {
  const angle = Math.PI * 0.25;
  const fixture = makeFixture('tower');
  const frontage = {
    ...fixture.frontage,
    frontageNormalX: Math.sin(angle),
    frontageNormalZ: Math.cos(angle),
    frontageX: 100,
    frontageZ: 100,
  };
  const road = { ...fixture.road, width: 80 };
  const buildingX = 100 - Math.sin(angle) * (40 + 55 + 40);
  const buildingZ = 100 - Math.cos(angle) * (40 + 55 + 40);
  const lot = createBuildingLot({
    ...fixture.input,
    buildingX,
    buildingZ,
    rotationY: angle,
    frontage,
    road,
  });
  assert.equal(lot.rotationY, angle);
  assert.ok(Math.hypot(lot.frontX - Math.sin(angle), lot.frontZ - Math.cos(angle)) < 1e-9);
});

test('START_APPROACH and unsupported building types cannot create Lots', () => {
  const fixture = makeFixture();
  assert.throws(() => createBuildingLot({
    ...fixture.input,
    frontage: { ...fixture.frontage, frontageRoadKind: ROAD_KINDS.START_APPROACH },
  }), /non-START_APPROACH/);
  assert.throws(() => createBuildingLot({ ...fixture.input, buildingType: 'factory' }), /unsupported/);
});

test('oriented overlap helpers reject road, Junction, Bridge, water, and neighboring Lot intrusion', () => {
  const lot = createBuildingLot(makeFixture().input);
  const roadRectangle = roadSurfaceToRectangle({
    x: lot.centerX,
    z: lot.centerZ,
    width: 80,
    length: 500,
    tangentX: 1,
    tangentZ: 0,
  });
  const bridgeRectangle = bridgeToRectangle({
    x: lot.centerX,
    z: lot.centerZ,
    angle: lot.rotationY,
    halfWidth: 50,
    halfLength: 80,
  });
  assert.equal(orientedRectanglesOverlap(lot, roadRectangle), true);
  assert.equal(orientedRectanglesOverlap(lot, bridgeRectangle), true);
  assert.equal(orientedRectangleIntersectsCircle(lot, {
    x: lot.centerX,
    z: lot.centerZ,
    radius: 20,
  }), true);
  assert.equal(orientedRectanglesOverlap(lot, { ...lot, centerX: lot.centerX + 10 }), true);
});

test('Tiny passage rule keeps at least 2.5 diameters between accepted Lots', () => {
  const tinyDiameter = PLAYER_RADIUS * 0.15 * 2;
  assert.ok(TINY_MINIMUM_LOT_PASSAGE >= tinyDiameter * 2.5);
  const first = { centerX: 0, centerZ: 0, rotationY: 0, width: 100, depth: 100 };
  const tooClose = { ...first, centerX: 149 };
  const safe = { ...first, centerX: 150 };
  assert.equal(orientedRectanglesOverlap(first, tooClose, TINY_MINIMUM_LOT_PASSAGE), true);
  assert.equal(orientedRectanglesOverlap(first, safe, TINY_MINIMUM_LOT_PASSAGE), false);
});

test('unsafe Lot omission preserves the candidate and disables only its surfaces', () => {
  const lot = createBuildingLot(makeFixture().input);
  const omitted = omitBuildingLot(lot, 'parkCollision');
  assert.equal(lot.lotStatus, LOT_STATUS.ACTIVE);
  assert.equal(omitted.lotStatus, LOT_STATUS.OMITTED_UNSAFE);
  assert.equal(omitted.omissionReason, 'parkCollision');
  assert.equal(omitted.hasEntrancePath, false);
  assert.equal(getLotSurfaceDescriptors(omitted).length, 0);
  assert.equal(lot.buildingIndex, omitted.buildingIndex);
});

test('residential and civic Lots expose only a front surface and one entrance path', () => {
  for (const type of LOT_BUILDING_TYPES) {
    const lot = createBuildingLot(makeFixture(type).input);
    const surfaces = getLotSurfaceDescriptors(lot);
    assert.equal(surfaces.length, 2);
    assert.equal(surfaces[1].surfaceKind, 'ENTRANCE_PATH');
    assert.equal(surfaces[0].surfaceKind, ['school', 'church'].includes(type) ? 'FORECOURT' : 'FRONT_YARD');
    assert.ok(surfaces[0].width <= lot.width);
    assert.ok(surfaces[0].depth <= lot.depth);
  }
});

test('game integration derives Lots only from existing Phase 2A frontage buildings', () => {
  assert.match(game, /LOT_BUILDING_TYPES\.includes\(entity\.type\)[\s\S]*?entity\.frontageRoadId[\s\S]*?!entity\.isDead/);
  assert.match(game, /buildingX: building\.mesh\.position\.x/);
  assert.match(game, /buildingZ: building\.mesh\.position\.z/);
  assert.match(game, /rotationY: building\.mesh\.rotation\.y/);
  assert.doesNotMatch(game, /building\.mesh\.position\.(?:set|copy)\(/);
  assert.doesNotMatch(game, /building\.mesh\.rotation\.y\s*=/);
});

test('game integration records every required omission reason without console or HUD output', () => {
  for (const reason of [
    'roadCollision', 'junctionCollision', 'bridgeCollision', 'waterCollision', 'parkCollision',
    'landmarkCollision', 'militaryBaseCollision', 'buildingCollision', 'lotCollision',
    'invalidFrontage', 'invalidEntrance', 'noRoadAccess',
  ]) assert.match(game, new RegExp(`${reason}: 0`));
  assert.match(game, /scene\.userData\.buildingLots = Object\.freeze\(\[\.\.\.buildingLots\]\)/);
  assert.match(game, /scene\.userData\.buildingLotSummary = Object\.freeze\(\{/);
  assert.doesNotMatch(game, /console\.(?:log|info|debug)\([^\n]*buildingLot/i);
  assert.doesNotMatch(game, /getElementById\([^\n]*buildingLot/i);
});

test('Lot surfaces use one shared Geometry, two shared Materials, and at most two draw calls', () => {
  assert.match(game, /lotResidential: new THREE\.MeshPhongMaterial/);
  assert.match(game, /lotCivic: new THREE\.MeshPhongMaterial/);
  assert.match(game, /new THREE\.InstancedMesh\(\s*geometries\.roadPlane,\s*material,/);
  assert.match(game, /residentialLotSurfaceMesh = createSurfaceMesh\(residentialSurfaces, materials\.lotResidential\)/);
  assert.match(game, /civicLotSurfaceMesh = createSurfaceMesh\(civicSurfaces, materials\.lotCivic\)/);
  assert.equal((game.match(/createSurfaceMesh\([^,]+, materials\.lot/g) ?? []).length, 2);
});

test('vegetation exclusions cover Lot/path for trees and surfaces for grass and flowers', () => {
  assert.match(game, /lotVegetationExclusionSurfaces\.push\(lot, lot\.pathRectangle\)/);
  assert.match(game, /lotSurfaceVegetationExclusionSurfaces\.push\(\.\.\.surfaces\)/);
  assert.equal((game.match(/BUILDING LOT VEGETATION EXCLUSION START/g) ?? []).length, 3);
  assert.match(game, /pointInOrientedRectangle\(x, z, surface, 60\)/);
  assert.match(game, /pointInOrientedRectangle\(x, z, surface, 6\)/);
  assert.match(game, /pointInOrientedRectangle\(x \+ offsetX, z \+ offsetZ, surface, 4\)/);
});

test('Phase 2B adds no Zoning, Terrain, Growth, Seed, or generic Parcel framework', () => {
  const lotModule = readFileSync(resolve(repoRoot, 'src/building-lot.js'), 'utf8');
  assert.doesNotMatch(lotModule, /\b(?:Zoning|Terrain|Chunk|Query|Seed|WorldState|Growth|Threat|Wanted|NavMesh)\b/i);
  assert.doesNotMatch(lotModule, /class\s+(?:Parcel|Lot|Entity|World)/);
});

test('JavaScript syntax, local import resolution, and whitespace checks pass', () => {
  for (const path of ['src/building-lot.js', 'src/game.js', 'tests/building-lot.test.mjs']) {
    execFileSync(process.execPath, ['--check', resolve(repoRoot, path)], { cwd: repoRoot, stdio: 'pipe' });
  }
  execFileSync('git', ['diff', '--check'], { cwd: repoRoot, stdio: 'pipe' });
});
