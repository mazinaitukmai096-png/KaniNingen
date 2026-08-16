import { createChunkId } from './legacy-core/g0/chunk-id.js';
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
  W8_SHARED_CANONICAL_GROUND_REVISION,
  createSharedCanonicalGroundKernel,
  createSettlementSurfacePolicy,
} from './w8-surface-policy.js';

export const PRESENTATION_OWNER_SCHEMA = 'w8-presentation-owner-1';
export const PRESENTATION_OWNER_SHARED_CORE_REVISION =
  `${W8_SHARED_CANONICAL_GROUND_REVISION}:formal-natural-candidate-kernel-1`;
export const W8_CANONICAL_TREE_CELL_SCHEMA = 'w8-canonical-tree-cell-1';
export const W8_CANONICAL_TREE_PREPARER_REVISION =
  `${PRESENTATION_OWNER_SHARED_CORE_REVISION}:${W8_NATURAL_PRESENTATION_PHASE_1.schemaVersion}:production-exclusions-1`;
export const W8_CANONICAL_TREE_MACRO_SIZE_METERS = 64;
export const W8_CANONICAL_TREE_OWNERS_PER_AXIS =
  W8_CANONICAL_TREE_MACRO_SIZE_METERS / LOGICAL_CHUNK_SIZE_METERS;
const PRESENTATION_CANONICAL_GENERATOR_MAJOR = 8;

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
  if (!['tree', 'shrub', 'rock'].includes(canonical.objectType)) {
    throw new TypeError('Presentation Natural supports Tree, Bush/Shrub, and Rock only');
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
  if (!record || !['tree', 'shrub', 'rock'].includes(record.objectType)) {
    throw new TypeError('compact Presentation Natural record is required');
  }
  const position = expandPosition(record.position);
  const owner = parseCompactOwner(record.owner);
  const resolved = resolveW8CanonicalWorldObject(Object.freeze({
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
  }));
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
} = {}) {
  const normalizedWorldSeed = normalizeWorldSeed(worldSeed);
  const { worldSeedHash } = await hashWorldSeed(normalizedWorldSeed);
  const [naturalKernel, candidateKernel, naturalPolicy] = await Promise.all([
    createSharedCanonicalNaturalKernel({ worldSeedHash }),
    createFormalNaturalCandidateKernel({ worldSeedHash }),
    createW8NaturalPresentationPhase1Policy({ worldSeedHash }),
  ]);
  const prepareOwner = async (chunkX, chunkZ, {
    includeRocks = true,
    materializePresentationOwner = true,
    resolvedContext = undefined,
    resolvedContextPromise = null,
  } = {}) => {
    if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
      throw new TypeError('Presentation owner coordinates are required');
    }
    if (typeof includeRocks !== 'boolean') {
      throw new TypeError('includeRocks must be boolean');
    }
    if (typeof materializePresentationOwner !== 'boolean') {
      throw new TypeError('materializePresentationOwner must be boolean');
    }
    if (resolvedContextPromise !== null
      && typeof resolvedContextPromise?.then !== 'function') {
      throw new TypeError('resolvedContextPromise must be Promise-like');
    }
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
    const ownerSampler = naturalKernel.createOwnerSampler(chunkX, chunkZ);
    const sampleTerrainAt = (_chunk, point, candidateKind) => ownerSampler.sampleTerrain(
      point,
      { includeMaterials: candidateKind === 'rock' },
    );
    const sampleBiomeWeightsAt = (_chunk, point) => ownerSampler.sampleBiomeWeights(point);
    let candidatesReadyAt = startedAt;
    const pendingCandidates = (async () => {
      const vegetationGeneration = await candidateKernel.generateVegetation({
        chunk: { chunkX, chunkZ, worldSeedHash },
        sampleTerrainAt,
        sampleBiomeWeightsAt,
      });
      const rockGeneration = includeRocks
        ? await candidateKernel.generateRocks({
          chunk: { chunkX, chunkZ, worldSeedHash },
          vegetationCandidates: vegetationGeneration.vegetationCandidates,
          sampleTerrainAt,
          sampleBiomeWeightsAt,
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
      });
    })();
      const [context, candidates] = await Promise.all([pendingContext, pendingCandidates]);
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
        settlementReferences: settlementRegionRefs,
        experienceSpawn,
        introDistanceMeters: context.introDistanceMeters ?? 11,
      });
      const rocks = candidates.rockCandidates.filter(candidateVisible);
      // Full W8 preserves the formal Natural candidate base Y and applies the
      // shared final-ground kernel to Terrain/structures separately. Both
      // consumers resolve Tree records through compactNatural; the Tree-only
      // batch does not also allocate the unrelated PresentationOwner payload.
      const resource = materializePresentationOwner ? createPresentationOwnerResource({
        worldSeedHash,
        chunkX,
        chunkZ,
        naturalCandidates: [...vegetation, ...rocks].map(resolveW8CanonicalWorldObject),
        structures: preliminaryStructures,
        settlementRegionRefs,
        riverCorridorRefs: context.riverCorridorRefs
          ?? canonicalSurfacePolicy?.riverCorridors ?? [],
        water,
        landmarks,
        street: [...(context.street ?? []), ...(auxiliary.street ?? [])],
      }) : null;
      const trees = Object.freeze((resource
        ? resource.natural.filter(record => record.objectType === 'tree')
        : vegetation.filter(candidate => candidate.subtype !== 'shrub')
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
          vegetationCandidateCpuMs: candidates.timings.vegetationMs,
          rockCandidateCpuMs: candidates.timings.rockMs,
          contextCpuMs: q6(contextReadyAt - startedAt),
          candidateCpuMs: q6(candidatesReadyAt - startedAt),
          projectionCpuMs: q6(completedAt - preparationReadyAt),
          totalCpuMs: q6(completedAt - startedAt),
        }),
      });
  };

  const generateCanonicalTreeCell = async (macroX, macroZ) => {
    assertCanonicalTreeMacroCoordinate(macroX, 'macroX');
    assertCanonicalTreeMacroCoordinate(macroZ, 'macroZ');
    const key = `${macroX},${macroZ}`;
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
    const preparedOwners = await Promise.all(ownerCoordinates.map(({ chunkX, chunkZ }, index) => (
      prepareOwner(chunkX, chunkZ, {
        includeRocks: false,
        materializePresentationOwner: false,
        resolvedContextPromise: resolvedContextsPromise?.then(contexts => contexts[index]) ?? null,
      })
    )));
    const ownerKeys = Object.freeze(ownerCoordinates.map(({ chunkX, chunkZ }) => (
      createChunkKey(chunkX, chunkZ)
    )));
    const trees = [];
    const ownerBoundaries = [];
    for (let ownerIndex = 0; ownerIndex < preparedOwners.length; ownerIndex += 1) {
      const prepared = preparedOwners[ownerIndex];
      const { chunkX, chunkZ } = ownerCoordinates[ownerIndex];
      const ownerKey = ownerKeys[ownerIndex];
      const ownerTrees = prepared.trees;
      if (ownerTrees.some(record => record.owner !== ownerKey)) {
        throw new Error(`canonical Tree escaped owner ${ownerKey}`);
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
      }));
      trees.push(...ownerTrees);
    }
    const stableIds = new Set(trees.map(tree => tree.stableId));
    if (stableIds.size !== trees.length) {
      throw new Error(`duplicate canonical Tree Stable ID in ${key}`);
    }
    const frozenTrees = Object.freeze(trees);
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
    });
    const contentHash = await hashCanonicalTreeCellContent(content);
    return Object.freeze({
      ...content,
      contentHash,
      diagnostics: Object.freeze({
        ownerCount: preparedOwners.length,
        treeCount: trees.length,
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
        rockCandidateCount: 0,
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
    generateOwner(chunkX, chunkZ) {
      return prepareOwner(chunkX, chunkZ, { includeRocks: true });
    },
    generateCanonicalTreeCell,
  });
}
