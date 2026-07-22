export const LOGICAL_CHUNK_SIZE_METERS = 16;
export const RENDER_CHUNK_SIZE = 4096;
export const UNITS_PER_METER = RENDER_CHUNK_SIZE / LOGICAL_CHUNK_SIZE_METERS;
export const SUPPORTED_RENDER_CHUNK_SIZES = Object.freeze([4096, 2048]);

export function createRenderScale(renderChunkSize = RENDER_CHUNK_SIZE) {
  if (!SUPPORTED_RENDER_CHUNK_SIZES.includes(renderChunkSize)) {
    throw new RangeError(`renderChunkSize must be one of ${SUPPORTED_RENDER_CHUNK_SIZES.join(', ')}`);
  }
  return Object.freeze({
    renderChunkSize,
    unitsPerMeter: renderChunkSize / LOGICAL_CHUNK_SIZE_METERS,
  });
}

export const MAX_LOGICAL_CHUNK_COORDINATE = Math.floor(
  (Number.MAX_SAFE_INTEGER - LOGICAL_CHUNK_SIZE_METERS) / LOGICAL_CHUNK_SIZE_METERS,
);

export function normalizeNegativeZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

export function assertLogicalChunkCoordinate(value, name = 'chunk coordinate') {
  const normalized = normalizeNegativeZero(value);
  if (!Number.isSafeInteger(normalized)
    || Math.abs(normalized) > MAX_LOGICAL_CHUNK_COORDINATE) {
    throw new RangeError(`${name} must be a safe logical chunk coordinate`);
  }
  return normalized;
}

export function createChunkKey(chunkX, chunkZ) {
  return `${assertLogicalChunkCoordinate(chunkX, 'chunkX')},${assertLogicalChunkCoordinate(chunkZ, 'chunkZ')}`;
}

export function parseChunkKey(key) {
  if (typeof key !== 'string' || !/^-?\d+,-?\d+$/.test(key)) {
    throw new TypeError('invalid chunk key');
  }
  const [chunkX, chunkZ] = key.split(',').map(Number);
  return Object.freeze({
    chunkX: assertLogicalChunkCoordinate(chunkX, 'chunkX'),
    chunkZ: assertLogicalChunkCoordinate(chunkZ, 'chunkZ'),
  });
}

// A point exactly on a grid boundary belongs to the west/north chunk. This
// produces local coordinates in (0, 16], including 16 at an owned boundary.
export function ownerAxisForLogicalMeters(worldMeters) {
  if (!Number.isFinite(worldMeters)) throw new TypeError('logical world position must be finite');
  const scaled = worldMeters / LOGICAL_CHUNK_SIZE_METERS;
  const owner = Number.isInteger(scaled) ? scaled - 1 : Math.floor(scaled);
  return assertLogicalChunkCoordinate(owner, 'owner chunk coordinate');
}

export function logicalWorldToOwnedChunk(worldX, worldZ) {
  const chunkX = ownerAxisForLogicalMeters(normalizeNegativeZero(worldX));
  const chunkZ = ownerAxisForLogicalMeters(normalizeNegativeZero(worldZ));
  return Object.freeze({ chunkX, chunkZ, key: createChunkKey(chunkX, chunkZ) });
}

export function decomposeLogicalWorldPosition(worldX, worldZ) {
  const owner = logicalWorldToOwnedChunk(worldX, worldZ);
  return Object.freeze({
    ...owner,
    logicalLocalX: normalizeNegativeZero(worldX - owner.chunkX * LOGICAL_CHUNK_SIZE_METERS),
    logicalLocalZ: normalizeNegativeZero(worldZ - owner.chunkZ * LOGICAL_CHUNK_SIZE_METERS),
    logicalWorldMeters: Object.freeze({
      x: normalizeNegativeZero(worldX),
      z: normalizeNegativeZero(worldZ),
    }),
  });
}

export function logicalLocalToWorldMeters(chunkX, chunkZ, logicalLocalX, logicalLocalZ) {
  const x = assertLogicalChunkCoordinate(chunkX, 'chunkX');
  const z = assertLogicalChunkCoordinate(chunkZ, 'chunkZ');
  if (!Number.isFinite(logicalLocalX) || logicalLocalX < 0 || logicalLocalX > LOGICAL_CHUNK_SIZE_METERS
    || !Number.isFinite(logicalLocalZ) || logicalLocalZ < 0 || logicalLocalZ > LOGICAL_CHUNK_SIZE_METERS) {
    throw new RangeError('logical local coordinates must be within 0..16 meters');
  }
  return Object.freeze({
    x: normalizeNegativeZero(x * LOGICAL_CHUNK_SIZE_METERS + logicalLocalX),
    z: normalizeNegativeZero(z * LOGICAL_CHUNK_SIZE_METERS + logicalLocalZ),
  });
}

export function chunkRenderPosition(
  chunkX,
  chunkZ,
  renderOriginChunkX,
  renderOriginChunkZ,
  renderChunkSize = RENDER_CHUNK_SIZE,
) {
  const scale = createRenderScale(renderChunkSize);
  return Object.freeze({
    x: (assertLogicalChunkCoordinate(chunkX, 'chunkX')
      - assertLogicalChunkCoordinate(renderOriginChunkX, 'renderOriginChunkX')) * scale.renderChunkSize,
    z: (assertLogicalChunkCoordinate(chunkZ, 'chunkZ')
      - assertLogicalChunkCoordinate(renderOriginChunkZ, 'renderOriginChunkZ')) * scale.renderChunkSize,
  });
}

export function logicalWorldToRenderLocal(
  worldX,
  worldZ,
  renderOriginChunkX,
  renderOriginChunkZ,
  renderChunkSize = RENDER_CHUNK_SIZE,
) {
  const scale = createRenderScale(renderChunkSize);
  return Object.freeze({
    x: (worldX - renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS) * scale.unitsPerMeter,
    z: (worldZ - renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS) * scale.unitsPerMeter,
  });
}

export function squareChunkCoordinates(centerChunkX, centerChunkZ, radius) {
  const centerX = assertLogicalChunkCoordinate(centerChunkX, 'centerChunkX');
  const centerZ = assertLogicalChunkCoordinate(centerChunkZ, 'centerChunkZ');
  if (!Number.isSafeInteger(radius) || radius < 0) throw new RangeError('radius must be a non-negative integer');
  const coordinates = [];
  for (let z = centerZ - radius; z <= centerZ + radius; z += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      coordinates.push(Object.freeze({ chunkX: x, chunkZ: z, key: createChunkKey(x, z) }));
    }
  }
  return Object.freeze(coordinates);
}
