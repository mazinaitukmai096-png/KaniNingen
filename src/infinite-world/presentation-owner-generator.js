import { createChunkId } from './legacy-core/g0/chunk-id.js';
import { hashWorldSeed, normalizeWorldSeed } from './legacy-core/g0/seed.js';
import { createChunkKey } from './chunk-coordinates.js';
import {
  projectMigratedSettlementTemplate,
  settlementTemplateConflictsWithCandidate,
} from './distributed-settlement-chunk-generator.js';
import { createFormalNaturalCandidateKernel } from './formal-natural-chunk-generator.js';
import { createSharedCanonicalNaturalKernel } from './natural-chunk-generator.js';
import { createW8NaturalPresentationPhase1Policy } from './w8-natural-presentation-policy.js';
import { resolveW8CanonicalFarTreeDensityRank } from './vegetation-lod-policy.js';
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

/**
 * Purpose-built Stage 1 generator. It evaluates only Natural lattice samples
 * reached by semantic candidates and consumes compact settlement/structure
 * context from the existing sparse stream. It never builds Full ChunkData.
 */
export async function createPresentationOwnerGenerator({
  worldSeed = 'KaniNingen Infinite Natural World',
  experienceSpawn = null,
  resolvePresentationContext = null,
} = {}) {
  const normalizedWorldSeed = normalizeWorldSeed(worldSeed);
  const { worldSeedHash } = await hashWorldSeed(normalizedWorldSeed);
  const [naturalKernel, candidateKernel, naturalPolicy] = await Promise.all([
    createSharedCanonicalNaturalKernel({ worldSeedHash }),
    createFormalNaturalCandidateKernel({ worldSeedHash }),
    createW8NaturalPresentationPhase1Policy({ worldSeedHash }),
  ]);
  return Object.freeze({
    schemaVersion: 'w8-presentation-owner-generator-1',
    worldSeed: normalizedWorldSeed,
    worldSeedHash,
    async generateOwner(chunkX, chunkZ) {
      if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
        throw new TypeError('Presentation owner coordinates are required');
      }
      const startedAt = globalThis.performance?.now?.() ?? Date.now();
      const context = resolvePresentationContext
        ? await resolvePresentationContext({
          chunkX,
          chunkZ,
          ownerKey: createChunkKey(chunkX, chunkZ),
        }) ?? {} : {};
      const contextReadyAt = globalThis.performance?.now?.() ?? Date.now();
      const ownerSampler = naturalKernel.createOwnerSampler(chunkX, chunkZ);
      const candidates = await candidateKernel.generate({
        chunk: { chunkX, chunkZ, worldSeedHash },
        sampleTerrainAt: (_chunk, point, candidateKind) => ownerSampler.sampleTerrain(
          point,
          { includeMaterials: candidateKind === 'rock' },
        ),
        sampleBiomeWeightsAt: (_chunk, point) => ownerSampler.sampleBiomeWeights(point),
      });
      const candidatesReadyAt = globalThis.performance?.now?.() ?? Date.now();
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
      const resource = createPresentationOwnerResource({
        worldSeedHash,
        chunkX,
        chunkZ,
        // Full W8 preserves the formal Natural candidate base Y and applies
        // the shared final-ground kernel to Terrain/structures separately.
        // Presentation must retain that same canonical object identity.
        naturalCandidates: [...vegetation, ...rocks].map(resolveW8CanonicalWorldObject),
        structures: preliminaryStructures,
        settlementRegionRefs,
        riverCorridorRefs: context.riverCorridorRefs
          ?? canonicalSurfacePolicy?.riverCorridors ?? [],
        water,
        landmarks,
        street: [...(context.street ?? []), ...(auxiliary.street ?? [])],
      });
      const completedAt = globalThis.performance?.now?.() ?? Date.now();
      return Object.freeze({
        schemaVersion: 'w8-presentation-owner-data-1',
        chunkId: resource.identity.chunkId,
        contentHash: `presentation:${PRESENTATION_OWNER_SHARED_CORE_REVISION}:${chunkX},${chunkZ}`,
        chunkX,
        chunkZ,
        resource,
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
          vegetationCandidateCpuMs: candidates.timings.vegetationMs,
          rockCandidateCpuMs: candidates.timings.rockMs,
          contextCpuMs: q6(contextReadyAt - startedAt),
          candidateCpuMs: q6(candidatesReadyAt - contextReadyAt),
          projectionCpuMs: q6(completedAt - candidatesReadyAt),
          totalCpuMs: q6(completedAt - startedAt),
        }),
      });
    },
  });
}
