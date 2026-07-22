import { SETTLEMENT_TYPES } from './settlement-type.js';

export const CIVIC_SPACE_TYPES = Object.freeze({
  CITY_SQUARE: 'CITY_SQUARE',
  CHURCH_SQUARE: 'CHURCH_SQUARE',
  SCHOOL_SQUARE: 'SCHOOL_SQUARE',
});

export const CIVIC_SPACE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  OMITTED_UNSAFE: 'OMITTED_UNSAFE',
});

export const CIVIC_SPACE_MATERIALS = Object.freeze({
  [CIVIC_SPACE_TYPES.CITY_SQUARE]: Object.freeze({ color: 0x625f57, label: 'DARK_STONE' }),
  [CIVIC_SPACE_TYPES.CHURCH_SQUARE]: Object.freeze({ color: 0x806d5b, label: 'WARM_STONE' }),
  [CIVIC_SPACE_TYPES.SCHOOL_SQUARE]: Object.freeze({ color: 0x73736d, label: 'GREY_SANDSTONE' }),
});

const TARGETS = Object.freeze([
  Object.freeze({
    townType: 'capital',
    settlementType: SETTLEMENT_TYPES.CITY,
    civicSpaceType: CIVIC_SPACE_TYPES.CITY_SQUARE,
    width: 260,
    depth: 200,
    accessWidth: 32,
  }),
  Object.freeze({
    townType: 'church_town',
    settlementType: SETTLEMENT_TYPES.TOWN,
    civicSpaceType: CIVIC_SPACE_TYPES.CHURCH_SQUARE,
    landmarkType: 'church',
    width: 200,
    depth: 150,
    accessWidth: 30,
    landmarkHalfWidth: 83,
    landmarkHalfDepth: 195,
    lateralOffsets: Object.freeze([-160, 160, -240, 240, -320, 320, -400, 400, -480, 480]),
  }),
  Object.freeze({
    townType: 'school_town',
    settlementType: SETTLEMENT_TYPES.TOWN,
    civicSpaceType: CIVIC_SPACE_TYPES.SCHOOL_SQUARE,
    landmarkType: 'school',
    width: 220,
    depth: 170,
    accessWidth: 30,
    landmarkHalfWidth: 190,
    landmarkHalfDepth: 80,
    lateralOffsets: Object.freeze([0, -110, 110, -220, 220, -330, 330]),
  }),
]);

const EPSILON = 1e-7;
const LANDMARK_GAP = 18;
const MAX_ACCESS_LENGTH = 520;

const finite = value => typeof value === 'number' && Number.isFinite(value);

function getAxes(rotationY) {
  return Object.freeze({
    rightX: Math.cos(rotationY),
    rightZ: -Math.sin(rotationY),
    frontX: Math.sin(rotationY),
    frontZ: Math.cos(rotationY),
  });
}

function rectangleCorners(rectangle) {
  const axes = getAxes(rectangle.rotationY);
  const halfWidth = rectangle.width / 2;
  const halfDepth = rectangle.depth / 2;
  return [
    [-halfWidth, -halfDepth],
    [halfWidth, -halfDepth],
    [halfWidth, halfDepth],
    [-halfWidth, halfDepth],
  ].map(([localX, localZ]) => Object.freeze({
    x: rectangle.centerX + axes.rightX * localX + axes.frontX * localZ,
    z: rectangle.centerZ + axes.rightZ * localX + axes.frontZ * localZ,
  }));
}

function projectCorners(corners, axisX, axisZ) {
  const projections = corners.map(corner => corner.x * axisX + corner.z * axisZ);
  return { minimum: Math.min(...projections), maximum: Math.max(...projections) };
}

function circleIntersectsRectangle(zone, rectangle, clearance = 0) {
  const axes = getAxes(rectangle.rotationY);
  const dx = zone.x - rectangle.centerX;
  const dz = zone.z - rectangle.centerZ;
  const localX = dx * axes.rightX + dz * axes.rightZ;
  const localZ = dx * axes.frontX + dz * axes.frontZ;
  const closestX = Math.max(-rectangle.width / 2, Math.min(rectangle.width / 2, localX));
  const closestZ = Math.max(-rectangle.depth / 2, Math.min(rectangle.depth / 2, localZ));
  return Math.hypot(localX - closestX, localZ - closestZ) < zone.radius + clearance;
}

export function orientedRectanglesOverlap(first, second, clearance = 0) {
  const firstCorners = rectangleCorners({
    ...first,
    width: first.width + clearance * 2,
    depth: first.depth + clearance * 2,
  });
  const secondCorners = rectangleCorners({
    ...second,
    width: second.width + clearance * 2,
    depth: second.depth + clearance * 2,
  });
  const firstAxes = getAxes(first.rotationY);
  const secondAxes = getAxes(second.rotationY);
  const axes = [
    [firstAxes.rightX, firstAxes.rightZ],
    [firstAxes.frontX, firstAxes.frontZ],
    [secondAxes.rightX, secondAxes.rightZ],
    [secondAxes.frontX, secondAxes.frontZ],
  ];
  return axes.every(([axisX, axisZ]) => {
    const firstProjection = projectCorners(firstCorners, axisX, axisZ);
    const secondProjection = projectCorners(secondCorners, axisX, axisZ);
    return firstProjection.maximum > secondProjection.minimum + EPSILON
      && secondProjection.maximum > firstProjection.minimum + EPSILON;
  });
}

export function pointInCivicSpaceReservation(x, z, civicSpace, clearance = 0) {
  if (civicSpace.status !== CIVIC_SPACE_STATUS.ACTIVE) return false;
  const axes = getAxes(civicSpace.rotationY);
  const dx = x - civicSpace.centerX;
  const dz = z - civicSpace.centerZ;
  const localX = dx * axes.rightX + dz * axes.rightZ;
  const localZ = dx * axes.frontX + dz * axes.frontZ;
  const inBody = Math.abs(localX) <= civicSpace.width / 2 + clearance
    && Math.abs(localZ) <= civicSpace.depth / 2 + clearance;
  if (inBody) return true;
  const access = civicSpaceToAccessRectangle(civicSpace);
  if (!access) return false;
  const accessAxes = getAxes(access.rotationY);
  const accessDx = x - access.centerX;
  const accessDz = z - access.centerZ;
  return Math.abs(accessDx * accessAxes.rightX + accessDz * accessAxes.rightZ)
      <= access.width / 2 + clearance
    && Math.abs(accessDx * accessAxes.frontX + accessDz * accessAxes.frontZ)
      <= access.depth / 2 + clearance;
}

export function circleIntersectsCivicSpaceReservation(
  x,
  z,
  radius,
  civicSpace,
  clearance = 0,
) {
  if (civicSpace.status !== CIVIC_SPACE_STATUS.ACTIVE) return false;
  return [civicSpaceToBodyRectangle(civicSpace), civicSpaceToAccessRectangle(civicSpace)]
    .filter(Boolean)
    .some(rectangle => {
      const axes = getAxes(rectangle.rotationY);
      const dx = x - rectangle.centerX;
      const dz = z - rectangle.centerZ;
      const localX = dx * axes.rightX + dz * axes.rightZ;
      const localZ = dx * axes.frontX + dz * axes.frontZ;
      const closestX = Math.max(-rectangle.width / 2, Math.min(rectangle.width / 2, localX));
      const closestZ = Math.max(-rectangle.depth / 2, Math.min(rectangle.depth / 2, localZ));
      return Math.hypot(localX - closestX, localZ - closestZ) < radius + clearance;
    });
}

export function civicSpaceToBodyRectangle(civicSpace) {
  return Object.freeze({
    centerX: civicSpace.centerX,
    centerZ: civicSpace.centerZ,
    rotationY: civicSpace.rotationY,
    width: civicSpace.width,
    depth: civicSpace.depth,
  });
}

export function civicSpaceToAccessRectangle(civicSpace) {
  if (civicSpace.status !== CIVIC_SPACE_STATUS.ACTIVE) return null;
  const dx = civicSpace.accessEndX - civicSpace.accessStartX;
  const dz = civicSpace.accessEndZ - civicSpace.accessStartZ;
  const length = Math.hypot(dx, dz);
  if (length <= EPSILON) return null;
  return Object.freeze({
    centerX: (civicSpace.accessStartX + civicSpace.accessEndX) / 2,
    centerZ: (civicSpace.accessStartZ + civicSpace.accessEndZ) / 2,
    rotationY: Math.atan2(dx, dz),
    width: civicSpace.accessWidth,
    depth: length,
  });
}

function roadToRectangle(road) {
  const length = Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z);
  return Object.freeze({
    centerX: (road.start.x + road.end.x) / 2,
    centerZ: (road.start.z + road.end.z) / 2,
    rotationY: Math.atan2(road.tangentX, road.tangentZ),
    width: road.width,
    depth: length,
  });
}

function surfaceToRectangle(surface) {
  return Object.freeze({
    centerX: surface.x,
    centerZ: surface.z,
    rotationY: Math.atan2(surface.tangentX ?? 0, surface.tangentZ ?? 1),
    width: surface.width,
    depth: surface.length,
  });
}

function bridgeToRectangle(bridge) {
  const dx = bridge.end.x - bridge.start.x;
  const dz = bridge.end.z - bridge.start.z;
  return Object.freeze({
    centerX: (bridge.start.x + bridge.end.x) / 2,
    centerZ: (bridge.start.z + bridge.end.z) / 2,
    rotationY: Math.atan2(dx, dz),
    width: bridge.width,
    depth: Math.hypot(dx, dz),
  });
}

function closestPointOnRoad(point, road) {
  const dx = road.end.x - road.start.x;
  const dz = road.end.z - road.start.z;
  const lengthSquared = dx * dx + dz * dz;
  const along = lengthSquared <= EPSILON
    ? 0
    : Math.max(0, Math.min(1, (
      (point.x - road.start.x) * dx + (point.z - road.start.z) * dz
    ) / lengthSquared));
  return Object.freeze({
    x: road.start.x + dx * along,
    z: road.start.z + dz * along,
  });
}

function pointOnRectangleBoundaryToward(rectangle, target) {
  const axes = getAxes(rectangle.rotationY);
  const dx = target.x - rectangle.centerX;
  const dz = target.z - rectangle.centerZ;
  const localX = dx * axes.rightX + dz * axes.rightZ;
  const localZ = dx * axes.frontX + dz * axes.frontZ;
  const scale = 1 / Math.max(
    Math.abs(localX) / (rectangle.width / 2),
    Math.abs(localZ) / (rectangle.depth / 2),
  );
  return Object.freeze({
    x: rectangle.centerX + axes.rightX * localX * scale + axes.frontX * localZ * scale,
    z: rectangle.centerZ + axes.rightZ * localX * scale + axes.frontZ * localZ * scale,
  });
}

function makeOmitted(target, town, reason) {
  return Object.freeze({
    civicSpaceId: `civic-space-${target.townType}`,
    civicSpaceType: target.civicSpaceType,
    townType: target.townType,
    settlementType: town?.settlementType ?? target.settlementType,
    centerX: town?.x ?? null,
    centerZ: town?.z ?? null,
    rotationY: null,
    width: target.width,
    depth: target.depth,
    accessRoadId: null,
    accessWidth: target.accessWidth,
    accessStartX: null,
    accessStartZ: null,
    accessEndX: null,
    accessEndZ: null,
    status: CIVIC_SPACE_STATUS.OMITTED_UNSAFE,
    omissionReason: reason,
  });
}

function makeActive(target, town, rectangle, access) {
  return Object.freeze({
    civicSpaceId: `civic-space-${target.townType}`,
    civicSpaceType: target.civicSpaceType,
    townType: target.townType,
    settlementType: town.settlementType,
    centerX: rectangle.centerX,
    centerZ: rectangle.centerZ,
    rotationY: rectangle.rotationY,
    width: rectangle.width,
    depth: rectangle.depth,
    accessRoadId: access.roadId,
    accessWidth: target.accessWidth,
    accessStartX: access.start.x,
    accessStartZ: access.start.z,
    accessEndX: access.end.x,
    accessEndZ: access.end.z,
    status: CIVIC_SPACE_STATUS.ACTIVE,
    omissionReason: null,
  });
}

function overlapsForbiddenRectangle(rectangle, context, ignoredRoadId = null) {
  const roadOverlap = context.roadRectangles.some(entry => (
    entry.roadId !== ignoredRoadId && orientedRectanglesOverlap(rectangle, entry.rectangle, 2)
  ));
  if (roadOverlap) return 'ROAD_SURFACE_OVERLAP';
  if (context.junctionRectangles.some(candidate => orientedRectanglesOverlap(rectangle, candidate, 2))) {
    return 'JUNCTION_SURFACE_OVERLAP';
  }
  if (context.bridgeRectangles.some(candidate => orientedRectanglesOverlap(rectangle, candidate, 2))) {
    return 'BRIDGE_SURFACE_OVERLAP';
  }
  if (context.protectedZones.some(zone => circleIntersectsRectangle(zone, rectangle, 4))) {
    return 'PROTECTED_ZONE_OVERLAP';
  }
  return null;
}

function createCapitalReservation(target, town, context) {
  const core = context.capitalCivicCore;
  const accessRoads = context.roads.filter(road => road.isCivicAccess);
  if (!core || accessRoads.length !== 1) return makeOmitted(target, town, 'CAPITAL_ACCESS_UNAVAILABLE');
  const rectangle = Object.freeze({
    centerX: core.centerX,
    centerZ: core.centerZ - 10,
    rotationY: core.rotationY,
    width: target.width,
    depth: target.depth,
  });
  const coreMarginX = core.halfWidth - rectangle.width / 2;
  const coreMarginZ = core.halfDepth - Math.abs(rectangle.centerZ - core.centerZ) - rectangle.depth / 2;
  if (coreMarginX < core.clearance || coreMarginZ < core.clearance) {
    return makeOmitted(target, town, 'CITY_SQUARE_OUTSIDE_CORE');
  }
  const bodyConflict = overlapsForbiddenRectangle(rectangle, context);
  if (bodyConflict) return makeOmitted(target, town, bodyConflict);
  const accessRoad = accessRoads[0];
  const axes = getAxes(rectangle.rotationY);
  const start = Object.freeze({
    x: rectangle.centerX - axes.frontX * rectangle.depth / 2,
    z: rectangle.centerZ - axes.frontZ * rectangle.depth / 2,
  });
  const roadEndpoints = [accessRoad.start, accessRoad.end].sort((first, second) => (
    Math.hypot(first.x - start.x, first.z - start.z)
    - Math.hypot(second.x - start.x, second.z - start.z)
  ));
  const end = Object.freeze({ x: roadEndpoints[0].x, z: roadEndpoints[0].z });
  const accessRectangle = civicSpaceToAccessRectangle(makeActive(target, town, rectangle, {
    roadId: accessRoad.roadId,
    start,
    end,
  }));
  const accessConflict = overlapsForbiddenRectangle(accessRectangle, context, accessRoad.roadId);
  if (accessConflict) return makeOmitted(target, town, `ACCESS_${accessConflict}`);
  return makeActive(target, town, rectangle, { roadId: accessRoad.roadId, start, end });
}

function landmarkToRectangle(landmark, target) {
  return Object.freeze({
    centerX: landmark.x,
    centerZ: landmark.z,
    rotationY: landmark.rotationY,
    width: target.landmarkHalfWidth * 2,
    depth: target.landmarkHalfDepth * 2,
  });
}

function createLandmarkReservation(target, town, context) {
  const landmark = context.landmarks.find(candidate => (
    candidate.townType === target.townType && candidate.type === target.landmarkType
  ));
  if (!landmark) return makeOmitted(target, town, 'LANDMARK_UNAVAILABLE');
  const axes = getAxes(landmark.rotationY);
  const forwardDistance = target.landmarkHalfDepth + LANDMARK_GAP + target.depth / 2;
  const landmarkRectangle = landmarkToRectangle(landmark, target);
  const townId = town.id ?? `town-${context.townCenters.indexOf(town)}-${town.type}`;
  const eligibleRoads = context.roads.filter(road => (
    road.townId === townId && (road.kind === 'LOCAL' || road.kind === 'MAJOR')
  ));
  for (const lateralOffset of target.lateralOffsets) {
    const rectangle = Object.freeze({
      centerX: landmark.x + axes.frontX * forwardDistance + axes.rightX * lateralOffset,
      centerZ: landmark.z + axes.frontZ * forwardDistance + axes.rightZ * lateralOffset,
      rotationY: landmark.rotationY,
      width: target.width,
      depth: target.depth,
    });
    if (Math.hypot(rectangle.centerX - town.x, rectangle.centerZ - town.z) + Math.hypot(
      rectangle.width / 2,
      rectangle.depth / 2,
    ) > town.radius) continue;
    if (orientedRectanglesOverlap(rectangle, landmarkRectangle, 1)) continue;
    if (overlapsForbiddenRectangle(rectangle, context)) continue;
    const rankedRoads = eligibleRoads.map(road => {
      const closest = closestPointOnRoad({ x: rectangle.centerX, z: rectangle.centerZ }, road);
      const fromLandmarkX = closest.x - landmark.x;
      const fromLandmarkZ = closest.z - landmark.z;
      return {
        road,
        closest,
        forward: fromLandmarkX * axes.frontX + fromLandmarkZ * axes.frontZ,
        distance: Math.hypot(closest.x - rectangle.centerX, closest.z - rectangle.centerZ),
      };
    }).filter(candidate => candidate.forward > 0)
      .sort((first, second) => (
        first.distance - second.distance
        || (first.road.kind === 'LOCAL' ? -1 : 1)
        || first.road.roadId.localeCompare(second.road.roadId)
      ));
    for (const candidate of rankedRoads) {
      const bodyAnchor = pointOnRectangleBoundaryToward(rectangle, candidate.closest);
      const refinedClosest = closestPointOnRoad(bodyAnchor, candidate.road);
      const towardBodyX = bodyAnchor.x - refinedClosest.x;
      const towardBodyZ = bodyAnchor.z - refinedClosest.z;
      const towardBodyLength = Math.hypot(towardBodyX, towardBodyZ);
      if (towardBodyLength <= candidate.road.width / 2 + 8) continue;
      const roadEdge = Object.freeze({
        x: refinedClosest.x + towardBodyX / towardBodyLength * candidate.road.width / 2,
        z: refinedClosest.z + towardBodyZ / towardBodyLength * candidate.road.width / 2,
      });
      const accessLength = Math.hypot(roadEdge.x - bodyAnchor.x, roadEdge.z - bodyAnchor.z);
      if (accessLength > MAX_ACCESS_LENGTH) continue;
      const provisional = makeActive(target, town, rectangle, {
        roadId: candidate.road.roadId,
        start: bodyAnchor,
        end: roadEdge,
      });
      const accessRectangle = civicSpaceToAccessRectangle(provisional);
      if (orientedRectanglesOverlap(accessRectangle, landmarkRectangle, 4)) continue;
      if (overlapsForbiddenRectangle(accessRectangle, context, candidate.road.roadId)) continue;
      return provisional;
    }
  }
  return makeOmitted(target, town, 'NO_SAFE_FRONT_ACCESS');
}

export function validateCivicSpace(civicSpace) {
  const commonValid = Object.values(CIVIC_SPACE_TYPES).includes(civicSpace.civicSpaceType)
    && Object.values(CIVIC_SPACE_STATUS).includes(civicSpace.status)
    && finite(civicSpace.width) && civicSpace.width > 0
    && finite(civicSpace.depth) && civicSpace.depth > 0
    && finite(civicSpace.accessWidth) && civicSpace.accessWidth >= 24 && civicSpace.accessWidth <= 40;
  if (!commonValid) return Object.freeze({ valid: false, omissionReason: 'INVALID_CONTRACT' });
  if (civicSpace.status === CIVIC_SPACE_STATUS.OMITTED_UNSAFE) {
    return Object.freeze({
      valid: typeof civicSpace.omissionReason === 'string' && civicSpace.omissionReason.length > 0,
      omissionReason: civicSpace.omissionReason,
    });
  }
  const activeValid = [
    civicSpace.centerX,
    civicSpace.centerZ,
    civicSpace.rotationY,
    civicSpace.accessStartX,
    civicSpace.accessStartZ,
    civicSpace.accessEndX,
    civicSpace.accessEndZ,
  ].every(finite) && typeof civicSpace.accessRoadId === 'string';
  return Object.freeze({
    valid: activeValid,
    omissionReason: activeValid ? null : 'INVALID_ACTIVE_CONTRACT',
  });
}

export function createCivicSpaceReservations({
  townCenters,
  landmarks,
  roads,
  roadSurfaces,
  junctionSurfaces,
  bridgeSpans,
  capitalCivicCore,
  waterZones = [],
  exclusionZones = [],
}) {
  const context = Object.freeze({
    townCenters,
    landmarks,
    roads,
    capitalCivicCore,
    roadRectangles: Object.freeze(roadSurfaces.map(surface => Object.freeze({
      roadId: surface.roadId,
      rectangle: surfaceToRectangle(surface),
    }))),
    junctionRectangles: Object.freeze(junctionSurfaces.map(surfaceToRectangle)),
    bridgeRectangles: Object.freeze(bridgeSpans.map(bridgeToRectangle)),
    protectedZones: Object.freeze([...waterZones, ...exclusionZones].map(zone => Object.freeze({
      x: zone.x,
      z: zone.z,
      radius: zone.radius,
    }))),
  });
  return Object.freeze(TARGETS.map(target => {
    const town = townCenters.find(candidate => candidate.type === target.townType);
    if (!town || town.settlementType !== target.settlementType) {
      return makeOmitted(target, town, 'TOWN_UNAVAILABLE');
    }
    const civicSpace = target.civicSpaceType === CIVIC_SPACE_TYPES.CITY_SQUARE
      ? createCapitalReservation(target, town, context)
      : createLandmarkReservation(target, town, context);
    const validation = validateCivicSpace(civicSpace);
    return validation.valid ? civicSpace : makeOmitted(target, town, validation.omissionReason);
  }));
}

export function createCivicSpaceSurfaces(civicSpaces) {
  const bodySurfaces = [];
  const accessSurfaces = [];
  for (const civicSpace of civicSpaces.filter(candidate => (
    candidate.status === CIVIC_SPACE_STATUS.ACTIVE
  ))) {
    bodySurfaces.push(Object.freeze({
      surfaceId: `${civicSpace.civicSpaceId}-surface`,
      civicSpaceId: civicSpace.civicSpaceId,
      civicSpaceType: civicSpace.civicSpaceType,
      materialKey: CIVIC_SPACE_MATERIALS[civicSpace.civicSpaceType].label,
      ...civicSpaceToBodyRectangle(civicSpace),
    }));
    accessSurfaces.push(Object.freeze({
      surfaceId: `${civicSpace.civicSpaceId}-access-surface`,
      civicSpaceId: civicSpace.civicSpaceId,
      civicSpaceType: civicSpace.civicSpaceType,
      materialKey: CIVIC_SPACE_MATERIALS[civicSpace.civicSpaceType].label,
      ...civicSpaceToAccessRectangle(civicSpace),
    }));
  }
  return Object.freeze({
    bodySurfaces: Object.freeze(bodySurfaces),
    accessSurfaces: Object.freeze(accessSurfaces),
    surfaceInstanceCount: bodySurfaces.length + accessSurfaces.length,
  });
}
