import {
  LOGICAL_CHUNK_SIZE_METERS,
  createChunkKey,
  logicalWorldToOwnedChunk,
  parseChunkKey,
} from './chunk-coordinates.js';
import {
  WORLD_STREAMING_POLICY_SCHEMA,
  WORLD_STREAMING_POLICY_STREAM,
} from './world-streaming-policy-registry.js';

export const STATIC_OBJECT_STREAM_SCHEMA = 'static-object-stream-1';
export const WORLD_PUBLICATION_TICKET_SCHEMA = 'world-publication-ticket-1';

export const STATIC_OBJECT_STREAM_VELOCITY_PREFETCH = Object.freeze({
  enabled: true,
  leadSeconds: 5,
  maximumDistanceMeters: 192,
  sampleIntervalSeconds: 0.25,
});

const defaultClock = () => globalThis.performance?.now?.() ?? Date.now();
export function staticChunkAabbIntersectsCircle(
  chunkX,
  chunkZ,
  centerX,
  centerZ,
  radiusMeters,
) {
  const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const maximumX = minimumX + LOGICAL_CHUNK_SIZE_METERS;
  const maximumZ = minimumZ + LOGICAL_CHUNK_SIZE_METERS;
  const closestX = Math.max(minimumX, Math.min(maximumX, centerX));
  const closestZ = Math.max(minimumZ, Math.min(maximumZ, centerZ));
  return Math.hypot(closestX - centerX, closestZ - centerZ) <= radiusMeters;
}

function collectCircularOwners({
  centerX,
  centerZ,
  exactRadiusMeters,
  horizonRadiusMeters,
  horizonOwnerPredicate,
}) {
  const result = new Set();
  const radius = Math.max(exactRadiusMeters, horizonRadiusMeters ?? exactRadiusMeters);
  const minimumChunkX = Math.floor((centerX - radius) / LOGICAL_CHUNK_SIZE_METERS);
  const maximumChunkX = Math.floor((centerX + radius) / LOGICAL_CHUNK_SIZE_METERS);
  const minimumChunkZ = Math.floor((centerZ - radius) / LOGICAL_CHUNK_SIZE_METERS);
  const maximumChunkZ = Math.floor((centerZ + radius) / LOGICAL_CHUNK_SIZE_METERS);
  for (let chunkZ = minimumChunkZ; chunkZ <= maximumChunkZ; chunkZ += 1) {
    for (let chunkX = minimumChunkX; chunkX <= maximumChunkX; chunkX += 1) {
      const exact = staticChunkAabbIntersectsCircle(
        chunkX, chunkZ, centerX, centerZ, exactRadiusMeters,
      );
      const horizon = !exact && horizonRadiusMeters !== null
        && horizonOwnerPredicate({ chunkX, chunkZ })
        && staticChunkAabbIntersectsCircle(
          chunkX, chunkZ, centerX, centerZ, horizonRadiusMeters,
        );
      if (exact || horizon) result.add(createChunkKey(chunkX, chunkZ));
    }
  }
  return result;
}

function segmentIntersectsExpandedChunkAabb(
  chunkX,
  chunkZ,
  start,
  end,
  radiusMeters,
) {
  const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS - radiusMeters;
  const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS - radiusMeters;
  const maximumX = (chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS + radiusMeters;
  const maximumZ = (chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS + radiusMeters;
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  let minimumT = 0;
  let maximumT = 1;
  for (const [origin, delta, minimum, maximum] of [
    [start.x, dx, minimumX, maximumX],
    [start.z, dz, minimumZ, maximumZ],
  ]) {
    if (delta === 0) {
      if (origin < minimum || origin > maximum) return false;
      continue;
    }
    const first = (minimum - origin) / delta;
    const second = (maximum - origin) / delta;
    minimumT = Math.max(minimumT, Math.min(first, second));
    maximumT = Math.min(maximumT, Math.max(first, second));
    if (minimumT > maximumT) return false;
  }
  return true;
}

function collectCorridorOwners({
  start,
  end,
  exactRadiusMeters,
  horizonRadiusMeters,
  horizonOwnerPredicate,
}) {
  const result = new Set();
  const radius = Math.max(exactRadiusMeters, horizonRadiusMeters ?? exactRadiusMeters);
  const minimumChunkX = Math.floor((Math.min(start.x, end.x) - radius) / LOGICAL_CHUNK_SIZE_METERS);
  const maximumChunkX = Math.floor((Math.max(start.x, end.x) + radius) / LOGICAL_CHUNK_SIZE_METERS);
  const minimumChunkZ = Math.floor((Math.min(start.z, end.z) - radius) / LOGICAL_CHUNK_SIZE_METERS);
  const maximumChunkZ = Math.floor((Math.max(start.z, end.z) + radius) / LOGICAL_CHUNK_SIZE_METERS);
  for (let chunkZ = minimumChunkZ; chunkZ <= maximumChunkZ; chunkZ += 1) {
    for (let chunkX = minimumChunkX; chunkX <= maximumChunkX; chunkX += 1) {
      const exact = segmentIntersectsExpandedChunkAabb(
        chunkX, chunkZ, start, end, exactRadiusMeters,
      );
      const horizon = !exact && horizonRadiusMeters !== null
        && horizonOwnerPredicate({ chunkX, chunkZ })
        && segmentIntersectsExpandedChunkAabb(
          chunkX, chunkZ, start, end, horizonRadiusMeters,
        );
      if (exact || horizon) result.add(createChunkKey(chunkX, chunkZ));
    }
  }
  return result;
}

function sorted(values) {
  return Object.freeze([...new Set(values)].sort((left, right) => {
    const a = parseChunkKey(left);
    const b = parseChunkKey(right);
    return a.chunkZ - b.chunkZ || a.chunkX - b.chunkX;
  }));
}

export function createCircularStaticStreamingPolicy({
  kind,
  publicationGroup,
  distanceProfileResolver,
  horizonOwnerPredicate = () => false,
  maximumRequiredDistanceMeters,
  retentionMarginMeters = 32,
  velocityPrefetch = STATIC_OBJECT_STREAM_VELOCITY_PREFETCH,
  generatorKind = 'canonical-chunk',
  exactResourceKind = 'canonical',
  horizonResourceKind = 'manifest',
} = {}) {
  if (typeof kind !== 'string' || !kind) throw new TypeError('static policy kind is required');
  if (typeof publicationGroup !== 'string' || !publicationGroup) {
    throw new TypeError('static publicationGroup is required');
  }
  if (typeof distanceProfileResolver !== 'function') {
    throw new TypeError('distanceProfileResolver is required');
  }
  if (typeof horizonOwnerPredicate !== 'function') {
    throw new TypeError('horizonOwnerPredicate must be a function');
  }
  if (!Number.isFinite(maximumRequiredDistanceMeters)
    || maximumRequiredDistanceMeters <= 0) {
    throw new RangeError('maximumRequiredDistanceMeters must be positive');
  }
  const requiredRadiusChunks = Math.ceil(
    maximumRequiredDistanceMeters / LOGICAL_CHUNK_SIZE_METERS,
  );
  const retainedRadiusChunks = Math.ceil(
    (maximumRequiredDistanceMeters + retentionMarginMeters) / LOGICAL_CHUNK_SIZE_METERS,
  );

  const coverageFor = (center, renderDistancePreset, marginMeters = 0) => {
    const profile = distanceProfileResolver(renderDistancePreset);
    return collectCircularOwners({
      centerX: center.x,
      centerZ: center.z,
      exactRadiusMeters: profile.exactDistanceMeters + marginMeters,
      horizonRadiusMeters: profile.horizonDistanceMeters === null
        ? null : profile.horizonDistanceMeters + marginMeters,
      horizonOwnerPredicate,
    });
  };
  const coverageCache = new Map();
  const ownerResolver = ({ player, velocityCorridor, renderDistancePreset }) => {
    const playerOwner = logicalWorldToOwnedChunk(player.x, player.z);
    const endpointOwner = logicalWorldToOwnedChunk(
      velocityCorridor.endpoint.x,
      velocityCorridor.endpoint.z,
    );
    const coverageKey = `${renderDistancePreset}:${playerOwner.key}:${endpointOwner.key}`;
    const cached = coverageCache.get(coverageKey);
    if (cached) {
      coverageCache.delete(coverageKey);
      coverageCache.set(coverageKey, cached);
      return cached;
    }
    const required = coverageFor(player, renderDistancePreset);
    const profile = distanceProfileResolver(renderDistancePreset);
    const prefetched = collectCorridorOwners({
      start: player,
      end: velocityCorridor.endpoint,
      exactRadiusMeters: profile.exactDistanceMeters,
      horizonRadiusMeters: profile.horizonDistanceMeters,
      horizonOwnerPredicate,
    });
    for (const ownerKey of required) prefetched.delete(ownerKey);
    const retained = coverageFor(player, renderDistancePreset, retentionMarginMeters);
    for (const ownerKey of required) retained.add(ownerKey);
    for (const ownerKey of prefetched) retained.add(ownerKey);
    const resolved = Object.freeze({
      required: sorted(required),
      prefetched: sorted(prefetched),
      retained: sorted(retained),
    });
    coverageCache.set(coverageKey, resolved);
    while (coverageCache.size > 64) coverageCache.delete(coverageCache.keys().next().value);
    return resolved;
  };
  const policy = Object.freeze({
    schemaVersion: WORLD_STREAMING_POLICY_SCHEMA,
    kind,
    stream: WORLD_STREAMING_POLICY_STREAM.STATIC,
    distanceBands: Object.freeze({
      required: Object.freeze({ radiusChunks: requiredRadiusChunks, deadlineSeconds: 0 }),
      prefetched: Object.freeze({ radiusChunks: requiredRadiusChunks, deadlineSeconds: 4.5 }),
      retained: Object.freeze({ radiusChunks: retainedRadiusChunks, deadlineSeconds: null }),
    }),
    velocityPrefetch,
    ownerResolver,
    generatorKind,
    cachePolicy: Object.freeze({ kind: 'static-owner-ready-lru', maximumEntries: 2048 }),
    publicationGroup,
    publicationDependencies: Object.freeze([]),
    visibilityPolicy: Object.freeze({ kind: 'existing-object-visibility' }),
    persistencePolicy: Object.freeze({ kind: 'canonical-gameplay-only' }),
    criticality: 'presentation-required',
  });

  const classifyOwner = ({ ownerKey, plan, policyPlan }) => {
    const owner = parseChunkKey(ownerKey);
    const profile = distanceProfileResolver(plan.renderDistancePreset);
    const exact = segmentIntersectsExpandedChunkAabb(
      owner.chunkX,
      owner.chunkZ,
      plan.player,
      policyPlan.velocityCorridor.endpoint,
      profile.exactDistanceMeters,
    );
    return exact ? exactResourceKind : horizonResourceKind;
  };
  return Object.freeze({ policy, classifyOwner });
}

function coverageSignature(plan, policyPlan) {
  return JSON.stringify({
    renderDistancePreset: plan.renderDistancePreset,
    required: policyPlan.requiredOwnerKeys,
    prefetched: policyPlan.prefetchedOwnerKeys,
    retained: policyPlan.retainedOwnerKeys,
  });
}

export function createStaticObjectStream({
  policyKind,
  classifyOwner,
  requestOwner,
  cancelRequests = null,
  clock = defaultClock,
  maximumConcurrentRequests = 4,
  requiredPriority = 3,
  prefetchedPriority = 5,
  queueCapacity = 2048,
  readyCapacity = 2048,
  ticketCapacity = 4096,
} = {}) {
  if (typeof policyKind !== 'string' || !policyKind) throw new TypeError('policyKind is required');
  if (typeof classifyOwner !== 'function') throw new TypeError('classifyOwner is required');
  if (typeof requestOwner !== 'function') throw new TypeError('requestOwner is required');
  if (cancelRequests !== null && typeof cancelRequests !== 'function') {
    throw new TypeError('cancelRequests must be a function');
  }
  if (typeof clock !== 'function') throw new TypeError('Static Object Stream clock is required');
  if (!Number.isSafeInteger(maximumConcurrentRequests) || maximumConcurrentRequests < 1) {
    throw new RangeError('maximumConcurrentRequests must be a positive safe integer');
  }
  if (!Number.isSafeInteger(requiredPriority) || requiredPriority < 1
    || !Number.isSafeInteger(prefetchedPriority) || prefetchedPriority < requiredPriority) {
    throw new RangeError('Static Object Stream priorities must be ordered positive integers');
  }
  if (!Number.isSafeInteger(queueCapacity) || queueCapacity < maximumConcurrentRequests) {
    throw new RangeError('queueCapacity must cover maximumConcurrentRequests');
  }

  const ready = new Map();
  const tasks = new Map();
  const queue = [];
  const tickets = new Map();
  let activeCount = 0;
  let epoch = 0;
  let latestPlan = null;
  let latestPolicyPlan = null;
  let latestCoverageSignature = null;
  let disposed = false;
  const counts = {
    plans: 0,
    unchangedPlans: 0,
    requested: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    readyHits: 0,
    pendingReuse: 0,
    queuedPromotions: 0,
    stalePlanCancels: 0,
    ticketsCreated: 0,
    ticketsPublished: 0,
    ticketRejects: 0,
    readyEvictions: 0,
    maximumBacklog: 0,
    queueOverflows: 0,
    invalidations: 0,
  };

  const taskKey = (ownerKey, resourceKind) => `${resourceKind}\n${ownerKey}`;
  const touchReady = key => {
    const value = ready.get(key);
    if (!value) return null;
    ready.delete(key);
    ready.set(key, value);
    return value;
  };
  const trimReady = () => {
    while (ready.size > readyCapacity) {
      ready.delete(ready.keys().next().value);
      counts.readyEvictions += 1;
    }
  };
  const trimTickets = () => {
    while (tickets.size > ticketCapacity) tickets.delete(tickets.keys().next().value);
  };
  const createTicket = (ownerKey, resourceKind) => {
    if (!latestPlan || !latestPolicyPlan) return null;
    const key = `${latestPlan.planId}\n${resourceKind}\n${ownerKey}`;
    let ticket = tickets.get(key);
    if (ticket) return ticket;
    const resource = ready.get(taskKey(ownerKey, resourceKind));
    ticket = {
      schemaVersion: WORLD_PUBLICATION_TICKET_SCHEMA,
      ticketId: `${latestPlan.planId}:${policyKind}:${resourceKind}:${ownerKey}`,
      planId: latestPlan.planId,
      policyKind,
      publicationGroup: latestPolicyPlan.publicationGroup,
      stateRevision: latestPlan.stateRevision,
      originGeneration: latestPlan.originGeneration,
      ownerKey,
      resourceKind,
      createdAtMs: clock(),
      readyAtMs: resource?.readyAtMs ?? null,
      publishedAtMs: null,
      state: resource ? 'ready' : 'waiting',
    };
    tickets.set(key, ticket);
    counts.ticketsCreated += 1;
    trimTickets();
    return ticket;
  };
  const markTicketsReady = (ownerKey, resourceKind, readyAtMs) => {
    for (const ticket of tickets.values()) {
      if (ticket.ownerKey !== ownerKey || ticket.resourceKind !== resourceKind
        || ticket.state !== 'waiting') continue;
      ticket.readyAtMs = readyAtMs;
      ticket.state = 'ready';
    }
  };
  const settleTask = (task, state, value = null, error = null) => {
    if (disposed && state === 'ready') state = 'cancelled';
    task.state = state;
    tasks.delete(task.key);
    if (state === 'ready') {
      const readyAtMs = clock();
      ready.set(task.key, Object.freeze({
        ownerKey: task.ownerKey,
        resourceKind: task.resourceKind,
        value,
        readyAtMs,
        sourcePlanId: task.planId,
      }));
      trimReady();
      markTicketsReady(task.ownerKey, task.resourceKind, readyAtMs);
      counts.completed += 1;
      task.resolve(value);
    } else if (state === 'cancelled') {
      counts.cancelled += 1;
      task.resolve(null);
    } else {
      counts.failed += 1;
      task.reject(error);
    }
  };
  const pump = () => {
    if (disposed) return;
    while (activeCount < maximumConcurrentRequests && queue.length) {
      const task = queue.shift();
      if (task.state !== 'queued') continue;
      task.state = 'in-flight';
      activeCount += 1;
      counts.requested += 1;
      let handle;
      try {
        handle = requestOwner(Object.freeze({
          ownerKey: task.ownerKey,
          resourceKind: task.resourceKind,
          priority: task.required ? requiredPriority : prefetchedPriority,
          required: task.required,
          deadlineAtMs: task.deadlineAtMs,
          epoch: task.epoch,
          planId: task.planId,
          publicationGroup: task.publicationGroup,
        }));
        task.cancel = typeof handle?.cancel === 'function' ? handle.cancel : null;
      } catch (error) {
        activeCount -= 1;
        settleTask(task, 'failed', null, error);
        continue;
      }
      Promise.resolve(handle?.promise ?? handle).then(value => {
        settleTask(task, value === null ? 'cancelled' : 'ready', value);
      }, error => settleTask(task, 'failed', null, error)).finally(() => {
        activeCount -= 1;
        pump();
      });
    }
    counts.maximumBacklog = Math.max(counts.maximumBacklog, queue.length + activeCount);
  };
  const enqueue = ({
    ownerKey,
    resourceKind,
    required,
    deadlineAtMs,
    planId,
    publicationGroup,
    pumpNow = true,
  }) => {
    const key = taskKey(ownerKey, resourceKind);
    const existingReady = touchReady(key);
    if (existingReady) {
      counts.readyHits += 1;
      createTicket(ownerKey, resourceKind);
      return Object.freeze({ promise: Promise.resolve(existingReady.value), cancel: () => false });
    }
    const existing = tasks.get(key);
    if (existing) {
      counts.pendingReuse += 1;
      if (required && !existing.required) {
        existing.required = true;
        existing.deadlineAtMs = deadlineAtMs;
        const index = queue.indexOf(existing);
        if (index > 0) {
          queue.splice(index, 1);
          queue.unshift(existing);
        }
        counts.queuedPromotions += 1;
        pump();
      }
      createTicket(ownerKey, resourceKind);
      return Object.freeze({ promise: existing.promise, cancel: () => false });
    }
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    // Plan application is intentionally fire-and-forget. Keep adapter failures
    // observable through counters without creating an unhandled rejection.
    void promise.catch(() => {});
    const task = {
      key,
      ownerKey,
      resourceKind,
      required,
      deadlineAtMs,
      planId,
      publicationGroup,
      epoch,
      state: 'queued',
      promise,
      resolve,
      reject,
      cancel: null,
      stalePlanCount: 0,
    };
    if (tasks.size >= queueCapacity) {
      counts.queueOverflows += 1;
      throw new RangeError(`Static Object Stream queue capacity exceeded: ${queueCapacity}`);
    }
    tasks.set(key, task);
    queue.push(task);
    createTicket(ownerKey, resourceKind);
    if (pumpNow) pump();
    return Object.freeze({
      promise,
      cancel: reason => {
        if (task.state === 'queued') {
          const index = queue.indexOf(task);
          if (index >= 0) queue.splice(index, 1);
          settleTask(task, 'cancelled');
          return true;
        }
        return task.cancel?.(reason) ?? false;
      },
    });
  };

  const applyPlan = ({ plan, policyPlan } = {}) => {
    if (disposed) return false;
    if (plan?.schemaVersion !== 'world-streaming-plan-1' || policyPlan?.kind !== policyKind) {
      throw new TypeError(`Static Object Stream requires ${policyKind} plan coverage`);
    }
    const nextSignature = coverageSignature(plan, policyPlan);
    if (nextSignature === latestCoverageSignature) {
      latestPlan = plan;
      latestPolicyPlan = policyPlan;
      // Readiness belongs to canonical owners, while tickets belong to the
      // latest publication revision. Re-ticket lazily at publication without
      // cancelling or regenerating unchanged owner coverage.
      tickets.clear();
      counts.unchangedPlans += 1;
      return false;
    }
    epoch += 1;
    latestPlan = plan;
    latestPolicyPlan = policyPlan;
    latestCoverageSignature = nextSignature;
    counts.plans += 1;
    const retained = new Set(policyPlan.allOwnerKeys);
    for (const task of [...tasks.values()]) {
      if (retained.has(task.ownerKey)) {
        task.stalePlanCount = 0;
        continue;
      }
      task.stalePlanCount += 1;
      // One changed-plan grace avoids cancelling useful corridor work during
      // an instantaneous stop/start sample or a one-frame direction jitter.
      if (task.stalePlanCount < 2) continue;
      if (task.state === 'queued') {
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
        settleTask(task, 'cancelled');
      } else task.cancel?.('superseded-static-plan');
      counts.stalePlanCancels += 1;
    }
    tickets.clear();
    const required = new Set(policyPlan.requiredOwnerKeys);
    const requestedOwnerKeys = [
      ...policyPlan.requiredOwnerKeys,
      ...policyPlan.prefetchedOwnerKeys,
    ];
    const requested = requestedOwnerKeys.map(ownerKey => ({
      ownerKey,
      resourceKind: classifyOwner({ ownerKey, plan, policyPlan }),
      required: required.has(ownerKey),
      deadlineAtMs: required.has(ownerKey)
        ? policyPlan.deadline.requiredAtMs : policyPlan.deadline.prefetchedAtMs,
      planId: plan.planId,
      publicationGroup: policyPlan.publicationGroup,
    }));
    for (const descriptor of requested) enqueue({ ...descriptor, pumpNow: false });
    pump();
    return true;
  };

  const requestOrReuse = ({ ownerKey, resourceKind, fallback }) => {
    if (typeof fallback !== 'function') throw new TypeError('fallback is required');
    const key = taskKey(ownerKey, resourceKind);
    const existingReady = touchReady(key);
    if (existingReady) {
      counts.readyHits += 1;
      createTicket(ownerKey, resourceKind);
      return Promise.resolve(existingReady.value);
    }
    const existing = tasks.get(key);
    if (existing) {
      counts.pendingReuse += 1;
      createTicket(ownerKey, resourceKind);
      return existing.promise.then(value => value ?? fallback());
    }
    if (!latestPlan || !latestPolicyPlan) return fallback();
    return enqueue({
      ownerKey,
      resourceKind,
      required: true,
      deadlineAtMs: latestPolicyPlan.deadline.requiredAtMs,
      planId: latestPlan.planId,
      publicationGroup: latestPolicyPlan.publicationGroup,
    }).promise;
  };

  const publishOwners = ({
    ownerKeys,
    stateRevision = latestPlan?.stateRevision,
    originGeneration = latestPlan?.originGeneration,
  } = {}) => {
    if (!Array.isArray(ownerKeys) || !latestPlan) return Object.freeze([]);
    const published = [];
    const ownerSet = new Set(ownerKeys);
    for (const ownerKey of ownerSet) {
      createTicket(ownerKey, classifyOwner({
        ownerKey,
        plan: latestPlan,
        policyPlan: latestPolicyPlan,
      }));
    }
    for (const ticket of tickets.values()) {
      if (!ownerSet.has(ticket.ownerKey) || ticket.state !== 'ready') continue;
      if (ticket.planId !== latestPlan.planId
        || ticket.stateRevision !== stateRevision
        || ticket.originGeneration !== originGeneration) {
        counts.ticketRejects += 1;
        continue;
      }
      ticket.state = 'published';
      ticket.publishedAtMs = clock();
      counts.ticketsPublished += 1;
      published.push(Object.freeze({ ...ticket }));
    }
    return Object.freeze(published);
  };

  const snapshot = () => {
    const required = new Set(latestPolicyPlan?.requiredOwnerKeys ?? []);
    const prefetched = new Set(latestPolicyPlan?.prefetchedOwnerKeys ?? []);
    const ownerReady = ownerKey => ready.has(taskKey(
      ownerKey,
      classifyOwner({ ownerKey, plan: latestPlan, policyPlan: latestPolicyPlan }),
    ));
    const readyOwnerKeys = new Set([
      ...required,
      ...prefetched,
    ].filter(ownerReady));
    return Object.freeze({
      schemaVersion: STATIC_OBJECT_STREAM_SCHEMA,
      policyKind,
      workerCount: 1,
      epoch,
      latestPlanId: latestPlan?.planId ?? null,
      publicationGroup: latestPolicyPlan?.publicationGroup ?? null,
      requiredOwnerCount: required.size,
      prefetchedOwnerCount: prefetched.size,
      retainedOwnerCount: latestPolicyPlan?.retainedOwnerKeys.length ?? 0,
      readyOwnerCount: readyOwnerKeys.size,
      missingRequiredOwnerKeys: Object.freeze(
        [...required].filter(ownerKey => !ownerReady(ownerKey)).sort(),
      ),
      missingPrefetchedOwnerKeys: Object.freeze(
        [...prefetched].filter(ownerKey => !ownerReady(ownerKey)).sort(),
      ),
      queuedCount: queue.length,
      inFlightCount: activeCount,
      backlog: queue.length + activeCount,
      queueCapacity,
      readyCacheSize: ready.size,
      readyCacheCapacity: readyCapacity,
      ticketCount: tickets.size,
      ticketCapacity,
      tickets: Object.freeze([...tickets.values()].map(ticket => Object.freeze({ ...ticket }))),
      counts: Object.freeze({ ...counts }),
      disposed,
    });
  };
  const diagnostics = () => {
    const requiredOwnerKeys = latestPolicyPlan?.requiredOwnerKeys ?? [];
    const prefetchedOwnerKeys = latestPolicyPlan?.prefetchedOwnerKeys ?? [];
    const isReady = ownerKey => ready.has(taskKey(
      ownerKey,
      classifyOwner({ ownerKey, plan: latestPlan, policyPlan: latestPolicyPlan }),
    ));
    let readyRequiredOwnerCount = 0;
    let readyPrefetchedOwnerCount = 0;
    if (latestPlan) {
      for (const ownerKey of requiredOwnerKeys) readyRequiredOwnerCount += Number(isReady(ownerKey));
      for (const ownerKey of prefetchedOwnerKeys) {
        readyPrefetchedOwnerCount += Number(isReady(ownerKey));
      }
    }
    return Object.freeze({
      policyKind,
      workerCount: 1,
      latestPlanId: latestPlan?.planId ?? null,
      requiredOwnerCount: requiredOwnerKeys.length,
      readyRequiredOwnerCount,
      missingRequiredOwnerCount: requiredOwnerKeys.length - readyRequiredOwnerCount,
      prefetchedOwnerCount: prefetchedOwnerKeys.length,
      readyPrefetchedOwnerCount,
      backlog: queue.length + activeCount,
      ticketCount: tickets.size,
      publishedTicketCount: counts.ticketsPublished,
      requestedCount: counts.requested,
      readyHitCount: counts.readyHits,
      pendingReuseCount: counts.pendingReuse,
      cancelledCount: counts.cancelled,
      failedCount: counts.failed,
      invalidationCount: counts.invalidations,
    });
  };
  const invalidate = (reason = 'static-stream-invalidated') => {
    if (disposed) return 0;
    epoch += 1;
    latestCoverageSignature = null;
    tickets.clear();
    ready.clear();
    counts.invalidations += 1;
    let cancelled = 0;
    for (const task of [...tasks.values()]) {
      if (task.state === 'queued') {
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
        settleTask(task, 'cancelled');
        cancelled += 1;
      } else if (task.cancel?.(reason)) cancelled += 1;
    }
    return cancelled;
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    cancelRequests?.({ beforeEpoch: Number.MAX_SAFE_INTEGER, reason: 'static-stream-dispose' });
    const pendingPromises = [...tasks.values()].map(task => task.promise);
    for (const task of [...tasks.values()]) {
      if (task.state === 'queued') settleTask(task, 'cancelled');
      else task.cancel?.('static-stream-dispose');
    }
    // Transport shutdown remains authoritative for any adapter that cannot
    // acknowledge cooperative cancellation synchronously. Stream disposal
    // itself must never hold application shutdown open on external work.
    void Promise.allSettled(pendingPromises);
    queue.length = 0;
    tasks.clear();
    ready.clear();
    tickets.clear();
  };
  return Object.freeze({
    applyPlan,
    requestOrReuse,
    publishOwners,
    invalidate,
    diagnostics,
    snapshot,
    dispose,
  });
}
