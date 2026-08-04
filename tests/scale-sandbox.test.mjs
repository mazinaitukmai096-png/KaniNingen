import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  HUMAN_VISUAL_SCALES,
  INITIAL_SCALE_STAGE_ID,
  SCALE_STAGE_IDS,
  SCALE_STAGES,
  canScaleStageDamageTarget,
  isScaleSandboxAtomicEnabled,
} from '../src/scale-sandbox.js';
import {
  CAM_INITIAL_DIST,
  CAM_INITIAL_PITCH,
  CAM_MAX_DIST,
  CAM_MAX_PITCH,
  CAM_MIN_DIST,
  CAM_MIN_PITCH,
  PLAYER_GRAVITY,
  PLAYER_JUMP_VELOCITY,
  PLAYER_RADIUS,
  PLAYER_SPEED,
} from '../src/constants.js';

const repoRoot = resolve(import.meta.dirname, '..');
const game = readFileSync(resolve(repoRoot, 'src/game.js'), 'utf8').replace(/\r\n/g, '\n');
const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

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

test('the sandbox exposes exactly TINY, MID, and MAX with an explicit Tiny initial stage', () => {
  assert.deepEqual(Object.keys(SCALE_STAGES), ['TINY', 'MID', 'MAX']);
  assert.equal(Object.keys(SCALE_STAGES).length, 3);
  assert.equal(INITIAL_SCALE_STAGE_ID, SCALE_STAGE_IDS.TINY);
  assert.match(game, /let activeScaleStageId = INITIAL_SCALE_STAGE_ID;/);

  const buttons = [...html.matchAll(/data-scale-stage="([A-Z]+)"/g)].map(match => match[1]);
  assert.deepEqual(buttons, ['TINY', 'MID', 'MAX']);
});

test('MAX preserves every locked baseline scale, movement, attack, landing, and camera value', () => {
  const max = SCALE_STAGES.MAX;
  assert.deepEqual({
    visualScale: max.visualScale,
    collisionRadius: max.collisionRadius,
    movementSpeed: max.movementSpeed,
    jumpVelocity: max.jumpVelocity,
    gravity: max.gravity,
    attackOffsetX: max.attackOffsetX,
    attackOffsetZ: max.attackOffsetZ,
    singleAttackRadius: max.singleAttackRadius,
    doubleAttackRadius: max.doubleAttackRadius,
    landingRadius: max.landingRadius,
    landingPushRadius: max.landingPushRadius,
    landingShake: max.landingShake,
    windArcRadius: max.windArcRadius,
    cameraDistance: max.cameraDistance,
    cameraMinDistance: max.cameraMinDistance,
    cameraMaxDistance: max.cameraMaxDistance,
    cameraNear: max.cameraNear,
    cameraPitch: max.cameraPitch,
    cameraMinPitch: max.cameraMinPitch,
    cameraMaxPitch: max.cameraMaxPitch,
    cameraHeight: max.cameraHeight,
    cameraTargetHeight: max.cameraTargetHeight,
  }, {
    visualScale: 1,
    collisionRadius: PLAYER_RADIUS,
    movementSpeed: PLAYER_SPEED,
    jumpVelocity: PLAYER_JUMP_VELOCITY,
    gravity: PLAYER_GRAVITY,
    attackOffsetX: 180,
    attackOffsetZ: 180,
    singleAttackRadius: 350,
    doubleAttackRadius: 380,
    landingRadius: 500,
    landingPushRadius: 1000,
    landingShake: 80,
    windArcRadius: 180,
    cameraDistance: CAM_INITIAL_DIST,
    cameraMinDistance: CAM_MIN_DIST,
    cameraMaxDistance: CAM_MAX_DIST,
    cameraNear: 10,
    cameraPitch: CAM_INITIAL_PITCH,
    cameraMinPitch: CAM_MIN_PITCH,
    cameraMaxPitch: CAM_MAX_PITCH,
    cameraHeight: 200,
    cameraTargetHeight: 120,
  });

  assert.match(game, /\? 550 \* 1\.5 : 550/);
  assert.match(game, /\? 650 \* 1\.5 : 650/);
  assert.match(game, /activeScaleStage\.landingRadius,[\s\S]*?800,[\s\S]*?activeScaleStage\.landingPushRadius/);
});

test('TINY and MID use independently tuned visual, collision, movement, attack, and camera values', () => {
  const tiny = SCALE_STAGES.TINY;
  const mid = SCALE_STAGES.MID;
  assert.equal(tiny.visualScale, 0.08);
  assert.equal(tiny.collisionRadius, PLAYER_RADIUS * 0.08);
  assert.equal(tiny.movementSpeed, PLAYER_SPEED * 0.16);
  assert.equal(tiny.sprintMultiplier, 1.35);
  assert.equal(tiny.jumpVelocity, PLAYER_JUMP_VELOCITY * 0.09);
  assert.equal(tiny.gravity, PLAYER_GRAVITY / 7);
  assert.equal(tiny.singleAttackRadius, 18);
  assert.equal(tiny.cameraDistance, 85);
  assert.equal(tiny.cameraNear, 0.5);
  assert.equal(tiny.cameraMinDistance, 50);
  assert.equal(tiny.cameraMaxDistance, 220);
  assert.equal(tiny.cameraMinPitch, 0.05);
  assert.equal(tiny.cameraMaxPitch, 1.5);
  assert.equal(tiny.playerShakeMultiplier, 0.08);

  assert.equal(mid.visualScale, 0.45);
  assert.equal(mid.collisionRadius, PLAYER_RADIUS * 0.45);
  assert.equal(mid.movementSpeed, PLAYER_SPEED * 0.75);
  assert.equal(mid.jumpVelocity, PLAYER_JUMP_VELOCITY * 0.8);
  assert.equal(mid.singleAttackRadius, 165);
  assert.equal(mid.cameraDistance, 280);
  assert.equal(mid.cameraNear, 4);
  assert.equal(mid.cameraMinDistance, 180);
  assert.equal(mid.cameraMaxDistance, 650);
  assert.equal(mid.cameraMinPitch, 0.08);
  assert.equal(mid.cameraMaxPitch, 1.42);
  assert.equal(mid.playerShakeMultiplier, 0.45);

  assert.notEqual(tiny.movementSpeed / PLAYER_SPEED, tiny.visualScale);
  assert.notEqual(mid.singleAttackRadius / 350, mid.visualScale);
});

test('all stages retain full yaw, tuned pitch/distance bounds, and safe near-camera settings', () => {
  const tiny = SCALE_STAGES.TINY;
  const mid = SCALE_STAGES.MID;
  const max = SCALE_STAGES.MAX;

  for (const stage of [tiny, mid, max]) {
    assert.equal(stage.cameraYawRestriction, 'FULL');
    assert.equal(stage.cameraRotationSensitivity, 1);
    assert.ok(stage.cameraMinPitch < stage.cameraPitch);
    assert.ok(stage.cameraPitch < stage.cameraMaxPitch);
    assert.ok(stage.cameraMinDistance <= stage.cameraDistance);
    assert.ok(stage.cameraDistance <= stage.cameraMaxDistance);
  }
  assert.deepEqual(
    [tiny.cameraGroundClearance, mid.cameraGroundClearance, max.cameraGroundClearance],
    [3, 10, 12],
  );
  assert.deepEqual([tiny.cameraNear, mid.cameraNear, max.cameraNear], [0.5, 4, 10]);

  assert.match(game, /yaw -= e\.movementX \* CAM_MOUSE_ROTATION_SPEED \* settings\.mouseSensitivity \* activeScaleStage\.cameraRotationSensitivity;/);
  assert.doesNotMatch(game, /yaw\s*=\s*Math\.(?:max|min)|Math\.(?:max|min)\([^\n]*yaw/);
});

test('stage-scaled Player shake, stage reset, and camera ground protection are explicit', () => {
  const [tiny, mid, max] = [SCALE_STAGES.TINY, SCALE_STAGES.MID, SCALE_STAGES.MAX];
  assert.deepEqual(
    [tiny.playerShakeMultiplier, mid.playerShakeMultiplier, max.playerShakeMultiplier],
    [0.08, 0.45, 1],
  );
  assert.deepEqual([tiny.cameraShakeCap, mid.cameraShakeCap, max.cameraShakeCap], [20, 96, Infinity]);

  const applyStage = extractFunction(game, 'applyScaleStage');
  assert.match(applyStage, /shake = 0;/);
  const playerShake = extractFunction(game, 'applyPlayerCameraShake');
  assert.match(playerShake, /baseAmount \* activeScaleStage\.playerShakeMultiplier/);
  assert.match(game, /const appliedShake = Math\.min\(shake, activeScaleStage\.cameraShakeCap\) \* settings\.cameraShake;/);
  assert.match(game, /camera\.position\.y = Math\.max\(\s*player\.mesh\.position\.y \+ activeScaleStage\.cameraGroundClearance,/s);
});

test('stage switching reuses Player, Renderer, RAF, and listeners while preserving World state', () => {
  const applyStage = extractFunction(game, 'applyScaleStage');
  assert.match(applyStage, /player\.mesh\.scale\.setScalar\(nextStage\.visualScale\)/);
  assert.match(applyStage, /player\.radius = nextStage\.collisionRadius/);
  assert.match(applyStage, /camera\.near = nextStage\.cameraNear/);
  assert.doesNotMatch(applyStage, /new THREE|initPlayer|scene\.add|createRenderer|requestAnimationFrame|addEventListener/);
  assert.doesNotMatch(applyStage, /player\.mesh\s*=|player\.hp|player\.mesh\.position|score\s*=|entities\s*=|initMap/);

  const stageListener = /document\.querySelectorAll\('\[data-scale-stage\]'\)\.forEach\(button => \{[\s\S]*?button\.addEventListener\('click',[\s\S]*?applyScaleStage/;
  assert.match(game, stageListener);
  assert.doesNotMatch(applyStage, /querySelectorAll/);
});

test('Player collision, movement, attacks, landing, camera, and effects read the active Stage definition', () => {
  for (const snippet of [
    'activeScaleStage.jumpVelocity',
    'activeScaleStage.gravity',
    'activeScaleStage.movementSpeed',
    'activeScaleStage.attackOffsetX',
    'activeScaleStage.attackOffsetZ',
    'activeScaleStage.singleAttackRadius',
    'activeScaleStage.doubleAttackRadius',
    'activeScaleStage.landingRadius',
    'activeScaleStage.cameraHeight',
    'activeScaleStage.cameraTargetHeight',
    'activeScaleStage.cameraMinDistance',
    'activeScaleStage.cameraMaxDistance',
    'activeScaleStage.cameraMinPitch',
    'activeScaleStage.cameraMaxPitch',
    'activeScaleStage.windArcRadius',
  ]) assert.ok(game.includes(snippet), `missing active Stage use: ${snippet}`);
});

test('temporary destruction gates allow only the intended target classes', () => {
  const target = (type, radius = 50) => ({ type, radius });
  assert.equal(canScaleStageDamageTarget('TINY', target('pebble', 20)), true);
  assert.equal(canScaleStageDamageTarget('TINY', target('tree', 25)), true);
  assert.equal(canScaleStageDamageTarget('TINY', target('human', 25)), false);
  assert.equal(canScaleStageDamageTarget('TINY', target('house', 55)), false);

  assert.equal(canScaleStageDamageTarget('MID', target('tree', 25)), true);
  assert.equal(canScaleStageDamageTarget('MID', target('pebble', 20)), true);
  assert.equal(canScaleStageDamageTarget('MID', target('human', 25)), true);
  assert.equal(canScaleStageDamageTarget('MID', target('house', 55)), true);
  assert.equal(canScaleStageDamageTarget('MID', target('house', 75)), true);
  assert.equal(canScaleStageDamageTarget('MID', target('house', 500)), true);
  assert.equal(canScaleStageDamageTarget('MID', target('tank', 70)), false);
  assert.equal(canScaleStageDamageTarget('MID', target('militaryBase', 160)), false);
  assert.equal(canScaleStageDamageTarget('MID', target('church', 115)), false);
  assert.equal(canScaleStageDamageTarget('MID', target('factory', 160)), false);

  for (const type of ['pebble', 'tree', 'human', 'house', 'tank', 'militaryBase', 'boss']) {
    assert.equal(canScaleStageDamageTarget('MAX', target(type, 500)), true);
  }
  assert.ok((game.match(/canScaleStageDamageTarget\(activeScaleStageId, en\)/g) || []).length >= 3);
});

test('Atomic assets remain present while use is disabled throughout the Scale Sandbox', () => {
  for (const id of Object.values(SCALE_STAGE_IDS)) assert.equal(isScaleSandboxAtomicEnabled(id), false);
  for (const asset of [
    'BOMB_COOLDOWN',
    'BOMB_DAMAGE_RADIUS',
    'BOMB_DAMAGE_AMOUNT',
    'spawnMushroomCloud(player.mesh.position)',
    'explodeAt(player.mesh.position, BOMB_DAMAGE_RADIUS, BOMB_DAMAGE_AMOUNT, BOMB_PUSH_RADIUS)',
  ]) assert.ok(game.includes(asset), `Atomic asset removed: ${asset}`);
  assert.match(game, /isScaleSandboxAtomicEnabled\(activeScaleStageId\) && wasCharging/);
  assert.match(game, /SCALE SANDBOX: LOCKED/);
});

test('Human scale comparison remains visual-only and exposes the approved values including Production 0.50', () => {
  assert.deepEqual(HUMAN_VISUAL_SCALES, {
    CURRENT: 1,
    COMPARE_065: 0.65,
    PRODUCTION_050: 0.5,
    COMPARE_040: 0.4,
  });
  const applyHumanScale = extractFunction(game, 'applyHumanVisualScale');
  assert.match(applyHumanScale, /en\.mesh\.scale\.setScalar\(humanVisualScale\)/);
  assert.doesNotMatch(applyHumanScale, /radius|hp|speed|humanState|velocity/);
  assert.match(html, /Human見た目Scale（比較専用・AI\/Collision不変）/);
  assert.match(html, /<option value="1">Current<\/option>/);
  assert.match(html, /<option value="0\.65">0\.65<\/option>/);
  assert.match(html, /<option value="0\.5">0\.50 \(Production\)<\/option>/);
  assert.match(html, /<option value="0\.4">0\.40<\/option>/);
});

test('Tank spawn is stage-gated without introducing wanted, threat, or score proxy state', () => {
  const tankGate = extractFunction(game, 'canSpawnTankForCurrentProgression');
  assert.match(tankGate, /return activeScaleStageId === SCALE_STAGE_IDS\.MAX;/);
  assert.doesNotMatch(tankGate.replace(/\/\/[^\n]*/g, ''), /score|wantedLevel|threat/i);
  assert.doesNotMatch(game, /\b(?:let|const|var)\s+(?:wantedLevel|threat(?:Level)?|tankUnlock)\b/i);

  assert.match(game, /const tankSpawnAllowed = canSpawnTankForCurrentProgression\(\);/);
  assert.match(game, /if \(tankSpawnAllowed && tankCount < currentAllowedTanks && frameRateIndependentChance\(spawnChance, dtScale\)\)/);
  assert.ok((game.match(/if \(canSpawnTankForCurrentProgression\(\)\) \{/g) || []).length >= 3);
});

test('existing Tanks are suppressed and resumed without deleting their gameplay state', () => {
  const syncTanks = extractFunction(game, 'syncTankSandboxState');
  assert.match(syncTanks, /en\.sandboxSuppressed = !allowTank;/);
  assert.match(syncTanks, /if \(en\.sandboxSuppressed\) en\.mesh\.visible = false;/);
  assert.doesNotMatch(syncTanks, /entities\.splice|entities\.filter|en\.isDead\s*=/);

  assert.match(game, /if \(en\.type === 'tank' && en\.sandboxSuppressed\) \{\s*en\.mesh\.visible = false;\s*continue;/s);
  assert.match(game, /if \(b\.owner\?\.type === 'tank' && b\.owner\.sandboxSuppressed\) \{/);
  assert.match(game, /if \(\(en\.type === 'tank' \|\| en\.type === 'boss'\) && !en\.isDead && !en\.sandboxSuppressed\)/);
});

test('the debug Tank route is Max-only and reports the current stage camera and Tank state', () => {
  assert.match(html, /id="debug-spawn-tank-btn"/);
  assert.match(game, /Tank normal spawn: \$\{canSpawnTankForCurrentProgression\(\) \? 'Yes' : 'No'\}/);
  assert.match(game, /spawnTankBtn\.disabled = !gameRunning \|\| !canSpawnTankForCurrentProgression\(\);/);
  assert.match(game, /spawnTankBtn\.innerText = canSpawnTankForCurrentProgression\(\) \? '召喚' : 'Maxのみ';/);
  assert.match(game, /debug-spawn-tank-btn'\)\.addEventListener\('click', \(\) => \{\s*if \(!gameRunning \|\| !canSpawnTankForCurrentProgression\(\)\) return;/s);
  for (const label of ['Camera:', 'Pitch:', 'Yaw:', 'Shake:', 'Tank normal spawn:']) {
    assert.ok(game.includes(label), `missing debug status: ${label}`);
  }
});

test('the sandbox does not introduce growth, perk, save, Terrain, Chunk, Query, or Seed systems', () => {
  const sandbox = readFileSync(resolve(repoRoot, 'src/scale-sandbox.js'), 'utf8');
  assert.doesNotMatch(sandbox, /Destruction Energy|Threat|Level Up|Perk|Permanent Unlock|Session|Save/i);
  for (const path of ['terrain', 'chunk', 'query', 'seed']) {
    assert.doesNotMatch(sandbox, new RegExp(path, 'i'));
  }
});

test('JavaScript syntax, import resolution, and whitespace checks pass', () => {
  for (const path of ['src/game.js', 'src/scale-sandbox.js', 'src/constants.js']) {
    execFileSync(process.execPath, ['--check', resolve(repoRoot, path)], { cwd: repoRoot, stdio: 'pipe' });
  }
  execFileSync('git', ['diff', '--check'], { cwd: repoRoot, stdio: 'pipe' });
});
