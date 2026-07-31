const FOREST_HORIZON_OWNER_PERIOD = 4;
const FOREST_HORIZON_LATTICES = Object.freeze([
  Object.freeze([1, 1]),
  Object.freeze([1, 3]),
  Object.freeze([3, 1]),
  Object.freeze([3, 3]),
]);

const hashForestOwnerSeed = worldSeedHash => {
  let hash = 0x811c9dc5;
  for (const character of `${worldSeedHash}:w8-forest-horizon-owner-lattice`) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return hash >>> 0;
};

const floorModulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

function selectW8ForestHorizonOwner(hash, chunkX, chunkZ) {
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
    throw new TypeError('Forest horizon owner selection requires safe integer Chunk coordinates');
  }
  const [coefficientX, coefficientZ] = FOREST_HORIZON_LATTICES[
    hash % FOREST_HORIZON_LATTICES.length
  ];
  const phase = (hash >>> 3) % FOREST_HORIZON_OWNER_PERIOD;
  const localX = floorModulo(chunkX, FOREST_HORIZON_OWNER_PERIOD);
  const localZ = floorModulo(chunkZ, FOREST_HORIZON_OWNER_PERIOD);
  return floorModulo(
    coefficientX * localX + coefficientZ * localZ + phase,
    FOREST_HORIZON_OWNER_PERIOD,
  ) === 0;
}

/**
 * Selects one canonical owner in four on a seed-oriented world-fixed lattice.
 * The selection remains stable across negative coordinates, streaming order,
 * and Floating Origin rebases.
 */
export function isW8ForestHorizonOwner({ worldSeedHash, chunkX, chunkZ } = {}) {
  if (typeof worldSeedHash !== 'string' || !worldSeedHash) {
    throw new TypeError('Forest horizon owner selection requires worldSeedHash');
  }
  return selectW8ForestHorizonOwner(hashForestOwnerSeed(worldSeedHash), chunkX, chunkZ);
}

export function createW8ForestHorizonOwnerPredicate(worldSeedHash) {
  if (typeof worldSeedHash !== 'string' || !worldSeedHash) {
    throw new TypeError('Forest horizon owner predicate requires worldSeedHash');
  }
  const hash = hashForestOwnerSeed(worldSeedHash);
  return Object.freeze(({ chunkX, chunkZ }) => (
    selectW8ForestHorizonOwner(hash, chunkX, chunkZ)
  ));
}
