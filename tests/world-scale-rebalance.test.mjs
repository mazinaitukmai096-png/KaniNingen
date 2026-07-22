import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { HUMAN_VISUAL_SCALES } from '../src/scale-sandbox.js';
import {
  PRODUCTION_HUMAN_VISUAL_SCALE,
  PRODUCTION_TANK_VISUAL_SCALE,
  START_POND_WORLD_DETAIL_TYPES,
  TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES,
  WORLD_DETAIL_INSTANCE_CAPACITY,
  WORLD_DETAIL_INTERACTION_RADII,
  WORLD_DETAIL_PARTS,
  WORLD_DETAIL_TYPES,
  WORLD_DETAILS_PER_START_POND,
  WORLD_DETAILS_PER_TOWN,
  canStageDestroyWorldDetail,
  getWorldDetailCounts,
  getWorldDetailInstanceCount,
} from '../src/world-scale-rebalance.js';

const PHASE1B_COMMIT = '1bc4b390e0aea512be51cf72050006d4dd17eeb7';
const repoRoot = resolve(import.meta.dirname, '..');
const game = readFileSync(resolve(repoRoot, 'src/game.js'), 'utf8').replace(/\r\n/g, '\n');
const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const baselineGame = execFileSync('git', ['show', `${PHASE1B_COMMIT}:src/game.js`], {
  cwd: repoRoot,
  encoding: 'utf8',
}).replace(/\r\n/g, '\n');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const openBrace = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`unterminated function: ${name}`);
}

test('formal Human and Tank visual scales are explicit and visual-only', () => {
  assert.equal(PRODUCTION_HUMAN_VISUAL_SCALE, 0.5);
  assert.equal(PRODUCTION_TANK_VISUAL_SCALE, 1.35);
  assert.ok(Object.values(HUMAN_VISUAL_SCALES).includes(PRODUCTION_HUMAN_VISUAL_SCALE));
  assert.match(game, /let humanVisualScale = PRODUCTION_HUMAN_VISUAL_SCALE;/);
  assert.match(game, /if \(type === 'human'\) group\.scale\.setScalar\(humanVisualScale\);/);
  assert.match(game, /if \(type === 'tank'\) group\.scale\.setScalar\(PRODUCTION_TANK_VISUAL_SCALE\);/);
  assert.match(html, /<option value="0\.5">0\.50 \(Production\)<\/option>/);

  const currentSpawn = extractFunction(game, 'spawnEntity');
  assert.match(currentSpawn, /buildingVisual && FRONTAGE_BUILDING_TYPES\.includes\(type\)/);
  assert.doesNotMatch(currentSpawn, /buildingVisual[^\n]*(?:human|tank)|(?:human|tank)[^\n]*buildingVisual/);
});

test('priority town routes and two start ponds receive exactly 96 props and 258 instances', () => {
  assert.equal(WORLD_DETAILS_PER_TOWN, 12);
  assert.equal(WORLD_DETAILS_PER_START_POND, 12);
  assert.deepEqual(getWorldDetailCounts(6, 2), {
    streetLamp: 12,
    bench: 18,
    trashBin: 18,
    roadSign: 18,
    planter: 12,
    vendingMachine: 6,
    parkedCar: 6,
    fence: 6,
  });
  assert.equal(Object.values(getWorldDetailCounts(6, 2)).reduce((sum, count) => sum + count, 0), 96);
  assert.equal(getWorldDetailInstanceCount(6, 2), 258);
  assert.ok(getWorldDetailInstanceCount(6, 2) <= WORLD_DETAIL_INSTANCE_CAPACITY);
});

test('Tiny street interactions are limited to four approved InstancedMesh prop types', () => {
  assert.deepEqual(TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES, [
    'trashBin',
    'roadSign',
    'bench',
    'planter',
  ]);
  assert.equal(START_POND_WORLD_DETAIL_TYPES, TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES);
  assert.deepEqual(WORLD_DETAIL_INTERACTION_RADII, {
    bench: 35,
    trashBin: 18,
    roadSign: 20,
    planter: 22,
  });
  for (const stage of ['TINY', 'MID', 'MAX']) {
    for (const type of TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES) {
      assert.equal(canStageDestroyWorldDetail(stage, type), true);
    }
    assert.equal(canStageDestroyWorldDetail(stage, 'parkedCar'), false);
  }
});

test('street interaction hides only hit instances and reuses existing feedback paths', () => {
  const damageDetails = extractFunction(game, 'damageWorldDetailsAt');
  assert.match(damageDetails, /prop\.destroyed = true;/);
  assert.match(damageDetails, /worldDetailInstancedMesh\.setMatrixAt\(instanceIndex, hiddenMatrix\);/);
  assert.match(damageDetails, /createParticles\(/);
  assert.match(damageDetails, /playHitSound\(false\);/);
  assert.match(damageDetails, /applyPlayerCameraShake\(8\);/);
  assert.doesNotMatch(damageDetails, /entities\.(?:push|splice)|new THREE\.(?:Mesh|Group|InstancedMesh)/);
  assert.equal((game.match(/damageWorldDetailsAt\(/g) || []).length, 4);
});

test('street props prioritize centers, parks, building roads, intersections, and both start ponds', () => {
  const populate = extractFunction(game, 'populateWorldScaleDetails');
  for (const snippet of [
    'distanceSq(a, tc.x, tc.z)',
    'distanceSq(a, tc.park.x, tc.park.z)',
    'buildingDistanceByTile.get(a)',
    'pathDensityByTile.get(b)',
    'worldWaterZones.filter(zone => zone.isPond)',
    'WORLD_DETAILS_PER_START_POND',
  ]) assert.ok(populate.includes(snippet), `missing priority placement: ${snippet}`);
  assert.doesNotMatch(populate, /\(detailIndex \+ 0\.5\) \* townPaths\.length/);
});

test('world detail templates use valid Three.js primitive part data and no external assets', () => {
  assert.deepEqual(Object.keys(WORLD_DETAIL_PARTS), [...WORLD_DETAIL_TYPES]);
  for (const type of WORLD_DETAIL_TYPES) {
    assert.ok(WORLD_DETAIL_PARTS[type].length > 0, `${type} has no parts`);
    for (const detailPart of WORLD_DETAIL_PARTS[type]) {
      for (const key of ['x', 'y', 'z', 'width', 'height', 'depth', 'color', 'rotationY']) {
        assert.equal(Number.isFinite(detailPart[key]), true, `${type}.${key} is invalid`);
      }
      assert.ok(detailPart.width > 0 && detailPart.height > 0 && detailPart.depth > 0);
    }
  }
  const config = readFileSync(resolve(repoRoot, 'src/world-scale-rebalance.js'), 'utf8');
  assert.doesNotMatch(config, /https?:|\.glb|\.gltf|\.fbx|\.obj|TextureLoader|GLTFLoader/i);
});

test('roadside detail rendering shares one Geometry and one Material through InstancedMesh', () => {
  const populate = extractFunction(game, 'populateWorldScaleDetails');
  assert.match(game, /new THREE\.InstancedMesh\(\s*geometries\.box,\s*materials\.worldDetail,\s*WORLD_DETAIL_INSTANCE_CAPACITY\s*\)/s);
  assert.match(populate, /worldDetailInstancedMesh\.setMatrixAt\(instanceIndex, dummy\.matrix\);/);
  assert.match(populate, /worldDetailInstancedMesh\.setColorAt\(instanceIndex, color\);/);
  assert.match(populate, /worldDetailInstancedMesh\.count = instanceIndex;/);
  assert.doesNotMatch(populate, /new THREE\.(?:BoxGeometry|MeshPhongMaterial|Mesh)\b/);
  assert.equal((game.match(/worldDetail: new THREE\.MeshPhongMaterial/g) || []).length, 1);
});

test('House, School, Church, Factory, Military Base, Tree, AI, HP, and Damage stay at Phase 1B', () => {
  for (const snippet of [
    "if (type === 'house')",
    "else if (type === 'church')",
    "else if (type === 'school')",
    "else if (type === 'tree')",
    "else if (type === 'militaryBase')",
    "else if (type === 'factory')",
    'hp = 3200; radius = 160; scoreVal = 2200;',
    'hp = 1600; radius = 160; scoreVal = 1200;',
  ]) {
    assert.ok(game.includes(snippet));
    assert.ok(baselineGame.includes(snippet));
  }

  for (const functionName of ['applyHumanDensity', 'handleCollisions', 'damageEntity']) {
    assert.equal(extractFunction(game, functionName), extractFunction(baselineGame, functionName));
  }
});

test('the phase adds no Growth, Threat, Wanted, Perk, Terrain, Chunk, Query, Seed, Session, or Save system', () => {
  const config = readFileSync(resolve(repoRoot, 'src/world-scale-rebalance.js'), 'utf8');
  assert.doesNotMatch(config, /Growth|Threat|Wanted|Perk|LevelUp|Terrain|Chunk|Query|Seed|Session|Save/i);
  for (const forbiddenPath of [
    'src/terrain.js',
    'src/chunk.js',
    'src/query.js',
    'src/seed.js',
    'src/world-state.js',
  ]) {
    assert.throws(() => readFileSync(resolve(repoRoot, forbiddenPath), 'utf8'));
  }
});

test('JavaScript syntax, import resolution, and whitespace checks pass', () => {
  for (const path of [
    'src/game.js',
    'src/scale-sandbox.js',
    'src/world-scale-rebalance.js',
    'src/constants.js',
  ]) {
    execFileSync(process.execPath, ['--check', resolve(repoRoot, path)], { cwd: repoRoot, stdio: 'pipe' });
  }
  execFileSync('git', ['diff', '--check'], { cwd: repoRoot, stdio: 'pipe' });
});
