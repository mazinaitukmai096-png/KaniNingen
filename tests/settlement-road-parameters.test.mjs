import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SETTLEMENT_ROAD_PARAMETERS,
  getRoadKindParameters,
  getSettlementRoadParameters,
  validateSettlementRoadParameters,
} from '../src/settlement-road-parameters.js';
import { SETTLEMENT_TYPES } from '../src/settlement-type.js';

const repoRoot = resolve(import.meta.dirname, '..');
const requiredKeys = [
  'settlementType', 'roadPattern', 'majorWidth', 'localWidth', 'alleyWidth', 'startApproachWidth',
  'localSpineCount', 'localBranchCount', 'alleyCount', 'junctionSpacingMultiplier',
  'preferredBranchAngleMin', 'preferredBranchAngleMax', 'hardBranchAngleMin', 'hardBranchAngleMax',
  'localCurvature', 'alleyCurvature', 'majorCurvature', 'gridBias', 'deadEndBias',
  'densityMultiplier', 'centerConnectionBias', 'outerRoadBias', 'roadLengthMultiplier',
  'sampleSpacing', 'roadSurfaceOverlap',
];

test('CITY, TOWN, and RURAL have complete deterministic road parameter records', () => {
  assert.deepEqual(Object.keys(SETTLEMENT_ROAD_PARAMETERS), ['CITY', 'TOWN', 'RURAL']);
  assert.equal(Object.isFrozen(SETTLEMENT_ROAD_PARAMETERS), true);

  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    const parameters = getSettlementRoadParameters(settlementType);
    assert.ok(parameters);
    assert.equal(Object.isFrozen(parameters), true);
    assert.deepEqual(Object.keys(parameters), requiredKeys);
    assert.equal(parameters.settlementType, settlementType);
    assert.equal(validateSettlementRoadParameters(parameters), true);
  }
});

test('settlement road patterns map exactly to CITY, TOWN, and RURAL', () => {
  assert.equal(getSettlementRoadParameters(SETTLEMENT_TYPES.CITY).roadPattern, 'GRID');
  assert.equal(getSettlementRoadParameters(SETTLEMENT_TYPES.TOWN).roadPattern, 'SEMI_GRID');
  assert.equal(getSettlementRoadParameters(SETTLEMENT_TYPES.RURAL).roadPattern, 'ORGANIC');
  assert.equal(getSettlementRoadParameters('UNKNOWN'), null);
});

test('road widths and density hierarchy preserve the planned settlement ordering', () => {
  const city = getSettlementRoadParameters(SETTLEMENT_TYPES.CITY);
  const town = getSettlementRoadParameters(SETTLEMENT_TYPES.TOWN);
  const rural = getSettlementRoadParameters(SETTLEMENT_TYPES.RURAL);

  for (const parameters of [city, town, rural]) {
    assert.ok(parameters.majorWidth >= parameters.localWidth);
    assert.ok(parameters.localWidth >= parameters.alleyWidth);
  }
  assert.ok(city.majorWidth > town.majorWidth && town.majorWidth > rural.majorWidth);
  assert.ok(city.densityMultiplier > town.densityMultiplier && town.densityMultiplier > rural.densityMultiplier);
  assert.ok(city.gridBias > town.gridBias && town.gridBias > rural.gridBias);
  assert.ok(rural.deadEndBias > town.deadEndBias && town.deadEndBias > city.deadEndBias);
  assert.ok(rural.localCurvature > town.localCurvature && town.localCurvature > city.localCurvature);
  assert.ok(rural.junctionSpacingMultiplier > town.junctionSpacingMultiplier
    && town.junctionSpacingMultiplier > city.junctionSpacingMultiplier);
});

test('road-kind accessor returns the fixed width and curvature metadata without runtime coupling', () => {
  const city = getSettlementRoadParameters(SETTLEMENT_TYPES.CITY);
  assert.deepEqual(getRoadKindParameters(SETTLEMENT_TYPES.CITY, 'MAJOR'), { width: city.majorWidth, curvature: city.majorCurvature });
  assert.deepEqual(getRoadKindParameters(SETTLEMENT_TYPES.CITY, 'LOCAL'), { width: city.localWidth, curvature: city.localCurvature });
  assert.deepEqual(getRoadKindParameters(SETTLEMENT_TYPES.CITY, 'ALLEY'), { width: city.alleyWidth, curvature: city.alleyCurvature });
  assert.deepEqual(getRoadKindParameters(SETTLEMENT_TYPES.CITY, 'START_APPROACH'), { width: city.startApproachWidth, curvature: 0 });
  assert.equal(getRoadKindParameters('UNKNOWN', 'MAJOR'), null);
  assert.equal(getRoadKindParameters(SETTLEMENT_TYPES.CITY, 'UNKNOWN'), null);
});

test('validator rejects invalid widths, angles, biases, and counts', () => {
  const city = getSettlementRoadParameters(SETTLEMENT_TYPES.CITY);
  assert.throws(() => validateSettlementRoadParameters({ ...city, localWidth: city.majorWidth + 1 }), RangeError);
  assert.throws(() => validateSettlementRoadParameters({ ...city, preferredBranchAngleMin: 100, preferredBranchAngleMax: 90 }), RangeError);
  assert.throws(() => validateSettlementRoadParameters({ ...city, gridBias: 1.01 }), RangeError);
  assert.throws(() => validateSettlementRoadParameters({ ...city, alleyCount: 0 }), RangeError);
  assert.throws(() => validateSettlementRoadParameters({ ...city, roadPattern: 'ORGANIC' }), RangeError);
  assert.throws(() => validateSettlementRoadParameters({ ...city, settlementType: 'UNKNOWN' }), RangeError);
});

test('parameter module is deterministic and does not use random or Seed systems', () => {
  const source = readFileSync(resolve(repoRoot, 'src/settlement-road-parameters.js'), 'utf8');
  assert.doesNotMatch(source, /Math\.random\s*\(/);
  assert.doesNotMatch(source, /\bseed\b/i);
  assert.doesNotMatch(source, /scene\.userData|console\.|HUD/);
});

test('Phase 3A-2C connects CITY, TOWN, and RURAL LOCAL and ALLEY generation', () => {
  const game = readFileSync(resolve(repoRoot, 'src/game.js'), 'utf8');
  const road = readFileSync(resolve(repoRoot, 'src/road-town-structure.js'), 'utf8');
  assert.doesNotMatch(game, /settlement-road-parameters|getSettlementRoadParameters|getRoadKindParameters|SETTLEMENT_ROAD_PARAMETERS/);
  assert.match(road, /import \{ getSettlementRoadParameters \} from '\.\/settlement-road-parameters\.js';/);
  assert.match(road, /town\.type === 'capital' && town\.settlementType === SETTLEMENT_TYPES\.CITY/);
  assert.match(road, /getSettlementRoadParameters\(SETTLEMENT_TYPES\.CITY\)/);
  assert.match(road, /getSettlementRoadParameters\(SETTLEMENT_TYPES\.TOWN\)/);
  assert.match(road, /getSettlementRoadParameters\(SETTLEMENT_TYPES\.RURAL\)/);
});

test('Phase 1 road kinds and fixed widths remain unchanged before Phase 3A-2 wiring', () => {
  const source = readFileSync(resolve(repoRoot, 'src/road-town-structure.js'), 'utf8');
  assert.match(source, /\[ROAD_KINDS\.MAJOR\]:\s*90/);
  assert.match(source, /\[ROAD_KINDS\.LOCAL\]:\s*64/);
  assert.match(source, /\[ROAD_KINDS\.ALLEY\]:\s*44/);
  assert.match(source, /\[ROAD_KINDS\.START_APPROACH\]:\s*56/);
});
