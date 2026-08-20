import { FRONTAGE_BUILDING_TYPES } from './building-frontage.js';
import { ROAD_KINDS } from './road-town-structure.js';

export const LOT_BUILDING_TYPES = FRONTAGE_BUILDING_TYPES;
export const LOT_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  OMITTED_UNSAFE: 'OMITTED_UNSAFE',
});
export const TINY_MINIMUM_LOT_PASSAGE = 50;

export const BUILDING_LOT_PROFILES = Object.freeze({
  house: Object.freeze({
    footprintWidth: 260, footprintDepth: 210,
    sideMargin: 12, frontMargin: 25, backMargin: 12,
    entranceOffset: 105, pathWidth: 14, forecourtWidth: 90,
    surfaceClass: 'RESIDENTIAL',
  }),
  tower: Object.freeze({
    footprintWidth: 110, footprintDepth: 110,
    sideMargin: 10, frontMargin: 18, backMargin: 10,
    entranceOffset: 55, pathWidth: 12, forecourtWidth: 70,
    surfaceClass: 'RESIDENTIAL',
  }),
  school: Object.freeze({
    footprintWidth: 380, footprintDepth: 190,
    sideMargin: 35, frontMargin: 55, backMargin: 25,
    entranceOffset: 95, pathWidth: 24, forecourtWidth: 330,
    surfaceClass: 'CIVIC',
  }),
  church: Object.freeze({
    footprintWidth: 165, footprintDepth: 380,
    sideMargin: 40, frontMargin: 65, backMargin: 30,
    entranceOffset: 190, pathWidth: 28, forecourtWidth: 200,
    surfaceClass: 'CIVIC',
  }),
});

const EPSILON = 1e-9;

function finite(...values) {
  return values.every(Number.isFinite);
}

function axes(rotationY) {
  return {
    rightX: Math.cos(rotationY),
    rightZ: -Math.sin(rotationY),
    frontX: Math.sin(rotationY),
    frontZ: Math.cos(rotationY),
  };
}

export function pointInOrientedRectangle(x, z, rectangle, clearance = 0) {
  const basis = axes(rectangle.rotationY);
  const dx = x - rectangle.centerX;
  const dz = z - rectangle.centerZ;
  const localRight = dx * basis.rightX + dz * basis.rightZ;
  const localFront = dx * basis.frontX + dz * basis.frontZ;
  return Math.abs(localRight) <= rectangle.width / 2 + clearance
    && Math.abs(localFront) <= rectangle.depth / 2 + clearance;
}

export function orientedRectangleIntersectsCircle(rectangle, circle, clearance = 0) {
  const basis = axes(rectangle.rotationY);
  const dx = circle.x - rectangle.centerX;
  const dz = circle.z - rectangle.centerZ;
  const localRight = dx * basis.rightX + dz * basis.rightZ;
  const localFront = dx * basis.frontX + dz * basis.frontZ;
  const halfWidth = rectangle.width / 2 + clearance;
  const halfDepth = rectangle.depth / 2 + clearance;
  const closestRight = Math.max(-halfWidth, Math.min(halfWidth, localRight));
  const closestFront = Math.max(-halfDepth, Math.min(halfDepth, localFront));
  return Math.hypot(localRight - closestRight, localFront - closestFront) < circle.radius;
}

export function orientedRectanglesOverlap(first, second, minimumSeparation = 0) {
  // SAT is called for every candidate Lot against the already accepted Lots.
  // Keep the same four-axis/order contract without allocating two basis
  // objects, an axis array, and four axis objects for each comparison.
  const firstRightX = Math.cos(first.rotationY);
  const firstRightZ = -Math.sin(first.rotationY);
  const firstFrontX = Math.sin(first.rotationY);
  const firstFrontZ = Math.cos(first.rotationY);
  const secondRightX = Math.cos(second.rotationY);
  const secondRightZ = -Math.sin(second.rotationY);
  const secondFrontX = Math.sin(second.rotationY);
  const secondFrontZ = Math.cos(second.rotationY);
  const centerDx = second.centerX - first.centerX;
  const centerDz = second.centerZ - first.centerZ;
  const firstHalfWidth = first.width / 2;
  const firstHalfDepth = first.depth / 2;
  const secondHalfWidth = second.width / 2;
  const secondHalfDepth = second.depth / 2;
  const addedHalfSeparation = minimumSeparation / 2;

  const overlapsOnAxis = (axisX, axisZ) => {
    const centerDistance = Math.abs(centerDx * axisX + centerDz * axisZ);
    const firstRadius = firstHalfWidth * Math.abs(firstRightX * axisX + firstRightZ * axisZ)
      + firstHalfDepth * Math.abs(firstFrontX * axisX + firstFrontZ * axisZ)
      + addedHalfSeparation;
    const secondRadius = secondHalfWidth * Math.abs(secondRightX * axisX + secondRightZ * axisZ)
      + secondHalfDepth * Math.abs(secondFrontX * axisX + secondFrontZ * axisZ)
      + addedHalfSeparation;
    return !(centerDistance >= firstRadius + secondRadius);
  };

  return overlapsOnAxis(firstRightX, firstRightZ)
    && overlapsOnAxis(firstFrontX, firstFrontZ)
    && overlapsOnAxis(secondRightX, secondRightZ)
    && overlapsOnAxis(secondFrontX, secondFrontZ);
}

export function roadSurfaceToRectangle(surface) {
  return Object.freeze({
    centerX: surface.x,
    centerZ: surface.z,
    rotationY: Math.atan2(surface.tangentX, surface.tangentZ),
    width: surface.width,
    depth: surface.length,
  });
}

export function bridgeToRectangle(bridge) {
  return Object.freeze({
    centerX: bridge.x,
    centerZ: bridge.z,
    rotationY: bridge.angle,
    width: bridge.halfWidth * 2,
    depth: bridge.halfLength * 2,
  });
}

export function createBuildingLot({
  buildingType,
  buildingIndex,
  buildingX,
  buildingZ,
  rotationY,
  frontage,
  road,
}) {
  const profile = BUILDING_LOT_PROFILES[buildingType];
  if (!profile) throw new RangeError(`unsupported lot building type: ${buildingType}`);
  if (!frontage || !road || frontage.frontageRoadKind === ROAD_KINDS.START_APPROACH) {
    throw new RangeError('valid non-START_APPROACH frontage is required');
  }
  const frontLength = Math.hypot(frontage.frontageNormalX, frontage.frontageNormalZ);
  if (!finite(buildingX, buildingZ, rotationY, frontLength) || frontLength <= EPSILON) {
    throw new RangeError('finite building and frontage values are required');
  }
  const frontX = frontage.frontageNormalX / frontLength;
  const frontZ = frontage.frontageNormalZ / frontLength;
  const frontMargin = profile.frontMargin;
  const width = profile.footprintWidth + profile.sideMargin * 2;
  const depth = profile.footprintDepth + frontMargin + profile.backMargin;
  const centerShift = (frontMargin - profile.backMargin) / 2;
  const centerX = buildingX + frontX * centerShift;
  const centerZ = buildingZ + frontZ * centerShift;
  const entranceX = buildingX + frontX * profile.entranceOffset;
  const entranceZ = buildingZ + frontZ * profile.entranceOffset;
  const roadAccessX = frontage.frontageX - frontX * road.width / 2;
  const roadAccessZ = frontage.frontageZ - frontZ * road.width / 2;
  const accessDx = roadAccessX - entranceX;
  const accessDz = roadAccessZ - entranceZ;
  const pathLength = accessDx * frontX + accessDz * frontZ;
  const pathCenterX = entranceX + frontX * pathLength / 2;
  const pathCenterZ = entranceZ + frontZ * pathLength / 2;
  const forecourtDepth = Math.max(8, frontMargin);
  const forecourtCenterX = buildingX + frontX * (profile.footprintDepth / 2 + forecourtDepth / 2);
  const forecourtCenterZ = buildingZ + frontZ * (profile.footprintDepth / 2 + forecourtDepth / 2);

  const lot = {
    lotId: `lot-${String(buildingIndex).padStart(4, '0')}`,
    buildingIndex,
    buildingType,
    buildingX,
    buildingZ,
    footprintWidth: profile.footprintWidth,
    footprintDepth: profile.footprintDepth,
    frontageRoadId: frontage.frontageRoadId,
    frontageRoadKind: frontage.frontageRoadKind,
    centerX,
    centerZ,
    rotationY,
    width,
    depth,
    frontX,
    frontZ,
    entranceX,
    entranceZ,
    roadAccessX,
    roadAccessZ,
    frontageNormalX: frontX,
    frontageNormalZ: frontZ,
    hasEntrancePath: pathLength > 2,
    lotStatus: LOT_STATUS.ACTIVE,
    omissionReason: null,
    frontMargin,
    backMargin: profile.backMargin,
    sideMargin: profile.sideMargin,
    pathWidth: profile.pathWidth,
    pathLength,
    pathRectangle: Object.freeze({
      centerX: pathCenterX,
      centerZ: pathCenterZ,
      rotationY,
      width: profile.pathWidth,
      depth: Math.max(0, pathLength),
    }),
    forecourtRectangle: Object.freeze({
      centerX: forecourtCenterX,
      centerZ: forecourtCenterZ,
      rotationY,
      width: Math.min(profile.forecourtWidth, width),
      depth: forecourtDepth,
    }),
    surfaceClass: profile.surfaceClass,
  };
  if (!finite(
    lot.centerX, lot.centerZ, lot.rotationY, lot.width, lot.depth,
    lot.entranceX, lot.entranceZ, lot.roadAccessX, lot.roadAccessZ,
    lot.pathLength,
  )) throw new RangeError('lot contains non-finite values');
  return Object.freeze(lot);
}

export function omitBuildingLot(lot, reason) {
  return Object.freeze({
    ...lot,
    hasEntrancePath: false,
    lotStatus: LOT_STATUS.OMITTED_UNSAFE,
    omissionReason: reason,
  });
}

export function getLotSurfaceDescriptors(lot) {
  if (lot.lotStatus !== LOT_STATUS.ACTIVE) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({ ...lot.forecourtRectangle, surfaceKind: lot.surfaceClass === 'CIVIC' ? 'FORECOURT' : 'FRONT_YARD' }),
    Object.freeze({ ...lot.pathRectangle, surfaceKind: 'ENTRANCE_PATH' }),
  ]);
}

export function lotContainsBuildingFootprint(lot) {
  const profile = BUILDING_LOT_PROFILES[lot.buildingType];
  if (!profile || !finite(lot.buildingX, lot.buildingZ)) return false;
  const basis = axes(lot.rotationY);
  const halfWidth = profile.footprintWidth / 2;
  const halfDepth = profile.footprintDepth / 2;
  return [
    [-halfWidth, -halfDepth],
    [-halfWidth, halfDepth],
    [halfWidth, -halfDepth],
    [halfWidth, halfDepth],
  ].every(([right, front]) => pointInOrientedRectangle(
    lot.buildingX + basis.rightX * right + basis.frontX * front,
    lot.buildingZ + basis.rightZ * right + basis.frontZ * front,
    lot,
    EPSILON,
  ));
}
