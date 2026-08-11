import {
  LOGICAL_CHUNK_SIZE_METERS,
  logicalWorldToOwnedChunk,
  squareChunkCoordinates,
} from './chunk-coordinates.js';

const EPSILON = 1e-9;

export const RUNTIME_TERRAIN_READY_LEAD_SECONDS = 2.25;
export const RUNTIME_TERRAIN_READY_MAXIMUM_DISTANCE_METERS = 192;

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
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

/**
 * Builds the single authoritative Runtime Terrain owner set. The current 5x5
 * data / 3x3 render coverage is unioned with the same rings along the player's
 * velocity corridor, so an owner requested by multiple centers is prepared
 * once and receives its earliest-arrival priority.
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
  const dataByKey = new Map();
  const renderByKey = new Map();
  corridorCenters.forEach((center, centerIndex) => {
    for (const coordinate of squareChunkCoordinates(center.chunkX, center.chunkZ, 2)) {
      const current = dataByKey.get(coordinate.key);
      if (!current || center.arrivalSeconds < current.dataArrivalSeconds) {
        dataByKey.set(coordinate.key, {
          ...coordinate,
          dataArrivalSeconds: center.arrivalSeconds,
          visibleData: centerIndex === 0,
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
        : render ? 2 : 3;
    return Object.freeze({
      chunkX: coordinate.chunkX,
      chunkZ: coordinate.chunkZ,
      key: coordinate.key,
      priorityClass,
      arrivalSeconds: render?.renderArrivalSeconds ?? coordinate.dataArrivalSeconds,
      renderRequired: render !== null,
      visibleRequired: coordinate.visibleData,
    });
  }).sort(compareReadyOwner);
  const renderCoordinates = dataCoordinates.filter(coordinate => coordinate.renderRequired);
  const signature = `${scaleStageId}:${sprint ? 'sprint' : 'walk'}:${speedMetersPerSecond.toFixed(3)}|${dataCoordinates
    .map(coordinate => `${coordinate.key}:${coordinate.priorityClass}`).join('|')}`;
  const endpoint = corridorCenters.at(-1);
  return Object.freeze({
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
    dataCoordinates: Object.freeze(dataCoordinates),
    renderCoordinates: Object.freeze(renderCoordinates),
  });
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
