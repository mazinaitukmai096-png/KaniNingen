export const PRODUCTION_HUMAN_VISUAL_SCALE = 0.5;
export const PRODUCTION_TANK_VISUAL_SCALE = 1.35;

export const WORLD_DETAIL_TYPES = Object.freeze([
  'streetLamp',
  'bench',
  'trashBin',
  'roadSign',
  'planter',
  'vendingMachine',
  'parkedCar',
  'fence',
]);

export const WORLD_DETAILS_PER_TOWN = 12;
export const WORLD_DETAILS_PER_START_POND = 12;
export const WORLD_DETAIL_INSTANCE_CAPACITY = 320;
export const WORLD_DETAIL_ROADSIDE_OFFSET = 62;

export const TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES = Object.freeze([
  'trashBin',
  'roadSign',
  'bench',
  'planter',
]);

export const START_POND_WORLD_DETAIL_TYPES = TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES;

export const WORLD_DETAIL_INTERACTION_RADII = Object.freeze({
  bench: 35,
  trashBin: 18,
  roadSign: 20,
  planter: 22,
});

const part = (x, y, z, width, height, depth, color, rotationY = 0) => Object.freeze({
  x, y, z, width, height, depth, color, rotationY,
});

export const WORLD_DETAIL_PARTS = Object.freeze({
  streetLamp: Object.freeze([
    part(0, 2, 0, 10, 4, 10, 0x454b50),
    part(0, 34, 0, 4, 64, 4, 0x454b50),
    part(0, 67, 0, 13, 7, 13, 0xffd76a),
  ]),
  bench: Object.freeze([
    part(0, 18, 0, 50, 6, 18, 0x8b5a2b),
    part(0, 32, -7, 50, 24, 5, 0x8b5a2b),
    part(-18, 8, 0, 5, 16, 5, 0x454b50),
    part(18, 8, 0, 5, 16, 5, 0x454b50),
  ]),
  trashBin: Object.freeze([
    part(0, 14, 0, 18, 28, 18, 0x47654a),
    part(0, 29, 0, 21, 4, 21, 0x2f3d31),
  ]),
  roadSign: Object.freeze([
    part(0, 18, 0, 4, 36, 4, 0x727b80),
    part(0, 43, 0, 25, 18, 4, 0x2c6eaf),
  ]),
  planter: Object.freeze([
    part(0, 9, 0, 27, 18, 27, 0x8b6337),
    part(0, 28, 0, 31, 22, 31, 0x397a3b),
  ]),
  vendingMachine: Object.freeze([
    part(0, 25, 0, 25, 50, 19, 0xc73b3b),
    part(0, 30, 10, 18, 27, 2, 0xd9eef7),
  ]),
  parkedCar: Object.freeze([
    part(0, 10, 0, 48, 14, 80, 0x315f88),
    part(0, 23, -5, 38, 14, 36, 0x9ec3d3),
    part(0, 7, 42, 52, 5, 6, 0x454b50),
  ]),
  fence: Object.freeze([
    part(-28, 16, 0, 5, 32, 5, 0x9b7954),
    part(28, 16, 0, 5, 32, 5, 0x9b7954),
    part(0, 11, 0, 60, 5, 5, 0x9b7954),
    part(0, 25, 0, 60, 5, 5, 0x9b7954),
  ]),
});

export function canStageDestroyWorldDetail(stageId, type) {
  return (stageId === 'TINY' || stageId === 'MID' || stageId === 'MAX')
    && TINY_DESTRUCTIBLE_WORLD_DETAIL_TYPES.includes(type);
}

export function getWorldDetailCounts(townCount, startPondCount = 0) {
  if (!Number.isInteger(townCount) || townCount < 0
      || !Number.isInteger(startPondCount) || startPondCount < 0) {
    throw new RangeError('counts must be non-negative integers');
  }

  const counts = Object.fromEntries(WORLD_DETAIL_TYPES.map(type => [type, 0]));
  for (let townIndex = 0; townIndex < townCount; townIndex++) {
    for (let detailIndex = 0; detailIndex < WORLD_DETAILS_PER_TOWN; detailIndex++) {
      counts[WORLD_DETAIL_TYPES[detailIndex % WORLD_DETAIL_TYPES.length]]++;
    }
  }
  for (let pondIndex = 0; pondIndex < startPondCount; pondIndex++) {
    for (let detailIndex = 0; detailIndex < WORLD_DETAILS_PER_START_POND; detailIndex++) {
      counts[START_POND_WORLD_DETAIL_TYPES[detailIndex % START_POND_WORLD_DETAIL_TYPES.length]]++;
    }
  }
  return counts;
}

export function getWorldDetailInstanceCount(townCount, startPondCount = 0) {
  const counts = getWorldDetailCounts(townCount, startPondCount);
  return WORLD_DETAIL_TYPES.reduce(
    (total, type) => total + counts[type] * WORLD_DETAIL_PARTS[type].length,
    0,
  );
}
