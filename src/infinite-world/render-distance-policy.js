export const W8_RENDER_DISTANCE_PRESET_IDS = Object.freeze({
  SHORT: 'short',
  STANDARD: 'standard',
  CURRENT: 'current',
});

export const W8_DEFAULT_RENDER_DISTANCE_PRESET = W8_RENDER_DISTANCE_PRESET_IDS.CURRENT;
export const W8_RENDER_FOG_COLOR_HEX = 0x5dade2;

const CURRENT_NATURAL_VISIBILITY_METERS = 140;
const CURRENT_GENERAL_OBJECT_VISIBILITY_METERS = 187.5;
const CURRENT_TERRAIN_RIVER_EXTENT_METERS = 352;
const CURRENT_NATURAL_INNER_WARM_METERS = 84;
const CURRENT_SETTLEMENT_HANDOFF_HALF_WIDTH_METERS = 6;
const q6 = value => Math.round(value * 1e6) / 1e6;
const clamp = value => Math.max(0, Math.min(1, value));
const smoothstep = value => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

const treeLodFor = naturalVisibilityMeters => {
  const scale = naturalVisibilityMeters / CURRENT_NATURAL_VISIBILITY_METERS;
  return Object.freeze({
    fullToSilhouette: Object.freeze({ minimum: q6(54 * scale), maximum: q6(58 * scale) }),
    silhouetteToUltra: Object.freeze({ minimum: q6(76 * scale), maximum: q6(84 * scale) }),
    silhouetteVisibility: q6(84 * scale),
    ultraFadeStart: q6(124 * scale),
    ultraVisibility: naturalVisibilityMeters,
  });
};

const settlementLodFor = generalObjectVisibilityMeters => {
  const scale = generalObjectVisibilityMeters / CURRENT_GENERAL_OBJECT_VISIBILITY_METERS;
  const fullDistanceMeters = q6(140 * scale);
  const handoffHalfWidthMeters = q6(
    CURRENT_SETTLEMENT_HANDOFF_HALF_WIDTH_METERS * scale,
  );
  return Object.freeze({
    fullDistanceMeters,
    handoffStartMeters: q6(fullDistanceMeters - handoffHalfWidthMeters),
    handoffEndMeters: q6(fullDistanceMeters + handoffHalfWidthMeters),
    handoffWidthMeters: q6(handoffHalfWidthMeters * 2),
    fadeStartMeters: q6(171.5 * scale),
    visibilityMeters: generalObjectVisibilityMeters,
  });
};

const preset = ({
  id,
  naturalVisibilityMeters,
  terrainRiverExtentMeters,
  generalObjectVisibilityMeters,
  settlementHorizonMeters,
}) => Object.freeze({
  schemaVersion: 'w8-render-distance-policy-1',
  id,
  naturalVisibilityMeters,
  naturalInnerWarmMeters: Math.min(
    naturalVisibilityMeters,
    CURRENT_NATURAL_INNER_WARM_METERS,
  ),
  terrainRiverExtentMeters,
  generalObjectVisibilityMeters,
  settlementHorizonMeters,
  // Preserve the current 300m fog relationship while keeping it independent
  // from graphics quality and safely inside every Terrain extent.
  fogFarMeters: q6(
    terrainRiverExtentMeters * 300 / CURRENT_TERRAIN_RIVER_EXTENT_METERS,
  ),
  treeLod: treeLodFor(naturalVisibilityMeters),
  settlementLod: settlementLodFor(generalObjectVisibilityMeters),
});

export const W8_RENDER_DISTANCE_PRESETS = Object.freeze({
  [W8_RENDER_DISTANCE_PRESET_IDS.SHORT]: preset({
    id: W8_RENDER_DISTANCE_PRESET_IDS.SHORT,
    naturalVisibilityMeters: 84,
    terrainRiverExtentMeters: 192,
    generalObjectVisibilityMeters: 112.5,
    settlementHorizonMeters: 352,
  }),
  [W8_RENDER_DISTANCE_PRESET_IDS.STANDARD]: preset({
    id: W8_RENDER_DISTANCE_PRESET_IDS.STANDARD,
    naturalVisibilityMeters: 112,
    terrainRiverExtentMeters: 256,
    generalObjectVisibilityMeters: 150,
    settlementHorizonMeters: 656.25,
  }),
  [W8_RENDER_DISTANCE_PRESET_IDS.CURRENT]: preset({
    id: W8_RENDER_DISTANCE_PRESET_IDS.CURRENT,
    naturalVisibilityMeters: 140,
    terrainRiverExtentMeters: 352,
    generalObjectVisibilityMeters: 187.5,
    settlementHorizonMeters: 875,
  }),
});

export function isW8RenderDistancePresetId(value) {
  return typeof value === 'string' && Object.hasOwn(W8_RENDER_DISTANCE_PRESETS, value);
}

export function normalizeW8RenderDistancePreset(value) {
  return isW8RenderDistancePresetId(value) ? value : W8_DEFAULT_RENDER_DISTANCE_PRESET;
}

export function resolveW8RenderDistancePolicy(value = W8_DEFAULT_RENDER_DISTANCE_PRESET) {
  return W8_RENDER_DISTANCE_PRESETS[normalizeW8RenderDistancePreset(value)];
}

export function resolveW8SettlementHandoffProgress(distanceMeters, settlementLod) {
  const distance = Number.isFinite(distanceMeters) ? Math.max(0, distanceMeters) : Infinity;
  const width = settlementLod?.handoffEndMeters - settlementLod?.handoffStartMeters;
  if (!(width > 0)) return distance < settlementLod?.fullDistanceMeters ? 0 : 1;
  return q6(smoothstep((distance - settlementLod.handoffStartMeters) / width));
}

export function resolveW8SettlementHandoffState(
  distanceMeters,
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  const settlementLod = resolveW8RenderDistancePolicy(renderDistancePreset).settlementLod;
  const horizonOpacity = resolveW8SettlementHandoffProgress(distanceMeters, settlementLod);
  const fullOpacity = q6(1 - horizonOpacity);
  return Object.freeze({
    distanceMeters,
    handoffStartMeters: settlementLod.handoffStartMeters,
    handoffCenterMeters: settlementLod.fullDistanceMeters,
    handoffEndMeters: settlementLod.handoffEndMeters,
    fullOpacity,
    horizonOpacity,
    totalOpacity: q6(fullOpacity + horizonOpacity),
    selectedTier: fullOpacity === 0
      ? 'horizon' : horizonOpacity === 0 ? 'full' : 'full-horizon-handoff',
  });
}

export const W8_CURRENT_TREE_LOD_METERS =
  W8_RENDER_DISTANCE_PRESETS[W8_RENDER_DISTANCE_PRESET_IDS.CURRENT].treeLod;
export const W8_CURRENT_SETTLEMENT_LOD_METERS =
  W8_RENDER_DISTANCE_PRESETS[W8_RENDER_DISTANCE_PRESET_IDS.CURRENT].settlementLod;
