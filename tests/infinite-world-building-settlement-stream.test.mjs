import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILDING_SETTLEMENT_STREAM_MODE,
  createBuildingSettlementStream,
} from '../src/infinite-world/building-settlement-stream.js';
import { createW8BuildingSettlementShadowPolicies } from '../src/infinite-world/settlement-stream-policy.js';
import { createWorldStreamingPlan } from '../src/infinite-world/world-streaming-plan.js';
import { validateWorldStreamingPolicy } from '../src/infinite-world/world-streaming-policy-registry.js';

const observation = Object.freeze({
  renderDistancePreset: 'current',
  quality: 'high',
  generalVisibilityMeters: 187.5,
  metadataQueryDistanceMeters: 875,
  buildingOwnerKeys: Object.freeze(['0,0']),
  settlementOwnerKeys: Object.freeze(['0,0', '1,0']),
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

function plan(sequence = 1) {
  return createWorldStreamingPlan({
    sequence,
    generatedAtMs: sequence,
    player: { x: 0, z: 0 },
    velocity: { x: 0, z: 0 },
    renderDistancePreset: 'current',
    stateRevision: sequence,
    originGeneration: 1,
    policies: createW8BuildingSettlementShadowPolicies({
      readObservation: () => observation,
    }).map(validateWorldStreamingPolicy),
  });
}

const validPayload = (source = observation) => ({
  capacity: 2,
  ownerKeys: [...source.settlementOwnerKeys],
  stableIds: [...source.stableIds],
  invalidRoadLinkageCount: 0,
  roadLinkages: [...source.roadLinkages],
  damageStates: [...source.damageStates],
  disposed: false,
  dispose() { this.disposed = true; },
});

test('transactional staging remains detached and legacy is the only publisher', async () => {
  let publishCount = 0;
  const stream = createBuildingSettlementStream({
    buildStage: async () => validPayload(),
    publishStage: () => { publishCount += 1; return true; },
  });
  const staged = await stream.applyShadowPlan({
    plan: plan(), observation, renderDistanceRevision: 3,
  });
  assert.equal(staged.ownerKeys.length, 2);
  assert.equal(stream.snapshot().mode, BUILDING_SETTLEMENT_STREAM_MODE.SHADOW);
  assert.equal(stream.commit({ planId: staged.planId, renderDistanceRevision: 3 }), false);
  assert.equal(publishCount, 0);
  assert.equal(stream.snapshot().counts.ready, 1);
  await stream.dispose();
});

test('capacity and mid-build failures roll back without replacing the ready stage', async () => {
  let failMode = null;
  const disposed = [];
  const stream = createBuildingSettlementStream({
    buildStage: async ({ observation: source }) => {
      if (failMode === 'throw') throw new Error('generated failure');
      const payload = validPayload(source);
      if (failMode === 'capacity') payload.capacity = 1;
      return payload;
    },
    disposeStage: stage => { stage.dispose(); disposed.push(stage); },
  });
  const first = await stream.applyShadowPlan({
    plan: plan(1), observation, renderDistanceRevision: 1,
  });
  failMode = 'capacity';
  const changed = Object.freeze({
    ...observation,
    damageStates: Object.freeze([Object.freeze({
      stableId: 'building:a', destroyed: true,
    })]),
  });
  await assert.rejects(stream.applyShadowPlan({
    plan: plan(2), observation: changed, renderDistanceRevision: 2,
  }), /capacity exceeded/);
  assert.equal(stream.snapshot().readyStage.planId, first.planId);
  assert.equal(stream.snapshot().counts.rolledBack, 1);
  assert.equal(disposed.length, 1);
  failMode = 'throw';
  await assert.rejects(stream.applyShadowPlan({
    plan: plan(3), observation: changed, renderDistanceRevision: 3,
  }), /generated failure/);
  assert.equal(stream.snapshot().readyStage.planId, first.planId);
  await stream.dispose();
});

test('superseded async staging is discarded and shared publication is exclusive', async () => {
  const resolvers = [];
  let published = null;
  const stream = createBuildingSettlementStream({
    initialMode: BUILDING_SETTLEMENT_STREAM_MODE.SHARED,
    buildStage: context => new Promise(resolve => resolvers.push(
      () => resolve(validPayload(context.observation)),
    )),
    publishStage: stage => { published = stage; return true; },
  });
  const firstPromise = stream.applyShadowPlan({
    plan: plan(1), observation, renderDistanceRevision: 1,
  });
  const secondPromise = stream.applyShadowPlan({
    plan: plan(2), observation: Object.freeze({
      ...observation,
      damageStates: Object.freeze([Object.freeze({
        stableId: 'building:a', destroyed: true,
      })]),
    }), renderDistanceRevision: 2,
  });
  resolvers[0]();
  assert.equal(await firstPromise, null);
  resolvers[1]();
  const second = await secondPromise;
  assert.equal(stream.commit({ planId: second.planId, renderDistanceRevision: 1 }), false);
  assert.equal(stream.commit({ planId: second.planId, renderDistanceRevision: 2 }), true);
  assert.equal(published.planId, second.planId);
  assert.equal(stream.snapshot().counts.cancelled, 1);
  assert.equal(stream.snapshot().counts.stale, 2);
  await stream.dispose();
});
