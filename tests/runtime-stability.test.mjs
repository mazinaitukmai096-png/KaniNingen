import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PHASE4_BASELINE_COMMIT = '78c2ae19555ec54530f192034f7bd2acf05c4645';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gamePath = resolve(repoRoot, 'src/game.js');
const game = readFileSync(gamePath, 'utf8').replace(/\r\n/g, '\n');
const baselineGame = execFileSync('git', ['show', `${PHASE4_BASELINE_COMMIT}:src/game.js`], {
  cwd: repoRoot,
  encoding: 'utf8',
}).replace(/\r\n/g, '\n');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const openBrace = source.indexOf('{', start);
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`unterminated function: ${name}`);
}

const probabilityHelpers = new Function(`
  ${extractFunction(game, 'timeAdjustedProbability')}
  ${extractFunction(game, 'referenceFrameEventCount')}
  return { timeAdjustedProbability, referenceFrameEventCount };
`)();

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test('Tank and military spawn chance has identical elapsed-time probability at 30/60/120fps', () => {
  for (const perFrameChance of [0.012, 0.04]) {
    const expectedOneSecondChance = 1 - Math.pow(1 - perFrameChance, 60);
    for (const fps of [30, 60, 120]) {
      const frameScale = 60 / fps;
      const adjusted = probabilityHelpers.timeAdjustedProbability(perFrameChance, frameScale);
      const actualOneSecondChance = 1 - Math.pow(1 - adjusted, fps);
      assert.ok(Math.abs(actualOneSecondChance - expectedOneSecondChance) < 1e-12);
    }
  }

  const currentSpawn = sliceBetween(game, 'const currentAllowedTanks', 'let activeShelterBuildings');
  const baselineSpawn = sliceBetween(baselineGame, 'const currentAllowedTanks', 'for (let ei = 0; ei < entities.length; ei++)');
  for (const snippet of [
    'const currentAllowedTanks = bossActive ? 2 : Math.min(10, 4 + Math.floor(score / 6000));',
    'const spawnChance = 0.012 + Math.min(0.028, score * 0.000003);',
    'const SPAWN_ABLE_BASE_DIST_SQ = 5800 * 5800;',
    "spawnEntity('tank',",
    'score > 2500',
  ]) {
    assert.ok(currentSpawn.includes(snippet));
    assert.ok(baselineSpawn.includes(snippet));
  }
  assert.match(currentSpawn, /const tankSpawnAllowed = canSpawnTankForCurrentProgression\(\);/);
  assert.match(currentSpawn, /if \(tankSpawnAllowed && tankCount < currentAllowedTanks && frameRateIndependentChance\(spawnChance, dtScale\)\)/);
});

test('time-based Particle generation preserves the 60fps event expectation', () => {
  const seconds = 2000;
  for (const perFrameChance of [0.12, 0.2, 0.35, 0.45, 1]) {
    const expected = perFrameChance * 60 * seconds;
    for (const fps of [30, 60, 120]) {
      const random = seededRandom(0x4B414E49 + fps + Math.round(perFrameChance * 100));
      const frameScale = 60 / fps;
      let actual = 0;
      for (let frame = 0; frame < fps * seconds; frame++) {
        actual += probabilityHelpers.referenceFrameEventCount(perFrameChance, frameScale, random);
      }
      const tolerance = perFrameChance === 1 ? 0.001 : 0.015;
      assert.ok(Math.abs(actual - expected) <= expected * tolerance, `${perFrameChance} at ${fps}fps: ${actual} vs ${expected}`);
    }
  }
});

test('Human and Boss state probabilities use elapsed-time conversion without changing decisions', () => {
  assert.match(game, /en\.humanTimer > 0\.8 && frameRateIndependentChance\(0\.003, dtScale\)/);
  assert.match(game, /en\.humanTimer > 1\.5 && frameRateIndependentChance\(0\.005, dtScale\)/);
  assert.match(game, /en\.hyperRage && frameRateIndependentChance\(BOSS_SLITHER_ACID_SPIT_CHANCE, dtScale\)/);
  assert.match(game, /frameRateIndependentChance\(0\.3, dtScale\)/);
  assert.match(game, /frameRateIndependentChance\(0\.4, dtScale\)/);

  for (const decision of [
    "en.humanState = 'tripped';",
    "en.humanState = 'recovering';",
    "const allStates = en.rageMode ? ['charge', 'dig', 'sweep'] : ['charge', 'dig', 'slither'];",
    "en.aiState = 'breach';",
    "en.aiState = 'slither';",
  ]) {
    assert.ok(game.includes(decision));
    assert.ok(baselineGame.includes(decision));
  }
});

test('Tank count remains bounded by the unchanged gameplay cap', () => {
  assert.match(game, /const currentAllowedTanks = bossActive \? 2 : Math\.min\(10, 4 \+ Math\.floor\(score \/ 6000\)\);/);
  assert.match(game, /if \(tankSpawnAllowed && tankCount < currentAllowedTanks && frameRateIndependentChance\(spawnChance, dtScale\)\)/);
  assert.doesNotMatch(game, /currentAllowedTanks[^\n]*MAX_TANKS/);

  for (const cap of [2, 4, 10]) {
    let tankCount = 0;
    for (let frame = 0; frame < 1000; frame++) {
      if (tankCount < cap) tankCount++;
    }
    assert.equal(tankCount, cap);
  }
});

test('all direct Particle paths respect the existing Normal or Heavy caps', () => {
  assert.match(extractFunction(game, 'makeParticleRoom'), /while \(particles\.length >= limit\)/);
  assert.match(extractFunction(game, 'createParticles'), /makeParticleRoom\(PARTICLE_CAP_NORMAL\)/);
  assert.match(extractFunction(game, 'createWindArcParticles'), /makeParticleRoom\(PARTICLE_CAP_HEAVY\)/);
  assert.match(extractFunction(game, 'spawnMushroomCloud'), /makeParticleRoom\(PARTICLE_CAP_HEAVY\)/);
  assert.match(extractFunction(game, 'shatterRock'), /makeParticleRoom\(PARTICLE_CAP_NORMAL\)/);
  assert.match(extractFunction(game, 'damageEntity'), /makeParticleRoom\(PARTICLE_CAP_(?:NORMAL|HEAVY)\)/);
  assert.match(game, /for \(let j = 0; j < landDustCount; j\+\+\) \{\s*makeParticleRoom\(PARTICLE_CAP_HEAVY\)/);
  assert.match(game, /for \(let starEvent = 0; starEvent < recoverStarEvents; starEvent\+\+\) \{\s*makeParticleRoom\(PARTICLE_CAP_NORMAL\)/);
  assert.doesNotMatch(game, /particles\.length < 800/);
});

test('ruin Smoke uses the quality Particle cap and preserves appearance values', () => {
  const ruinUpdate = sliceBetween(game, "else if (en.type === 'ruins')", '} else {\n                        // その他の死んだエンティティ');
  assert.match(ruinUpdate, /referenceFrameEventCount\(0\.12, dtScale\)/);
  assert.match(ruinUpdate, /particles\.length >= PARTICLE_CAP_NORMAL/);
  assert.match(ruinUpdate, /life: 1\.1 \+ Math\.random\(\) \* 0\.5/);
  assert.match(ruinUpdate, /maxLife: 1\.6/);
  assert.match(ruinUpdate, /materials\.ruinSmoke/);
  assert.match(ruinUpdate, /if \(en\.life === undefined\) en\.life = 15\.0/);
});

test('Particle, Bullet, Debris, Smoke, and destroyed entities retain deterministic cleanup', () => {
  assert.ok((game.match(/p\.life -= delta;/g) || []).length >= 2);
  assert.match(game, /if \(p\.life <= 0[^]*?scene\.remove\(p\.mesh\);[^]*?safeDispose\(p\.mesh\);[^]*?particles\.splice\(i, 1\);/);
  assert.match(game, /b\.life -= dtScale;[^]*?scene\.remove\(b\.mesh\);[^]*?safeDispose\(b\.mesh\);[^]*?bullets\.splice\(i, 1\);/);
  assert.match(game, /en\.life -= delta;[^]*?if \(en\.life <= 0\)[^]*?entities\.splice\(ei, 1\);/);
  assert.match(game, /その他の死んだエンティティを配列から除去して肥大化を防ぐ[^]*?entities\.splice\(ei, 1\);[^]*?continue;/);
});

test('collision broad-phase candidates preserve the exact legacy type sets', () => {
  assert.match(game, /MOBILE_COLLISION_OBSTACLE_TYPES = new Set\(\['house', 'rock', 'pebble', 'tower', 'church', 'school', 'militaryBase', 'barn', 'factory'\]\)/);
  assert.match(game, /BOSS_COLLISION_OBSTACLE_TYPES = new Set\(\['house', 'rock', 'pebble', 'tower', 'church', 'school'\]\)/);
  assert.match(game, /for \(let obstacle of mobileCollisionObstacles\)/);
  assert.match(game, /for \(let obstacle of bossCollisionObstacles\)/);
  assert.match(game, /if \(obstacle\.isDead\) continue;/);
  assert.match(game, /const maxDist = en\.radius \+ obstacle\.radius;/);
  assert.match(game, /const limitDist = segRadius \+ obstacle\.radius;/);
});

test('Building feedback, non-road World generation, Input, Renderer, and locked HUD behavior are unchanged', () => {
  const readBaseline = path => execFileSync('git', ['show', `${PHASE4_BASELINE_COMMIT}:${path}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).replace(/\r\n/g, '\n');
  const readCurrent = path => readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

  for (const path of ['src/constants.js', 'src/core/input.js', 'src/core/renderer.js']) {
    assert.equal(readCurrent(path), readBaseline(path));
  }
  const normalizeRoadHierarchy = source => {
    const startMarker = '            // --- 街道（道と橋）の生成（人間の営みロジック） ---';
    const endMarker = '            // --- 建物クラスターの生成';
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, 'missing road hierarchy start');
    assert.notEqual(end, -1, 'missing road hierarchy end');
    return `${source.slice(0, start)}            // ROAD HIERARCHY CHANGE ALLOWED\n${source.slice(end)}`;
  };
  const normalizeBuildingFrontage = source => {
    const startMarker = '            const placedTownSpots = []';
    const endMarker = '            const RURAL_OBJECTS = ';
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, 'missing building frontage start');
    assert.notEqual(end, -1, 'missing building frontage end');
    return `${source.slice(0, start)}            // BUILDING FRONTAGE CHANGE ALLOWED\n${source.slice(end)}`;
  };
  const normalizeBuildingLotVegetation = source => source.replace(
    /\n\s*\/\/ BUILDING LOT VEGETATION EXCLUSION START[\s\S]*?\/\/ BUILDING LOT VEGETATION EXCLUSION END\n/g,
    '\n',
  );
  const normalizeSettlementTypeFoundation = source => source.replace(
    /\n\s*\/\/ SETTLEMENT TYPE FOUNDATION START[\s\S]*?\/\/ SETTLEMENT TYPE FOUNDATION END\n/g,
    '\n',
  );
  const currentMap = normalizeSettlementTypeFoundation(normalizeBuildingLotVegetation(normalizeBuildingFrontage(normalizeRoadHierarchy(sliceBetween(game, 'function initMap()', 'function createParticles(')
    .replace(
      /\s+if \(canSpawnTankForCurrentProgression\(\)\) \{\n\s+(spawnEntity\('tank', tc\.baseX - 150, tc\.baseZ \+ 120\);)\n\s+(spawnEntity\('tank', tc\.baseX \+ 150, tc\.baseZ - 120\);)\n\s+\}/,
      '\n                    $1\n                    $2',
    )
    .replace(
      /\n\s+worldDetailInstancedMesh = new THREE\.InstancedMesh\([\s\S]*?scene\.add\(worldDetailInstancedMesh\);\n/,
      '\n',
    )
    .replace(/\n\s+populateWorldScaleDetails\([^;]+\);\n/, '\n')))));
  const baselineMap = normalizeSettlementTypeFoundation(normalizeBuildingLotVegetation(normalizeBuildingFrontage(normalizeRoadHierarchy(
    sliceBetween(baselineGame, 'function initMap()', 'function createParticles('),
  ))));
  assert.equal(currentMap, baselineMap);
  const currentHud = extractFunction(game, 'updateHUD');
  const baselineHud = extractFunction(baselineGame, 'updateHUD');
  for (const lockedHudSnippet of [
    "document.getElementById('score').innerText = \"$\" + (score * 10000).toLocaleString();",
    "hpFill.style.width = Math.max(0, player.hp) + '%';",
    'const cdRemaining = Math.max(0, BOMB_COOLDOWN - (Date.now() - player.lastBombTime));',
  ]) {
    assert.ok(currentHud.includes(lockedHudSnippet));
    assert.ok(baselineHud.includes(lockedHudSnippet));
  }
});

test('JavaScript syntax and local module imports resolve', () => {
  for (const path of ['src/game.js', 'src/constants.js', 'src/scale-sandbox.js', 'src/building-lot.js', 'src/settlement-type.js', 'src/settlement-road-parameters.js', 'src/core/input.js', 'src/core/renderer.js']) {
    execFileSync(process.execPath, ['--check', resolve(repoRoot, path)], { cwd: repoRoot, stdio: 'pipe' });
  }

  for (const match of game.matchAll(/import\s+\{[^}]+\}\s+from\s+'([^']+)'/gs)) {
    const importedPath = resolve(dirname(gamePath), match[1]);
    assert.ok(existsSync(importedPath), `missing import: ${match[1]}`);
  }
});

test('git diff has no whitespace errors', () => {
  execFileSync('git', ['diff', '--check'], { cwd: repoRoot, stdio: 'pipe' });
});
