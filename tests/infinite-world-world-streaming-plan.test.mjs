import test from 'node:test';
import assert from 'node:assert/strict';

import { squareChunkCoordinates } from '../src/infinite-world/chunk-coordinates.js';
import {
  LEGACY_RUNTIME_CHUNK_POLICY_KIND,
  WORLD_STREAMING_PLAN_SCHEMA,
  createLegacyRuntimeChunkStreamingPolicy,
  createVelocityCorridor,
  createWorldStreamingPlan,
} from '../src/infinite-world/world-streaming-plan.js';
import {
  WORLD_STREAMING_POLICY_SCHEMA,
  createWorldStreamingPolicyRegistry,
  validateWorldStreamingPolicy,
} from '../src/infinite-world/world-streaming-policy-registry.js';
import { createWorldStreamingCoordinator } from '../src/infinite-world/world-streaming-coordinator.js';

const registeredRuntimePolicy = () => {
  const registry = createWorldStreamingPolicyRegistry();
  registry.register(createLegacyRuntimeChunkStreamingPolicy());
  registry.freeze();
  return registry;
};

const planInput = (overrides = {}) => ({
  sequence: 7,
  generatedAtMs: 1_000,
  player: { x: 8, z: 8 },
  velocity: { x: 0, z: 0 },
  renderDistancePreset: 'current',
  stateRevision: 3,
  originGeneration: 2,
  policies: registeredRuntimePolicy().list(),
  ...overrides,
});

const policyWith = overrides => ({
  ...createLegacyRuntimeChunkStreamingPolicy(),
  ...overrides,
});

test('policy validation accepts and freezes the complete Phase 2 contract', () => {
  const policy = validateWorldStreamingPolicy(createLegacyRuntimeChunkStreamingPolicy());
  assert.equal(policy.schemaVersion, WORLD_STREAMING_POLICY_SCHEMA);
  assert.equal(policy.kind, LEGACY_RUNTIME_CHUNK_POLICY_KIND);
  assert.equal(policy.distanceBands.required.radiusChunks, 1);
  assert.equal(policy.distanceBands.prefetched.radiusChunks, 2);
  assert.equal(policy.distanceBands.retained.radiusChunks, 2);
  assert.equal(policy.publicationGroup, 'runtime-transition');
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.distanceBands), true);
});

test('policy registry rejects duplicate kinds and registration after freeze', () => {
  const registry = createWorldStreamingPolicyRegistry();
  registry.register(createLegacyRuntimeChunkStreamingPolicy());
  assert.throws(
    () => registry.register(createLegacyRuntimeChunkStreamingPolicy()),
    /duplicate World Streaming policy/,
  );
  registry.freeze();
  assert.throws(() => registry.register(policyWith({ kind: 'other-kind' })), /registry is frozen/);
});

test('policy validation rejects invalid schema, stream, distance order, resolver, and cycles', () => {
  assert.throws(() => validateWorldStreamingPolicy(policyWith({ schemaVersion: 'invalid' })),
    /schemaVersion/);
  assert.throws(() => validateWorldStreamingPolicy(policyWith({ stream: 'render-root' })),
    /unsupported policy stream/);
  assert.throws(() => validateWorldStreamingPolicy(policyWith({
    distanceBands: {
      required: { radiusChunks: 2, deadlineSeconds: 0 },
      prefetched: { radiusChunks: 1, deadlineSeconds: 1 },
      retained: { radiusChunks: 2, deadlineSeconds: null },
    },
  })), /required <= prefetched <= retained/);
  assert.throws(() => validateWorldStreamingPolicy(policyWith({ ownerResolver: null })),
    /ownerResolver/);

  const registry = createWorldStreamingPolicyRegistry();
  registry.register(policyWith({
    kind: 'first-policy',
    publicationGroup: 'first-group',
    publicationDependencies: ['second-group'],
  }));
  registry.register(policyWith({
    kind: 'second-policy',
    publicationGroup: 'second-group',
    publicationDependencies: ['first-group'],
  }));
  assert.throws(() => registry.freeze(), /cyclic publication dependency/);
});

test('World Streaming plan is deterministic for identical input including Plan ID', () => {
  const left = createWorldStreamingPlan(planInput());
  const right = createWorldStreamingPlan(planInput());
  assert.deepEqual(left, right);
  assert.equal(left.schemaVersion, WORLD_STREAMING_PLAN_SCHEMA);
  assert.equal(left.mode, 'shadow');
  assert.match(left.planId, /^world-plan-7-[0-9a-f]{8}$/);
});

test('velocity corridor is bounded, ordered, and crosses into the predicted owner', () => {
  const corridor = createVelocityCorridor({
    logicalPosition: { x: 15, z: 8 },
    velocity: { x: 10, z: 0 },
    leadSeconds: 2.25,
    maximumDistanceMeters: 16,
    sampleIntervalSeconds: 0.1,
  });
  assert.equal(corridor.speedMetersPerSecond, 10);
  assert.equal(corridor.distanceMeters, 16);
  assert.equal(corridor.clamped, true);
  assert.deepEqual(corridor.ownerKeys, ['0,0', '1,0']);
  assert.deepEqual(corridor.endpoint, { x: 31, z: 8 });
  assert.ok(corridor.samples.every((sample, index, values) => (
    index === 0 || sample.timeSeconds >= values[index - 1].timeSeconds
  )));
});

test('legacy runtime owner sets reproduce 3x3 required and 5x5 request/retained coverage', () => {
  const plan = createWorldStreamingPlan(planInput());
  const policy = plan.policyPlans[0];
  assert.equal(policy.requiredOwnerKeys.length, 9);
  assert.equal(policy.prefetchedOwnerKeys.length, 16);
  assert.equal(policy.requestOwnerKeys.length, 25);
  assert.equal(policy.retainedOwnerKeys.length, 25);
  assert.equal(policy.deadline.requiredAtMs, 1_000);
  assert.equal(policy.deadline.prefetchedAtMs, 1_900);
  assert.equal(plan.publicationGroups[0].group, 'runtime-transition');
  assert.equal(plan.publicationGroups[0].requiredOwnerKeys.length, 9);
});

test('negative logical coordinates produce deterministic negative owner coverage', () => {
  const plan = createWorldStreamingPlan(planInput({ player: { x: -8, z: -8 } }));
  const policy = plan.policyPlans[0];
  assert.deepEqual(policy.requiredOwnerKeys, [
    '-2,-2', '-1,-2', '0,-2',
    '-2,-1', '-1,-1', '0,-1',
    '-2,0', '-1,0', '0,0',
  ]);
  assert.equal(policy.requestOwnerKeys.length, 25);
});

test('preset changes create a new deterministic Plan ID without changing legacy coverage', () => {
  const current = createWorldStreamingPlan(planInput({ renderDistancePreset: 'current' }));
  const standard = createWorldStreamingPlan(planInput({ renderDistancePreset: 'standard' }));
  assert.notEqual(current.planId, standard.planId);
  assert.notEqual(current.signatureHash, standard.signatureHash);
  assert.deepEqual(
    current.policyPlans[0].requestOwnerKeys,
    standard.policyPlans[0].requestOwnerKeys,
  );
});

test('Coordinator generates monotonic shadow Plan IDs and compares current requests without ownership', () => {
  const coordinator = createWorldStreamingCoordinator({
    registry: registeredRuntimePolicy(),
    clock: () => 5_000,
  });
  const requiredOwnerKeys = squareChunkCoordinates(0, 0, 1).map(value => value.key);
  const requestOwnerKeys = squareChunkCoordinates(0, 0, 2).map(value => value.key);
  const input = {
    player: { x: 8, z: 8 },
    velocity: { x: 0, z: 0 },
    renderDistancePreset: 'current',
    stateRevision: 1,
    originGeneration: 1,
    currentRequests: {
      [LEGACY_RUNTIME_CHUNK_POLICY_KIND]: {
        requiredOwnerKeys,
        requestOwnerKeys,
        retainedOwnerKeys: requestOwnerKeys,
      },
    },
  };
  const first = coordinator.createShadowPlan(input);
  const second = coordinator.createShadowPlan(input);
  assert.notEqual(first.planId, second.planId);
  assert.equal(first.signatureHash, second.signatureHash);
  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.mode, 'shadow');
  assert.equal(snapshot.planCount, 2);
  assert.equal(snapshot.latestComparison.matches, true);
  assert.equal(snapshot.performance.sampleCapacity, 256);
  assert.equal(snapshot.performance.sampleCount, 2);
  assert.equal(snapshot.performance.p95PlanDurationMs, 0);
  assert.deepEqual(snapshot.ownership, {
    mesh: false,
    material: false,
    gameplay: false,
    worker: false,
    renderRoot: false,
  });
});
