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
import { unionNormalizedOwnerKeys } from './world-streaming-plan.js';
import { residentOwnerKeysWithinRadius } from './chunk-streaming-plan.js';

export const STATIC_OBJECT_STREAM_SCHEMA = 'static-object-stream-1';
export const WORLD_PUBLICATION_TICKET_SCHEMA = 'world-publication-ticket-1';

export const STATIC_OBJECT_STREAM_VELOCITY_PREFETCH = Object.freeze({
  enabled: true,
  leadSeconds: 5,
  maximumDistanceMeters: 192,
  sampleIntervalSeconds: 0.25,
});

// Keep one owner-cell diagonal of renderer-ready coarse world immediately
// outside the true visual circle. Natural coverage invalidates at owner
// boundaries, so this is the exact conservative supply needed while the player
// moves between any two points in the same 16 m cell. It is scheduling metadata
// on the existing Resource cursor, not another coverage lifecycle or queue.
const STATIC_COARSE_SAFETY_MARGIN_METERS = Math.SQRT2 * LOGICAL_CHUNK_SIZE_METERS;
const STATIC_COARSE_FILL_INNER_RATIO = 2 / 3;

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
  const distanceX = closestX - centerX;
  const distanceZ = closestZ - centerZ;
  return distanceX * distanceX + distanceZ * distanceZ <= radiusMeters * radiusMeters;
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
  const minimumChunkX = Math.ceil((centerX - radius) / LOGICAL_CHUNK_SIZE_METERS) - 1;
  const maximumChunkX = Math.floor((centerX + radius) / LOGICAL_CHUNK_SIZE_METERS);
  const minimumChunkZ = Math.ceil((centerZ - radius) / LOGICAL_CHUNK_SIZE_METERS) - 1;
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
  if (dx === 0) {
    if (start.x < minimumX || start.x > maximumX) return false;
  } else {
    const first = (minimumX - start.x) / dx;
    const second = (maximumX - start.x) / dx;
    minimumT = Math.max(minimumT, Math.min(first, second));
    maximumT = Math.min(maximumT, Math.max(first, second));
    if (minimumT > maximumT) return false;
  }
  if (dz === 0) return start.z >= minimumZ && start.z <= maximumZ;
  const first = (minimumZ - start.z) / dz;
  const second = (maximumZ - start.z) / dz;
  minimumT = Math.max(minimumT, Math.min(first, second));
  maximumT = Math.min(maximumT, Math.max(first, second));
  return minimumT <= maximumT;
}

function rayAabbEntrySeconds({
  playerX,
  playerZ,
  velocityX,
  velocityZ,
  minimumX,
  minimumZ,
  maximumX,
  maximumZ,
}) {
  let minimumT = 0;
  let maximumT = Number.POSITIVE_INFINITY;
  for (const [position, direction, minimum, maximum] of [
    [playerX, velocityX, minimumX, maximumX],
    [playerZ, velocityZ, minimumZ, maximumZ],
  ]) {
    if (direction === 0) {
      if (position < minimum || position > maximum) return null;
      continue;
    }
    const first = (minimum - position) / direction;
    const second = (maximum - position) / direction;
    minimumT = Math.max(minimumT, Math.min(first, second));
    maximumT = Math.min(maximumT, Math.max(first, second));
    if (minimumT > maximumT) return null;
  }
  return maximumT < 0 ? null : Math.max(0, minimumT);
}

function rayCircleEntrySeconds({
  playerX,
  playerZ,
  velocityX,
  velocityZ,
  centerX,
  centerZ,
  radiusMeters,
}) {
  const offsetX = playerX - centerX;
  const offsetZ = playerZ - centerZ;
  const radiusSquared = radiusMeters * radiusMeters;
  if (offsetX * offsetX + offsetZ * offsetZ <= radiusSquared) return 0;
  const speedSquared = velocityX * velocityX + velocityZ * velocityZ;
  if (!(speedSquared > 0)) return null;
  const projection = offsetX * velocityX + offsetZ * velocityZ;
  const discriminant = projection * projection
    - speedSquared * (offsetX * offsetX + offsetZ * offsetZ - radiusSquared);
  if (discriminant < 0) return null;
  const entry = (-projection - Math.sqrt(Math.max(0, discriminant))) / speedSquared;
  return entry < 0 ? null : entry;
}

/**
 * First time a moving point enters the exact Euclidean radius of a Chunk AABB.
 * The rounded rectangle is the union of its two edge strips and four corner
 * circles.  In particular, this never treats the square corner of an
 * independently-expanded AABB as drawable visual coverage.
 */
export function staticMovingPointChunkAabbEntrySeconds({
  chunkX,
  chunkZ,
  player,
  velocity,
  radiusMeters,
} = {}) {
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
    throw new TypeError('Chunk coordinates must be safe integers');
  }
  const playerX = Number(player?.x);
  const playerZ = Number(player?.z);
  const velocityX = Number(velocity?.x);
  const velocityZ = Number(velocity?.z);
  if (![playerX, playerZ, velocityX, velocityZ, radiusMeters].every(Number.isFinite)
    || radiusMeters < 0) {
    throw new RangeError('moving-point Chunk entry requires finite coordinates and radius');
  }
  const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const maximumX = minimumX + LOGICAL_CHUNK_SIZE_METERS;
  const maximumZ = minimumZ + LOGICAL_CHUNK_SIZE_METERS;
  if (staticChunkAabbIntersectsCircle(
    chunkX,
    chunkZ,
    playerX,
    playerZ,
    radiusMeters,
  )) return 0;
  const candidates = [
    rayAabbEntrySeconds({
      playerX,
      playerZ,
      velocityX,
      velocityZ,
      minimumX: minimumX - radiusMeters,
      minimumZ,
      maximumX: maximumX + radiusMeters,
      maximumZ,
    }),
    rayAabbEntrySeconds({
      playerX,
      playerZ,
      velocityX,
      velocityZ,
      minimumX,
      minimumZ: minimumZ - radiusMeters,
      maximumX,
      maximumZ: maximumZ + radiusMeters,
    }),
  ];
  for (const [centerX, centerZ] of [
    [minimumX, minimumZ],
    [minimumX, maximumZ],
    [maximumX, minimumZ],
    [maximumX, maximumZ],
  ]) {
    candidates.push(rayCircleEntrySeconds({
      playerX,
      playerZ,
      velocityX,
      velocityZ,
      centerX,
      centerZ,
      radiusMeters,
    }));
  }
  const finiteCandidates = candidates.filter(Number.isFinite);
  return finiteCandidates.length === 0 ? null : Math.min(...finiteCandidates);
}

function segmentIntersectsRoundedChunkAabb(
  chunkX,
  chunkZ,
  start,
  end,
  radiusMeters,
) {
  const entrySeconds = staticMovingPointChunkAabbEntrySeconds({
    chunkX,
    chunkZ,
    player: start,
    velocity: { x: end.x - start.x, z: end.z - start.z },
    radiusMeters,
  });
  return entrySeconds !== null && entrySeconds <= 1;
}

function collectCorridorOwners({
  start,
  end,
  exactRadiusMeters,
  horizonRadiusMeters,
  horizonOwnerPredicate,
  exactOwnerKeys = null,
}) {
  const result = new Set();
  const radius = Math.max(exactRadiusMeters, horizonRadiusMeters ?? exactRadiusMeters);
  const minimumChunkX = Math.ceil(
    (Math.min(start.x, end.x) - radius) / LOGICAL_CHUNK_SIZE_METERS,
  ) - 1;
  const maximumChunkX = Math.floor((Math.max(start.x, end.x) + radius) / LOGICAL_CHUNK_SIZE_METERS);
  const minimumChunkZ = Math.ceil(
    (Math.min(start.z, end.z) - radius) / LOGICAL_CHUNK_SIZE_METERS,
  ) - 1;
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
      if (exact || horizon) {
        const ownerKey = createChunkKey(chunkX, chunkZ);
        result.add(ownerKey);
        if (exact) exactOwnerKeys?.add(ownerKey);
      }
    }
  }
  return result;
}

function collectVisualCorridorOwners({
  start,
  end,
  exactRadiusMeters,
  horizonRadiusMeters,
  horizonOwnerPredicate,
  exactOwnerKeys = null,
}) {
  const result = new Set();
  const radius = Math.max(exactRadiusMeters, horizonRadiusMeters ?? exactRadiusMeters);
  const minimumChunkX = Math.ceil((Math.min(start.x, end.x) - radius)
    / LOGICAL_CHUNK_SIZE_METERS) - 1;
  const maximumChunkX = Math.floor((Math.max(start.x, end.x) + radius)
    / LOGICAL_CHUNK_SIZE_METERS);
  const minimumChunkZ = Math.ceil((Math.min(start.z, end.z) - radius)
    / LOGICAL_CHUNK_SIZE_METERS) - 1;
  const maximumChunkZ = Math.floor((Math.max(start.z, end.z) + radius)
    / LOGICAL_CHUNK_SIZE_METERS);
  for (let chunkZ = minimumChunkZ; chunkZ <= maximumChunkZ; chunkZ += 1) {
    for (let chunkX = minimumChunkX; chunkX <= maximumChunkX; chunkX += 1) {
      const exact = segmentIntersectsRoundedChunkAabb(
        chunkX,
        chunkZ,
        start,
        end,
        exactRadiusMeters,
      );
      const horizon = !exact && horizonRadiusMeters !== null
        && horizonOwnerPredicate({ chunkX, chunkZ })
        && segmentIntersectsRoundedChunkAabb(
          chunkX,
          chunkZ,
          start,
          end,
          horizonRadiusMeters,
        );
      if (exact || horizon) {
        const ownerKey = createChunkKey(chunkX, chunkZ);
        result.add(ownerKey);
        if (exact) exactOwnerKeys?.add(ownerKey);
      }
    }
  }
  return result;
}

function freezeCollectedOwnerKeys(values, ownerMetadataCache = null) {
  const result = Object.freeze([...values]);
  ownerMetadataCache?.markNormalizedOwnerKeys(result);
  return result;
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
  const ownerResolver = ({
    player,
    velocityCorridor,
    renderDistancePreset,
    residentCoverage = null,
  }) => {
    const playerOwner = logicalWorldToOwnedChunk(player.x, player.z);
    const endpointOwner = logicalWorldToOwnedChunk(
      velocityCorridor.endpoint.x,
      velocityCorridor.endpoint.z,
    );
    // The coordinator decides when coverage is regenerated (owner/corridor
    // boundary, not camera or micro-movement). Once it does regenerate, the
    // cache must not substitute a circle computed from an older sub-Chunk
    // alignment that happened to share the same start/end owner keys. Such a
    // stale circle can mark a lateral owner Expected even though the current
    // velocity ray can never enter its exact visual radius.
    const coverageKey = `${renderDistancePreset}:${residentCoverage?.signature
      ?? playerOwner.key}:${endpointOwner.key}:`
      + `${Number(player.x).toFixed(6)},${Number(player.z).toFixed(6)}:`
      + `${Number(velocityCorridor.endpoint.x).toFixed(6)},`
      + `${Number(velocityCorridor.endpoint.z).toFixed(6)}`;
    const cached = coverageCache.get(coverageKey);
    if (cached) {
      coverageCache.delete(coverageKey);
      coverageCache.set(coverageKey, cached);
      return cached;
    }
    const profile = distanceProfileResolver(renderDistancePreset);
    const presentationRadiusMeters = Math.max(
      profile.exactDistanceMeters,
      profile.horizonDistanceMeters ?? profile.exactDistanceMeters,
    );
    const requiredRadiusMeters = residentCoverage === null
      ? presentationRadiusMeters : residentCoverage.radiusMeters;
    const required = residentCoverage === null
      ? coverageFor(player, renderDistancePreset)
      : new Set(residentOwnerKeysWithinRadius(residentCoverage, requiredRadiusMeters));
    // Resource residency deliberately carries one Chunk of prewarm margin,
    // while visual existence is the true presentation circle around the
    // player. Keep both immutable domains on the same source snapshot.
    const visualRequired = coverageFor(player, renderDistancePreset);
    const visualExactOwnerKeys = collectCircularOwners({
      centerX: player.x,
      centerZ: player.z,
      exactRadiusMeters: profile.exactDistanceMeters,
      horizonRadiusMeters: null,
      horizonOwnerPredicate,
    });
    const exactOwnerKeys = residentCoverage === null
      ? collectCircularOwners({
        centerX: player.x,
        centerZ: player.z,
        exactRadiusMeters: profile.exactDistanceMeters,
        horizonRadiusMeters: null,
        horizonOwnerPredicate,
      })
      : new Set(residentOwnerKeysWithinRadius(
        residentCoverage,
        Math.min(
          residentCoverage.radiusMeters,
          profile.exactDistanceMeters + LOGICAL_CHUNK_SIZE_METERS,
        ),
      ));
    const prefetched = velocityCorridor.distanceMeters > 0
      ? collectCorridorOwners({
        start: player,
        end: velocityCorridor.endpoint,
        exactRadiusMeters: profile.exactDistanceMeters,
        horizonRadiusMeters: profile.horizonDistanceMeters,
        horizonOwnerPredicate,
        exactOwnerKeys,
      })
      : new Set();
    for (const ownerKey of required) prefetched.delete(ownerKey);
    const visualCorridor = velocityCorridor.distanceMeters > 0
      ? collectVisualCorridorOwners({
        start: player,
        end: velocityCorridor.endpoint,
        exactRadiusMeters: profile.exactDistanceMeters,
        horizonRadiusMeters: profile.horizonDistanceMeters,
        horizonOwnerPredicate,
        exactOwnerKeys: visualExactOwnerKeys,
      })
      : new Set();
    const visualPrefetched = new Set(visualCorridor);
    for (const ownerKey of visualRequired) visualPrefetched.delete(ownerKey);
    const retainedRadiusMeters = requiredRadiusMeters + retentionMarginMeters;
    const retained = residentCoverage !== null
      ? new Set(residentCoverage.presentationView?.ownerKeys
        ?? residentOwnerKeysWithinRadius(residentCoverage, requiredRadiusMeters))
      : coverageFor(player, renderDistancePreset, retentionMarginMeters);
    const requiredOwnerKeys = freezeCollectedOwnerKeys(required, ownerMetadataCache);
    const prefetchedOwnerKeys = freezeCollectedOwnerKeys(prefetched, ownerMetadataCache);
    const visualRequiredOwnerKeys = freezeCollectedOwnerKeys(
      visualRequired,
      ownerMetadataCache,
    );
    const visualPrefetchedOwnerKeys = freezeCollectedOwnerKeys(
      visualPrefetched,
      ownerMetadataCache,
    );
    const visualExpectedOwnerKeys = unionNormalizedOwnerKeys(
      ownerMetadataCache,
      visualRequiredOwnerKeys,
      visualPrefetchedOwnerKeys,
    );
    const visualExpectedOwnerSet = new Set(visualExpectedOwnerKeys);
    const coarsePrewarm = coverageFor(
      player,
      renderDistancePreset,
      STATIC_COARSE_SAFETY_MARGIN_METERS,
    );
    for (const ownerKey of visualExpectedOwnerSet) coarsePrewarm.delete(ownerKey);
    for (const ownerKey of [...coarsePrewarm]) {
      if (!required.has(ownerKey)) coarsePrewarm.delete(ownerKey);
    }
    const coarsePrewarmOwnerKeys = freezeCollectedOwnerKeys(
      coarsePrewarm,
      ownerMetadataCache,
    );
    const retainedOwnerKeys = unionNormalizedOwnerKeys(
      ownerMetadataCache,
      freezeCollectedOwnerKeys(retained, ownerMetadataCache),
      requiredOwnerKeys,
      prefetchedOwnerKeys,
    );
    const canonicalOnly = profile.horizonDistanceMeters === null;
    const resolved = {
      sourceHash: coverageKey,
      requiredRadiusMeters,
      visualRadiusMeters: presentationRadiusMeters,
      required: requiredOwnerKeys,
      prefetched: prefetchedOwnerKeys,
      retained: retainedOwnerKeys,
      visualRequired: visualRequiredOwnerKeys,
      visualPrefetched: visualPrefetchedOwnerKeys,
      visualExpected: visualExpectedOwnerKeys,
      coarsePrewarm: coarsePrewarmOwnerKeys,
      coarseFillInnerRadiusMeters:
        presentationRadiusMeters * STATIC_COARSE_FILL_INNER_RATIO,
      resourceKindEntries: Object.freeze(retainedOwnerKeys.map(ownerKey => Object.freeze([
        ownerKey,
        canonicalOnly || exactOwnerKeys.has(ownerKey) ? exactResourceKind : horizonResourceKind,
      ]))),
    };
    Object.defineProperty(resolved, 'resourceKindFor', {
      value: ownerKey => (canonicalOnly || exactOwnerKeys.has(ownerKey)
        ? exactResourceKind : horizonResourceKind),
      enumerable: false,
    });
    Object.defineProperty(resolved, 'isVisualRequired', {
      value: ownerKey => visualRequired.has(ownerKey),
      enumerable: false,
    });
    Object.defineProperty(resolved, 'isVisualExpected', {
      value: ownerKey => visualRequired.has(ownerKey) || visualPrefetched.has(ownerKey),
      enumerable: false,
    });
    Object.defineProperty(resolved, 'isCoarsePrewarm', {
      value: ownerKey => coarsePrewarm.has(ownerKey),
      enumerable: false,
    });
    Object.defineProperty(resolved, 'visualRadiusFor', {
      value: ownerKey => (visualExactOwnerKeys.has(ownerKey)
        ? profile.exactDistanceMeters
        : profile.horizonDistanceMeters),
      enumerable: false,
    });
    Object.freeze(resolved);
    coverageCache.set(coverageKey, resolved);
    while (coverageCache.size > 64) coverageCache.delete(coverageCache.keys().next().value);
    return resolved;
  };
  const policy = Object.freeze({
    schemaVersion: WORLD_STREAMING_POLICY_SCHEMA,
    kind,
    stream: WORLD_STREAMING_POLICY_STREAM.STATIC,
    distanceBands: Object.freeze({
      // The initial stationary 360-degree domain is a staged boot cohort, not
      // a steady-state deadline proof. StaticObjectStream derives exact
      // per-owner deadlines for velocity-corridor admission from owner AABB
      // entry time instead of assigning this entire domain one artificial
      // grace period.
      required: Object.freeze({ radiusChunks: requiredRadiusChunks, deadlineSeconds: null }),
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
    if (profile.horizonDistanceMeters === null) return exactResourceKind;
    const exact = policyPlan.velocityCorridor.distanceMeters > 0
      ? segmentIntersectsExpandedChunkAabb(
        coordinate.chunkX,
        coordinate.chunkZ,
        plan.player,
        policyPlan.velocityCorridor.endpoint,
        profile.exactDistanceMeters,
      )
      : staticChunkAabbIntersectsCircle(
        coordinate.chunkX,
        coordinate.chunkZ,
        plan.player.x,
        plan.player.z,
        profile.exactDistanceMeters,
      );
    return exact ? exactResourceKind : horizonResourceKind;
  };
  const maximumCoverage = renderDistancePreset => {
    const profile = distanceProfileResolver(renderDistancePreset);
    const corridorLengthMeters = velocityPrefetch.enabled
      ? velocityPrefetch.maximumDistanceMeters : 0;
    const canonical = maximumCorridorOwnerCount(
      profile.exactDistanceMeters + (profile.horizonDistanceMeters === null
        ? retentionMarginMeters : 0),
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
  const mergeOrdered = arrays => unionNormalizedOwnerKeys(ownerMetadataCache, ...arrays);
  const union = field => mergeOrdered(ordered.map(value => value[field]));
  const finiteDeadline = field => {
    const values = ordered.map(value => value.deadline[field]).filter(Number.isFinite);
    return values.length ? Math.min(...values) : null;
  };
  const requiredOwnerKeys = union('requiredOwnerKeys');
  const requiredOwnerSet = new Set(requiredOwnerKeys);
  const prefetchedOwnerKeys = union('prefetchedOwnerKeys')
    .filter(ownerKey => !requiredOwnerSet.has(ownerKey));
  const retainedOwnerKeys = union('retainedOwnerKeys');
  const requestOwnerKeys = mergeOrdered([requiredOwnerKeys, prefetchedOwnerKeys]);
  const visualRequiredOwnerKeys = mergeOrdered(ordered.map(member => (
    member.sourceSnapshot?.visualRequired ?? member.requiredOwnerKeys
  )));
  const visualExpectedOwnerKeys = mergeOrdered(ordered.map(member => (
    member.sourceSnapshot?.visualExpected
      ?? member.requestOwnerKeys
      ?? mergeOrdered([member.requiredOwnerKeys, member.prefetchedOwnerKeys])
  )));
  const visualRequiredOwnerSet = new Set(visualRequiredOwnerKeys);
  const visualExpectedOwnerSet = new Set(visualExpectedOwnerKeys);
  const coarsePrewarmOwnerKeys = mergeOrdered(ordered.map(member => (
    member.sourceSnapshot?.coarsePrewarm ?? Object.freeze([])
  ))).filter(ownerKey => !visualExpectedOwnerSet.has(ownerKey));
  const coarsePrewarmOwnerSet = new Set(coarsePrewarmOwnerKeys);
  const coarseFillInnerRadiusMeters = Math.max(0, ...ordered.map(member => (
    member.sourceSnapshot?.coarseFillInnerRadiusMeters ?? 0
  )));
  const merged = {
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
    allOwnerKeys: mergeOrdered([requestOwnerKeys, retainedOwnerKeys]),
    visualRequiredOwnerKeys,
    visualExpectedOwnerKeys,
    coarsePrewarmOwnerKeys: Object.freeze(coarsePrewarmOwnerKeys),
    coarseFillInnerRadiusMeters,
    deadline: Object.freeze({
      requiredAtMs: finiteDeadline('requiredAtMs'),
      prefetchedAtMs: finiteDeadline('prefetchedAtMs'),
    }),
    velocityCorridor: ordered[0].velocityCorridor,
  };
  Object.defineProperty(merged, 'isVisualRequired', {
    value: ownerKey => visualRequiredOwnerSet.has(ownerKey),
    enumerable: false,
  });
  Object.defineProperty(merged, 'isVisualExpected', {
    value: ownerKey => visualExpectedOwnerSet.has(ownerKey),
    enumerable: false,
  });
  Object.defineProperty(merged, 'isCoarsePrewarm', {
    value: ownerKey => coarsePrewarmOwnerSet.has(ownerKey),
    enumerable: false,
  });
  return Object.freeze(merged);
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
  const taskKeysByOwner = new Map();
  const queue = [];
  const tickets = new Map();
  let activeCount = 0;
  let epoch = 0;
  let coverageGeneration = 0;
  let planRevision = 0;
  let latestPlan = null;
  let latestPolicyPlan = null;
  let latestCoverageSignature = null;
  let latestSourceCoverageSignature = null;
  let latestResourceKindEntries = Object.freeze([]);
  let latestResourceKindByOwner = new Map();
  let latestResourceKindEntryByOwner = new Map();
  let latestOwnerDescriptorByKey = new Map();
  let latestPolicyResourceKindEntries = Object.freeze([]);
  let latestPolicyResourceEntryMaps = new Map();
  let latestPolicyDescriptorMaps = new Map();
  let latestRequestedOwnerKeys = new Set();
  let latestRequiredOwnerKeys = new Set();
  let latestAllOwnerKeys = new Set();
  let pendingAdmissionOwnerKeys = Object.freeze([]);
  let pendingAdmissionIndex = 0;
  let pendingAdmissionCoverageGeneration = 0;
  const pendingAdmissionSinceByOwner = new Map();
  // Coverage changes can arrive every 16 m while the bounded admission window
  // still has a large retained backlog. Keep the unadmitted cursor across
  // generations and only priority-sort identities whose scheduling class
  // actually changed. Re-sorting the entire retained cursor was an O(N log N)
  // main-thread spike on every owner-boundary crossing.
  let pendingAdmissionOwnerSet = new Set();
  const ownerTimingByOwner = new Map();
  let bootCohortOwnerKeys = null;
  let bootCohortStartedAtMs = null;
  let maximumPendingTaskAgeMs = 0;
  let maximumAdmissionCursorAgeMs = 0;
  let latestApplyDiff = Object.freeze({
    enteringOwnerCount: 0,
    leavingOwnerCount: 0,
    unchangedOwnerCount: 0,
    classifiedOwnerCount: 0,
    sortTargetOwnerCount: 0,
    queueCandidateCount: 0,
    retainedAdmissionOwnerCount: 0,
    freshAdmissionOwnerCount: 0,
    queueInsertionCount: 0,
  });
  let applyAttemptSequence = 0;
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
    enteringOwners: 0,
    leavingOwners: 0,
    unchangedOwners: 0,
    sortTargetOwners: 0,
    queueInsertions: 0,
    readyPageQueueCalls: 0,
    readyPageQueueInsertions: 0,
    readyPageQueueReuses: 0,
    sourceCoverageFastPaths: 0,
    enqueueCalls: 0,
    admissionCursorReplacements: 0,
    admissionCursorSkips: 0,
    admissionCursorRetainedOwners: 0,
    admissionCursorFreshOwners: 0,
    supersededApplies: 0,
  };

  const taskKey = (ownerKey, resourceKind) => `${resourceKind}\n${ownerKey}`;
  const ownerEntrySeconds = (owner, player, velocity, radiusMeters) => {
    if (!(radiusMeters >= 0)) return null;
    return staticMovingPointChunkAabbEntrySeconds({
      chunkX: owner.chunkX,
      chunkZ: owner.chunkZ,
      player,
      velocity,
      radiusMeters,
    });
  };
  const ownerDistanceSquared = (owner, player) => {
    const minimumX = owner.chunkX * LOGICAL_CHUNK_SIZE_METERS;
    const minimumZ = owner.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const maximumX = minimumX + LOGICAL_CHUNK_SIZE_METERS;
    const maximumZ = minimumZ + LOGICAL_CHUNK_SIZE_METERS;
    const closestX = Math.max(minimumX, Math.min(maximumX, player.x));
    const closestZ = Math.max(minimumZ, Math.min(maximumZ, player.z));
    return (closestX - player.x) ** 2 + (closestZ - player.z) ** 2;
  };
  const coarseFillBandFor = ({
    deadlineAtMs,
    visualExpected,
    coarsePrewarm,
    owner,
    plan,
    policyPlan,
  }) => {
    if (Number.isFinite(deadlineAtMs)) return 0;
    if (visualExpected === true && ownerDistanceSquared(owner, plan.player)
      <= policyPlan.coarseFillInnerRadiusMeters ** 2) return 1;
    if (coarsePrewarm === true) return 2;
    if (visualExpected === true) return 3;
    return 4;
  };
  const derivedOwnerTiming = (
    ownerKey,
    owner,
    plan,
    policyPlan,
    _coverageRequired,
    bootKeys = bootCohortOwnerKeys,
  ) => {
    const previous = ownerTimingByOwner.get(ownerKey);
    const visualRequired = policyPlan.isVisualRequired?.(ownerKey)
      ?? policyPlan.requiredOwnerKeys.includes(ownerKey);
    const visualExpected = policyPlan.isVisualExpected?.(ownerKey)
      ?? policyPlan.requestOwnerKeys.includes(ownerKey);
    const coarsePrewarm = policyPlan.isCoarsePrewarm?.(ownerKey) ?? false;
    // bootCohortOwnerKeys remains the immutable metrics identity, but boot
    // exemption lasts only while that identity is continuously Visual
    // Expected. Leaving the visual domain converts it to steady timing, so a
    // later corridor re-entry receives its real deadline.
    const initialBootApply = bootCohortOwnerKeys === null;
    if (bootKeys?.has(ownerKey) && visualExpected
      && (initialBootApply || previous?.cohort === 'boot')) {
      return previous ?? Object.freeze({
        ownerKey,
        cohort: 'boot',
        expectedAt: plan.generatedAtMs,
        firstPossibleVisibleAt: plan.generatedAtMs,
        deadlineAtMs: null,
        required: true,
        visualExpected: true,
        coarsePrewarm: false,
        coarseFillBand: coarseFillBandFor({
          deadlineAtMs: null,
          visualExpected: true,
          coarsePrewarm: false,
          owner,
          plan,
          policyPlan,
        }),
      });
    }
    let firstPossibleVisibleAt = Number.POSITIVE_INFINITY;
    for (const member of visualExpected ? policyPlan.memberPolicyPlans : []) {
      const sourceSnapshot = member.sourceSnapshot;
      const memberVisualExpected = sourceSnapshot?.isVisualExpected?.(ownerKey)
        ?? (sourceSnapshot?.visualExpected
          ?? member.requestOwnerKeys
          ?? member.requiredOwnerKeys).includes(ownerKey);
      if (!memberVisualExpected) continue;
      const radiusMeters = sourceSnapshot?.visualRadiusFor?.(ownerKey)
        ?? sourceSnapshot?.visualRadiusMeters
        ?? sourceSnapshot?.requiredRadiusMeters;
      const entrySeconds = ownerEntrySeconds(
        owner,
        plan.player,
        plan.velocity,
        radiusMeters,
      );
      if (entrySeconds !== null) {
        firstPossibleVisibleAt = Math.min(
          firstPossibleVisibleAt,
          plan.generatedAtMs + entrySeconds * 1_000,
        );
      }
    }
    if (!Number.isFinite(firstPossibleVisibleAt)) {
      if (visualExpected && !visualRequired) {
        const evidence = policyPlan.memberPolicyPlans.map(member => {
          const sourceSnapshot = member.sourceSnapshot;
          const memberVisualExpected = sourceSnapshot?.isVisualExpected?.(ownerKey)
            ?? (sourceSnapshot?.visualExpected
              ?? member.requestOwnerKeys
              ?? member.requiredOwnerKeys).includes(ownerKey);
          const radiusMeters = sourceSnapshot?.visualRadiusFor?.(ownerKey)
            ?? sourceSnapshot?.visualRadiusMeters
            ?? sourceSnapshot?.requiredRadiusMeters;
          return Object.freeze({
            kind: member.kind,
            memberVisualExpected,
            radiusMeters,
            entrySeconds: memberVisualExpected ? ownerEntrySeconds(
              owner,
              plan.player,
              plan.velocity,
              radiusMeters,
            ) : null,
          });
        });
        throw new Error(`visual Expected owner has no exact entry: ${JSON.stringify({
          ownerKey,
          owner,
          player: plan.player,
          velocity: plan.velocity,
          evidence,
        })}`);
      }
      firstPossibleVisibleAt = visualRequired ? plan.generatedAtMs : null;
    }
    if (previous && previous.cohort !== 'boot' && visualRequired) {
      firstPossibleVisibleAt = Number.isFinite(previous.firstPossibleVisibleAt)
        ? Math.min(previous.firstPossibleVisibleAt, firstPossibleVisibleAt ?? Number.POSITIVE_INFINITY)
        : firstPossibleVisibleAt;
    }
    return Object.freeze({
      ownerKey,
      cohort: 'steady',
      expectedAt: plan.generatedAtMs,
      firstPossibleVisibleAt,
      deadlineAtMs: firstPossibleVisibleAt,
      required: visualRequired,
      visualExpected,
      coarsePrewarm,
      coarseFillBand: coarseFillBandFor({
        deadlineAtMs: firstPossibleVisibleAt,
        visualExpected,
        coarsePrewarm,
        owner,
        plan,
        policyPlan,
      }),
    });
  };
  const ownerDeadlineAtMs = (ownerKey, required) => {
    const timing = ownerTimingByOwner.get(ownerKey);
    return timing?.required === required ? timing.deadlineAtMs : timing?.deadlineAtMs ?? null;
  };
  // Coverage membership remains the immutable Expected denominator. Visual
  // Expected work always belongs to the coordinator's coarse-existence class;
  // only real entry ETA supplies a deadline. Resource-only margin work remains
  // staged prefetch, so boot does not invent simultaneous deadlines for the
  // complete resident Resource window.
  const schedulerRequiredFor = (deadlineAtMs, timing = null) => (
    Number.isFinite(deadlineAtMs)
      || timing?.visualExpected === true
      || timing?.coarsePrewarm === true
  );
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
    counts.readyPageQueueCalls += 1;
    if (!resource || !latestRequestedOwnerKeys.has(resource.ownerKey)) return false;
    if (latestResourceKindByOwner.get(resource.ownerKey) !== resource.resourceKind) {
      counts.staleResultDiscards += 1;
      return false;
    }
    const required = latestRequiredOwnerKeys.has(resource.ownerKey);
    const deadlineAtMs = ownerDeadlineAtMs(resource.ownerKey, required);
    const schedulerRequired = schedulerRequiredFor(
      deadlineAtMs,
      ownerTimingByOwner.get(resource.ownerKey),
    );
    const coarseFillBand = ownerTimingByOwner.get(resource.ownerKey)?.coarseFillBand ?? 4;
    const key = taskKey(resource.ownerKey, resource.resourceKind);
    const queued = readyPageQueue.get(key);
    if (queued?.value === resource.value && queued.required === required
      && queued.schedulerRequired === schedulerRequired
      && queued.coarseFillBand === coarseFillBand
      && queued.deadlineAtMs === deadlineAtMs) {
      counts.readyPageQueueReuses += 1;
      return false;
    }
    readyPageQueue.set(key, Object.freeze({
      ...resource,
      required,
      schedulerRequired,
      coarseFillBand,
      deadlineAtMs,
    }));
    counts.readyPageQueueInsertions += 1;
    return true;
  };
  const createTicket = (ownerKey, resourceKind) => {
    if (!latestPlan || !latestPolicyPlan) return null;
    const key = taskKey(ownerKey, resourceKind);
    let ticket = tickets.get(key);
    if (ticket) {
      ticket.ticketId = `${coverageGeneration}:${policyKind}:${resourceKind}:${ownerKey}`;
      ticket.planId = latestPlan.planId;
      ticket.planRevision = planRevision;
      ticket.coverageGeneration = coverageGeneration;
      ticket.publicationSequence = currentPublicationSequence();
      ticket.stateRevision = currentStateRevision();
      ticket.originGeneration = currentOriginGeneration();
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
    const ownerTaskKeys = taskKeysByOwner.get(task.ownerKey);
    ownerTaskKeys?.delete(task.key);
    if (ownerTaskKeys?.size === 0) taskKeysByOwner.delete(task.ownerKey);
    staleTaskKeys.delete(task.key);
    if (state === 'ready') {
      const readyAtMs = clock();
      const retainedByLatestCoverage = latestRequestedOwnerKeys.has(task.ownerKey)
        && latestResourceKindByOwner.get(task.ownerKey) === task.resourceKind;
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
  const pendingAdmissionCount = () => (
    pendingAdmissionCoverageGeneration === coverageGeneration
      ? Math.max(0, pendingAdmissionOwnerKeys.length - pendingAdmissionIndex)
      : 0
  );
  const fillAdmissionWindow = () => {
    if (disposed || pendingAdmissionCoverageGeneration !== coverageGeneration) return 0;
    let admitted = 0;
    while (tasks.size < maximumConcurrentRequests
      && pendingAdmissionIndex < pendingAdmissionOwnerKeys.length) {
      const ownerKey = pendingAdmissionOwnerKeys[pendingAdmissionIndex++];
      pendingAdmissionOwnerSet.delete(ownerKey);
      pendingAdmissionSinceByOwner.delete(ownerKey);
      if (!latestRequestedOwnerKeys.has(ownerKey)) {
        counts.admissionCursorSkips += 1;
        continue;
      }
      const descriptor = latestOwnerDescriptorByKey.get(ownerKey);
      const resourceKind = latestResourceKindByOwner.get(ownerKey);
      if (!descriptor || typeof resourceKind !== 'string') {
        counts.admissionCursorSkips += 1;
        continue;
      }
      const key = taskKey(ownerKey, resourceKind);
      if (tasks.has(key)) {
        counts.admissionCursorSkips += 1;
        continue;
      }
      const required = latestRequiredOwnerKeys.has(ownerKey);
      const deadlineAtMs = ownerDeadlineAtMs(ownerKey, required);
      enqueue({
        ownerKey,
        ownerX: descriptor.ownerX,
        ownerZ: descriptor.ownerZ,
        resourceKind,
        required,
        schedulerRequired: schedulerRequiredFor(
          deadlineAtMs,
          ownerTimingByOwner.get(ownerKey),
        ),
        deadlineAtMs,
        planId: latestPlan.planId,
        publicationGroup: latestPolicyPlan.publicationGroup,
        pumpNow: false,
      });
      admitted += Number(tasks.has(key));
    }
    return admitted;
  };
  const pump = () => {
    if (disposed) return;
    fillAdmissionWindow();
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
          priority: task.schedulerRequired ? requiredPriority : prefetchedPriority,
          required: task.schedulerRequired,
          coverageRequired: task.required,
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
    schedulerRequired = schedulerRequiredFor(
      deadlineAtMs,
      ownerTimingByOwner.get(ownerKey),
    ),
    planId,
    publicationGroup,
    pumpNow = true,
  }) => {
    counts.enqueueCalls += 1;
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
      const requirementPromoted = required && !existing.required;
      const schedulingPromoted = schedulerRequired && !existing.schedulerRequired;
      if (requirementPromoted || schedulingPromoted) {
        existing.required ||= required;
        existing.schedulerRequired ||= schedulerRequired;
        if (deadlineAtMs !== null
          && (existing.deadlineAtMs === null || deadlineAtMs < existing.deadlineAtMs)) {
          existing.deadlineAtMs = deadlineAtMs;
        }
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
      schedulerRequired,
      deadlineAtMs,
      planId,
      publicationGroup,
      epoch,
      createdAtMs: clock(),
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
    let ownerTaskKeys = taskKeysByOwner.get(ownerKey);
    if (!ownerTaskKeys) {
      ownerTaskKeys = new Set();
      taskKeysByOwner.set(ownerKey, ownerTaskKeys);
    }
    ownerTaskKeys.add(key);
    queue.push(task);
    counts.queueInsertions += 1;
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
      const retainedWithCurrentKind = latestRequestedOwnerKeys.has(task.ownerKey)
        && latestResourceKindByOwner.get(task.ownerKey) === task.resourceKind;
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
    const applyAttempt = ++applyAttemptSequence;
    let stagedPublicationContext = publicationContext;
    if (stagedPublicationContext === null && (!publicationContextPendingForPlan
      || !latestPublicationContext
      || latestPublicationContext.stateRevision !== plan.stateRevision
      || latestPublicationContext.originGeneration !== plan.originGeneration)) {
      stagedPublicationContext = Object.freeze({
        schemaVersion: WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA,
        sequence: (latestPublicationContext?.sequence ?? 0) + 1,
        generatedAtMs: Number.isFinite(plan.generatedAtMs) ? plan.generatedAtMs : clock(),
        stateRevision: plan.stateRevision ?? 0,
        destructionRevision: latestPublicationContext?.destructionRevision ?? null,
        originGeneration: plan.originGeneration ?? 0,
      });
    } else if (stagedPublicationContext === null) {
      stagedPublicationContext = latestPublicationContext;
    }
    if (stagedPublicationContext?.schemaVersion !== WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA) {
      throw new TypeError(
        `Static Object Stream requires ${WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA}`,
      );
    }
    if (latestPublicationContext
      && stagedPublicationContext.sequence < latestPublicationContext.sequence) {
      return false;
    }
    const selectedPolicyPlans = policyPlans ?? (policyPlan ? [policyPlan] : []);
    const sourceCoverageSignature = selectedPolicyPlans.every(member => (
      typeof member?.sourceHash === 'string' && member.sourceHash.length > 0
    )) ? `${plan.renderDistancePreset}|${selectedPolicyPlans.map(member => (
        `${member.kind}:${member.sourceHash}`
      )).join('|')}` : null;
    if (latestPolicyPlan !== null && sourceCoverageSignature !== null
      && sourceCoverageSignature === latestSourceCoverageSignature) {
      if (applyAttempt !== applyAttemptSequence) {
        counts.supersededApplies += 1;
        return false;
      }
      const stagedPublicationContextChanged = stagedPublicationContext !== latestPublicationContext;
      if (stagedPublicationContextChanged) {
        latestPublicationContext = stagedPublicationContext;
        counts.publicationContextUpdates += 1;
        counts.publicationFastPathUpdates += 1;
      }
      publicationContextPendingForPlan = false;
      latestPlan = plan;
      planRevision += 1;
      counts.unchangedPlans += 1;
      counts.sourceCoverageFastPaths += 1;
      const unchangedOwnerCount = [...latestPolicyDescriptorMaps.values()].reduce(
        (sum, descriptors) => sum + descriptors.size,
        0,
      );
      counts.unchangedOwners += unchangedOwnerCount;
      latestApplyDiff = Object.freeze({
        enteringOwnerCount: 0,
        leavingOwnerCount: 0,
        unchangedOwnerCount,
        classifiedOwnerCount: 0,
        sortTargetOwnerCount: 0,
        queueCandidateCount: 0,
        retainedAdmissionOwnerCount: 0,
        freshAdmissionOwnerCount: 0,
        queueInsertionCount: 0,
      });
      cancelMatureStaleTasks();
      pump();
      return false;
    }
    const mergedPolicyPlan = mergePolicyPlanCoverage(
      policyKind,
      memberPolicyKinds,
      selectedPolicyPlans,
      ownerMetadataCache,
    );
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
    const policyDiffs = policyPlan.memberPolicyPlans.map(member => {
      const previousDescriptors = latestPolicyDescriptorMaps.get(member.kind) ?? new Map();
      const nextOwnerSet = new Set(member.allOwnerKeys);
      let resourceKindHintFor = typeof member.resourceKindFor === 'function'
        ? member.resourceKindFor : null;
      if (resourceKindHintFor === null && member.resourceKindEntries != null) {
        const resourceKindHints = new Map(member.resourceKindEntries);
        resourceKindHintFor = resourceKindHints.get.bind(resourceKindHints);
      }
      const resourceKindTransitions = resourceKindHintFor === null ? new Set() : new Set(
        member.allOwnerKeys.filter(ownerKey => {
          const previous = previousDescriptors.get(ownerKey);
          return previous && previous.resourceKind !== resourceKindHintFor(ownerKey);
        }),
      );
      const enteringOwnerKeys = member.allOwnerKeys.filter(ownerKey => (
        !previousDescriptors.has(ownerKey) || resourceKindTransitions.has(ownerKey)
      ));
      const leavingOwnerKeys = [...previousDescriptors.keys()].filter(ownerKey => (
        !nextOwnerSet.has(ownerKey) || resourceKindTransitions.has(ownerKey)
      ));
      return {
        member,
        previousDescriptors,
        nextOwnerSet,
        resourceKindHintFor,
        enteringOwnerKeys,
        leavingOwnerKeys,
        unchangedOwnerCount: member.allOwnerKeys.length - enteringOwnerKeys.length,
      };
    });
    const enteringOwnerCount = policyDiffs.reduce(
      (sum, diff) => sum + diff.enteringOwnerKeys.length, 0,
    );
    const leavingOwnerCount = policyDiffs.reduce(
      (sum, diff) => sum + diff.leavingOwnerKeys.length, 0,
    );
    const unchangedOwnerCount = policyDiffs.reduce(
      (sum, diff) => sum + diff.unchangedOwnerCount, 0,
    );
    // Callers without a stable coverage revision may provide classifiers whose
    // output changes independently from owner coverage. Preserve that generic
    // fallback when the owner sets alone cannot expose the change.
    const forceFullClassification = latestPlan !== null
      && ownerMetadataRevision === null
      && policyDiffs.some(diff => diff.resourceKindHintFor === null)
      && enteringOwnerCount === 0
      && leavingOwnerCount === 0;
    const changedPolicyOwners = new Set();
    const stagedDescriptorsByPolicy = new Map();
    const policyDiffByKind = new Map(policyDiffs.map(diff => [diff.member.kind, diff]));
    const resourceEntryMapsByPolicy = new Map();
    const retainedClassificationDescriptors = [];
    let classifiedOwnerCount = 0;
    let coverageOwnerEntryAllocationCount = 0;
    const nextPolicyResourceKindEntries = Object.freeze(policyDiffs.map(diff => {
      const stagedDescriptors = new Map();
      const resourceEntries = diff.member.resourceKindEntries == null ? new Map() : null;
      const previousResourceEntries = latestPolicyResourceEntryMaps.get(diff.member.kind)
        ?? new Map();
      for (const ownerKey of diff.leavingOwnerKeys) changedPolicyOwners.add(ownerKey);
      const ownersToClassify = forceFullClassification
        ? diff.member.allOwnerKeys : diff.enteringOwnerKeys;
      for (const ownerKey of ownersToClassify) {
        const coordinate = coordinateFor(ownerKey);
        const descriptor = ownerMetadataCache?.classify({
          ownerKey,
          policyKind: diff.member.kind,
          revision: classificationRevision,
          coordinate,
          path: 'static-object-stream:policy-classification',
          classifier: owner => classifyOwner({
            ownerKey,
            owner,
            plan,
            policyPlan: diff.member,
            policyPlans: Object.freeze([diff.member]),
          }),
        }) ?? Object.freeze({
          ...coordinate,
          policyKind: diff.member.kind,
          resourceKind: classifyOwner({
            ownerKey,
            owner: coordinate,
            plan,
            policyPlan: diff.member,
            policyPlans: Object.freeze([diff.member]),
          }),
          classificationRevision,
        });
        stagedDescriptors.set(ownerKey, descriptor);
        classifiedOwnerCount += 1;
        changedPolicyOwners.add(ownerKey);
        retainedClassificationDescriptors.push(descriptor);
      }
      stagedDescriptorsByPolicy.set(diff.member.kind, stagedDescriptors);
      if (resourceEntries !== null) {
        for (const ownerKey of diff.member.allOwnerKeys) {
          const descriptor = stagedDescriptors.get(ownerKey)
            ?? diff.previousDescriptors.get(ownerKey);
          let resourceEntry = previousResourceEntries.get(ownerKey);
          if (resourceEntry?.[1] !== descriptor.resourceKind) {
            resourceEntry = Object.freeze([descriptor.ownerKey, descriptor.resourceKind]);
            coverageOwnerEntryAllocationCount += 1;
          }
          resourceEntries.set(ownerKey, resourceEntry);
        }
        resourceEntryMapsByPolicy.set(diff.member.kind, resourceEntries);
      }
      return Object.freeze({
        policyKind: diff.member.kind,
        resourceKindEntries: diff.member.resourceKindEntries ?? Object.freeze(
          diff.member.allOwnerKeys.map(ownerKey => resourceEntries.get(ownerKey)),
        ),
      });
    }));
    if (applyAttempt !== applyAttemptSequence) {
      counts.supersededApplies += 1;
      return false;
    }
    const nextOwnerDescriptors = Object.freeze(policyPlan.allOwnerKeys.map(ownerKey => {
      const previous = latestOwnerDescriptorByKey.get(ownerKey);
      if (!changedPolicyOwners.has(ownerKey) && previous) return previous;
      const policyDescriptors = [];
      for (const member of policyPlan.memberPolicyPlans) {
        const diff = policyDiffByKind.get(member.kind);
        if (!diff.nextOwnerSet.has(ownerKey)) continue;
        policyDescriptors.push(stagedDescriptorsByPolicy.get(member.kind).get(ownerKey)
          ?? diff.previousDescriptors.get(ownerKey));
      }
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
      if (previous?.resourceKind === resourceKind) return previous;
      return Object.freeze({ ...coordinateFor(ownerKey), resourceKind });
    }));
    const nextOwnerDescriptorByKey = new Map();
    const nextResourceKindEntryByOwner = new Map();
    const nextResourceKindEntries = Object.freeze(nextOwnerDescriptors.map(descriptor => {
      nextOwnerDescriptorByKey.set(descriptor.ownerKey, descriptor);
      let entry = latestResourceKindEntryByOwner.get(descriptor.ownerKey);
      if (entry?.[1] !== descriptor.resourceKind) {
        entry = Object.freeze([descriptor.ownerKey, descriptor.resourceKind]);
        coverageOwnerEntryAllocationCount += 1;
      }
      nextResourceKindEntryByOwner.set(descriptor.ownerKey, entry);
      return entry;
    }));
    const nextResourceKindByOwner = new Map(nextResourceKindEntries);
    const visuallyEnteringOwnerKeys = new Set(
      (policyPlan.visualExpectedOwnerKeys ?? []).filter(ownerKey => (
        ownerTimingByOwner.get(ownerKey)?.visualExpected !== true
      )),
    );
    const coarsePrewarmEnteringOwnerKeys = new Set(
      (policyPlan.coarsePrewarmOwnerKeys ?? []).filter(ownerKey => (
        ownerTimingByOwner.get(ownerKey)?.coarsePrewarm !== true
      )),
    );
    const priorityEnteringOwnerKeys = new Set([
      ...visuallyEnteringOwnerKeys,
      ...coarsePrewarmEnteringOwnerKeys,
    ]);
    const nextSignature = ownerMetadataRevision === null
      ? coverageSignature(plan, policyPlan, nextResourceKindEntries, ownerMetadataCache)
      : `immutable-coverage:${ownerMetadataRevision}`;
    const stagedPublicationContextChanged = stagedPublicationContext !== latestPublicationContext;
    const commitPolicyDescriptorMaps = () => {
      const committed = new Map(latestPolicyDescriptorMaps);
      for (const diff of policyDiffs) {
        const descriptors = diff.previousDescriptors;
        for (const ownerKey of diff.leavingOwnerKeys) descriptors.delete(ownerKey);
        for (const [ownerKey, descriptor] of stagedDescriptorsByPolicy.get(diff.member.kind)) {
          descriptors.set(ownerKey, descriptor);
        }
        committed.set(diff.member.kind, descriptors);
      }
      return committed;
    };
    if (nextSignature === latestCoverageSignature && priorityEnteringOwnerKeys.size === 0) {
      if (applyAttempt !== applyAttemptSequence) {
        counts.supersededApplies += 1;
        return false;
      }
      ownerMetadataCache?.retainClassificationRevision({
        revision: classificationRevision,
        descriptors: retainedClassificationDescriptors,
      });
      if (stagedPublicationContextChanged) {
        latestPublicationContext = stagedPublicationContext;
        counts.publicationContextUpdates += 1;
        if (latestCoverageSignature !== null) counts.publicationFastPathUpdates += 1;
      }
      publicationContextPendingForPlan = false;
      latestPlan = plan;
      latestPolicyPlan = policyPlan;
      latestPolicyDescriptorMaps = commitPolicyDescriptorMaps();
      latestPolicyResourceEntryMaps = resourceEntryMapsByPolicy;
      latestResourceKindEntryByOwner = nextResourceKindEntryByOwner;
      latestPolicyResourceKindEntries = nextPolicyResourceKindEntries;
      latestSourceCoverageSignature = sourceCoverageSignature;
      planRevision += 1;
      counts.unchangedPlans += 1;
      counts.coverageMerges += 1;
      counts.resourceKindClassifications += classifiedOwnerCount;
      counts.coverageOwnerEntryAllocations += coverageOwnerEntryAllocationCount;
      if (ownerMetadataRevision === null) counts.coverageSignatures += 1;
      counts.enteringOwners += enteringOwnerCount;
      counts.leavingOwners += leavingOwnerCount;
      counts.unchangedOwners += unchangedOwnerCount;
      latestApplyDiff = Object.freeze({
        enteringOwnerCount,
        leavingOwnerCount,
        unchangedOwnerCount,
        classifiedOwnerCount,
        sortTargetOwnerCount: 0,
        queueCandidateCount: 0,
        retainedAdmissionOwnerCount: 0,
        freshAdmissionOwnerCount: 0,
        queueInsertionCount: 0,
      });
      for (const ownerKey of policyPlan.requestOwnerKeys) {
        const required = policyPlan.requiredOwnerKeys.includes(ownerKey);
        ownerTimingByOwner.set(ownerKey, derivedOwnerTiming(
          ownerKey,
          nextOwnerDescriptorByKey.get(ownerKey),
          plan,
          policyPlan,
          required,
        ));
        const task = tasks.get(taskKey(ownerKey, nextResourceKindByOwner.get(ownerKey)));
        if (task) {
          task.required = required;
          task.deadlineAtMs = ownerDeadlineAtMs(ownerKey, required);
          task.schedulerRequired = schedulerRequiredFor(
            task.deadlineAtMs,
            ownerTimingByOwner.get(ownerKey),
          );
          if (task.schedulerRequired) promoteQueuedTask(task);
        }
      }
      cancelMatureStaleTasks();
      pump();
      return false;
    }
    const required = new Set(policyPlan.requiredOwnerKeys);
    const retained = new Set(policyPlan.allOwnerKeys);
    const stagedBootCohortOwnerKeys = bootCohortOwnerKeys
      ?? new Set(policyPlan.visualRequiredOwnerKeys);
    const stagedOwnerTimingByOwner = new Map(ownerTimingByOwner);
    for (const ownerKey of policyPlan.requestOwnerKeys) {
      stagedOwnerTimingByOwner.set(ownerKey, derivedOwnerTiming(
        ownerKey,
        nextOwnerDescriptorByKey.get(ownerKey),
        plan,
        policyPlan,
        required.has(ownerKey),
        stagedBootCohortOwnerKeys,
      ));
    }
    const previousRequestedOwnerKeys = latestRequestedOwnerKeys;
    const previousRequiredOwnerKeys = latestRequiredOwnerKeys;
    const previousResourceKindByOwner = latestResourceKindByOwner;
    const nextRequestedOwnerKeys = new Set(policyPlan.requestOwnerKeys);
    const previousPendingAdmissionOwnerKeys = pendingAdmissionCoverageGeneration === coverageGeneration
      ? pendingAdmissionOwnerKeys.slice(pendingAdmissionIndex)
      : [];
    const requiredEnteringOwnerKeys = new Set(
      policyPlan.requiredOwnerKeys.filter(ownerKey => !previousRequiredOwnerKeys.has(ownerKey)),
    );
    const retainedPendingOwnerKeys = [];
    const retainedPendingOwnerSet = new Set();
    for (const ownerKey of previousPendingAdmissionOwnerKeys) {
      const nextResourceKind = nextResourceKindByOwner.get(ownerKey);
      const key = typeof nextResourceKind === 'string'
        ? taskKey(ownerKey, nextResourceKind) : null;
      const schedulingClassChanged = priorityEnteringOwnerKeys.has(ownerKey)
        || requiredEnteringOwnerKeys.has(ownerKey);
      if (!nextRequestedOwnerKeys.has(ownerKey)
        || previousResourceKindByOwner.get(ownerKey) !== nextResourceKind
        || schedulingClassChanged
        || (key !== null && (ready.has(key) || tasks.has(key)))) continue;
      retainedPendingOwnerKeys.push(ownerKey);
      retainedPendingOwnerSet.add(ownerKey);
    }
    const freshQueueCandidateOwnerKeys = policyPlan.requestOwnerKeys.filter(ownerKey => {
      if (retainedPendingOwnerSet.has(ownerKey)) return false;
      const nextResourceKind = nextResourceKindByOwner.get(ownerKey);
      const key = taskKey(ownerKey, nextResourceKind);
      const wasPending = pendingAdmissionOwnerSet.has(ownerKey);
      return !latestRequestedOwnerKeys.has(ownerKey)
        || latestResourceKindByOwner.get(ownerKey) !== nextResourceKind
        || (requiredEnteringOwnerKeys.has(ownerKey)
          && !ready.has(key)
          && !tasks.has(key))
        || (wasPending && !ready.has(key) && !tasks.has(key))
        || (priorityEnteringOwnerKeys.has(ownerKey)
          && !ready.has(key)
          && !tasks.has(key));
    });
    const compareRequestPriority = (left, right) => {
      const leftOwner = nextOwnerDescriptorByKey.get(left);
      const rightOwner = nextOwnerDescriptorByKey.get(right);
      const leftTiming = stagedOwnerTimingByOwner.get(left);
      const rightTiming = stagedOwnerTimingByOwner.get(right);
      const leftSchedulerRequired = schedulerRequiredFor(leftTiming?.deadlineAtMs, leftTiming);
      const rightSchedulerRequired = schedulerRequiredFor(rightTiming?.deadlineAtMs, rightTiming);
      const leftDistanceSquared = ownerDistanceSquared(leftOwner, plan.player);
      const rightDistanceSquared = ownerDistanceSquared(rightOwner, plan.player);
      return Number(rightSchedulerRequired) - Number(leftSchedulerRequired)
        || (leftTiming?.deadlineAtMs ?? Number.POSITIVE_INFINITY)
          - (rightTiming?.deadlineAtMs ?? Number.POSITIVE_INFINITY)
        || (leftTiming?.coarseFillBand ?? 4) - (rightTiming?.coarseFillBand ?? 4)
        || Number(required.has(right)) - Number(required.has(left))
        || leftDistanceSquared - rightDistanceSquared
        || leftOwner.chunkZ - rightOwner.chunkZ
        || leftOwner.chunkX - rightOwner.chunkX;
    };
    // Existing unadmitted work keeps its prior deterministic order. Only new
    // or scheduling-class-changed identities are re-ranked for this coverage
    // generation. Put that fresh frontier first so movement never leaves newly
    // visible/required owners behind a large stale prefetch cursor.
    freshQueueCandidateOwnerKeys.sort(compareRequestPriority);
    const queueCandidateOwnerKeys = Object.freeze([
      ...freshQueueCandidateOwnerKeys,
      ...retainedPendingOwnerKeys,
    ]);
    if (applyAttempt !== applyAttemptSequence) {
      counts.supersededApplies += 1;
      return false;
    }
    ownerMetadataCache?.retainClassificationRevision({
      revision: classificationRevision,
      descriptors: retainedClassificationDescriptors,
    });
    // No stream plan state has changed above. Only commit the new coverage
    // after classification, signature construction, and ordering succeed.
    if (stagedPublicationContextChanged) {
      latestPublicationContext = stagedPublicationContext;
      counts.publicationContextUpdates += 1;
      if (latestCoverageSignature !== null) counts.publicationFastPathUpdates += 1;
    }
    publicationContextPendingForPlan = false;
    epoch += 1;
    coverageGeneration += 1;
    planRevision += 1;
    latestPlan = plan;
    latestPolicyPlan = policyPlan;
    latestCoverageSignature = nextSignature;
    latestSourceCoverageSignature = sourceCoverageSignature;
    latestResourceKindEntries = nextResourceKindEntries;
    latestResourceKindByOwner = nextResourceKindByOwner;
    latestResourceKindEntryByOwner = nextResourceKindEntryByOwner;
    latestOwnerDescriptorByKey = nextOwnerDescriptorByKey;
    latestPolicyResourceKindEntries = nextPolicyResourceKindEntries;
    latestPolicyResourceEntryMaps = resourceEntryMapsByPolicy;
    latestPolicyDescriptorMaps = commitPolicyDescriptorMaps();
    latestRequestedOwnerKeys = nextRequestedOwnerKeys;
    latestRequiredOwnerKeys = required;
    latestAllOwnerKeys = retained;
    if (bootCohortOwnerKeys === null) {
      bootCohortOwnerKeys = stagedBootCohortOwnerKeys;
      bootCohortStartedAtMs = plan.generatedAtMs;
    }
    ownerTimingByOwner.clear();
    for (const [ownerKey, timing] of stagedOwnerTimingByOwner) {
      if (nextRequestedOwnerKeys.has(ownerKey)) ownerTimingByOwner.set(ownerKey, timing);
    }
    // A resident Resource-margin page may have been consumed by the existing
    // coarse publisher before that owner entered the 300 m Visual domain. Put
    // its immutable cached page back on the same ready-page bridge so the new
    // Expected record can derive requirements; no generation or second queue
    // is introduced.
    for (const ownerKey of priorityEnteringOwnerKeys) {
      const resourceKind = nextResourceKindByOwner.get(ownerKey);
      queueReadyPage(ready.get(taskKey(ownerKey, resourceKind)));
    }
    pendingAdmissionOwnerKeys = queueCandidateOwnerKeys;
    pendingAdmissionIndex = 0;
    pendingAdmissionCoverageGeneration = coverageGeneration;
    pendingAdmissionOwnerSet = new Set(queueCandidateOwnerKeys);
    for (const ownerKey of freshQueueCandidateOwnerKeys) {
      pendingAdmissionSinceByOwner.set(
        ownerKey,
        pendingAdmissionSinceByOwner.get(ownerKey) ?? plan.generatedAtMs,
      );
    }
    for (const ownerKey of [...pendingAdmissionSinceByOwner.keys()]) {
      if (!nextRequestedOwnerKeys.has(ownerKey)) pendingAdmissionSinceByOwner.delete(ownerKey);
    }
    counts.admissionCursorReplacements += 1;
    const supersededQueuedTasks = [...queue].filter(task => (
      task.state === 'queued'
        && (!nextRequestedOwnerKeys.has(task.ownerKey)
          || nextResourceKindByOwner.get(task.ownerKey) !== task.resourceKind)
    ));
    for (const task of supersededQueuedTasks) {
      if (tasks.get(task.key) !== task || task.state !== 'queued') continue;
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
      task.cancellationRequested = true;
      settleTask(task, 'cancelled');
      counts.stalePlanCancels += 1;
      counts.stableCoverageCancels += 1;
    }
    counts.plans += 1;
    counts.coverageMerges += 1;
    counts.ownerSorts += Number(freshQueueCandidateOwnerKeys.length > 1);
    counts.resourceKindClassifications += classifiedOwnerCount;
    counts.coverageOwnerEntryAllocations += coverageOwnerEntryAllocationCount;
    if (ownerMetadataRevision === null) counts.coverageSignatures += 1;
    counts.enteringOwners += enteringOwnerCount;
    counts.leavingOwners += leavingOwnerCount;
    counts.unchangedOwners += unchangedOwnerCount;
    counts.sortTargetOwners += freshQueueCandidateOwnerKeys.length;
    counts.admissionCursorRetainedOwners += retainedPendingOwnerKeys.length;
    counts.admissionCursorFreshOwners += freshQueueCandidateOwnerKeys.length;
    const queueInsertionsBeforeAdmission = counts.queueInsertions;
    latestApplyDiff = Object.freeze({
      enteringOwnerCount,
      leavingOwnerCount,
      unchangedOwnerCount,
      classifiedOwnerCount,
      sortTargetOwnerCount: freshQueueCandidateOwnerKeys.length,
      queueCandidateCount: queueCandidateOwnerKeys.length,
      retainedAdmissionOwnerCount: retainedPendingOwnerKeys.length,
      freshAdmissionOwnerCount: freshQueueCandidateOwnerKeys.length,
      queueInsertionCount: 0,
    });
    const affectedOwnerKeys = new Set(changedPolicyOwners);
    for (const ownerKey of previousRequestedOwnerKeys) {
      if (!nextRequestedOwnerKeys.has(ownerKey)) affectedOwnerKeys.add(ownerKey);
    }
    for (const ownerKey of affectedOwnerKeys) {
      const nextResourceKind = nextResourceKindByOwner.get(ownerKey);
      for (const key of taskKeysByOwner.get(ownerKey) ?? []) {
        const task = tasks.get(key);
        if (!task) continue;
        const retainedWithCurrentKind = nextRequestedOwnerKeys.has(ownerKey)
          && nextResourceKind === task.resourceKind;
        if (retainedWithCurrentKind) {
          task.staleSincePublicationSequence = null;
          task.cancellationRequested = false;
          staleTaskKeys.delete(task.key);
        } else {
          task.staleSincePublicationSequence ??= currentPublicationSequence();
          staleTaskKeys.add(task.key);
        }
      }
      const previousResourceKind = previousResourceKindByOwner.get(ownerKey);
      if (previousResourceKind !== undefined
        && (!nextRequestedOwnerKeys.has(ownerKey)
          || previousResourceKind !== nextResourceKind)) {
        const previousKey = taskKey(ownerKey, previousResourceKind);
        tickets.delete(previousKey);
        if (readyPageQueue.delete(previousKey)) counts.staleResultDiscards += 1;
      }
    }
    // The physical window is at most maximumConcurrentRequests, so refresh
    // scheduling metadata in-place without scanning or materializing the full
    // staged boot cursor.
    for (const task of tasks.values()) {
      if (!nextRequestedOwnerKeys.has(task.ownerKey)
        || nextResourceKindByOwner.get(task.ownerKey) !== task.resourceKind) continue;
      task.required = required.has(task.ownerKey);
      task.deadlineAtMs = ownerDeadlineAtMs(task.ownerKey, task.required);
      task.schedulerRequired = schedulerRequiredFor(
        task.deadlineAtMs,
        ownerTimingByOwner.get(task.ownerKey),
      );
      if (task.schedulerRequired) promoteQueuedTask(task);
    }
    cancelMatureStaleTasks();
    pump();
    latestApplyDiff = Object.freeze({
      ...latestApplyDiff,
      queueInsertionCount: counts.queueInsertions - queueInsertionsBeforeAdmission,
    });
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
    // Direct demand is already a currently-needed request. When the bounded
    // plan window is full, let its caller's authoritative fallback join the
    // shared generation service directly instead of growing a second queue.
    if (tasks.size >= maximumConcurrentRequests) return fallback();
    const handle = enqueue({
      ownerKey,
      resourceKind,
      required: true,
      deadlineAtMs: ownerDeadlineAtMs(ownerKey, true),
      schedulerRequired: true,
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
      Number(right[1].schedulerRequired) - Number(left[1].schedulerRequired)
        || (left[1].deadlineAtMs ?? Number.POSITIVE_INFINITY)
          - (right[1].deadlineAtMs ?? Number.POSITIVE_INFINITY)
        || (left[1].coarseFillBand ?? 4) - (right[1].coarseFillBand ?? 4)
        || Number(right[1].required) - Number(left[1].required)
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
        schedulerRequired: resource.schedulerRequired,
        coarseFillBand: resource.coarseFillBand,
        deadlineAtMs: resource.deadlineAtMs,
        coverageGeneration,
        planRevision,
        planId: latestPlan?.planId ?? null,
      }));
    }
    return Object.freeze(pages);
  };

  const snapshot = () => {
    const snapshotAtMs = clock();
    const taskAges = [...tasks.values()].map(task => Math.max(
      0,
      snapshotAtMs - task.createdAtMs,
    ));
    const cursorAges = pendingAdmissionCoverageGeneration === coverageGeneration
      ? pendingAdmissionOwnerKeys.slice(pendingAdmissionIndex).map(ownerKey => Math.max(
        0,
        snapshotAtMs - (pendingAdmissionSinceByOwner.get(ownerKey) ?? snapshotAtMs),
      )) : [];
    const oldestPendingTaskAgeMs = taskAges.length ? Math.max(...taskAges) : 0;
    const oldestAdmissionCursorAgeMs = cursorAges.length ? Math.max(...cursorAges) : 0;
    maximumPendingTaskAgeMs = Math.max(maximumPendingTaskAgeMs, oldestPendingTaskAgeMs);
    maximumAdmissionCursorAgeMs = Math.max(
      maximumAdmissionCursorAgeMs,
      oldestAdmissionCursorAgeMs,
    );
    const required = new Set(latestPolicyPlan?.requiredOwnerKeys ?? []);
    const prefetched = new Set(latestPolicyPlan?.prefetchedOwnerKeys ?? []);
    const ownerReady = ownerKey => {
      const resourceKind = latestResourceKindByOwner.get(ownerKey);
      return typeof resourceKind === 'string' && ready.has(taskKey(ownerKey, resourceKind));
    };
    const readyOwnerKeys = new Set([
      ...required,
      ...prefetched,
    ].filter(ownerReady));
    const policyCoverage = Object.freeze((latestPolicyPlan?.memberPolicyPlans ?? [])
      .map(member => Object.freeze({
        kind: member.kind,
        requiredOwnerCount: member.requiredOwnerKeys.length,
        visualRequiredOwnerCount:
          (member.sourceSnapshot?.visualRequired ?? member.requiredOwnerKeys).length,
        visualExpectedOwnerCount:
          (member.sourceSnapshot?.visualExpected
            ?? member.requestOwnerKeys
            ?? member.requiredOwnerKeys).length,
        coarsePrewarmOwnerCount: member.sourceSnapshot?.coarsePrewarm?.length ?? 0,
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
      visualRequiredOwnerCount: latestPolicyPlan?.visualRequiredOwnerKeys.length ?? 0,
      visualExpectedOwnerCount: latestPolicyPlan?.visualExpectedOwnerKeys.length ?? 0,
      coarsePrewarmOwnerCount: latestPolicyPlan?.coarsePrewarmOwnerKeys.length ?? 0,
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
      queuedTaskKeys: Object.freeze(queue
        .filter(task => task.state === 'queued')
        .map(task => task.key)),
      inFlightOwnerKeys: Object.freeze([...tasks.values()]
        .filter(task => task.state === 'in-flight')
        .map(task => task.ownerKey)
        .sort()),
      backlog: queue.length + activeCount,
      pendingAdmissionCount: pendingAdmissionCount(),
      oldestPendingTaskAgeMs,
      maximumPendingTaskAgeMs,
      oldestAdmissionCursorAgeMs,
      maximumAdmissionCursorAgeMs,
      bootCohortStartedAtMs,
      bootCohortOwnerCount: bootCohortOwnerKeys?.size ?? 0,
      bootCohortReadyOwnerCount: bootCohortOwnerKeys
        ? [...bootCohortOwnerKeys].filter(ownerReady).length : 0,
      admissionWindowCount: tasks.size,
      admissionWindowCapacity: maximumConcurrentRequests,
      queueCapacity,
      readyCacheSize: ready.size,
      readyCacheCapacity: readyCapacity,
      ticketCount: tickets.size,
      readyPageQueueCount: readyPageQueue.size,
      ticketCapacity,
      tickets: Object.freeze([...tickets.values()].map(ticket => Object.freeze({
        ...ticket,
        ticketId: `${coverageGeneration}:${policyKind}:${ticket.resourceKind}:${ticket.ownerKey}`,
        planId: latestPlan?.planId ?? ticket.planId,
        planRevision,
        coverageGeneration,
        publicationSequence: currentPublicationSequence(),
        stateRevision: currentStateRevision(),
        originGeneration: currentOriginGeneration(),
      }))),
      latestApplyDiff,
      counts: Object.freeze({ ...counts }),
      disposed,
    });
  };
  const diagnostics = () => {
    const requiredOwnerKeys = latestPolicyPlan?.requiredOwnerKeys ?? [];
    const prefetchedOwnerKeys = latestPolicyPlan?.prefetchedOwnerKeys ?? [];
    const isReady = ownerKey => {
      const resourceKind = latestResourceKindByOwner.get(ownerKey);
      return typeof resourceKind === 'string' && ready.has(taskKey(ownerKey, resourceKind));
    };
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
        visualRequiredOwnerCount:
          (member.sourceSnapshot?.visualRequired ?? member.requiredOwnerKeys).length,
        visualExpectedOwnerCount:
          (member.sourceSnapshot?.visualExpected
            ?? member.requestOwnerKeys
            ?? member.requiredOwnerKeys).length,
        coarsePrewarmOwnerCount: member.sourceSnapshot?.coarsePrewarm?.length ?? 0,
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
      visualRequiredOwnerCount: latestPolicyPlan?.visualRequiredOwnerKeys.length ?? 0,
      visualExpectedOwnerCount: latestPolicyPlan?.visualExpectedOwnerKeys.length ?? 0,
      coarsePrewarmOwnerCount: latestPolicyPlan?.coarsePrewarmOwnerKeys.length ?? 0,
      readyRequiredOwnerCount,
      missingRequiredOwnerCount: requiredOwnerKeys.length - readyRequiredOwnerCount,
      prefetchedOwnerCount: prefetchedOwnerKeys.length,
      readyPrefetchedOwnerCount,
      backlog: queue.length + activeCount,
      pendingAdmissionCount: pendingAdmissionCount(),
      admissionWindowCount: tasks.size,
      admissionWindowCapacity: maximumConcurrentRequests,
      queueDepth: queue.length,
      inFlightCount: activeCount,
      readyPageCount: readyPageQueue.size,
      ticketCount: tickets.size,
      publishedTicketCount: counts.ticketsPublished,
      requestedCount: counts.requested,
      readyHitCount: counts.readyHits,
      pendingReuseCount: counts.pendingReuse,
      latestApplyDiff,
      counts: Object.freeze({ ...counts }),
      cancelledCount: counts.cancelled,
      failedCount: counts.failed,
      invalidationCount: counts.invalidations,
    });
  };
  const invalidate = (reason = 'static-stream-invalidated') => {
    if (disposed) return 0;
    epoch += 1;
    latestCoverageSignature = null;
    latestSourceCoverageSignature = null;
    latestResourceKindEntries = Object.freeze([]);
    latestResourceKindByOwner = new Map();
    latestResourceKindEntryByOwner = new Map();
    latestOwnerDescriptorByKey = new Map();
    latestPolicyResourceKindEntries = Object.freeze([]);
    latestPolicyResourceEntryMaps = new Map();
    latestPolicyDescriptorMaps = new Map();
    latestRequestedOwnerKeys = new Set();
    latestRequiredOwnerKeys = new Set();
    latestAllOwnerKeys = new Set();
    pendingAdmissionOwnerKeys = Object.freeze([]);
    pendingAdmissionIndex = 0;
    pendingAdmissionCoverageGeneration = 0;
    pendingAdmissionOwnerSet = new Set();
    pendingAdmissionSinceByOwner.clear();
    ownerTimingByOwner.clear();
    bootCohortOwnerKeys = null;
    bootCohortStartedAtMs = null;
    latestApplyDiff = Object.freeze({
      enteringOwnerCount: 0,
      leavingOwnerCount: 0,
      unchangedOwnerCount: 0,
      classifiedOwnerCount: 0,
      sortTargetOwnerCount: 0,
      queueCandidateCount: 0,
      retainedAdmissionOwnerCount: 0,
      freshAdmissionOwnerCount: 0,
      queueInsertionCount: 0,
    });
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
    pendingAdmissionOwnerKeys = Object.freeze([]);
    pendingAdmissionIndex = 0;
    pendingAdmissionCoverageGeneration = 0;
    pendingAdmissionOwnerSet = new Set();
    pendingAdmissionSinceByOwner.clear();
    tasks.clear();
    taskKeysByOwner.clear();
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
    // Requirement derivation may read an immutable page that the same bridge
    // already consumed while it was only Resource-prewarmed. This is a cache
    // view, not another admission/publication path; renderer work continues to
    // flow exclusively through drainReadyOwnerPages.
    readyOwnerResource: ownerKey => {
      const resourceKind = latestResourceKindByOwner.get(ownerKey);
      return resourceKind ? ready.get(taskKey(ownerKey, resourceKind)) ?? null : null;
    },
    resourceKindEntries: () => latestResourceKindEntries,
    policyResourceKindEntries: () => latestPolicyResourceKindEntries,
    ownerMetadataDiagnostics: () => ownerMetadataCache?.snapshot() ?? null,
    ownerTimingSnapshot: ownerKeys => Object.freeze((ownerKeys ?? []).map(ownerKey => (
      ownerTimingByOwner.get(ownerKey)
    )).filter(Boolean)),
    invalidate,
    diagnostics,
    snapshot,
    dispose,
  });
}
