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
import { WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA } from './natural-streaming-coverage.js';

export const STATIC_OBJECT_STREAM_SCHEMA = 'static-object-stream-1';
export const WORLD_PUBLICATION_TICKET_SCHEMA = 'world-publication-ticket-1';

export const STATIC_OBJECT_STREAM_VELOCITY_PREFETCH = Object.freeze({
  enabled: true,
  leadSeconds: 5,
  maximumDistanceMeters: 192,
  sampleIntervalSeconds: 0.25,
});

function maximumCorridorOwnerCount(radiusMeters, corridorLengthMeters) {
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0
    || !Number.isFinite(corridorLengthMeters) || corridorLengthMeters < 0) {
    throw new RangeError('Static coverage capacity requires finite non-negative distances');
  }
  const columns = Math.ceil(
    (corridorLengthMeters + radiusMeters * 2) / LOGICAL_CHUNK_SIZE_METERS,
  ) + 1;
  const rows = Math.ceil(
    radiusMeters * 2 / LOGICAL_CHUNK_SIZE_METERS,
  ) + 1;
  return Object.freeze({ columns, rows, ownerCount: columns * rows });
}

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

function sorted(values, ownerMetadataCache = null, path = 'static-owner-sort') {
  const localCoordinates = new Map();
  const coordinateFor = ownerKey => {
    let coordinate = localCoordinates.get(ownerKey);
    if (coordinate) return coordinate;
    coordinate = ownerMetadataCache?.parse(ownerKey, { path }) ?? parseChunkKey(ownerKey);
    localCoordinates.set(ownerKey, coordinate);
    return coordinate;
  };
  return Object.freeze([...new Set(values)].sort((left, right) => {
    const a = coordinateFor(left);
    const b = coordinateFor(right);
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
  horizonOwnerDensity = 1,
  ownerMetadataCache = null,
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
  if (!Number.isSafeInteger(horizonOwnerDensity) || horizonOwnerDensity < 1) {
    throw new RangeError('horizonOwnerDensity must be a positive safe integer');
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
      required: sorted(required, ownerMetadataCache, `${kind}:required-sort`),
      prefetched: sorted(prefetched, ownerMetadataCache, `${kind}:prefetched-sort`),
      retained: sorted(retained, ownerMetadataCache, `${kind}:retained-sort`),
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

  const classifyOwner = ({ ownerKey, owner = null, plan, policyPlan }) => {
    const coordinate = owner
      ?? ownerMetadataCache?.parse(ownerKey, { path: `${kind}:classify` })
      ?? parseChunkKey(ownerKey);
    const profile = distanceProfileResolver(plan.renderDistancePreset);
    const exact = segmentIntersectsExpandedChunkAabb(
      coordinate.chunkX,
      coordinate.chunkZ,
      plan.player,
      policyPlan.velocityCorridor.endpoint,
      profile.exactDistanceMeters,
    );
    return exact ? exactResourceKind : horizonResourceKind;
  };
  const maximumCoverage = renderDistancePreset => {
    const profile = distanceProfileResolver(renderDistancePreset);
    const corridorLengthMeters = velocityPrefetch.enabled
      ? velocityPrefetch.maximumDistanceMeters : 0;
    const canonical = maximumCorridorOwnerCount(
      profile.exactDistanceMeters,
      corridorLengthMeters,
    );
    const horizon = profile.horizonDistanceMeters === null
      ? Object.freeze({ columns: 0, rows: 0, ownerCount: 0 })
      : maximumCorridorOwnerCount(profile.horizonDistanceMeters, corridorLengthMeters);
    // The horizon predicate is a world-fixed lattice. One boundary row/column
    // is retained in the bound so every player alignment remains covered.
    const maximumManifestOwnerCount = horizon.ownerCount === 0 ? 0 : Math.min(
      horizon.ownerCount,
      Math.ceil(horizon.ownerCount / horizonOwnerDensity)
        + Math.max(horizon.columns, horizon.rows),
    );
    return Object.freeze({
      schemaVersion: 'static-policy-capacity-1',
      maximumCanonicalOwnerCount: canonical.ownerCount,
      maximumManifestOwnerCount,
    });
  };
  return Object.freeze({ policy, classifyOwner, maximumCoverage });
}

function coverageSignature(plan, policyPlan, resourceKinds, ownerMetadataCache = null) {
  ownerMetadataCache?.recordSignature('static-object-stream:coverage-signature');
  return JSON.stringify({
    renderDistancePreset: plan.renderDistancePreset,
    required: policyPlan.requiredOwnerKeys,
    prefetched: policyPlan.prefetchedOwnerKeys,
    retained: policyPlan.retainedOwnerKeys,
    resourceKinds,
  });
}

function mergePolicyPlanCoverage(
  policyKind,
  policyKinds,
  policyPlans,
  ownerMetadataCache = null,
) {
  if (!Array.isArray(policyPlans) || policyPlans.length !== policyKinds.length) {
    throw new TypeError('Static Object Stream requires one plan coverage per policy kind');
  }
  const plansByKind = new Map(policyPlans.map(value => [value?.kind, value]));
  const ordered = policyKinds.map(kind => {
    const value = plansByKind.get(kind);
    if (!value) throw new TypeError(`Static Object Stream requires ${kind} plan coverage`);
    return value;
  });
  const publicationGroups = new Set(ordered.map(value => value.publicationGroup));
  if (publicationGroups.size !== 1) {
    throw new Error('Static Object Stream policy group must share one publicationGroup');
  }
  const union = field => sorted(
    ordered.flatMap(value => value[field]),
    ownerMetadataCache,
    `static-object-stream:merge:${field}`,
  );
  const finiteDeadline = field => {
    const values = ordered.map(value => value.deadline[field]).filter(Number.isFinite);
    return values.length ? Math.min(...values) : null;
  };
  const requiredOwnerKeys = union('requiredOwnerKeys');
  const prefetchedOwnerKeys = union('prefetchedOwnerKeys')
    .filter(ownerKey => !requiredOwnerKeys.includes(ownerKey));
  const retainedOwnerKeys = union('retainedOwnerKeys');
  const requestOwnerKeys = sorted(
    [...requiredOwnerKeys, ...prefetchedOwnerKeys],
    ownerMetadataCache,
    'static-object-stream:merge:requestOwnerKeys',
  );
  return Object.freeze({
    kind: policyKind,
    policyKinds,
    memberPolicyPlans: Object.freeze(ordered),
    stream: ordered[0].stream,
    generatorKind: ordered[0].generatorKind,
    publicationGroup: ordered[0].publicationGroup,
    publicationDependencies: Object.freeze([
      ...new Set(ordered.flatMap(value => value.publicationDependencies)),
    ].sort()),
    requiredOwnerKeys,
    prefetchedOwnerKeys: Object.freeze(prefetchedOwnerKeys),
    retainedOwnerKeys,
    requestOwnerKeys,
    allOwnerKeys: sorted(
      [...requestOwnerKeys, ...retainedOwnerKeys],
      ownerMetadataCache,
      'static-object-stream:merge:allOwnerKeys',
    ),
    deadline: Object.freeze({
      requiredAtMs: finiteDeadline('requiredAtMs'),
      prefetchedAtMs: finiteDeadline('prefetchedAtMs'),
    }),
    velocityCorridor: ordered[0].velocityCorridor,
  });
}

export function createStaticObjectStream({
  policyKind,
  policyKinds = null,
  classifyOwner,
  combineResourceKinds = null,
  ownerMetadataCache = null,
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
  const memberPolicyKinds = Object.freeze(policyKinds === null
    ? [policyKind]
    : [...new Set(policyKinds)]);
  if (memberPolicyKinds.length === 0
    || memberPolicyKinds.some(kind => typeof kind !== 'string' || !kind)
    || !memberPolicyKinds.includes(policyKind)) {
    throw new TypeError('policyKinds must contain policyKind and non-empty string keys');
  }
  if (typeof classifyOwner !== 'function') throw new TypeError('classifyOwner is required');
  if (combineResourceKinds !== null && typeof combineResourceKinds !== 'function') {
    throw new TypeError('combineResourceKinds must be a function');
  }
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
  let coverageGeneration = 0;
  let planRevision = 0;
  let latestPlan = null;
  let latestPolicyPlan = null;
  let latestCoverageSignature = null;
  let latestResourceKindEntries = Object.freeze([]);
  let latestResourceKindByOwner = new Map();
  let latestOwnerDescriptorByKey = new Map();
  let latestPolicyResourceKindEntries = Object.freeze([]);
  let latestPublicationContext = null;
  let publicationContextPendingForPlan = false;
  let disposed = false;
  const readyPageQueue = new Map();
  const staleTaskKeys = new Set();
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
    stableCoverageCancels: 0,
    staleResultDiscards: 0,
    ticketsCreated: 0,
    ticketsPublished: 0,
    ticketRejects: 0,
    readyEvictions: 0,
    maximumBacklog: 0,
    queueOverflows: 0,
    invalidations: 0,
    publicationContextUpdates: 0,
    publicationFastPathUpdates: 0,
    coverageMerges: 0,
    ownerSorts: 0,
    resourceKindClassifications: 0,
    coverageSignatures: 0,
    coverageOwnerEntryAllocations: 0,
  };

  const taskKey = (ownerKey, resourceKind) => `${resourceKind}\n${ownerKey}`;
  const classify = (
    ownerKey,
    plan = latestPlan,
    policyPlan = latestPolicyPlan,
    path = 'static-object-stream:cached-classification',
  ) => {
    const cached = latestResourceKindByOwner.get(ownerKey);
    if (cached !== undefined && plan === latestPlan) {
      ownerMetadataCache?.recordClassificationReuse({ ownerKey, path });
      return cached;
    }
    const owner = latestOwnerDescriptorByKey.get(ownerKey)
      ?? ownerMetadataCache?.parse(ownerKey, { path: 'static-object-stream:fallback-classify' })
      ?? parseChunkKey(ownerKey);
    return classifyOwner({
      ownerKey,
      owner,
      plan,
      policyPlan,
      policyPlans: policyPlan?.memberPolicyPlans ?? Object.freeze([policyPlan]),
    });
  };
  const promoteQueuedTask = task => {
    if (task?.state !== 'queued') return false;
    const index = queue.indexOf(task);
    if (index <= 0) return false;
    queue.splice(index, 1);
    queue.unshift(task);
    counts.queuedPromotions += 1;
    return true;
  };
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
  const currentStateRevision = () => (
    latestPublicationContext?.stateRevision ?? latestPlan?.stateRevision ?? 0
  );
  const currentOriginGeneration = () => (
    latestPublicationContext?.originGeneration ?? latestPlan?.originGeneration ?? 0
  );
  const currentPublicationSequence = () => latestPublicationContext?.sequence ?? 0;
  const queueReadyPage = resource => {
    if (!resource || !latestPolicyPlan?.allOwnerKeys.includes(resource.ownerKey)) return;
    if (latestResourceKindByOwner.get(resource.ownerKey) !== resource.resourceKind) {
      counts.staleResultDiscards += 1;
      return;
    }
    const required = latestPolicyPlan.requiredOwnerKeys.includes(resource.ownerKey);
    readyPageQueue.set(taskKey(resource.ownerKey, resource.resourceKind), Object.freeze({
      ...resource,
      required,
      deadlineAtMs: required
        ? latestPolicyPlan.deadline.requiredAtMs
        : latestPolicyPlan.deadline.prefetchedAtMs,
    }));
  };
  const createTicket = (ownerKey, resourceKind) => {
    if (!latestPlan || !latestPolicyPlan) return null;
    const key = taskKey(ownerKey, resourceKind);
    let ticket = tickets.get(key);
    if (ticket) {
      ticket.planId = latestPlan.planId;
      ticket.planRevision = planRevision;
      return ticket;
    }
    const resource = ready.get(taskKey(ownerKey, resourceKind));
    ticket = {
      schemaVersion: WORLD_PUBLICATION_TICKET_SCHEMA,
      ticketId: `${coverageGeneration}:${policyKind}:${resourceKind}:${ownerKey}`,
      planId: latestPlan.planId,
      planRevision,
      coverageGeneration,
      policyKind,
      policyKinds: memberPolicyKinds,
      publicationGroup: latestPolicyPlan.publicationGroup,
      publicationSequence: currentPublicationSequence(),
      stateRevision: currentStateRevision(),
      originGeneration: currentOriginGeneration(),
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
    staleTaskKeys.delete(task.key);
    if (state === 'ready') {
      const readyAtMs = clock();
      const retainedByLatestCoverage = latestPolicyPlan?.allOwnerKeys.includes(task.ownerKey)
        === true && latestResourceKindByOwner.get(task.ownerKey) === task.resourceKind;
      ready.set(task.key, Object.freeze({
        ownerKey: task.ownerKey,
        resourceKind: task.resourceKind,
        value,
        readyAtMs,
        sourcePlanId: task.planId,
      }));
      if (retainedByLatestCoverage) queueReadyPage(ready.get(task.key));
      else counts.staleResultDiscards += 1;
      trimReady();
      if (retainedByLatestCoverage) {
        markTicketsReady(task.ownerKey, task.resourceKind, readyAtMs);
      }
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
          ownerX: task.ownerX,
          ownerZ: task.ownerZ,
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
    ownerX = latestOwnerDescriptorByKey.get(ownerKey)?.ownerX ?? null,
    ownerZ = latestOwnerDescriptorByKey.get(ownerKey)?.ownerZ ?? null,
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
      queueReadyPage(existingReady);
      return Object.freeze({ promise: Promise.resolve(existingReady.value), cancel: () => false });
    }
    const existing = tasks.get(key);
    if (existing) {
      counts.pendingReuse += 1;
      if (required && !existing.required) {
        existing.required = true;
        existing.deadlineAtMs = deadlineAtMs;
        promoteQueuedTask(existing);
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
      ownerX,
      ownerZ,
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
      staleSincePublicationSequence: null,
      cancellationRequested: false,
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

  const cancelMatureStaleTasks = () => {
    if (disposed || staleTaskKeys.size === 0) return 0;
    const publicationSequence = currentPublicationSequence();
    let cancelled = 0;
    for (const key of [...staleTaskKeys]) {
      const task = tasks.get(key);
      if (!task) {
        staleTaskKeys.delete(key);
        continue;
      }
      const retainedWithCurrentKind = latestPolicyPlan?.allOwnerKeys.includes(task.ownerKey)
        === true && latestResourceKindByOwner.get(task.ownerKey) === task.resourceKind;
      if (retainedWithCurrentKind) {
        task.staleSincePublicationSequence = null;
        task.cancellationRequested = false;
        staleTaskKeys.delete(key);
        continue;
      }
      if (task.staleSincePublicationSequence === null) {
        task.staleSincePublicationSequence = publicationSequence;
        continue;
      }
      // Preserve the existing one-frame stop/start grace without requiring a
      // second full coverage application.
      if (publicationSequence <= task.staleSincePublicationSequence) continue;
      if (task.cancellationRequested) continue;
      task.cancellationRequested = true;
      if (task.state === 'queued') {
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
        settleTask(task, 'cancelled');
      } else {
        task.cancel?.('superseded-static-plan');
      }
      counts.stalePlanCancels += 1;
      counts.stableCoverageCancels += 1;
      cancelled += 1;
    }
    return cancelled;
  };

  const updatePublicationContext = (context, { deferStaleCancellation = false } = {}) => {
    if (disposed) return false;
    if (context?.schemaVersion !== WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA) {
      throw new TypeError(
        `Static Object Stream requires ${WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA}`,
      );
    }
    if (latestPublicationContext && context.sequence < latestPublicationContext.sequence) {
      return false;
    }
    latestPublicationContext = context;
    publicationContextPendingForPlan = true;
    counts.publicationContextUpdates += 1;
    if (latestCoverageSignature !== null) counts.publicationFastPathUpdates += 1;
    if (!deferStaleCancellation) cancelMatureStaleTasks();
    pump();
    return true;
  };

  const applyPlan = ({
    plan,
    policyPlan,
    policyPlans = null,
    publicationContext = null,
    ownerMetadataRevision = null,
  } = {}) => {
    if (disposed) return false;
    if (plan?.schemaVersion !== 'world-streaming-plan-1') {
      throw new TypeError(`Static Object Stream requires ${policyKind} plan coverage`);
    }
    if (publicationContext !== null) {
      updatePublicationContext(publicationContext, { deferStaleCancellation: true });
    } else if (!publicationContextPendingForPlan
      || !latestPublicationContext
      || latestPublicationContext.stateRevision !== plan.stateRevision
      || latestPublicationContext.originGeneration !== plan.originGeneration) {
      const nextSequence = (latestPublicationContext?.sequence ?? 0) + 1;
      updatePublicationContext(Object.freeze({
        schemaVersion: WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA,
        sequence: nextSequence,
        generatedAtMs: Number.isFinite(plan.generatedAtMs) ? plan.generatedAtMs : clock(),
        stateRevision: plan.stateRevision ?? 0,
        destructionRevision: latestPublicationContext?.destructionRevision ?? null,
        originGeneration: plan.originGeneration ?? 0,
      }), { deferStaleCancellation: true });
    }
    publicationContextPendingForPlan = false;
    const selectedPolicyPlans = policyPlans ?? (policyPlan ? [policyPlan] : []);
    const mergedPolicyPlan = mergePolicyPlanCoverage(
      policyKind,
      memberPolicyKinds,
      selectedPolicyPlans,
      ownerMetadataCache,
    );
    counts.coverageMerges += 1;
    counts.ownerSorts += 6;
    policyPlan = mergedPolicyPlan;
    const classificationRevision = ownerMetadataRevision
      ?? `world-plan:${plan.signatureHash}`;
    const stagedCoordinates = new Map();
    const coordinateFor = ownerKey => {
      let coordinate = stagedCoordinates.get(ownerKey);
      if (coordinate) return coordinate;
      coordinate = ownerMetadataCache?.parse(ownerKey, {
        path: 'static-object-stream:apply-plan',
      }) ?? parseChunkKey(ownerKey);
      if (coordinate.ownerKey === undefined) {
        coordinate = Object.freeze({
          key: ownerKey,
          ownerKey,
          ownerX: coordinate.chunkX,
          ownerZ: coordinate.chunkZ,
          chunkX: coordinate.chunkX,
          chunkZ: coordinate.chunkZ,
        });
      }
      stagedCoordinates.set(ownerKey, coordinate);
      return coordinate;
    };
    const descriptorsByPolicy = new Map();
    const nextPolicyResourceKindEntries = Object.freeze(selectedPolicyPlans.map(member => {
      const descriptors = Object.freeze(member.allOwnerKeys.map(ownerKey => {
        const coordinate = coordinateFor(ownerKey);
        return ownerMetadataCache?.classify({
          ownerKey,
          policyKind: member.kind,
          revision: classificationRevision,
          path: 'static-object-stream:policy-classification',
          classifier: owner => classifyOwner({
            ownerKey,
            owner,
            plan,
            policyPlan: member,
            policyPlans: Object.freeze([member]),
          }),
        }) ?? Object.freeze({
          ...coordinate,
          policyKind: member.kind,
          resourceKind: classifyOwner({
            ownerKey,
            owner: coordinate,
            plan,
            policyPlan: member,
            policyPlans: Object.freeze([member]),
          }),
          classificationRevision,
        });
      }));
      descriptorsByPolicy.set(member.kind, new Map(
        descriptors.map(descriptor => [descriptor.ownerKey, descriptor]),
      ));
      counts.resourceKindClassifications += descriptors.length;
      return Object.freeze({
        policyKind: member.kind,
        resourceKindEntries: Object.freeze(descriptors.map(descriptor => Object.freeze([
          descriptor.ownerKey,
          descriptor.resourceKind,
        ]))),
      });
    }));
    const nextOwnerDescriptors = Object.freeze(policyPlan.allOwnerKeys.map(ownerKey => {
      const policyDescriptors = selectedPolicyPlans
        .filter(member => descriptorsByPolicy.get(member.kind).has(ownerKey))
        .map(member => descriptorsByPolicy.get(member.kind).get(ownerKey));
      const resourceKinds = Object.freeze(policyDescriptors.map(value => value.resourceKind));
      const uniqueKinds = [...new Set(resourceKinds)];
      const resourceKind = uniqueKinds.length === 1
        ? uniqueKinds[0]
        : combineResourceKinds?.({
          ownerKey,
          plan,
          policyPlan,
          policyDescriptors: Object.freeze(policyDescriptors),
          resourceKinds,
        });
      if (typeof resourceKind !== 'string' || !resourceKind) {
        throw new Error(`Static Object Stream cannot combine resource kinds for ${ownerKey}`);
      }
      return Object.freeze({ ...coordinateFor(ownerKey), resourceKind });
    }));
    const nextOwnerDescriptorByKey = new Map(
      nextOwnerDescriptors.map(descriptor => [descriptor.ownerKey, descriptor]),
    );
    const nextResourceKindEntries = Object.freeze(nextOwnerDescriptors.map(descriptor => (
      Object.freeze([descriptor.ownerKey, descriptor.resourceKind])
    )));
    counts.coverageOwnerEntryAllocations += nextResourceKindEntries.length;
    const nextResourceKindByOwner = new Map(nextResourceKindEntries);
    const nextSignature = ownerMetadataRevision === null
      ? coverageSignature(plan, policyPlan, nextResourceKindEntries, ownerMetadataCache)
      : `immutable-coverage:${ownerMetadataRevision}`;
    if (ownerMetadataRevision === null) counts.coverageSignatures += 1;
    if (nextSignature === latestCoverageSignature) {
      latestPlan = plan;
      planRevision += 1;
      counts.unchangedPlans += 1;
      cancelMatureStaleTasks();
      pump();
      return false;
    }
    const required = new Set(policyPlan.requiredOwnerKeys);
    const requestedOwnerKeys = [
      ...policyPlan.requiredOwnerKeys,
      ...policyPlan.prefetchedOwnerKeys,
    ].sort((left, right) => {
      const leftOwner = nextOwnerDescriptorByKey.get(left);
      const rightOwner = nextOwnerDescriptorByKey.get(right);
      const leftX = (leftOwner.chunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS - plan.player.x;
      const leftZ = (leftOwner.chunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS - plan.player.z;
      const rightX = (rightOwner.chunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS - plan.player.x;
      const rightZ = (rightOwner.chunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS - plan.player.z;
      return Number(required.has(right)) - Number(required.has(left))
        || leftX * leftX + leftZ * leftZ - (rightX * rightX + rightZ * rightZ)
        || leftOwner.chunkZ - rightOwner.chunkZ
        || leftOwner.chunkX - rightOwner.chunkX;
    });
    const requested = requestedOwnerKeys.map(ownerKey => ({
      ownerKey,
      ownerX: nextOwnerDescriptorByKey.get(ownerKey).ownerX,
      ownerZ: nextOwnerDescriptorByKey.get(ownerKey).ownerZ,
      resourceKind: nextResourceKindByOwner.get(ownerKey),
      required: required.has(ownerKey),
      deadlineAtMs: required.has(ownerKey)
        ? policyPlan.deadline.requiredAtMs : policyPlan.deadline.prefetchedAtMs,
      planId: plan.planId,
      publicationGroup: policyPlan.publicationGroup,
    }));
    const newTaskKeys = new Set(requested.map(descriptor => (
      taskKey(descriptor.ownerKey, descriptor.resourceKind)
    )).filter(key => !tasks.has(key) && !ready.has(key)));
    if (tasks.size + newTaskKeys.size > queueCapacity) {
      counts.queueOverflows += 1;
      throw new RangeError(`Static Object Stream queue capacity exceeded: ${queueCapacity}`);
    }
    // Everything above is immutable staging. Only commit the new coverage
    // after classification, signature construction, ordering, and capacity
    // validation have all succeeded.
    epoch += 1;
    coverageGeneration += 1;
    planRevision += 1;
    latestPlan = plan;
    latestPolicyPlan = policyPlan;
    latestCoverageSignature = nextSignature;
    latestResourceKindEntries = nextResourceKindEntries;
    latestResourceKindByOwner = nextResourceKindByOwner;
    latestOwnerDescriptorByKey = nextOwnerDescriptorByKey;
    latestPolicyResourceKindEntries = nextPolicyResourceKindEntries;
    ownerMetadataCache?.retainClassificationRevision({
      revision: classificationRevision,
      descriptors: nextPolicyResourceKindEntries.flatMap(entry => (
        entry.resourceKindEntries.map(([ownerKey]) => descriptorsByPolicy
          .get(entry.policyKind).get(ownerKey))
      )),
    });
    counts.plans += 1;
    const retained = new Set(policyPlan.allOwnerKeys);
    for (const task of tasks.values()) {
      const retainedWithCurrentKind = retained.has(task.ownerKey)
        && nextResourceKindByOwner.get(task.ownerKey) === task.resourceKind;
      if (retainedWithCurrentKind) {
        task.staleSincePublicationSequence = null;
        task.cancellationRequested = false;
        staleTaskKeys.delete(task.key);
      } else {
        task.staleSincePublicationSequence ??= currentPublicationSequence();
        staleTaskKeys.add(task.key);
      }
    }
    for (const [key, ticket] of tickets) {
      if (!retained.has(ticket.ownerKey)
        || latestResourceKindByOwner.get(ticket.ownerKey) !== ticket.resourceKind) {
        tickets.delete(key);
      }
      else {
        ticket.ticketId = `${coverageGeneration}:${policyKind}:${ticket.resourceKind}:${ticket.ownerKey}`;
        ticket.planId = plan.planId;
        ticket.planRevision = planRevision;
        ticket.coverageGeneration = coverageGeneration;
      }
    }
    for (const [key, resource] of readyPageQueue) {
      if (!retained.has(resource.ownerKey)
        || latestResourceKindByOwner.get(resource.ownerKey) !== resource.resourceKind) {
        readyPageQueue.delete(key);
        counts.staleResultDiscards += 1;
      }
    }
    for (const descriptor of requested) enqueue({ ...descriptor, pumpNow: false });
    cancelMatureStaleTasks();
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
      queueReadyPage(existingReady);
      return Promise.resolve(existingReady.value);
    }
    const existing = tasks.get(key);
    if (existing) {
      counts.pendingReuse += 1;
      promoteQueuedTask(existing);
      createTicket(ownerKey, resourceKind);
      pump();
      return existing.promise.then(value => value ?? fallback());
    }
    if (!latestPlan || !latestPolicyPlan) return fallback();
    const handle = enqueue({
      ownerKey,
      resourceKind,
      required: true,
      deadlineAtMs: latestPolicyPlan.deadline.requiredAtMs,
      planId: latestPlan.planId,
      publicationGroup: latestPolicyPlan.publicationGroup,
      pumpNow: false,
    });
    promoteQueuedTask(tasks.get(key));
    pump();
    return handle.promise;
  };

  const publishOwners = ({
    ownerKeys,
    stateRevision = currentStateRevision(),
    originGeneration = currentOriginGeneration(),
  } = {}) => {
    if (!Array.isArray(ownerKeys) || !latestPlan) return Object.freeze([]);
    const published = [];
    const ownerSet = new Set(ownerKeys);
    for (const ownerKey of ownerSet) {
      createTicket(ownerKey, classify(
        ownerKey,
        latestPlan,
        latestPolicyPlan,
        'static-object-stream:publish',
      ));
    }
    for (const ticket of tickets.values()) {
      if (!ownerSet.has(ticket.ownerKey) || ticket.state !== 'ready') continue;
      if (ticket.planId !== latestPlan.planId
        || ticket.coverageGeneration !== coverageGeneration
        || stateRevision !== currentStateRevision()
        || originGeneration !== currentOriginGeneration()) {
        counts.ticketRejects += 1;
        continue;
      }
      ticket.publicationSequence = currentPublicationSequence();
      ticket.stateRevision = stateRevision;
      ticket.originGeneration = originGeneration;
      ticket.state = 'published';
      ticket.publishedAtMs = clock();
      counts.ticketsPublished += 1;
      published.push(Object.freeze({ ...ticket }));
    }
    return Object.freeze(published);
  };
  const drainReadyOwnerPages = ({ limit = 32 } = {}) => {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('ready owner page drain limit must be a positive safe integer');
    }
    const pages = [];
    const prioritized = [...readyPageQueue.entries()].sort((left, right) => (
      Number(right[1].required) - Number(left[1].required)
        || (left[1].deadlineAtMs ?? Number.POSITIVE_INFINITY)
          - (right[1].deadlineAtMs ?? Number.POSITIVE_INFINITY)
        || left[1].readyAtMs - right[1].readyAtMs
        || left[1].ownerKey.localeCompare(right[1].ownerKey)
    ));
    for (const [key, resource] of prioritized) {
      if (pages.length >= limit) break;
      readyPageQueue.delete(key);
      if (latestResourceKindByOwner.get(resource.ownerKey) !== resource.resourceKind) {
        counts.staleResultDiscards += 1;
        continue;
      }
      pages.push(Object.freeze({
        ownerKey: resource.ownerKey,
        resourceKind: resource.resourceKind,
        value: resource.value,
        readyAtMs: resource.readyAtMs,
        sourcePlanId: resource.sourcePlanId,
        required: resource.required,
        deadlineAtMs: resource.deadlineAtMs,
        coverageGeneration,
        planRevision,
        planId: latestPlan?.planId ?? null,
      }));
    }
    return Object.freeze(pages);
  };

  const snapshot = () => {
    const required = new Set(latestPolicyPlan?.requiredOwnerKeys ?? []);
    const prefetched = new Set(latestPolicyPlan?.prefetchedOwnerKeys ?? []);
    const ownerReady = ownerKey => ready.has(taskKey(
      ownerKey,
       classify(ownerKey, latestPlan, latestPolicyPlan, 'static-object-stream:snapshot'),
    ));
    const readyOwnerKeys = new Set([
      ...required,
      ...prefetched,
    ].filter(ownerReady));
    const policyCoverage = Object.freeze((latestPolicyPlan?.memberPolicyPlans ?? [])
      .map(member => Object.freeze({
        kind: member.kind,
        requiredOwnerCount: member.requiredOwnerKeys.length,
        prefetchedOwnerCount: member.prefetchedOwnerKeys.length,
        retainedOwnerCount: member.retainedOwnerKeys.length,
        readyRequiredOwnerCount: member.requiredOwnerKeys.filter(ownerReady).length,
        readyPrefetchedOwnerCount: member.prefetchedOwnerKeys.filter(ownerReady).length,
      })));
    return Object.freeze({
      schemaVersion: STATIC_OBJECT_STREAM_SCHEMA,
      policyKind,
      policyKinds: memberPolicyKinds,
      policyCoverage,
      workerCount: 1,
      epoch,
      coverageGeneration,
      planRevision,
      latestPlanId: latestPlan?.planId ?? null,
      publicationContext: latestPublicationContext,
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
      queuedOwnerKeys: Object.freeze(queue
        .filter(task => task.state === 'queued')
        .map(task => task.ownerKey)),
      inFlightOwnerKeys: Object.freeze([...tasks.values()]
        .filter(task => task.state === 'in-flight')
        .map(task => task.ownerKey)
        .sort()),
      backlog: queue.length + activeCount,
      queueCapacity,
      readyCacheSize: ready.size,
      readyCacheCapacity: readyCapacity,
      ticketCount: tickets.size,
      readyPageQueueCount: readyPageQueue.size,
      ticketCapacity,
      tickets: Object.freeze([...tickets.values()].map(ticket => Object.freeze({
        ...ticket,
        planId: latestPlan?.planId ?? ticket.planId,
        planRevision,
        publicationSequence: currentPublicationSequence(),
        stateRevision: currentStateRevision(),
        originGeneration: currentOriginGeneration(),
      }))),
      counts: Object.freeze({ ...counts }),
      disposed,
    });
  };
  const diagnostics = () => {
    const requiredOwnerKeys = latestPolicyPlan?.requiredOwnerKeys ?? [];
    const prefetchedOwnerKeys = latestPolicyPlan?.prefetchedOwnerKeys ?? [];
    const isReady = ownerKey => ready.has(taskKey(
      ownerKey,
      classify(ownerKey, latestPlan, latestPolicyPlan, 'static-object-stream:diagnostics'),
    ));
    let readyRequiredOwnerCount = 0;
    let readyPrefetchedOwnerCount = 0;
    if (latestPlan) {
      for (const ownerKey of requiredOwnerKeys) readyRequiredOwnerCount += Number(isReady(ownerKey));
      for (const ownerKey of prefetchedOwnerKeys) {
        readyPrefetchedOwnerCount += Number(isReady(ownerKey));
      }
    }
    const policyCoverage = Object.freeze((latestPolicyPlan?.memberPolicyPlans ?? [])
      .map(member => Object.freeze({
        kind: member.kind,
        requiredOwnerCount: member.requiredOwnerKeys.length,
        readyRequiredOwnerCount: member.requiredOwnerKeys.filter(isReady).length,
        prefetchedOwnerCount: member.prefetchedOwnerKeys.length,
        readyPrefetchedOwnerCount: member.prefetchedOwnerKeys.filter(isReady).length,
        retainedOwnerCount: member.retainedOwnerKeys.length,
      })));
    return Object.freeze({
      policyKind,
      policyKinds: memberPolicyKinds,
      workerCount: 1,
      coverageGeneration,
      planRevision,
      latestPlanId: latestPlan?.planId ?? null,
      publicationSequence: currentPublicationSequence(),
      policyCoverage,
      requiredOwnerCount: requiredOwnerKeys.length,
      readyRequiredOwnerCount,
      missingRequiredOwnerCount: requiredOwnerKeys.length - readyRequiredOwnerCount,
      prefetchedOwnerCount: prefetchedOwnerKeys.length,
      readyPrefetchedOwnerCount,
      backlog: queue.length + activeCount,
      queueDepth: queue.length,
      inFlightCount: activeCount,
      readyPageCount: readyPageQueue.size,
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
    latestResourceKindEntries = Object.freeze([]);
    latestResourceKindByOwner = new Map();
    latestOwnerDescriptorByKey = new Map();
    latestPolicyResourceKindEntries = Object.freeze([]);
    ownerMetadataCache?.invalidateClassifications();
    latestPlan = null;
    latestPolicyPlan = null;
    publicationContextPendingForPlan = false;
    staleTaskKeys.clear();
    tickets.clear();
    ready.clear();
    readyPageQueue.clear();
    staleTaskKeys.clear();
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
    readyPageQueue.clear();
  };
  return Object.freeze({
    applyPlan,
    updatePublicationContext,
    requestOrReuse,
    publishOwners,
    drainReadyOwnerPages,
    resourceKindEntries: () => latestResourceKindEntries,
    policyResourceKindEntries: () => latestPolicyResourceKindEntries,
    ownerMetadataDiagnostics: () => ownerMetadataCache?.snapshot() ?? null,
    invalidate,
    diagnostics,
    snapshot,
    dispose,
  });
}
