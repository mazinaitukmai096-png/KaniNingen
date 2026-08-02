import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStreamingOwnerMetadataCache,
} from '../src/infinite-world/streaming-owner-metadata.js';
import {
  createCircularStaticStreamingPolicy,
  createStaticObjectStream,
} from '../src/infinite-world/static-object-stream.js';
import { createWorldStreamingCoordinator } from '../src/infinite-world/world-streaming-coordinator.js';
import { createWorldStreamingPolicyRegistry } from '../src/infinite-world/world-streaming-policy-registry.js';
import {
  createNaturalCoverageKey,
} from '../src/infinite-world/natural-streaming-coverage.js';

function createIntegratedRuntime(cache) {
  const runtime = createCircularStaticStreamingPolicy({
    kind: 'natural-owner-metadata-test',
    publicationGroup: 'natural-static',
    maximumRequiredDistanceMeters: 32,
    retentionMarginMeters: 16,
    distanceProfileResolver: () => ({ exactDistanceMeters: 16, horizonDistanceMeters: null }),
    ownerMetadataCache: cache,
  });
  const registry = createWorldStreamingPolicyRegistry();
  registry.register(runtime.policy);
  registry.freeze();
  let now = 1_000;
  const coordinator = createWorldStreamingCoordinator({
    registry,
    ownerMetadataCache: cache,
    clock: () => now++,
  });
  const createPlan = ({ stateRevision = 0, originGeneration = 0 } = {}) => (
    coordinator.createShadowPlan({
      player: { x: -1, z: 1 },
      velocity: { x: 0, z: 0 },
      renderDistancePreset: 'current',
      stateRevision,
      originGeneration,
    })
  );
  return { runtime, createPlan };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function runIntegratedPerformanceWorkload({ reuse }) {
  const cache = createStreamingOwnerMetadataCache({
    diagnosticsEnabled: true,
    reuseParsedCoordinates: reuse,
    reuseClassifications: reuse,
  });
  const { runtime } = createIntegratedRuntime(cache);
  const registry = createWorldStreamingPolicyRegistry();
  registry.register(runtime.policy);
  registry.freeze();
  let now = 1_000;
  const coordinator = createWorldStreamingCoordinator({
    registry,
    ownerMetadataCache: cache,
    clock: () => now,
  });
  const stream = createStaticObjectStream({
    policyKind: runtime.policy.kind,
    classifyOwner: runtime.classifyOwner,
    ownerMetadataCache: cache,
    maximumConcurrentRequests: 1,
    requestOwner: () => ({ promise: new Promise(() => {}), cancel: () => true }),
  });
  const playerUpdateDurations = [];
  const planDurations = [];
  const applyDurations = [];
  let applyCalls = 0;
  for (let frame = 0; frame < 120; frame += 1) {
    cache.beginFrame(frame);
    now += 16;
    const playerX = -1 + Math.floor(frame / 20) * 16;
    const publicationContext = coordinator.createPublicationContext({
      generatedAtMs: now,
      stateRevision: frame,
      originGeneration: Math.floor(frame / 80),
    });
    const coverageKey = createNaturalCoverageKey({
      policyRegistryVersion: registry.version,
      renderDistancePreset: 'current',
      player: { x: playerX, z: 1 },
      velocity: { x: 16, z: 0 },
      velocityPrefetch: runtime.policy.velocityPrefetch,
      settlementContentHash: null,
      runtimeCoverageSignature: `runtime:${Math.floor(playerX / 16)},0`,
      ownerMetadataCache: cache,
    });
    const updateStartedAt = performance.now();
    const planStartedAt = performance.now();
    const result = coordinator.resolveCoveragePlan({
      coverageKey,
      publicationContext,
      createPlanInput: () => ({
        player: { x: playerX, z: 1 },
        velocity: { x: 16, z: 0 },
        renderDistancePreset: 'current',
      }),
    });
    planDurations.push(performance.now() - planStartedAt);
    if (result.regenerated) {
      applyCalls += 1;
      const applyStartedAt = performance.now();
      stream.applyPlan({
        plan: result.plan,
        policyPlan: result.plan.policyPlans[0],
        publicationContext,
        ownerMetadataRevision: coverageKey.signature,
      });
      applyDurations.push(performance.now() - applyStartedAt);
    } else stream.updatePublicationContext(publicationContext);
    // Match production readback pressure without enabling any additional scan.
    stream.diagnostics();
    stream.snapshot();
    playerUpdateDurations.push(performance.now() - updateStartedAt);
  }
  const ownerMetadata = cache.snapshot();
  const result = Object.freeze({
    frames: 120,
    planBuilds: coordinator.snapshot().planCount,
    staticApplyCalls: applyCalls,
    classifyCalls: ownerMetadata.classifyCalls,
    classifyExecutions: ownerMetadata.classifyExecutions,
    classifyHitRate: ownerMetadata.classifyHitRate,
    parseCalls: ownerMetadata.parseCalls,
    parseExecutions: ownerMetadata.parseExecutions,
    parseHitRate: ownerMetadata.parseHitRate,
    signatureBuilds: ownerMetadata.signatureBuilds,
    descriptorAllocations: ownerMetadata.descriptorAllocations,
    playerUpdateP50Ms: percentile(playerUpdateDurations, 0.5),
    playerUpdateMaximumMs: Math.max(...playerUpdateDurations),
    worldPlanP50Ms: percentile(planDurations, 0.5),
    worldPlanMaximumMs: Math.max(...planDurations),
    staticApplyP50Ms: percentile(applyDurations, 0.5),
    staticApplyMaximumMs: Math.max(...applyDurations),
    maximumSynchronousSliceMs: Math.max(
      ...playerUpdateDurations,
      ...planDurations,
      ...applyDurations,
    ),
  });
  await stream.dispose();
  return result;
}

function runRepeatedFrameWork({ reuseParsedCoordinates, reuseClassifications }) {
  const cache = createStreamingOwnerMetadataCache({
    coordinateCapacity: 32,
    classificationCapacity: 64,
    diagnosticsEnabled: true,
    reuseParsedCoordinates,
    reuseClassifications,
  });
  const owners = ['-2,0', '0,0', '214,319'];
  const policies = ['natural-tree', 'natural-bush', 'natural-grass', 'natural-rock'];
  for (let frame = 0; frame < 2; frame += 1) {
    cache.beginFrame(frame);
    for (const path of ['world-plan', 'static-apply', 'presentation', 'diagnostics']) {
      for (const ownerKey of owners) {
        cache.parse(ownerKey, { path });
        for (const policyKind of policies) {
          cache.classify({
            ownerKey,
            policyKind,
            revision: 'coverage-1',
            path,
            classifier: owner => (
              policyKind === 'natural-tree' && owner.ownerX > 100 ? 'manifest' : 'canonical'
            ),
          });
        }
      }
      cache.recordSignature(path);
    }
  }
  return cache.snapshot();
}

test('owner metadata measurement confirms same-frame classification and parse duplication', t => {
  const baseline = runRepeatedFrameWork({
    reuseParsedCoordinates: false,
    reuseClassifications: false,
  });
  const optimized = runRepeatedFrameWork({
    reuseParsedCoordinates: true,
    reuseClassifications: true,
  });
  assert.equal(baseline.classifyCalls, 96);
  assert.equal(baseline.classifyUniqueInputCount, 12);
  assert.equal(baseline.classifyExecutions, 96);
  assert.equal(baseline.classifySameFrameDuplicates, 72);
  assert.equal(baseline.parseCalls, 120);
  assert.equal(baseline.parseUniqueInputCount, 3);
  assert.equal(baseline.parseExecutions, 120);
  assert.equal(baseline.parseSameFrameDuplicates, 114);
  assert.equal(baseline.signatureBuilds, 8);
  assert.equal(optimized.classifyExecutions, 12);
  assert.equal(optimized.parseExecutions, 3);
  assert.equal(optimized.classifyHitRate, 0.875);
  assert.equal(optimized.parseHitRate, 11 / 12);
  assert.deepEqual(optimized.classifyCallsByPolicy, {
    'natural-bush': 24,
    'natural-grass': 24,
    'natural-rock': 24,
    'natural-tree': 24,
  });
  t.diagnostic(JSON.stringify({ baseline, optimized }));
});

test('classification cache invalidates by coverage revision without world-state-only churn', () => {
  const cache = createStreamingOwnerMetadataCache({ diagnosticsEnabled: true });
  let executions = 0;
  const classify = revision => cache.classify({
    ownerKey: '-1,0',
    policyKind: 'natural-tree',
    revision,
    classifier: () => {
      executions += 1;
      return 'canonical';
    },
  });
  assert.equal(classify('coverage:preset=current').resourceKind, 'canonical');
  assert.equal(classify('coverage:preset=current').resourceKind, 'canonical');
  assert.equal(executions, 1, 'world state changes do not alter the coverage revision');
  assert.equal(classify('coverage:preset=short').resourceKind, 'canonical');
  assert.equal(executions, 2);
  cache.retainClassificationRevision({
    revision: 'coverage:preset=short',
    descriptors: [classify('coverage:preset=short')],
  });
  assert.equal(cache.snapshot().classificationCacheSize, 1);
});

test('resource classifications remain isolated by Object policy', () => {
  const cache = createStreamingOwnerMetadataCache({ diagnosticsEnabled: true });
  const tree = cache.classify({
    ownerKey: '32,0',
    policyKind: 'natural-tree',
    revision: 'coverage-1',
    classifier: () => 'manifest',
  });
  const grass = cache.classify({
    ownerKey: '32,0',
    policyKind: 'natural-grass',
    revision: 'coverage-1',
    classifier: () => 'canonical',
  });
  assert.equal(tree.resourceKind, 'manifest');
  assert.equal(grass.resourceKind, 'canonical');
  assert.equal(cache.snapshot().classifyExecutions, 2);
});

test('classifier failure is not cached and leaves the prior revision reusable', () => {
  const cache = createStreamingOwnerMetadataCache({ diagnosticsEnabled: true });
  const prior = cache.classify({
    ownerKey: '0,0',
    policyKind: 'natural-tree',
    revision: 'coverage-1',
    classifier: () => 'canonical',
  });
  assert.throws(() => cache.classify({
    ownerKey: '0,0',
    policyKind: 'natural-tree',
    revision: 'coverage-2',
    classifier: () => { throw new Error('classification failed'); },
  }), /classification failed/);
  assert.equal(cache.classify({
    ownerKey: '0,0',
    policyKind: 'natural-tree',
    revision: 'coverage-1',
    classifier: () => assert.fail('prior descriptor must remain cached'),
  }), prior);
});

test('parsed descriptors preserve negative, zero-boundary, and far logical coordinates', () => {
  const cache = createStreamingOwnerMetadataCache();
  assert.deepEqual(
    ['-1,0', '0,0', '214748,319999'].map(key => {
      const value = cache.parse(key);
      return [value.key, value.ownerX, value.ownerZ];
    }),
    [['-1,0', -1, 0], ['0,0', 0, 0], ['214748,319999', 214748, 319999]],
  );
});

test('diagnostics disabled adds no call-path or unique-input aggregation', () => {
  const cache = createStreamingOwnerMetadataCache({ diagnosticsEnabled: false });
  cache.beginFrame(1);
  cache.classify({
    ownerKey: '0,0',
    policyKind: 'natural-tree',
    revision: 'coverage-1',
    path: 'diagnostics-off',
    classifier: () => 'canonical',
  });
  cache.recordSignature('diagnostics-off');
  const snapshot = cache.snapshot();
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.parseCalls, 0);
  assert.equal(snapshot.classifyCalls, 0);
  assert.equal(snapshot.signatureBuilds, 0);
  assert.deepEqual(snapshot.parseCallsByPath, {});
  assert.deepEqual(snapshot.classifyCallsByPath, {});
});

test('Static Stream reuses parsed owner metadata across plan, diagnostics, and publication', async () => {
  const cache = createStreamingOwnerMetadataCache({ diagnosticsEnabled: true });
  const { runtime, createPlan } = createIntegratedRuntime(cache);
  const requested = [];
  const stream = createStaticObjectStream({
    policyKind: runtime.policy.kind,
    classifyOwner: runtime.classifyOwner,
    ownerMetadataCache: cache,
    requestOwner: request => {
      requested.push(request);
      return Promise.resolve(Object.freeze({ ownerKey: request.ownerKey }));
    },
  });
  cache.beginFrame(1);
  const first = createPlan();
  const firstPolicy = first.policyPlans[0];
  assert.equal(stream.applyPlan({
    plan: first,
    policyPlan: firstPolicy,
    ownerMetadataRevision: 'coverage-current-1',
  }), true);
  await waitFor(() => stream.snapshot().backlog === 0, 'owner metadata requests did not settle');
  const afterApply = cache.snapshot();
  assert.equal(afterApply.classifyExecutions, firstPolicy.allOwnerKeys.length);
  assert.equal(afterApply.parseExecutions, afterApply.parseUniqueInputCount);
  const executionsBeforeReadback = afterApply.classifyExecutions;
  stream.snapshot();
  stream.diagnostics();
  const ownerKey = firstPolicy.requiredOwnerKeys[0];
  assert.equal(stream.publishOwners({ ownerKeys: [ownerKey] }).length, 1);
  const afterReadback = cache.snapshot();
  assert.equal(afterReadback.classifyExecutions, executionsBeforeReadback);
  assert.ok(afterReadback.classifyHits > 0);
  assert.ok(afterReadback.classifyCallsByPath['static-object-stream:diagnostics'] > 0);
  assert.ok(afterReadback.classifyCallsByPath['static-object-stream:snapshot'] > 0);
  assert.equal(requested.every(request => (
    Number.isSafeInteger(request.ownerX) && Number.isSafeInteger(request.ownerZ)
  )), true);
  await stream.dispose();
});

test('coverage revision invalidates classification while state and origin revisions do not', () => {
  const cache = createStreamingOwnerMetadataCache({ diagnosticsEnabled: true });
  const { runtime, createPlan } = createIntegratedRuntime(cache);
  const stream = createStaticObjectStream({
    policyKind: runtime.policy.kind,
    classifyOwner: runtime.classifyOwner,
    ownerMetadataCache: cache,
    requestOwner: () => ({ promise: new Promise(() => {}), cancel: () => true }),
  });
  const first = createPlan();
  stream.applyPlan({
    plan: first,
    policyPlan: first.policyPlans[0],
    ownerMetadataRevision: 'coverage-current-1',
  });
  const firstExecutions = cache.snapshot().classifyExecutions;
  const stateAndOriginOnly = createPlan({ stateRevision: 7, originGeneration: 3 });
  assert.equal(stream.applyPlan({
    plan: stateAndOriginOnly,
    policyPlan: stateAndOriginOnly.policyPlans[0],
    ownerMetadataRevision: 'coverage-current-1',
  }), false);
  assert.equal(cache.snapshot().classifyExecutions, firstExecutions);
  assert.equal(stream.snapshot().coverageGeneration, 1);
  const policyRevision = createPlan({ stateRevision: 8, originGeneration: 3 });
  stream.invalidate('policy-revision-test');
  stream.applyPlan({
    plan: policyRevision,
    policyPlan: policyRevision.policyPlans[0],
    ownerMetadataRevision: 'coverage-current-2',
  });
  assert.ok(cache.snapshot().classifyExecutions > firstExecutions);
  void stream.dispose();
});

test('deterministic owner metadata workload reduces parse and allocation work', async t => {
  const baseline = await runIntegratedPerformanceWorkload({ reuse: false });
  const optimized = await runIntegratedPerformanceWorkload({ reuse: true });
  assert.equal(optimized.planBuilds, baseline.planBuilds);
  assert.equal(optimized.staticApplyCalls, baseline.staticApplyCalls);
  assert.equal(optimized.classifyCalls, baseline.classifyCalls);
  assert.ok(optimized.parseExecutions < baseline.parseExecutions * 0.1);
  assert.ok(optimized.descriptorAllocations < baseline.descriptorAllocations * 0.2);
  assert.ok(optimized.parseHitRate > 0.9);
  t.diagnostic(JSON.stringify({
    schemaVersion: 'streaming-owner-metadata-benchmark-1',
    environment: 'node-deterministic-work-count',
    browserFrameGate: 'pending-user-chrome-trace',
    baseline,
    optimized,
  }));
});
