import test from 'node:test';
import assert from 'node:assert/strict';

import {
  W8_BUILDING_STREAM_POLICY_KIND,
  W8_SETTLEMENT_STREAM_POLICY_KIND,
  compareW8BuildingSettlementShadow,
  createW8BuildingSettlementShadowPolicies,
} from '../src/infinite-world/settlement-stream-policy.js';
import { createWorldStreamingPlan } from '../src/infinite-world/world-streaming-plan.js';
import { validateWorldStreamingPolicy } from '../src/infinite-world/world-streaming-policy-registry.js';

const observation = Object.freeze({
  contentHash: 'settlement-stream:1:0:4',
  frameSequence: 1,
  presentationRevision: 1,
  renderDistanceRevision: 0,
  stateRevision: 4,
  renderDistancePreset: 'current',
  quality: 'high',
  generalVisibilityMeters: 187.5,
  metadataQueryDistanceMeters: 875,
  buildingOwnerKeys: Object.freeze(['0,0', '1,0']),
  settlementOwnerKeys: Object.freeze(['0,0', '1,0', '2,0']),
  stableIds: Object.freeze(['building:a', 'road:a']),
  settlementIds: Object.freeze(['settlement:a']),
  roadLinkages: Object.freeze([Object.freeze({
    stableId: 'road:a', settlementId: 'settlement:a', ownerKey: '1,0',
  })]),
  damageStates: Object.freeze([Object.freeze({ stableId: 'building:a', destroyed: false })]),
  duplicateStableIdCount: 0,
  duplicateSettlementIdCount: 0,
  invalidRoadLinkageCount: 0,
});

function planFor(source = observation) {
  const policies = createW8BuildingSettlementShadowPolicies({
    readObservation: () => source,
  }).map(validateWorldStreamingPolicy);
  return createWorldStreamingPlan({
    sequence: 1,
    generatedAtMs: 10,
    player: { x: 0, z: 0 },
    velocity: { x: 500, z: 0 },
    renderDistancePreset: source.renderDistancePreset,
    stateRevision: 4,
    originGeneration: 2,
    policies,
  });
}

test('Building and Settlement enter WorldStreamingPlan as read-only shadow policies', () => {
  const plan = planFor();
  const building = plan.policyPlans.find(policy => (
    policy.kind === W8_BUILDING_STREAM_POLICY_KIND
  ));
  const settlement = plan.policyPlans.find(policy => (
    policy.kind === W8_SETTLEMENT_STREAM_POLICY_KIND
  ));
  assert.deepEqual(building.requiredOwnerKeys, observation.buildingOwnerKeys);
  assert.deepEqual(building.prefetchedOwnerKeys, []);
  assert.deepEqual(settlement.requiredOwnerKeys, observation.settlementOwnerKeys);
  assert.equal(building.velocityCorridor.distanceMeters, 0);
  assert.equal(settlement.velocityCorridor.distanceMeters, 0);
  assert.equal(building.publicationGroup, 'settlement-static');
  assert.equal(settlement.publicationGroup, 'settlement-static');
  assert.equal(building.sourceSnapshot, observation);
  assert.equal(settlement.sourceSnapshot, observation);
});

test('Settlement shadow parity covers owner, identity, Road, damage, and Current 875m metadata', () => {
  const comparison = compareW8BuildingSettlementShadow({
    plan: planFor(), observation,
  });
  assert.equal(comparison.matches, true);
  assert.equal(comparison.buildingOwners.matches, true);
  assert.equal(comparison.settlementOwners.matches, true);
  assert.equal(comparison.presetBoundaryMatches, true);
  assert.equal(comparison.identityMatches, true);
  assert.equal(comparison.roadLinkageCount, 1);
  assert.equal(comparison.damageStateCount, 1);
});

test('Settlement shadow refuses mismatched owners, IDs, Road linkage, and preset boundaries', () => {
  const mismatched = Object.freeze({
    ...observation,
    buildingOwnerKeys: Object.freeze(['9,9']),
    metadataQueryDistanceMeters: 874,
    duplicateStableIdCount: 1,
    invalidRoadLinkageCount: 1,
  });
  const comparison = compareW8BuildingSettlementShadow({
    plan: planFor(), observation: mismatched,
  });
  assert.equal(comparison.matches, false);
  assert.equal(comparison.buildingOwners.matches, false);
  assert.equal(comparison.presetBoundaryMatches, false);
  assert.equal(comparison.identityMatches, false);
});
