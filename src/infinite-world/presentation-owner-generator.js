import { createChunkId } from './legacy-core/g0/chunk-id.js';
import { resolveBuildingResident } from './building-resident-kernel.js';
import {
  ambientDetailProposals,
  ambientDetailStableId,
  ambientFieldSeed,
  ambientParentChunkId,
  applyAmbientDetailCap,
} from './ambient-detail-kernel.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { hashWorldSeed, normalizeWorldSeed } from './legacy-core/g0/seed.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { createChunkKey, LOGICAL_CHUNK_SIZE_METERS } from './chunk-coordinates.js';
import {
  projectMigratedSettlementTemplate,
  settlementTemplateConflictsWithCandidate,
} from './distributed-settlement-chunk-generator.js';
import { createFormalNaturalCandidateKernel } from './formal-natural-chunk-generator.js';
import { createSharedCanonicalNaturalKernel } from './natural-chunk-generator.js';
import {
  W8_NATURAL_PRESENTATION_PHASE_1,
  createW8NaturalPresentationPhase1Policy,
} from './w8-natural-presentation-policy.js';
import {
  W8_CANONICAL_TREE_DENSITY_THRESHOLDS,
  resolveW8CanonicalFarTreeDensityRank,
} from './vegetation-lod-policy.js';
import { resolveW8CanonicalWorldObject } from './world-object-canonical-contract.js';
import { createCanonicalRiverProjection } from './canonical-river-realization.js';
import {
  W8_CANONICAL_NATURAL_GROUND_REVISION,
  W8_SHARED_CANONICAL_GROUND_REVISION,
  createSharedCanonicalGroundKernel,
  createSettlementSurfacePolicy,
} from './w8-surface-policy.js';

export const PRESENTATION_OWNER_SCHEMA = 'w8-presentation-owner-1';
export const PRESENTATION_OWNER_SHARED_CORE_REVISION =
  `${W8_SHARED_CANONICAL_GROUND_REVISION}:${W8_CANONICAL_NATURAL_GROUND_REVISION}:formal-natural-candidate-kernel-1`;
export const W8_CANONICAL_TREE_CELL_SCHEMA = 'w8-canonical-tree-cell-5';
export const W8_CANONICAL_NATURAL_PRESENCE_SCHEMA = 'w8-canonical-natural-presence-4';
export const W8_CANONICAL_TREE_PREPARER_REVISION =
  `${PRESENTATION_OWNER_SHARED_CORE_REVISION}:${W8_NATURAL_PRESENTATION_PHASE_1.schemaVersion}:production-exclusions-1:decorative-bush-only-1:canonical-rock-presence-5`;
export const W8_CANONICAL_TREE_MACRO_SIZE_METERS = 64;
export const W8_CANONICAL_TREE_OWNERS_PER_AXIS =
  W8_CANONICAL_TREE_MACRO_SIZE_METERS / LOGICAL_CHUNK_SIZE_METERS;
const PRESENTATION_CANONICAL_GENERATOR_MAJOR = 8;
// Residents must be parented exactly as Full residency parents them, or the far figures
// would be different people wearing the same buildings.
const RESIDENT_GENERATOR_MAJOR = 800;
// Macro Natural presence reaches past Full residency across every owner in the
// Presentation view, so this cap is multiplied by roughly 1,700 chunks -- each
// extra rock per owner is thousands of additional instances.
const W8_CANONICAL_NATURAL_PRESENCE_MAX_ROCKS_PER_OWNER = 4;

// --- S-2: Mid Grass field -------------------------------------------------
// Ambient Grass is generated only by Full residency, which is pinned at 100 m by worker
// throughput, so beyond that the ground had no Grass at all. The Mid band instead carries
// an identity-free Grass *field*: deterministic cluster positions, no Stable ID, no Save
// participation. Giving these clusters canonical identities is explicitly forbidden -
// they have no Near counterpart, and 'Far-only synthetic Grass objects are forbidden from
// Macro Natural presence'. They are a representation of grassland, not world objects.
//
// 8 m cells keep the draw budget at Tree scale (about 2,900 clusters across the Mid ring
// against roughly 2,100 Trees); each cluster carries the blades that one Near-density
// patch of that area would hold, so density and silhouette match the Near field.
// Shrub is Near-only ambient decoration today: Full residency authors it and stops at 100 m,
// which is why the Bush band ends abruptly once Grass reaches the horizon. Unlike Grass it
// carries a collision radius and a canonical identity, so it cannot become an identity-free
// field - it has to be the *same* object at both distances. The shared ambient kernel makes
// that a property of calling one function rather than of two derivations staying in step.
export const W8_CANONICAL_SHRUB_FIELD_SCHEMA = 'w8-canonical-shrub-field-1';
export const W8_AMBIENT_CELL_SIZE_METERS = 2;
export const W8_AMBIENT_CONTENT_SCHEMA_VERSION = 'w8-finite-experience-content-1';

export const W8_CANONICAL_GRASS_FIELD_SCHEMA = 'w8-canonical-grass-field-1';
const GRASS_FIELD_CELL_SIZE_METERS = 8;
const GRASS_FIELD_ACCEPTANCE = 0.48;
export const W8_GRASS_CLUSTER_DETAIL_COUNT = 16;

const grassMix32 = value => {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
};
const grassTextSeed = value => {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return grassMix32(hash);
};
// Cheap deterministic unit hash. Stable IDs are deliberately not used here: they cost
// about 35 us each through async Web Crypto, and identity is exactly what this field
// must not have.
const grassUnit = (seed, x, z, salt) => grassMix32(
  seed ^ Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(z | 0, 0x5f356495)
    ^ Math.imul(salt, 0x9e3779b9),
) / 0xffffffff;
// Far Rock presentation is a deterministic subset of the exact canonical Rock
// proposal lattice. It is sparse by design so the existing Tree Macro path does
// not regain the Rock-generation cost that previously hurt Streaming.
// Far Rock presence previously sampled only 1/16 of the Rock proposals, which left
// 0-1 Rocks per 64 m canonical cell against 16-28 Trees: beyond Full residency the world
// simply had no Rocks, while Trees were complete. Sampling every proposal restores Rock
// density to Tree-comparable levels (measured 9-15 per cell) for ~31% more owner
// generation time; the per-owner MAX_ROCKS_PER_OWNER cap still bounds the worst case.
const W8_CANONICAL_NATURAL_PRESENCE_ROCK_PROPOSAL_SAMPLE_RATE = 1;

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const frozenPosition = position => Object.freeze([
  q6(position.x),
  q6(position.y ?? 0),
  q6(position.z),
]);

const frozenDimensions = dimensions => Object.freeze([
  q6(dimensions?.width ?? 0),
  q6(dimensions?.height ?? 0),
  q6(dimensions?.depth ?? 0),
]);

function ownerSummary(owner, includeKey = false) {
  if (!Number.isSafeInteger(owner?.x) || !Number.isSafeInteger(owner?.z)) {
    throw new TypeError('Presentation object owner is required');
  }
  const key = createChunkKey(owner.x, owner.z);
  return includeKey ? Object.freeze({ x: owner.x, z: owner.z, key }) : key;
}

function compactNatural(source) {
  const canonical = resolveW8CanonicalWorldObject(source);
  if (!['tree', 'shrub', 'rock', 'grass'].includes(canonical.objectType)) {
    throw new TypeError('Presentation Natural supports Tree, Bush/Shrub, Grass, and Rock only');
  }
  const position = frozenPosition(canonical.position);
  return Object.freeze({
    stableId: canonical.stableId,
    owner: ownerSummary(canonical.owner),
    position,
    objectType: canonical.objectType,
    subtype: canonical.subtype ?? canonical.extension?.subtype ?? null,
    visualKind: canonical.presentation.partSetKey,
    dimensions: frozenDimensions(canonical.visualBounds),
    rotationY: q6(canonical.rotation.y),
    variationSeed: canonical.extension?.variationSeed ?? null,
    densityRank: q6(resolveW8CanonicalFarTreeDensityRank(canonical.stableId)),
    paletteKey: `${canonical.objectType}:${canonical.presentation.partSetKey}`,
  });
}

function compactRoad(source) {
  const owner = source.owningChunkCoordinate ?? source.projectionOwner;
  const position = source.worldPosition ?? {
    x: ((source.start?.x ?? 0) + (source.end?.x ?? 0)) / 2,
    y: 0,
    z: ((source.start?.z ?? 0) + (source.end?.z ?? 0)) / 2,
  };
  return Object.freeze({
    stableId: source.stableId,
    sourceStableId: source.sourceStableId ?? source.stableId,
    owner: ownerSummary(owner),
    projectionOwner: ownerSummary(source.projectionOwner ?? owner),
    objectType: 'road',
    featureType: 'settlement-road',
    archetypeKey: source.roadClass ?? source.roadType ?? 'road',
    position: frozenPosition(position),
    dimensions: Object.freeze([
      q6(source.widthMeters ?? 0),
      0,
      q6(source.lengthMeters ?? Math.hypot(
        (source.end?.x ?? position.x) - (source.start?.x ?? position.x),
        (source.end?.z ?? position.z) - (source.start?.z ?? position.z),
      )),
    ]),
    rotationY: q6(source.rotationY ?? Math.atan2(
      (source.end?.x ?? position.x) - (source.start?.x ?? position.x),
      (source.end?.z ?? position.z) - (source.start?.z ?? position.z),
    )),
    start: source.start ? Object.freeze(Number.isFinite(source.start.y)
      ? [q6(source.start.x), q6(source.start.y), q6(source.start.z)]
      : [q6(source.start.x), q6(source.start.z)]) : null,
    end: source.end ? Object.freeze(Number.isFinite(source.end.y)
      ? [q6(source.end.x), q6(source.end.y), q6(source.end.z)]
      : [q6(source.end.x), q6(source.end.z)]) : null,
    settlementId: source.settlementId ?? null,
    settlementType: source.settlementType ?? null,
    canonicalMajorRoad: source.canonicalMajorRoad === true,
    colors: null,
  });
}

function compactStructure(source) {
  if (source?.featureType === 'settlement-road' || source?.objectType === 'road') {
    return compactRoad(source);
  }
  const canonical = resolveW8CanonicalWorldObject(source);
  return Object.freeze({
    stableId: canonical.stableId,
    sourceStableId: source.sourceStableId ?? canonical.stableId,
    owner: ownerSummary(canonical.owner),
    projectionOwner: ownerSummary(source.projectionOwner ?? canonical.owner),
    objectType: canonical.objectType,
    featureType: source.featureType ?? canonical.extension?.sourceKind ?? null,
    archetypeKey: canonical.presentation.partSetKey,
    position: frozenPosition(canonical.position),
    dimensions: frozenDimensions(canonical.visualBounds),
    rotationY: q6(canonical.rotation.y),
    radiusMeters: q6(source.radiusMeters ?? canonical.collision?.radiusMeters ?? 0),
    settlementId: source.settlementId ?? canonical.extension?.settlementId ?? null,
    settlementType: source.settlementType ?? canonical.extension?.settlementType ?? null,
    townType: source.townType ?? canonical.extension?.townType ?? null,
    visual: source.visual ?? null,
  });
}

function compactReference(reference) {
  if (!reference || typeof reference !== 'object') return null;
  const stableId = reference.stableId ?? reference.sourceStableId
    ?? reference.settlementId ?? null;
  if (!stableId) return null;
  return Object.freeze({
    stableId,
    kind: reference.kind ?? reference.schemaVersion ?? null,
    ...(reference.settlementId ? { settlementId: reference.settlementId } : {}),
    ...(reference.settlementType ? { settlementType: reference.settlementType } : {}),
    ...(reference.townType ? { townType: reference.townType } : {}),
    center: reference.center && Number.isFinite(reference.center.x)
      ? Object.freeze({ x: q6(reference.center.x), z: q6(reference.center.z) }) : null,
    radiusMeters: Number.isFinite(reference.radiusMeters)
      ? q6(reference.radiusMeters) : null,
    influenceRadiusMeters: Number.isFinite(reference.influenceRadiusMeters)
      ? q6(reference.influenceRadiusMeters) : null,
    macroRegion: reference.macroRegion && Number.isSafeInteger(reference.macroRegion.x)
      ? Object.freeze({ x: reference.macroRegion.x, z: reference.macroRegion.z }) : null,
  });
}

function compactAuxiliary(record) {
  if (!record || typeof record !== 'object' || typeof record.stableId !== 'string') {
    throw new TypeError('Presentation auxiliary record requires a Stable ID');
  }
  return Object.freeze({
    stableId: record.stableId,
    kind: record.waterType ?? record.landmarkType ?? record.detailType
      ?? record.featureType ?? 'presentation-detail',
    owner: record.owningChunkCoordinate ? ownerSummary(record.owningChunkCoordinate) : null,
    position: record.worldPosition ? frozenPosition(record.worldPosition) : null,
    dimensions: record.worldPosition ? Object.freeze([
      q6(record.widthMeters ?? 0),
      q6(record.heightMeters ?? 0),
      q6(record.depthMeters ?? 0),
    ]) : null,
    rotationY: q6(record.rotationY ?? 0),
    parentSettlementId: record.parentSettlementId ?? record.settlementId ?? null,
    settlementId: record.settlementId ?? record.parentSettlementId ?? null,
    settlementType: record.settlementType ?? null,
    townType: record.townType ?? null,
    landmarkType: record.landmarkType ?? null,
    parentRoadStableId: record.parentRoadStableId ?? null,
    waterType: record.waterType ?? null,
    detailType: record.detailType ?? null,
    featureType: record.featureType ?? null,
  });
}

export function createPresentationOwnerResource({
  worldSeedHash,
  chunkX,
  chunkZ,
  naturalCandidates = [],
  structures = [],
  settlementRegionRefs = [],
  riverCorridorRefs = [],
  water = [],
  landmarks = [],
  street = [],
} = {}) {
  if (typeof worldSeedHash !== 'string' || !worldSeedHash
    || !Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
    throw new TypeError('PresentationOwner identity is required');
  }
  const owner = ownerSummary({ x: chunkX, z: chunkZ }, true);
  const resource = Object.freeze({
    schemaVersion: PRESENTATION_OWNER_SCHEMA,
    identity: Object.freeze({
      owner,
      chunkId: createChunkId({
        worldSeedHash,
        generatorMajor: PRESENTATION_CANONICAL_GENERATOR_MAJOR,
        chunkCoordinate: { x: chunkX, z: chunkZ },
      }),
      sharedCoreRevision: PRESENTATION_OWNER_SHARED_CORE_REVISION,
    }),
    surface: Object.freeze({
      settlementRegionRefs: Object.freeze(settlementRegionRefs.map(compactReference).filter(Boolean)),
      riverCorridorRefs: Object.freeze(riverCorridorRefs.map(compactReference).filter(Boolean)),
    }),
    natural: Object.freeze(naturalCandidates.map(compactNatural)
      .sort((left, right) => left.stableId.localeCompare(right.stableId))),
    structures: Object.freeze(structures.map(compactStructure)
      .sort((left, right) => left.stableId.localeCompare(right.stableId))),
    water: Object.freeze(water.map(compactAuxiliary)
      .sort((left, right) => left.stableId.localeCompare(right.stableId))),
    landmarks: Object.freeze(landmarks.map(compactAuxiliary)
      .sort((left, right) => left.stableId.localeCompare(right.stableId))),
    street: Object.freeze(street.map(compactAuxiliary)
      .sort((left, right) => left.stableId.localeCompare(right.stableId))),
  });
  const validation = validatePresentationOwnerResource(resource);
  if (!validation.valid) {
    throw new Error(`invalid PresentationOwner: ${validation.errors.join('; ')}`);
  }
  return resource;
}

export function validatePresentationOwnerResource(resource) {
  const errors = [];
  if (resource?.schemaVersion !== PRESENTATION_OWNER_SCHEMA) {
    errors.push('invalid PresentationOwner schema');
  }
  if (resource?.identity?.sharedCoreRevision !== PRESENTATION_OWNER_SHARED_CORE_REVISION) {
    errors.push('invalid shared core revision');
  }
  const owner = resource?.identity?.owner;
  if (!Number.isSafeInteger(owner?.x) || !Number.isSafeInteger(owner?.z)
    || owner?.key !== createChunkKey(owner?.x, owner?.z)) {
    errors.push('invalid PresentationOwner owner');
  }
  const ids = new Set();
  for (const record of [...(resource?.natural ?? []), ...(resource?.structures ?? [])]) {
    if (typeof record?.stableId !== 'string' || !record.stableId || ids.has(record.stableId)) {
      errors.push('invalid or duplicate Presentation Stable ID');
      break;
    }
    ids.add(record.stableId);
    if (![record.position?.[0], record.position?.[1], record.position?.[2],
      record.rotationY].every(Number.isFinite)) {
      errors.push(`non-finite Presentation object: ${record.stableId}`);
      break;
    }
  }
  if ('terrain' in (resource ?? {}) || 'grass' in (resource ?? {})
    || 'gameplay' in (resource ?? {}) || 'collision' in (resource ?? {})
    || 'generationProof' in (resource ?? {}) || 'contentHash' in (resource ?? {})) {
    errors.push('forbidden Full-only field in PresentationOwner');
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

function parseCompactOwner(ownerKey) {
  const match = /^(-?\d+),(-?\d+)$/.exec(ownerKey ?? '');
  if (!match) throw new TypeError(`invalid compact Presentation owner: ${ownerKey}`);
  const owner = { x: Number(match[1]), z: Number(match[2]) };
  if (!Number.isSafeInteger(owner.x) || !Number.isSafeInteger(owner.z)) {
    throw new TypeError(`invalid compact Presentation owner: ${ownerKey}`);
  }
  return Object.freeze(owner);
}

const expandPosition = value => Object.freeze({
  x: value[0], y: value[1], z: value[2],
});

/** Expands only the canonical fields required by the existing renderer. */
export function expandPresentationNaturalRecord(record) {
  if (!record || !['tree', 'shrub', 'rock', 'grass'].includes(record.objectType)) {
    throw new TypeError('compact Presentation Natural record is required');
  }
  const position = expandPosition(record.position);
  const owner = parseCompactOwner(record.owner);
  const source = record.objectType === 'grass'
    ? Object.freeze({
      stableId: record.stableId,
      detailType: 'grass',
      worldPosition: position,
      owningChunkCoordinate: owner,
      rotationY: record.rotationY,
      variation: 1,
    })
    : Object.freeze({
      candidateId: record.stableId,
      candidateType: record.objectType === 'rock' ? 'rock' : 'vegetation',
      subtype: record.subtype,
      variationSeed: record.variationSeed,
      orientationSeed: record.rotationY / (Math.PI * 2),
      worldPosition: position,
      owningChunkCoordinate: owner,
      metadata: Object.freeze({
        candidateRadiusMeters: record.objectType === 'rock'
          ? record.dimensions[0] / 2 : record.objectType === 'shrub' ? 0.2 : 0.625,
        boundsType: 'horizontal-circle',
      }),
    });
  const resolved = resolveW8CanonicalWorldObject(source);
  const visualBounds = Object.freeze({
    width: record.dimensions[0],
    height: record.dimensions[1],
    depth: record.dimensions[2],
  });
  const matrixScale = record.objectType === 'rock' ? 0.5 : 1;
  return Object.freeze({
    ...resolved,
    // Preserve the compact resource's deterministic selection input through
    // expansion. Renderers may independently recompute the same Stable-ID
    // hash for validation, but must not need a second identity source.
    densityRank: record.densityRank,
    coarsePresenceKind: record.coarsePresenceKind ?? null,
    position,
    worldPosition: position,
    rotation: Object.freeze({ y: record.rotationY }),
    rotationY: record.rotationY,
    visualBounds,
    widthMeters: record.dimensions[0] * matrixScale,
    heightMeters: record.dimensions[1] * matrixScale,
    depthMeters: record.dimensions[2] * matrixScale,
  });
}

export function expandPresentationStructureRecord(record) {
  if (!record || !['building', 'road'].includes(record.objectType)) {
    throw new TypeError('compact Presentation structure record is required');
  }
  const position = expandPosition(record.position);
  const owner = parseCompactOwner(record.owner);
  if (record.objectType === 'road') {
    const start = record.start
      ? Object.freeze({
        x: record.start[0],
        ...(record.start.length > 2 ? { y: record.start[1] } : {}),
        z: record.start.at(-1),
      }) : position;
    const end = record.end
      ? Object.freeze({
        x: record.end[0],
        ...(record.end.length > 2 ? { y: record.end[1] } : {}),
        z: record.end.at(-1),
      }) : position;
    return Object.freeze({
      stableId: record.stableId,
      sourceStableId: record.sourceStableId,
      featureType: 'settlement-road',
      roadClass: record.archetypeKey,
      settlementId: record.settlementId,
      settlementType: record.settlementType,
      canonicalMajorRoad: record.canonicalMajorRoad === true,
      start,
      end,
      widthMeters: record.dimensions[0],
      lengthMeters: record.dimensions[2],
      rotationY: record.rotationY,
      worldPosition: position,
      owningChunkCoordinate: owner,
    });
  }
  const dimensions = record.dimensions;
  const visual = record.visual ?? (record.colors ? Object.freeze({
    wallColor: record.colors.wall,
    roofColor: record.colors.roof,
    variant: record.colors.variant,
  }) : null);
  return resolveW8CanonicalWorldObject(Object.freeze({
    stableId: record.stableId,
    sourceStableId: record.sourceStableId,
    featureType: 'settlement-building',
    buildingType: record.archetypeKey,
    settlementId: record.settlementId,
    settlementType: record.settlementType,
    townType: record.townType,
    radiusMeters: record.radiusMeters,
    widthMeters: dimensions[0],
    heightMeters: dimensions[1],
    depthMeters: dimensions[2],
    rotationY: record.rotationY,
    worldPosition: position,
    owningChunkCoordinate: owner,
    ...(visual ? { visual } : {}),
  }));
}

export function expandPresentationAuxiliaryRecord(record) {
  if (!record || typeof record.stableId !== 'string') {
    throw new TypeError('compact Presentation auxiliary record is required');
  }
  const owner = record.owner ? parseCompactOwner(record.owner) : null;
  const position = record.position ? expandPosition(record.position) : null;
  return Object.freeze({
    stableId: record.stableId,
    ...(record.parentSettlementId ? { parentSettlementId: record.parentSettlementId } : {}),
    ...(record.settlementId ? { settlementId: record.settlementId } : {}),
    ...(record.settlementType ? { settlementType: record.settlementType } : {}),
    ...(record.townType ? { townType: record.townType } : {}),
    ...(record.landmarkType ? { landmarkType: record.landmarkType } : {}),
    ...(record.parentRoadStableId ? { parentRoadStableId: record.parentRoadStableId } : {}),
    ...(record.waterType ? { waterType: record.waterType } : {}),
    ...(record.detailType ? { detailType: record.detailType } : {}),
    ...(record.featureType ? { featureType: record.featureType } : {}),
    ...(position ? { worldPosition: position } : {}),
    ...(owner ? { owningChunkCoordinate: owner } : {}),
    widthMeters: record.dimensions?.[0] ?? 0,
    heightMeters: record.dimensions?.[1] ?? 0,
    depthMeters: record.dimensions?.[2] ?? 0,
    rotationY: record.rotationY ?? 0,
  });
}

export function presentationOwnerResourceOf(value) {
  if (value?.schemaVersion === PRESENTATION_OWNER_SCHEMA) return value;
  if (value?.resource?.schemaVersion === PRESENTATION_OWNER_SCHEMA) return value.resource;
  return null;
}

function recordInsidePresentationOwnerDomain(resource, record) {
  // The canonical owner cell is the only observer-independent spatial
  // criterion available to an immutable summary. Runtime owner admission is
  // based on that cell intersecting the 0-300 m domain, so the presenter must
  // keep every admitted anchor drawable through the cell's far corner.
  const owner = resource?.identity?.owner;
  if (!Number.isSafeInteger(owner?.x) || !Number.isSafeInteger(owner?.z)
    || record?.owner !== owner.key) return false;
  const worldX = Number(record?.position?.[0]);
  const worldZ = Number(record?.position?.[2]);
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) return false;
  const minimumX = owner.x * LOGICAL_CHUNK_SIZE_METERS;
  const minimumZ = owner.z * LOGICAL_CHUNK_SIZE_METERS;
  return worldX >= minimumX && worldX < minimumX + LOGICAL_CHUNK_SIZE_METERS
    && worldZ >= minimumZ && worldZ < minimumZ + LOGICAL_CHUNK_SIZE_METERS;
}

/**
 * Derives the coarse world-existence contract from the existing compact
 * PresentationOwner.  This is an immutable summary/index only: it creates no
 * request, queue, visual identity, or handoff state.
 */
export function derivePresentationOwnerCoarseSummary(value, {
  // Kept for call-site compatibility. Coarse requirements intentionally do
  // not depend on the observer: an immutable owner resource must resolve to
  // the same contract before, during, and after a player crossing.
  playerX: _playerX = null,
  playerZ: _playerZ = null,
  maximumDistanceMeters: _maximumDistanceMeters = Number.POSITIVE_INFINITY,
} = {}) {
  const resource = presentationOwnerResourceOf(value);
  if (!resource) throw new TypeError('PresentationOwner resource is required');
  const structureStableIds = [...new Set((resource.structures ?? [])
    // Require authored Building silhouettes and only roads explicitly marked
    // as canonical major layout. Ordinary split road segments remain useful
    // coarse detail without turning one continuous road into an artificial
    // all-segments barrier.
    .filter(record => recordInsidePresentationOwnerDomain(resource, record)
      && (record?.objectType === 'building'
        || (record?.objectType === 'road' && record.canonicalMajorRoad === true)))
    .map(record => record.stableId)
    .filter(stableId => typeof stableId === 'string' && stableId))]
    .sort((left, right) => left.localeCompare(right));
  const trees = (resource.natural ?? [])
    .filter(record => recordInsidePresentationOwnerDomain(resource, record)
      && record?.objectType === 'tree'
      && typeof record.stableId === 'string' && record.stableId)
    .map(record => Object.freeze({
      stableId: record.stableId,
      densityRank: Number.isFinite(record.densityRank)
        ? record.densityRank : resolveW8CanonicalFarTreeDensityRank(record.stableId),
    }))
    .sort((left, right) => left.densityRank - right.densityRank
      || left.stableId.localeCompare(right.stableId));
  const selectedForest = trees.filter(tree => (
    tree.densityRank < W8_CANONICAL_TREE_DENSITY_THRESHOLDS.far
  ));
  return Object.freeze({
    schemaVersion: 'presentation-owner-coarse-summary-1',
    ownerKey: resource.identity.owner.key,
    terrainRequired: true,
    structureStableIds: Object.freeze(structureStableIds),
    selectedForestStableIds: Object.freeze(selectedForest.map(tree => tree.stableId)),
    canonicalTreeCount: trees.length,
  });
}

function assertCanonicalTreeMacroCoordinate(value, name) {
  if (!Number.isSafeInteger(value)
    || !Number.isSafeInteger(value * W8_CANONICAL_TREE_OWNERS_PER_AXIS)) {
    throw new RangeError(`${name} must be a safe Macro coordinate`);
  }
}

function canonicalTreeCellBounds(macroX, macroZ) {
  const minimumX = macroX * W8_CANONICAL_TREE_MACRO_SIZE_METERS;
  const minimumZ = macroZ * W8_CANONICAL_TREE_MACRO_SIZE_METERS;
  const maximumExclusiveX = minimumX + W8_CANONICAL_TREE_MACRO_SIZE_METERS;
  const maximumExclusiveZ = minimumZ + W8_CANONICAL_TREE_MACRO_SIZE_METERS;
  if (![minimumX, minimumZ, maximumExclusiveX, maximumExclusiveZ]
    .every(Number.isSafeInteger)) {
    throw new RangeError('canonical Tree cell bounds exceed safe coordinates');
  }
  return Object.freeze({
    minimumX,
    minimumZ,
    maximumExclusiveX,
    maximumExclusiveZ,
    sizeMeters: W8_CANONICAL_TREE_MACRO_SIZE_METERS,
  });
}

async function hashCanonicalTreeCellContent(content) {
  return `sha256:${await sha256Hex(canonicalizeJson(content))}`;
}

function createGenerationControl(checkpoint = null, cooperativeCheckpoint = null) {
  if (checkpoint !== null && typeof checkpoint !== 'function') {
    throw new TypeError('Presentation owner checkpoint must be a function when provided');
  }
  if (cooperativeCheckpoint !== null && typeof cooperativeCheckpoint !== 'function') {
    throw new TypeError('Presentation owner cooperative checkpoint must be a function when provided');
  }
  return checkpoint || cooperativeCheckpoint
    ? Object.freeze({ checkpoint, cooperativeCheckpoint }) : null;
}

async function reachGenerationCheckpoint(control) {
  if (!control) return;
  if (control.cooperativeCheckpoint) await control.cooperativeCheckpoint();
  else control.checkpoint?.();
}

/**
 * Purpose-built Stage 1 generator. It evaluates only Natural lattice samples
 * reached by semantic candidates and consumes compact settlement/structure
 * context from the existing sparse stream. It never builds Full ChunkData.
 */
export async function createPresentationOwnerGenerator({
  worldSeed = 'KaniNingen Infinite Natural World',
  experienceSpawn = null,
  resolvePresentationContext = null,
  resolvePresentationContexts = null,
  resolveCanonicalNaturalCandidates = null,
} = {}) {
  const normalizedWorldSeed = normalizeWorldSeed(worldSeed);
  const { worldSeedHash } = await hashWorldSeed(normalizedWorldSeed);
  const [naturalKernel, candidateKernel, naturalPolicy] = await Promise.all([
    createSharedCanonicalNaturalKernel({ worldSeedHash }),
    createFormalNaturalCandidateKernel({ worldSeedHash }),
    createW8NaturalPresentationPhase1Policy({ worldSeedHash }),
  ]);
  if (resolveCanonicalNaturalCandidates !== null
    && typeof resolveCanonicalNaturalCandidates !== 'function') {
    throw new TypeError('resolveCanonicalNaturalCandidates must be a function');
  }
  const prepareOwner = async (chunkX, chunkZ, {
    includeRocks = true,
    includeCoarsePresence = false,
    includeGrassField = false,
    includeShrubField = false,
    includeResidents = false,
    materializePresentationOwner = true,
    resolvedContext = undefined,
    resolvedContextPromise = null,
    resolvedCandidates = undefined,
    rockProposalSampleRate = 1,
    sharedRockFieldCache = null,
    checkpoint = null,
    cooperativeCheckpoint = null,
  } = {}) => {
    if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
      throw new TypeError('Presentation owner coordinates are required');
    }
    if (typeof includeRocks !== 'boolean') {
      throw new TypeError('includeRocks must be boolean');
    }
    if (typeof includeShrubField !== 'boolean') {
      throw new TypeError('includeShrubField must be boolean');
    }
    if (typeof includeGrassField !== 'boolean') {
      throw new TypeError('includeGrassField must be boolean');
    }
    if (typeof includeCoarsePresence !== 'boolean') {
      throw new TypeError('includeCoarsePresence must be boolean');
    }
    if (typeof materializePresentationOwner !== 'boolean') {
      throw new TypeError('materializePresentationOwner must be boolean');
    }
    if (!Number.isFinite(rockProposalSampleRate) || rockProposalSampleRate <= 0 || rockProposalSampleRate > 1) {
      throw new RangeError('rockProposalSampleRate must be in (0, 1]');
    }
    if (sharedRockFieldCache !== null && !(sharedRockFieldCache instanceof Map)) {
      throw new TypeError('sharedRockFieldCache must be a Map');
    }
    if (resolvedContextPromise !== null
      && typeof resolvedContextPromise?.then !== 'function') {
      throw new TypeError('resolvedContextPromise must be Promise-like');
    }
    const generationControl = createGenerationControl(checkpoint, cooperativeCheckpoint);
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    let contextReadyAt = startedAt;
    const pendingContext = Promise.resolve(resolvedContextPromise ?? (
      resolvedContext === undefined && resolvePresentationContext
        ? resolvePresentationContext({
          chunkX,
          chunkZ,
          ownerKey: createChunkKey(chunkX, chunkZ),
        }) : resolvedContext
    )).then(value => {
      contextReadyAt = globalThis.performance?.now?.() ?? Date.now();
      return value ?? {};
    });
    // Reuse only the immutable formal candidates. Settlement/Road/River
    // projection, exclusions, final-ground anchoring, and Stable-ID selection
    // still execute through this purpose-built PresentationOwner path.
    const reusableCandidates = resolvedCandidates ?? resolveCanonicalNaturalCandidates?.({
      chunkX,
      chunkZ,
      ownerKey: createChunkKey(chunkX, chunkZ),
    }) ?? null;
    if (reusableCandidates !== null
      && (!Array.isArray(reusableCandidates.vegetationCandidates)
        || !Array.isArray(reusableCandidates.rockCandidates))) {
      throw new TypeError('resolved canonical Natural candidates are invalid');
    }
    const ownerSampler = naturalKernel.createOwnerSampler(chunkX, chunkZ);
    const sampleTerrainAt = (_chunk, point, candidateKind) => ownerSampler.sampleTerrain(
      point,
      { includeMaterials: candidateKind === 'rock' },
    );
    const sampleBiomeWeightsAt = (_chunk, point) => ownerSampler.sampleBiomeWeights(point);
    let candidatesReadyAt = startedAt;
    const pendingCandidates = reusableCandidates === null ? (async () => {
      const vegetationGeneration = await candidateKernel.generateVegetation({
        chunk: { chunkX, chunkZ, worldSeedHash },
        sampleTerrainAt,
        sampleBiomeWeightsAt,
        ...(generationControl ?? {}),
      });
      const rockGeneration = includeRocks
        ? await candidateKernel.generateRocks({
          chunk: { chunkX, chunkZ, worldSeedHash },
          vegetationCandidates: vegetationGeneration.vegetationCandidates,
          sampleTerrainAt,
          sampleBiomeWeightsAt,
          proposalSampleRate: rockProposalSampleRate,
          sharedFieldCache: sharedRockFieldCache,
          ...(generationControl ?? {}),
        })
        : Object.freeze({
          rockCandidates: Object.freeze([]),
          timings: Object.freeze({ rockMs: 0 }),
        });
      candidatesReadyAt = globalThis.performance?.now?.() ?? Date.now();
      return Object.freeze({
        vegetationCandidates: vegetationGeneration.vegetationCandidates,
        rockCandidates: rockGeneration.rockCandidates,
        timings: Object.freeze({
          vegetationMs: vegetationGeneration.timings.vegetationMs,
          rockMs: rockGeneration.timings.rockMs,
        }),
        reused: false,
      });
    })() : Promise.resolve().then(() => {
      candidatesReadyAt = globalThis.performance?.now?.() ?? Date.now();
      return Object.freeze({
        vegetationCandidates: reusableCandidates.vegetationCandidates,
        rockCandidates: includeRocks
          ? reusableCandidates.rockCandidates : Object.freeze([]),
        timings: Object.freeze({ vegetationMs: 0, rockMs: 0 }),
        reused: true,
      });
    });
    const [context, candidates] = await Promise.all([pendingContext, pendingCandidates]);
    await reachGenerationCheckpoint(generationControl);
    const preparationReadyAt = globalThis.performance?.now?.() ?? Date.now();
    const excluded = new Set(context.excludedNaturalStableIds ?? []);
    const exclusionTemplates = context.naturalExclusionTemplates
      ?? context.settlementTemplates ?? [];
    const candidateAllowed = candidate => !excluded.has(candidate.candidateId)
      && !exclusionTemplates.some(template => (
        settlementTemplateConflictsWithCandidate(candidate, template)
      ));
    const firstProjection = (context.settlementTemplates ?? []).map(template => (
      projectMigratedSettlementTemplate(template, { chunkX, chunkZ }, {
        sampleTerrainHeightAt: ownerSampler.sampleNaturalHeightMeters,
      })
    ));
    const settlementRegionRefs = context.settlementRegionRefs
      ?? context.settlementReferences
      ?? firstProjection.flatMap(value => value.references);
    const preliminarySurfacePolicy = context.canonicalSurfacePolicy
      ?? createSettlementSurfacePolicy(settlementRegionRefs);
    const preliminaryGround = createSharedCanonicalGroundKernel({
      canonicalSurfacePolicy: preliminarySurfacePolicy,
      sampleNaturalHeightMeters: ownerSampler.sampleNaturalHeightMeters,
    });
    const projectedSettlements = (context.settlementTemplates ?? []).map(template => (
      projectMigratedSettlementTemplate(template, { chunkX, chunkZ }, {
        sampleTerrainHeightAt: (worldX, worldZ) => (
          preliminaryGround.settlementGround(worldX, worldZ).heightMeters
        ),
      })
    ));
    const settlementStructures = projectedSettlements.flatMap(value => value.features);
    const majorRoadStructures = typeof context.resolveMajorRoadFeatures === 'function'
      ? await context.resolveMajorRoadFeatures({
        chunkX,
        chunkZ,
        ground: preliminaryGround,
        settlementReferences: settlementRegionRefs,
        settlementStructures,
      }) ?? [] : [];
    await reachGenerationCheckpoint(generationControl);
    const preliminaryStructures = [
      ...settlementStructures,
      ...majorRoadStructures,
      ...(context.structures ?? []),
    ].sort((left, right) => left.stableId.localeCompare(right.stableId));
    const riverProjection = context.includeCanonicalRiver === true
      ? await createCanonicalRiverProjection({
        worldSeedHash,
        chunkX,
        chunkZ,
        settlementReferences: settlementRegionRefs,
        roads: preliminaryStructures,
        sampleSurfaceHeight: (worldX, worldZ) => (
          preliminaryGround.finalGround(worldX, worldZ).heightMeters
        ),
      }) : null;
    await reachGenerationCheckpoint(generationControl);
    const canonicalSurfacePolicy = context.canonicalSurfacePolicy
      ?? createSettlementSurfacePolicy(
        settlementRegionRefs,
        riverProjection?.surfaceCorridor ? [riverProjection.surfaceCorridor] : [],
      );
    const ground = createSharedCanonicalGroundKernel({
      canonicalSurfacePolicy,
      sampleNaturalHeightMeters: ownerSampler.sampleNaturalHeightMeters,
    });
    const auxiliary = typeof context.resolvePresentationAuxiliary === 'function'
      ? await context.resolvePresentationAuxiliary({
          chunkX,
          chunkZ,
          ground,
          settlementReferences: settlementRegionRefs,
          structures: preliminaryStructures,
          riverProjection,
          naturalOnly: !materializePresentationOwner,
        }) ?? {} : {};
    await reachGenerationCheckpoint(generationControl);
    const water = [
      ...(context.water ?? []),
      ...(auxiliary.water ?? []),
      ...(riverProjection?.waterSurface ? [riverProjection.waterSurface] : []),
    ];
    const landmarks = [...(context.landmarks ?? []), ...(auxiliary.landmarks ?? [])];
    const candidateVisible = candidate => candidateAllowed(candidate)
      && (typeof context.isNaturalCandidateAllowed !== 'function'
        || context.isNaturalCandidateAllowed({
          candidate,
          structures: preliminaryStructures,
          water,
          landmarks,
          riverProjection,
          canonicalSurfacePolicy,
        }) !== false);
    const vegetation = naturalPolicy.selectVegetation({
      candidates: candidates.vegetationCandidates.filter(candidateVisible),
      settlementReferences: context.settlementDensityReferences ?? settlementRegionRefs,
      experienceSpawn,
      introDistanceMeters: context.introDistanceMeters ?? 11,
    });
    const rocks = candidates.rockCandidates.filter(candidateVisible);
    const regroundNaturalCandidate = candidate => {
      const heightMeters = ground.finalGround(
        candidate.worldPosition.x,
        candidate.worldPosition.z,
      ).heightMeters;
      if (candidate.worldPosition.y === heightMeters) return candidate;
      return Object.freeze({
        ...candidate,
        worldPosition: Object.freeze({
          ...candidate.worldPosition,
          y: heightMeters,
        }),
      });
    };
    const groundedVegetation = Object.freeze(vegetation.map(regroundNaturalCandidate));
    const groundedRocks = Object.freeze(rocks.map(regroundNaturalCandidate));
    await reachGenerationCheckpoint(generationControl);
    const coarsePresence = includeCoarsePresence ? (() => {
      // Macro Natural presence may only reuse real canonical Rock objects.
      // Bush is a Near-only ambient decoration and must never enter the Macro
      // Natural stream. Far-only synthetic Grass/Rock identities are forbidden.
      const rocks = groundedRocks
        .map(candidate => Object.freeze({
          ...compactNatural(resolveW8CanonicalWorldObject(candidate)),
          coarsePresenceKind: 'canonical-rock',
        }))
        .sort((left, right) => left.densityRank - right.densityRank
          || left.stableId.localeCompare(right.stableId))
        .slice(0, W8_CANONICAL_NATURAL_PRESENCE_MAX_ROCKS_PER_OWNER);
      if (rocks.some(record => record.objectType !== 'rock'
        || record.coarsePresenceKind !== 'canonical-rock')) {
        throw new Error(`non-canonical Natural escaped Macro presence for ${chunkX},${chunkZ}`);
      }
      return Object.freeze({
        schemaVersion: W8_CANONICAL_NATURAL_PRESENCE_SCHEMA,
        rocks: Object.freeze(rocks),
      });
    })() : null;
    // Human NPCs are Building residents, so the same people can be shown out here by asking
    // the shared kernel who lives in each Building this owner holds. Identity and placement
    // both come from that kernel, so these are the same residents Full residency will hand
    // over - not look-alikes that would shift or vanish as the player walks up.
    const residentsStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const residents = [];
    if (includeResidents) {
      for (const structure of preliminaryStructures) {
        if (structure?.featureType !== 'settlement-building') continue;
        const resident = await resolveBuildingResident({
          worldSeedHash,
          // Full residency parents the resident on the parity generator major, so the
          // presentation major would derive a different person entirely.
          generatorMajor: RESIDENT_GENERATOR_MAJOR,
          building: structure,
          ownerChunkX: chunkX,
          ownerChunkZ: chunkZ,
        });
        const surface = ground.finalGround(resident.x, resident.z);
        residents.push(Object.freeze({
          stableId: resident.stableId,
          buildingStableId: resident.buildingStableId,
          x: resident.x,
          z: resident.z,
          y: q6(surface.heightMeters),
          rotationY: resident.angle,
        }));
      }
    }
    const residentsCpuMs = q6((globalThis.performance?.now?.() ?? Date.now()) - residentsStartedAt);
    const grassFieldStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const grassField = includeGrassField ? (() => {
      // One 8 m cell may place one cluster. Position, rotation and variation come from a
      // cheap deterministic hash of the world cell, so the same cell always resolves to the
      // same cluster without carrying an identity.
      const seed = grassTextSeed('grass-field:' + worldSeedHash);
      const size = GRASS_FIELD_CELL_SIZE_METERS;
      const perOwner = Math.max(1, Math.round(LOGICAL_CHUNK_SIZE_METERS / size));
      const baseCellX = chunkX * perOwner;
      const baseCellZ = chunkZ * perOwner;
      const clusters = [];
      for (let localZ = 0; localZ < perOwner; localZ += 1) {
        for (let localX = 0; localX < perOwner; localX += 1) {
          const cellX = baseCellX + localX;
          const cellZ = baseCellZ + localZ;
          if (grassUnit(seed, cellX, cellZ, 1) > GRASS_FIELD_ACCEPTANCE) continue;
          const worldX = q6((cellX + 0.5 + (grassUnit(seed, cellX, cellZ, 2) - 0.5) * 0.7) * size);
          const worldZ = q6((cellZ + 0.5 + (grassUnit(seed, cellX, cellZ, 3) - 0.5) * 0.7) * size);
          const surface = ground.finalGround(worldX, worldZ);
          if (surface?.isWater === true || surface?.isRoad === true) continue;
          clusters.push(Object.freeze({
            x: worldX,
            z: worldZ,
            y: q6(surface.heightMeters),
            rotationY: q6(grassUnit(seed, cellX, cellZ, 4) * Math.PI * 2),
            variation: q6(0.85 + grassUnit(seed, cellX, cellZ, 5) * 0.35),
          }));
        }
      }
      return Object.freeze({
        schemaVersion: W8_CANONICAL_GRASS_FIELD_SCHEMA,
        cellSizeMeters: size,
        detailsPerCluster: W8_GRASS_CLUSTER_DETAIL_COUNT,
        clusters: Object.freeze(clusters),
      });
    })() : null;
    const grassFieldCpuMs = q6((globalThis.performance?.now?.() ?? Date.now()) - grassFieldStartedAt);
    const shrubFieldStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const shrubField = includeShrubField ? await (async () => {
      // Proposals, jitter and Stable IDs all come from the shared kernel, so these are the
      // very objects Full residency authors - not look-alikes generated a second way.
      const proposals = ambientDetailProposals({
        seed: ambientFieldSeed({
          worldSeedHash,
          contentSchemaVersion: W8_AMBIENT_CONTENT_SCHEMA_VERSION,
        }),
        chunkX,
        chunkZ,
        cellSizeMeters: W8_AMBIENT_CELL_SIZE_METERS,
        // The cap ranks every ambient type together, so all types must be resolved before
        // the Shrubs that survive it can be known.
      });
      if (proposals.length === 0) {
        return Object.freeze({
          schemaVersion: W8_CANONICAL_SHRUB_FIELD_SCHEMA, shrubs: Object.freeze([]),
        });
      }
      const parentChunkId = ambientParentChunkId({ worldSeedHash, chunkX, chunkZ });
      const identified = [];
      for (const proposal of proposals) {
        identified.push({
          proposal,
          stableId: await ambientDetailStableId({
            worldSeedHash,
            parentChunkId,
            detailType: proposal.detailType,
            cellX: proposal.cellX,
            cellZ: proposal.cellZ,
          }),
        });
      }
      const shrubs = [];
      for (const { proposal, stableId } of applyAmbientDetailCap(identified)) {
        if (proposal.detailType !== 'shrub') continue;
        const surface = ground.finalGround(proposal.x, proposal.z);
        if (surface?.isWater === true || surface?.isRoad === true) continue;
        // Reuse the exclusion Trees and Rocks already run against Settlements. It only ever
        // rejects more than the Full pass would, never less, so this tier cannot invent a
        // Shrub that has no Near counterpart.
        if (!candidateAllowed({
          candidateId: null,
          worldPosition: { x: proposal.x, z: proposal.z },
          metadata: { candidateRadiusMeters: 0.45 },
        })) continue;
        // Emit the same compact Natural record Trees and Rocks use, built from the same
        // ambient-detail shape the Full tier feeds through resolveW8CanonicalWorldObject, so
        // the renderer consumes Shrub through its existing canonical path.
        shrubs.push(compactNatural(Object.freeze({
          schemaVersion: 'w8-ambient-detail-1',
          stableId,
          detailType: 'shrub',
          worldPosition: Object.freeze({
            x: q6(proposal.x), y: q6(surface.heightMeters), z: q6(proposal.z),
          }),
          rotationY: q6(proposal.rotationY),
          variation: q6(proposal.variation),
          destructible: false,
          owningChunkCoordinate: Object.freeze({ x: chunkX, z: chunkZ }),
        })));
      }
      return Object.freeze({
        schemaVersion: W8_CANONICAL_SHRUB_FIELD_SCHEMA,
        cellSizeMeters: W8_AMBIENT_CELL_SIZE_METERS,
        shrubs: Object.freeze(shrubs),
      });
    })() : null;
    const shrubFieldCpuMs = q6((globalThis.performance?.now?.() ?? Date.now()) - shrubFieldStartedAt);
    // Natural Stable IDs and X/Z admission remain unchanged, but canonical Y
    // is the same post-grading/post-river finalGround used by visible Terrain.
    // Near, Distant, and the Tree-only batch therefore share one immutable
    // ground anchor without per-frame Terrain resampling.
    const resource = materializePresentationOwner ? createPresentationOwnerResource({
      worldSeedHash,
      chunkX,
      chunkZ,
      naturalCandidates: [...groundedVegetation, ...groundedRocks]
        .map(resolveW8CanonicalWorldObject),
      structures: preliminaryStructures,
      settlementRegionRefs,
      riverCorridorRefs: context.riverCorridorRefs
        ?? canonicalSurfacePolicy?.riverCorridors ?? [],
      water,
      landmarks,
      street: [...(context.street ?? []), ...(auxiliary.street ?? [])],
    }) : null;
    await reachGenerationCheckpoint(generationControl);
    const trees = Object.freeze((resource
      ? resource.natural.filter(record => record.objectType === 'tree')
      : groundedVegetation.filter(candidate => candidate.subtype !== 'shrub')
        .map(candidate => compactNatural(resolveW8CanonicalWorldObject(candidate)))
        .sort((left, right) => left.stableId.localeCompare(right.stableId))));
    const completedAt = globalThis.performance?.now?.() ?? Date.now();
    return Object.freeze({
      schemaVersion: 'w8-presentation-owner-data-1',
      chunkId: resource?.identity.chunkId ?? null,
      contentHash: `presentation:${PRESENTATION_OWNER_SHARED_CORE_REVISION}:${chunkX},${chunkZ}`,
      chunkX,
      chunkZ,
      resource,
      trees,
      coarsePresence,
      grassField,
      residents: Object.freeze(residents),
      shrubField,
      ground,
      canonicalSurfacePolicy,
      riverProjection,
      diagnostics: Object.freeze({
        denseTerrainMaterialized: false,
        fullNaturalExpanded: false,
        grassGenerated: false,
        gameplayGenerated: false,
        fullSettlementGenerated: false,
        largeContentHashGenerated: false,
        latticeSampleCount: ownerSampler.snapshot().latticeSampleCount,
        sourceVegetationCandidateCount: candidates.vegetationCandidates.length,
        sourceRockCandidateCount: candidates.rockCandidates.length,
        selectedVegetationCandidateCount: vegetation.length,
        selectedTreeCount: vegetation.filter(candidate => candidate.subtype !== 'shrub').length,
        selectedShrubCount: vegetation.filter(candidate => candidate.subtype === 'shrub').length,
        excludedVegetationCandidateCount:
          candidates.vegetationCandidates.length - vegetation.length,
        rockGenerationSkipped: !includeRocks,
        coarseNaturalPresenceGenerated: includeCoarsePresence,
        coarseShrubCount: 0,
        coarseRockCount: coarsePresence?.rocks.length ?? 0,
        grassClusterCount: grassField?.clusters.length ?? 0,
        residentCount: residents.length,
        residentsCpuMs,
        grassFieldCpuMs,
        shrubCount: shrubField?.shrubs.length ?? 0,
        shrubFieldCpuMs,
        canonicalCandidatesReused: candidates.reused === true,
        vegetationCandidateCpuMs: candidates.timings.vegetationMs,
        rockCandidateCpuMs: candidates.timings.rockMs,
        contextCpuMs: q6(contextReadyAt - startedAt),
        candidateCpuMs: q6(candidatesReadyAt - startedAt),
        projectionCpuMs: q6(completedAt - preparationReadyAt),
        totalCpuMs: q6(completedAt - startedAt),
      }),
    });
  };

  const generateCanonicalTreeCell = async (
    macroX,
    macroZ,
    { checkpoint = null, cooperativeCheckpoint = null } = {},
  ) => {
    assertCanonicalTreeMacroCoordinate(macroX, 'macroX');
    assertCanonicalTreeMacroCoordinate(macroZ, 'macroZ');
    const key = `${macroX},${macroZ}`;
    const generationControl = createGenerationControl(checkpoint, cooperativeCheckpoint);
    const bounds = canonicalTreeCellBounds(macroX, macroZ);
    const ownerCoordinates = [];
    for (let ownerOffsetZ = 0;
      ownerOffsetZ < W8_CANONICAL_TREE_OWNERS_PER_AXIS;
      ownerOffsetZ += 1) {
      for (let ownerOffsetX = 0;
        ownerOffsetX < W8_CANONICAL_TREE_OWNERS_PER_AXIS;
        ownerOffsetX += 1) {
        ownerCoordinates.push(Object.freeze({
          chunkX: macroX * W8_CANONICAL_TREE_OWNERS_PER_AXIS + ownerOffsetX,
          chunkZ: macroZ * W8_CANONICAL_TREE_OWNERS_PER_AXIS + ownerOffsetZ,
        }));
      }
    }
    const resolvedContextsPromise = typeof resolvePresentationContexts === 'function'
      ? Promise.resolve(resolvePresentationContexts(Object.freeze({
          macroX,
          macroZ,
          bounds,
          owners: Object.freeze(ownerCoordinates),
        }))).then(resolvedContexts => {
          if (!Array.isArray(resolvedContexts)
            || resolvedContexts.length !== ownerCoordinates.length) {
            throw new Error('canonical Tree context batch must match all 16 owners');
          }
          return resolvedContexts;
        }) : null;
    const sharedRockFieldCache = new Map();
    const preparedOwners = await Promise.all(ownerCoordinates.map(({ chunkX, chunkZ }, index) => (
      prepareOwner(chunkX, chunkZ, {
        includeRocks: true,
        rockProposalSampleRate: W8_CANONICAL_NATURAL_PRESENCE_ROCK_PROPOSAL_SAMPLE_RATE,
        sharedRockFieldCache,
        includeCoarsePresence: true,
        includeGrassField: true,
        includeResidents: true,
        includeShrubField: true,
        materializePresentationOwner: false,
        resolvedContextPromise: resolvedContextsPromise?.then(contexts => contexts[index]) ?? null,
        ...(generationControl ?? {}),
      })
    )));
    await reachGenerationCheckpoint(generationControl);
    const ownerKeys = Object.freeze(ownerCoordinates.map(({ chunkX, chunkZ }) => (
      createChunkKey(chunkX, chunkZ)
    )));
    const trees = [];
    const rocks = [];
    const grassClusters = [];
    const residents = [];
    const shrubs = [];
    const ownerBoundaries = [];
    for (let ownerIndex = 0; ownerIndex < preparedOwners.length; ownerIndex += 1) {
      const prepared = preparedOwners[ownerIndex];
      const { chunkX, chunkZ } = ownerCoordinates[ownerIndex];
      const ownerKey = ownerKeys[ownerIndex];
      const ownerTrees = prepared.trees;
      const ownerPresence = prepared.coarsePresence;
      if (ownerPresence?.schemaVersion !== W8_CANONICAL_NATURAL_PRESENCE_SCHEMA) {
        throw new Error(`canonical Natural presence missing for owner ${ownerKey}`);
      }
      const ownerRocks = ownerPresence.rocks;
      if ([...ownerTrees, ...ownerRocks]
        .some(record => record.owner !== ownerKey)
        || ownerRocks.some(record => record.objectType !== 'rock'
          || record.coarsePresenceKind !== 'canonical-rock')) {
        throw new Error(`canonical Natural presence escaped owner ${ownerKey}`);
      }
      ownerBoundaries.push(Object.freeze({
        ownerKey,
        chunkX,
        chunkZ,
        minimumX: chunkX * LOGICAL_CHUNK_SIZE_METERS,
        minimumZ: chunkZ * LOGICAL_CHUNK_SIZE_METERS,
        maximumExclusiveX: (chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS,
        maximumExclusiveZ: (chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS,
        treeOffset: trees.length,
        treeCount: ownerTrees.length,
        rockOffset: rocks.length,
        rockCount: ownerRocks.length,
      }));
      trees.push(...ownerTrees);
      rocks.push(...ownerRocks);
      // Grass clusters carry no Stable ID, so they never enter the identity audit below.
      grassClusters.push(...(prepared.grassField?.clusters ?? []));
      residents.push(...(prepared.residents ?? []));
      shrubs.push(...(prepared.shrubField?.shrubs ?? []));
      if ((ownerIndex + 1) % 4 === 0 || ownerIndex === preparedOwners.length - 1) {
        await reachGenerationCheckpoint(generationControl);
      }
    }
    const allNatural = [...trees, ...rocks];
    const stableIds = new Set(allNatural.map(record => record.stableId));
    if (stableIds.size !== allNatural.length) {
      throw new Error(`duplicate canonical Natural presence Stable ID in ${key}`);
    }
    const frozenTrees = Object.freeze(trees);
    const frozenNaturalPresence = Object.freeze({
      schemaVersion: W8_CANONICAL_NATURAL_PRESENCE_SCHEMA,
      rocks: Object.freeze(rocks),
    });
    const frozenOwnerBoundaries = Object.freeze(ownerBoundaries);
    const identity = Object.freeze({
      schemaVersion: 'w8-canonical-tree-cell-identity-1',
      worldSeedHash,
      sourceRevision: W8_CANONICAL_TREE_PREPARER_REVISION,
      key,
      macroX,
      macroZ,
    });
    const content = Object.freeze({
      schemaVersion: W8_CANONICAL_TREE_CELL_SCHEMA,
      identity,
      key,
      macroX,
      macroZ,
      bounds,
      ownerKeys,
      ownerBoundaries: frozenOwnerBoundaries,
      trees: frozenTrees,
      naturalPresence: frozenNaturalPresence,
      shrubField: Object.freeze({
        schemaVersion: W8_CANONICAL_SHRUB_FIELD_SCHEMA,
        shrubs: Object.freeze(shrubs),
      }),
      residents: Object.freeze(residents),
      grassField: Object.freeze({
        schemaVersion: W8_CANONICAL_GRASS_FIELD_SCHEMA,
        cellSizeMeters: GRASS_FIELD_CELL_SIZE_METERS,
        detailsPerCluster: W8_GRASS_CLUSTER_DETAIL_COUNT,
        clusters: Object.freeze(grassClusters),
      }),
    });
    const contentHash = await hashCanonicalTreeCellContent(content);
    await reachGenerationCheckpoint(generationControl);
    return Object.freeze({
      ...content,
      contentHash,
      diagnostics: Object.freeze({
        ownerCount: preparedOwners.length,
        treeCount: trees.length,
        coarseShrubCount: 0,
        coarseRockCount: rocks.length,
        grassClusterCount: grassClusters.length,
        residentCount: residents.length,
        shrubCount: shrubs.length,
        sourceVegetationCandidateCount: preparedOwners.reduce((sum, prepared) => (
          sum + prepared.diagnostics.sourceVegetationCandidateCount
        ), 0),
        selectedVegetationCandidateCount: preparedOwners.reduce((sum, prepared) => (
          sum + prepared.diagnostics.selectedVegetationCandidateCount
        ), 0),
        selectedShrubCount: preparedOwners.reduce((sum, prepared) => (
          sum + prepared.diagnostics.selectedShrubCount
        ), 0),
        excludedVegetationCandidateCount: preparedOwners.reduce((sum, prepared) => (
          sum + prepared.diagnostics.excludedVegetationCandidateCount
        ), 0),
        latticeSampleCount: preparedOwners.reduce((sum, prepared) => (
          sum + prepared.diagnostics.latticeSampleCount
        ), 0),
        rockCandidateCount: preparedOwners.reduce((sum, prepared) => (
          sum + prepared.diagnostics.sourceRockCandidateCount
        ), 0),
        rockGenerationSkippedOwnerCount: preparedOwners.filter(prepared => (
          prepared.diagnostics.rockGenerationSkipped
        )).length,
      }),
    });
  };

  return Object.freeze({
    schemaVersion: 'w8-presentation-owner-generator-1',
    worldSeed: normalizedWorldSeed,
    worldSeedHash,
    prepareCanonicalNaturalOwner: prepareOwner,
    generateOwner(chunkX, chunkZ, options = {}) {
      return prepareOwner(chunkX, chunkZ, { ...options, includeRocks: true });
    },
    generateCanonicalTreeCell,
  });
}
