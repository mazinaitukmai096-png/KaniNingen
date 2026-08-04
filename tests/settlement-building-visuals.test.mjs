import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BUILDING_HEIGHT_VARIANTS,
  SETTLEMENT_BUILDING_COMPOSITIONS,
  SETTLEMENT_BUILDING_PALETTES,
  SETTLEMENT_BUILDING_TYPES,
  SETTLEMENT_BUILDING_VISUAL_RESOURCES,
  TOWER_PLACEMENT_LIMITS,
  createSettlementBuildingVisual,
  createSettlementBuildingVisualSummary,
  getTownPaletteTendency,
  isTowerPlacementAllowed,
  selectSettlementBuildingType,
} from '../src/settlement-building-visuals.js';
import { SETTLEMENT_TYPES } from '../src/settlement-type.js';

const repoRoot = resolve(import.meta.dirname, '..');
const gamePath = resolve(repoRoot, 'src/game.js');
const game = readFileSync(gamePath, 'utf8').replace(/\r\n/g, '\n');
const source = readFileSync(resolve(repoRoot, 'src/settlement-building-visuals.js'), 'utf8');

function plan(settlementType, townId, count = 100) {
  return Array.from({ length: count }, (_, index) => selectSettlementBuildingType({
    settlementType,
    townId,
    buildingIndex: index + 1,
  }));
}

function counts(values) {
  return Object.fromEntries(SETTLEMENT_BUILDING_TYPES.map(type => [
    type,
    values.filter(value => value === type).length,
  ]));
}

test('CITY, TOWN, and RURAL use distinct normalized building compositions', () => {
  assert.deepEqual(SETTLEMENT_BUILDING_COMPOSITIONS.CITY, { house: 55, tower: 32, school: 8, church: 5 });
  assert.deepEqual(SETTLEMENT_BUILDING_COMPOSITIONS.TOWN, { house: 74, tower: 14, school: 7, church: 5 });
  assert.deepEqual(SETTLEMENT_BUILDING_COMPOSITIONS.RURAL, { house: 88, tower: 4, school: 5, church: 3 });
  for (const composition of Object.values(SETTLEMENT_BUILDING_COMPOSITIONS)) {
    assert.equal(Object.values(composition).reduce((sum, value) => sum + value, 0), 100);
  }
  assert.ok(SETTLEMENT_BUILDING_COMPOSITIONS.CITY.tower >= SETTLEMENT_BUILDING_COMPOSITIONS.TOWN.tower);
  assert.ok(SETTLEMENT_BUILDING_COMPOSITIONS.TOWN.tower >= SETTLEMENT_BUILDING_COMPOSITIONS.RURAL.tower);
  assert.ok(SETTLEMENT_BUILDING_COMPOSITIONS.RURAL.house >= SETTLEMENT_BUILDING_COMPOSITIONS.TOWN.house);
  assert.ok(SETTLEMENT_BUILDING_COMPOSITIONS.TOWN.house >= SETTLEMENT_BUILDING_COMPOSITIONS.CITY.house);
});

test('one hundred deterministic selections realize each exact composition without a Seed system', () => {
  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    const first = plan(settlementType, `fixture-${settlementType}`);
    const repeated = plan(settlementType, `fixture-${settlementType}`);
    assert.deepEqual(first, repeated);
    assert.deepEqual(counts(first), SETTLEMENT_BUILDING_COMPOSITIONS[settlementType]);
  }
  assert.doesNotMatch(source, /Math\.random\s*\(/);
  assert.doesNotMatch(source, /\bseed\b/i);
});

test('town identity changes deterministic ordering without changing the target composition', () => {
  const churchTown = plan(SETTLEMENT_TYPES.TOWN, 'town-1-church_town');
  const schoolTown = plan(SETTLEMENT_TYPES.TOWN, 'town-2-school_town');
  assert.notDeepEqual(churchTown, schoolTown);
  assert.deepEqual(counts(churchTown), counts(schoolTown));
});

test('Tower route and proximity limits match CITY, TOWN, and RURAL contracts', () => {
  assert.deepEqual(TOWER_PLACEMENT_LIMITS.CITY, { routeConsecutive: 2, nearbyRadius: 700, nearbyMaximum: 3 });
  assert.deepEqual(TOWER_PLACEMENT_LIMITS.TOWN, { routeConsecutive: 1, nearbyRadius: 700, nearbyMaximum: 3 });
  assert.deepEqual(TOWER_PLACEMENT_LIMITS.RURAL, { routeConsecutive: 1, nearbyRadius: 1000, nearbyMaximum: 1 });

  const tower = (routeId, x, z) => ({ type: 'tower', routeId, x, z });
  assert.equal(isTowerPlacementAllowed({
    settlementType: SETTLEMENT_TYPES.CITY,
    routeId: 'route-a', x: 600, z: 0,
    records: [tower('route-a', 0, 0), tower('route-a', 300, 0)],
  }), false);
  assert.equal(isTowerPlacementAllowed({
    settlementType: SETTLEMENT_TYPES.TOWN,
    routeId: 'route-a', x: 600, z: 0,
    records: [tower('route-a', 0, 0)],
  }), false);
  assert.equal(isTowerPlacementAllowed({
    settlementType: SETTLEMENT_TYPES.RURAL,
    routeId: 'route-b', x: 900, z: 0,
    records: [tower('route-a', 0, 0)],
  }), false);
});

test('Tower rejection is integrated as a House replacement without reducing target counts', () => {
  assert.match(game, /spawnType = 'house';\n\s+newApproxRadius = APPROX_RADIUS\.house;\n\s+towerReplacedByHouse = true;/);
  assert.match(game, /const targetCount = Math\.round\(\(tc\.coreRadius \* tc\.coreRadius\) \/ 36000\);/);
  assert.match(game, /while \(placed < targetCount && attempts < targetCount \* 18\)/);
  assert.match(game, /placed\+\+;/);
});

test('House, Tower, School, and Church height variants remain within approved vertical bounds', () => {
  assert.equal(BUILDING_HEIGHT_VARIANTS.house.length, 3);
  assert.equal(BUILDING_HEIGHT_VARIANTS.tower.length, 4);
  assert.ok(BUILDING_HEIGHT_VARIANTS.house.every(variant => variant.scale >= 0.88 && variant.scale <= 1.12));
  assert.ok(BUILDING_HEIGHT_VARIANTS.house.every(variant => variant.roofScale >= 0.90 && variant.roofScale <= 1.10));
  assert.ok(BUILDING_HEIGHT_VARIANTS.tower.every(variant => variant.scale >= 0.75 && variant.scale <= 1.25));
  assert.ok(BUILDING_HEIGHT_VARIANTS.school.every(variant => variant.scale >= 0.95 && variant.scale <= 1.05));
  assert.ok(BUILDING_HEIGHT_VARIANTS.church.every(variant => variant.scale >= 0.95 && variant.scale <= 1.05));
});

test('horizontal footprints and existing Frontage and Lot modules remain unchanged', () => {
  for (const path of ['src/building-frontage.js', 'src/building-lot.js']) {
    const current = readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
    const baseline = execFileSync('git', ['show', `HEAD:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).replace(/\r\n/g, '\n');
    assert.equal(current, baseline, path);
  }
  assert.match(game, /group\.scale\.y = buildingVisual\.heightScale;/);
  assert.doesNotMatch(source, /footprintWidth|footprintDepth|setback|rotationY\s*=/);
});

test('CITY, TOWN, and RURAL expose finite, distinct, low-saturation shared palettes', () => {
  const serialized = new Set();
  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    const palette = SETTLEMENT_BUILDING_PALETTES[settlementType];
    assert.equal(palette.wall.length, 4);
    assert.equal(palette.roof.length, 4);
    assert.ok([...palette.wall, ...palette.roof].every(color => Number.isInteger(color) && color >= 0 && color <= 0xffffff));
    serialized.add(JSON.stringify(palette));
  }
  assert.equal(serialized.size, 3);
  assert.equal(SETTLEMENT_BUILDING_VISUAL_RESOURCES.materialColorCount, 24);
  assert.equal(SETTLEMENT_BUILDING_VISUAL_RESOURCES.geometryVariantCount, 0);
});

test('church_town and school_town receive distinct but deterministic TOWN roof tendencies', () => {
  const church = getTownPaletteTendency({
    settlementType: SETTLEMENT_TYPES.TOWN,
    townId: 'town-1-church_town',
    townType: 'church_town',
  });
  const school = getTownPaletteTendency({
    settlementType: SETTLEMENT_TYPES.TOWN,
    townId: 'town-2-school_town',
    townType: 'school_town',
  });
  assert.equal(church.primaryRoofPaletteIndex, 0);
  assert.equal(school.primaryRoofPaletteIndex, 2);
  assert.deepEqual(church, getTownPaletteTendency({
    settlementType: SETTLEMENT_TYPES.TOWN,
    townId: 'town-1-church_town',
    townType: 'church_town',
  }));
});

test('identical type-height-roof triples cannot continue for three buildings on one route', () => {
  const input = {
    settlementType: SETTLEMENT_TYPES.CITY,
    townId: 'town-0-capital',
    townType: 'capital',
    type: 'house',
    buildingIndex: 7,
    routeId: 'local-town-0-capital-spine-0',
  };
  const initial = createSettlementBuildingVisual({ ...input, records: [] });
  const repeated = {
    ...initial,
    routeId: input.routeId,
    type: input.type,
    x: 0,
    z: 0,
  };
  const adjusted = createSettlementBuildingVisual({ ...input, records: [repeated, repeated] });
  assert.notEqual(
    `${adjusted.type}|${adjusted.heightVariant}|${adjusted.roofPaletteIndex}`,
    `${initial.type}|${initial.heightVariant}|${initial.roofPaletteIndex}`,
  );
});

test('palette materials use the existing shared caches and add no per-building Three.js allocation', () => {
  assert.match(game, /getWallMaterial\(buildingVisual\.wallColor\)/);
  assert.match(game, /getRoofMaterial\(buildingVisual\.roofColor\)/);
  assert.doesNotMatch(source, /new THREE\./);
  assert.match(game, /const roofMaterialPool = \{\};/);
  assert.match(game, /const wallMaterialPool = \{\};/);
});

test('visual metadata changes no building HP, radius, Damage, or destruction category', () => {
  for (const snippet of [
    'hp = 1200; radius = 65; scoreVal = 800;',
    'hp = 2200; radius = 115; scoreVal = 1500;',
    'hp = 3500; radius = 145; scoreVal = 2500;',
    "const MOBILE_COLLISION_OBSTACLE_TYPES = new Set(['house', 'rock', 'pebble', 'tower', 'church', 'school', 'militaryBase', 'barn', 'factory']);",
  ]) assert.ok(game.includes(snippet), snippet);
  assert.doesNotMatch(source, /\bhp\b|\bdamage\b|scoreVal|attack/i);
});

test('scene diagnostics summarize types, variants, palettes, Tower density, and repeated variants', () => {
  const records = [
    { townId: 'town-a', type: 'house', routeId: 'route-a', x: 0, z: 0, heightVariant: 'LOW', roofPaletteIndex: 0, wallPaletteIndex: 0 },
    { townId: 'town-a', type: 'tower', routeId: 'route-a', x: 200, z: 0, heightVariant: 'MID', roofPaletteIndex: 1, wallPaletteIndex: 0 },
  ];
  const summary = createSettlementBuildingVisualSummary({
    towns: [{ townId: 'town-a', townType: 'capital', settlementType: SETTLEMENT_TYPES.CITY }],
    records,
  });
  assert.equal(summary.totalBuildingCount, 2);
  assert.equal(summary.townSummaries[0].typeCounts.house, 1);
  assert.equal(summary.townSummaries[0].typeCounts.tower, 1);
  assert.equal(summary.townSummaries[0].nearbyTowerMaximum, 1);
  assert.equal(summary.townSummaries[0].maximumIdenticalVariantConsecutive, 1);
  assert.match(game, /scene\.userData\.settlementBuildingVisualSummary = createSettlementBuildingVisualSummary/);
});

test('normal town building opportunities retain legacy non-building thresholds and no new runtime loop', () => {
  assert.match(game, /tc\.type === 'military'[\s\S]*?if \(r < 0\.60\) plannedBuildingType/);
  assert.match(game, /tc\.type === 'suburb'[\s\S]*?if \(r < 0\.50\) plannedBuildingType/);
  assert.match(game, /else \{\n\s+if \(r < 0\.78\) plannedBuildingType/);
  assert.doesNotMatch(source, /requestAnimationFrame|addEventListener|setInterval|setTimeout/);
});

test('unrelated gameplay modules remain at the Phase 3A-2B HEAD', () => {
  for (const path of [
    'src/world-scale-rebalance.js',
    'src/constants.js',
    'src/core/input.js',
    'src/core/renderer.js',
  ]) {
    const current = readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
    const baseline = execFileSync('git', ['show', `HEAD:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).replace(/\r\n/g, '\n');
    assert.equal(current, baseline, path);
  }
});
