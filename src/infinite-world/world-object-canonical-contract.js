import {
  W6_STATIC_TARGET_CONTRACTS,
  W8_WORLD_DETAIL_CONTRACTS,
  finiteWorldUnitsToMeters,
} from './gameplay-contract.js';
import {
  W8_CURRENT_SETTLEMENT_LOD_METERS,
  W8_CURRENT_TREE_LOD_METERS,
  W8_RENDER_DISTANCE_PRESETS,
  resolveW8RenderDistancePolicy,
} from './render-distance-policy.js';
import {
  W8_PARITY_FEATURE_PARTS,
  resolveW8BuildingParts,
} from './render/w8-parity-visual-assets.js';

export const W8_CANONICAL_WORLD_OBJECT_SCHEMA = 'w8-canonical-world-object-1';

export const W8_CANONICAL_WORLD_OBJECT_TYPES = Object.freeze([
  'rock', 'tree', 'shrub', 'grass', 'building', 'cow', 'haystack',
  'barn', 'factory', 'militaryBase', 'streetLamp', 'roadSign',
  'bench', 'trashBin', 'planter', 'vendingMachine', 'parkedCar', 'fence',
]);

export const W8_RESERVED_WORLD_DETAIL_TYPES = Object.freeze([
  'bench', 'trashBin', 'planter', 'vendingMachine', 'parkedCar', 'fence',
]);

export const W8_CANONICAL_VISIBILITY_METERS = Object.freeze({
  short: W8_RENDER_DISTANCE_PRESETS.short.generalObjectVisibilityMeters,
  standard: W8_RENDER_DISTANCE_PRESETS.standard.generalObjectVisibilityMeters,
  current: W8_RENDER_DISTANCE_PRESETS.current.generalObjectVisibilityMeters,
});

export const W8_HIGH_TREE_LOD_METERS = W8_CURRENT_TREE_LOD_METERS;

export const W8_HIGH_HORIZON_LOD_METERS = Object.freeze({
  start: W8_CURRENT_SETTLEMENT_LOD_METERS.fullDistanceMeters,
  fadeStart: W8_CURRENT_SETTLEMENT_LOD_METERS.fadeStartMeters,
  visibility: W8_CURRENT_SETTLEMENT_LOD_METERS.visibilityMeters,
});

export const W8_FINITE_ROCK_PRESENTATION_METERS = Object.freeze({
  sourceCommit: 'f8bc9f80c2af417bb585bff26c99522c4229ab8e',
  small: Object.freeze({ minimumScaleMeters: 0.525, maximumScaleMeters: 1.225 }),
  medium: Object.freeze({ minimumScaleMeters: 200 / 112, maximumScaleMeters: 325 / 112 }),
  large: Object.freeze({ minimumScaleMeters: 325 / 112, maximumScaleMeters: 450 / 112 }),
});

const nearTier = Object.freeze({ ownerSet: 'rendered', presentationTier: 'full' });
const activeTier = Object.freeze({ ownerSet: 'active', presentationTier: 'full' });
const queriedTier = Object.freeze({ ownerSet: 'queried', presentationTier: 'full' });

export const W8_ROCK_CANONICAL_LOD_POLICY = Object.freeze({
  schemaVersion: 'w8-rock-lod-policy-1',
  visibilityClass: 'natural',
  near: nearTier,
  outer: activeTier,
  far: queriedTier,
  presentationTiers: Object.freeze(['full', 'atmospheric']),
  proxy: false,
});

export const W8_TREE_CANONICAL_LOD_POLICY = Object.freeze({
  schemaVersion: 'w8-tree-lod-policy-1',
  visibilityClass: 'natural',
  near: nearTier,
  outer: activeTier,
  far: queriedTier,
  presentationTiers: Object.freeze(['full', 'forest', 'atmospheric', 'horizon']),
  highTiers: W8_HIGH_TREE_LOD_METERS,
  proxy: false,
});

export const W8_SHRUB_CANONICAL_LOD_POLICY = Object.freeze({
  schemaVersion: 'w8-shrub-lod-policy-1',
  visibilityClass: 'natural',
  near: nearTier,
  outer: activeTier,
  far: queriedTier,
  presentationTiers: Object.freeze(['full', 'forest', 'atmospheric']),
  proxy: false,
});

export const W8_GRASS_CANONICAL_LOD_POLICY = Object.freeze({
  schemaVersion: 'w8-grass-lod-policy-1',
  visibilityClass: 'natural',
  near: nearTier,
  outer: activeTier,
  far: queriedTier,
  presentationTiers: Object.freeze(['full', 'forest', 'atmospheric']),
  proxy: false,
});

export const W8_SETTLEMENT_CANONICAL_LOD_POLICY = Object.freeze({
  schemaVersion: 'w8-settlement-lod-policy-1',
  visibilityClass: 'general-object',
  near: nearTier,
  outer: activeTier,
  far: queriedTier,
  presentationTiers: Object.freeze(['full', 'horizon']),
  highHorizon: W8_HIGH_HORIZON_LOD_METERS,
  proxy: false,
});

export const W8_NEAR_ONLY_CANONICAL_LOD_POLICY = Object.freeze({
  schemaVersion: 'w8-near-only-lod-policy-1',
  visibilityClass: 'near-only',
  near: nearTier,
  outer: null,
  far: null,
  presentationTiers: Object.freeze(['full']),
  proxy: false,
});

const canonicalBySource = new WeakMap();
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const unitInterval = value => Number.isFinite(value) ? clamp(value, 0, 1) : 0.5;

const immutableCopy = value => {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy));
  if (!value || typeof value !== 'object') return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, immutableCopy(child)]),
  ));
};

const copyPosition = position => {
  if (position === undefined || position === null) return null;
  if (![position.x, position.y ?? 0, position.z].every(Number.isFinite)) {
    throw new TypeError('canonical World Object position must be finite');
  }
  return Object.freeze({ x: position.x, y: position.y ?? 0, z: position.z });
};

const copyOwner = owner => {
  if (owner === undefined || owner === null) return null;
  if (!Number.isSafeInteger(owner.x) || !Number.isSafeInteger(owner.z)) {
    throw new TypeError('canonical World Object owner must contain safe Chunk coordinates');
  }
  return Object.freeze({ x: owner.x, z: owner.z });
};

const dimensions = (width, height, depth) => {
  if (![width, height, depth].every(value => Number.isFinite(value) && value >= 0)) {
    throw new TypeError('canonical World Object dimensions must be finite and non-negative');
  }
  return Object.freeze({ width, height, depth });
};

const noCollision = heightMeters => Object.freeze({
  shape: 'none', radiusMeters: 0, halfExtents: null, heightMeters, blocksPlayer: false,
});

const noInteraction = Object.freeze({
  enabled: false,
  targetType: null,
  radiusMeters: 0,
  maxHp: null,
  scoreValue: 0,
});

const interactionFromContract = (targetType, radiusMeters, destructible = true) => {
  const contract = W6_STATIC_TARGET_CONTRACTS[targetType];
  if (!contract) throw new Error(`missing canonical interaction contract: ${targetType}`);
  return Object.freeze({
    enabled: true,
    targetType,
    radiusMeters,
    maxHp: contract.maxHp,
    scoreValue: contract.scoreValue,
    destructible,
  });
};

const detailInteraction = (detailType, radiusMeters) => {
  const contract = W8_WORLD_DETAIL_CONTRACTS[detailType];
  if (!contract?.destructible) return noInteraction;
  return Object.freeze({
    enabled: true,
    targetType: detailType,
    radiusMeters,
    maxHp: contract.maxHp,
    scoreValue: contract.scoreValue,
    destructible: true,
  });
};

const destruction = (stableId, destructible, presentation = destructible ? 'rubble' : 'none') => Object.freeze({
  destructible,
  stateKey: destructible ? stableId : null,
  presentation: destructible ? presentation : 'none',
});

const presentation = (partSetKey, parts, tiers) => Object.freeze({
  partSetKey,
  parts: Object.freeze([...(parts ?? [])]),
  tiers,
});

const baseRecord = ({
  source,
  objectType,
  stableId,
  position,
  owner,
  rotationY,
  visualBounds,
  matrixDimensionsMeters,
  collision,
  interaction,
  destructible,
  destructionPresentation,
  lodPolicy,
  presentation: objectPresentation,
  extension,
  compatibility = {},
}) => {
  if (typeof stableId !== 'string' || !stableId) {
    throw new TypeError('canonical World Object Stable ID is required');
  }
  if (!W8_CANONICAL_WORLD_OBJECT_TYPES.includes(objectType)) {
    throw new Error(`unsupported canonical World Object type: ${objectType}`);
  }
  const canonicalPosition = copyPosition(position);
  const canonicalOwner = copyOwner(owner);
  if (!canonicalPosition || !canonicalOwner) {
    throw new TypeError(`${objectType} canonical object requires position and owner`);
  }
  const canonicalExtension = immutableCopy(extension);
  const canonicalCompatibility = immutableCopy(compatibility);
  const record = Object.freeze({
    schemaVersion: W8_CANONICAL_WORLD_OBJECT_SCHEMA,
    objectType,
    stableId,
    owner: canonicalOwner,
    position: canonicalPosition,
    rotation: Object.freeze({ y: rotationY }),
    visualBounds,
    collision,
    interaction,
    destruction: destruction(stableId, destructible, destructionPresentation),
    lodPolicy,
    presentation: objectPresentation,
    extension: canonicalExtension,
    // Compatibility aliases for existing generic rendering and identity paths.
    worldPosition: canonicalPosition,
    owningChunkCoordinate: canonicalOwner,
    rotationY,
    destructible,
    widthMeters: matrixDimensionsMeters.width,
    heightMeters: matrixDimensionsMeters.height,
    depthMeters: matrixDimensionsMeters.depth,
    ...canonicalCompatibility,
  });
  canonicalBySource.set(source, record);
  return record;
};

function resolveRock(source) {
  const variation = unitInterval(source.variationSeed);
  const candidateRadiusMeters = Number.isFinite(source?.metadata?.candidateRadiusMeters)
    ? Math.max(0, source.metadata.candidateRadiusMeters) : 0;
  const explicitlyLarge = source.sizeClass === 'large';
  const mediumFamily = explicitlyLarge || source.sizeClass === 'medium'
    || source.subtype === 'medium-rock' || candidateRadiusMeters >= 0.15;
  const sizeClass = explicitlyLarge ? 'large'
    : mediumFamily ? (variation < 0.5 ? 'medium' : 'large') : 'small';
  const bounds = W8_FINITE_ROCK_PRESENTATION_METERS[sizeClass];
  const rangeVariation = explicitlyLarge ? variation
    : mediumFamily ? (variation < 0.5 ? variation * 2 : (variation - 0.5) * 2)
      : variation;
  const scaleMeters = bounds.minimumScaleMeters
    + (bounds.maximumScaleMeters - bounds.minimumScaleMeters) * rangeVariation;
  const visualBounds = dimensions(scaleMeters * 2, scaleMeters * 2, scaleMeters * 2);
  const matrixDimensionsMeters = dimensions(scaleMeters, scaleMeters, scaleMeters);
  const collision = Object.freeze({
    shape: 'circle',
    radiusMeters: visualBounds.width / 2,
    halfExtents: null,
    heightMeters: visualBounds.height,
    blocksPlayer: true,
  });
  const targetType = sizeClass === 'small' ? 'pebble' : 'rock';
  return baseRecord({
    source,
    objectType: 'rock',
    stableId: source.candidateId ?? source.stableId,
    position: source.worldPosition,
    owner: source.owningChunkCoordinate,
    rotationY: source.candidateId !== undefined
      ? (source.orientationSeed ?? 0) * Math.PI * 2 : source.yawRadians ?? 0,
    visualBounds,
    matrixDimensionsMeters,
    collision,
    interaction: interactionFromContract(targetType, collision.radiusMeters),
    destructible: true,
    destructionPresentation: 'none',
    lodPolicy: W8_ROCK_CANONICAL_LOD_POLICY,
    presentation: presentation('rock', W8_PARITY_FEATURE_PARTS.rock, W8_ROCK_CANONICAL_LOD_POLICY.presentationTiers),
    extension: {
      sourceKind: 'natural-candidate',
      candidateId: source.candidateId ?? source.stableId,
      subtype: source.subtype ?? null,
      sizeClass,
      variationSeed: source.variationSeed ?? null,
      generationBounds: Object.freeze({
        shape: source?.metadata?.boundsType ?? 'horizontal-circle',
        radiusMeters: candidateRadiusMeters,
      }),
    },
    compatibility: {
      candidateId: source.candidateId ?? source.stableId,
      featureType: 'natural-rock',
      subtype: source.subtype ?? null,
      sizeClass,
      generationBounds: Object.freeze({
        shape: source?.metadata?.boundsType ?? 'horizontal-circle',
        radiusMeters: candidateRadiusMeters,
      }),
      visual: Object.freeze({
        visualKind: 'rock',
        sizeClass,
        variationSeed: source.variationSeed ?? null,
        dimensionsMeters: visualBounds,
        matrixDimensionsMeters,
      }),
    },
  });
}

export function resolveW8NaturalCandidateVisual(source) {
  const formal = source?.candidateId !== undefined;
  const variation = formal ? 0.84 + source.variationSeed * 0.32 : 1;
  const shrub = formal && source.subtype === 'shrub';
  const radiusMeters = formal ? source.metadata.candidateRadiusMeters : 0.32;
  const widthMeters = (shrub ? radiusMeters * 2.2 : 2) * variation;
  return Object.freeze({
    visualKind: shrub ? 'shrub'
      : source.subtype === 'wetland-tree' ? 'wetlandTree'
        : source.subtype === 'broadleaf-tree' ? 'broadleafTree' : 'tree',
    widthMeters,
    heightMeters: (shrub ? 0.85 : 3.625) * variation,
    depthMeters: widthMeters,
    rotationY: formal ? source.orientationSeed * Math.PI * 2 : source.yawRadians,
  });
}

function resolveNatural(source) {
  const visual = resolveW8NaturalCandidateVisual(source);
  const shrub = source.subtype === 'shrub';
  const objectType = shrub ? 'shrub' : 'tree';
  const visualBounds = dimensions(visual.widthMeters, visual.heightMeters, visual.depthMeters);
  const radiusMeters = source.metadata?.candidateRadiusMeters ?? (shrub ? 0.2 : 0.625);
  const collision = Object.freeze({
    shape: 'horizontal-circle', radiusMeters, halfExtents: null,
    heightMeters: visualBounds.height, blocksPlayer: false,
  });
  const lodPolicy = shrub ? W8_SHRUB_CANONICAL_LOD_POLICY : W8_TREE_CANONICAL_LOD_POLICY;
  return baseRecord({
    source,
    objectType,
    stableId: source.candidateId ?? source.stableId,
    position: source.worldPosition,
    owner: source.owningChunkCoordinate,
    rotationY: visual.rotationY,
    visualBounds,
    matrixDimensionsMeters: visualBounds,
    collision,
    interaction: interactionFromContract('tree', radiusMeters),
    destructible: true,
    lodPolicy,
    presentation: presentation(visual.visualKind, W8_PARITY_FEATURE_PARTS[visual.visualKind], lodPolicy.presentationTiers),
    extension: {
      sourceKind: 'natural-candidate',
      candidateId: source.candidateId ?? source.stableId,
      subtype: source.subtype ?? null,
      variationSeed: source.variationSeed ?? null,
    },
    compatibility: {
      candidateId: source.candidateId ?? source.stableId,
      featureType: 'natural-vegetation',
      subtype: source.subtype ?? null,
      visual: Object.freeze({
        visualKind: visual.visualKind,
        subtype: source.subtype ?? null,
        variationSeed: source.variationSeed ?? null,
      }),
    },
  });
}

function resolveBuilding(source) {
  const visualBounds = dimensions(source.widthMeters, source.heightMeters, source.depthMeters);
  const parts = resolveW8BuildingParts(source);
  const contract = W6_STATIC_TARGET_CONTRACTS[source.buildingType];
  if (!contract) throw new Error(`unsupported canonical Building type: ${source.buildingType}`);
  const radiusMeters = source.radiusMeters;
  const visualHeightScale = Math.max(1, ...parts.map(part => (
    part.position[1] + part.scale[1] * 0.5
  )));
  const visualHalfWidthScale = Math.max(0.5, ...parts.map(part => (
    Math.abs(part.position[0]) + part.scale[0] * 0.5
  )));
  const visualHalfDepthScale = Math.max(0.5, ...parts.map(part => (
    Math.abs(part.position[2]) + part.scale[2] * 0.5
  )));
  const collision = Object.freeze({
    shape: 'horizontal-circle',
    radiusMeters,
    halfExtents: Object.freeze({
      x: visualBounds.width * visualHalfWidthScale,
      y: visualBounds.height * visualHeightScale / 2,
      z: visualBounds.depth * visualHalfDepthScale,
    }),
    heightMeters: visualBounds.height,
    blocksPlayer: false,
    cameraShape: 'oriented-box',
    halfWidthMeters: visualBounds.width * visualHalfWidthScale,
    halfDepthMeters: visualBounds.depth * visualHalfDepthScale,
    cameraHeightMeters: visualBounds.height * visualHeightScale,
  });
  return baseRecord({
    source,
    objectType: 'building',
    stableId: source.stableId,
    position: source.worldPosition,
    owner: source.owningChunkCoordinate,
    rotationY: source.rotationY ?? 0,
    visualBounds,
    matrixDimensionsMeters: visualBounds,
    collision,
    interaction: interactionFromContract(source.buildingType, radiusMeters),
    destructible: true,
    lodPolicy: W8_SETTLEMENT_CANONICAL_LOD_POLICY,
    presentation: presentation(source.buildingType, parts, W8_SETTLEMENT_CANONICAL_LOD_POLICY.presentationTiers),
    extension: {
      sourceKind: 'settlement-building',
      buildingType: source.buildingType,
      settlementId: source.settlementId ?? null,
      settlementType: source.settlementType ?? null,
      townType: source.townType ?? null,
      visual: source.visual ?? null,
      lot: source.lot ?? null,
    },
    compatibility: {
      featureType: 'settlement-building',
      buildingType: source.buildingType,
      settlementId: source.settlementId ?? null,
      settlementType: source.settlementType ?? null,
      townType: source.townType ?? null,
      visual: source.visual ?? null,
      lot: source.lot ?? null,
    },
  });
}

function resolveLandmark(source) {
  const landmarkType = source.landmarkType;
  const objectType = W8_CANONICAL_WORLD_OBJECT_TYPES.includes(landmarkType)
    ? landmarkType : 'building';
  const visualBounds = dimensions(source.widthMeters, source.heightMeters, source.depthMeters);
  const contract = W6_STATIC_TARGET_CONTRACTS[landmarkType];
  if (!contract) throw new Error(`unsupported Phase 4B landmark type: ${landmarkType}`);
  const radiusMeters = finiteWorldUnitsToMeters(contract.radius);
  const collision = Object.freeze({
    shape: 'horizontal-circle', radiusMeters, halfExtents: null,
    heightMeters: visualBounds.height, blocksPlayer: false,
  });
  return baseRecord({
    source,
    objectType,
    stableId: source.stableId,
    position: source.worldPosition,
    owner: source.owningChunkCoordinate,
    rotationY: source.rotationY ?? 0,
    visualBounds,
    matrixDimensionsMeters: visualBounds,
    collision,
    interaction: interactionFromContract(landmarkType, radiusMeters),
    destructible: true,
    lodPolicy: W8_SETTLEMENT_CANONICAL_LOD_POLICY,
    presentation: presentation(landmarkType, W8_PARITY_FEATURE_PARTS[landmarkType], W8_SETTLEMENT_CANONICAL_LOD_POLICY.presentationTiers),
    extension: {
      sourceKind: 'settlement-landmark',
      landmarkType,
      parentSettlementId: source.parentSettlementId ?? null,
      settlementType: source.settlementType ?? null,
      townType: source.townType ?? null,
    },
    compatibility: {
      featureType: 'settlement-landmark',
      landmarkType,
      parentSettlementId: source.parentSettlementId ?? null,
      settlementType: source.settlementType ?? null,
      townType: source.townType ?? null,
    },
  });
}

const detailDimensions = Object.freeze({
  grass: Object.freeze({ width: 0.45, height: 0.65, depth: 0.45 }),
  shrub: Object.freeze({ width: 0.75, height: 0.7, depth: 0.75 }),
  streetLamp: Object.freeze({ width: 0.45, height: 3.4, depth: 0.45 }),
  roadSign: Object.freeze({ width: 1.2, height: 2.1, depth: 0.25 }),
  bench: Object.freeze({ width: 1.25, height: 1.1, depth: 0.45 }),
  trashBin: Object.freeze({ width: 0.525, height: 0.775, depth: 0.525 }),
  planter: Object.freeze({ width: 0.775, height: 0.975, depth: 0.775 }),
  vendingMachine: Object.freeze({ width: 0.625, height: 1.25, depth: 0.5 }),
  parkedCar: Object.freeze({ width: 1.3, height: 0.75, depth: 2.125 }),
  fence: Object.freeze({ width: 1.5, height: 0.8, depth: 0.125 }),
});

function resolveDetail(source) {
  const detailType = source.detailType;
  if (!['grass', 'shrub', 'streetLamp', 'roadSign', ...W8_RESERVED_WORLD_DETAIL_TYPES]
    .includes(detailType)) {
    throw new Error(`unsupported Phase 4B World Detail type: ${detailType}`);
  }
  const variation = source.variation ?? 1;
  const base = detailDimensions[detailType];
  const visualBounds = dimensions(
    base.width * variation,
    base.height * variation,
    base.depth * variation,
  );
  const detailContract = W8_WORLD_DETAIL_CONTRACTS[detailType];
  const radiusMeters = detailContract ? finiteWorldUnitsToMeters(detailContract.radius) : 0;
  const destructible = detailContract?.destructible === true;
  const collision = destructible
    ? Object.freeze({
      shape: 'horizontal-circle', radiusMeters, halfExtents: null,
      heightMeters: visualBounds.height, blocksPlayer: false,
    })
    : noCollision(visualBounds.height);
  const lodPolicy = detailType === 'grass'
    ? W8_GRASS_CANONICAL_LOD_POLICY
    : detailType === 'shrub' ? W8_SHRUB_CANONICAL_LOD_POLICY
      : W8_NEAR_ONLY_CANONICAL_LOD_POLICY;
  return baseRecord({
    source,
    objectType: detailType,
    stableId: source.stableId,
    position: source.worldPosition,
    owner: source.owningChunkCoordinate,
    rotationY: source.rotationY ?? 0,
    visualBounds,
    matrixDimensionsMeters: visualBounds,
    collision,
    interaction: detailInteraction(detailType, radiusMeters),
    destructible,
    lodPolicy,
    presentation: presentation(
      detailType,
      W8_PARITY_FEATURE_PARTS[detailType],
      lodPolicy.presentationTiers,
    ),
    extension: {
      sourceKind: source.parentRoadStableId ? 'street-detail' : 'ambient-detail',
      detailType,
      parentRoadStableId: source.parentRoadStableId ?? null,
      variation,
    },
    compatibility: {
      featureType: source.parentRoadStableId ? 'street-detail' : 'ambient-detail',
      detailType,
      parentRoadStableId: source.parentRoadStableId ?? null,
    },
  });
}

export function resolveW8CanonicalWorldObject(source) {
  if (!source || typeof source !== 'object') {
    throw new TypeError('World Object source record is required');
  }
  if (source.schemaVersion === W8_CANONICAL_WORLD_OBJECT_SCHEMA) return source;
  const cached = canonicalBySource.get(source);
  if (cached) return cached;
  const naturalSubtype = ['broadleaf-tree', 'conifer-tree', 'wetland-tree', 'shrub']
    .includes(source.subtype);
  if (source.candidateType === 'rock' || source.featureType === 'natural-rock'
    || (source.candidateId && !naturalSubtype && !source.featureType)) {
    return resolveRock(source);
  }
  if (source.candidateType === 'vegetation' || source.featureType === 'natural-vegetation'
    || (source.candidateId && naturalSubtype)) {
    return resolveNatural(source);
  }
  if (source.featureType === 'settlement-building') return resolveBuilding(source);
  if (source.featureType === 'settlement-landmark' || typeof source.landmarkType === 'string') {
    return resolveLandmark(source);
  }
  if (['grass', 'shrub', 'streetLamp', 'roadSign', ...W8_RESERVED_WORLD_DETAIL_TYPES]
    .includes(source.detailType)) return resolveDetail(source);
  throw new Error(`unsupported canonical World Object source: ${source.featureType
    ?? source.landmarkType ?? source.detailType ?? source.candidateType ?? 'unknown'}`);
}

export function resolveW8ObjectVisibilityMeters(record, renderDistancePreset = 'current') {
  const policy = resolveW8RenderDistancePolicy(renderDistancePreset);
  if (record?.lodPolicy?.visibilityClass === 'natural') return policy.naturalVisibilityMeters;
  if (record?.lodPolicy?.visibilityClass === 'general-object') {
    return policy.generalObjectVisibilityMeters;
  }
  if (record?.lodPolicy?.visibilityClass === 'near-only') return 0;
  const direct = record?.lodPolicy?.visibilityMeters?.[policy.id];
  return Number.isFinite(direct) && direct >= 0 ? direct : 0;
}

export function resolveW8RockCandidateVisual(source) {
  const record = resolveW8CanonicalWorldObject(source);
  if (record.objectType !== 'rock') throw new TypeError('Rock candidate is required');
  return Object.freeze({
    visualKind: record.presentation.partSetKey,
    sizeClass: record.sizeClass,
    scaleMeters: record.widthMeters,
    widthMeters: record.widthMeters,
    heightMeters: record.heightMeters,
    depthMeters: record.depthMeters,
    outerWidthMeters: record.visualBounds.width,
    outerHeightMeters: record.visualBounds.height,
    outerDepthMeters: record.visualBounds.depth,
    rotationY: record.rotationY,
  });
}

export const resolveW8RockCanonicalObject = source => {
  const record = resolveW8CanonicalWorldObject(source);
  if (record.objectType !== 'rock') throw new TypeError('Rock candidate is required');
  return record;
};

export const resolveW8RockVisibilityMeters = (record, renderDistancePreset = 'current') => (
  resolveW8ObjectVisibilityMeters(
    record ?? { lodPolicy: W8_ROCK_CANONICAL_LOD_POLICY },
    renderDistancePreset,
  )
);
