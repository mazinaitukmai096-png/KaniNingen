import { createWorldFeatureId } from './legacy-core/g0/stable-id.js';
import { createDeterministicRandom, deriveLocalSeed64 } from './legacy-core/g0/deterministic-random.js';
import { createChunkKey, logicalWorldToOwnedChunk } from './chunk-coordinates.js';

/**
 * Shared derivation for the resident a Building houses.
 *
 * Human NPCs are Building residents, so which humans exist is a pure function of which
 * Buildings exist. Full residency derives them one way; any tier that wants to show the
 * same people further out must arrive at the same identities, or the far figures would be
 * strangers who vanish when the player walks up to them.
 *
 * Rather than let a second tier re-derive them, both call this kernel. The shrub work
 * showed why that matters: a re-derivation looks correct until some detail of the original
 * (a parent id from a different generator major, a cap applied before publication) turns
 * out to differ, and the mismatch only surfaces as objects appearing and disappearing at a
 * distance boundary.
 *
 * Everything here depends only on the world seed, the generator major and the Building's
 * own Stable ID - never on chunk internals - so a tier holding nothing but a Settlement
 * template can reproduce the population exactly.
 */

export const W8_BUILDING_RESIDENT_KERNEL_SCHEMA = 'w8-building-resident-kernel-1';
export const W8_BUILDING_RESIDENT_PURPOSE_KEY = 'w6-building-resident';

const q6 = value => Math.round(value * 1e6) / 1e6;

/** The Stable ID of the resident of one Building. */
export async function buildingResidentStableId({
  worldSeedHash,
  generatorMajor,
  buildingStableId,
}) {
  if (typeof worldSeedHash !== 'string' || !worldSeedHash) {
    throw new TypeError('worldSeedHash is required');
  }
  if (!Number.isSafeInteger(generatorMajor)) {
    throw new TypeError('generatorMajor must be a safe integer');
  }
  if (typeof buildingStableId !== 'string' || !buildingStableId) {
    throw new TypeError('buildingStableId is required');
  }
  const result = await createWorldFeatureId({
    stableIdSchema: 'wf1',
    worldSeedHash,
    generatorMajor,
    featureType: 'human',
    parentStableId: buildingStableId,
    purposeKey: W8_BUILDING_RESIDENT_PURPOSE_KEY,
    semanticLocalKey: 'ordinal:0',
  });
  return result.stableId;
}

/**
 * Where that resident stands, before any owner clamping or terrain sampling: an angle and a
 * distance drawn from a seed derived from the resident's own Stable ID, so the pose follows
 * the identity rather than the order the tier happened to visit Buildings in.
 */
export async function buildingResidentPose({
  worldSeedHash,
  stableId,
  buildingRadiusMeters = 2,
}) {
  const seed64 = await deriveLocalSeed64({
    worldSeedHash,
    namespace: 'w6-human-spawn',
    semanticKey: stableId,
  });
  const random = createDeterministicRandom(seed64);
  const angle = await random.float01('angle') * Math.PI * 2;
  const distance = (buildingRadiusMeters ?? 2) + 0.75
    + await random.float01('distance') * 0.75;
  return Object.freeze({ angle: q6(angle), distanceMeters: q6(distance) });
}

/**
 * Walks the resident onto a spot inside the Building's owning Chunk.
 *
 * Full residency does not stand the resident wherever the raw angle points: it tries eight
 * angles and takes the first that still falls inside the owner, falling back to the Building
 * itself when none do. A tier that skipped this would agree on who the person is and then
 * draw them somewhere else - measured at up to 10 m apart - so the figure would jump as the
 * player crossed the handoff. The walk needs only the owning Chunk coordinate, which a
 * Settlement template already carries, so it belongs here rather than in either tier.
 */
export function walkBuildingResidentIntoOwner({
  originX,
  originZ,
  angle,
  distanceMeters,
  ownerChunkX,
  ownerChunkZ,
}) {
  if (!Number.isSafeInteger(ownerChunkX) || !Number.isSafeInteger(ownerChunkZ)) {
    return Object.freeze({ x: q6(originX), z: q6(originZ), attempt: null, clamped: true });
  }
  const ownerChunkKey = createChunkKey(ownerChunkX, ownerChunkZ);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidateAngle = angle + attempt * Math.PI / 4;
    const candidateX = originX + Math.cos(candidateAngle) * distanceMeters;
    const candidateZ = originZ + Math.sin(candidateAngle) * distanceMeters;
    if (logicalWorldToOwnedChunk(candidateX, candidateZ).key !== ownerChunkKey) continue;
    return Object.freeze({ x: q6(candidateX), z: q6(candidateZ), attempt, clamped: false });
  }
  // No angle fits: Full residency leaves the resident standing at the Building.
  return Object.freeze({ x: q6(originX), z: q6(originZ), attempt: null, clamped: true });
}

/**
 * Resolves identity and pose together for one Building. `building` needs only a Stable ID,
 * a radius and a world position - the shape a Settlement template already carries, which is
 * what lets a far tier call this without holding chunk data.
 */
export async function resolveBuildingResident({
  worldSeedHash,
  generatorMajor,
  building,
  ownerChunkX = null,
  ownerChunkZ = null,
}) {
  const stableId = await buildingResidentStableId({
    worldSeedHash,
    generatorMajor,
    buildingStableId: building?.stableId,
  });
  const pose = await buildingResidentPose({
    worldSeedHash,
    stableId,
    buildingRadiusMeters: building?.radiusMeters,
  });
  const originX = building?.worldPosition?.x ?? building?.x;
  const originZ = building?.worldPosition?.z ?? building?.z;
  if (!Number.isFinite(originX) || !Number.isFinite(originZ)) {
    throw new TypeError('building must expose a world position');
  }
  // Both tiers walk the same eight angles, so the resident stands in one place whichever
  // tier drew them.
  const placement = walkBuildingResidentIntoOwner({
    originX,
    originZ,
    angle: pose.angle,
    distanceMeters: pose.distanceMeters,
    ownerChunkX: ownerChunkX ?? building?.owningChunkCoordinate?.x,
    ownerChunkZ: ownerChunkZ ?? building?.owningChunkCoordinate?.z,
  });
  return Object.freeze({
    schemaVersion: W8_BUILDING_RESIDENT_KERNEL_SCHEMA,
    stableId,
    buildingStableId: building.stableId,
    angle: pose.angle,
    distanceMeters: pose.distanceMeters,
    x: placement.x,
    z: placement.z,
    placementAttempt: placement.attempt,
    standsAtBuilding: placement.clamped,
    originX: q6(originX),
    originZ: q6(originZ),
  });
}
