export const W8_RENDER_DISTANCE_PRESET_IDS = Object.freeze({
  SHORT: 'short',
  STANDARD: 'standard',
  CURRENT: 'current',
});

export const W8_DEFAULT_RENDER_DISTANCE_PRESET = W8_RENDER_DISTANCE_PRESET_IDS.CURRENT;
export const W8_RENDER_FOG_COLOR_HEX = 0x5dade2;

export const W8_WORLD_PRESENTATION_DISTANCE_CONTRACT_SCHEMA =
  'w8-world-presentation-distance-contract-1';

export const W8_RENDER_DISTANCE_CHANNELS = Object.freeze({
  WORLD_PRESENTATION: 'world-presentation',
  TERRAIN_COVERAGE: 'terrain-coverage',
  GENERAL_DETAIL: 'general-detail',
  NATURAL_DETAIL: 'natural-detail',
  NATURAL_INNER_WARM: 'natural-inner-warm',
  SETTLEMENT_METADATA: 'settlement-metadata',
});

/**
 * One Render Distance preset controls a small set of semantic lanes.
 *
 * WORLD is the useful visible-world boundary used by Terrain/Fog and coarse
 * world-defining silhouettes. DETAIL keeps expensive authored presentation
 * closer to the player. METADATA is sparse query reach and is not drawable
 * distance. Future Object kinds should select one of these shared lanes rather
 * than introducing an Object-specific Render Distance setting.
 */
export const W8_PRESENTATION_DISTANCE_LANES = Object.freeze({
  WORLD: 'world',
  DETAIL: 'detail',
  METADATA: 'metadata',
});

export const W8_PRESENTATION_DISTANCE_KINDS = Object.freeze({
  TERRAIN: 'terrain',
  TREE: 'tree',
  ROAD: 'road',
  BUILDING: 'building',
  NATURAL: 'natural',
  SETTLEMENT: 'settlement',
});

const presentationDistanceKinds = new Set(Object.values(W8_PRESENTATION_DISTANCE_KINDS));
const renderDistanceChannels = new Set(Object.values(W8_RENDER_DISTANCE_CHANNELS));
const CURRENT_WORLD_PRESENTATION_DISTANCE_METERS = 300;
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

const treeLodFor = naturalDetailDistanceMeters => {
  const scale = naturalDetailDistanceMeters / CURRENT_NATURAL_VISIBILITY_METERS;
  return Object.freeze({
    fullToSilhouette: Object.freeze({ minimum: q6(54 * scale), maximum: q6(58 * scale) }),
    silhouetteToUltra: Object.freeze({ minimum: q6(76 * scale), maximum: q6(84 * scale) }),
    silhouetteVisibility: q6(84 * scale),
    ultraFadeStart: q6(124 * scale),
    ultraVisibility: naturalDetailDistanceMeters,
  });
};

const settlementLodFor = generalDetailDistanceMeters => {
  const scale = generalDetailDistanceMeters / CURRENT_GENERAL_OBJECT_VISIBILITY_METERS;
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
    visibilityMeters: generalDetailDistanceMeters,
  });
};

const presentationProfile = ({
  kind,
  lane,
  visibilityMeters,
  coverageMeters = null,
  innerWarmMeters = null,
  queryDistanceMeters = null,
}) => Object.freeze({
  kind,
  lane,
  visibilityMeters,
  coverageMeters,
  innerWarmMeters,
  queryDistanceMeters,
});

const createDistanceContract = ({
  id,
  worldScale,
  detailScale,
  settlementMetadataDistanceMeters,
}) => {
  const worldPresentationDistanceMeters = q6(
    CURRENT_WORLD_PRESENTATION_DISTANCE_METERS * worldScale,
  );
  const terrainCoverageDistanceMeters = q6(
    CURRENT_TERRAIN_RIVER_EXTENT_METERS * worldScale,
  );
  const generalDetailDistanceMeters = q6(
    CURRENT_GENERAL_OBJECT_VISIBILITY_METERS * detailScale,
  );
  const naturalDetailDistanceMeters = q6(
    CURRENT_NATURAL_VISIBILITY_METERS * detailScale,
  );
  const naturalInnerWarmDistanceMeters = q6(Math.min(
    naturalDetailDistanceMeters,
    CURRENT_NATURAL_INNER_WARM_METERS,
  ));

  const distanceByChannel = Object.freeze({
    [W8_RENDER_DISTANCE_CHANNELS.WORLD_PRESENTATION]: worldPresentationDistanceMeters,
    [W8_RENDER_DISTANCE_CHANNELS.TERRAIN_COVERAGE]: terrainCoverageDistanceMeters,
    [W8_RENDER_DISTANCE_CHANNELS.GENERAL_DETAIL]: generalDetailDistanceMeters,
    [W8_RENDER_DISTANCE_CHANNELS.NATURAL_DETAIL]: naturalDetailDistanceMeters,
    [W8_RENDER_DISTANCE_CHANNELS.NATURAL_INNER_WARM]: naturalInnerWarmDistanceMeters,
    [W8_RENDER_DISTANCE_CHANNELS.SETTLEMENT_METADATA]: settlementMetadataDistanceMeters,
  });

  const lanes = Object.freeze({
    [W8_PRESENTATION_DISTANCE_LANES.WORLD]: Object.freeze({
      lane: W8_PRESENTATION_DISTANCE_LANES.WORLD,
      scale: q6(worldScale),
      visibilityMeters: worldPresentationDistanceMeters,
      terrainCoverageMeters: terrainCoverageDistanceMeters,
    }),
    [W8_PRESENTATION_DISTANCE_LANES.DETAIL]: Object.freeze({
      lane: W8_PRESENTATION_DISTANCE_LANES.DETAIL,
      scale: q6(detailScale),
      visibilityMeters: generalDetailDistanceMeters,
      naturalVisibilityMeters: naturalDetailDistanceMeters,
      naturalInnerWarmMeters: naturalInnerWarmDistanceMeters,
    }),
    [W8_PRESENTATION_DISTANCE_LANES.METADATA]: Object.freeze({
      lane: W8_PRESENTATION_DISTANCE_LANES.METADATA,
      settlementQueryDistanceMeters: settlementMetadataDistanceMeters,
    }),
  });

  const byKind = Object.freeze({
    [W8_PRESENTATION_DISTANCE_KINDS.TERRAIN]: presentationProfile({
      kind: W8_PRESENTATION_DISTANCE_KINDS.TERRAIN,
      lane: W8_PRESENTATION_DISTANCE_LANES.WORLD,
      visibilityMeters: worldPresentationDistanceMeters,
      coverageMeters: terrainCoverageDistanceMeters,
    }),
    [W8_PRESENTATION_DISTANCE_KINDS.TREE]: presentationProfile({
      kind: W8_PRESENTATION_DISTANCE_KINDS.TREE,
      lane: W8_PRESENTATION_DISTANCE_LANES.WORLD,
      visibilityMeters: worldPresentationDistanceMeters,
    }),
    [W8_PRESENTATION_DISTANCE_KINDS.ROAD]: presentationProfile({
      kind: W8_PRESENTATION_DISTANCE_KINDS.ROAD,
      lane: W8_PRESENTATION_DISTANCE_LANES.WORLD,
      visibilityMeters: worldPresentationDistanceMeters,
    }),
    [W8_PRESENTATION_DISTANCE_KINDS.BUILDING]: presentationProfile({
      kind: W8_PRESENTATION_DISTANCE_KINDS.BUILDING,
      lane: W8_PRESENTATION_DISTANCE_LANES.DETAIL,
      visibilityMeters: generalDetailDistanceMeters,
    }),
    [W8_PRESENTATION_DISTANCE_KINDS.NATURAL]: presentationProfile({
      kind: W8_PRESENTATION_DISTANCE_KINDS.NATURAL,
      lane: W8_PRESENTATION_DISTANCE_LANES.DETAIL,
      visibilityMeters: naturalDetailDistanceMeters,
      innerWarmMeters: naturalInnerWarmDistanceMeters,
    }),
    [W8_PRESENTATION_DISTANCE_KINDS.SETTLEMENT]: presentationProfile({
      kind: W8_PRESENTATION_DISTANCE_KINDS.SETTLEMENT,
      lane: W8_PRESENTATION_DISTANCE_LANES.DETAIL,
      visibilityMeters: generalDetailDistanceMeters,
      queryDistanceMeters: settlementMetadataDistanceMeters,
    }),
  });

  const maximumVisibleDistanceMeters = Math.max(
    ...Object.values(byKind).map(profile => profile.visibilityMeters ?? 0),
  );
  return Object.freeze({
    schemaVersion: W8_WORLD_PRESENTATION_DISTANCE_CONTRACT_SCHEMA,
    renderDistancePreset: id,
    distanceByChannel,
    lanes,
    byKind,
    worldPresentationDistanceMeters,
    terrainCoverageDistanceMeters,
    generalDetailDistanceMeters,
    naturalDetailDistanceMeters,
    naturalInnerWarmDistanceMeters,
    settlementMetadataDistanceMeters,
    maximumVisibleDistanceMeters,
    residentCoverageDistanceMeters: Math.max(
      terrainCoverageDistanceMeters,
      maximumVisibleDistanceMeters,
    ),
  });
};

const preset = ({
  id,
  worldScale,
  detailScale,
  settlementMetadataDistanceMeters,
}) => {
  const distanceContract = createDistanceContract({
    id,
    worldScale,
    detailScale,
    settlementMetadataDistanceMeters,
  });
  const terrain = distanceContract.byKind[W8_PRESENTATION_DISTANCE_KINDS.TERRAIN];
  const tree = distanceContract.byKind[W8_PRESENTATION_DISTANCE_KINDS.TREE];
  const road = distanceContract.byKind[W8_PRESENTATION_DISTANCE_KINDS.ROAD];
  const building = distanceContract.byKind[W8_PRESENTATION_DISTANCE_KINDS.BUILDING];
  const natural = distanceContract.byKind[W8_PRESENTATION_DISTANCE_KINDS.NATURAL];
  const settlement = distanceContract.byKind[W8_PRESENTATION_DISTANCE_KINDS.SETTLEMENT];

  return Object.freeze({
    schemaVersion: 'w8-render-distance-policy-1',
    id,
    distanceContract,
    worldPresentationDistanceContract: distanceContract,
    distanceByChannel: distanceContract.distanceByChannel,

    // Canonical semantic fields used by current and future presentation code.
    worldPresentationDistanceMeters: distanceContract.worldPresentationDistanceMeters,
    terrainCoverageDistanceMeters: distanceContract.terrainCoverageDistanceMeters,
    detailPresentationDistanceMeters: distanceContract.generalDetailDistanceMeters,
    generalDetailDistanceMeters: distanceContract.generalDetailDistanceMeters,
    naturalDetailDistanceMeters: distanceContract.naturalDetailDistanceMeters,
    naturalInnerWarmDistanceMeters: distanceContract.naturalInnerWarmDistanceMeters,
    settlementMetadataDistanceMeters: distanceContract.settlementMetadataDistanceMeters,

    // Compatibility aliases. The nested distanceContract is the only source
    // of truth; existing snapshots/tools can migrate without changing the
    // current Short / Standard / Current visual boundaries.
    naturalVisibilityMeters: natural.visibilityMeters,
    naturalInnerWarmMeters: natural.innerWarmMeters,
    terrainRiverExtentMeters: terrain.coverageMeters,
    generalObjectVisibilityMeters: building.visibilityMeters,
    settlementHorizonMeters: settlement.queryDistanceMeters,
    fogFarMeters: tree.visibilityMeters,
    majorSilhouetteVisibilityMeters: road.visibilityMeters,

    treeLod: treeLodFor(natural.visibilityMeters),
    settlementLod: settlementLodFor(building.visibilityMeters),
  });
};

export const W8_RENDER_DISTANCE_PRESETS = Object.freeze({
  [W8_RENDER_DISTANCE_PRESET_IDS.SHORT]: preset({
    id: W8_RENDER_DISTANCE_PRESET_IDS.SHORT,
    // Preserve the historical 192m Terrain / 163.636364m Fog relationship.
    worldScale: 6 / 11,
    // Preserve the historical 84m Natural / 112.5m general-detail reach.
    detailScale: 0.6,
    settlementMetadataDistanceMeters: 352,
  }),
  [W8_RENDER_DISTANCE_PRESET_IDS.STANDARD]: preset({
    id: W8_RENDER_DISTANCE_PRESET_IDS.STANDARD,
    worldScale: 8 / 11,
    detailScale: 0.8,
    settlementMetadataDistanceMeters: 656.25,
  }),
  [W8_RENDER_DISTANCE_PRESET_IDS.CURRENT]: preset({
    id: W8_RENDER_DISTANCE_PRESET_IDS.CURRENT,
    worldScale: 1,
    detailScale: 1,
    settlementMetadataDistanceMeters: 875,
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


export function isW8RenderDistanceChannel(value) {
  return typeof value === 'string' && renderDistanceChannels.has(value);
}

export function resolveW8RenderDistanceMeters(
  channel,
  value = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  if (!isW8RenderDistanceChannel(channel)) {
    throw new RangeError(`unsupported Render Distance channel: ${channel}`);
  }
  return resolveW8WorldPresentationDistanceContract(value).distanceByChannel[channel];
}

export function isW8PresentationDistanceKind(value) {
  return typeof value === 'string' && presentationDistanceKinds.has(value);
}

export function resolveW8WorldPresentationDistanceContract(
  value = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  return resolveW8RenderDistancePolicy(value).distanceContract;
}

export function resolveW8PresentationDistanceProfile(
  kind,
  value = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  if (!isW8PresentationDistanceKind(kind)) {
    throw new RangeError(`unsupported World Presentation distance kind: ${kind}`);
  }
  return resolveW8WorldPresentationDistanceContract(value).byKind[kind];
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
