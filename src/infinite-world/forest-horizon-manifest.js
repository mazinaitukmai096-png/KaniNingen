import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { resolveCanonicalGroundSurface } from './w8-surface-policy.js';
import { isW8NaturalCandidateVisible } from './w8-natural-presentation-policy.js';

export const W8_FOREST_HORIZON_MANIFEST_SCHEMA = 'w8-forest-horizon-owner-summary-1';

function compactForestHorizonCandidate(candidate, worldPosition, chunk) {
  const formal = candidate?.candidateId !== undefined;
  const owner = candidate?.owningChunkCoordinate ?? {
    x: chunk.chunkX,
    z: chunk.chunkZ,
  };
  const radius = candidate?.metadata?.candidateRadiusMeters
    ?? (candidate?.subtype === 'shrub' ? 0.2 : 0.625);
  return Object.freeze({
    ...(formal
      ? { candidateId: candidate.candidateId }
      : { stableId: candidate?.stableId }),
    candidateType: candidate?.candidateType ?? 'vegetation',
    subtype: candidate?.subtype ?? null,
    variationSeed: candidate?.variationSeed ?? null,
    ...(formal
      ? { orientationSeed: candidate?.orientationSeed ?? 0 }
      : { yawRadians: candidate?.yawRadians ?? 0 }),
    worldPosition: Object.freeze({
      x: worldPosition.x,
      y: worldPosition.y,
      z: worldPosition.z,
    }),
    owningChunkCoordinate: Object.freeze({ x: owner.x, z: owner.z }),
    metadata: Object.freeze({ candidateRadiusMeters: radius }),
  });
}

/**
 * Produces the transferable, presentation-only view needed beyond the exact
 * natural-object range. The records retain their canonical Tree Stable IDs and
 * owner coordinates; only unrelated W8 Chunk payload is discarded.
 */
function resolveForestHorizonVegetation(chunk) {
  const source = chunk.presentationLayers?.natural?.vegetation
    ?? chunk.vegetationCandidates
    ?? chunk.vegetationProxies
    ?? [];
  return Object.freeze(source
    .filter(candidate => candidate?.subtype !== 'shrub')
    .filter(candidate => (
      candidate?.candidateId === undefined
      || chunk.generatorVersion?.major < 800
      || isW8NaturalCandidateVisible(candidate)
    ))
    .map(candidate => {
      const worldPosition = chunk.canonicalSurfacePolicy
        ? {
          ...candidate.worldPosition,
          y: resolveCanonicalGroundSurface({
            chunkData: chunk,
            worldX: candidate.worldPosition.x,
            worldZ: candidate.worldPosition.z,
          }).heightMeters,
        }
        : candidate.worldPosition;
      return compactForestHorizonCandidate(candidate, worldPosition, chunk);
    }));
}

function assembleForestHorizonManifest(chunk, vegetation, contentHash) {
  return Object.freeze({
    schemaVersion: W8_FOREST_HORIZON_MANIFEST_SCHEMA,
    chunkId: chunk.chunkId,
    chunkX: chunk.chunkX,
    chunkZ: chunk.chunkZ,
    contentHash,
    sourceW5ContentHash: chunk.sourceW5ContentHash ?? chunk.sourceChunkData?.contentHash ?? null,
    generatorVersion: chunk.generatorVersion,
    presentationLayers: Object.freeze({
      natural: Object.freeze({
        vegetation: Object.freeze(vegetation),
        rocks: Object.freeze([]),
      }),
    }),
  });
}

export async function hashW8ForestHorizonManifestContent({
  chunk,
  vegetation,
} = {}) {
  if (!chunk || !Array.isArray(vegetation)) {
    throw new TypeError('Forest horizon manifest content is required');
  }
  return `sha256:${await sha256Hex(canonicalizeJson({
    schemaVersion: W8_FOREST_HORIZON_MANIFEST_SCHEMA,
    chunkId: chunk.chunkId,
    chunkX: chunk.chunkX,
    chunkZ: chunk.chunkZ,
    sourceW5ContentHash: chunk.sourceW5ContentHash
      ?? chunk.sourceChunkData?.contentHash
      ?? null,
    generatorVersion: chunk.generatorVersion,
    canonicalSurfacePolicy: chunk.canonicalSurfacePolicy ?? null,
    vegetation,
  }))}`;
}

/**
 * Compacts an already-generated Chunk synchronously. Its full Chunk hash is
 * retained because callers may already use that identity in a read-through
 * cache.
 */
export function createW8ForestHorizonManifest(chunk) {
  if (!chunk) return null;
  if (chunk.schemaVersion === W8_FOREST_HORIZON_MANIFEST_SCHEMA) return chunk;
  return assembleForestHorizonManifest(
    chunk,
    resolveForestHorizonVegetation(chunk),
    chunk.contentHash,
  );
}

/**
 * Builds a manifest directly from the shared canonical W8 context. This path
 * intentionally has its own content hash so no full W8 Chunk has to be
 * materialized merely to obtain the full Chunk hash.
 */
export async function createHashedW8ForestHorizonManifest(chunk) {
  if (!chunk) return null;
  if (chunk.schemaVersion === W8_FOREST_HORIZON_MANIFEST_SCHEMA) return chunk;
  const vegetation = resolveForestHorizonVegetation(chunk);
  const contentHash = await hashW8ForestHorizonManifestContent({ chunk, vegetation });
  return assembleForestHorizonManifest(chunk, vegetation, contentHash);
}
