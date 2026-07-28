import {
  LOGICAL_CHUNK_SIZE_METERS,
  squareChunkCoordinates,
} from './chunk-coordinates.js';

const EPSILON = 1e-9;

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
