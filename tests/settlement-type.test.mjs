import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getSettlementTypeForTownType, SETTLEMENT_TYPES } from '../src/settlement-type.js';

const repoRoot = resolve(import.meta.dirname, '..');
const game = readFileSync(resolve(repoRoot, 'src/game.js'), 'utf8').replace(/\r\n/g, '\n');
const settlementModule = readFileSync(resolve(repoRoot, 'src/settlement-type.js'), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('SETTLEMENT_TYPES exposes exactly CITY, TOWN, and RURAL', () => {
  assert.deepEqual(SETTLEMENT_TYPES, {
    CITY: 'CITY',
    TOWN: 'TOWN',
    RURAL: 'RURAL',
  });
});

test('every current town type has the approved deterministic settlement type', () => {
  assert.deepEqual([
    ['capital', getSettlementTypeForTownType('capital')],
    ['church_town', getSettlementTypeForTownType('church_town')],
    ['school_town', getSettlementTypeForTownType('school_town')],
    ['residential', getSettlementTypeForTownType('residential')],
    ['military', getSettlementTypeForTownType('military')],
    ['suburb', getSettlementTypeForTownType('suburb')],
  ], [
    ['capital', SETTLEMENT_TYPES.CITY],
    ['church_town', SETTLEMENT_TYPES.TOWN],
    ['school_town', SETTLEMENT_TYPES.TOWN],
    ['residential', SETTLEMENT_TYPES.RURAL],
    ['military', SETTLEMENT_TYPES.RURAL],
    ['suburb', SETTLEMENT_TYPES.RURAL],
  ]);
});

test('unknown, missing, and invalid town types remain unclassified', () => {
  for (const value of [undefined, null, '', 'city', 'new_town', 42]) {
    assert.equal(getSettlementTypeForTownType(value), null);
  }
});

test('current town assignments always produce the approved 1 CITY, 2 TOWN, 3 RURAL split', () => {
  const currentTownTypes = [
    'capital', 'church_town', 'school_town', 'residential', 'military', 'suburb',
  ];
  const counts = currentTownTypes.reduce((result, townType) => {
    result[getSettlementTypeForTownType(townType)]++;
    return result;
  }, { CITY: 0, TOWN: 0, RURAL: 0 });
  assert.deepEqual(counts, { CITY: 1, TOWN: 2, RURAL: 3 });
});

test('mapping is deterministic and has no random, Seed, or gameplay dependency', () => {
  const first = ['capital', 'church_town', 'school_town', 'residential', 'military', 'suburb']
    .map(getSettlementTypeForTownType);
  const second = ['capital', 'church_town', 'school_town', 'residential', 'military', 'suburb']
    .map(getSettlementTypeForTownType);
  assert.deepEqual(first, second);
  assert.doesNotMatch(settlementModule, /Math\.random|Seed|Terrain|Chunk|Query|Growth|Threat|Wanted|Perk|WorldState/i);
});

test('game assigns settlementType to the existing six town objects and records diagnostics only', () => {
  assert.match(game, /import \{ getSettlementTypeForTownType, SETTLEMENT_TYPES \} from '\.\/settlement-type\.js';/);
  const foundation = sliceBetween(
    game,
    '// SETTLEMENT TYPE FOUNDATION START',
    '// SETTLEMENT TYPE FOUNDATION END',
  );
  assert.match(foundation, /town\.settlementType = getSettlementTypeForTownType\(town\.type\);/);
  assert.match(foundation, /scene\.userData\.settlementTypeSummary = Object\.freeze\(\{/);
  assert.match(foundation, /totalTownCount: townCenters\.length/);
  assert.match(foundation, /cityCount: settlementCounts\[SETTLEMENT_TYPES\.CITY\]/);
  assert.match(foundation, /townCount: settlementCounts\[SETTLEMENT_TYPES\.TOWN\]/);
  assert.match(foundation, /ruralCount: settlementCounts\[SETTLEMENT_TYPES\.RURAL\]/);
  assert.match(foundation, /townAssignments: Object\.freeze\(townAssignments\)/);
  assert.doesNotMatch(foundation, /Math\.random|console\.|getElementById|spawnEntity|buildRoadHierarchy/);
});

test('the six town anchors retain their existing positions, radii, and town types', () => {
  const townBlock = sliceBetween(game, '            const townCenters = [', '            // SETTLEMENT TYPE FOUNDATION START');
  for (const town of [
    "{ x: 0,     z: 0,     radius: 4860, coreRadius: 2700, type: 'capital' }",
    "{ x: 7500,  z: 7500,  radius: 3780, coreRadius: 2100, type: 'church_town' }",
    "{ x: -8250, z: 6750,  radius: 3780, coreRadius: 2100, type: 'school_town' }",
    "{ x: 7500,  z: -7500, radius: 3510, coreRadius: 1950, type: 'residential' }",
    "{ x: -7500, z: -8250, radius: 3510, coreRadius: 1950, type: 'military' }",
    "{ x: 0,     z: 11250, radius: 3240, coreRadius: 1800, type: 'suburb' }",
  ]) assert.ok(townBlock.includes(town), `missing unchanged town: ${town}`);
  assert.equal((townBlock.match(/type: '/g) ?? []).length, 6);
});

test('Phase 2C introduces no road, frontage, Lot, street object, or gameplay behavior branch', () => {
  const foundation = sliceBetween(
    game,
    '// SETTLEMENT TYPE FOUNDATION START',
    '// SETTLEMENT TYPE FOUNDATION END',
  );
  assert.doesNotMatch(foundation, /Road|Junction|Bridge|Frontage|Lot|Forecourt|WorldDetail|Human|Tank|Boss|Camera|Shake/i);
  assert.doesNotMatch(foundation, /RURAL\s*\/\s*TOWN\s*\/\s*CITY|Zoning|Farm|Fence|Parking|Sidewalk/i);
});

test('JavaScript syntax and whitespace checks pass', () => {
  for (const path of ['src/settlement-type.js', 'src/game.js', 'tests/settlement-type.test.mjs']) {
    execFileSync(process.execPath, ['--check', resolve(repoRoot, path)], { cwd: repoRoot, stdio: 'pipe' });
  }
  execFileSync('git', ['diff', '--check'], { cwd: repoRoot, stdio: 'pipe' });
});
