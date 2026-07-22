import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASELINE_COMMIT = '78c2ae19555ec54530f192034f7bd2acf05c4645';
const repoRoot = resolve(import.meta.dirname, '..');

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

function readCurrent(path) {
  return normalize(readFileSync(resolve(repoRoot, path), 'utf8'));
}

function readBaseline(path) {
  return normalize(execFileSync('git', ['show', `${BASELINE_COMMIT}:${path}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }));
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const currentGame = readCurrent('src/game.js');
const baselineGame = readBaseline('src/game.js');

test('locked constants and Phase 2 modules match the baseline', () => {
  assert.equal(readCurrent('src/constants.js'), readBaseline('src/constants.js'));
  assert.equal(readCurrent('src/core/input.js'), readBaseline('src/core/input.js'));
  assert.equal(readCurrent('src/core/renderer.js'), readBaseline('src/core/renderer.js'));
});

test('Player, Tank, Boss, and world gameplay constants match the Phase 4 baseline', () => {
  assert.equal(readCurrent('src/constants.js'), readBaseline('src/constants.js'));

  for (const lockedSnippet of [
    'const currentAllowedTanks = bossActive ? 2 : Math.min(10, 4 + Math.floor(score / 6000));',
    "const allStates = en.rageMode ? ['charge', 'dig', 'sweep'] : ['charge', 'dig', 'slither'];",
    'player.hp -= TANK_BULLET_DAMAGE;',
    'player.hp -= BOSS_ACID_DAMAGE;',
  ]) {
    assert.ok(currentGame.includes(lockedSnippet), `missing locked gameplay snippet: ${lockedSnippet}`);
    assert.ok(baselineGame.includes(lockedSnippet), `baseline missing locked gameplay snippet: ${lockedSnippet}`);
  }
});

test('building feedback is gated to the six civilian building types and has no added effects', () => {
  const typeDeclaration = currentGame.match(/const DESTRUCTIBLE_BUILDING_TYPES = new Set\(\[([^\]]+)\]\);/);
  assert.ok(typeDeclaration, 'building type allow-list is missing');

  const types = [...typeDeclaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(types, ['house', 'tower', 'church', 'school', 'barn', 'factory']);
  assert.ok(!types.includes('human'));
  assert.ok(!types.includes('militaryBase'));
  assert.ok(!types.includes('tank'));
  assert.ok(!types.includes('boss'));

  const damageEntity = sliceBetween(currentGame, 'function damageEntity(', 'function isOnBridge(');
  const buildingFeedback = sliceBetween(damageEntity, 'const isDestructibleBuilding', "if (en.type !== 'human')");
  assert.match(damageEntity, /DESTRUCTIBLE_BUILDING_TYPES\.has\(en\.type\)/);
  assert.match(buildingFeedback, /if \(en\.hp <= 0\) \{\s*buildingHitStopUntil = Math\.max\(buildingHitStopUntil, performance\.now\(\) \+ 65\);\s*const buildingShake = Math\.min\(88, 50 \+ en\.radius \* 0\.21\);/s);
  assert.match(buildingFeedback, /if \(shakeSource === 'world'\) \{\s*shake = Math\.max\(shake, buildingShake\);\s*\} else \{\s*applyPlayerCameraShake\(buildingShake\);/s);
  assert.match(buildingFeedback, /else \{\s*buildingHitStopUntil = Math\.max\(buildingHitStopUntil, performance\.now\(\) \+ 32\);\s*playHitSound\(false\);/s);
  assert.doesNotMatch(buildingFeedback, /createParticles|createShockwave|PointLight|setTimeout/);
  assert.doesNotMatch(currentGame, /function (scheduleDestructionFeedback|flashBuildingHit|createBuildingDestructionBurst)/);
  assert.doesNotMatch(currentGame, /destructionFeedbackTimers|destructionFlashLights/);
});

test('attack power, hit radius, HP, and cooldown remain at baseline values', () => {
  const attacks = sliceBetween(currentGame, 'function attack(isLeft)', 'function updateLobbyAnimation(');
  assert.match(attacks, /const hitRad = activeScaleStage\.singleAttackRadius;/);
  assert.match(attacks, /\? 550 \* 1\.5 : 550;/);
  assert.match(attacks, /const hitRad = activeScaleStage\.doubleAttackRadius;/);
  assert.match(attacks, /\? 650 \* 1\.5 : 650;/);

  const sandbox = readCurrent('src/scale-sandbox.js');
  assert.match(sandbox, /singleAttackRadius: 350,/);
  assert.match(sandbox, /doubleAttackRadius: 380,/);

  const constants = readCurrent('src/constants.js');
  assert.match(constants, /export const ATTACK_COOLDOWN = 380;/);
  assert.match(constants, /export const PLAYER_MAX_HP = 100;/);
  assert.match(constants, /export const PLAYER_SPEED = 22\.0;/);
});

test('Phase 4 changes do not include forbidden runtime or world-generation files', () => {
  const changedFiles = execFileSync('git', ['diff', '--name-only', `${BASELINE_COMMIT}..HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim().split(/\r?\n/).filter(Boolean);

  assert.ok(changedFiles.every(path => [
     'index.html',
     'src/game.js',
     'src/building-frontage.js',
     'src/building-lot.js',
     'src/road-town-structure.js',
     'src/scale-sandbox.js',
     'src/world-scale-rebalance.js',
     'tests/building-frontage.test.mjs',
     'tests/building-lot.test.mjs',
     'tests/destruction-feel-regression.test.mjs',
     'tests/road-town-structure.test.mjs',
     'tests/runtime-stability.test.mjs',
     'tests/scale-sandbox.test.mjs',
     'tests/world-scale-rebalance.test.mjs',
  ].includes(path)), `unexpected changed files: ${changedFiles.join(', ')}`);
  assert.ok(changedFiles.every(path => !/(terrain|chunk|query|seed|world.?generation)/i.test(path)));
});
