import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILDING_SETTLEMENT_STREAM_MODE,
  createBuildingSettlementStream,
} from '../src/infinite-world/building-settlement-stream.js';
import { createW8BuildingSettlementShadowPolicies } from '../src/infinite-world/settlement-stream-policy.js';
import {
  createSettlementStreamingSnapshotCache,
  isSettlementStreamingSnapshotCurrent,
} from '../src/infinite-world/settlement-streaming-snapshot-cache.js';
import { createWorldStreamingPlan } from '../src/infinite-world/world-streaming-plan.js';
import { validateWorldStreamingPolicy } from '../src/infinite-world/world-streaming-policy-registry.js';

const observation = Object.freeze({
  contentHash: 'settlement-stream:1:0:1',
  frameSequence: 1,
  presentationRevision: 1,
  renderDistanceRevision: 0,
  stateRevision: 1,
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

function plan(sequence = 1, source = observation, originGeneration = 1) {
  return createWorldStreamingPlan({
    sequence,
    generatedAtMs: sequence,
    player: { x: 0, z: 0 },
    velocity: { x: 0, z: 0 },
    renderDistancePreset: 'current',
    stateRevision: sequence,
    originGeneration,
    policies: createW8BuildingSettlementShadowPolicies({
      readObservation: () => source,
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
  assert.equal(stream.commit({
    planId: staged.planId, originGeneration: 1, renderDistanceRevision: 3,
  }), false);
  assert.equal(publishCount, 0);
  assert.equal(stream.snapshot().counts.ready, 1);
  await stream.dispose();
});

test('frame/revision/state cache materializes once and never reuses a stale snapshot', () => {
  const cache = createSettlementStreamingSnapshotCache();
  let materializeCount = 0;
  const read = overrides => cache.read({
    frameSequence: 10,
    presentationRevision: 3,
    renderDistanceRevision: 4,
    stateRevision: 5,
    ...overrides,
    materialize: () => Object.freeze({ sequence: ++materializeCount }),
  });
  const first = read();
  const sameFrame = read();
  assert.equal(sameFrame, first);
  assert.equal(materializeCount, 1);
  assert.notEqual(read({ frameSequence: 11 }), first);
  assert.equal(materializeCount, 2);
  assert.equal(read({ frameSequence: 11, stateRevision: 6 }).sequence, 3);
  assert.equal(read({ frameSequence: 11, stateRevision: 6, renderDistanceRevision: 5 }).sequence, 4);
  assert.equal(read({
    frameSequence: 11,
    stateRevision: 6,
    renderDistanceRevision: 5,
    presentationRevision: 4,
  }).sequence, 5);
  assert.deepEqual(cache.snapshot().counts, { requests: 6, materialized: 5, reused: 1 });
  assert.equal(isSettlementStreamingSnapshotCurrent(observation, {
    presentationRevision: 1,
    renderDistanceRevision: 0,
    stateRevision: 1,
  }), true);
  assert.equal(isSettlementStreamingSnapshotCurrent(observation, {
    presentationRevision: 1,
    renderDistanceRevision: 1,
    stateRevision: 1,
  }), false, 'next revision cannot publish the prior snapshot');
});

test('Building and Settlement policy plans retain one shared immutable snapshot identity', () => {
  const streamingPlan = plan();
  const settlementPolicies = streamingPlan.policyPlans.filter(policy => (
    policy.publicationGroup === 'settlement-static'
  ));
  assert.equal(settlementPolicies.length, 2);
  assert.equal(settlementPolicies.every(policy => policy.sourceSnapshot === observation), true);
  assert.equal(settlementPolicies.every(policy => policy.sourceHash.includes(
    observation.contentHash,
  )), true);
});

test('legacy and shared modes preserve identical owner, Stable ID, Road, and damage staging', async () => {
  const stageForMode = async mode => {
    let published = 0;
    const stream = createBuildingSettlementStream({
      initialMode: mode,
      buildStage: async () => validPayload(),
      publishStage: () => { published += 1; return true; },
    });
    const streamingPlan = plan();
    const stage = await stream.applyShadowPlan({
      plan: streamingPlan,
      observation,
      renderDistanceRevision: 0,
    });
    stream.commit({
      planId: stage.planId, originGeneration: 1, renderDistanceRevision: 0,
    });
    const result = {
      ownerKeys: stage.ownerKeys,
      stableIds: stage.stableIds,
      settlementIds: stage.settlementIds,
      roadLinkages: stage.roadLinkages,
      damageStates: stage.damageStates,
      duplicateStableIds: stage.stableIds.length - new Set(stage.stableIds).size,
      published,
      counts: stream.snapshot().counts,
    };
    await stream.dispose();
    return result;
  };
  const legacy = await stageForMode(BUILDING_SETTLEMENT_STREAM_MODE.LEGACY);
  const shared = await stageForMode(BUILDING_SETTLEMENT_STREAM_MODE.SHARED);
  for (const field of [
    'ownerKeys', 'stableIds', 'settlementIds', 'roadLinkages', 'damageStates',
  ]) assert.deepEqual(legacy[field], shared[field]);
  assert.equal(legacy.published, 0);
  assert.equal(shared.published, 1);
  assert.equal(shared.duplicateStableIds, 0);
  assert.equal(shared.counts.stale, 0);
  assert.equal(shared.counts.failed, 0);
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
    contentHash: 'settlement-stream:1:0:2',
    stateRevision: 2,
    damageStates: Object.freeze([Object.freeze({
      stableId: 'building:a', destroyed: true,
    })]),
  });
  await assert.rejects(stream.applyShadowPlan({
    plan: plan(2, changed), observation: changed, renderDistanceRevision: 2,
  }), /capacity exceeded/);
  assert.equal(stream.snapshot().readyStage.planId, first.planId);
  assert.equal(stream.snapshot().counts.rolledBack, 1);
  assert.equal(disposed.length, 1);
  failMode = 'throw';
  await assert.rejects(stream.applyShadowPlan({
    plan: plan(3, changed), observation: changed, renderDistanceRevision: 3,
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
  const secondObservation = Object.freeze({
    ...observation,
    contentHash: 'settlement-stream:1:0:2',
    stateRevision: 2,
    damageStates: Object.freeze([Object.freeze({
      stableId: 'building:a', destroyed: true,
    })]),
  });
  const secondPromise = stream.applyShadowPlan({
    plan: plan(2, secondObservation),
    observation: secondObservation,
    renderDistanceRevision: 2,
  });
  resolvers[0]();
  assert.equal(await firstPromise, null);
  resolvers[1]();
  const second = await secondPromise;
  assert.equal(stream.commit({
    planId: second.planId, originGeneration: 1, renderDistanceRevision: 1,
  }), false);
  assert.equal(stream.commit({
    planId: second.planId, originGeneration: 1, renderDistanceRevision: 2,
  }), true);
  assert.equal(published.planId, second.planId);
  assert.equal(stream.snapshot().counts.cancelled, 1);
  assert.equal(stream.snapshot().counts.stale, 2);
  await stream.dispose();
});

test('Terrain transition generation supersedes same-content Building staging', async () => {
  const resolvers = [];
  let published = null;
  const stream = createBuildingSettlementStream({
    initialMode: BUILDING_SETTLEMENT_STREAM_MODE.SHARED,
    buildStage: context => new Promise(resolve => resolvers.push(
      () => resolve(validPayload(context.observation)),
    )),
    publishStage: stage => { published = stage; return true; },
  });
  const oldPromise = stream.applyShadowPlan({
    plan: plan(1, observation, 7), observation, renderDistanceRevision: 0,
  });
  const currentPromise = stream.applyShadowPlan({
    plan: plan(2, observation, 8), observation, renderDistanceRevision: 0,
  });
  resolvers[0]();
  assert.equal(await oldPromise, null, 'old Terrain generation must stay detached');
  resolvers[1]();
  const current = await currentPromise;
  assert.equal(stream.commit({
    planId: current.planId, originGeneration: 7, renderDistanceRevision: 0,
  }), false, 'old Terrain generation cannot publish the current Building stage');
  assert.equal(published, null);
  assert.equal(stream.commit({
    planId: current.planId, originGeneration: 8, renderDistanceRevision: 0,
  }), true);
  assert.equal(published.originGeneration, 8);
  assert.equal(stream.snapshot().counts.cancelled, 1);
  assert.equal(stream.snapshot().counts.stale, 2);
  await stream.dispose();
});
