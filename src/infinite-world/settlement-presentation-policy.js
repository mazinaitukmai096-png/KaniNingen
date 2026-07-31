import { SETTLEMENT_TYPES } from '../settlement-type.js';
import { FINITE_WORLD_UNITS_PER_METER, MIGRATED_SETTLEMENT_PROFILES } from './single-rural-settlement.js';
import { W5_SETTLEMENT_DISTRIBUTION } from './settlement-distributor.js';
import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
  W8_RENDER_DISTANCE_PRESET_IDS,
  W8_RENDER_FOG_COLOR_HEX,
  resolveW8RenderDistancePolicy,
} from './render-distance-policy.js';

export const W8_FINITE_SETTLEMENT_VIEW_CONTRACT = Object.freeze({
  schemaVersion: 'w8-finite-settlement-view-contract-1',
  sourceCommit: 'f8bc9f80c2af417bb585bff26c99522c4229ab8e',
  cameraFarMeters: 35_000 / FINITE_WORLD_UNITS_PER_METER,
});

export const W8_SETTLEMENT_ROLE_LANDMARKS = Object.freeze({
  military: Object.freeze({
    landmarkType: 'militaryBase', widthMeters: 11, heightMeters: 6, depthMeters: 11,
  }),
  residential: Object.freeze({
    landmarkType: 'barn', widthMeters: 7, heightMeters: 5, depthMeters: 7,
  }),
  suburb: Object.freeze({
    landmarkType: 'factory', widthMeters: 9, heightMeters: 8, depthMeters: 8,
  }),
});

const MAXIMUM_FINITE_BUILDING_OPPORTUNITIES = Math.max(
  ...Object.values(MIGRATED_SETTLEMENT_PROFILES).map(profile => (
    Math.round((profile.coreRadius * profile.coreRadius) / 36_000)
  )),
);
const MAXIMUM_ROLE_LANDMARKS_PER_SETTLEMENT = 3;
export const W8_SETTLEMENT_SILHOUETTE_COLOR_HEX = 0x3a3932;
const REMOTE_SETTLEMENT_MAXIMUM_FOG_BLEND = 0.96;
const REMOTE_SETTLEMENT_FOG_EDGE_BLEND = 0.72;
const REMOTE_SETTLEMENT_FOG_EDGE_OPACITY = 0.28;
const minimumFormalSettlementSeparationMeters = Math.min(
  ...Object.values(W5_SETTLEMENT_DISTRIBUTION.minimumDistanceMetersByTypePair)
    .flatMap(byOtherType => Object.values(byOtherType)),
);
const maximumLocalSettlementCenterDistanceMeters = (
  resolveW8RenderDistancePolicy(W8_RENDER_DISTANCE_PRESET_IDS.CURRENT)
    .generalObjectVisibilityMeters
  + W5_SETTLEMENT_DISTRIBUTION.maximumInfluenceRadiusMeters
);
const formalSettlementPackingRadiusMeters = minimumFormalSettlementSeparationMeters / 2;
// Treat each formally spaced candidate as a non-overlapping disc. The expanded
// local selection circle provides a conservative area bound without changing
// the distribution contract or silently making the selection unbounded.
export const W8_LOCAL_SETTLEMENT_SELECTION_LIMIT = Math.floor((
  (maximumLocalSettlementCenterDistanceMeters + formalSettlementPackingRadiusMeters)
    / formalSettlementPackingRadiusMeters
) ** 2);
const qualityPartCount = quality => quality === 'high' ? 2 : 1;
const q6 = value => Math.round(value * 1e6) / 1e6;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const smoothstep = value => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

const mixHexColor = (from, to, ratio) => {
  const t = clamp(ratio, 0, 1);
  const mix = shift => Math.round(
    ((from >> shift) & 0xff) * (1 - t) + ((to >> shift) & 0xff) * t,
  );
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
};

const buildPresentationPolicy = (quality, renderDistancePreset) => {
  const distance = resolveW8RenderDistancePolicy(renderDistancePreset);
  const partsPerBuilding = qualityPartCount(quality);
  const remoteEnabled = distance.id === W8_RENDER_DISTANCE_PRESET_IDS.CURRENT;
  const remoteEndMeters = remoteEnabled
    ? distance.settlementHorizonMeters
    : distance.generalObjectVisibilityMeters;
  return Object.freeze({
    quality: ['high', 'medium', 'low'].includes(quality) ? quality : 'high',
    renderDistancePreset: distance.id,
    metadata: Object.freeze({
      queryDistanceMeters: distance.settlementHorizonMeters,
    }),
    local: Object.freeze({
      fullDistanceMeters: distance.settlementLod.fullDistanceMeters,
      horizonStartMeters: distance.settlementLod.fullDistanceMeters,
      handoffStartMeters: distance.settlementLod.handoffStartMeters,
      handoffEndMeters: distance.settlementLod.handoffEndMeters,
      handoffWidthMeters: distance.settlementLod.handoffWidthMeters,
      fadeStartMeters: distance.settlementLod.fadeStartMeters,
      hiddenDistanceMeters: distance.generalObjectVisibilityMeters,
      settlementLimit: W8_LOCAL_SETTLEMENT_SELECTION_LIMIT,
    }),
    remote: Object.freeze({
      enabled: remoteEnabled,
      horizonStartMeters: distance.generalObjectVisibilityMeters,
      fadeStartMeters: distance.generalObjectVisibilityMeters,
      fadeEndMeters: remoteEndMeters,
      hiddenDistanceMeters: remoteEndMeters,
      fog: false,
      atmosphere: Object.freeze({
        mode: remoteEnabled ? 'manual-fog-blend' : 'disabled',
        silhouetteColorHex: W8_SETTLEMENT_SILHOUETTE_COLOR_HEX,
        fogColorHex: W8_RENDER_FOG_COLOR_HEX,
        fogIntegrationEndMeters: distance.fogFarMeters,
        fogEdgeBlend: REMOTE_SETTLEMENT_FOG_EDGE_BLEND,
        fogEdgeOpacity: REMOTE_SETTLEMENT_FOG_EDGE_OPACITY,
        maximumFogBlend: REMOTE_SETTLEMENT_MAXIMUM_FOG_BLEND,
      }),
      settlementLimit: remoteEnabled ? 4 : 0,
      buildingLimitPerSettlement: MAXIMUM_FINITE_BUILDING_OPPORTUNITIES,
      partsPerBuilding,
      partLimit: 5 * (MAXIMUM_FINITE_BUILDING_OPPORTUNITIES
        + MAXIMUM_ROLE_LANDMARKS_PER_SETTLEMENT) * partsPerBuilding,
    }),
  });
};

// Compatibility snapshot for callers that inspect the historical export. All
// entries use the default distance; quality changes only silhouette part count.
export const W8_SETTLEMENT_PRESENTATION_POLICY = Object.freeze(Object.fromEntries(
  ['high', 'medium', 'low'].map(quality => [
    quality,
    buildPresentationPolicy(quality, W8_DEFAULT_RENDER_DISTANCE_PRESET),
  ]),
));

const TYPE_PRIORITY = Object.freeze({
  [SETTLEMENT_TYPES.CITY]: 0,
  [SETTLEMENT_TYPES.TOWN]: 1,
  [SETTLEMENT_TYPES.RURAL]: 2,
});

export function resolveW8SettlementPresentationPolicy(
  quality = 'high',
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  return buildPresentationPolicy(quality, renderDistancePreset);
}

export function resolveW8RemoteSettlementOpacityAtDistance(
  boundaryDistanceMeters,
  policy,
) {
  const distance = Number.isFinite(boundaryDistanceMeters)
    ? Math.max(0, boundaryDistanceMeters)
    : Infinity;
  if (!policy?.enabled || distance >= policy.hiddenDistanceMeters) return 0;
  const fogRange = policy.atmosphere.fogIntegrationEndMeters - policy.fadeStartMeters;
  const horizonRange = policy.fadeEndMeters - policy.atmosphere.fogIntegrationEndMeters;
  const fogProgress = fogRange > 0
    ? smoothstep((distance - policy.fadeStartMeters) / fogRange)
    : 1;
  const horizonProgress = horizonRange > 0
    ? smoothstep((distance - policy.atmosphere.fogIntegrationEndMeters) / horizonRange)
    : 1;
  const opacity = distance > policy.atmosphere.fogIntegrationEndMeters
    ? policy.atmosphere.fogEdgeOpacity * (1 - horizonProgress)
    : 1 - (1 - policy.atmosphere.fogEdgeOpacity) * fogProgress;
  return q6(opacity);
}

export function resolveW8RemoteSettlementAtmosphere({
  boundaryDistanceMeters,
  quality = 'high',
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
} = {}) {
  const policy = resolveW8SettlementPresentationPolicy(
    quality,
    renderDistancePreset,
  ).remote;
  const distance = Number.isFinite(boundaryDistanceMeters)
    ? Math.max(0, boundaryDistanceMeters)
    : Infinity;
  const fogRange = policy.atmosphere.fogIntegrationEndMeters - policy.fadeStartMeters;
  const horizonRange = policy.fadeEndMeters - policy.atmosphere.fogIntegrationEndMeters;
  const fogProgress = fogRange > 0
    ? smoothstep((distance - policy.fadeStartMeters) / fogRange)
    : 1;
  const horizonProgress = horizonRange > 0
    ? smoothstep((distance - policy.atmosphere.fogIntegrationEndMeters) / horizonRange)
    : 1;
  let fogBlend = policy.enabled
    ? policy.atmosphere.fogEdgeBlend * fogProgress
    : 1;
  if (distance > policy.atmosphere.fogIntegrationEndMeters) {
    fogBlend = policy.atmosphere.fogEdgeBlend
      + (policy.atmosphere.maximumFogBlend - policy.atmosphere.fogEdgeBlend) * horizonProgress;
  }
  const opacity = resolveW8RemoteSettlementOpacityAtDistance(distance, policy);
  const colorHex = mixHexColor(
    policy.atmosphere.silhouetteColorHex,
    policy.atmosphere.fogColorHex,
    fogBlend,
  );
  return Object.freeze({
    visible: opacity > 0,
    opacity,
    fogBlend: q6(fogBlend),
    contrast: q6(1 - fogBlend),
    colorHex,
  });
}

export function resolveSettlementCandidateRadiusMeters(candidate) {
  const explicit = candidate?.radiusMeters ?? candidate?.radius;
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const profile = MIGRATED_SETTLEMENT_PROFILES[candidate?.townType];
  return profile ? profile.radius / FINITE_WORLD_UNITS_PER_METER : 0;
}

export function settlementCandidateDistance(candidate, playerX, playerZ) {
  const center = candidate?.center ?? candidate?.worldPosition;
  const centerDistanceMeters = Math.hypot(
    (center?.x ?? Infinity) - playerX,
    (center?.z ?? Infinity) - playerZ,
  );
  const radiusMeters = resolveSettlementCandidateRadiusMeters(candidate);
  return Object.freeze({
    centerDistanceMeters,
    radiusMeters,
    boundaryDistanceMeters: Math.max(0, centerDistanceMeters - radiusMeters),
  });
}

export function selectW8SettlementPresentationCandidates({
  candidates,
  playerX,
  playerZ,
  quality = 'high',
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
} = {}) {
  const policy = resolveW8SettlementPresentationPolicy(quality, renderDistancePreset);
  const ranked = [...(candidates ?? [])].map(candidate => Object.freeze({
    candidate,
    ...settlementCandidateDistance(candidate, playerX, playerZ),
  })).sort((left, right) => (
    left.boundaryDistanceMeters - right.boundaryDistanceMeters
      || left.centerDistanceMeters - right.centerDistanceMeters
      || (TYPE_PRIORITY[left.candidate.settlementType] ?? 3)
        - (TYPE_PRIORITY[right.candidate.settlementType] ?? 3)
      || Number(!W8_SETTLEMENT_ROLE_LANDMARKS[left.candidate.townType])
        - Number(!W8_SETTLEMENT_ROLE_LANDMARKS[right.candidate.townType])
      || left.candidate.settlementId.localeCompare(right.candidate.settlementId)
  ));
  const localCandidates = ranked.filter(value => (
    value.boundaryDistanceMeters <= policy.local.hiddenDistanceMeters
  ));
  const selectedLocalCandidates = localCandidates.slice(0, policy.local.settlementLimit);
  const activeLocalCandidate = selectedLocalCandidates[0] ?? null;
  const localCandidateIds = new Set(localCandidates.map(value => value.candidate.settlementId));
  const selectedLocalIds = new Set(selectedLocalCandidates.map(value => (
    value.candidate.settlementId
  )));
  const remoteCandidates = ranked.filter(value => (
    policy.remote.enabled
      && !selectedLocalIds.has(value.candidate.settlementId)
      && value.boundaryDistanceMeters >= policy.remote.horizonStartMeters
      && value.boundaryDistanceMeters <= policy.remote.hiddenDistanceMeters
  ));
  const selectedRemoteCandidates = remoteCandidates.slice(0, policy.remote.settlementLimit);
  const remoteCandidateIds = new Set(remoteCandidates.map(value => value.candidate.settlementId));
  const selectedRemoteIds = new Set(selectedRemoteCandidates.map(value => (
    value.candidate.settlementId
  )));
  const classified = ranked.map(value => {
    const settlementId = value.candidate.settlementId;
    let tier = 'excluded';
    let selectedReason = 'outside-presentation-range';
    if (settlementId === activeLocalCandidate?.candidate.settlementId) {
      tier = 'active-local';
      selectedReason = 'nearest-local';
    } else if (selectedLocalIds.has(settlementId)) {
      tier = 'additional-local';
      selectedReason = 'within-local-band';
    } else if (selectedRemoteIds.has(settlementId)) {
      tier = 'remote';
      selectedReason = 'within-remote-band';
    } else if (localCandidateIds.has(settlementId)) {
      selectedReason = 'local-limit';
    } else if (!policy.remote.enabled
      && value.boundaryDistanceMeters >= policy.remote.horizonStartMeters
      && value.boundaryDistanceMeters <= policy.metadata.queryDistanceMeters) {
      selectedReason = 'remote-disabled';
    } else if (remoteCandidateIds.has(settlementId)) {
      selectedReason = 'remote-limit';
    }
    return Object.freeze({
      ...value,
      tier,
      selected: tier !== 'excluded',
      selectedReason,
    });
  });
  const classifiedById = new Map(classified.map(value => [
    value.candidate.settlementId,
    value,
  ]));
  const local = Object.freeze(selectedLocalCandidates.map(value => (
    classifiedById.get(value.candidate.settlementId)
  )));
  const activeLocal = local[0] ?? null;
  const additionalLocal = Object.freeze(local.slice(1));
  const remote = Object.freeze(selectedRemoteCandidates.map(value => (
    classifiedById.get(value.candidate.settlementId)
  )));
  const excluded = Object.freeze(classified.filter(value => !value.selected));
  return Object.freeze({
    policy,
    activeLocal,
    additionalLocal,
    local,
    remote,
    excluded,
    ranked: Object.freeze(classified),
  });
}

export function resolveRemoteHorizonBuildingLimit({
  buildingCount,
  quality = 'high',
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
} = {}) {
  const policy = resolveW8SettlementPresentationPolicy(quality, renderDistancePreset);
  if (!policy.remote.settlementLimit) return 0;
  return Math.max(0, Math.floor(buildingCount ?? 0));
}

export function selectRemoteHorizonBuildings({
  template,
  quality = 'high',
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
} = {}) {
  const buildings = [...(template?.buildings ?? [])];
  const limit = resolveRemoteHorizonBuildingLimit({
    buildingCount: buildings.length,
    quality,
    renderDistancePreset,
  });
  if (!limit || !buildings.length) return Object.freeze([]);
  const stableKey = (building, index = 0) => building.stableId
    ?? `${building.buildingType ?? building.type ?? 'building'}:${building.x}:${building.z}:${index}`;
  const byStableId = new Map();
  buildings.forEach((building, index) => byStableId.set(stableKey(building, index), building));
  return Object.freeze([...byStableId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, limit)
    .map(([, building]) => building));
}
