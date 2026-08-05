import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NATURAL_RESOURCE_BAND_REVISION,
  createNaturalCoverageKey,
} from '../src/infinite-world/natural-streaming-coverage.js';
import { createWorldStreamingCoordinator } from '../src/infinite-world/world-streaming-coordinator.js';
import { createWorldStreamingPolicyRegistry } from '../src/infinite-world/world-streaming-policy-registry.js';
import { createLegacyRuntimeChunkStreamingPolicy } from '../src/infinite-world/world-streaming-plan.js';
import {
  STATIC_OBJECT_STREAM_VELOCITY_PREFETCH,
  createCircularStaticStreamingPolicy,
  createStaticObjectStream,
} from '../src/infinite-world/static-object-stream.js';

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
};

function createRegistry(...policies) {
  const registry = createWorldStreamingPolicyRegistry();
  for (const policy of policies) registry.register(policy);
  registry.freeze();
  return registry;
}

function key(registry, overrides = {}) {
  return createNaturalCoverageKey({
    policyRegistryVersion: registry.version,
    renderDistancePreset: 'current',
    player: { x: 1, z: 1 },
    velocity: { x: 0, z: 0 },
    velocityPrefetch: STATIC_OBJECT_STREAM_VELOCITY_PREFETCH,
    naturalResourceBandRevision: NATURAL_RESOURCE_BAND_REVISION,
    settlementContentHash: 'settlement-coverage:stable',
    runtimeCoverageSignature: 'runtime-coverage:0,0',
    ...overrides,
  });
}

function planInput(overrides = {}) {
  return {
    player: { x: 1, z: 1 },
    velocity: { x: 0, z: 0 },
    renderDistancePreset: 'current',
    currentRequests: {},
    ...overrides,
  };
}

test('NaturalCoverageKey invalidates only on formal coverage inputs', () => {
  const registry = createRegistry(createLegacyRuntimeChunkStreamingPolicy());
  const initial = key(registry);
  assert.equal(key(registry, { player: { x: 15.9, z: 1 } }).signature, initial.signature,
    'movement inside one owner must retain immutable coverage');
  assert.notEqual(key(registry, { player: { x: 16.1, z: 1 } }).signature, initial.signature);
  assert.notEqual(key(registry, { velocity: { x: 32, z: 0 } }).signature, initial.signature,
    'corridor endpoint owner changes must invalidate coverage');
  assert.notEqual(key(registry, { renderDistancePreset: 'short' }).signature, initial.signature);
  assert.notEqual(key(registry, {
    settlementContentHash: 'settlement-coverage:changed',
  }).signature, initial.signature);
  assert.notEqual(key(registry, {
    runtimeCoverageSignature: 'runtime-coverage:1,0',
  }).signature, initial.signature);
  assert.notEqual(key(registry, {
    naturalResourceBandRevision: NATURAL_RESOURCE_BAND_REVISION + 1,
  }).signature, initial.signature);
  const additionalPolicy = createCircularStaticStreamingPolicy({
    kind: 'natural-key-version',
    publicationGroup: 'natural-static',
    maximumRequiredDistanceMeters: 32,
    distanceProfileResolver: () => ({ exactDistanceMeters: 16, horizonDistanceMeters: null }),
  }).policy;
  const expandedRegistry = createRegistry(
    createLegacyRuntimeChunkStreamingPolicy(),
    additionalPolicy,
  );
  assert.notEqual(key(expandedRegistry).signature, initial.signature);
});

test('Coordinator reuses one immutable plan across stopped, camera-only, state, damage, and origin frames', () => {
  const registry = createRegistry(createLegacyRuntimeChunkStreamingPolicy());
  let now = 1_000;
  const coordinator = createWorldStreamingCoordinator({ registry, clock: () => now });
  let inputBuilds = 0;
  let firstPlan = null;
  for (let frame = 0; frame < 240; frame += 1) {
    now += 16;
    const publicationContext = coordinator.createPublicationContext({
      generatedAtMs: now,
      stateRevision: frame,
      destructionRevision: frame < 120 ? null : 'damage-only-change',
      originGeneration: frame < 180 ? 0 : 1,
    });
    const result = coordinator.resolveCoveragePlan({
      coverageKey: key(registry),
      publicationContext,
      createPlanInput() {
        inputBuilds += 1;
        return planInput();
      },
    });
    firstPlan ??= result.plan;
    assert.equal(result.plan, firstPlan);
    assert.equal(result.regenerated, frame === 0);
  }
  const snapshot = coordinator.snapshot();
  assert.equal(Object.isFrozen(firstPlan), true);
  assert.equal(Object.isFrozen(firstPlan.policyPlans[0].requiredOwnerKeys), true);
  assert.equal(Object.isFrozen(firstPlan.publicationGroups), true);
  assert.equal(inputBuilds, 1);
  assert.equal(snapshot.planCount, 1);
  assert.equal(snapshot.publicationSequence, 240);
  assert.equal(snapshot.counts.coveragePlanBuilds, 1);
  assert.equal(snapshot.counts.coveragePlanReuses, 239);
});

test('owner, corridor, Preset, and lifecycle invalidation rebuild while failed generation retains old plan', () => {
  const registry = createRegistry(createLegacyRuntimeChunkStreamingPolicy());
  let now = 0;
  const coordinator = createWorldStreamingCoordinator({ registry, clock: () => ++now });
  const resolve = (coverageKey, input = planInput()) => coordinator.resolveCoveragePlan({
    coverageKey,
    publicationContext: coordinator.createPublicationContext({
      generatedAtMs: ++now,
      stateRevision: 0,
      originGeneration: 0,
    }),
    createPlanInput: () => input,
  });
  const first = resolve(key(registry));
  assert.equal(resolve(key(registry, { player: { x: 16.1, z: 1 } }), planInput({
    player: { x: 16.1, z: 1 },
  })).regenerated, true);
  assert.equal(resolve(key(registry, { velocity: { x: 32, z: 0 } }), planInput({
    velocity: { x: 32, z: 0 },
  })).regenerated, true);
  assert.equal(resolve(key(registry, { renderDistancePreset: 'short' }), planInput({
    renderDistancePreset: 'short',
  })).regenerated, true);
  coordinator.invalidateCoverage('continue');
  assert.equal(resolve(key(registry)).regenerated, true);
  coordinator.invalidateCoverage('retry');
  assert.equal(resolve(key(registry)).regenerated, true);
  const beforeFailure = coordinator.snapshot().latestPlan;
  assert.throws(() => resolve(
    key(registry, { runtimeCoverageSignature: 'runtime-coverage:bad' }),
    planInput({ renderDistancePreset: '' }),
  ), /renderDistancePreset/);
  assert.equal(coordinator.snapshot().latestPlan, beforeFailure);
  assert.equal(coordinator.snapshot().counts.coverageBuildFailures, 1);
  assert.notEqual(first.plan.planId, beforeFailure.planId);
});

test('fast path advances ready admission and publication without reapplying Static coverage', async () => {
  const runtime = createCircularStaticStreamingPolicy({
    kind: 'natural-test',
    publicationGroup: 'natural-static',
    maximumRequiredDistanceMeters: 32,
    distanceProfileResolver: () => ({ exactDistanceMeters: 16, horizonDistanceMeters: null }),
  });
  const registry = createRegistry(runtime.policy);
  let now = 1_000;
  const coordinator = createWorldStreamingCoordinator({ registry, clock: () => now });
  const stream = createStaticObjectStream({
    policyKind: runtime.policy.kind,
    classifyOwner: runtime.classifyOwner,
    clock: () => now,
    requestOwner: request => Promise.resolve(Object.freeze({ ownerKey: request.ownerKey })),
  });
  let staticApplyCalls = 0;
  let admitted = 0;
  for (let frame = 0; frame < 120; frame += 1) {
    now += 16;
    const publicationContext = coordinator.createPublicationContext({
      generatedAtMs: now,
      stateRevision: frame,
      destructionRevision: frame === 60 ? 'destroyed-id' : null,
      originGeneration: frame > 90 ? 1 : 0,
    });
    const result = coordinator.resolveCoveragePlan({
      coverageKey: key(registry, { settlementContentHash: null }),
      publicationContext,
      createPlanInput: () => planInput(),
    });
    if (result.regenerated) {
      staticApplyCalls += 1;
      stream.applyPlan({
        plan: result.plan,
        policyPlan: result.plan.policyPlans[0],
        publicationContext,
      });
    } else stream.updatePublicationContext(publicationContext);
    await new Promise(resolve => setImmediate(resolve));
    const pages = stream.drainReadyOwnerPages({ limit: 1 });
    admitted += pages.length;
    if (pages.length) stream.publishOwners({ ownerKeys: pages.map(page => page.ownerKey) });
  }
  await waitFor(() => stream.snapshot().backlog === 0, 'owner requests did not settle');
  const coordinatorSnapshot = coordinator.snapshot();
  const streamSnapshot = stream.snapshot();
  assert.equal(coordinatorSnapshot.planCount, 1);
  assert.equal(coordinatorSnapshot.counts.coveragePlanReuses, 119);
  assert.equal(staticApplyCalls, 1);
  assert.equal(streamSnapshot.counts.plans, 1);
  assert.equal(streamSnapshot.counts.unchangedPlans, 0);
  assert.ok(admitted > 0);
  assert.ok(streamSnapshot.counts.ticketsPublished > 0);
  assert.equal(streamSnapshot.counts.failed, 0);
  assert.equal(streamSnapshot.counts.staleResultDiscards, 0);
  await stream.dispose();
});

test('480-frame deterministic workload keeps plan/application work below ten percent', async t => {
  const runtime = createCircularStaticStreamingPolicy({
    kind: 'natural-performance',
    publicationGroup: 'natural-static',
    maximumRequiredDistanceMeters: 32,
    distanceProfileResolver: () => ({ exactDistanceMeters: 16, horizonDistanceMeters: null }),
  });
  const registry = createRegistry(runtime.policy);
  const coordinator = createWorldStreamingCoordinator({ registry, clock: () => 1_000 });
  const stream = createStaticObjectStream({
    policyKind: runtime.policy.kind,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 1,
    requestOwner: () => ({ promise: new Promise(() => {}), cancel: () => true }),
  });
  let planInputBuilds = 0;
  let staticApplyCalls = 0;
  let previousPlan = null;
  const playerUpdateDurations = [];
  const planDurations = [];
  const staticApplyDurations = [];
  for (let frame = 0; frame < 480; frame += 1) {
    const playerUpdateStartedAt = performance.now();
    const movingFrame = Math.max(0, frame - 240);
    const playerX = frame < 240 ? 1 : 1 + movingFrame * (32 / 60);
    const velocity = frame < 240 ? { x: 0, z: 0 } : { x: 32, z: 0 };
    const publicationContext = coordinator.createPublicationContext({
      generatedAtMs: 1_000 + frame * 16,
      stateRevision: frame,
      originGeneration: Math.floor(playerX / 256),
    });
    const coverageKey = key(registry, { player: { x: playerX, z: 1 }, velocity });
    const planStartedAt = performance.now();
    const result = coordinator.resolveCoveragePlan({
      coverageKey,
      publicationContext,
      createPlanInput() {
        planInputBuilds += 1;
        return planInput({ player: { x: playerX, z: 1 }, velocity });
      },
    });
    planDurations.push(performance.now() - planStartedAt);
    if (result.regenerated) {
      staticApplyCalls += 1;
      const staticApplyStartedAt = performance.now();
      stream.applyPlan({
        plan: result.plan,
        policyPlan: result.plan.policyPlans[0],
        publicationContext,
      });
      staticApplyDurations.push(performance.now() - staticApplyStartedAt);
    } else {
      assert.equal(result.plan, previousPlan);
      stream.updatePublicationContext(publicationContext);
    }
    previousPlan = result.plan;
    playerUpdateDurations.push(performance.now() - playerUpdateStartedAt);
  }
  const snapshot = coordinator.snapshot();
  const streamSnapshot = stream.snapshot();
  const fastPathRate = snapshot.counts.coveragePlanReuses / 480;
  assert.equal(planInputBuilds, snapshot.planCount);
  assert.equal(staticApplyCalls, snapshot.planCount);
  assert.ok(snapshot.planCount > 0 && snapshot.planCount <= 30, String(snapshot.planCount));
  assert.ok(fastPathRate >= 0.9, fastPathRate);
  assert.ok((480 - snapshot.planCount) / 480 >= 0.85);
  assert.equal(streamSnapshot.counts.plans, staticApplyCalls);
  assert.equal(streamSnapshot.counts.coverageMerges, staticApplyCalls);
  assert.equal(streamSnapshot.counts.coverageSignatures, staticApplyCalls);
  assert.ok(streamSnapshot.counts.ownerSorts <= staticApplyCalls);
  assert.ok(streamSnapshot.counts.sortTargetOwners
    <= streamSnapshot.counts.resourceKindClassifications);
  const percentile = (values, ratio) => [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)
  ];
  t.diagnostic(JSON.stringify({
    frames: 480,
    planBuilds: snapshot.planCount,
    fastPathHits: snapshot.counts.coveragePlanReuses,
    fastPathRate,
    staticApplyCalls,
    ownerMergeCalls: streamSnapshot.counts.coverageMerges,
    ownerSortCalls: streamSnapshot.counts.ownerSorts,
    sortTargetOwners: streamSnapshot.counts.sortTargetOwners,
    enteringOwners: streamSnapshot.counts.enteringOwners,
    leavingOwners: streamSnapshot.counts.leavingOwners,
    unchangedOwners: streamSnapshot.counts.unchangedOwners,
    resourceKindClassifications: streamSnapshot.counts.resourceKindClassifications,
    coverageSignatureBuilds: streamSnapshot.counts.coverageSignatures,
    coverageOwnerEntryAllocations:
      streamSnapshot.counts.coverageOwnerEntryAllocations,
    playerUpdateP50Ms: percentile(playerUpdateDurations, 0.5),
    playerUpdateMaximumMs: Math.max(...playerUpdateDurations),
    worldPlanP50Ms: percentile(planDurations, 0.5),
    worldPlanMaximumMs: Math.max(...planDurations),
    staticApplyP50Ms: percentile(staticApplyDurations, 0.5),
    staticApplyMaximumMs: Math.max(...staticApplyDurations),
  }));
  await stream.dispose();
});
