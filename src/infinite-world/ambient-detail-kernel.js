import { LOGICAL_CHUNK_SIZE_METERS } from './chunk-coordinates.js';
import { createChunkId } from './legacy-core/g0/chunk-id.js';
import { createWorldFeatureId } from './legacy-core/g0/stable-id.js';

/**
 * Shared ambient-detail kernel.
 *
 * Ambient Grass, Flower and Shrub are authored by Full residency, which is pinned at 100 m by
 * worker throughput. Presenting Shrub past that distance means the Distant tier has to produce
 * the *same* objects the Near tier does - a Far Shrub with no Near counterpart is precisely
 * what "Bush is Near-only decoration and is forbidden from Macro Natural presence" guards
 * against, the same failure as far-only Grass patches or Rock proxies.
 *
 * Identity is therefore made a consequence of calling one function rather than an agreement
 * between two independently maintained derivations. Two tiers recomputing the same Stable ID
 * from separately held inputs would agree only by convention: the day either derivation moved,
 * Near and Far would quietly become different Shrubs, and no invariant could express the break.
 *
 * Everything here is a pure function of the world seed and the cell coordinate. Note the
 * parent: ambient identities descend from the *W5 base* Chunk ID (generator major 500), not
 * from the W8 parity Chunk ID, because the Full generator hands its base-backed chunk to the
 * ambient pass. Deriving it from the parity major silently produces different identities.
 */

export const AMBIENT_DETAIL_KERNEL_SCHEMA = 'w8-ambient-detail-kernel-1';

/** Ambient identities descend from the W5 base Chunk ID, not the W8 parity Chunk ID. */
export const AMBIENT_DETAIL_PARENT_GENERATOR_MAJOR = 500;
export const AMBIENT_DETAIL_FEATURE_TYPE = 'ambient-detail';
/** Ambient identities are minted under the W8 parity generator major. */
export const AMBIENT_DETAIL_GENERATOR_MAJOR = 800;
/** The Full pass keeps only this many details per chunk, ranked by Stable ID. */
export const AMBIENT_DETAIL_MAXIMUM_PER_CHUNK = 48;
export const AMBIENT_DETAIL_STABLE_ID_SCHEMA = 'wf1';

const mix32 = value => {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
};

export function ambientTextSeed(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return mix32(hash);
}

export function ambientUnit(seed, x, z, salt) {
  return mix32(seed ^ Math.imul(x | 0, 0x1f123bb5)
    ^ Math.imul(z | 0, 0x5f356495) ^ Math.imul(salt, 0x9e3779b9)) / 0xffffffff;
}

/** The seed the ambient pass rolls every cell against. */
export function ambientFieldSeed({ worldSeedHash, contentSchemaVersion }) {
  if (typeof worldSeedHash !== 'string' || !worldSeedHash) {
    throw new TypeError('ambient field seed requires a worldSeedHash');
  }
  if (typeof contentSchemaVersion !== 'string' || !contentSchemaVersion) {
    throw new TypeError('ambient field seed requires a content schema version');
  }
  return ambientTextSeed(`${worldSeedHash}:${contentSchemaVersion}`);
}

/** The Chunk ID ambient identities descend from. */
export function ambientParentChunkId({ worldSeedHash, chunkX, chunkZ }) {
  return createChunkId({
    worldSeedHash,
    generatorMajor: AMBIENT_DETAIL_PARENT_GENERATOR_MAJOR,
    chunkCoordinate: { x: chunkX, z: chunkZ },
  });
}

/**
 * Resolves which ambient details a chunk's cells propose, without terrain, settlement or
 * identity work. Callers apply their own exclusions and grounding on top; both tiers share
 * this selection so the two can never disagree about which cell holds what.
 */
export function ambientDetailProposals({
  seed,
  chunkX,
  chunkZ,
  cellSizeMeters,
  acceptanceThreshold = 0.72,
  detailTypes = null,
}) {
  if (!Number.isFinite(seed)) throw new TypeError('ambient proposals require a numeric seed');
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
    throw new TypeError('ambient proposals require integer chunk coordinates');
  }
  if (!(cellSizeMeters > 0)) throw new RangeError('cellSizeMeters must be positive');
  const cellsPerChunk = Math.round(LOGICAL_CHUNK_SIZE_METERS / cellSizeMeters);
  const startCellX = chunkX * cellsPerChunk;
  const startCellZ = chunkZ * cellsPerChunk;
  const wanted = detailTypes ? new Set(detailTypes) : null;
  const proposals = [];
  for (let localZ = 0; localZ < cellsPerChunk; localZ += 1) {
    for (let localX = 0; localX < cellsPerChunk; localX += 1) {
      const cellX = startCellX + localX;
      const cellZ = startCellZ + localZ;
      if (ambientUnit(seed, cellX, cellZ, 1) > acceptanceThreshold) continue;
      const typeRoll = ambientUnit(seed, cellX, cellZ, 4);
      const detailType = typeRoll < 0.66 ? 'grass' : typeRoll < 0.88 ? 'flower' : 'shrub';
      if (wanted && !wanted.has(detailType)) continue;
      proposals.push(Object.freeze({
        cellX,
        cellZ,
        detailType,
        // Same jitter the Full pass applies, so a proposal resolves to the same spot in
        // either tier before grounding.
        x: (cellX + 0.5 + (ambientUnit(seed, cellX, cellZ, 2) - 0.5) * 0.58) * cellSizeMeters,
        z: (cellZ + 0.5 + (ambientUnit(seed, cellX, cellZ, 3) - 0.5) * 0.58) * cellSizeMeters,
        rotationY: ambientUnit(seed, cellX, cellZ, 5) * Math.PI * 2,
        variation: 0.72 + ambientUnit(seed, cellX, cellZ, 6) * 0.56,
      }));
    }
  }
  return Object.freeze(proposals);
}

/** The Stable ID a proposal resolves to. Identical in every tier by construction. */
export async function ambientDetailStableId({
  worldSeedHash,
  generatorMajor = AMBIENT_DETAIL_GENERATOR_MAJOR,
  parentChunkId,
  detailType,
  cellX,
  cellZ,
}) {
  return (await createWorldFeatureId({
    stableIdSchema: AMBIENT_DETAIL_STABLE_ID_SCHEMA,
    worldSeedHash,
    generatorMajor,
    featureType: AMBIENT_DETAIL_FEATURE_TYPE,
    parentStableId: parentChunkId,
    purposeKey: detailType,
    semanticLocalKey: `${cellX}:${cellZ}:slot-0`,
  })).stableId;
}

/**
 * Applies the Full pass's per-chunk cap. Details are ranked by Stable ID and truncated, so a
 * dense chunk drops its tail - a tier that skips this step would keep details the Near tier
 * discarded and present Shrubs that vanish on approach. The ranking runs over *every* ambient
 * type, so a caller interested in one type still has to resolve the identities of the rest.
 */
export function applyAmbientDetailCap(identified, {
  maximumPerChunk = AMBIENT_DETAIL_MAXIMUM_PER_CHUNK,
} = {}) {
  if (!Array.isArray(identified)) throw new TypeError('ambient cap requires an array');
  return Object.freeze([...identified]
    .sort((left, right) => left.stableId.localeCompare(right.stableId))
    .slice(0, maximumPerChunk));
}
