import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
  resolveW8RenderDistancePolicy,
} from './render-distance-policy.js';
export {
  createW8ForestHorizonOwnerPredicate,
  isW8ForestHorizonOwner,
} from './forest-horizon-owner-policy.js';

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
  HORIZON: 'horizon',
});

export const W8_FOREST_SILHOUETTE_COLOR_HEX = 0x28512f;
export const W8_ATMOSPHERIC_VEGETATION_COLOR_HEX = 0x49674f;

const CURRENT_NATURAL_VISIBILITY_METERS = 140;
const NEAR_OWNER_HANDOFF_SAFE_METERS = 48;
const FOREST_HORIZON_FADE_START_RATIO = 0.78;
const FOREST_HORIZON_OWNER_DENSITY = 4;
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

const noHorizon = Object.freeze({
  horizonEntry: null,
  horizonFade: null,
  horizonVisibilityMeters: null,
  horizonScale: null,
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
    const horizonFade = Object.freeze({
      minimum: q6(Math.max(
        atmosphericFade.maximum,
        renderDistance.fogFarMeters * FOREST_HORIZON_FADE_START_RATIO,
      )),
      maximum: renderDistance.fogFarMeters,
    });
    const atmosphericScale = 1.42;
    return Object.freeze({
      kind,
      fullToForest,
      forestToAtmospheric,
      atmosphericFade,
      visibilityMeters: naturalVisibilityMeters,
      // Primary crowns overlap at the formal 2m proposal spacing so the tier
      // reads as one canopy field instead of isolated Tree dots.
      forestScale: 1.28,
      atmosphericScale,
      horizonEntry: atmosphericFade,
      horizonFade,
      horizonVisibilityMeters: renderDistance.fogFarMeters,
      // One canonical owner in four is retained on a bounded-coverage lattice.
      // sqrt(4) preserves projected canopy area without inventing anonymous Trees.
      horizonScale: q6(atmosphericScale * Math.sqrt(FOREST_HORIZON_OWNER_DENSITY)),
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
      ...noHorizon,
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
      ...noHorizon,
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
      ...noHorizon,
    });
  }
  throw new RangeError(`unsupported Vegetation LOD kind: ${kind}`);
};

const policyCache = new Map();

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
  const horizonEntry = transitionProgress(distance, policy.horizonEntry);
  const horizonFade = transitionProgress(distance, policy.horizonFade);
  const forest = policy.forestToAtmospheric
    ? fullToForest * (1 - forestToAtmospheric)
    : 0;
  target.full = q6(1 - fullToForest);
  target.forest = q6(forest);
  target.atmospheric = q6(forestToAtmospheric * (1 - atmosphericFade));
  target.horizon = policy.horizonEntry
    ? q6(horizonEntry * (1 - horizonFade))
    : 0;
  target.totalOpacity = q6(
    target.full + target.forest + target.atmospheric + target.horizon,
  );
  target.dominantTier = null;
  if (target.totalOpacity > 0) {
    if (target.horizon > target.atmospheric
      && target.horizon >= target.forest && target.horizon >= target.full) {
      target.dominantTier = W8_VEGETATION_LOD_TIERS.HORIZON;
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
    + Number(target.atmospheric > 0) + Number(target.horizon > 0) > 1;
  target.visible = target.totalOpacity > 0
    && distance < (policy.horizonVisibilityMeters ?? policy.visibilityMeters);
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
