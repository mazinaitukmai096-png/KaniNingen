import {
  createChunkKey,
  logicalWorldToOwnedChunk,
  parseChunkKey,
  squareChunkCoordinates,
} from './chunk-coordinates.js';
import {
  WORLD_STREAMING_POLICY_SCHEMA,
  WORLD_STREAMING_POLICY_STREAM,
} from './world-streaming-policy-registry.js';

export const WORLD_STREAMING_PLAN_SCHEMA = 'world-streaming-plan-1';
export const LEGACY_RUNTIME_CHUNK_POLICY_KIND = 'runtime-chunk-coverage';

const q6 = value => Math.round(value * 1e6) / 1e6;
const normalizedOwnerKeyArrayCache = new WeakMap();
const ownerKeyUnionCache = new WeakMap();

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function normalizePosition(value, label) {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} is required`);
  return Object.freeze({
    x: finite(value.x, `${label}.x`),
    z: finite(value.z, `${label}.z`),
  });
}

function normalizeOwnerKeys(values, label, ownerMetadataCache = null) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  if (ownerMetadataCache?.isNormalizedOwnerKeys(values)) return values;
  const cached = normalizedOwnerKeyArrayCache.get(values);
  if (cached) return cached;
  const coordinates = new Map();
  for (const value of values) {
    const coordinate = typeof value === 'string'
      ? (ownerMetadataCache?.parse(value, { path: 'world-streaming-plan:normalize' })
        ?? parseChunkKey(value))
      : { chunkX: value?.chunkX, chunkZ: value?.chunkZ };
    const key = createChunkKey(coordinate.chunkX, coordinate.chunkZ);
    coordinates.set(key, Object.freeze({ ...coordinate, key }));
  }
  const normalized = Object.freeze([...coordinates.values()]
    .sort((left, right) => left.chunkZ - right.chunkZ || left.chunkX - right.chunkX)
    .map(value => value.key));
  ownerMetadataCache?.markNormalizedOwnerKeys(normalized);
  if (Object.isFrozen(values)) normalizedOwnerKeyArrayCache.set(values, normalized);
  return normalized;
}

function mergeNormalizedOwnerKeyPair(left, right, ownerMetadataCache = null) {
  if (left === right || right.length === 0) return left;
  if (left.length === 0) return right;
  if (Object.isFrozen(left) && Object.isFrozen(right)) {
    let byRight = ownerKeyUnionCache.get(left);
    if (!byRight) {
      byRight = new WeakMap();
      ownerKeyUnionCache.set(left, byRight);
    }
    const cached = byRight.get(right);
    if (cached) {
      ownerMetadataCache?.markNormalizedOwnerKeys(cached);
      return cached;
    }
  }
  const localCoordinates = ownerMetadataCache === null ? new Map() : null;
  const compare = ownerMetadataCache?.compareOwnerKeys
    ? (a, b) => ownerMetadataCache.compareOwnerKeys(a, b, {
      path: 'world-streaming-plan:merge',
    })
    : (a, b) => {
      let leftCoordinate = localCoordinates.get(a);
      if (!leftCoordinate) {
        leftCoordinate = parseChunkKey(a);
        localCoordinates.set(a, leftCoordinate);
      }
      let rightCoordinate = localCoordinates.get(b);
      if (!rightCoordinate) {
        rightCoordinate = parseChunkKey(b);
        localCoordinates.set(b, rightCoordinate);
      }
      return leftCoordinate.chunkZ - rightCoordinate.chunkZ
        || leftCoordinate.chunkX - rightCoordinate.chunkX;
    };
  const merged = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftKey = left[leftIndex];
    const rightKey = right[rightIndex];
    if (leftKey === undefined) {
      if (merged.at(-1) !== rightKey) merged.push(rightKey);
      rightIndex += 1;
    } else if (rightKey === undefined) {
      if (merged.at(-1) !== leftKey) merged.push(leftKey);
      leftIndex += 1;
    } else {
      const comparison = compare(leftKey, rightKey);
      const key = comparison <= 0 ? leftKey : rightKey;
      if (merged.at(-1) !== key) merged.push(key);
      if (comparison <= 0) leftIndex += 1;
      if (comparison >= 0) rightIndex += 1;
    }
  }
  const result = Object.freeze(merged);
  ownerMetadataCache?.markNormalizedOwnerKeys(result);
  if (Object.isFrozen(left) && Object.isFrozen(right)) {
    ownerKeyUnionCache.get(left).set(right, result);
  }
  return result;
}

export function unionNormalizedOwnerKeys(ownerMetadataCache, ...sets) {
  if (sets.length === 0) return Object.freeze([]);
  return sets.slice(1).reduce(
    (merged, values) => mergeNormalizedOwnerKeyPair(merged, values, ownerMetadataCache),
    sets[0],
  );
}

function unionOwnerKeys(...sets) {
  const normalized = sets.map((values, index) => normalizeOwnerKeys(
    values,
    `owner key union[${index}]`,
  ));
  return unionNormalizedOwnerKeys(null, ...normalized);
}

function unionOwnerKeysWithMetadata(ownerMetadataCache, ...sets) {
  const normalized = sets.map((values, index) => normalizeOwnerKeys(
    values,
    `owner key union[${index}]`,
    ownerMetadataCache,
  ));
  return unionNormalizedOwnerKeys(ownerMetadataCache, ...normalized);
}

function differenceOwnerKeys(values, excluded) {
  const excludedKeys = new Set(excluded);
  return Object.freeze(values.filter(key => !excludedKeys.has(key)));
}

function hashText(value) {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function createVelocityCorridor({
  logicalPosition,
  velocity = { x: 0, z: 0 },
  leadSeconds,
  maximumDistanceMeters,
  sampleIntervalSeconds,
} = {}) {
  const origin = normalizePosition(logicalPosition, 'logicalPosition');
  const direction = normalizePosition(velocity, 'velocity');
  const lead = finite(leadSeconds, 'leadSeconds');
  const maximumDistance = finite(maximumDistanceMeters, 'maximumDistanceMeters');
  const interval = finite(sampleIntervalSeconds, 'sampleIntervalSeconds');
  if (lead < 0 || maximumDistance < 0 || interval <= 0) {
    throw new RangeError('velocity corridor bounds must be non-negative with a positive interval');
  }
  const speedMetersPerSecond = Math.hypot(direction.x, direction.z);
  const unclampedDistanceMeters = speedMetersPerSecond * lead;
  const distanceMeters = Math.min(unclampedDistanceMeters, maximumDistance);
  const durationSeconds = speedMetersPerSecond > 0
    ? distanceMeters / speedMetersPerSecond : 0;
  const sampleCount = Math.max(1, Math.min(64, Math.ceil(durationSeconds / interval) + 1));
  const samples = [];
  const ownerKeys = [];
  const seenOwners = new Set();
  for (let index = 0; index < sampleCount; index += 1) {
    const ratio = sampleCount === 1 ? 0 : index / (sampleCount - 1);
    const timeSeconds = durationSeconds * ratio;
    const x = q6(origin.x + direction.x * timeSeconds);
    const z = q6(origin.z + direction.z * timeSeconds);
    const owner = logicalWorldToOwnedChunk(x, z);
    samples.push(Object.freeze({ timeSeconds: q6(timeSeconds), x, z, ownerKey: owner.key }));
    if (!seenOwners.has(owner.key)) {
      seenOwners.add(owner.key);
      ownerKeys.push(owner.key);
    }
  }
  const endpoint = samples.at(-1);
  return Object.freeze({
    schemaVersion: 'world-streaming-velocity-corridor-1',
    origin,
    velocity: direction,
    speedMetersPerSecond: q6(speedMetersPerSecond),
    leadSeconds: lead,
    durationSeconds: q6(durationSeconds),
    unclampedDistanceMeters: q6(unclampedDistanceMeters),
    distanceMeters: q6(distanceMeters),
    clamped: distanceMeters < unclampedDistanceMeters,
    endpoint: Object.freeze({ x: endpoint.x, z: endpoint.z }),
    ownerKeys: Object.freeze(ownerKeys),
    samples: Object.freeze(samples),
  });
}

export function createLegacyRuntimeChunkStreamingPolicy({ ownerMetadataCache = null } = {}) {
  return Object.freeze({
    schemaVersion: WORLD_STREAMING_POLICY_SCHEMA,
    kind: LEGACY_RUNTIME_CHUNK_POLICY_KIND,
    stream: WORLD_STREAMING_POLICY_STREAM.STATIC,
    distanceBands: Object.freeze({
      required: Object.freeze({ radiusChunks: 1, deadlineSeconds: 0 }),
      prefetched: Object.freeze({ radiusChunks: 2, deadlineSeconds: 0.9 }),
      retained: Object.freeze({ radiusChunks: 2, deadlineSeconds: null }),
    }),
    velocityPrefetch: Object.freeze({
      enabled: true,
      leadSeconds: 2.25,
      maximumDistanceMeters: 16,
      sampleIntervalSeconds: 0.1,
    }),
    ownerResolver({ player, velocityCorridor, policy, residentCoverage = null }) {
      if (residentCoverage?.schemaVersion === 'resident-world-coverage-1') {
        const required = residentCoverage.fullView?.ownerKeys
          ?? residentCoverage.residentRequiredOwnerKeys;
        return {
          required,
          prefetched: Object.freeze([]),
          retained: required,
          sourceHash: `${residentCoverage.signature}:full`,
        };
      }
      const currentOwner = logicalWorldToOwnedChunk(player.x, player.z);
      const required = squareChunkCoordinates(
        currentOwner.chunkX,
        currentOwner.chunkZ,
        policy.distanceBands.required.radiusChunks,
      ).map(value => value.key);
      const retained = squareChunkCoordinates(
        currentOwner.chunkX,
        currentOwner.chunkZ,
        policy.distanceBands.retained.radiusChunks,
      ).map(value => value.key);
      const prefetched = differenceOwnerKeys(retained, required);
      const velocityPrefetched = [];
      for (const ownerKey of velocityCorridor.ownerKeys.slice(1)) {
        const owner = ownerMetadataCache?.parse(ownerKey, {
          path: 'world-streaming-plan:legacy-prefetch',
        }) ?? parseChunkKey(ownerKey);
        velocityPrefetched.push(...squareChunkCoordinates(
          owner.chunkX,
          owner.chunkZ,
          policy.distanceBands.prefetched.radiusChunks,
        ).map(value => value.key));
      }
      return {
        required,
        prefetched: unionOwnerKeys(prefetched, velocityPrefetched),
        retained,
      };
    },
    generatorKind: 'canonical-chunk',
    cachePolicy: Object.freeze({ kind: 'legacy-runtime-lru', maximumEntries: 81 }),
    publicationGroup: 'runtime-transition',
    publicationDependencies: Object.freeze([]),
    visibilityPolicy: Object.freeze({ kind: 'legacy-runtime-coverage' }),
    persistencePolicy: Object.freeze({ kind: 'canonical-gameplay-only' }),
    criticality: 'player-required',
  });
}

function deadlineAt(generatedAtMs, seconds) {
  return seconds === null ? null : q6(generatedAtMs + seconds * 1000);
}

export function createWorldStreamingPlan({
  sequence,
  generatedAtMs,
  player,
  velocity = { x: 0, z: 0 },
  renderDistancePreset,
  stateRevision = 0,
  originGeneration = 0,
  policies,
  ownerMetadataCache = null,
  residentCoverage = null,
} = {}) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError('World Streaming plan sequence must be a positive safe integer');
  }
  const createdAt = finite(generatedAtMs, 'generatedAtMs');
  if (typeof renderDistancePreset !== 'string' || !renderDistancePreset) {
    throw new TypeError('renderDistancePreset is required');
  }
  if (!Number.isSafeInteger(stateRevision) || stateRevision < 0
    || !Number.isSafeInteger(originGeneration) || originGeneration < 0) {
    throw new RangeError('stateRevision and originGeneration must be non-negative safe integers');
  }
  if (!Array.isArray(policies) || policies.length === 0) {
    throw new TypeError('at least one World Streaming policy is required');
  }
  if (residentCoverage !== null
    && residentCoverage?.schemaVersion !== 'resident-world-coverage-1') {
    throw new TypeError('residentCoverage must use the Resident World coverage contract');
  }
  const logicalPlayer = normalizePosition(player, 'player');
  const logicalVelocity = normalizePosition(velocity, 'velocity');
  const policyPlans = policies.map(policy => {
    const velocityCorridor = createVelocityCorridor({
      logicalPosition: logicalPlayer,
      velocity: policy.velocityPrefetch.enabled ? logicalVelocity : { x: 0, z: 0 },
      ...policy.velocityPrefetch,
    });
    const resolved = policy.ownerResolver({
      player: logicalPlayer,
      velocity: logicalVelocity,
      velocityCorridor,
      renderDistancePreset,
      stateRevision,
      originGeneration,
      policy,
      residentCoverage,
    });
    const requiredOwnerKeys = normalizeOwnerKeys(
      resolved?.required ?? [],
      `${policy.kind}.required`,
      ownerMetadataCache,
    );
    const prefetchedOwnerKeys = normalizeOwnerKeys(
      resolved?.prefetched ?? [],
      `${policy.kind}.prefetched`,
      ownerMetadataCache,
    );
    const retainedOwnerKeys = normalizeOwnerKeys(
      resolved?.retained ?? [],
      `${policy.kind}.retained`,
      ownerMetadataCache,
    );
    const requestOwnerKeys = unionOwnerKeysWithMetadata(
      ownerMetadataCache,
      requiredOwnerKeys,
      prefetchedOwnerKeys,
    );
    const policyPlan = {
      kind: policy.kind,
      stream: policy.stream,
      generatorKind: policy.generatorKind,
      publicationGroup: policy.publicationGroup,
      publicationDependencies: policy.publicationDependencies,
      requiredOwnerKeys,
      prefetchedOwnerKeys,
      retainedOwnerKeys,
      requestOwnerKeys,
      allOwnerKeys: unionOwnerKeysWithMetadata(
        ownerMetadataCache,
        requestOwnerKeys,
        retainedOwnerKeys,
      ),
      sourceHash: typeof resolved?.sourceHash === 'string' ? resolved.sourceHash : null,
      deadline: Object.freeze({
        requiredAtMs: deadlineAt(
          createdAt,
          policy.distanceBands.required.deadlineSeconds,
        ),
        prefetchedAtMs: deadlineAt(
          createdAt,
          policy.distanceBands.prefetched.deadlineSeconds,
        ),
      }),
      velocityCorridor,
    };
    Object.defineProperty(policyPlan, 'sourceSnapshot', {
      value: resolved?.sourceSnapshot ?? resolved ?? null,
      enumerable: false,
    });
    Object.defineProperty(policyPlan, 'resourceKindEntries', {
      value: resolved?.resourceKindEntries ?? null,
      enumerable: false,
    });
    Object.defineProperty(policyPlan, 'resourceKindFor', {
      value: resolved?.resourceKindFor ?? null,
      enumerable: false,
    });
    return Object.freeze(policyPlan);
  }).sort((left, right) => left.kind.localeCompare(right.kind));
  ownerMetadataCache?.recordSignature('world-streaming-plan:signature');
  const signature = JSON.stringify({
    player: logicalPlayer,
    velocity: logicalVelocity,
    renderDistancePreset,
    stateRevision,
    originGeneration,
    residentCoverage: residentCoverage?.signature ?? null,
    policies: policyPlans.map(policy => ({
      kind: policy.kind,
      ...(policy.sourceHash ? { sourceHash: policy.sourceHash } : {
        required: policy.requiredOwnerKeys,
        prefetched: policy.prefetchedOwnerKeys,
        retained: policy.retainedOwnerKeys,
      }),
    })),
  });
  const planId = `world-plan-${sequence}-${hashText(signature)}`;
  const publicationGroups = [...new Set(policyPlans.map(policy => policy.publicationGroup))]
    .sort().map(group => {
      const members = policyPlans.filter(policy => policy.publicationGroup === group);
      const requiredDeadlines = members.map(policy => policy.deadline.requiredAtMs)
        .filter(value => value !== null);
      return Object.freeze({
        group,
        policyKinds: Object.freeze(members.map(policy => policy.kind)),
        requiredOwnerKeys: unionOwnerKeysWithMetadata(
          ownerMetadataCache,
          ...members.map(policy => policy.requiredOwnerKeys),
        ),
        deadlineAtMs: requiredDeadlines.length ? Math.min(...requiredDeadlines) : null,
      });
    });
  return Object.freeze({
    schemaVersion: WORLD_STREAMING_PLAN_SCHEMA,
    mode: 'shadow',
    planId,
    sequence,
    generatedAtMs: createdAt,
    player: logicalPlayer,
    velocity: logicalVelocity,
    renderDistancePreset,
    stateRevision,
    originGeneration,
    residentCoverage,
    policyPlans: Object.freeze(policyPlans),
    publicationGroups: Object.freeze(publicationGroups),
    signatureHash: hashText(signature),
  });
}
