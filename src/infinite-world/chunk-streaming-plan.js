import {
  LOGICAL_CHUNK_SIZE_METERS,
  createChunkKey,
  logicalWorldToOwnedChunk,
  squareChunkCoordinates,
} from './chunk-coordinates.js';
import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
  normalizeW8RenderDistancePreset,
  resolveW8RenderDistancePolicy,
} from './render-distance-policy.js';

const EPSILON = 1e-9;

let lastResidentReadyPlanCacheKey = null;
let lastResidentReadyPlan = null;

export const RUNTIME_TERRAIN_READY_LEAD_SECONDS = 2.25;
export const RUNTIME_TERRAIN_READY_MAXIMUM_DISTANCE_METERS = 192;

const currentRenderDistance = resolveW8RenderDistancePolicy(
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
);
// Resource coverage is a cache/data-availability bound only. It must never be
// interpreted as evidence that an owner has a visible GPU-backed drawable;
// that is tracked by the separate Visual Continuity lifecycle.
// Remote Settlement metadata remains a sparse Presentation Resource query.
//
// Capacity constants deliberately stay sized for Current (the largest preset),
// while live Presentation residency follows the selected Render Distance. This
// keeps one bounded cache capable of every preset without forcing Short and
// Standard to keep Current's entire resource window required.
export const RESIDENT_WORLD_MAXIMUM_VISIBLE_RADIUS_METERS =
  currentRenderDistance.distanceContract.residentCoverageDistanceMeters;
export const FULL_RESIDENT_RADIUS_METERS = 100;

export function resolvePresentationResidentRadiusMeters(
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  const policy = resolveW8RenderDistancePolicy(renderDistancePreset);
  return Math.max(
    FULL_RESIDENT_RADIUS_METERS,
    policy.distanceContract.residentCoverageDistanceMeters + LOGICAL_CHUNK_SIZE_METERS,
  );
}

export const RESIDENT_WORLD_REQUIRED_RADIUS_METERS =
  resolvePresentationResidentRadiusMeters(W8_DEFAULT_RENDER_DISTANCE_PRESET);
export const PRESENTATION_RESIDENT_RADIUS_METERS =
  RESIDENT_WORLD_REQUIRED_RADIUS_METERS;

function chunkAabbDistanceSquared(chunkX, chunkZ, centerX, centerZ) {
  const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const maximumX = minimumX + LOGICAL_CHUNK_SIZE_METERS;
  const maximumZ = minimumZ + LOGICAL_CHUNK_SIZE_METERS;
  const closestX = Math.max(minimumX, Math.min(maximumX, centerX));
  const closestZ = Math.max(minimumZ, Math.min(maximumZ, centerZ));
  return (closestX - centerX) ** 2 + (closestZ - centerZ) ** 2;
}

function collectResidentCoordinates(centerChunkX, centerChunkZ, radiusMeters) {
  const centerX = centerChunkX * LOGICAL_CHUNK_SIZE_METERS
    + LOGICAL_CHUNK_SIZE_METERS / 2;
  const centerZ = centerChunkZ * LOGICAL_CHUNK_SIZE_METERS
    + LOGICAL_CHUNK_SIZE_METERS / 2;
  const minimumChunkX = Math.floor((centerX - radiusMeters) / LOGICAL_CHUNK_SIZE_METERS);
  const maximumChunkX = Math.floor((centerX + radiusMeters) / LOGICAL_CHUNK_SIZE_METERS);
  const minimumChunkZ = Math.floor((centerZ - radiusMeters) / LOGICAL_CHUNK_SIZE_METERS);
  const maximumChunkZ = Math.floor((centerZ + radiusMeters) / LOGICAL_CHUNK_SIZE_METERS);
  const radiusSquared = radiusMeters ** 2;
  const result = [];
  for (let chunkZ = minimumChunkZ; chunkZ <= maximumChunkZ; chunkZ += 1) {
    for (let chunkX = minimumChunkX; chunkX <= maximumChunkX; chunkX += 1) {
      const distanceSquared = chunkAabbDistanceSquared(chunkX, chunkZ, centerX, centerZ);
      if (distanceSquared > radiusSquared) continue;
      result.push(Object.freeze({
        chunkX,
        chunkZ,
        key: createChunkKey(chunkX, chunkZ),
        residentDistanceMeters: Math.sqrt(distanceSquared),
      }));
    }
  }
  return Object.freeze(result);
}

function createNamedResidentView(name, radiusMeters, ownerCoordinates) {
  const coordinates = Object.freeze(ownerCoordinates.filter(
    coordinate => coordinate.residentDistanceMeters <= radiusMeters,
  ));
  return Object.freeze({
    schemaVersion: 'resident-world-coverage-view-1',
    name,
    contract: 'resource-resident-not-drawable',
    radiusMeters,
    ownerCoordinates: coordinates,
    ownerKeys: Object.freeze(coordinates.map(coordinate => coordinate.key)),
    signature: `${name}:${radiusMeters}:${coordinates.length}`,
  });
}

/**
 * The one player-Chunk-centered, camera/velocity-independent required World set.
 * Category presentation radii may select subsets, but they never choose a
 * different required center.
 */
export function createResidentWorldCoverage({
  centerChunkX,
  centerChunkZ,
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
  radiusMeters = null,
} = {}) {
  if (!Number.isSafeInteger(centerChunkX) || !Number.isSafeInteger(centerChunkZ)) {
    throw new TypeError('Resident World center must use safe Chunk coordinates');
  }
  const normalizedRenderDistancePreset = normalizeW8RenderDistancePreset(
    renderDistancePreset,
  );
  const renderDistancePolicy = resolveW8RenderDistancePolicy(
    normalizedRenderDistancePreset,
  );
  const maximumVisibleRadiusMeters =
    renderDistancePolicy.distanceContract.residentCoverageDistanceMeters;
  const presentationResidentRadiusMeters = resolvePresentationResidentRadiusMeters(
    normalizedRenderDistancePreset,
  );
  const resolvedRadiusMeters = radiusMeters ?? presentationResidentRadiusMeters;
  if (!Number.isFinite(resolvedRadiusMeters)
    || resolvedRadiusMeters < presentationResidentRadiusMeters) {
    throw new RangeError(
      'Resident World radius must cover the selected Render Distance resource margin',
    );
  }
  const ownerCoordinates = collectResidentCoordinates(
    centerChunkX,
    centerChunkZ,
    resolvedRadiusMeters,
  );
  const ownerKeys = Object.freeze(ownerCoordinates.map(value => value.key));
  const presentationView = createNamedResidentView(
    'presentation',
    presentationResidentRadiusMeters,
    ownerCoordinates,
  );
  const fullView = createNamedResidentView(
    'full',
    Math.min(FULL_RESIDENT_RADIUS_METERS, resolvedRadiusMeters),
    ownerCoordinates,
  );
  return Object.freeze({
    schemaVersion: 'resident-world-coverage-1',
    contract: 'resource-resident-not-drawable',
    centerChunkX,
    centerChunkZ,
    renderDistancePreset: normalizedRenderDistancePreset,
    centerOwnerKey: createChunkKey(centerChunkX, centerChunkZ),
    centerX: centerChunkX * LOGICAL_CHUNK_SIZE_METERS + LOGICAL_CHUNK_SIZE_METERS / 2,
    centerZ: centerChunkZ * LOGICAL_CHUNK_SIZE_METERS + LOGICAL_CHUNK_SIZE_METERS / 2,
    maximumVisibleRadiusMeters,
    requiredRadiusMeters: presentationResidentRadiusMeters,
    radiusMeters: resolvedRadiusMeters,
    ownerCoordinates,
    presentationView,
    fullView,
    residentRequiredOwnerKeys: ownerKeys,
    residentDataOwnerKeys: fullView.ownerKeys,
    residentTerrainOwnerKeys: fullView.ownerKeys,
    residentNaturalOwnerKeys: presentationView.ownerKeys,
    residentStructureOwnerKeys: presentationView.ownerKeys,
    signature: `resident:${normalizedRenderDistancePreset}:${centerChunkX},${centerChunkZ}:`
      + `${resolvedRadiusMeters}:${ownerKeys.length}`,
  });
}

export function residentOwnerKeysWithinRadius(coverage, radiusMeters) {
  if (coverage?.schemaVersion !== 'resident-world-coverage-1') {
    throw new TypeError('Resident World coverage is required');
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0
    || radiusMeters > coverage.radiusMeters) {
    throw new RangeError('Resident subset radius must be within the Resident World');
  }
  return Object.freeze(coverage.ownerCoordinates
    .filter(value => value.residentDistanceMeters <= radiusMeters)
    .map(value => value.key));
}

const baselineResidentCoverage = createResidentWorldCoverage({
  centerChunkX: 0,
  centerChunkZ: 0,
});
const maximumPrefetchPrimaryAxisShiftChunks = Math.ceil(
  RUNTIME_TERRAIN_READY_MAXIMUM_DISTANCE_METERS / LOGICAL_CHUNK_SIZE_METERS,
) + 1;
// A 192 m segment can reach 13 owners on one axis only by remaining in the
// adjacent row on the other axis. Exhaustive feasible-lattice evaluation puts
// the maximum circular-Resident union at the (13, 1) displacement, not at the
// geometrically impossible (13, 13) displacement.
const maximumPrefetchCoverage = createResidentWorldCoverage({
  centerChunkX: maximumPrefetchPrimaryAxisShiftChunks,
  centerChunkZ: 1,
});
const baselineResidentKeys = new Set(baselineResidentCoverage.residentRequiredOwnerKeys);
export const RESIDENT_WORLD_OWNER_COUNT =
  baselineResidentCoverage.residentRequiredOwnerKeys.length;
export const PRESENTATION_RESIDENT_OWNER_COUNT =
  baselineResidentCoverage.presentationView.ownerKeys.length;
export const FULL_RESIDENT_OWNER_COUNT =
  baselineResidentCoverage.fullView.ownerKeys.length;
export const RESIDENT_WORLD_BOUNDED_PREFETCH_OWNER_COUNT =
  maximumPrefetchCoverage.residentRequiredOwnerKeys
    .filter(key => !baselineResidentKeys.has(key)).length;
const baselineFullKeys = new Set(baselineResidentCoverage.fullView.ownerKeys);
export const FULL_RESIDENT_BOUNDED_PREFETCH_OWNER_COUNT =
  maximumPrefetchCoverage.fullView.ownerKeys
    .filter(key => !baselineFullKeys.has(key)).length;
export const PRESENTATION_OWNER_CACHE_CAPACITY =
  RESIDENT_WORLD_OWNER_COUNT + RESIDENT_WORLD_BOUNDED_PREFETCH_OWNER_COUNT;
export const FULL_CHUNK_DATA_CACHE_CAPACITY =
  FULL_RESIDENT_OWNER_COUNT + FULL_RESIDENT_BOUNDED_PREFETCH_OWNER_COUNT;
// Compatibility name for consumers that size the Full ChunkData cache. The
// production data-plane now protects only the nested 100 m Full view.
export const RESIDENT_WORLD_CHUNK_DATA_CACHE_CAPACITY = FULL_CHUNK_DATA_CACHE_CAPACITY;

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function coordinateKeySet(coordinates) {
  return new Set(coordinates.map(coordinate => coordinate.key));
}

function timeToBoundary(local, velocity) {
  if (velocity > EPSILON) return (LOGICAL_CHUNK_SIZE_METERS - local) / velocity;
  if (velocity < -EPSILON) return local / -velocity;
  return Infinity;
}

function orderedCorridorCenters({ logicalX, logicalZ, velocityX, velocityZ, speed, distance }) {
  const start = logicalWorldToOwnedChunk(logicalX, logicalZ);
  const centers = [{ ...start, arrivalDistanceMeters: 0, arrivalSeconds: 0 }];
  if (speed <= EPSILON || distance <= EPSILON) return centers;

  const directionX = velocityX / speed;
  const directionZ = velocityZ / speed;
  const stepX = Math.sign(directionX);
  const stepZ = Math.sign(directionZ);
  let chunkX = start.chunkX;
  let chunkZ = start.chunkZ;
  let distanceToX = stepX === 0 ? Infinity : stepX > 0
    ? ((chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS - logicalX) / directionX
    : (chunkX * LOGICAL_CHUNK_SIZE_METERS - logicalX) / directionX;
  let distanceToZ = stepZ === 0 ? Infinity : stepZ > 0
    ? ((chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS - logicalZ) / directionZ
    : (chunkZ * LOGICAL_CHUNK_SIZE_METERS - logicalZ) / directionZ;
  const distancePerX = stepX === 0 ? Infinity : LOGICAL_CHUNK_SIZE_METERS / Math.abs(directionX);
  const distancePerZ = stepZ === 0 ? Infinity : LOGICAL_CHUNK_SIZE_METERS / Math.abs(directionZ);

  // Amanatides-Woo traversal provides every owner crossed by the actual path.
  // Exact corner crossings advance both axes together; a wide square corridor
  // is never synthesized around the endpoint.
  while (Math.min(distanceToX, distanceToZ) <= distance + EPSILON) {
    const nextDistance = Math.max(0, Math.min(distanceToX, distanceToZ));
    const crossesX = distanceToX <= nextDistance + EPSILON;
    const crossesZ = distanceToZ <= nextDistance + EPSILON;
    if (crossesX) {
      chunkX += stepX;
      distanceToX += distancePerX;
    }
    if (crossesZ) {
      chunkZ += stepZ;
      distanceToZ += distancePerZ;
    }
    centers.push({
      chunkX,
      chunkZ,
      key: `${chunkX},${chunkZ}`,
      arrivalDistanceMeters: nextDistance,
      arrivalSeconds: nextDistance / speed,
    });
  }
  return centers;
}

function compareReadyOwner(left, right) {
  return left.priorityClass - right.priorityClass
    || left.arrivalSeconds - right.arrivalSeconds
    || (left.residentDistanceMeters ?? Infinity)
      - (right.residentDistanceMeters ?? Infinity)
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

/**
 * Builds Runtime preparation from the authoritative Resident required set and
 * a replaceable future-Resident prefetch candidate. Terrain's existing 5x5
 * data / 3x3 render layers remain presentation subsets for Phase A. Callers
 * that omit residentCoverage retain the isolated legacy-fixture contract.
 */
export function planRuntimeTerrainReadySet({
  centerChunkX,
  centerChunkZ,
  logicalX,
  logicalZ,
  velocityX,
  velocityZ,
  speedMetersPerSecond,
  scaleStageId,
  sprint = false,
  leadSeconds = RUNTIME_TERRAIN_READY_LEAD_SECONDS,
  maximumDistanceMeters = RUNTIME_TERRAIN_READY_MAXIMUM_DISTANCE_METERS,
  residentCoverage = null,
} = {}) {
  for (const [value, name] of [
    [centerChunkX, 'centerChunkX'], [centerChunkZ, 'centerChunkZ'],
  ]) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  }
  for (const [value, name] of [
    [logicalX, 'logicalX'], [logicalZ, 'logicalZ'], [velocityX, 'velocityX'], [velocityZ, 'velocityZ'],
    [speedMetersPerSecond, 'speedMetersPerSecond'], [leadSeconds, 'leadSeconds'],
    [maximumDistanceMeters, 'maximumDistanceMeters'],
  ]) finite(value, name);
  if (speedMetersPerSecond < 0) throw new RangeError('speedMetersPerSecond must be non-negative');
  if (leadSeconds <= 0) throw new RangeError('leadSeconds must be positive');
  if (maximumDistanceMeters <= 0) throw new RangeError('maximumDistanceMeters must be positive');
  if (typeof scaleStageId !== 'string' || !scaleStageId) throw new TypeError('scaleStageId is required');
  if (typeof sprint !== 'boolean') throw new TypeError('sprint must be boolean');

  const velocityMagnitude = Math.hypot(velocityX, velocityZ);
  const movementSpeed = Math.min(speedMetersPerSecond, velocityMagnitude);
  const corridorDistanceMeters = Math.min(maximumDistanceMeters, movementSpeed * leadSeconds);
  const corridorCenters = orderedCorridorCenters({
    logicalX,
    logicalZ,
    velocityX,
    velocityZ,
    speed: velocityMagnitude,
    distance: corridorDistanceMeters,
  });
  const visibleCenter = corridorCenters[0];
  if (residentCoverage !== null
    && (residentCoverage?.schemaVersion !== 'resident-world-coverage-1'
      || residentCoverage.centerChunkX !== visibleCenter.chunkX
      || residentCoverage.centerChunkZ !== visibleCenter.chunkZ)) {
    throw new Error('Resident World coverage must match the player-owned Chunk');
  }
  const residentCoordinates = residentCoverage?.fullView?.ownerCoordinates
    ?? residentCoverage?.ownerCoordinates ?? Object.freeze([]);
  const endpoint = corridorCenters.at(-1);
  const residentReadyPlanCacheKey = residentCoverage === null ? null : [
    residentCoverage.signature,
    scaleStageId,
    sprint ? 'sprint' : 'walk',
    speedMetersPerSecond.toFixed(3),
    velocityX.toFixed(3),
    velocityZ.toFixed(3),
    leadSeconds,
    maximumDistanceMeters,
    corridorCenters.map(center => center.key).join(','),
  ].join('|');
  if (residentReadyPlanCacheKey !== null
    && residentReadyPlanCacheKey === lastResidentReadyPlanCacheKey) {
    return lastResidentReadyPlan;
  }
  const residentKeySet = new Set(residentCoordinates.map(value => value.key));
  const futureResidentCoverage = residentCoverage !== null
    && endpoint.key !== residentCoverage.centerOwnerKey
    ? createResidentWorldCoverage({
      centerChunkX: endpoint.chunkX,
      centerChunkZ: endpoint.chunkZ,
      renderDistancePreset: residentCoverage.renderDistancePreset,
      radiusMeters: residentCoverage.radiusMeters,
    })
    : null;
  const velocityPrefetchCoordinates = futureResidentCoverage === null
    ? Object.freeze([])
    : Object.freeze(futureResidentCoverage.fullView.ownerCoordinates.filter(
      coordinate => !residentKeySet.has(coordinate.key),
    ));
  const dataByKey = new Map();
  const renderByKey = new Map();
  for (const coordinate of residentCoordinates) {
    dataByKey.set(coordinate.key, {
      ...coordinate,
      dataArrivalSeconds: 0,
      visibleData: false,
      residentRequired: true,
    });
  }
  for (const coordinate of velocityPrefetchCoordinates) {
    dataByKey.set(coordinate.key, {
      ...coordinate,
      dataArrivalSeconds: endpoint.arrivalSeconds,
      visibleData: false,
      residentRequired: false,
    });
  }
  corridorCenters.forEach((center, centerIndex) => {
    for (const coordinate of squareChunkCoordinates(center.chunkX, center.chunkZ, 2)) {
      const current = dataByKey.get(coordinate.key);
      if (!current || center.arrivalSeconds < current.dataArrivalSeconds) {
        dataByKey.set(coordinate.key, {
          ...current,
          ...coordinate,
          dataArrivalSeconds: center.arrivalSeconds,
          visibleData: centerIndex === 0,
          residentRequired: current?.residentRequired === true,
        });
      } else if (centerIndex === 0) {
        current.visibleData = true;
      }
    }
    for (const coordinate of squareChunkCoordinates(center.chunkX, center.chunkZ, 1)) {
      const current = renderByKey.get(coordinate.key);
      if (!current || center.arrivalSeconds < current.renderArrivalSeconds) {
        renderByKey.set(coordinate.key, {
          ...coordinate,
          renderArrivalSeconds: center.arrivalSeconds,
          visibleRender: centerIndex === 0,
        });
      } else if (centerIndex === 0) {
        current.visibleRender = true;
      }
    }
  });

  const dataCoordinates = [...dataByKey.values()].map(coordinate => {
    const render = renderByKey.get(coordinate.key) ?? null;
    const priorityClass = render?.visibleRender ? 0
      : coordinate.visibleData ? 1
        : residentCoverage === null ? (render ? 2 : 3)
          : coordinate.residentRequired ? 2
            : render ? 3 : 4;
    return Object.freeze({
      chunkX: coordinate.chunkX,
      chunkZ: coordinate.chunkZ,
      key: coordinate.key,
      priorityClass,
      arrivalSeconds: render?.renderArrivalSeconds ?? coordinate.dataArrivalSeconds,
      renderRequired: render !== null,
      visibleRequired: coordinate.visibleData,
      residentRequired: coordinate.residentRequired === true,
      residentDistanceMeters: coordinate.residentRequired
        ? coordinate.residentDistanceMeters : null,
    });
  }).sort(compareReadyOwner);
  const renderCoordinates = dataCoordinates.filter(coordinate => coordinate.renderRequired);
  const signature = residentReadyPlanCacheKey ?? `${scaleStageId}:${sprint ? 'sprint' : 'walk'}:${speedMetersPerSecond.toFixed(3)}|${dataCoordinates
    .map(coordinate => `${coordinate.key}:${coordinate.priorityClass}`).join('|')}`;
  const residentRequiredOwnerKeys = residentCoverage?.fullView?.ownerKeys
    ?? Object.freeze(dataCoordinates.filter(value => value.visibleRequired).map(value => value.key));
  const velocityPrefetchOwnerKeys = Object.freeze(
    dataCoordinates.filter(value => !value.residentRequired).map(value => value.key),
  );
  const plan = Object.freeze({
    schemaVersion: 'runtime-terrain-ready-set-1',
    signature,
    requestedFromChunkX: centerChunkX,
    requestedFromChunkZ: centerChunkZ,
    visibleCenterChunkX: corridorCenters[0].chunkX,
    visibleCenterChunkZ: corridorCenters[0].chunkZ,
    velocityX,
    velocityZ,
    speedMetersPerSecond,
    scaleStageId,
    sprint,
    leadSeconds,
    maximumDistanceMeters,
    corridorDistanceMeters,
    corridorEndpointOwnerKey: endpoint.key,
    corridorCenters: Object.freeze(corridorCenters.map(center => Object.freeze({ ...center }))),
    residentCoverage,
    residentRequiredOwnerKeys,
    residentPresentationOwnerKeys: residentCoverage?.presentationView?.ownerKeys
      ?? residentRequiredOwnerKeys,
    residentFullOwnerKeys: residentRequiredOwnerKeys,
    residentDataOwnerKeys: residentRequiredOwnerKeys,
    residentTerrainOwnerKeys: residentRequiredOwnerKeys,
    residentNaturalOwnerKeys: residentCoverage?.presentationView?.ownerKeys
      ?? residentRequiredOwnerKeys,
    residentStructureOwnerKeys: residentCoverage?.presentationView?.ownerKeys
      ?? residentRequiredOwnerKeys,
    velocityPrefetchOwnerKeys,
    dataCoordinates: Object.freeze(dataCoordinates),
    renderCoordinates: Object.freeze(renderCoordinates),
  });
  if (residentReadyPlanCacheKey !== null) {
    lastResidentReadyPlanCacheKey = residentReadyPlanCacheKey;
    lastResidentReadyPlan = plan;
  }
  return plan;
}

/**
 * Fixed P0 reproduction contract for the Stage 1 streaming defect.
 * The individual combinations are exercised by the runtime tests; production
 * uses the same inputs to select a deterministic next-boundary preparation.
 */
export const P1_CHUNK_STREAMING_REPRODUCTION = Object.freeze({
  defect: 'player movement hitches while crossing a logical Chunk boundary',
  worldSeed: 'KaniNingen Infinite Natural World',
  quality: 'high',
  scaleStages: Object.freeze(['TINY', 'MID', 'MAX']),
  sprint: Object.freeze([false, true]),
  paths: Object.freeze(['straight', 'diagonal']),
  crossingCount: 12,
  saveDuringRun: Object.freeze([false, true]),
});

/**
 * Computes the next center Chunk and exactly the entering 5x5 data / 3x3
 * render perimeter. The look-ahead is expressed in time so Scale, Sprint and
 * any finite movement multiplier all feed the same decision through velocity.
 */
export function planNextChunkBoundaryPrefetch({
  centerChunkX,
  centerChunkZ,
  logicalX,
  logicalZ,
  velocityX,
  velocityZ,
  speedMetersPerSecond,
  scaleStageId,
  sprint = false,
  leadSeconds = null,
} = {}) {
  for (const [value, name] of [
    [centerChunkX, 'centerChunkX'], [centerChunkZ, 'centerChunkZ'],
  ]) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  }
  for (const [value, name] of [
    [logicalX, 'logicalX'], [logicalZ, 'logicalZ'], [velocityX, 'velocityX'], [velocityZ, 'velocityZ'],
    [speedMetersPerSecond, 'speedMetersPerSecond'],
  ]) finite(value, name);
  if (speedMetersPerSecond < 0) throw new RangeError('speedMetersPerSecond must be non-negative');
  if (typeof scaleStageId !== 'string' || !scaleStageId) throw new TypeError('scaleStageId is required');
  if (typeof sprint !== 'boolean') throw new TypeError('sprint must be boolean');

  const localX = logicalX - centerChunkX * LOGICAL_CHUNK_SIZE_METERS;
  const localZ = logicalZ - centerChunkZ * LOGICAL_CHUNK_SIZE_METERS;
  if (localX < -EPSILON || localX > LOGICAL_CHUNK_SIZE_METERS + EPSILON
    || localZ < -EPSILON || localZ > LOGICAL_CHUNK_SIZE_METERS + EPSILON) {
    return null;
  }
  const horizonSeconds = leadSeconds ?? Math.min(2.25, Math.max(
    sprint ? 1.35 : 0.9,
    0.55 + speedMetersPerSecond / 38,
  ));
  if (!Number.isFinite(horizonSeconds) || horizonSeconds <= 0) {
    throw new RangeError('leadSeconds must be positive when supplied');
  }
  const xTime = timeToBoundary(Math.min(LOGICAL_CHUNK_SIZE_METERS, Math.max(0, localX)), velocityX);
  const zTime = timeToBoundary(Math.min(LOGICAL_CHUNK_SIZE_METERS, Math.max(0, localZ)), velocityZ);
  const firstBoundarySeconds = Math.min(xTime, zTime);
  if (!Number.isFinite(firstBoundarySeconds) || firstBoundarySeconds > horizonSeconds) return null;

  // Only treat it as a diagonal transition when both boundaries are genuinely
  // imminent. This prevents an oblique path from preparing the wrong corner.
  const diagonalWindowSeconds = Math.min(0.18, Math.max(0.04, horizonSeconds * 0.12));
  const targetChunkX = xTime <= firstBoundarySeconds + diagonalWindowSeconds
    ? centerChunkX + Math.sign(velocityX) : centerChunkX;
  const targetChunkZ = zTime <= firstBoundarySeconds + diagonalWindowSeconds
    ? centerChunkZ + Math.sign(velocityZ) : centerChunkZ;
  if (targetChunkX === centerChunkX && targetChunkZ === centerChunkZ) return null;

  const currentData = squareChunkCoordinates(centerChunkX, centerChunkZ, 2);
  const currentRender = squareChunkCoordinates(centerChunkX, centerChunkZ, 1);
  const dataCoordinates = squareChunkCoordinates(targetChunkX, targetChunkZ, 2);
  const renderCoordinates = squareChunkCoordinates(targetChunkX, targetChunkZ, 1);
  const currentDataKeys = coordinateKeySet(currentData);
  const currentRenderKeys = coordinateKeySet(currentRender);
  return Object.freeze({
    schemaVersion: 'p1-chunk-boundary-prefetch-1',
    fromChunkX: centerChunkX,
    fromChunkZ: centerChunkZ,
    targetChunkX,
    targetChunkZ,
    targetKey: `${targetChunkX},${targetChunkZ}`,
    velocityX,
    velocityZ,
    speedMetersPerSecond,
    scaleStageId,
    sprint,
    leadSeconds: horizonSeconds,
    firstBoundarySeconds,
    dataCoordinates: Object.freeze(dataCoordinates),
    renderCoordinates: Object.freeze(renderCoordinates),
    enteringDataCoordinates: Object.freeze(dataCoordinates.filter(value => !currentDataKeys.has(value.key))),
    enteringRenderCoordinates: Object.freeze(renderCoordinates.filter(value => !currentRenderKeys.has(value.key))),
  });
}
