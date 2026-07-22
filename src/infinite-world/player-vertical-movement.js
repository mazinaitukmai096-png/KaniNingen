import { LOGICAL_CHUNK_SIZE_METERS, decomposeLogicalWorldPosition } from './chunk-coordinates.js';
import { finiteWorldUnitsToMeters } from './gameplay-contract.js';

const PLAYER_LEG_HALF_WIDTH_UNITS = 7.5;
const PLAYER_LEG_HALF_HEIGHT_UNITS = 22.5;
const PLAYER_LEG_ROTATION_RADIANS = 0.35;
const PLAYER_MODEL_MAXIMUM_Y_UNITS = 73;

const playerLegVerticalExtent = Math.abs(Math.sin(PLAYER_LEG_ROTATION_RADIANS))
  * PLAYER_LEG_HALF_WIDTH_UNITS
  + Math.abs(Math.cos(PLAYER_LEG_ROTATION_RADIANS)) * PLAYER_LEG_HALF_HEIGHT_UNITS;

export const PLAYER_MODEL_VERTICAL_BOUNDS_UNITS = Object.freeze({
  minimum: -playerLegVerticalExtent,
  maximum: PLAYER_MODEL_MAXIMUM_Y_UNITS,
  height: PLAYER_MODEL_MAXIMUM_Y_UNITS + playerLegVerticalExtent,
});

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function verticalState(state) {
  if (!state || typeof state !== 'object') throw new TypeError('Player vertical state is required');
  return state;
}

function terrainDescriptor(chunkData) {
  const terrain = chunkData?.terrain;
  const width = terrain?.resolution?.x;
  const depth = terrain?.resolution?.z;
  if (!Number.isSafeInteger(chunkData?.chunkX) || !Number.isSafeInteger(chunkData?.chunkZ)
    || !Number.isInteger(width) || width < 2 || !Number.isInteger(depth) || depth < 2
    || !Array.isArray(terrain?.heights) || terrain.heights.length !== width * depth
    || !Number.isFinite(terrain?.heightUnitMeters) || terrain.heightUnitMeters <= 0) {
    throw new TypeError('formal Terrain ChunkData is required');
  }
  return { terrain, width, depth };
}

export function sampleFormalTerrainHeightMeters(chunkData, logicalWorldX, logicalWorldZ) {
  const worldX = finite(logicalWorldX, 'logicalWorldX');
  const worldZ = finite(logicalWorldZ, 'logicalWorldZ');
  const owner = decomposeLogicalWorldPosition(worldX, worldZ);
  if (owner.chunkX !== chunkData?.chunkX || owner.chunkZ !== chunkData?.chunkZ) {
    throw new RangeError(`ChunkData ${chunkData?.chunkX},${chunkData?.chunkZ} does not own logical position ${worldX},${worldZ}`);
  }
  const { terrain, width, depth } = terrainDescriptor(chunkData);
  const localX = worldX - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const localZ = worldZ - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const fx = Math.max(0, Math.min(width - 1,
    localX / LOGICAL_CHUNK_SIZE_METERS * (width - 1)));
  const fz = Math.max(0, Math.min(depth - 1,
    localZ / LOGICAL_CHUNK_SIZE_METERS * (depth - 1)));
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, width - 1);
  const z1 = Math.min(z0 + 1, depth - 1);
  const tx = fx - x0;
  const tz = fz - z0;
  const at = (x, z) => terrain.heights[z * width + x] * terrain.heightUnitMeters;
  const northwest = at(x0, z0);
  const northeast = at(x1, z0);
  const southwest = at(x0, z1);
  const southeast = at(x1, z1);

  // Match ChunkRenderAdapter's NW-SW-NE / NE-SW-SE triangle topology exactly.
  if (tx + tz <= 1) {
    return northwest + tx * (northeast - northwest) + tz * (southwest - northwest);
  }
  return northeast * (1 - tz) + southwest * (1 - tx) + southeast * (tx + tz - 1);
}

export function getScalePlayerVerticalMetrics(scaleProfile) {
  const stage = scaleProfile?.stage;
  if (!stage || !Number.isFinite(stage.visualScale) || stage.visualScale <= 0
    || !Number.isFinite(stage.collisionRadius) || stage.collisionRadius <= 0
    || !Number.isFinite(stage.jumpVelocity) || stage.jumpVelocity <= 0
    || !Number.isFinite(stage.gravity) || stage.gravity <= 0) {
    throw new TypeError('valid Scale Player vertical profile is required');
  }
  return Object.freeze({
    stageId: stage.id,
    footOffsetMeters: finiteWorldUnitsToMeters(
      -PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.minimum * stage.visualScale,
    ),
    heightMeters: finiteWorldUnitsToMeters(
      PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.height * stage.visualScale,
    ),
    radiusMeters: finiteWorldUnitsToMeters(stage.collisionRadius),
    jumpVelocityMetersPerSecond: finiteWorldUnitsToMeters(stage.jumpVelocity) * 60,
    gravityMetersPerSecondSquared: finiteWorldUnitsToMeters(stage.gravity) * 3600,
  });
}

export function createPlayerVerticalMovementState() {
  return {
    rootY: null,
    terrainHeightMeters: null,
    groundRootY: null,
    footOffsetMeters: 0,
    heightMeters: 0,
    radiusMeters: 0,
    velocityMetersPerSecond: 0,
    grounded: true,
  };
}

function applySurface(state, terrainHeightMeters, scaleProfile) {
  const target = verticalState(state);
  const terrainHeight = finite(terrainHeightMeters, 'terrainHeightMeters');
  const metrics = getScalePlayerVerticalMetrics(scaleProfile);
  target.terrainHeightMeters = terrainHeight;
  target.footOffsetMeters = metrics.footOffsetMeters;
  target.heightMeters = metrics.heightMeters;
  target.radiusMeters = metrics.radiusMeters;
  target.groundRootY = terrainHeight + metrics.footOffsetMeters;
  return metrics;
}

export function resetPlayerGrounding(state, { terrainHeightMeters, scaleProfile } = {}) {
  const target = verticalState(state);
  applySurface(target, terrainHeightMeters, scaleProfile);
  target.rootY = target.groundRootY;
  target.velocityMetersPerSecond = 0;
  target.grounded = true;
  return snapshotPlayerVerticalMovement(target);
}

export function tryStartPlayerJump(state, scaleProfile) {
  const target = verticalState(state);
  if (!target.grounded) return false;
  const metrics = getScalePlayerVerticalMetrics(scaleProfile);
  target.velocityMetersPerSecond = metrics.jumpVelocityMetersPerSecond;
  target.grounded = false;
  return true;
}

export function stepPlayerVerticalMovement(state, {
  deltaSeconds,
  terrainHeightMeters,
  scaleProfile,
} = {}) {
  const target = verticalState(state);
  const delta = finite(deltaSeconds, 'deltaSeconds');
  if (delta < 0) throw new RangeError('deltaSeconds must not be negative');
  const metrics = applySurface(target, terrainHeightMeters, scaleProfile);

  if (!Number.isFinite(target.rootY) || target.grounded) {
    target.rootY = target.groundRootY;
    target.velocityMetersPerSecond = 0;
    target.grounded = true;
  } else if (delta > 0) {
    target.velocityMetersPerSecond -= metrics.gravityMetersPerSecondSquared * delta;
    target.rootY += target.velocityMetersPerSecond * delta;
    if (target.velocityMetersPerSecond <= 0 && target.rootY <= target.groundRootY) {
      target.rootY = target.groundRootY;
      target.velocityMetersPerSecond = 0;
      target.grounded = true;
    }
  }

  return snapshotPlayerVerticalMovement(target);
}

export function snapshotPlayerVerticalMovement(state) {
  const target = verticalState(state);
  return Object.freeze({
    rootY: target.rootY,
    terrainHeightMeters: target.terrainHeightMeters,
    groundRootY: target.groundRootY,
    footOffsetMeters: target.footOffsetMeters,
    heightMeters: target.heightMeters,
    radiusMeters: target.radiusMeters,
    velocityMetersPerSecond: target.velocityMetersPerSecond,
    grounded: target.grounded,
  });
}
