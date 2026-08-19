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

export const W8_CANONICAL_TREE_DENSITY_SCHEMA = 'w8-canonical-tree-density-2';
export const W8_CANONICAL_TREE_DENSITY_TIERS = Object.freeze({
  NEAR: 'near',
  MID: 'mid',
  FAR: 'far',
});
export const W8_CANONICAL_TREE_DENSITY_THRESHOLDS = Object.freeze({
  [W8_CANONICAL_TREE_DENSITY_TIERS.NEAR]: 1,
  [W8_CANONICAL_TREE_DENSITY_TIERS.MID]: 1,
  [W8_CANONICAL_TREE_DENSITY_TIERS.FAR]: 1,
});
export const W8_CANONICAL_TREE_DENSITY_REFERENCE_METERS = Object.freeze({
  nearMaximum: 100,
  midMaximum: 200,
  farMaximum: 300,
  transitionWidth: 8,
  outerFadeWidth: 8,
});

/**
 * Resolves the single low-poly Tree silhouette shared by Near and Distant
 * presentation. Broadleaf and wetland crowns keep the authored primary crown
 * transform/material but replace the smooth SphereGeometry with the existing
 * detail-0 DodecahedronGeometry. Conifers retain their authored ConeGeometry.
 *
 * The helper is intentionally descriptor-only: canonical identity, dimensions,
 * and world transforms remain unchanged, and isolated test assets can fall back
 * to their authored geometry when a low-poly resource is unavailable.
 */
export function resolveW8LowPolyTreePresentationParts({
  subtype = null,
  parts = [],
  supportsDodeca = true,
  supportsCone = true,
  includeTrunk = true,
} = {}) {
  if (!Array.isArray(parts)) {
    throw new TypeError('low-poly Tree presentation parts must be an array');
  }
  if (parts.length === 0) return Object.freeze([]);

  const trunk = parts.find(part => part?.material === 'treeTrunk')
    ?? parts.find(part => /trunk/i.test(part?.materialRole ?? ''))
    ?? null;
  const conifer = subtype === 'conifer-tree'
    || (subtype === null
      && parts.some(part => part?.geometry === 'cone')
      && !parts.some(part => part?.geometry === 'sphere'));
  const authoredFoliageGeometry = conifer ? 'cone' : 'sphere';
  const foliage = parts.find(part => part?.geometry === authoredFoliageGeometry)
    ?? parts.find(part => part !== trunk && part?.material !== 'treeTrunk')
    ?? parts.find(part => part !== trunk)
    ?? parts[0]
    ?? null;
  if (!foliage) return Object.freeze([]);

  const lowPolyGeometry = conifer
    ? (supportsCone ? 'cone' : foliage.geometry)
    : (supportsDodeca ? 'dodeca' : foliage.geometry);
  const lowPolyFoliage = lowPolyGeometry === foliage.geometry
    ? foliage
    : Object.freeze({ ...foliage, geometry: lowPolyGeometry });
  const resolved = includeTrunk && trunk && trunk !== foliage
    ? [trunk, lowPolyFoliage]
    : [lowPolyFoliage];
  return Object.freeze(resolved);
}

const CURRENT_NATURAL_VISIBILITY_METERS = 140;
const NEAR_OWNER_HANDOFF_SAFE_METERS = 48;
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

const scaledTreeDensityPolicy = renderDistance => {
  const reference = W8_CANONICAL_TREE_DENSITY_REFERENCE_METERS;
  const scale = renderDistance.fogFarMeters / reference.farMaximum;
  const nearMaximum = q6(reference.nearMaximum * scale);
  const midMaximum = q6(reference.midMaximum * scale);
  const farMaximum = renderDistance.fogFarMeters;
  const transitionWidth = q6(Math.max(4, reference.transitionWidth * scale));
  const outerFadeWidth = q6(Math.max(4, reference.outerFadeWidth * scale));
  const nearToMid = Object.freeze({
    // The canonical Near set remains complete through the nominal 100 m
    // boundary. Moving outward may remove ranked silhouettes; approaching can
    // therefore only add them.
    minimum: nearMaximum,
    maximum: q6(nearMaximum + transitionWidth),
  });
  const midToFar = Object.freeze({
    minimum: q6(midMaximum - transitionWidth),
    maximum: midMaximum,
  });
  const farFade = Object.freeze({
    // Keep the exact Fog boundary drawable and finish the fade just outside it.
    minimum: q6(farMaximum - outerFadeWidth / 2),
    maximum: q6(farMaximum + outerFadeWidth / 2),
  });
  return Object.freeze({
    schemaVersion: W8_CANONICAL_TREE_DENSITY_SCHEMA,
    nearMaximumDistanceMeters: nearMaximum,
    midMaximumDistanceMeters: midMaximum,
    farMaximumDistanceMeters: farMaximum,
    transitionWidthMeters: transitionWidth,
    nearToMid,
    midToFar,
    nearDensity: W8_CANONICAL_TREE_DENSITY_THRESHOLDS.near,
    midDensity: W8_CANONICAL_TREE_DENSITY_THRESHOLDS.mid,
    farDensity: W8_CANONICAL_TREE_DENSITY_THRESHOLDS.far,
    rankFadeWidth: CANONICAL_FAR_TREE_DENSITY_FADE,
    // Compatibility names used by the existing instanced geometry admission.
    // innerDensity=1 means every canonical identity can reappear on approach.
    innerDistanceMeters: nearMaximum,
    outerDistanceMeters: farMaximum,
    innerDensity: W8_CANONICAL_TREE_DENSITY_THRESHOLDS.near,
    outerDensity: W8_CANONICAL_TREE_DENSITY_THRESHOLDS.far,
    outerFade: farFade,
  });
};

const profileFor = (kind, renderDistance) => {
  const { naturalVisibilityMeters } = renderDistance;
  const scale = naturalVisibilityMeters / CURRENT_NATURAL_VISIBILITY_METERS;
  if (kind === W8_VEGETATION_LOD_KINDS.TREE) {
    const farDensity = scaledTreeDensityPolicy(renderDistance);
    const fullToForest = farDensity.nearToMid;
    // The renderer retains its existing atmospheric bridge, but the two 4 m
    // halves form one simple 8 m Mid-to-Far representation handoff.
    const forestToAtmospheric = Object.freeze({
      minimum: farDensity.midToFar.minimum,
      maximum: q6((farDensity.midToFar.minimum + farDensity.midToFar.maximum) / 2),
    });
    const atmosphericFade = Object.freeze({
      minimum: forestToAtmospheric.maximum,
      maximum: farDensity.midToFar.maximum,
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
      farFade: farDensity.outerFade,
      farVisibilityMeters: renderDistance.fogFarMeters,
      farDensity,
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

export function resolveW8CanonicalTreeDensityTier(policy, distanceMeters) {
  const density = policy?.farDensity;
  if (!density) return W8_CANONICAL_TREE_DENSITY_TIERS.NEAR;
  const distance = Number.isFinite(distanceMeters)
    ? Math.max(0, distanceMeters) : density.farMaximumDistanceMeters;
  if (distance <= density.nearMaximumDistanceMeters) {
    return W8_CANONICAL_TREE_DENSITY_TIERS.NEAR;
  }
  if (distance < density.midMaximumDistanceMeters) {
    return W8_CANONICAL_TREE_DENSITY_TIERS.MID;
  }
  return W8_CANONICAL_TREE_DENSITY_TIERS.FAR;
}

export function resolveW8CanonicalTreeDensityThreshold(policy, distanceMeters) {
  const density = policy?.farDensity;
  if (!density) return 1;
  const distance = Number.isFinite(distanceMeters)
    ? Math.max(0, distanceMeters) : density.farMaximumDistanceMeters;
  const interpolate = (band, inner, outer) => {
    const width = band.maximum - band.minimum;
    if (!(width > 0)) return distance <= band.minimum ? inner : outer;
    const progress = smoothstep((distance - band.minimum) / width);
    return inner + (outer - inner) * progress;
  };
  if (distance <= density.nearToMid.minimum) return density.nearDensity;
  if (distance < density.nearToMid.maximum) {
    return q6(interpolate(density.nearToMid, density.nearDensity, density.midDensity));
  }
  if (distance <= density.midToFar.minimum) return density.midDensity;
  if (distance < density.midToFar.maximum) {
    return q6(interpolate(density.midToFar, density.midDensity, density.farDensity));
  }
  return density.farDensity;
}

export function resolveW8CanonicalFarTreeDensityThreshold(policy, distanceMeters) {
  return resolveW8CanonicalTreeDensityThreshold(policy, distanceMeters);
}

export function resolveW8CanonicalTreeDensityOpacity({
  policy,
  distanceMeters,
  stableId,
  densityRank = null,
} = {}) {
  const density = policy?.farDensity;
  if (!density) return 1;
  const rank = Number.isFinite(densityRank)
    ? densityRank : resolveW8CanonicalFarTreeDensityRank(stableId);
  const threshold = resolveW8CanonicalTreeDensityThreshold(policy, distanceMeters);
  // Rank is in [0, 1), so the complete Near threshold is truly fully opaque.
  if (threshold >= 1) return 1;
  return q6(smoothstep((threshold - rank) / density.rankFadeWidth));
}

export function resolveW8CanonicalFarTreeDensityOpacity(options = {}) {
  return resolveW8CanonicalTreeDensityOpacity(options);
}

export function isW8CanonicalTreeDensitySelected({
  policy,
  distanceMeters,
  stableId,
  densityRank = null,
} = {}) {
  const rank = Number.isFinite(densityRank)
    ? densityRank : resolveW8CanonicalFarTreeDensityRank(stableId);
  return rank < resolveW8CanonicalTreeDensityThreshold(policy, distanceMeters);
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
