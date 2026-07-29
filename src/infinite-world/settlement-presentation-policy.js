import { SETTLEMENT_TYPES } from '../settlement-type.js';
import { FINITE_WORLD_UNITS_PER_METER, MIGRATED_SETTLEMENT_PROFILES } from './single-rural-settlement.js';
import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
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
const maximumSettlementRadiusMeters = Math.max(...Object.values(MIGRATED_SETTLEMENT_PROFILES)
  .map(profile => profile.radius / FINITE_WORLD_UNITS_PER_METER));
const qualityPartCount = quality => quality === 'high' ? 2 : 1;

const buildPresentationPolicy = (quality, renderDistancePreset) => {
  const distance = resolveW8RenderDistancePolicy(renderDistancePreset);
  const partsPerBuilding = qualityPartCount(quality);
  return Object.freeze({
    quality: ['high', 'medium', 'low'].includes(quality) ? quality : 'high',
    renderDistancePreset: distance.id,
    local: Object.freeze({
      fullDistanceMeters: distance.settlementLod.fullDistanceMeters,
      horizonStartMeters: distance.settlementLod.fullDistanceMeters,
      fadeStartMeters: distance.settlementLod.fadeStartMeters,
      hiddenDistanceMeters: distance.generalObjectVisibilityMeters,
    }),
    remote: Object.freeze({
      horizonStartMeters: distance.generalObjectVisibilityMeters,
      fadeStartMeters: Math.max(
        distance.generalObjectVisibilityMeters,
        distance.settlementHorizonMeters - maximumSettlementRadiusMeters,
      ),
      hiddenDistanceMeters: distance.settlementHorizonMeters,
      fog: false,
      settlementLimit: 4,
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
  const current = ranked.find(value => (
    value.boundaryDistanceMeters <= policy.local.hiddenDistanceMeters
  )) ?? null;
  const remote = ranked.filter(value => (
    value.candidate.settlementId !== current?.candidate.settlementId
      && value.boundaryDistanceMeters >= policy.remote.horizonStartMeters
      && value.boundaryDistanceMeters <= policy.remote.hiddenDistanceMeters
  )).slice(0, policy.remote.settlementLimit);
  return Object.freeze({
    policy,
    current,
    remote: Object.freeze(remote),
    ranked: Object.freeze(ranked),
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
