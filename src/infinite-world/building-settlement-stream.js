import {
  W8_BUILDING_STREAM_POLICY_KIND,
  W8_SETTLEMENT_STREAM_POLICY_KIND,
  compareW8BuildingSettlementShadow,
} from './settlement-stream-policy.js';

export const BUILDING_SETTLEMENT_STREAM_MODE = Object.freeze({
  LEGACY: 'legacy',
  SHADOW: 'shadow',
  SHARED: 'shared',
});

const MODES = new Set(Object.values(BUILDING_SETTLEMENT_STREAM_MODE));

function stableSignature(plan, observation) {
  return JSON.stringify({
    preset: plan.renderDistancePreset,
    buildingOwners: observation.buildingOwnerKeys,
    settlementOwners: observation.settlementOwnerKeys,
    stableIds: observation.stableIds,
    roadLinkages: observation.roadLinkages,
    damageStates: observation.damageStates,
  });
}

function validateStagingPayload(payload, observation) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('Building/Settlement staging payload is required');
  }
  const ownerKeys = new Set(payload.ownerKeys ?? []);
  const stableIds = payload.stableIds ?? [];
  const expectedOwners = new Set(observation.settlementOwnerKeys);
  if (ownerKeys.size > (payload.capacity ?? ownerKeys.size)) {
    throw new RangeError('Building/Settlement staging capacity exceeded');
  }
  if (stableIds.length !== new Set(stableIds).size) {
    throw new Error('duplicate Building/Settlement Stable ID in staging');
  }
  if (ownerKeys.size !== expectedOwners.size
    || [...ownerKeys].some(ownerKey => !expectedOwners.has(ownerKey))) {
    throw new Error('Building/Settlement staging owner coverage mismatch');
  }
  if (stableIds.length !== observation.stableIds.length
    || stableIds.some(stableId => !observation.stableIds.includes(stableId))) {
    throw new Error('Building/Settlement staging identity mismatch');
  }
  if (payload.invalidRoadLinkageCount !== 0
    || JSON.stringify(payload.roadLinkages ?? [])
      !== JSON.stringify(observation.roadLinkages)) {
    throw new Error('Building/Settlement staging Road linkage mismatch');
  }
  if (JSON.stringify(payload.damageStates ?? []) !== JSON.stringify(observation.damageStates)) {
    throw new Error('Building/Settlement staging damage state mismatch');
  }
  return true;
}

export function createBuildingSettlementStream({
  buildStage,
  disposeStage = stage => stage?.dispose?.(),
  publishStage = () => false,
  initialMode = BUILDING_SETTLEMENT_STREAM_MODE.SHADOW,
} = {}) {
  if (typeof buildStage !== 'function') throw new TypeError('buildStage is required');
  if (typeof disposeStage !== 'function' || typeof publishStage !== 'function') {
    throw new TypeError('disposeStage and publishStage must be functions');
  }
  if (!MODES.has(initialMode)) throw new RangeError(`invalid stream mode: ${initialMode}`);
  let mode = initialMode;
  let sequence = 0;
  let activeBuild = null;
  let readyStage = null;
  let latestSignature = null;
  let disposed = false;
  const counts = {
    requested: 0,
    reused: 0,
    ready: 0,
    cancelled: 0,
    failed: 0,
    rolledBack: 0,
    published: 0,
    stale: 0,
  };

  const applyPlan = async ({ plan, observation, renderDistanceRevision = 0 } = {}) => {
    if (disposed) throw new Error('Building/Settlement stream is disposed');
    const buildingPlan = plan?.policyPlans?.find(
      policy => policy.kind === W8_BUILDING_STREAM_POLICY_KIND,
    );
    const settlementPlan = plan?.policyPlans?.find(
      policy => policy.kind === W8_SETTLEMENT_STREAM_POLICY_KIND,
    );
    if (!buildingPlan || !settlementPlan || !observation) {
      throw new Error('Building/Settlement plan and observation are required');
    }
    const comparison = compareW8BuildingSettlementShadow({ plan, observation });
    if (!comparison.matches) throw new Error('Building/Settlement shadow parity failed');
    const signature = stableSignature(plan, observation);
    if (signature === latestSignature && readyStage) {
      counts.reused += 1;
      return readyStage;
    }
    const requestSequence = ++sequence;
    counts.requested += 1;
    if (activeBuild) {
      activeBuild.cancelled = true;
      counts.cancelled += 1;
    }
    const token = { sequence: requestSequence, cancelled: false };
    activeBuild = token;
    let staged = null;
    try {
      staged = await buildStage(Object.freeze({
        plan,
        buildingPlan,
        settlementPlan,
        observation,
        renderDistanceRevision,
        isCurrent: () => !disposed && !token.cancelled && activeBuild === token,
      }));
      if (disposed || token.cancelled || activeBuild !== token) {
        counts.stale += 1;
        disposeStage(staged);
        return null;
      }
      validateStagingPayload(staged, observation);
      const next = Object.freeze({
        schemaVersion: 'building-settlement-stage-1',
        sequence: requestSequence,
        planId: plan.planId,
        renderDistancePreset: plan.renderDistancePreset,
        renderDistanceRevision,
        publicationGroup: buildingPlan.publicationGroup,
        ownerKeys: Object.freeze([...staged.ownerKeys]),
        stableIds: Object.freeze([...staged.stableIds]),
        settlementIds: Object.freeze([...observation.settlementIds]),
        roadLinkages: Object.freeze([...observation.roadLinkages]),
        damageStates: Object.freeze([...observation.damageStates]),
        payload: staged,
      });
      if (readyStage) disposeStage(readyStage.payload);
      readyStage = next;
      latestSignature = signature;
      counts.ready += 1;
      return readyStage;
    } catch (error) {
      if (staged) disposeStage(staged);
      counts.failed += 1;
      counts.rolledBack += 1;
      throw error;
    } finally {
      if (activeBuild === token) activeBuild = null;
    }
  };

  return Object.freeze({
    applyShadowPlan: applyPlan,
    setMode(nextMode) {
      if (!MODES.has(nextMode)) throw new RangeError(`invalid stream mode: ${nextMode}`);
      mode = nextMode;
      return mode;
    },
    commit({ planId, renderDistanceRevision } = {}) {
      if (mode !== BUILDING_SETTLEMENT_STREAM_MODE.SHARED || !readyStage) return false;
      if (readyStage.planId !== planId
        || readyStage.renderDistanceRevision !== renderDistanceRevision) {
        counts.stale += 1;
        return false;
      }
      const published = publishStage(readyStage) === true;
      if (published) counts.published += 1;
      return published;
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: 'building-settlement-stream-snapshot-1',
        mode,
        activeBuild: activeBuild !== null,
        readyStage: readyStage ? Object.freeze({
          sequence: readyStage.sequence,
          planId: readyStage.planId,
          renderDistancePreset: readyStage.renderDistancePreset,
          renderDistanceRevision: readyStage.renderDistanceRevision,
          publicationGroup: readyStage.publicationGroup,
          ownerCount: readyStage.ownerKeys.length,
          stableIdCount: readyStage.stableIds.length,
          settlementIdCount: readyStage.settlementIds.length,
          roadLinkageCount: readyStage.roadLinkages.length,
          damageStateCount: readyStage.damageStates.length,
        }) : null,
        counts: Object.freeze({ ...counts }),
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (activeBuild) activeBuild.cancelled = true;
      if (readyStage) disposeStage(readyStage.payload);
      activeBuild = null;
      readyStage = null;
    },
  });
}
