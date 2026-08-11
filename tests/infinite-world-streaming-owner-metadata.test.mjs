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
import {
  createLegacyRuntimeChunkStreamingPolicy,
} from '../src/infinite-world/world-streaming-plan.js';
import { W8_RENDER_DISTANCE_PRESETS } from '../src/infinite-world/render-distance-policy.js';
import {
  W8_VEGETATION_LOD_KINDS,
  resolveW8VegetationVisibilityContract,
} from '../src/infinite-world/vegetation-lod-policy.js';
import { createW8ForestHorizonOwnerPredicate } from '../src/infinite-world/forest-horizon-owner-policy.js';
import { getW6ScaleProfile } from '../src/infinite-world/gameplay-contract.js';

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

function createProductionNaturalBenchmarkRuntime() {
  const cache = createStreamingOwnerMetadataCache({ diagnosticsEnabled: true });
  const registry = createWorldStreamingPolicyRegistry();
  registry.register(createLegacyRuntimeChunkStreamingPolicy({ ownerMetadataCache: cache }));
  const horizonOwnerPredicate = createW8ForestHorizonOwnerPredicate(
    'production-static-spike-benchmark',
  );
  const runtimes = new Map(Object.values(W8_VEGETATION_LOD_KINDS).map(kind => {
    const distanceProfileResolver = renderDistancePreset => (
      resolveW8VegetationVisibilityContract(renderDistancePreset).byKind[kind]
    );
    const runtime = createCircularStaticStreamingPolicy({
      kind: `natural-${kind}`,
      publicationGroup: 'natural-static',
      maximumRequiredDistanceMeters: Math.max(
        ...Object.keys(W8_RENDER_DISTANCE_PRESETS).map(renderDistancePreset => Math.max(
          distanceProfileResolver(renderDistancePreset).exactDistanceMeters,
          distanceProfileResolver(renderDistancePreset).horizonDistanceMeters ?? 0,
        )),
      ),
      distanceProfileResolver,
      horizonOwnerPredicate: coordinate => (
        kind === W8_VEGETATION_LOD_KINDS.TREE && horizonOwnerPredicate(coordinate)
      ),
      horizonOwnerDensity: kind === W8_VEGETATION_LOD_KINDS.TREE ? 4 : 1,
      ownerMetadataCache: cache,
    });
    registry.register(runtime.policy);
    return [runtime.policy.kind, runtime];
  }));
  registry.freeze();
  let now = 1_000;
  const coordinator = createWorldStreamingCoordinator({
    registry,
    ownerMetadataCache: cache,
    clock: () => now,
  });
  const policyKinds = [...runtimes.keys()];
  const stream = createStaticObjectStream({
    policyKind: policyKinds[0],
    policyKinds,
    classifyOwner: ({ ownerKey, owner, plan, policyPlan }) => (
      runtimes.get(policyPlan.kind).classifyOwner({ ownerKey, owner, plan, policyPlan })
    ),
    combineResourceKinds: ({ resourceKinds }) => (
      resourceKinds.includes('canonical') ? 'canonical' : 'manifest'
    ),
    ownerMetadataCache: cache,
    queueCapacity: 4096,
    readyCapacity: 4096,
    requestOwner: () => ({ promise: new Promise(() => {}), cancel: () => true }),
  });
  const apply = ({ frame, player, velocity }) => {
    cache.beginFrame(frame);
    now += 16;
    const beforeMetadata = cache.snapshot();
    const beforeStream = stream.diagnostics();
    const planStartedAt = performance.now();
    const plan = coordinator.createShadowPlan({
      player,
      velocity,
      renderDistancePreset: 'current',
    });
    const planDurationMs = performance.now() - planStartedAt;
    const naturalPolicyPlans = plan.policyPlans.filter(policy => runtimes.has(policy.kind));
    const applyStartedAt = performance.now();
    stream.applyPlan({
      plan,
      policyPlans: naturalPolicyPlans,
      ownerMetadataRevision: plan.planId,
    });
    const applyPlanDurationMs = performance.now() - applyStartedAt;
    const afterMetadata = cache.snapshot();
    const afterStream = stream.diagnostics();
    const delta = (before, after, key) => after[key] - before[key];
    return Object.freeze({
      planDurationMs,
      applyPlanDurationMs,
      maxStreamingSliceMs: planDurationMs + applyPlanDurationMs,
      parseCalls: delta(beforeMetadata, afterMetadata, 'parseCalls'),
      parseExecutions: delta(beforeMetadata, afterMetadata, 'parseExecutions'),
      parseSameFrameDuplicates: delta(
        beforeMetadata,
        afterMetadata,
        'parseSameFrameDuplicates',
      ),
      descriptorAllocations: delta(
        beforeMetadata,
        afterMetadata,
        'descriptorAllocations',
      ),
      coverageOwnerEntryAllocations: delta(
        beforeStream.counts,
        afterStream.counts,
        'coverageOwnerEntryAllocations',
      ),
      enqueueCalls: delta(beforeStream.counts, afterStream.counts, 'enqueueCalls'),
      readyPageQueueCalls: delta(
        beforeStream.counts,
        afterStream.counts,
        'readyPageQueueCalls',
      ),
      ...afterStream.latestApplyDiff,
      normalizedOwnerCount: naturalPolicyPlans.reduce(
        (sum, policy) => sum + policy.allOwnerKeys.length,
        0,
      ),
      duplicateQueuedTaskCount: stream.snapshot().queuedTaskKeys.length
        - new Set(stream.snapshot().queuedTaskKeys).size,
    });
  };
  return { cache, coordinator, runtimes, stream, apply };
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
  assert.ok(optimized.parseCalls < baseline.parseCalls * 0.2);
  assert.ok(optimized.parseExecutions < baseline.parseExecutions * 0.1);
  assert.ok(optimized.descriptorAllocations < baseline.descriptorAllocations * 0.2);
  t.diagnostic(JSON.stringify({
    schemaVersion: 'streaming-owner-metadata-benchmark-1',
    environment: 'node-deterministic-work-count',
    browserFrameGate: 'pending-user-chrome-trace',
    baseline,
    optimized,
  }));
});

test('production Natural coverage processes only the steady-state owner delta in 12 profiles',
  async t => {
    const reports = [];
    for (const stageId of ['TINY', 'MID', 'MAX']) {
      for (const sprint of [false, true]) {
        for (const path of ['straight', 'diagonal']) {
          const runtime = createProductionNaturalBenchmarkRuntime();
          const profile = getW6ScaleProfile(stageId);
          const speedMetersPerSecond = profile.movementMetersPerSecond
            * (sprint ? profile.sprintMultiplier : 1);
          const axisSpeed = path === 'diagonal'
            ? speedMetersPerSecond / Math.SQRT2 : speedMetersPerSecond;
          const velocity = {
            x: axisSpeed,
            z: path === 'diagonal' ? axisSpeed : 0,
          };
          runtime.apply({ frame: 0, player: { x: 8, z: 8 }, velocity });
          const measured = runtime.apply({
            frame: 1,
            player: { x: 24, z: path === 'diagonal' ? 24 : 8 },
            velocity,
          });
          assert.equal(measured.classifiedOwnerCount, measured.enteringOwnerCount);
          assert.equal(measured.sortTargetOwnerCount, measured.queueCandidateCount);
          assert.equal(measured.enqueueCalls, measured.queueCandidateCount);
          assert.ok(measured.queueInsertionCount <= measured.queueCandidateCount);
          assert.ok(measured.parseCalls < 512, JSON.stringify({ stageId, sprint, path, measured }));
          assert.ok(measured.parseSameFrameDuplicates < 256);
          assert.equal(measured.duplicateQueuedTaskCount, 0);
          reports.push({ stageId, sprint, path, ...measured });
          await runtime.stream.dispose();
        }
      }
    }
    t.diagnostic(JSON.stringify(reports));
  });

test('unchanged production Natural source coverage bypasses merge, classify, and enqueue', async () => {
  const runtime = createProductionNaturalBenchmarkRuntime();
  const velocity = { x: getW6ScaleProfile('MAX').sprintMetersPerSecond, z: 0 };
  runtime.apply({ frame: 0, player: { x: 8, z: 8 }, velocity });
  const first = runtime.stream.diagnostics();
  const repeated = runtime.apply({ frame: 1, player: { x: 8, z: 8 }, velocity });
  const second = runtime.stream.diagnostics();
  assert.equal(repeated.enteringOwnerCount, 0);
  assert.equal(repeated.leavingOwnerCount, 0);
  assert.equal(repeated.classifiedOwnerCount, 0);
  assert.equal(repeated.queueCandidateCount, 0);
  assert.equal(repeated.enqueueCalls, 0);
  assert.equal(second.counts.sourceCoverageFastPaths, first.counts.sourceCoverageFastPaths + 1);
  assert.equal(second.coverageGeneration, first.coverageGeneration);
  await runtime.stream.dispose();
});

test('production Natural delta survives reversal, rapid turn, stop, and restart without duplicate work',
  async t => {
    const runtime = createProductionNaturalBenchmarkRuntime();
    const speed = getW6ScaleProfile('MAX').sprintMetersPerSecond;
    const scenarios = [
      { name: 'east', player: { x: 8, z: 8 }, velocity: { x: speed, z: 0 } },
      { name: 'reverse-west', player: { x: 8, z: 8 }, velocity: { x: -speed, z: 0 } },
      { name: 'rapid-turn-north', player: { x: 8, z: 8 }, velocity: { x: 0, z: -speed } },
      { name: 'stop', player: { x: 8, z: 8 }, velocity: { x: 0, z: 0 } },
      { name: 'restart-east', player: { x: 8, z: 8 }, velocity: { x: speed, z: 0 } },
      { name: 'rapid-movement', player: { x: 56, z: 8 }, velocity: { x: speed, z: 0 } },
    ];
    const reports = scenarios.map((scenario, frame) => ({
      name: scenario.name,
      ...runtime.apply({ frame, player: scenario.player, velocity: scenario.velocity }),
    }));
    t.diagnostic(JSON.stringify(reports));
    for (const report of reports) {
      assert.equal(report.classifiedOwnerCount, report.enteringOwnerCount);
      assert.equal(report.duplicateQueuedTaskCount, 0);
      assert.ok(report.queueInsertionCount <= report.queueCandidateCount);
      // Canonical Far Tree retains every 300m Tree owner (plus the existing
      // velocity corridor) instead of the former 1/4 Remote manifest lattice.
      // Bound parse work to the actual canonical working set rather than the
      // old sparse-manifest absolute owner count.
      assert.ok(report.parseCalls < Math.max(512, report.normalizedOwnerCount * 1.25),
        JSON.stringify(report));
    }
    const snapshot = runtime.stream.snapshot();
    assert.equal(new Set(snapshot.queuedTaskKeys).size, snapshot.queuedTaskKeys.length);
    assert.equal(snapshot.counts.failed, 0);
    assert.equal(snapshot.counts.queueOverflows, 0);
    await runtime.stream.dispose();
  });
