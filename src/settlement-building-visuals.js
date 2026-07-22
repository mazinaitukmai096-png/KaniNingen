import { SETTLEMENT_TYPES } from './settlement-type.js';

export const SETTLEMENT_BUILDING_TYPES = Object.freeze(['house', 'tower', 'school', 'church']);

export const SETTLEMENT_BUILDING_COMPOSITIONS = Object.freeze({
  [SETTLEMENT_TYPES.CITY]: Object.freeze({ house: 55, tower: 32, school: 8, church: 5 }),
  [SETTLEMENT_TYPES.TOWN]: Object.freeze({ house: 74, tower: 14, school: 7, church: 5 }),
  [SETTLEMENT_TYPES.RURAL]: Object.freeze({ house: 88, tower: 4, school: 5, church: 3 }),
});

export const BUILDING_HEIGHT_VARIANTS = Object.freeze({
  house: Object.freeze([
    Object.freeze({ id: 'LOW', scale: 0.88, roofScale: 0.90 }),
    Object.freeze({ id: 'STANDARD', scale: 1.00, roofScale: 1.00 }),
    Object.freeze({ id: 'TALL', scale: 1.12, roofScale: 1.10 }),
  ]),
  tower: Object.freeze([
    Object.freeze({ id: 'LOW', scale: 0.75, roofScale: 1.00 }),
    Object.freeze({ id: 'MID', scale: 0.92, roofScale: 1.00 }),
    Object.freeze({ id: 'TALL', scale: 1.08, roofScale: 1.00 }),
    Object.freeze({ id: 'HIGH', scale: 1.25, roofScale: 1.00 }),
  ]),
  school: Object.freeze([
    Object.freeze({ id: 'SUBTLE_LOW', scale: 0.95, roofScale: 1.00 }),
    Object.freeze({ id: 'STANDARD', scale: 1.00, roofScale: 1.00 }),
    Object.freeze({ id: 'SUBTLE_HIGH', scale: 1.05, roofScale: 1.00 }),
  ]),
  church: Object.freeze([
    Object.freeze({ id: 'SUBTLE_LOW', scale: 0.95, roofScale: 1.00 }),
    Object.freeze({ id: 'STANDARD', scale: 1.00, roofScale: 1.00 }),
    Object.freeze({ id: 'SUBTLE_HIGH', scale: 1.05, roofScale: 1.00 }),
  ]),
});

export const SETTLEMENT_BUILDING_PALETTES = Object.freeze({
  [SETTLEMENT_TYPES.CITY]: Object.freeze({
    wall: Object.freeze([0x4c4d4f, 0x777874, 0x8a806f, 0x667078]),
    roof: Object.freeze([0x343638, 0x6f302c, 0x3f5261, 0x4a3930]),
  }),
  [SETTLEMENT_TYPES.TOWN]: Object.freeze({
    wall: Object.freeze([0xb69f7e, 0xb2b0aa, 0xc2b99f, 0x82766d]),
    roof: Object.freeze([0x82463b, 0x684b38, 0x405644, 0x545b60]),
  }),
  [SETTLEMENT_TYPES.RURAL]: Object.freeze({
    wall: Object.freeze([0x80634c, 0x9a8569, 0xb4aa91, 0x716960]),
    roof: Object.freeze([0x4d382d, 0x536247, 0x806a3b, 0x66615a]),
  }),
});

export const TOWER_PLACEMENT_LIMITS = Object.freeze({
  [SETTLEMENT_TYPES.CITY]: Object.freeze({ routeConsecutive: 2, nearbyRadius: 700, nearbyMaximum: 3 }),
  [SETTLEMENT_TYPES.TOWN]: Object.freeze({ routeConsecutive: 1, nearbyRadius: 700, nearbyMaximum: 3 }),
  [SETTLEMENT_TYPES.RURAL]: Object.freeze({ routeConsecutive: 1, nearbyRadius: 1000, nearbyMaximum: 1 }),
});

export const SETTLEMENT_BUILDING_VISUAL_RESOURCES = Object.freeze({
  materialColorCount: new Set(Object.values(SETTLEMENT_BUILDING_PALETTES)
    .flatMap(palette => [...palette.wall, ...palette.roof])).size,
  geometryVariantCount: 0,
});

const EPSILON = 1e-9;

function stableHash(parts) {
  const text = parts.join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function requireSettlementType(settlementType) {
  if (!SETTLEMENT_BUILDING_COMPOSITIONS[settlementType]) {
    throw new RangeError(`unsupported settlement type: ${settlementType}`);
  }
}

export function selectSettlementBuildingType({ settlementType, townId, buildingIndex }) {
  requireSettlementType(settlementType);
  if (!Number.isInteger(buildingIndex) || buildingIndex < 1) {
    throw new RangeError('buildingIndex must be a positive integer');
  }
  const composition = SETTLEMENT_BUILDING_COMPOSITIONS[settlementType];
  const counts = Object.fromEntries(SETTLEMENT_BUILDING_TYPES.map(type => [type, 0]));
  let selectedType = SETTLEMENT_BUILDING_TYPES[0];

  for (let sequenceIndex = 1; sequenceIndex <= buildingIndex; sequenceIndex++) {
    let selectedScore = -Infinity;
    let selectedTie = -Infinity;
    for (const type of SETTLEMENT_BUILDING_TYPES) {
      const score = sequenceIndex * composition[type] / 100 - counts[type];
      const tie = stableHash([townId, settlementType, sequenceIndex, type, 'composition']);
      if (score > selectedScore + EPSILON || (Math.abs(score - selectedScore) <= EPSILON && tie > selectedTie)) {
        selectedType = type;
        selectedScore = score;
        selectedTie = tie;
      }
    }
    counts[selectedType]++;
  }
  return selectedType;
}

export function getTownPaletteTendency({ settlementType, townId, townType }) {
  requireSettlementType(settlementType);
  const palette = SETTLEMENT_BUILDING_PALETTES[settlementType];
  const identity = [townId, townType, settlementType];
  let primaryWallPaletteIndex = stableHash([...identity, 'primary-wall']) % palette.wall.length;
  let secondaryWallPaletteIndex = stableHash([...identity, 'secondary-wall']) % palette.wall.length;
  let primaryRoofPaletteIndex = stableHash([...identity, 'primary-roof']) % palette.roof.length;
  let accentPaletteIndex = stableHash([...identity, 'accent']) % palette.wall.length;

  if (townType === 'church_town') primaryRoofPaletteIndex = 0;
  if (townType === 'school_town') primaryRoofPaletteIndex = 2;
  if (secondaryWallPaletteIndex === primaryWallPaletteIndex) {
    secondaryWallPaletteIndex = (secondaryWallPaletteIndex + 1) % palette.wall.length;
  }
  if (accentPaletteIndex === primaryWallPaletteIndex) {
    accentPaletteIndex = (accentPaletteIndex + 2) % palette.wall.length;
  }

  return Object.freeze({
    primaryWallPaletteIndex,
    secondaryWallPaletteIndex,
    primaryRoofPaletteIndex,
    accentPaletteIndex,
  });
}

export function isTowerPlacementAllowed({ settlementType, routeId, x, z, records }) {
  requireSettlementType(settlementType);
  const limits = TOWER_PLACEMENT_LIMITS[settlementType];
  const routeRecords = records.filter(record => record.routeId === routeId);
  let consecutiveTowers = 0;
  for (let index = routeRecords.length - 1; index >= 0 && routeRecords[index].type === 'tower'; index--) {
    consecutiveTowers++;
  }
  if (consecutiveTowers >= limits.routeConsecutive) return false;

  const nearbyTowerCount = records.filter(record => (
    record.type === 'tower'
    && Math.hypot(record.x - x, record.z - z) <= limits.nearbyRadius
  )).length;
  return nearbyTowerCount < limits.nearbyMaximum;
}

function selectPaletteIndex({ identity, tendency, paletteLength, kind }) {
  const roll = stableHash([...identity, kind, 'roll']) % 100;
  if (kind === 'wall') {
    if (roll < 30) return tendency.secondaryWallPaletteIndex;
    return tendency.primaryWallPaletteIndex;
  }
  if (roll < 60) return tendency.primaryRoofPaletteIndex;
  return stableHash([...identity, kind, 'secondary']) % paletteLength;
}

export function createSettlementBuildingVisual({
  settlementType,
  townId,
  townType,
  type,
  buildingIndex,
  routeId,
  records = [],
}) {
  requireSettlementType(settlementType);
  if (!SETTLEMENT_BUILDING_TYPES.includes(type)) throw new RangeError(`unsupported building type: ${type}`);
  const variants = BUILDING_HEIGHT_VARIANTS[type];
  const palette = SETTLEMENT_BUILDING_PALETTES[settlementType];
  const tendency = getTownPaletteTendency({ settlementType, townId, townType });
  const identity = [townId, townType, settlementType, type, buildingIndex, routeId];
  let heightVariantIndex = stableHash([...identity, 'height']) % variants.length;
  let roofPaletteIndex = selectPaletteIndex({
    identity,
    tendency,
    paletteLength: palette.roof.length,
    kind: 'roof',
  });
  const wallPaletteIndex = selectPaletteIndex({
    identity,
    tendency,
    paletteLength: palette.wall.length,
    kind: 'wall',
  });

  const routeRecords = records.filter(record => record.routeId === routeId);
  const previousTwo = routeRecords.slice(-2);
  if (previousTwo.length === 2 && previousTwo.every(record => (
    record.type === type
    && record.heightVariantIndex === heightVariantIndex
    && record.roofPaletteIndex === roofPaletteIndex
  ))) {
    roofPaletteIndex = (roofPaletteIndex + 1) % palette.roof.length;
    if (previousTwo.every(record => record.roofPaletteIndex === roofPaletteIndex)) {
      heightVariantIndex = (heightVariantIndex + 1) % variants.length;
    }
  }

  const variant = variants[heightVariantIndex];
  return Object.freeze({
    type,
    heightVariant: variant.id,
    heightVariantIndex,
    heightScale: variant.scale,
    roofScale: variant.roofScale,
    wallPaletteIndex,
    roofPaletteIndex,
    wallColor: palette.wall[wallPaletteIndex],
    roofColor: palette.roof[roofPaletteIndex],
    accent: false,
    townPaletteTendency: tendency,
  });
}

function countValues(records, key) {
  const counts = {};
  for (const record of records) counts[record[key]] = (counts[record[key]] ?? 0) + 1;
  return Object.freeze(counts);
}

function maximumRun(records, selector) {
  let maximum = 0;
  const byRoute = new Map();
  for (const record of records) {
    if (!byRoute.has(record.routeId)) byRoute.set(record.routeId, []);
    byRoute.get(record.routeId).push(record);
  }
  for (const routeRecords of byRoute.values()) {
    let previous = null;
    let run = 0;
    for (const record of routeRecords) {
      const value = selector(record);
      if (value === previous) run++;
      else {
        previous = value;
        run = 1;
      }
      maximum = Math.max(maximum, run);
    }
  }
  return maximum;
}

function maximumTowerRun(records) {
  let maximum = 0;
  const byRoute = new Map();
  for (const record of records) {
    if (!byRoute.has(record.routeId)) byRoute.set(record.routeId, []);
    byRoute.get(record.routeId).push(record);
  }
  for (const routeRecords of byRoute.values()) {
    let run = 0;
    for (const record of routeRecords) {
      run = record.type === 'tower' ? run + 1 : 0;
      maximum = Math.max(maximum, run);
    }
  }
  return maximum;
}

export function createSettlementBuildingVisualSummary({ towns, records }) {
  const townSummaries = towns.map(town => {
    const townRecords = records.filter(record => record.townId === town.townId);
    const typeCounts = countValues(townRecords, 'type');
    const typeRatios = Object.freeze(Object.fromEntries(SETTLEMENT_BUILDING_TYPES.map(type => [
      type,
      townRecords.length === 0 ? 0 : (typeCounts[type] ?? 0) / townRecords.length,
    ])));
    let nearbyTowerMaximum = 0;
    const towers = townRecords.filter(record => record.type === 'tower');
    const radius = TOWER_PLACEMENT_LIMITS[town.settlementType].nearbyRadius;
    for (const tower of towers) {
      nearbyTowerMaximum = Math.max(nearbyTowerMaximum, towers.filter(other => (
        Math.hypot(other.x - tower.x, other.z - tower.z) <= radius
      )).length);
    }
    return Object.freeze({
      townId: town.townId,
      townType: town.townType,
      settlementType: town.settlementType,
      buildingCount: townRecords.length,
      typeCounts,
      typeRatios,
      heightVariantCounts: countValues(townRecords, 'heightVariant'),
      roofPaletteCounts: countValues(townRecords, 'roofPaletteIndex'),
      wallPaletteCounts: countValues(townRecords, 'wallPaletteIndex'),
      maximumTowerConsecutive: maximumTowerRun(townRecords),
      nearbyTowerMaximum,
      maximumIdenticalVariantConsecutive: maximumRun(
        townRecords,
        record => `${record.type}|${record.heightVariant}|${record.roofPaletteIndex}`,
      ),
    });
  });

  return Object.freeze({
    totalBuildingCount: records.length,
    townSummaries: Object.freeze(townSummaries),
    materialColorCount: SETTLEMENT_BUILDING_VISUAL_RESOURCES.materialColorCount,
    geometryVariantCount: SETTLEMENT_BUILDING_VISUAL_RESOURCES.geometryVariantCount,
  });
}
