import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
  resolveW8RenderDistancePolicy,
} from './render-distance-policy.js';
export const W8_VEGETATION_LOD_KINDS = Object.freeze({
  TREE: 'tree',
  BUSH: 'bush',
  GRASS: 'grass',
  ROCK: 'rock',
});

export const W8_VEGETATION_LOD_TIERS = Object.freeze({
  FULL: 'full',
  FOREST: 'forest',
  ATMOSPHERIC: 'atmospheric',
  FAR: 'far',
});

export const W8_VEGETATION_VISIBILITY_CONTRACT_SCHEMA =
  'w8-vegetation-visibility-contract-1';

export const W8_FOREST_SILHOUETTE_COLOR_HEX = 0x28512f;
export const W8_ATMOSPHERIC_VEGETATION_COLOR_HEX = 0x49674f;

const CURRENT_NATURAL_VISIBILITY_METERS = 140;
const NEAR_OWNER_HANDOFF_SAFE_METERS = 48;
const CANONICAL_FAR_FADE_START_RATIO = 0.92;
const CANONICAL_FAR_TREE_OUTER_DENSITY = 0.24;
const CANONICAL_FAR_TREE_INNER_DENSITY = 0.48;
const CANONICAL_FAR_TREE_DENSITY_FADE = 0.012;
const q6 = value => Math.round(value * 1e6) / 1e6;
const clamp = value => Math.max(0, Math.min(1, value));
const smoothstep = value => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

const handoffSafeBand = (minimum, maximum, scale) => {
  const start = Math.max(NEAR_OWNER_HANDOFF_SAFE_METERS, minimum * scale);
  return Object.freeze({
    minimum: q6(start),
    maximum: q6(start + Math.max(4, (maximum - minimum) * scale)),
  });
};

const noFar = Object.freeze({
  farEntry: null,
  farFade: null,
  farVisibilityMeters: null,
});

const profileFor = (kind, renderDistance) => {
  const { naturalVisibilityMeters } = renderDistance;
  const scale = naturalVisibilityMeters / CURRENT_NATURAL_VISIBILITY_METERS;
  if (kind === W8_VEGETATION_LOD_KINDS.TREE) {
    const fullToForest = handoffSafeBand(54, 58, scale);
    const forestStart = Math.max(fullToForest.maximum + 8, 76 * scale);
    const forestToAtmospheric = Object.freeze({
      minimum: q6(forestStart),
      maximum: q6(forestStart + Math.max(6, 8 * scale)),
    });
    const atmosphericFade = Object.freeze({
      minimum: q6(Math.max(forestToAtmospheric.maximum + 8, 124 * scale)),
      maximum: naturalVisibilityMeters,
    });
    const farFade = Object.freeze({
      minimum: q6(Math.max(
        atmosphericFade.maximum,
        renderDistance.fogFarMeters * CANONICAL_FAR_FADE_START_RATIO,
      )),
      // Keep the 300m boundary drawable; visibility itself remains capped at
      // fogFar, while the fade curve would reach zero just outside that cap.
      maximum: q6(renderDistance.fogFarMeters + 4),
    });
    return Object.freeze({
      kind,
      fullToForest,
      forestToAtmospheric,
      atmosphericFade,
      visibilityMeters: renderDistance.fogFarMeters,
      // Every canonical Tree tier keeps the same physical silhouette. Distance
      // changes geometry complexity and fog, never object scale.
      forestScale: 1,
      atmosphericScale: 1,
      farEntry: atmosphericFade,
      farFade,
      farVisibilityMeters: renderDistance.fogFarMeters,
      farDensity: Object.freeze({
        schemaVersion: 'w8-canonical-far-tree-density-1',
        innerDistanceMeters: atmosphericFade.maximum,
        outerDistanceMeters: renderDistance.fogFarMeters,
        innerDensity: CANONICAL_FAR_TREE_INNER_DENSITY,
        outerDensity: CANONICAL_FAR_TREE_OUTER_DENSITY,
        rankFadeWidth: CANONICAL_FAR_TREE_DENSITY_FADE,
      }),
    });
  }
  if (kind === W8_VEGETATION_LOD_KINDS.BUSH) {
    const fullToForest = handoffSafeBand(44, 56, scale);
    const forestStart = Math.max(fullToForest.maximum + 8, 76 * scale);
    const forestToAtmospheric = Object.freeze({
      minimum: q6(forestStart),
      maximum: q6(forestStart + Math.max(6, 12 * scale)),
    });
    return Object.freeze({
      kind,
      fullToForest,
      forestToAtmospheric,
      atmosphericFade: Object.freeze({
        minimum: q6(Math.max(forestToAtmospheric.maximum + 4, 116 * scale)),
        maximum: naturalVisibilityMeters,
      }),
      visibilityMeters: naturalVisibilityMeters,
      forestScale: 1.12,
      atmosphericScale: 1.18,
      ...noFar,
    });
  }
  if (kind === W8_VEGETATION_LOD_KINDS.GRASS) {
    const visibilityMeters = q6(Math.min(
      naturalVisibilityMeters,
      Math.max(64, 84 * scale),
    ));
    const fullToForest = Object.freeze({ minimum: 48, maximum: 52 });
    const forestToAtmospheric = Object.freeze({ minimum: 56, maximum: 60 });
    return Object.freeze({
      kind,
      fullToForest,
      forestToAtmospheric,
      atmosphericFade: Object.freeze({
        minimum: q6(Math.max(forestToAtmospheric.maximum, 68 * scale)),
        maximum: visibilityMeters,
      }),
      visibilityMeters,
      forestScale: 1.2,
      atmosphericScale: 1.3,
      ...noFar,
    });
  }
  if (kind === W8_VEGETATION_LOD_KINDS.ROCK) {
    const fullToForest = handoffSafeBand(76, 92, scale);
    return Object.freeze({
      kind,
      fullToForest,
      forestToAtmospheric: null,
      atmosphericFade: Object.freeze({
        minimum: q6(Math.max(fullToForest.maximum + 8, 124 * scale)),
        maximum: naturalVisibilityMeters,
      }),
      visibilityMeters: naturalVisibilityMeters,
      forestScale: 1,
      atmosphericScale: 1,
      ...noFar,
    });
  }
  throw new RangeError(`unsupported Vegetation LOD kind: ${kind}`);
};

const policyCache = new Map();
const visibilityContractCache = new Map();

export function resolveW8VegetationLodPolicy(
  kind,
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  const renderDistance = resolveW8RenderDistancePolicy(renderDistancePreset);
  const key = `${renderDistance.id}:${kind}`;
  if (policyCache.has(key)) return policyCache.get(key);
  const policy = Object.freeze({
    schemaVersion: 'w8-vegetation-lod-policy-1',
    renderDistancePreset: renderDistance.id,
    ...profileFor(kind, renderDistance),
  });
  policyCache.set(key, policy);
  return policy;
}

export function resolveW8CanonicalFarTreeDensityRank(stableId) {
  if (typeof stableId !== 'string' || stableId.length === 0) {
    throw new TypeError('canonical Far Tree density requires a Stable ID');
  }
  let hash = 0x811c9dc5;
  for (const character of stableId) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x1_0000_0000;
}

export function resolveW8CanonicalFarTreeDensityThreshold(policy, distanceMeters) {
  const density = policy?.farDensity;
  if (!density) return 1;
  const distance = Number.isFinite(distanceMeters)
    ? distanceMeters : density.outerDistanceMeters;
  const span = density.outerDistanceMeters - density.innerDistanceMeters;
  const progress = span > 0
    ? clamp((density.outerDistanceMeters - distance) / span)
    : Number(distance <= density.innerDistanceMeters);
  return q6(
    density.outerDensity
      + (density.innerDensity - density.outerDensity) * progress,
  );
}

export function resolveW8CanonicalFarTreeDensityOpacity({
  policy,
  distanceMeters,
  stableId,
  densityRank = null,
} = {}) {
  const density = policy?.farDensity;
  if (!density) return 1;
  const rank = Number.isFinite(densityRank)
    ? densityRank : resolveW8CanonicalFarTreeDensityRank(stableId);
  const threshold = resolveW8CanonicalFarTreeDensityThreshold(policy, distanceMeters);
  return q6(smoothstep((threshold - rank) / density.rankFadeWidth));
}

export function resolveW8VegetationVisibilityContract(
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  const renderDistance = resolveW8RenderDistancePolicy(renderDistancePreset);
  if (visibilityContractCache.has(renderDistance.id)) {
    return visibilityContractCache.get(renderDistance.id);
  }
  const byKind = Object.freeze(Object.fromEntries(
    Object.values(W8_VEGETATION_LOD_KINDS).map(kind => {
      const policy = resolveW8VegetationLodPolicy(kind, renderDistance.id);
      return [kind, Object.freeze({
        kind,
        exactDistanceMeters: policy.visibilityMeters,
        horizonDistanceMeters: null,
      })];
    }),
  ));
  const contract = Object.freeze({
    schemaVersion: W8_VEGETATION_VISIBILITY_CONTRACT_SCHEMA,
    renderDistancePreset: renderDistance.id,
    byKind,
  });
  visibilityContractCache.set(renderDistance.id, contract);
  return contract;
}

const transitionProgress = (distanceMeters, band) => {
  if (!band) return 0;
  const width = band.maximum - band.minimum;
  if (!(width > 0)) return distanceMeters >= band.maximum ? 1 : 0;
  return smoothstep((distanceMeters - band.minimum) / width);
};

export function evaluateW8VegetationLodBlend(policy, distanceMeters, target = {}) {
  const distance = Number.isFinite(distanceMeters) ? Math.max(0, distanceMeters) : Infinity;
  const fullToForest = transitionProgress(distance, policy.fullToForest);
  const forestToAtmospheric = policy.forestToAtmospheric
    ? transitionProgress(distance, policy.forestToAtmospheric)
    : fullToForest;
  const atmosphericFade = transitionProgress(distance, policy.atmosphericFade);
  const farEntry = transitionProgress(distance, policy.farEntry);
  const farFade = transitionProgress(distance, policy.farFade);
  const forest = policy.forestToAtmospheric
    ? fullToForest * (1 - forestToAtmospheric)
    : 0;
  target.full = q6(1 - fullToForest);
  target.forest = q6(forest);
  target.atmospheric = q6(forestToAtmospheric * (1 - atmosphericFade));
  target.far = policy.farEntry
    ? q6(farEntry * (1 - farFade))
    : 0;
  target.totalOpacity = q6(
    target.full + target.forest + target.atmospheric + target.far,
  );
  target.dominantTier = null;
  if (target.totalOpacity > 0) {
    if (target.far > target.atmospheric
      && target.far >= target.forest && target.far >= target.full) {
      target.dominantTier = W8_VEGETATION_LOD_TIERS.FAR;
    } else if (target.atmospheric >= target.forest
      && target.atmospheric >= target.full) {
      target.dominantTier = W8_VEGETATION_LOD_TIERS.ATMOSPHERIC;
    } else if (target.forest >= target.full) {
      target.dominantTier = W8_VEGETATION_LOD_TIERS.FOREST;
    } else {
      target.dominantTier = W8_VEGETATION_LOD_TIERS.FULL;
    }
  }
  target.crossFade = Number(target.full > 0) + Number(target.forest > 0)
    + Number(target.atmospheric > 0) + Number(target.far > 0) > 1;
  target.visible = target.totalOpacity > 0
    && distance <= policy.visibilityMeters;
  target.policy = policy;
  return target;
}

export function resolveW8VegetationLodBlend({
  kind,
  distanceMeters,
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
} = {}) {
  const policy = resolveW8VegetationLodPolicy(kind, renderDistancePreset);
  return Object.freeze({ ...evaluateW8VegetationLodBlend(policy, distanceMeters) });
}

export function naturalPresentationKind(record) {
  if (record?.featureType === 'natural-rock' || record?.objectType === 'rock') {
    return W8_VEGETATION_LOD_KINDS.ROCK;
  }
  if (record?.featureType === 'natural-vegetation') {
    return record.subtype === 'shrub'
      ? W8_VEGETATION_LOD_KINDS.BUSH : W8_VEGETATION_LOD_KINDS.TREE;
  }
  if (record?.objectType === 'shrub') return W8_VEGETATION_LOD_KINDS.BUSH;
  if (record?.objectType === 'grass') return W8_VEGETATION_LOD_KINDS.GRASS;
  return null;
}
