import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createCircularStaticStreamingPolicy,
  createStaticObjectStream,
} from '../src/infinite-world/static-object-stream.js';
import { createWorldStreamingCoordinator } from '../src/infinite-world/world-streaming-coordinator.js';
import { createWorldStreamingPolicyRegistry } from '../src/infinite-world/world-streaming-policy-registry.js';
import {
  createW8ForestHorizonOwnerPredicate,
  isW8ForestHorizonOwner,
} from '../src/infinite-world/forest-horizon-owner-policy.js';

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
  assert.equal(stream.snapshot().counts.readyHits > 0, true);
  assert.equal(stream.drainReadyOwnerPages({ limit: 32 })
    .some(page => page.ownerKey === staleOwner), true);
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

test('stable stopped coverage cancels stale corridor backlog without duplicate requeue', async t => {
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
  assert.equal(stoppedAgainSnapshot.counts.cancelled > 0, true);
  assert.equal(stoppedAgainSnapshot.counts.stalePlanCancels > 0, true);
  assert.equal(stoppedAgainSnapshot.counts.stableCoverageCancels > 0, true);
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

test('ready, queue, ticket, and Worker bounds are explicit and enforced', () => {
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

  assert.throws(
    () => stream.applyPlan({ plan, policyPlan: policyPlan(plan) }),
    /queue capacity exceeded/,
  );
  const snapshot = stream.snapshot();
  assert.equal(snapshot.workerCount, 1);
  assert.equal(snapshot.queueCapacity, 2);
  assert.equal(snapshot.readyCacheCapacity, 2);
  assert.equal(snapshot.ticketCapacity, 2);
  assert.equal(snapshot.counts.queueOverflows, 1);
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
