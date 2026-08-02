import { LOGICAL_CHUNK_SIZE_METERS } from './chunk-coordinates.js';
import {
  W8_RENDER_DISTANCE_PRESETS,
  resolveW8RenderDistancePolicy,
} from './render-distance-policy.js';
import { resolveW8SettlementPresentationPolicy } from './settlement-presentation-policy.js';
import {
  WORLD_STREAMING_POLICY_SCHEMA,
  WORLD_STREAMING_POLICY_STREAM,
} from './world-streaming-policy-registry.js';

export const W8_BUILDING_STREAM_POLICY_KIND = 'building-presentation';
export const W8_SETTLEMENT_STREAM_POLICY_KIND = 'settlement-presentation';
export const W8_SETTLEMENT_STREAM_PUBLICATION_GROUP = 'settlement-static';

const DISABLED_VELOCITY_PREFETCH = Object.freeze({
  enabled: false,
  leadSeconds: 0,
  maximumDistanceMeters: 0,
  sampleIntervalSeconds: 1,
});

const sortedKeys = values => Object.freeze([...new Set(values ?? [])].sort());

function maximumRadiusChunks(distanceResolver) {
  return Math.ceil(Math.max(...Object.keys(W8_RENDER_DISTANCE_PRESETS).map(
    preset => distanceResolver(preset),
  )) / LOGICAL_CHUNK_SIZE_METERS);
}

function createShadowPolicy({ kind, generatorKind, observedKey, distanceResolver, readObservation }) {
  const maximumRadius = maximumRadiusChunks(distanceResolver);
  return Object.freeze({
    schemaVersion: WORLD_STREAMING_POLICY_SCHEMA,
    kind,
    stream: WORLD_STREAMING_POLICY_STREAM.STATIC,
    distanceBands: Object.freeze({
      required: Object.freeze({ radiusChunks: maximumRadius, deadlineSeconds: 0 }),
      prefetched: Object.freeze({ radiusChunks: maximumRadius, deadlineSeconds: null }),
      retained: Object.freeze({ radiusChunks: maximumRadius, deadlineSeconds: null }),
    }),
    velocityPrefetch: DISABLED_VELOCITY_PREFETCH,
    ownerResolver({ renderDistancePreset }) {
      const observation = readObservation?.(renderDistancePreset) ?? null;
      const ownerKeys = observation?.renderDistancePreset === renderDistancePreset
        ? sortedKeys(observation[observedKey]) : Object.freeze([]);
      return { required: ownerKeys, prefetched: [], retained: ownerKeys };
    },
    generatorKind,
    cachePolicy: Object.freeze({ kind: 'canonical-owner-ready-lru', maximumEntries: 2048 }),
    publicationGroup: W8_SETTLEMENT_STREAM_PUBLICATION_GROUP,
    publicationDependencies: Object.freeze([]),
    visibilityPolicy: Object.freeze({
      kind: 'settlement-preset-distance',
      maximumDistanceMeters: Math.max(...Object.keys(W8_RENDER_DISTANCE_PRESETS).map(
        preset => distanceResolver(preset),
      )),
    }),
    persistencePolicy: Object.freeze({ kind: 'canonical-gameplay-only' }),
    criticality: 'presentation-required',
  });
}

export function createW8BuildingSettlementShadowPolicies({ readObservation } = {}) {
  if (typeof readObservation !== 'function') {
    throw new TypeError('Building/Settlement shadow policies require readObservation');
  }
  return Object.freeze([
    createShadowPolicy({
      kind: W8_BUILDING_STREAM_POLICY_KIND,
      generatorKind: 'canonical-chunk',
      observedKey: 'buildingOwnerKeys',
      distanceResolver: preset => resolveW8RenderDistancePolicy(
        preset,
      ).generalObjectVisibilityMeters,
      readObservation,
    }),
    createShadowPolicy({
      kind: W8_SETTLEMENT_STREAM_POLICY_KIND,
      generatorKind: 'settlement-template',
      observedKey: 'settlementOwnerKeys',
      distanceResolver: preset => resolveW8SettlementPresentationPolicy(
        'high',
        preset,
      ).metadata.queryDistanceMeters,
      readObservation,
    }),
  ]);
}

function compareKeys(planned = [], observed = []) {
  const plannedSet = new Set(planned);
  const observedSet = new Set(observed);
  const missing = observed.filter(key => !plannedSet.has(key));
  const extra = planned.filter(key => !observedSet.has(key));
  return Object.freeze({
    matches: missing.length === 0 && extra.length === 0,
    plannedCount: planned.length,
    observedCount: observed.length,
    missing: Object.freeze(missing),
    extra: Object.freeze(extra),
  });
}

export function compareW8BuildingSettlementShadow({ plan, observation } = {}) {
  const buildingPlan = plan?.policyPlans?.find(
    policy => policy.kind === W8_BUILDING_STREAM_POLICY_KIND,
  );
  const settlementPlan = plan?.policyPlans?.find(
    policy => policy.kind === W8_SETTLEMENT_STREAM_POLICY_KIND,
  );
  if (!buildingPlan || !settlementPlan || !observation) {
    return Object.freeze({
      schemaVersion: 'building-settlement-shadow-comparison-1',
      matches: false,
      reason: 'unavailable',
    });
  }
  const distance = resolveW8RenderDistancePolicy(plan.renderDistancePreset);
  const settlement = resolveW8SettlementPresentationPolicy(
    observation.quality ?? 'high',
    plan.renderDistancePreset,
  );
  const buildingOwners = compareKeys(
    buildingPlan.requiredOwnerKeys,
    observation.buildingOwnerKeys,
  );
  const settlementOwners = compareKeys(
    settlementPlan.requiredOwnerKeys,
    observation.settlementOwnerKeys,
  );
  const presetBoundaryMatches = observation.generalVisibilityMeters
      === distance.generalObjectVisibilityMeters
    && observation.metadataQueryDistanceMeters === settlement.metadata.queryDistanceMeters;
  const identityMatches = observation.duplicateStableIdCount === 0
    && observation.duplicateSettlementIdCount === 0
    && observation.invalidRoadLinkageCount === 0;
  return Object.freeze({
    schemaVersion: 'building-settlement-shadow-comparison-1',
    matches: buildingOwners.matches && settlementOwners.matches
      && presetBoundaryMatches && identityMatches,
    reason: null,
    renderDistancePreset: plan.renderDistancePreset,
    buildingOwners,
    settlementOwners,
    presetBoundaryMatches,
    identityMatches,
    stableIdCount: observation.stableIds.length,
    settlementIdCount: observation.settlementIds.length,
    roadLinkageCount: observation.roadLinkages.length,
    damageStateCount: observation.damageStates.length,
  });
}
