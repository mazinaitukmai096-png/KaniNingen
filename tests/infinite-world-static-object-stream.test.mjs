import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createCircularStaticStreamingPolicy,
  createStaticObjectStream,
  staticMovingPointChunkAabbEntrySeconds,
} from '../src/infinite-world/static-object-stream.js';
import { createResidentWorldCoverage } from '../src/infinite-world/chunk-streaming-plan.js';
import { LOGICAL_CHUNK_SIZE_METERS, parseChunkKey } from '../src/infinite-world/chunk-coordinates.js';
import { createWorldStreamingCoordinator } from '../src/infinite-world/world-streaming-coordinator.js';
import { createWorldStreamingPolicyRegistry } from '../src/infinite-world/world-streaming-policy-registry.js';
import {
  createW8ForestHorizonOwnerPredicate,
  isW8ForestHorizonOwner,
} from '../src/infinite-world/forest-horizon-owner-policy.js';
import {
  W8_RENDER_DISTANCE_PRESETS,
  resolveW8RenderDistancePolicy,
} from '../src/infinite-world/render-distance-policy.js';
import {
  W8_VEGETATION_LOD_KINDS,
  resolveW8VegetationLodPolicy,
} from '../src/infinite-world/vegetation-lod-policy.js';

const POLICY_KIND = 'test-static-object';

function createPolicyRuntime({ horizon = true } = {}) {
  return createCircularStaticStreamingPolicy({
    kind: POLICY_KIND,
    publicationGroup: 'test-static-publication',
    maximumRequiredDistanceMeters: 48,
    retentionMarginMeters: 16,
    velocityPrefetch: Object.freeze({
      enabled: true,
      leadSeconds: 2,
      maximumDistanceMeters: 64,
      sampleIntervalSeconds: 0.5,
    }),
    distanceProfileResolver: () => Object.freeze({
      exactDistanceMeters: 16,
      horizonDistanceMeters: horizon ? 48 : null,
    }),
    horizonOwnerPredicate: ({ chunkX, chunkZ }) => (chunkX + chunkZ) % 2 === 0,
  });
}

function createPlanner(policy) {
  const registry = createWorldStreamingPolicyRegistry();
  registry.register(policy);
  registry.freeze();
  let now = 1_000;
  const coordinator = createWorldStreamingCoordinator({ registry, clock: () => now++ });
  return input => coordinator.createShadowPlan({
    player: input.player ?? { x: 0, z: 0 },
    velocity: input.velocity ?? { x: 0, z: 0 },
    renderDistancePreset: 'current',
    stateRevision: input.stateRevision ?? 0,
    originGeneration: input.originGeneration ?? 0,
    residentCoverage: input.residentCoverage ?? null,
  });
}

function policyPlan(plan) {
  return plan.policyPlans.find(value => value.kind === POLICY_KIND);
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

test('velocity corridor creates a generic ahead ready-set without changing required coverage', () => {
  const runtime = createPolicyRuntime();
  const plan = createPlanner(runtime.policy);
  const stationary = plan({ player: { x: -1, z: -1 } });
  const moving = plan({
    player: { x: -1, z: -1 },
    velocity: { x: 24, z: 0 },
  });
  const stationaryPolicy = policyPlan(stationary);
  const movingPolicy = policyPlan(moving);

  assert.deepEqual(movingPolicy.requiredOwnerKeys, stationaryPolicy.requiredOwnerKeys);
  assert.equal(stationaryPolicy.prefetchedOwnerKeys.length, 0,
    'zero velocity must not turn a degenerate corridor into square prefetch coverage');
  assert.ok(movingPolicy.prefetchedOwnerKeys.length > stationaryPolicy.prefetchedOwnerKeys.length);
  assert.ok(movingPolicy.prefetchedOwnerKeys.some(key => Number(key.split(',')[0]) > 0));
  assert.ok(movingPolicy.retainedOwnerKeys.every(key => movingPolicy.allOwnerKeys.includes(key)));
});

test('a high-speed turn replaces the prefetched corridor while retaining current owners', () => {
  const runtime = createPolicyRuntime();
  const plan = createPlanner(runtime.policy);
  const east = policyPlan(plan({ velocity: { x: 32, z: 0 } }));
  const north = policyPlan(plan({ velocity: { x: 0, z: -32 } }));

  assert.deepEqual(east.requiredOwnerKeys, north.requiredOwnerKeys);
  assert.notDeepEqual(east.prefetchedOwnerKeys, north.prefetchedOwnerKeys);
  assert.ok(east.prefetchedOwnerKeys.some(key => Number(key.split(',')[0]) > 1));
  assert.ok(north.prefetchedOwnerKeys.some(key => Number(key.split(',')[1]) < -1));
});

test('resource prewarm margin stays outside the true visual Expected boot cohort', async t => {
  const runtime = createPolicyRuntime({ horizon: false });
  const planner = createPlanner(runtime.policy);
  const residentCoverage = createResidentWorldCoverage({
    centerChunkX: 0,
    centerChunkZ: 0,
  });
  const plan = planner({
    player: { x: 0, z: 0 },
    velocity: { x: 0, z: 0 },
    residentCoverage,
  });
  const member = policyPlan(plan);
  const source = member.sourceSnapshot;
  assert.equal(source.requiredRadiusMeters, residentCoverage.presentationView.radiusMeters,
    'resource coverage preserves the shared 368 m Presentation resident window');
  assert.equal(source.visualRadiusMeters, 16);
  assert.deepEqual(source.visualExpected, source.visualRequired,
    'stationary visual Expected must not invent a corridor');
  assert.ok(source.coarsePrewarm.length > 0,
    'one owner-width coarse safety shell must exist outside visual Expected');
  assert.equal(source.coarsePrewarm.every(ownerKey => (
    !source.visualExpected.includes(ownerKey) && member.requiredOwnerKeys.includes(ownerKey)
  )), true, 'coarse safety must remain Resource-only scheduling metadata');
  assert.ok(member.requiredOwnerKeys.length > source.visualRequired.length);
  assert.equal(source.visualRequired.every(ownerKey => (
    member.requestOwnerKeys.includes(ownerKey)
  )), true);

  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    requestOwner: request => Promise.resolve(Object.freeze({ ownerKey: request.ownerKey })),
  });
  t.after(() => stream.dispose());
  stream.applyPlan({ plan, policyPlan: member });
  const control = stream.snapshot();
  assert.equal(control.requiredOwnerCount, member.requiredOwnerKeys.length);
  assert.equal(control.visualRequiredOwnerCount, source.visualRequired.length);
  assert.equal(control.visualExpectedOwnerCount, source.visualExpected.length);
  assert.equal(control.coarsePrewarmOwnerCount, source.coarsePrewarm.length);
  assert.equal(control.bootCohortOwnerCount, source.visualRequired.length);
  const outerMarginOwner = member.requiredOwnerKeys.find(ownerKey => (
    !source.visualExpected.includes(ownerKey)
  ));
  assert.ok(outerMarginOwner, 'fixture requires a resource-only margin owner');
  const [outerTiming] = stream.ownerTimingSnapshot([outerMarginOwner]);
  assert.equal(outerTiming.cohort, 'steady');
  assert.equal(outerTiming.required, false);
  assert.equal(outerTiming.firstPossibleVisibleAt, null);
  assert.equal(outerTiming.deadlineAtMs, null,
    'stationary resource-only margin must not receive an artificial now deadline');
});

test('coarse safety shell fills before the outer visual ring on the existing cursor', async t => {
  const runtime = createPolicyRuntime({ horizon: false });
  const planner = createPlanner(runtime.policy);
  const residentCoverage = createResidentWorldCoverage({
    centerChunkX: 0,
    centerChunkZ: 0,
  });
  const plan = planner({
    player: { x: 0, z: 0 },
    velocity: { x: 0, z: 0 },
    residentCoverage,
  });
  const member = policyPlan(plan);
  const source = member.sourceSnapshot;
  const requests = [];
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 2048,
    requestOwner: request => {
      requests.push(request);
      return Promise.resolve(Object.freeze({ ownerKey: request.ownerKey }));
    },
  });
  t.after(() => stream.dispose());
  stream.applyPlan({ plan, policyPlan: member });
  await waitFor(() => stream.snapshot().backlog === 0,
    'coarse fill ordering fixture did not settle');

  const ownerDistanceSquared = ownerKey => {
    const { chunkX, chunkZ } = parseChunkKey(ownerKey);
    const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
    const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const maximumX = minimumX + LOGICAL_CHUNK_SIZE_METERS;
    const maximumZ = minimumZ + LOGICAL_CHUNK_SIZE_METERS;
    const closestX = Math.max(minimumX, Math.min(maximumX, plan.player.x));
    const closestZ = Math.max(minimumZ, Math.min(maximumZ, plan.player.z));
    return (closestX - plan.player.x) ** 2 + (closestZ - plan.player.z) ** 2;
  };
  const innerDistanceSquared = source.coarseFillInnerRadiusMeters ** 2;
  const category = ownerKey => {
    if (source.isVisualExpected(ownerKey)
      && ownerDistanceSquared(ownerKey) <= innerDistanceSquared) return 'inner';
    if (source.isCoarsePrewarm(ownerKey)) return 'safety';
    if (source.isVisualExpected(ownerKey)) return 'outer-visual';
    return 'resource';
  };
  const categories = requests.map(request => category(request.ownerKey));
  const lastInner = categories.lastIndexOf('inner');
  const firstSafety = categories.indexOf('safety');
  const lastSafety = categories.lastIndexOf('safety');
  const firstOuterVisual = categories.indexOf('outer-visual');
  assert.ok(lastInner >= 0 && firstSafety > lastInner,
    'local/inner visual world must fill before the safety shell');
  assert.ok(lastSafety >= firstSafety && firstOuterVisual > lastSafety,
    'the full safety shell must precede the outer visual ring');
  assert.equal(requests.slice(firstSafety, lastSafety + 1).every(request => (
    request.required && request.priority === 3 && request.deadlineAtMs === null
  )), true, 'safety shell must use coarse-existence scheduling without fake deadlines');
  const readyPages = stream.drainReadyOwnerPages({ limit: 2048 });
  const pageCategories = readyPages.map(page => category(page.ownerKey));
  assert.ok(pageCategories.indexOf('safety') > pageCategories.lastIndexOf('inner'));
  assert.ok(pageCategories.indexOf('outer-visual') > pageCategories.lastIndexOf('safety'),
    'the one ready-page bridge must preserve inner/safety/outer coarse ordering');
  assert.equal(readyPages.every(page => page.coarseFillBand === ({
    inner: 1,
    safety: 2,
    'outer-visual': 3,
    resource: 4,
  })[category(page.ownerKey)]), true);
  assert.ok(stream.snapshot().admissionWindowCount <= 2048);
});

test('cached Resource margin page is re-admitted when its owner enters Visual Expected', async t => {
  const runtime = createPolicyRuntime({ horizon: false });
  const planner = createPlanner(runtime.policy);
  const residentCoverage = createResidentWorldCoverage({
    centerChunkX: 0,
    centerChunkZ: 0,
  });
  const initial = planner({
    player: { x: 0, z: 0 },
    residentCoverage,
  });
  const initialPolicy = policyPlan(initial);
  const marginOwner = initialPolicy.requiredOwnerKeys.find(ownerKey => (
    !initialPolicy.sourceSnapshot.visualExpected.includes(ownerKey)
  ));
  assert.ok(marginOwner, 'fixture requires one Resource-only owner');
  let requestCount = 0;
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 2048,
    requestOwner: request => {
      requestCount += 1;
      return Promise.resolve(Object.freeze({ ownerKey: request.ownerKey }));
    },
  });
  t.after(() => stream.dispose());
  stream.applyPlan({ plan: initial, policyPlan: initialPolicy });
  await waitFor(() => stream.snapshot().backlog === 0, 'initial Resource pages did not settle');
  assert.equal(stream.drainReadyOwnerPages({ limit: 2048 })
    .some(page => page.ownerKey === marginOwner), true,
  'the lazy Resource window may warm coarse pages without making them Visual Expected');
  const cachedResource = stream.readyOwnerResource(marginOwner);
  assert.ok(cachedResource,
    'requirement metadata can read the already-consumed immutable ready cache entry');
  assert.equal(stream.drainReadyOwnerPages({ limit: 2048 }).length, 0);
  const requestsBeforeVisualEntry = requestCount;

  const [chunkX, chunkZ] = marginOwner.split(',').map(Number);
  const moved = planner({
    player: { x: (chunkX + 0.5) * 16, z: (chunkZ + 0.5) * 16 },
    stateRevision: 1,
    residentCoverage,
  });
  const movedPolicy = policyPlan(moved);
  assert.equal(movedPolicy.sourceSnapshot.visualExpected.includes(marginOwner), true);
  stream.applyPlan({ plan: moved, policyPlan: movedPolicy });
  const reAdmitted = stream.drainReadyOwnerPages({ limit: 2048 });
  const replayed = reAdmitted.find(page => page.ownerKey === marginOwner);
  assert.ok(replayed,
    'Visual entry must replay the cached page through the one existing publication bridge');
  assert.equal(replayed.schedulerRequired, true);
  assert.equal(Number.isFinite(replayed.deadlineAtMs), true);
  assert.equal(replayed.deadlineAtMs,
    stream.ownerTimingSnapshot([marginOwner])[0].deadlineAtMs);
  assert.equal(requestCount, requestsBeforeVisualEntry,
    'cached visual entry must not regenerate the resource');
  assert.equal(stream.readyOwnerResource(marginOwner), cachedResource,
    'metadata lookup must not consume, clone, or requeue the cached resource');
  assert.equal(stream.drainReadyOwnerPages({ limit: 2048 }).length, 0);
  stream.applyPlan({ plan: moved, policyPlan: movedPolicy });
  assert.equal(stream.drainReadyOwnerPages({ limit: 2048 }).length, 0,
    'the unchanged visual set must not duplicate the replay');
});

test('diagonal visual ETA enters the rounded Chunk radius, not the expanded square corner', () => {
  const entrySeconds = staticMovingPointChunkAabbEntrySeconds({
    chunkX: 0,
    chunkZ: 0,
    player: { x: -20, z: -20 },
    velocity: { x: 1, z: 1 },
    radiusMeters: 10,
  });
  assert.ok(Math.abs(entrySeconds - (20 - 10 / Math.sqrt(2))) < 1e-9);
  assert.ok(entrySeconds > 10,
    'independently expanding both AABB axes would report the false square-corner ETA');
});

test('diagonal square-corner resource prefetch does not create a false visual Expected owner', () => {
  const runtime = createCircularStaticStreamingPolicy({
    kind: POLICY_KIND,
    publicationGroup: 'test-static-publication',
    maximumRequiredDistanceMeters: 16,
    velocityPrefetch: Object.freeze({
      enabled: true,
      leadSeconds: 2,
      maximumDistanceMeters: 64,
      sampleIntervalSeconds: 0.5,
    }),
    distanceProfileResolver: () => Object.freeze({
      exactDistanceMeters: 16,
      horizonDistanceMeters: null,
    }),
  });
  const plan = createPlanner(runtime.policy)({
    player: { x: -32, z: -32 },
    velocity: { x: 8, z: 8 },
  });
  const member = policyPlan(plan);
  assert.ok(member.prefetchedOwnerKeys.includes('0,0'),
    'resource prefetch may conservatively include the expanded square corner');
  assert.equal(member.sourceSnapshot.visualExpected.includes('0,0'), false,
    'visual Expected must use Euclidean distance to the owner AABB');
  assert.equal(member.sourceSnapshot.visualExpected.every(ownerKey => (
    member.requestOwnerKeys.includes(ownerKey)
  )), true, 'every exact visual Expected owner must already belong to resource demand');
});

test('coverage cache never reuses an older sub-Chunk visual circle alignment', () => {
  const runtime = createCircularStaticStreamingPolicy({
    kind: POLICY_KIND,
    publicationGroup: 'test-static-publication',
    maximumRequiredDistanceMeters: 300,
    velocityPrefetch: Object.freeze({
      enabled: true,
      leadSeconds: 4,
      maximumDistanceMeters: 192,
      sampleIntervalSeconds: 0.25,
    }),
    distanceProfileResolver: () => Object.freeze({
      exactDistanceMeters: 300,
      horizonDistanceMeters: null,
    }),
  });
  const planner = createPlanner(runtime.policy);
  const first = policyPlan(planner({
    player: { x: 549.75, z: 430.4525 },
    velocity: { x: 0, z: -47.85 },
    stateRevision: 1,
  }));
  const shifted = policyPlan(planner({
    player: { x: 557.918506, z: 427.068994 },
    velocity: { x: 0, z: -47.85 },
    stateRevision: 2,
  }));
  assert.equal(first.sourceSnapshot.visualExpected.includes('15,11'), true,
    'the earlier north corridor reaches the lateral owner');
  assert.equal(shifted.sourceSnapshot.visualExpected.includes('15,11'), false,
    'same start/end owner keys cannot reuse a stale lateral circle after regeneration');
});

test('boot owners use staged fill while entering velocity owners expose AABB ETA and queue age', async t => {
  const runtime = createPolicyRuntime();
  const planner = createPlanner(runtime.policy);
  let now = 10_000;
  const pending = [];
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 1,
    clock: () => now,
    requestOwner: request => new Promise(resolve => pending.push({ request, resolve })),
  });
  t.after(() => stream.dispose());
  const boot = planner({ player: { x: 0, z: 0 }, velocity: { x: 0, z: 0 } });
  stream.applyPlan({ plan: boot, policyPlan: policyPlan(boot) });
  const bootTiming = stream.ownerTimingSnapshot(policyPlan(boot).requiredOwnerKeys);
  assert.equal(bootTiming.length, policyPlan(boot).requiredOwnerKeys.length);
  assert.equal(bootTiming.every(value => value.cohort === 'boot'
    && value.deadlineAtMs === null), true);

  const moving = planner({ player: { x: 0, z: 0 }, velocity: { x: 32, z: 0 } });
  stream.applyPlan({ plan: moving, policyPlan: policyPlan(moving) });
  const entering = policyPlan(moving).prefetchedOwnerKeys.find(ownerKey => {
    if (policyPlan(boot).requestOwnerKeys.includes(ownerKey)) return false;
    const [candidate] = stream.ownerTimingSnapshot([ownerKey]);
    return candidate?.firstPossibleVisibleAt > moving.generatedAtMs;
  });
  assert.ok(entering);
  const [timing] = stream.ownerTimingSnapshot([entering]);
  assert.equal(timing.cohort, 'steady');
  assert.ok(timing.firstPossibleVisibleAt > moving.generatedAtMs);
  assert.equal(timing.deadlineAtMs, timing.firstPossibleVisibleAt);

  now += 250;
  const aged = stream.snapshot();
  assert.ok(aged.oldestPendingTaskAgeMs >= 250);
  assert.ok(aged.oldestAdmissionCursorAgeMs >= 250);
  assert.ok(aged.maximumPendingTaskAgeMs >= aged.oldestPendingTaskAgeMs);
  assert.ok(aged.maximumAdmissionCursorAgeMs >= aged.oldestAdmissionCursorAgeMs);
  for (const handle of pending) handle.resolve(null);
});

test('a boot identity that leaves visual Expected receives exact steady ETA on re-entry', async t => {
  const runtime = createPolicyRuntime({ horizon: false });
  const planner = createPlanner(runtime.policy);
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 1,
    requestOwner: request => Promise.resolve(Object.freeze({ ownerKey: request.ownerKey })),
  });
  t.after(() => stream.dispose());

  const boot = planner({ player: { x: 8, z: 8 }, velocity: { x: 0, z: 0 } });
  stream.applyPlan({ plan: boot, policyPlan: policyPlan(boot) });
  const ownerKey = '0,0';
  assert.ok(policyPlan(boot).sourceSnapshot.visualRequired.includes(ownerKey));
  assert.equal(stream.ownerTimingSnapshot([ownerKey])[0]?.cohort, 'boot');

  const left = planner({ player: { x: 80, z: 8 }, velocity: { x: 0, z: 0 } });
  stream.applyPlan({ plan: left, policyPlan: policyPlan(left) });
  assert.equal(policyPlan(left).sourceSnapshot.visualExpected.includes(ownerKey), false);
  assert.equal(stream.ownerTimingSnapshot([ownerKey]).length, 0,
    'leaving resource demand prunes the old boot timing');

  const reentering = planner({
    player: { x: 64, z: 8 },
    velocity: { x: -16, z: 0 },
  });
  stream.applyPlan({ plan: reentering, policyPlan: policyPlan(reentering) });
  assert.equal(policyPlan(reentering).sourceSnapshot.visualRequired.includes(ownerKey), false);
  assert.equal(policyPlan(reentering).sourceSnapshot.visualExpected.includes(ownerKey), true);
  const [timing] = stream.ownerTimingSnapshot([ownerKey]);
  assert.equal(timing.cohort, 'steady');
  assert.ok(timing.firstPossibleVisibleAt > reentering.generatedAtMs);
  assert.equal(timing.deadlineAtMs, timing.firstPossibleVisibleAt);
  assert.equal(timing.required, false);
});

test('finite-deadline entering owner bypasses a huge boot cursor through the existing queue', async () => {
  const runtime = createPolicyRuntime();
  const planner = createPlanner(runtime.policy);
  let now = 20_000;
  let cancelCount = 0;
  const requests = [];
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 4,
    clock: () => now,
    requestOwner: request => {
      let resolve;
      let settled = false;
      const promise = new Promise(nextResolve => { resolve = nextResolve; });
      const operation = {
        request,
        complete: value => {
          if (settled) return false;
          settled = true;
          resolve(value);
          return true;
        },
      };
      requests.push(operation);
      return {
        promise,
        cancel: () => {
          if (settled) return false;
          cancelCount += 1;
          return operation.complete(null);
        },
      };
    },
  });

  const boot = planner({ player: { x: 0, z: 0 }, velocity: { x: 0, z: 0 } });
  const bootMember = policyPlan(boot);
  assert.ok(bootMember.requestOwnerKeys.length > 4, 'test requires a staged boot cursor');
  stream.applyPlan({ plan: boot, policyPlan: bootMember });
  assert.equal(requests.length, 4);
  assert.equal(requests.every(({ request }) => request.coverageRequired
    && request.required
    && request.priority === 3
    && request.deadlineAtMs === null), true,
  'boot visual Expected owners must be staged coarse-existence work without fake deadlines');
  assert.ok(stream.snapshot().pendingAdmissionCount > 0);

  now += 10;
  const moving = planner({ player: { x: 0, z: 0 }, velocity: { x: 32, z: 0 } });
  const movingMember = policyPlan(moving);
  stream.applyPlan({ plan: moving, policyPlan: movingMember });
  const bootOwnerKeys = new Set(bootMember.requestOwnerKeys);
  const finiteEnteringTimings = stream.ownerTimingSnapshot(movingMember.requestOwnerKeys)
    .filter(timing => !bootOwnerKeys.has(timing.ownerKey)
      && Number.isFinite(timing.deadlineAtMs));
  assert.ok(finiteEnteringTimings.length > 0);
  assert.equal(requests.length, 4,
    'an active boot request must not be cancelled to make physical room');
  assert.equal(cancelCount, 0);

  requests[0].complete(Object.freeze({ ownerKey: requests[0].request.ownerKey }));
  await waitFor(() => requests.length === 5,
    'entering owner did not take the next bounded admission slot');
  const next = requests[4].request;
  assert.equal(bootOwnerKeys.has(next.ownerKey), false,
    'the next slot was consumed by the remaining boot cursor');
  assert.equal(next.required, true,
    'finite ETA must enter the coordinator coarse-existence class');
  assert.equal(next.coverageRequired, false,
    'scheduler promotion must not mutate the Expected required denominator');
  assert.equal(next.priority, 3);
  assert.ok(Number.isFinite(next.deadlineAtMs));
  assert.equal(cancelCount, 0);
  assert.ok(stream.snapshot().pendingAdmissionCount > 0,
    'boot staged fill must continue after deadline-bearing admission');

  await stream.dispose();
});

test('incremental apply classifies and sorts only entering policy-owner identities', async t => {
  const runtime = createPolicyRuntime();
  const planner = createPlanner(runtime.policy);
  const requestedObjects = new Map();
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    requestOwner: request => {
      const key = `${request.resourceKind}:${request.ownerKey}`;
      const value = requestedObjects.get(key) ?? Object.freeze({ key, stableId: `id:${key}` });
      requestedObjects.set(key, value);
      return Promise.resolve(value);
    },
  });
  const scenarios = [
    { name: 'tiny-walk', player: { x: 0, z: 0 }, velocity: { x: 4, z: 0 } },
    { name: 'mid-walk', player: { x: 0, z: 0 }, velocity: { x: 12, z: 0 } },
    { name: 'max-walk', player: { x: 0, z: 0 }, velocity: { x: 33, z: 0 } },
    { name: 'max-sprint', player: { x: 0, z: 0 }, velocity: { x: 66, z: 0 } },
    { name: 'turn', player: { x: 0, z: 0 }, velocity: { x: 0, z: -33 } },
    { name: 'return', player: { x: 0, z: 0 }, velocity: { x: -33, z: 0 } },
    { name: 'stop', player: { x: 0, z: 0 }, velocity: { x: 0, z: 0 } },
    { name: 'tiny-again', player: { x: 0, z: 0 }, velocity: { x: 4, z: 0 } },
  ];
  const reports = [];
  for (const scenario of scenarios) {
    const plan = planner({ player: scenario.player, velocity: scenario.velocity });
    const member = policyPlan(plan);
    stream.applyPlan({
      plan,
      policyPlan: member,
      ownerMetadataRevision: plan.planId,
    });
    const actual = new Map(stream.policyResourceKindEntries()[0].resourceKindEntries);
    const expected = new Map(member.allOwnerKeys.map(ownerKey => [
      ownerKey,
      runtime.classifyOwner({ ownerKey, plan, policyPlan: member }),
    ]));
    assert.deepEqual(actual, expected, `${scenario.name} resource coverage changed`);
    assert.equal(actual.size, member.allOwnerKeys.length);
    const diff = stream.snapshot().latestApplyDiff;
    assert.equal(diff.classifiedOwnerCount, diff.enteringOwnerCount);
    assert.equal(diff.enteringOwnerCount + diff.unchangedOwnerCount,
      member.allOwnerKeys.length);
    assert.equal(diff.sortTargetOwnerCount, diff.queueCandidateCount);
    assert.ok(diff.queueInsertionCount <= 4,
      `${scenario.name} materialized more than the request window`);
    assert.ok(stream.snapshot().admissionWindowCount <= 4);
    assert.equal(new Set(actual.keys()).size, actual.size);
    reports.push({ name: scenario.name, ...diff });
    await new Promise(resolve => setImmediate(resolve));
  }
  await waitFor(() => stream.snapshot().backlog === 0, 'incremental requests did not settle');
  const finalPlan = planner({ player: { x: 0, z: 0 }, velocity: { x: 4, z: 0 } });
  const finalMember = policyPlan(finalPlan);
  const ownerKey = finalMember.requiredOwnerKeys[0];
  const resourceKind = runtime.classifyOwner({
    ownerKey,
    plan: finalPlan,
    policyPlan: finalMember,
  });
  const reused = await stream.requestOrReuse({
    ownerKey,
    resourceKind,
    fallback: () => assert.fail('canonical object identity was orphaned'),
  });
  assert.equal(reused, requestedObjects.get(`${resourceKind}:${ownerKey}`));
  t.diagnostic(JSON.stringify(reports));
  await stream.dispose();
});

test('apply staging keeps the prior generation intact when entering classification throws', () => {
  const runtime = createPolicyRuntime();
  const planner = createPlanner(runtime.policy);
  let rejectedPlanId = null;
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: input => {
      if (input.plan.planId === rejectedPlanId) throw new Error('staged classification failed');
      return runtime.classifyOwner(input);
    },
    maximumConcurrentRequests: 1,
    requestOwner: () => ({ promise: new Promise(() => {}), cancel: () => true }),
  });
  const first = planner({ player: { x: 0, z: 0 }, velocity: { x: 4, z: 0 } });
  stream.applyPlan({
    plan: first,
    policyPlan: policyPlan(first),
    ownerMetadataRevision: first.planId,
  });
  const before = stream.snapshot();
  const beforeEntries = stream.resourceKindEntries();
  const rejected = planner({ player: { x: 512, z: 512 }, velocity: { x: 33, z: 0 } });
  rejectedPlanId = rejected.planId;
  assert.throws(() => stream.applyPlan({
    plan: rejected,
    policyPlan: policyPlan(rejected),
    ownerMetadataRevision: rejected.planId,
  }), /staged classification failed/);
  const after = stream.snapshot();
  assert.equal(after.latestPlanId, before.latestPlanId);
  assert.equal(after.coverageGeneration, before.coverageGeneration);
  assert.equal(after.planRevision, before.planRevision);
  assert.equal(after.queuedCount, before.queuedCount);
  assert.equal(after.ticketCount, before.ticketCount);
  assert.equal(stream.resourceKindEntries(), beforeEntries);
});

test('a reentrant supersede discards the older staged diff before commit', () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const planner = createPlanner(runtime.policy);
  const older = planner({ player: { x: 0, z: 0 }, velocity: { x: 4, z: 0 } });
  const latest = planner({ player: { x: 512, z: 512 }, velocity: { x: 33, z: 0 } });
  let superseded = false;
  let stream;
  stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: input => {
      if (!superseded && input.plan.planId === older.planId) {
        superseded = true;
        stream.applyPlan({
          plan: latest,
          policyPlan: policyPlan(latest),
          ownerMetadataRevision: latest.planId,
        });
      }
      return runtime.classifyOwner(input);
    },
    maximumConcurrentRequests: 1,
    requestOwner: () => ({ promise: new Promise(() => {}), cancel: () => true }),
  });
  assert.equal(stream.applyPlan({
    plan: older,
    policyPlan: policyPlan(older),
    ownerMetadataRevision: older.planId,
  }), false);
  const snapshot = stream.snapshot();
  assert.equal(snapshot.latestPlanId, latest.planId);
  assert.equal(snapshot.coverageGeneration, 1);
  assert.equal(snapshot.counts.supersededApplies, 1);
  assert.deepEqual(stream.resourceKindEntries().map(([ownerKey]) => ownerKey),
    policyPlan(latest).allOwnerKeys);
});

test('unchanged merged coverage still commits the latest policy-owner diff baseline', () => {
  const policyKinds = ['test-static-first', 'test-static-second'];
  const member = (kind, ownerKey) => Object.freeze({
    kind,
    stream: 'static-object',
    generatorKind: 'static-object',
    publicationGroup: 'shared-static',
    publicationDependencies: Object.freeze([]),
    requiredOwnerKeys: Object.freeze([ownerKey]),
    prefetchedOwnerKeys: Object.freeze([]),
    retainedOwnerKeys: Object.freeze([ownerKey]),
    allOwnerKeys: Object.freeze([ownerKey]),
    deadline: Object.freeze({ requiredAtMs: 1_000, prefetchedAtMs: 2_000 }),
    velocityCorridor: null,
    resourceKindEntries: Object.freeze([Object.freeze([ownerKey, 'canonical'])]),
  });
  const worldPlan = (planId, policyPlans) => Object.freeze({
    schemaVersion: 'world-streaming-plan-1',
    planId,
    signatureHash: planId,
    generatedAtMs: 1_000,
    stateRevision: 0,
    originGeneration: 0,
    renderDistancePreset: 'current',
    player: Object.freeze({ x: 0, z: 0 }),
    policyPlans: Object.freeze(policyPlans),
  });
  const first = worldPlan('first', [
    member(policyKinds[0], '0,0'),
    member(policyKinds[1], '1,0'),
  ]);
  const swapped = worldPlan('swapped', [
    member(policyKinds[0], '1,0'),
    member(policyKinds[1], '0,0'),
  ]);
  const repeated = worldPlan('repeated', swapped.policyPlans);
  const stream = createStaticObjectStream({
    policyKind: policyKinds[0],
    policyKinds,
    classifyOwner: () => 'canonical',
    requestOwner: () => Promise.resolve(Object.freeze({})),
  });

  assert.equal(stream.applyPlan({ plan: first, policyPlans: first.policyPlans }), true);
  assert.equal(stream.applyPlan({ plan: swapped, policyPlans: swapped.policyPlans }), false);
  assert.deepEqual(stream.snapshot().latestApplyDiff, {
    enteringOwnerCount: 2,
    leavingOwnerCount: 2,
    unchangedOwnerCount: 0,
    classifiedOwnerCount: 2,
    sortTargetOwnerCount: 0,
    queueCandidateCount: 0,
    queueInsertionCount: 0,
  });
  assert.equal(stream.applyPlan({ plan: repeated, policyPlans: repeated.policyPlans }), false);
  assert.deepEqual(stream.snapshot().latestApplyDiff, {
    enteringOwnerCount: 0,
    leavingOwnerCount: 0,
    unchangedOwnerCount: 2,
    classifiedOwnerCount: 0,
    sortTargetOwnerCount: 0,
    queueCandidateCount: 0,
    queueInsertionCount: 0,
  });
});

test('Current stationary and MAX corridors remain inside policy-derived owner capacity', () => {
  const worldSeedHash = 'static-natural-capacity-policy';
  const horizonPredicate = createW8ForestHorizonOwnerPredicate(worldSeedHash);
  const runtimes = Object.values(W8_VEGETATION_LOD_KINDS).map(kind => (
    createCircularStaticStreamingPolicy({
      kind: `natural-${kind}`,
      publicationGroup: 'natural-static',
      maximumRequiredDistanceMeters: Math.max(
        ...Object.keys(W8_RENDER_DISTANCE_PRESETS).map(preset => (
          kind === W8_VEGETATION_LOD_KINDS.TREE
            ? resolveW8RenderDistancePolicy(preset).fogFarMeters
            : resolveW8VegetationLodPolicy(kind, preset).visibilityMeters
        )),
      ),
      distanceProfileResolver: preset => ({
        exactDistanceMeters: resolveW8VegetationLodPolicy(kind, preset).visibilityMeters,
        horizonDistanceMeters: kind === W8_VEGETATION_LOD_KINDS.TREE
          ? resolveW8RenderDistancePolicy(preset).fogFarMeters : null,
      }),
      horizonOwnerPredicate: coordinates => kind === W8_VEGETATION_LOD_KINDS.TREE
        && horizonPredicate(coordinates),
      horizonOwnerDensity: kind === W8_VEGETATION_LOD_KINDS.TREE ? 4 : 1,
    })
  ));
  const registry = createWorldStreamingPolicyRegistry();
  for (const runtime of runtimes) registry.register(runtime.policy);
  registry.freeze();
  const coordinator = createWorldStreamingCoordinator({ registry, clock: () => 1_000 });
  for (const velocity of [{ x: 0, z: 0 }, { x: 10_000, z: 0 }]) {
    const plan = coordinator.createShadowPlan({
      player: { x: 549.75, z: 431.25 },
      velocity,
      renderDistancePreset: 'current',
      stateRevision: 0,
      originGeneration: 0,
    });
    for (const runtime of runtimes) {
      const policyPlan = plan.policyPlans.find(value => value.kind === runtime.policy.kind);
      const classified = policyPlan.allOwnerKeys.map(ownerKey => runtime.classifyOwner({
        ownerKey,
        plan,
        policyPlan,
      }));
      const capacity = runtime.maximumCoverage('current');
      assert.equal(
        classified.filter(kind => kind === 'canonical').length
          <= capacity.maximumCanonicalOwnerCount,
        true,
      );
      if (runtime.policy.kind === 'natural-tree') {
        assert.equal(
          classified.filter(kind => kind === 'manifest').length
            <= capacity.maximumManifestOwnerCount,
          true,
        );
      }
    }
  }
});

test('owner data is requested once and reused by the renderer provider', async () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const plan = createPlanner(runtime.policy)({ velocity: { x: 16, z: 0 } });
  const requests = [];
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    requestOwner: request => {
      requests.push(request);
      return Promise.resolve(Object.freeze({ ownerKey: request.ownerKey, stableId: `id:${request.ownerKey}` }));
    },
  });

  stream.applyPlan({ plan, policyPlan: policyPlan(plan) });
  await waitFor(() => stream.snapshot().backlog === 0, 'Static owner requests did not settle');
  const ownerKey = policyPlan(plan).requiredOwnerKeys[0];
  const before = requests.length;
  const value = await stream.requestOrReuse({
    ownerKey,
    resourceKind: 'canonical',
    fallback: () => assert.fail('ready owner must not call the legacy provider'),
  });

  assert.equal(requests.length, before);
  assert.equal(value.stableId, `id:${ownerKey}`);
  assert.ok(requests.some(request => request.required && request.priority === 3));
  assert.ok(requests.some(request => !request.required && request.priority === 5));
  assert.ok(stream.snapshot().counts.readyHits >= 1);
  await stream.dispose();
});

test('one Static Object Stream merges registered object policies and requests each owner once', async () => {
  const createObjectPolicy = (kind, exactDistanceMeters) => createCircularStaticStreamingPolicy({
    kind,
    publicationGroup: 'shared-natural-static',
    maximumRequiredDistanceMeters: exactDistanceMeters,
    distanceProfileResolver: () => Object.freeze({
      exactDistanceMeters,
      horizonDistanceMeters: null,
    }),
  });
  const first = createObjectPolicy('test-static-first', 16);
  const second = createObjectPolicy('test-static-second', 48);
  const registry = createWorldStreamingPolicyRegistry();
  registry.register(first.policy);
  registry.register(second.policy);
  registry.freeze();
  const coordinator = createWorldStreamingCoordinator({ registry, clock: () => 2_000 });
  const plan = coordinator.createShadowPlan({
    player: { x: 8, z: 8 },
    velocity: { x: 32, z: 0 },
    renderDistancePreset: 'current',
  });
  const plans = plan.policyPlans.filter(value => value.publicationGroup === 'shared-natural-static');
  const requests = [];
  const stream = createStaticObjectStream({
    policyKind: first.policy.kind,
    policyKinds: [first.policy.kind, second.policy.kind],
    classifyOwner: () => 'canonical',
    requestOwner: request => {
      requests.push(request);
      return Promise.resolve(Object.freeze({ ownerKey: request.ownerKey }));
    },
  });

  stream.applyPlan({ plan, policyPlans: plans });
  await waitFor(() => stream.snapshot().backlog === 0, 'merged owner requests did not settle');
  const expectedOwners = new Set(plans.flatMap(value => value.requestOwnerKeys));
  assert.equal(requests.length, expectedOwners.size);
  assert.equal(new Set(requests.map(value => value.ownerKey)).size, requests.length);
  assert.deepEqual(stream.snapshot().policyKinds,
    [first.policy.kind, second.policy.kind]);
  assert.deepEqual(stream.snapshot().policyCoverage.map(value => value.kind),
    [first.policy.kind, second.policy.kind]);
  assert.deepEqual(stream.diagnostics().policyCoverage.map(value => value.kind),
    [first.policy.kind, second.policy.kind]);
  assert.equal(stream.diagnostics().policyCoverage.every(value => (
    value.readyRequiredOwnerCount === value.requiredOwnerCount
  )), true);
  assert.equal(stream.snapshot().requiredOwnerCount,
    new Set(plans.flatMap(value => value.requiredOwnerKeys)).size);
  assert.equal(stream.snapshot().prefetchedOwnerCount > 0, true);
  assert.equal(stream.snapshot().retainedOwnerCount >= stream.snapshot().requiredOwnerCount, true);
  await stream.dispose();
});

test('publication tickets advance from waiting to ready to published for the active plan', async () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const plan = createPlanner(runtime.policy)({});
  const deferred = [];
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 1,
    requestOwner: request => ({
      promise: new Promise(resolve => deferred.push({ request, resolve })),
      cancel: () => false,
    }),
  });
  stream.applyPlan({ plan, policyPlan: policyPlan(plan) });
  assert.ok(stream.snapshot().tickets.some(ticket => ticket.state === 'waiting'));

  while (stream.snapshot().backlog > 0) {
    const next = deferred.shift();
    if (next) next.resolve(Object.freeze({ ownerKey: next.request.ownerKey }));
    await new Promise(resolve => setImmediate(resolve));
  }
  const ownerKey = policyPlan(plan).requiredOwnerKeys[0];
  const tickets = stream.publishOwners({ ownerKeys: [ownerKey] });
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].planId, plan.planId);
  assert.equal(tickets[0].state, 'published');
  assert.equal(tickets[0].publicationGroup, 'test-static-publication');
  await stream.dispose();
});

test('superseded owner work is cooperatively cancelled and cannot publish stale tickets', async () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const plan = createPlanner(runtime.policy);
  const pending = new Map();
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 1,
    requestOwner: request => {
      let resolve;
      const promise = new Promise(nextResolve => { resolve = nextResolve; });
      pending.set(request.ownerKey, { resolve });
      return { promise, cancel: () => { resolve(null); return true; } };
    },
  });
  const first = plan({ player: { x: 0, z: 0 } });
  stream.applyPlan({ plan: first, policyPlan: policyPlan(first) });
  const staleOwner = policyPlan(first).requiredOwnerKeys[0];
  const second = plan({ player: { x: 512, z: 512 } });
  stream.applyPlan({ plan: second, policyPlan: policyPlan(second) });
  const third = plan({ player: { x: 1_024, z: 1_024 } });
  stream.applyPlan({ plan: third, policyPlan: policyPlan(third) });
  await waitFor(
    () => stream.snapshot().counts.cancelled > 0,
    'superseded request was not cooperatively cancelled',
  );

  assert.equal(stream.publishOwners({ ownerKeys: [staleOwner] }).length, 0);
  assert.ok(stream.snapshot().counts.stalePlanCancels > 0);
  for (const value of pending.values()) value.resolve(null);
  await stream.dispose();
});

test('late in-flight completion outside stable coverage is cached but not published', async () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const planner = createPlanner(runtime.policy);
  const pending = new Map();
  let noncancellableOwner = null;
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 1,
    requestOwner: request => {
      noncancellableOwner ??= request.ownerKey;
      let resolve;
      const promise = new Promise(nextResolve => { resolve = nextResolve; });
      pending.set(request.ownerKey, { request, resolve });
      return {
        promise,
        cancel: () => {
          if (request.ownerKey === noncancellableOwner) return false;
          resolve(null);
          return true;
        },
      };
    },
  });
  const first = planner({ player: { x: 0, z: 0 } });
  stream.applyPlan({ plan: first, policyPlan: policyPlan(first) });
  const staleOwner = stream.snapshot().inFlightOwnerKeys[0];
  const relocated = planner({ player: { x: 512, z: 512 } });
  const relocatedAgain = planner({ player: { x: 512, z: 512 }, stateRevision: 1 });
  stream.applyPlan({ plan: relocated, policyPlan: policyPlan(relocated) });
  stream.applyPlan({ plan: relocatedAgain, policyPlan: policyPlan(relocatedAgain) });

  pending.get(staleOwner).resolve(Object.freeze({ ownerKey: staleOwner }));
  await waitFor(
    () => stream.snapshot().counts.staleResultDiscards === 1,
    'late stale completion did not settle into reusable cache',
  );
  assert.equal(stream.drainReadyOwnerPages({ limit: 32 })
    .some(page => page.ownerKey === staleOwner), false);

  const returned = planner({ player: { x: 0, z: 0 }, stateRevision: 2 });
  stream.applyPlan({ plan: returned, policyPlan: policyPlan(returned) });
  for (const ownerKey of stream.snapshot().inFlightOwnerKeys) {
    pending.get(ownerKey)?.resolve(null);
  }
  await waitFor(
    () => stream.snapshot().counts.readyHits > 0,
    'the returned coverage cursor did not reuse the cached late completion',
  );
  assert.equal(stream.drainReadyOwnerPages({ limit: 32 })
    .some(page => page.ownerKey === staleOwner), true);
  await stream.dispose();
});

test('manifest to canonical coverage rejects queued and late obsolete resource pages', async () => {
  const ownerKey = '0,0';
  const deferred = new Map();
  const makePlan = (stateRevision, resourceKind) => Object.freeze({
    schemaVersion: 'world-streaming-plan-1',
    planId: `resource-plan-${stateRevision}`,
    renderDistancePreset: 'current',
    stateRevision,
    originGeneration: 0,
    player: Object.freeze({ x: 0, z: 0 }),
    velocityCorridor: Object.freeze({ endpoint: Object.freeze({ x: 0, z: 0 }) }),
    resourceKind,
  });
  const makePolicyPlan = plan => Object.freeze({
    kind: POLICY_KIND,
    publicationGroup: 'test-static-publication',
    requiredOwnerKeys: Object.freeze([ownerKey]),
    prefetchedOwnerKeys: Object.freeze([]),
    retainedOwnerKeys: Object.freeze([ownerKey]),
    requestOwnerKeys: Object.freeze([ownerKey]),
    allOwnerKeys: Object.freeze([ownerKey]),
    velocityCorridor: plan.velocityCorridor,
    deadline: Object.freeze({ requiredAtMs: 1_000, prefetchedAtMs: 2_000 }),
  });
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: ({ plan }) => plan.resourceKind,
    maximumConcurrentRequests: 1,
    requestOwner: request => {
      let resolve;
      const promise = new Promise(nextResolve => { resolve = nextResolve; });
      deferred.set(request.resourceKind, { request, resolve });
      return { promise, cancel: () => false };
    },
  });

  const manifestPlan = makePlan(0, 'manifest');
  stream.applyPlan({ plan: manifestPlan, policyPlan: makePolicyPlan(manifestPlan) });
  await waitFor(() => deferred.has('manifest'), 'manifest request did not start');
  const canonicalPlan = makePlan(1, 'canonical');
  stream.applyPlan({ plan: canonicalPlan, policyPlan: makePolicyPlan(canonicalPlan) });
  deferred.get('manifest').resolve(Object.freeze({ contentHash: 'manifest-payload' }));
  await waitFor(() => deferred.has('canonical'), 'canonical request did not replace manifest');
  deferred.get('canonical').resolve(Object.freeze({ contentHash: 'canonical-payload' }));
  await waitFor(() => stream.snapshot().backlog === 0, 'replacement requests did not settle');

  const pages = stream.drainReadyOwnerPages({ limit: 8 });
  assert.deepEqual(pages.map(page => page.resourceKind), ['canonical']);
  assert.deepEqual(stream.resourceKindEntries(), [[ownerKey, 'canonical']]);
  assert.equal(stream.snapshot().counts.staleResultDiscards > 0, true);
  assert.equal(stream.publishOwners({ ownerKeys: [ownerKey] })[0].resourceKind, 'canonical');
  await stream.dispose();
});

test('retained owner drops an already-ready page when its resource kind changes', async () => {
  const ownerKey = '0,0';
  const makePlan = (stateRevision, resourceKind) => ({
    schemaVersion: 'world-streaming-plan-1',
    planId: `ready-kind-${stateRevision}`,
    renderDistancePreset: 'current',
    stateRevision,
    originGeneration: 0,
    player: { x: 0, z: 0 },
    velocityCorridor: { endpoint: { x: 0, z: 0 } },
    resourceKind,
  });
  const makePolicyPlan = plan => ({
    kind: POLICY_KIND,
    publicationGroup: 'test-static-publication',
    requiredOwnerKeys: [ownerKey],
    prefetchedOwnerKeys: [],
    retainedOwnerKeys: [ownerKey],
    requestOwnerKeys: [ownerKey],
    allOwnerKeys: [ownerKey],
    velocityCorridor: plan.velocityCorridor,
    deadline: { requiredAtMs: 1_000, prefetchedAtMs: 2_000 },
  });
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: ({ plan }) => plan.resourceKind,
    requestOwner: request => Promise.resolve(Object.freeze({
      ownerKey: request.ownerKey,
      resourceKind: request.resourceKind,
    })),
  });
  const manifestPlan = makePlan(0, 'manifest');
  stream.applyPlan({ plan: manifestPlan, policyPlan: makePolicyPlan(manifestPlan) });
  await waitFor(() => stream.snapshot().readyPageQueueCount === 1,
    'manifest page did not become ready');

  const canonicalPlan = makePlan(1, 'canonical');
  stream.applyPlan({ plan: canonicalPlan, policyPlan: makePolicyPlan(canonicalPlan) });
  await waitFor(() => stream.snapshot().backlog === 0, 'canonical replacement did not settle');
  const pages = stream.drainReadyOwnerPages({ limit: 8 });
  assert.deepEqual(pages.map(page => page.resourceKind), ['canonical']);
  assert.equal(stream.snapshot().counts.staleResultDiscards > 0, true);
  await stream.dispose();
});

test('one-sample stop and restart does not cancel reusable corridor work', async () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const plan = createPlanner(runtime.policy);
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 1,
    requestOwner: () => ({ promise: new Promise(() => {}), cancel: () => true }),
  });
  const moving = plan({ velocity: { x: 32, z: 0 } });
  const stopped = plan({ velocity: { x: 0, z: 0 } });
  stream.applyPlan({ plan: moving, policyPlan: policyPlan(moving) });
  stream.applyPlan({ plan: stopped, policyPlan: policyPlan(stopped) });
  const movingAgain = plan({ velocity: { x: 32, z: 0 } });
  stream.applyPlan({ plan: movingAgain, policyPlan: policyPlan(movingAgain) });

  assert.equal(stream.snapshot().counts.cancelled, 0);
  assert.equal(stream.snapshot().counts.stalePlanCancels, 0);
});

test('stable stopped coverage replaces the stale corridor cursor without duplicate work', async t => {
  const runtime = createPolicyRuntime({ horizon: false });
  const planner = createPlanner(runtime.policy);
  const pending = [];
  const requestedOwnerKeys = [];
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 1,
    requestOwner: request => {
      requestedOwnerKeys.push(request.ownerKey);
      let resolve;
      const handle = { request, resolve: null, cancelled: false };
      const promise = new Promise(nextResolve => {
        resolve = nextResolve;
        handle.resolve = resolve;
        pending.push(handle);
      });
      return {
        promise,
        cancel: () => {
          handle.cancelled = true;
          resolve(null);
          return true;
        },
      };
    },
  });
  const moving = planner({ velocity: { x: 32, z: 0 } });
  const stopped = planner({ velocity: { x: 0, z: 0 } });
  const stoppedAgain = planner({ velocity: { x: 0, z: 0 }, stateRevision: 1 });
  stream.applyPlan({ plan: moving, policyPlan: policyPlan(moving) });
  const movingSnapshot = stream.snapshot();
  stream.applyPlan({ plan: stopped, policyPlan: policyPlan(stopped) });
  const stoppedSnapshot = stream.snapshot();
  stream.applyPlan({ plan: stoppedAgain, policyPlan: policyPlan(stoppedAgain) });
  const stoppedAgainSnapshot = stream.snapshot();
  const stoppedRetained = new Set(policyPlan(stopped).allOwnerKeys);
  const staleQueuedOwnerKeys = stoppedAgainSnapshot.queuedOwnerKeys.filter(ownerKey => (
    !stoppedRetained.has(ownerKey)
  ));

  assert.equal(new Set(stoppedAgainSnapshot.queuedOwnerKeys).size,
    stoppedAgainSnapshot.queuedOwnerKeys.length);
  assert.equal(stoppedAgainSnapshot.counts.cancelled, 0,
    'never-materialized corridor work requires no cancellation');
  assert.equal(stoppedAgainSnapshot.counts.admissionCursorReplacements, 2);
  assert.ok(stoppedAgainSnapshot.admissionWindowCount <= 1);
  assert.ok(stoppedAgainSnapshot.pendingAdmissionCount
    <= policyPlan(stopped).requestOwnerKeys.length);
  assert.equal(staleQueuedOwnerKeys.length, 0);
  assert.equal(stoppedAgainSnapshot.planRevision, 3);
  assert.equal(stoppedAgainSnapshot.coverageGeneration, 2);

  let completedOutsideStoppedCoverage = 0;
  while (stream.snapshot().backlog > 0) {
    const next = pending.shift();
    if (next) {
      if (!next.cancelled && !stoppedRetained.has(next.request.ownerKey)) {
        completedOutsideStoppedCoverage += 1;
      }
      if (!next.cancelled) next.resolve(Object.freeze({ ownerKey: next.request.ownerKey }));
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  const drained = stream.snapshot();
  const movingAgain = planner({ velocity: { x: 32, z: 0 }, stateRevision: 2 });
  stream.applyPlan({ plan: movingAgain, policyPlan: policyPlan(movingAgain) });
  const reaccelerated = stream.snapshot();

  assert.equal(completedOutsideStoppedCoverage, 0);
  assert.equal(drained.counts.staleResultDiscards, 0);
  assert.equal(reaccelerated.readyPageQueueCount <= stoppedRetained.size, true);

  t.diagnostic(JSON.stringify({
    moving: {
      coverageGeneration: movingSnapshot.coverageGeneration,
      planRevision: movingSnapshot.planRevision,
      backlog: movingSnapshot.backlog,
      queued: movingSnapshot.queuedCount,
      inFlight: movingSnapshot.inFlightCount,
    },
    stopped: {
      coverageGeneration: stoppedSnapshot.coverageGeneration,
      planRevision: stoppedSnapshot.planRevision,
      backlog: stoppedSnapshot.backlog,
      staleQueuedOwnerCount: staleQueuedOwnerKeys.length,
      duplicateQueuedOwnerCount: stoppedAgainSnapshot.queuedOwnerKeys.length
        - new Set(stoppedAgainSnapshot.queuedOwnerKeys).size,
      unchangedPlanCount: stoppedAgainSnapshot.counts.unchangedPlans,
    },
    drained: {
      backlog: drained.backlog,
      requestedCount: drained.counts.requested,
      completedCount: drained.counts.completed,
      completedOutsideStoppedCoverage,
      readyOwnerCount: drained.readyOwnerCount,
    },
    reaccelerated: {
      coverageGeneration: reaccelerated.coverageGeneration,
      planRevision: reaccelerated.planRevision,
      backlog: reaccelerated.backlog,
      readyPageQueueCount: reaccelerated.readyPageQueueCount,
      readyHits: reaccelerated.counts.readyHits,
      pendingReuse: reaccelerated.counts.pendingReuse,
    },
    requestedOwnerCount: requestedOwnerKeys.length,
  }));
  await stream.dispose();
});

test('lifecycle invalidation releases queued presentation work for Gameplay relocation', async () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const plan = createPlanner(runtime.policy)({ velocity: { x: 32, z: 0 } });
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 1,
    requestOwner: () => {
      let resolve;
      const promise = new Promise(nextResolve => { resolve = nextResolve; });
      return { promise, cancel: () => { resolve(null); return true; } };
    },
  });
  stream.applyPlan({ plan, policyPlan: policyPlan(plan) });
  const cancelled = stream.invalidate('continue-relocation');
  await waitFor(() => stream.snapshot().backlog === 0, 'invalidated work did not settle');

  assert.ok(cancelled > 0);
  assert.equal(stream.snapshot().counts.invalidations, 1);
  assert.equal(stream.snapshot().counts.failed, 0);
});

test('state and Floating Origin revisions re-ticket without regenerating logical owners', async () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const plan = createPlanner(runtime.policy);
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    requestOwner: request => Promise.resolve(Object.freeze({ ownerKey: request.ownerKey })),
  });
  const first = plan({ stateRevision: 4, originGeneration: 7 });
  const rebased = plan({ stateRevision: 5, originGeneration: 8 });
  assert.deepEqual(policyPlan(first).requestOwnerKeys, policyPlan(rebased).requestOwnerKeys);
  assert.equal(stream.applyPlan({ plan: first, policyPlan: policyPlan(first) }), true);
  await waitFor(() => stream.snapshot().backlog === 0, 'initial plan did not settle');
  assert.equal(stream.applyPlan({ plan: rebased, policyPlan: policyPlan(rebased) }), false);
  await waitFor(() => stream.snapshot().backlog === 0, 'rebased plan did not settle');

  const ownerKey = policyPlan(rebased).requiredOwnerKeys[0];
  const [ticket] = stream.publishOwners({ ownerKeys: [ownerKey] });
  assert.equal(ticket.stateRevision, 5);
  assert.equal(ticket.originGeneration, 8);
  assert.equal(ticket.ownerKey, ownerKey);
  assert.equal(stream.snapshot().counts.unchangedPlans, 1);
  assert.equal(stream.snapshot().counts.cancelled, 0);
  await stream.dispose();
});

test('coverage generation is stable across plan revisions and does not regenerate tickets', async () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const plan = createPlanner(runtime.policy);
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    requestOwner: request => Promise.resolve(Object.freeze({ ownerKey: request.ownerKey })),
  });
  const first = plan({ stateRevision: 10, originGeneration: 3 });
  const revised = plan({ stateRevision: 11, originGeneration: 4 });
  stream.applyPlan({ plan: first, policyPlan: policyPlan(first) });
  await waitFor(() => stream.snapshot().backlog === 0, 'initial coverage did not settle');
  const ownerKey = policyPlan(first).requiredOwnerKeys[0];
  const before = stream.snapshot();
  const beforeTicket = before.tickets.find(ticket => ticket.ownerKey === ownerKey);

  assert.equal(stream.applyPlan({ plan: revised, policyPlan: policyPlan(revised) }), false);
  const after = stream.snapshot();
  const afterTicket = after.tickets.find(ticket => ticket.ownerKey === ownerKey);
  assert.equal(after.coverageGeneration, before.coverageGeneration);
  assert.equal(after.planRevision, before.planRevision + 1);
  assert.equal(afterTicket.ticketId, beforeTicket.ticketId);
  assert.equal(afterTicket.planId, revised.planId);
  assert.equal(afterTicket.stateRevision, 11);
  assert.equal(afterTicket.originGeneration, 4);
  await stream.dispose();
});

test('retained ready tickets adopt the replacement coverage generation', async () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const plan = createPlanner(runtime.policy);
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    requestOwner: request => Promise.resolve(Object.freeze({ ownerKey: request.ownerKey })),
  });
  const first = plan({ player: { x: 1, z: 1 } });
  const replacement = plan({ player: { x: 17, z: 1 } });
  stream.applyPlan({ plan: first, policyPlan: policyPlan(first) });
  await waitFor(() => stream.snapshot().backlog === 0, 'first coverage did not settle');
  const ownerKey = policyPlan(first).requiredOwnerKeys.find(key => (
    policyPlan(replacement).requiredOwnerKeys.includes(key)
  ));
  assert.ok(ownerKey);
  assert.equal(stream.applyPlan({
    plan: replacement,
    policyPlan: policyPlan(replacement),
  }), true);
  const snapshot = stream.snapshot();
  const ticket = snapshot.tickets.find(value => value.ownerKey === ownerKey);
  assert.equal(ticket.coverageGeneration, snapshot.coverageGeneration);
  const [published] = stream.publishOwners({ ownerKeys: [ownerKey] });
  assert.equal(published.coverageGeneration, snapshot.coverageGeneration);
  assert.equal(snapshot.counts.ticketRejects, 0);
  await stream.dispose();
});

test('ready owner pages drain incrementally without waiting for the full coverage set', async () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const plan = createPlanner(runtime.policy)({});
  const deferred = [];
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 2,
    requestOwner: request => {
      let resolve;
      const promise = new Promise(nextResolve => {
        resolve = nextResolve;
        deferred.push({ request, resolve });
      });
      return { promise, cancel: () => { resolve(null); return true; } };
    },
  });
  stream.applyPlan({ plan, policyPlan: policyPlan(plan) });
  await waitFor(() => deferred.length >= 2, 'owner requests did not start');
  const completed = deferred.shift();
  completed.resolve(Object.freeze({ ownerKey: completed.request.ownerKey }));
  await waitFor(
    () => stream.snapshot().readyPageQueueCount === 1,
    'completed owner was not exposed as a ready page',
  );

  const [page] = stream.drainReadyOwnerPages({ limit: 1 });
  assert.equal(page.ownerKey, completed.request.ownerKey);
  assert.equal(page.coverageGeneration, stream.snapshot().coverageGeneration);
  assert.equal(page.planRevision, stream.snapshot().planRevision);
  assert.ok(stream.snapshot().backlog > 0);
  assert.equal(stream.drainReadyOwnerPages({ limit: 1 }).length, 0);
  for (const pending of deferred) pending.resolve(Object.freeze({ ownerKey: pending.request.ownerKey }));
  await stream.dispose();
});

test('ready owner reuse does not allocate or enqueue the same publication page twice', async () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const plan = createPlanner(runtime.policy)({});
  const member = policyPlan(plan);
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    requestOwner: request => Promise.resolve(Object.freeze({ ownerKey: request.ownerKey })),
  });
  stream.applyPlan({ plan, policyPlan: member });
  await waitFor(() => stream.snapshot().backlog === 0, 'ready cache did not settle');
  const ownerKey = member.requiredOwnerKeys[0];
  const resourceKind = runtime.classifyOwner({ ownerKey, plan, policyPlan: member });
  const before = stream.snapshot();
  await stream.requestOrReuse({
    ownerKey,
    resourceKind,
    fallback: () => assert.fail('ready owner must not use fallback'),
  });
  await stream.requestOrReuse({
    ownerKey,
    resourceKind,
    fallback: () => assert.fail('ready owner must not use fallback'),
  });
  const after = stream.snapshot();
  assert.equal(after.readyPageQueueCount, before.readyPageQueueCount);
  assert.equal(after.counts.readyPageQueueCalls, before.counts.readyPageQueueCalls + 2);
  assert.equal(after.counts.readyPageQueueInsertions, before.counts.readyPageQueueInsertions);
  assert.equal(after.counts.readyPageQueueReuses, before.counts.readyPageQueueReuses + 2);
  await stream.dispose();
});

test('ready, ticket, Worker, and lazy admission bounds are explicit and enforced', () => {
  const runtime = createPolicyRuntime({ horizon: false });
  const plan = createPlanner(runtime.policy)({ velocity: { x: 32, z: 0 } });
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 1,
    queueCapacity: 2,
    readyCapacity: 2,
    ticketCapacity: 2,
    requestOwner: () => new Promise(() => {}),
  });

  assert.equal(stream.applyPlan({ plan, policyPlan: policyPlan(plan) }), true);
  const snapshot = stream.snapshot();
  assert.equal(snapshot.workerCount, 1);
  assert.equal(snapshot.queueCapacity, 2);
  assert.equal(snapshot.readyCacheCapacity, 2);
  assert.equal(snapshot.ticketCapacity, 2);
  assert.equal(snapshot.counts.queueOverflows, 0);
  assert.equal(snapshot.backlog, 1);
  assert.equal(snapshot.admissionWindowCount, 1);
  assert.equal(snapshot.admissionWindowCapacity, 1);
  assert.ok(snapshot.pendingAdmissionCount > 0);
  assert.equal(snapshot.ticketCount, 1);
  assert.equal(snapshot.coverageGeneration, 1);
});

test('a direction change reclaims superseded queued owners before capacity admission', async () => {
  const runtime = createPolicyRuntime();
  const makePlan = createPlanner(runtime.policy);
  const east = makePlan({ player: { x: 0, z: 0 }, velocity: { x: 32, z: 0 } });
  const west = makePlan({ player: { x: 0, z: 0 }, velocity: { x: -32, z: 0 } });
  const capacity = Math.max(
    policyPlan(east).requestOwnerKeys.length,
    policyPlan(west).requestOwnerKeys.length,
  ) + 1;
  const pending = [];
  const stream = createStaticObjectStream({
    policyKind: POLICY_KIND,
    classifyOwner: runtime.classifyOwner,
    maximumConcurrentRequests: 1,
    queueCapacity: capacity,
    requestOwner: request => {
      let resolve;
      const promise = new Promise(nextResolve => { resolve = nextResolve; });
      pending.push({ request, resolve });
      return { promise, cancel: () => { resolve(null); return true; } };
    },
  });

  assert.equal(stream.applyPlan({ plan: east, policyPlan: policyPlan(east) }), true);
  const before = stream.snapshot();
  assert.equal(before.inFlightCount, 1);
  assert.equal(before.queuedCount, 0);
  assert.ok(before.pendingAdmissionCount > 0);
  assert.equal(stream.applyPlan({ plan: west, policyPlan: policyPlan(west) }), true,
    'the replacement corridor must replace the lazy cursor without a capacity spike');
  const after = stream.snapshot();
  assert.equal(after.counts.queueOverflows, 0);
  assert.ok(after.admissionWindowCount <= 1);
  assert.ok(after.backlog <= 1);
  assert.ok(after.pendingAdmissionCount <= policyPlan(west).requestOwnerKeys.length);

  for (const operation of pending) operation.resolve(null);
  await stream.dispose();
});

test('the shared Static Object Stream contains no Tree-specific scheduling branch', async () => {
  const source = await readFile(
    new URL('../src/infinite-world/static-object-stream.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /natural-tree|TREE|tree/i);
});

test('the prepared Forest owner predicate preserves the canonical lattice at negative coordinates', () => {
  const worldSeedHash = 'static-stream-owner-lattice';
  const predicate = createW8ForestHorizonOwnerPredicate(worldSeedHash);
  for (let chunkZ = -8; chunkZ <= 8; chunkZ += 1) {
    for (let chunkX = -8; chunkX <= 8; chunkX += 1) {
      assert.equal(
        predicate({ chunkX, chunkZ }),
        isW8ForestHorizonOwner({ worldSeedHash, chunkX, chunkZ }),
      );
    }
  }
});
