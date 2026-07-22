export const CAPITAL_CIVIC_CORE_TOWN_TYPE = 'capital';

export const CAPITAL_CIVIC_CORE_DIMENSIONS = Object.freeze({
  halfWidth: 260,
  halfDepth: 210,
  rotationY: 0,
  clearance: 18,
  accessSide: 'SOUTH',
});

function assertFinitePoint(source, name) {
  if (!source || !Number.isFinite(source.x) || !Number.isFinite(source.z)) {
    throw new TypeError(`${name} must contain finite x and z coordinates`);
  }
}

function toLocal(x, z, core) {
  const dx = x - core.centerX;
  const dz = z - core.centerZ;
  const cosine = Math.cos(core.rotationY);
  const sine = Math.sin(core.rotationY);
  return {
    x: dx * cosine - dz * sine,
    z: dx * sine + dz * cosine,
  };
}

export function createCapitalCivicCore(town, accessRoadId = null) {
  assertFinitePoint(town, 'capital town');
  if (town.type !== CAPITAL_CIVIC_CORE_TOWN_TYPE) {
    throw new RangeError('Capital Civic Core can only be created for the capital town');
  }
  if (accessRoadId !== null && typeof accessRoadId !== 'string') {
    throw new TypeError('accessRoadId must be a string or null');
  }

  return Object.freeze({
    centerX: town.x,
    centerZ: town.z,
    halfWidth: CAPITAL_CIVIC_CORE_DIMENSIONS.halfWidth,
    halfDepth: CAPITAL_CIVIC_CORE_DIMENSIONS.halfDepth,
    rotationY: CAPITAL_CIVIC_CORE_DIMENSIONS.rotationY,
    clearance: CAPITAL_CIVIC_CORE_DIMENSIONS.clearance,
    accessSide: CAPITAL_CIVIC_CORE_DIMENSIONS.accessSide,
    accessRoadId,
  });
}

export function isPointInCapitalCivicCore(x, z, core, margin = 0) {
  if (!core) return false;
  if (!Number.isFinite(margin) || margin < 0) throw new RangeError('margin must be non-negative');
  const local = toLocal(x, z, core);
  return Math.abs(local.x) <= core.halfWidth + margin
    && Math.abs(local.z) <= core.halfDepth + margin;
}

export function circleIntersectsCapitalCivicCore(x, z, radius, core, margin = 0) {
  if (!core) return false;
  if (!Number.isFinite(radius) || radius < 0) throw new RangeError('radius must be non-negative');
  if (!Number.isFinite(margin) || margin < 0) throw new RangeError('margin must be non-negative');
  const local = toLocal(x, z, core);
  const halfWidth = core.halfWidth + margin;
  const halfDepth = core.halfDepth + margin;
  const nearestX = Math.max(-halfWidth, Math.min(halfWidth, local.x));
  const nearestZ = Math.max(-halfDepth, Math.min(halfDepth, local.z));
  return (local.x - nearestX) ** 2 + (local.z - nearestZ) ** 2 <= radius ** 2;
}

export function segmentIntersectsCapitalCivicCore(start, end, width, core, margin = 0) {
  if (!core) return false;
  assertFinitePoint(start, 'segment start');
  assertFinitePoint(end, 'segment end');
  if (!Number.isFinite(width) || width < 0) throw new RangeError('width must be non-negative');
  if (!Number.isFinite(margin) || margin < 0) throw new RangeError('margin must be non-negative');

  const localStart = toLocal(start.x, start.z, core);
  const localEnd = toLocal(end.x, end.z, core);
  const halfWidth = core.halfWidth + width / 2 + margin;
  const halfDepth = core.halfDepth + width / 2 + margin;
  const dx = localEnd.x - localStart.x;
  const dz = localEnd.z - localStart.z;
  let minimumT = 0;
  let maximumT = 1;

  for (const [origin, direction, minimum, maximum] of [
    [localStart.x, dx, -halfWidth, halfWidth],
    [localStart.z, dz, -halfDepth, halfDepth],
  ]) {
    if (Math.abs(direction) < 1e-12) {
      if (origin < minimum || origin > maximum) return false;
      continue;
    }
    const first = (minimum - origin) / direction;
    const second = (maximum - origin) / direction;
    const entry = Math.min(first, second);
    const exit = Math.max(first, second);
    minimumT = Math.max(minimumT, entry);
    maximumT = Math.min(maximumT, exit);
    if (minimumT > maximumT) return false;
  }
  return true;
}
