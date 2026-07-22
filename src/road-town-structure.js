import { SETTLEMENT_TYPES } from './settlement-type.js';
import { getSettlementRoadParameters } from './settlement-road-parameters.js';
import {
  createCapitalCivicCore,
  isPointInCapitalCivicCore,
  segmentIntersectsCapitalCivicCore,
} from './capital-civic-core.js';

export const ROAD_KINDS = Object.freeze({
  MAJOR: 'MAJOR',
  LOCAL: 'LOCAL',
  ALLEY: 'ALLEY',
  START_APPROACH: 'START_APPROACH',
});

export const ROAD_KIND_LIST = Object.freeze(Object.values(ROAD_KINDS));

export const ROAD_WIDTH_RANGES = Object.freeze({
  [ROAD_KINDS.MAJOR]: Object.freeze({ min: 80, max: 100 }),
  [ROAD_KINDS.LOCAL]: Object.freeze({ min: 58, max: 72 }),
  [ROAD_KINDS.ALLEY]: Object.freeze({ min: 38, max: 50 }),
  [ROAD_KINDS.START_APPROACH]: Object.freeze({ min: 48, max: 64 }),
});

export const ROAD_WIDTHS = Object.freeze({
  [ROAD_KINDS.MAJOR]: 90,
  [ROAD_KINDS.LOCAL]: 64,
  [ROAD_KINDS.ALLEY]: 44,
  [ROAD_KINDS.START_APPROACH]: 56,
});

const ROAD_SAMPLE_SPACING = Object.freeze({
  [ROAD_KINDS.MAJOR]: 72,
  [ROAD_KINDS.LOCAL]: 52,
  [ROAD_KINDS.ALLEY]: 36,
  [ROAD_KINDS.START_APPROACH]: 48,
});

const MAJOR_CONNECTION_DISTANCE = 11000;
const EPSILON = 1e-6;

const point = source => ({ x: source.x, z: source.z });
const lerp = (a, b, t) => ({
  x: a.x + (b.x - a.x) * t,
  z: a.z + (b.z - a.z) * t,
});

function normalize(dx, dz) {
  const length = Math.hypot(dx, dz);
  if (length <= EPSILON) return null;
  return { x: dx / length, z: dz / length, length };
}

function getTownId(town, townIndex) {
  return town.id ?? `town-${townIndex}-${town.type}`;
}

function isPointInWater(testPoint, waterZones, clearance = 0) {
  return waterZones.some(zone => {
    const dx = testPoint.x - zone.x;
    const dz = testPoint.z - zone.z;
    const radius = zone.radius + clearance;
    return dx * dx + dz * dz < radius * radius;
  });
}

function closestPointOnSegment(testPoint, segment) {
  const dx = segment.end.x - segment.start.x;
  const dz = segment.end.z - segment.start.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq <= EPSILON
    ? 0
    : Math.max(0, Math.min(1,
      ((testPoint.x - segment.start.x) * dx + (testPoint.z - segment.start.z) * dz) / lengthSq));
  const closest = {
    x: segment.start.x + dx * t,
    z: segment.start.z + dz * t,
  };
  const distanceSq = (testPoint.x - closest.x) ** 2 + (testPoint.z - closest.z) ** 2;
  return { point: closest, distanceSq, t };
}

export function getMajorTownConnections(townCenters) {
  const connections = [];
  for (let fromIndex = 0; fromIndex < townCenters.length; fromIndex++) {
    for (let toIndex = fromIndex + 1; toIndex < townCenters.length; toIndex++) {
      const from = townCenters[fromIndex];
      const to = townCenters[toIndex];
      const distance = Math.hypot(from.x - to.x, from.z - to.z);
      if (distance <= MAJOR_CONNECTION_DISTANCE) {
        connections.push(Object.freeze({
          fromIndex,
          toIndex,
          fromTownId: getTownId(from, fromIndex),
          toTownId: getTownId(to, toIndex),
        }));
      }
    }
  }
  return Object.freeze(connections);
}

export function getRoadKindCounts(roads) {
  const counts = Object.fromEntries(ROAD_KIND_LIST.map(kind => [kind, 0]));
  for (const road of roads) counts[road.kind]++;
  return counts;
}

export function buildRoadHierarchy({ townCenters, waterZones = [], exclusionZones = [] }) {
  if (!Array.isArray(townCenters) || townCenters.length === 0) {
    throw new TypeError('townCenters must be a non-empty array');
  }
  if (!Array.isArray(waterZones)) throw new TypeError('waterZones must be an array');
  if (!Array.isArray(exclusionZones)) throw new TypeError('exclusionZones must be an array');

  const roads = [];
  const junctions = [];
  const omittedRoutes = [];
  const majorConnections = getMajorTownConnections(townCenters);
  const roadsById = new Map();
  const incidentMajorRoads = new Map(townCenters.map((town, townIndex) => [getTownId(town, townIndex), []]));
  let junctionIndex = 0;
  const capitalTownIndex = townCenters.findIndex(town => (
    town.type === 'capital' && town.settlementType === SETTLEMENT_TYPES.CITY
  ));
  const initialCapitalCivicCore = capitalTownIndex === -1
    ? null
    : createCapitalCivicCore(townCenters[capitalTownIndex]);
  const capitalTownId = capitalTownIndex === -1
    ? null
    : getTownId(townCenters[capitalTownIndex], capitalTownIndex);
  let capitalCivicCore = initialCapitalCivicCore;
  let capitalTopology = null;

  const omitRoute = (routeId, kind, reason) => {
    if (omittedRoutes.some(route => route.routeId === routeId)) return;
    omittedRoutes.push(Object.freeze({ routeId, kind, reason }));
  };

  const isPointInExclusion = (testPoint, clearance = 0) => exclusionZones.some(zone => {
    const dx = testPoint.x - zone.x;
    const dz = testPoint.z - zone.z;
    const radius = zone.radius + clearance;
    return dx * dx + dz * dz < radius * radius;
  });

  const townHubs = townCenters.map((town, townIndex) => {
    const center = point(town);
    if (!isPointInExclusion(center, ROAD_WIDTHS[ROAD_KINDS.MAJOR] / 2 + 18)) return center;

    const nearbyZones = exclusionZones.filter(zone => (
      (zone.x - town.x) ** 2 + (zone.z - town.z) ** 2 < 800 ** 2
    ));
    const hubRadius = Math.max(
      240,
      ...nearbyZones.map(zone => zone.radius + ROAD_WIDTHS[ROAD_KINDS.MAJOR] / 2 + 70),
    );
    let bestCandidate = null;
    for (let candidateIndex = 0; candidateIndex < 16; candidateIndex++) {
      const angle = townIndex * 1.37 + candidateIndex / 16 * Math.PI * 2;
      const candidate = {
        x: town.x + Math.sin(angle) * hubRadius,
        z: town.z + Math.cos(angle) * hubRadius,
      };
      if (isPointInWater(candidate, waterZones, ROAD_WIDTHS[ROAD_KINDS.MAJOR] / 2)) continue;
      const clearance = nearbyZones.reduce(
        (smallest, zone) => Math.min(smallest, Math.hypot(candidate.x - zone.x, candidate.z - zone.z) - zone.radius),
        Infinity,
      );
      if (!bestCandidate || clearance > bestCandidate.clearance) {
        bestCandidate = { ...candidate, clearance };
      }
    }
    return bestCandidate ? { x: bestCandidate.x, z: bestCandidate.z } : center;
  });

  const incidentConnections = townCenters.map(() => []);
  for (let connectionIndex = 0; connectionIndex < majorConnections.length; connectionIndex++) {
    const connection = majorConnections[connectionIndex];
    incidentConnections[connection.fromIndex].push({ connectionIndex, side: 'from', otherIndex: connection.toIndex });
    incidentConnections[connection.toIndex].push({ connectionIndex, side: 'to', otherIndex: connection.fromIndex });
  }

  const townSpineDirections = townCenters.map((town, townIndex) => {
    const firstConnection = incidentConnections[townIndex][0];
    let preferredAngle = 0.4 + townIndex * 1.37;
    if (firstConnection) {
      const otherHub = townHubs[firstConnection.otherIndex];
      const direction = normalize(otherHub.x - townHubs[townIndex].x, otherHub.z - townHubs[townIndex].z);
      if (direction) preferredAngle = Math.atan2(-direction.z, direction.x);
    }
    const halfLength = town.coreRadius * 0.42;
    let best = null;
    for (let candidateIndex = 0; candidateIndex < 16; candidateIndex++) {
      const angleOffset = (candidateIndex % 2 === 0 ? 1 : -1) * Math.ceil(candidateIndex / 2) * Math.PI / 16;
      const angle = preferredAngle + angleOffset;
      const direction = { x: Math.sin(angle), z: Math.cos(angle) };
      const segment = {
        start: {
          x: townHubs[townIndex].x - direction.x * halfLength,
          z: townHubs[townIndex].z - direction.z * halfLength,
        },
        end: {
          x: townHubs[townIndex].x + direction.x * halfLength,
          z: townHubs[townIndex].z + direction.z * halfLength,
        },
      };
      let clearance = Infinity;
      for (const zone of [...exclusionZones, ...waterZones]) {
        const candidate = closestPointOnSegment(zone, segment);
        clearance = Math.min(clearance, Math.sqrt(candidate.distanceSq) - zone.radius);
      }
      if (!best || clearance > best.clearance) best = { direction, clearance };
    }
    return Object.freeze(best.direction);
  });

  // 複数のMAJORを町中心の一点へ集めず、LOCAL spine上の独立したT字接続へ分散する。
  const majorPortByEndpoint = new Map();
  const majorPortSpacing = ROAD_WIDTHS[ROAD_KINDS.MAJOR] * 1.5;
  for (let townIndex = 0; townIndex < townCenters.length; townIndex++) {
    const incidents = incidentConnections[townIndex];
    const hub = townHubs[townIndex];
    const spineDirection = townSpineDirections[townIndex];
    const selectedDistances = [];
    for (let incidentIndex = 0; incidentIndex < incidents.length; incidentIndex++) {
      const incident = incidents[incidentIndex];
      const desiredDistance = (incidentIndex - (incidents.length - 1) / 2) * majorPortSpacing;
      const offsets = [0, majorPortSpacing, -majorPortSpacing, majorPortSpacing * 2, -majorPortSpacing * 2];
      let distance = null;
      for (const offset of offsets) {
        const candidateDistance = desiredDistance + offset;
        const candidate = {
          x: hub.x + spineDirection.x * candidateDistance,
          z: hub.z + spineDirection.z * candidateDistance,
        };
        if (selectedDistances.some(existing => Math.abs(existing - candidateDistance) < majorPortSpacing)) continue;
        if (isPointInWater(candidate, waterZones, ROAD_WIDTHS[ROAD_KINDS.MAJOR] * 2 + 18)) continue;
        if (isPointInExclusion(candidate, ROAD_WIDTHS[ROAD_KINDS.MAJOR] * 2 + 18)) continue;
        distance = candidateDistance;
        break;
      }
      if (distance === null) throw new RangeError(`no safe MAJOR port for town ${townIndex}`);
      selectedDistances.push(distance);
      majorPortByEndpoint.set(`${incident.connectionIndex}:${incident.side}`, Object.freeze({
        x: hub.x + spineDirection.x * distance,
        z: hub.z + spineDirection.z * distance,
        distance,
      }));
    }
  }

  const legacyMajorPortByEndpoint = new Map(majorPortByEndpoint);
  if (capitalTownIndex !== -1) {
    const capital = townCenters[capitalTownIndex];
    const parameters = getSettlementRoadParameters(SETTLEMENT_TYPES.CITY);
    const collectorZ = capitalCivicCore.centerZ
      - capitalCivicCore.halfDepth - ROAD_WIDTHS[ROAD_KINDS.MAJOR] / 2 - 2;
    const westX = capitalCivicCore.centerX - 360;
    const eastX = capitalCivicCore.centerX + 700;
    const portByTownType = Object.freeze({
      church_town: Object.freeze({ x: eastX, z: capitalCivicCore.centerZ + 280, outwardX: 0, outwardZ: 1 }),
      school_town: Object.freeze({ x: westX, z: collectorZ, outwardX: -1, outwardZ: 0 }),
      residential: Object.freeze({ x: capitalCivicCore.centerX, z: collectorZ, outwardX: 0, outwardZ: -1 }),
    });
    const capitalPorts = [];
    for (const incident of incidentConnections[capitalTownIndex]) {
      const otherTown = townCenters[incident.otherIndex];
      const port = portByTownType[otherTown.type];
      if (!port) throw new RangeError(`no Capital Civic Core MAJOR port for ${otherTown.type}`);
      if (isPointInCapitalCivicCore(port.x, port.z, capitalCivicCore)) {
        throw new RangeError(`Capital Civic Core MAJOR port enters the Core: ${otherTown.type}`);
      }
      const endpointKey = `${incident.connectionIndex}:${incident.side}`;
      majorPortByEndpoint.set(endpointKey, Object.freeze({
        x: port.x,
        z: port.z,
        distance: null,
        outwardX: port.outwardX,
        outwardZ: port.outwardZ,
        isCapitalCivicPort: true,
      }));
      capitalPorts.push(Object.freeze({
        endpointKey,
        connectionIndex: incident.connectionIndex,
        otherTownType: otherTown.type,
        x: port.x,
        z: port.z,
        outwardX: port.outwardX,
        outwardZ: port.outwardZ,
      }));
    }
    capitalPorts.sort((first, second) => first.connectionIndex - second.connectionIndex);
    for (let firstIndex = 0; firstIndex < capitalPorts.length; firstIndex++) {
      for (let secondIndex = firstIndex + 1; secondIndex < capitalPorts.length; secondIndex++) {
        if (Math.hypot(
          capitalPorts[firstIndex].x - capitalPorts[secondIndex].x,
          capitalPorts[firstIndex].z - capitalPorts[secondIndex].z,
        ) < 180) throw new RangeError('Capital Civic Core MAJOR port spacing is below 180');
      }
    }
    capitalTopology = {
      collectorZ,
      westX,
      eastX,
      northZ: capitalCivicCore.centerZ + 280,
      ports: capitalPorts,
    };
  }

  const routeAroundExclusions = (routePoints, kind, routeId, width = ROAD_WIDTHS[kind]) => {
    if (exclusionZones.length === 0) return routePoints;
    const routed = [routePoints[0]];
    for (let pointIndex = 0; pointIndex < routePoints.length - 1; pointIndex++) {
      const start = routePoints[pointIndex];
      const end = routePoints[pointIndex + 1];
      const direction = normalize(end.x - start.x, end.z - start.z);
      if (!direction) continue;
      const collisions = [];
      for (let zoneIndex = 0; zoneIndex < exclusionZones.length; zoneIndex++) {
        const zone = exclusionZones[zoneIndex];
        const along = (zone.x - start.x) * direction.x + (zone.z - start.z) * direction.z;
        if (along <= 0 || along >= direction.length) continue;
        const projection = {
          x: start.x + direction.x * along,
          z: start.z + direction.z * along,
        };
        const clearance = zone.radius + width / 2 + 18;
        const distance = Math.hypot(zone.x - projection.x, zone.z - projection.z);
        if (distance < clearance) collisions.push({ zone, zoneIndex, along, projection, clearance });
      }
      collisions.sort((a, b) => a.along - b.along);
      if (collisions.length > 0) {
        const firstCollision = collisions[0];
        const clearLeadLength = firstCollision.along - firstCollision.clearance;
        if (clearLeadLength >= width * 2) {
          routed.push({
            x: start.x + direction.x * width * 2,
            z: start.z + direction.z * width * 2,
          });
        }
      }
      for (const collision of collisions) {
        const sideSelector = [...routeId].reduce((total, character) => total + character.charCodeAt(0), 0);
        const side = (sideSelector + collision.zoneIndex) % 2 === 0 ? 1 : -1;
        const normalX = -direction.z * side;
        const normalZ = direction.x * side;
        const alongOffset = collision.clearance * 0.9;
        const sideOffset = collision.clearance * 1.15;
        routed.push({
          x: collision.projection.x - direction.x * alongOffset + normalX * sideOffset,
          z: collision.projection.z - direction.z * alongOffset + normalZ * sideOffset,
        });
        routed.push({
          x: collision.projection.x + direction.x * alongOffset + normalX * sideOffset,
          z: collision.projection.z + direction.z * alongOffset + normalZ * sideOffset,
        });
      }
      if (collisions.length > 0) {
        const lastCollision = collisions.at(-1);
        const clearLeadLength = direction.length - lastCollision.along - lastCollision.clearance;
        if (clearLeadLength >= width * 2) {
          routed.push({
            x: end.x - direction.x * width * 2,
            z: end.z - direction.z * width * 2,
          });
        }
      }
      routed.push(end);
    }
    return routed.filter((candidate, index) => {
      if (index === 0) return true;
      const previous = routed[index - 1];
      return Math.hypot(candidate.x - previous.x, candidate.z - previous.z) > EPSILON;
    });
  };

  const addRoadSegment = ({
    kind,
    routeId,
    routeOrder,
    town,
    townId,
    start,
    end,
    width = ROAD_WIDTHS[kind],
    sampleSpacing = ROAD_SAMPLE_SPACING[kind],
    curvature = 0,
    roadPattern = null,
    roadSurfaceOverlap = null,
    parentRoadId = null,
    isTownSpine = false,
    isCapitalCollector = false,
    isCivicAccess = false,
  }) => {
    const direction = normalize(end.x - start.x, end.z - start.z);
    if (!direction) throw new RangeError(`zero-length road segment: ${routeId}`);
    const road = Object.freeze({
      roadId: `road-${String(roads.length).padStart(3, '0')}`,
      routeId,
      routeOrder,
      kind,
      townId,
      town,
      start: Object.freeze(point(start)),
      end: Object.freeze(point(end)),
      width,
      ...(roadPattern === null ? {} : {
        sampleSpacing,
        curvature,
        roadPattern,
        roadSurfaceOverlap,
      }),
      tangentX: direction.x,
      tangentZ: direction.z,
      normalX: -direction.z,
      normalZ: direction.x,
      parentRoadId,
      isTownSpine,
      isCapitalCollector,
      isCivicAccess,
    });
    roads.push(road);
    roadsById.set(road.roadId, road);
    return road;
  };

  const addPolyline = ({
    kind,
    routeId,
    points,
    townResolver,
    parentRoadId = null,
    isTownSpine = false,
    preserveStartDirection = false,
    preserveEndDirection = false,
    width = ROAD_WIDTHS[kind],
    sampleSpacing = ROAD_SAMPLE_SPACING[kind],
    curvature = 0,
    roadPattern = null,
    roadSurfaceOverlap = null,
    isCapitalCollector = false,
    isCivicAccess = false,
  }) => {
    const segments = [];
    let nextParentRoadId = parentRoadId;
    let routedPoints = routeAroundExclusions(points, kind, routeId, width);
    const protectedLength = width * 2;
    if (preserveStartDirection && points.length >= 2) {
      const direction = normalize(points[1].x - points[0].x, points[1].z - points[0].z);
      if (direction && direction.length >= protectedLength) {
        const protectedPoint = {
          x: points[0].x + direction.x * protectedLength,
          z: points[0].z + direction.z * protectedLength,
        };
        const remaining = routedPoints.slice(1).filter((candidate, index, candidates) => {
          if (index === candidates.length - 1) return true;
          const along = (candidate.x - points[0].x) * direction.x + (candidate.z - points[0].z) * direction.z;
          return along > protectedLength + EPSILON;
        });
        routedPoints = [points[0], protectedPoint, ...remaining];
      }
    }
    if (preserveEndDirection && points.length >= 2) {
      const end = points.at(-1);
      const beforeEnd = points.at(-2);
      const direction = normalize(end.x - beforeEnd.x, end.z - beforeEnd.z);
      if (direction && direction.length >= protectedLength) {
        const protectedPoint = {
          x: end.x - direction.x * protectedLength,
          z: end.z - direction.z * protectedLength,
        };
        const retained = routedPoints.slice(0, -1).filter((candidate, index) => {
          if (index === 0) return true;
          const distanceFromEnd = (end.x - candidate.x) * direction.x + (end.z - candidate.z) * direction.z;
          return distanceFromEnd > protectedLength + EPSILON;
        });
        routedPoints = [...retained, protectedPoint, end];
      }
    }
    for (let segmentIndex = 0; segmentIndex < routedPoints.length - 1; segmentIndex++) {
      const start = routedPoints[segmentIndex];
      const end = routedPoints[segmentIndex + 1];
      const midpoint = lerp(start, end, 0.5);
      const townResult = townResolver(midpoint, segmentIndex);
      const segment = addRoadSegment({
        kind,
        routeId,
        routeOrder: segmentIndex,
        town: townResult.town,
        townId: townResult.townId,
        start,
        end,
        width,
        sampleSpacing,
        curvature,
        roadPattern,
        roadSurfaceOverlap,
        parentRoadId: kind === ROAD_KINDS.MAJOR ? null : nextParentRoadId,
        isTownSpine,
        isCapitalCollector,
        isCivicAccess,
      });
      segments.push(segment);
      if (kind !== ROAD_KINDS.MAJOR) nextParentRoadId = segment.roadId;
    }
    return segments;
  };

  const addJunction = ({
    type,
    x,
    z,
    roadIds,
    parentRoadId,
    childRoadId,
    isHub = false,
    surfaceMode = null,
  }) => {
    const uniqueRoadIds = [...new Set(roadIds)];
    const attachedRoads = uniqueRoadIds.map(roadId => roadsById.get(roadId)).filter(Boolean);
    const width = attachedRoads.reduce((largest, road) => Math.max(largest, road.width), 0);
    const duplicate = junctions.find(junction => Math.hypot(junction.x - x, junction.z - z) <= EPSILON);
    if (duplicate) throw new RangeError(`duplicate junction position: ${duplicate.junctionId}`);
    const degree = type === 'T' ? 3 : attachedRoads.length;
    if (degree > (isHub ? 4 : 3)) throw new RangeError(`junction degree exceeds limit: ${degree}`);
    junctions.push(Object.freeze({
      junctionId: `junction-${String(junctionIndex++).padStart(3, '0')}`,
      type,
      x,
      z,
      width,
      degree,
      isHub,
      surfaceMode,
      parentRoadId,
      childRoadId,
      roadIds: Object.freeze(attachedRoads.map(road => road.roadId)),
    }));
  };

  for (let connectionIndex = 0; connectionIndex < majorConnections.length; connectionIndex++) {
    const connection = majorConnections[connectionIndex];
    const fromTown = townCenters[connection.fromIndex];
    const toTown = townCenters[connection.toIndex];
    const fromPoint = majorPortByEndpoint.get(`${connectionIndex}:from`);
    const toPoint = majorPortByEndpoint.get(`${connectionIndex}:to`);
    const legacyFromPoint = legacyMajorPortByEndpoint.get(`${connectionIndex}:from`);
    const legacyToPoint = legacyMajorPortByEndpoint.get(`${connectionIndex}:to`);
    const direction = normalize(
      legacyToPoint.x - legacyFromPoint.x,
      legacyToPoint.z - legacyFromPoint.z,
    );
    const bendSign = connectionIndex % 2 === 0 ? 1 : -1;
    const bend = Math.min(220, direction.length * 0.025) * bendSign;
    const normalX = -direction.z;
    const normalZ = direction.x;
    const chooseTownExit = (spineDirection, targetDirection) => {
      const first = { x: -spineDirection.z, z: spineDirection.x };
      const dot = first.x * targetDirection.x + first.z * targetDirection.z;
      return dot >= 0 ? first : { x: -first.x, z: -first.z };
    };
    const fromExit = fromPoint.isCapitalCivicPort
      ? { x: fromPoint.outwardX, z: fromPoint.outwardZ }
      : chooseTownExit(townSpineDirections[connection.fromIndex], direction);
    const toOutward = toPoint.isCapitalCivicPort
      ? { x: toPoint.outwardX, z: toPoint.outwardZ }
      : chooseTownExit(townSpineDirections[connection.toIndex], {
      x: -direction.x,
      z: -direction.z,
      });
    const approachLength = Math.max(ROAD_WIDTHS[ROAD_KINDS.MAJOR] * 2, Math.min(360, direction.length * 0.035));
    const fromApproach = {
      x: fromPoint.x + fromExit.x * approachLength,
      z: fromPoint.z + fromExit.z * approachLength,
    };
    const toApproach = {
      x: toPoint.x + toOutward.x * approachLength,
      z: toPoint.z + toOutward.z * approachLength,
    };
    const points = [
      fromPoint,
      fromApproach,
      {
        x: legacyFromPoint.x + direction.x * direction.length * 0.34 + normalX * bend * 0.65,
        z: legacyFromPoint.z + direction.z * direction.length * 0.34 + normalZ * bend * 0.65,
      },
      {
        x: legacyFromPoint.x + direction.x * direction.length * 0.67 + normalX * bend,
        z: legacyFromPoint.z + direction.z * direction.length * 0.67 + normalZ * bend,
      },
      toApproach,
      toPoint,
    ];
    const routeId = `major-${connection.fromTownId}-${connection.toTownId}`;
    const segments = addPolyline({
      kind: ROAD_KINDS.MAJOR,
      routeId,
      points,
      preserveStartDirection: true,
      preserveEndDirection: true,
      townResolver: midpoint => {
        const fromDistanceSq = (midpoint.x - fromTown.x) ** 2 + (midpoint.z - fromTown.z) ** 2;
        const toDistanceSq = (midpoint.x - toTown.x) ** 2 + (midpoint.z - toTown.z) ** 2;
        return fromDistanceSq <= toDistanceSq
          ? { town: fromTown, townId: connection.fromTownId }
          : { town: toTown, townId: connection.toTownId };
      },
    });
    incidentMajorRoads.get(connection.fromTownId).push(Object.freeze({
      roadId: segments[0].roadId,
      point: fromPoint,
      connectionIndex,
    }));
    incidentMajorRoads.get(connection.toTownId).push(Object.freeze({
      roadId: segments.at(-1).roadId,
      point: toPoint,
      connectionIndex,
    }));
  }

  const roadsAtPoint = (routeRoads, testPoint) => routeRoads.filter(road => (
    Math.hypot(road.start.x - testPoint.x, road.start.z - testPoint.z) <= EPSILON
    || Math.hypot(road.end.x - testPoint.x, road.end.z - testPoint.z) <= EPSILON
  ));

  const isSafeJunctionPoint = (testPoint, width) => (
    !isPointInWater(testPoint, waterZones, width * 2 + 18)
    && !isPointInExclusion(testPoint, width * 2 + 18)
  );

  const isInitialCorridorClear = (start, end, width) => {
    const direction = normalize(end.x - start.x, end.z - start.z);
    if (!direction) return false;
    const protectedLength = Math.min(direction.length, width * 2);
    const protectedSegment = {
      start,
      end: {
        x: start.x + direction.x * protectedLength,
        z: start.z + direction.z * protectedLength,
      },
    };
    return [...exclusionZones, ...waterZones].every(zone => {
      const candidate = closestPointOnSegment(zone, protectedSegment);
      return Math.sqrt(candidate.distanceSq) >= zone.radius + width / 2 + 18;
    });
  };

  const isFullCorridorClear = (start, end, width) => {
    const segment = { start, end };
    return [...exclusionZones, ...waterZones].every(zone => {
      const candidate = closestPointOnSegment(zone, segment);
      return Math.sqrt(candidate.distanceSq) >= zone.radius + width / 2 + 18;
    });
  };

  const isRoadEndClear = (testPoint, width, ignoredRoadIds = new Set()) => roads.every(road => {
    if (ignoredRoadIds.has(road.roadId)) return true;
    const candidate = closestPointOnSegment(testPoint, road);
    return Math.sqrt(candidate.distanceSq) >= (width + road.width) / 2 + 8;
  });

  const pointAlongSpine = (hub, direction, distance) => ({
    x: hub.x + direction.x * distance,
    z: hub.z + direction.z * distance,
  });

  for (let townIndex = 0; townIndex < townCenters.length; townIndex++) {
    const town = townCenters[townIndex];
    const townId = getTownId(town, townIndex);
    const townHub = townHubs[townIndex];
    const spineDirection = townSpineDirections[townIndex];
    const spineHalfLength = town.coreRadius * 0.42;
    const incidentRoads = incidentMajorRoads.get(townId);

    if (town.type === 'capital' && town.settlementType === SETTLEMENT_TYPES.CITY) {
      const parameters = getSettlementRoadParameters(SETTLEMENT_TYPES.CITY);
      const localWidth = parameters.localWidth;
      const alleyWidth = parameters.alleyWidth;
      const westPort = Object.freeze({ x: capitalTopology.westX, z: capitalTopology.collectorZ });
      const mainHubPoint = Object.freeze({ x: town.x, z: capitalTopology.collectorZ });
      const collectorCorner = Object.freeze({ x: capitalTopology.eastX, z: capitalTopology.collectorZ });
      const northPort = Object.freeze({ x: capitalTopology.eastX, z: capitalTopology.northZ });
      const incidentAt = testPoint => incidentRoads.find(incident => (
        Math.hypot(incident.point.x - testPoint.x, incident.point.z - testPoint.z) <= EPSILON
      ));
      const westIncident = incidentAt(westPort);
      const hubIncident = incidentAt(mainHubPoint);
      const northIncident = incidentAt(northPort);
      if (!westIncident || !hubIncident || !northIncident) {
        throw new RangeError('Capital Civic Core requires three resolved MAJOR ports');
      }

      const collectorSegments = addPolyline({
        kind: ROAD_KINDS.LOCAL,
        routeId: `local-${townId}-collector`,
        points: [westPort, mainHubPoint, collectorCorner, northPort],
        townResolver: () => ({ town, townId }),
        parentRoadId: hubIncident.roadId,
        width: localWidth,
        sampleSpacing: parameters.sampleSpacing,
        curvature: 0,
        roadPattern: parameters.roadPattern,
        roadSurfaceOverlap: parameters.roadSurfaceOverlap,
        isCapitalCollector: true,
      });

      const civicAccessEnd = Object.freeze({
        x: town.x,
        z: capitalCivicCore.centerZ - capitalCivicCore.halfDepth,
      });
      const civicAccessSegments = addPolyline({
        kind: ROAD_KINDS.LOCAL,
        routeId: `local-${townId}-civic-access`,
        points: [mainHubPoint, civicAccessEnd],
        townResolver: () => ({ town, townId }),
        parentRoadId: hubIncident.roadId,
        width: 32,
        sampleSpacing: 32,
        curvature: 0,
        roadPattern: parameters.roadPattern,
        roadSurfaceOverlap: 0,
        isCivicAccess: true,
      });
      capitalCivicCore = createCapitalCivicCore(town, civicAccessSegments[0].roadId);

      const spine0BranchPoints = [-620, -1000, -1380].map(z => Object.freeze({ x: westPort.x, z }));
      const spine1BranchPoints = [1050, 1450, 1850].map(x => Object.freeze({ x, z: collectorCorner.z }));
      const spine0Segments = addPolyline({
        kind: ROAD_KINDS.LOCAL,
        routeId: `local-${townId}-spine-0`,
        points: [westPort, ...spine0BranchPoints, Object.freeze({ x: westPort.x, z: -1740 })],
        townResolver: () => ({ town, townId }),
        parentRoadId: collectorSegments[0].roadId,
        isTownSpine: true,
        width: localWidth,
        sampleSpacing: parameters.sampleSpacing,
        curvature: parameters.localCurvature,
        roadPattern: parameters.roadPattern,
        roadSurfaceOverlap: parameters.roadSurfaceOverlap,
      });
      const spine1Segments = addPolyline({
        kind: ROAD_KINDS.LOCAL,
        routeId: `local-${townId}-spine-1`,
        points: [collectorCorner, ...spine1BranchPoints, Object.freeze({ x: 2200, z: collectorCorner.z })],
        townResolver: () => ({ town, townId }),
        parentRoadId: collectorSegments[1].roadId,
        isTownSpine: true,
        width: localWidth,
        sampleSpacing: parameters.sampleSpacing,
        curvature: parameters.localCurvature,
        roadPattern: parameters.roadPattern,
        roadSurfaceOverlap: parameters.roadSurfaceOverlap,
      });

      const generatedBranches = [];
      const branchSpecs = [
        ...spine0BranchPoints.map((attach, branchIndex) => ({ attach, branchIndex, parentSegments: spine0Segments })),
        ...spine1BranchPoints.map((attach, offset) => ({
          attach,
          branchIndex: spine0BranchPoints.length + offset,
          parentSegments: spine1Segments,
        })),
      ];
      const branchLength = town.coreRadius
        * (0.19 + parameters.densityMultiplier * 0.025)
        * parameters.roadLengthMultiplier;
      for (const spec of branchSpecs) {
        const parentRoads = roadsAtPoint(spec.parentSegments, spec.attach);
        if (parentRoads.length !== 2) throw new RangeError(`CITY branch is not inside LOCAL spine: ${townId}`);
        const parentRoad = parentRoads[0];
        const preferredSide = spec.branchIndex % 2 === 0 ? 1 : -1;
        const makeBranchPoints = side => {
          const end = Object.freeze({
            x: spec.attach.x + parentRoad.normalX * branchLength * side,
            z: spec.attach.z + parentRoad.normalZ * branchLength * side,
          });
          return {
            middle: Object.freeze(lerp(spec.attach, end, 0.5)),
            alleyAttach: Object.freeze(lerp(spec.attach, end, 0.76)),
            end,
          };
        };
        let selected = null;
        for (const side of [preferredSide, -preferredSide]) {
          const candidate = makeBranchPoints(side);
          if (segmentIntersectsCapitalCivicCore(spec.attach, candidate.end, localWidth, capitalCivicCore)) continue;
          if (!isFullCorridorClear(spec.attach, candidate.end, localWidth)) continue;
          if (!isInitialCorridorClear(spec.attach, candidate.middle, localWidth)) continue;
          if (!isRoadEndClear(candidate.end, localWidth, new Set(parentRoads.map(road => road.roadId)))) continue;
          selected = candidate;
          break;
        }
        if (!selected) {
          omitRoute(`local-${townId}-branch-${spec.branchIndex}`, ROAD_KINDS.LOCAL, 'CIVIC_CORE_OR_CLEARANCE');
          continue;
        }
        const branchSegments = addPolyline({
          kind: ROAD_KINDS.LOCAL,
          routeId: `local-${townId}-branch-${spec.branchIndex}`,
          points: [spec.attach, selected.middle, selected.alleyAttach, selected.end],
          preserveStartDirection: true,
          townResolver: () => ({ town, townId }),
          parentRoadId: parentRoads[0].roadId,
          width: localWidth,
          sampleSpacing: parameters.sampleSpacing,
          curvature: parameters.localCurvature,
          roadPattern: parameters.roadPattern,
          roadSurfaceOverlap: parameters.roadSurfaceOverlap,
        });
        addJunction({
          type: 'T',
          x: spec.attach.x,
          z: spec.attach.z,
          roadIds: [...parentRoads.map(road => road.roadId), branchSegments[0].roadId],
          parentRoadId: parentRoads[0].roadId,
          childRoadId: branchSegments[0].roadId,
        });
        generatedBranches.push({ ...spec, branchSegments, alleyAttach: selected.alleyAttach });
      }

      let generatedAlleyCount = 0;
      for (const branch of generatedBranches) {
        if (generatedAlleyCount >= parameters.alleyCount) break;
        const parentRoads = roadsAtPoint(branch.branchSegments, branch.alleyAttach);
        if (parentRoads.length !== 2) continue;
        const parentRoad = parentRoads[0];
        const alleyLength = Math.max(alleyWidth * 3, town.coreRadius * 0.13 * parameters.roadLengthMultiplier);
        const candidates = [1, -1].map(side => Object.freeze({
          x: branch.alleyAttach.x + parentRoad.normalX * alleyLength * side,
          z: branch.alleyAttach.z + parentRoad.normalZ * alleyLength * side,
        })).sort((first, second) => (
          Math.hypot(second.x - capitalCivicCore.centerX, second.z - capitalCivicCore.centerZ)
          - Math.hypot(first.x - capitalCivicCore.centerX, first.z - capitalCivicCore.centerZ)
        ));
        const ignoredRoadIds = new Set(parentRoads.map(road => road.roadId));
        const alleyEnd = candidates.find(candidate => (
          Math.hypot(candidate.x - capitalCivicCore.centerX, candidate.z - capitalCivicCore.centerZ)
            > Math.hypot(
              branch.alleyAttach.x - capitalCivicCore.centerX,
              branch.alleyAttach.z - capitalCivicCore.centerZ,
            )
          &&
          !segmentIntersectsCapitalCivicCore(branch.alleyAttach, candidate, alleyWidth, capitalCivicCore)
          && isFullCorridorClear(branch.alleyAttach, candidate, alleyWidth)
          && isSafeJunctionPoint(candidate, alleyWidth)
          && isInitialCorridorClear(branch.alleyAttach, candidate, alleyWidth)
          && isRoadEndClear(candidate, alleyWidth, ignoredRoadIds)
        ));
        if (!alleyEnd) continue;
        const alleyMiddle = Object.freeze(lerp(branch.alleyAttach, alleyEnd, 0.5));
        const alleySegments = addPolyline({
          kind: ROAD_KINDS.ALLEY,
          routeId: `alley-${townId}-${generatedAlleyCount}`,
          points: [branch.alleyAttach, alleyMiddle, alleyEnd],
          preserveStartDirection: true,
          townResolver: () => ({ town, townId }),
          parentRoadId: parentRoads[0].roadId,
          width: alleyWidth,
          sampleSpacing: parameters.sampleSpacing,
          curvature: parameters.alleyCurvature,
          roadPattern: parameters.roadPattern,
          roadSurfaceOverlap: parameters.roadSurfaceOverlap,
        });
        addJunction({
          type: 'T',
          x: branch.alleyAttach.x,
          z: branch.alleyAttach.z,
          roadIds: [...parentRoads.map(road => road.roadId), alleySegments[0].roadId],
          parentRoadId: parentRoads[0].roadId,
          childRoadId: alleySegments[0].roadId,
        });
        generatedAlleyCount++;
      }
      for (let alleyIndex = generatedAlleyCount; alleyIndex < parameters.alleyCount; alleyIndex++) {
        omitRoute(`alley-${townId}-${alleyIndex}`, ROAD_KINDS.ALLEY, 'END_OR_CORRIDOR_BLOCKED');
      }

      const collectorAtWest = roadsAtPoint(collectorSegments, westPort);
      const collectorAtHub = roadsAtPoint(collectorSegments, mainHubPoint);
      const collectorAtCorner = roadsAtPoint(collectorSegments, collectorCorner);
      const collectorAtNorth = roadsAtPoint(collectorSegments, northPort);
      const spineAtWest = roadsAtPoint(spine0Segments, westPort);
      const spineAtCorner = roadsAtPoint(spine1Segments, collectorCorner);
      if (collectorAtHub.length !== 2 || collectorAtCorner.length !== 2) {
        throw new RangeError('Capital collector junction split is incomplete');
      }
      addJunction({
        type: 'T',
        x: westPort.x,
        z: westPort.z,
        roadIds: [westIncident.roadId, collectorAtWest[0].roadId, spineAtWest[0].roadId],
        parentRoadId: collectorAtWest[0].roadId,
        childRoadId: spineAtWest[0].roadId,
      });
      const mainHubRoadIds = [
        ...collectorAtHub.map(road => road.roadId),
        hubIncident.roadId,
        civicAccessSegments[0].roadId,
      ];
      addJunction({
        type: 'HUB',
        x: mainHubPoint.x,
        z: mainHubPoint.z,
        roadIds: mainHubRoadIds,
        parentRoadId: collectorAtHub[0].roadId,
        childRoadId: civicAccessSegments[0].roadId,
        isHub: true,
        surfaceMode: 'ATTACHED_ROAD_UNION',
      });
      addJunction({
        type: 'T',
        x: collectorCorner.x,
        z: collectorCorner.z,
        roadIds: [...collectorAtCorner.map(road => road.roadId), spineAtCorner[0].roadId],
        parentRoadId: collectorAtCorner[0].roadId,
        childRoadId: spineAtCorner[0].roadId,
      });
      addJunction({
        type: 'CONNECTOR',
        x: northPort.x,
        z: northPort.z,
        roadIds: [northIncident.roadId, collectorAtNorth[0].roadId],
        parentRoadId: northIncident.roadId,
        childRoadId: collectorAtNorth[0].roadId,
      });

      const mainHub = junctions.at(-3);
      capitalTopology = Object.freeze({
        collectorShape: 'L',
        collectorStraightLegCount: 2,
        collectorRouteId: `local-${townId}-collector`,
        collectorSegmentIds: Object.freeze(collectorSegments.map(road => road.roadId)),
        ports: Object.freeze(capitalTopology.ports.map(port => {
          const incident = incidentAt(port);
          return Object.freeze({ ...port, roadId: incident.roadId });
        })),
        mainHubId: mainHub.junctionId,
        mainHubX: mainHub.x,
        mainHubZ: mainHub.z,
        spineRouteIds: Object.freeze([
          `local-${townId}-spine-0`,
          `local-${townId}-spine-1`,
        ]),
        branchTarget: parameters.localBranchCount,
        branchGenerated: generatedBranches.length,
        alleyTarget: parameters.alleyCount,
        alleyGenerated: generatedAlleyCount,
        civicAccessRouteId: `local-${townId}-civic-access`,
        civicAccessRoadId: civicAccessSegments[0].roadId,
      });
      continue;
    }

    if ((town.type === 'church_town' || town.type === 'school_town')
        && town.settlementType === SETTLEMENT_TYPES.TOWN) {
      const parameters = getSettlementRoadParameters(SETTLEMENT_TYPES.TOWN);
      const localWidth = parameters.localWidth;
      const alleyWidth = parameters.alleyWidth;
      if (parameters.localSpineCount !== 1) throw new RangeError('TOWN requires exactly one LOCAL spine');
      const branchAngle = (parameters.preferredBranchAngleMin + parameters.preferredBranchAngleMax) / 2;
      if (branchAngle < parameters.hardBranchAngleMin || branchAngle > parameters.hardBranchAngleMax) {
        throw new RangeError('TOWN branch angle exceeds the hard angle range');
      }
      const branchAngleRadians = branchAngle * Math.PI / 180;
      const angleOffset = (town.type === 'church_town' ? 8 : -8) * Math.PI / 180;
      const nearestIncident = [...incidentRoads].sort((first, second) => {
        const firstDistance = Math.hypot(first.point.x - townHub.x, first.point.z - townHub.z);
        const secondDistance = Math.hypot(second.point.x - townHub.x, second.point.z - townHub.z);
        return firstDistance - secondDistance || first.roadId.localeCompare(second.roadId);
      })[0];
      const nearestDirection = nearestIncident
        ? normalize(nearestIncident.point.x - townHub.x, nearestIncident.point.z - townHub.z)
        : null;
      const fallbackDirection = spineDirection;
      const baseDirection = nearestDirection ?? fallbackDirection;
      const semiGridDirection = Object.freeze({
        x: baseDirection.x * Math.cos(angleOffset) + baseDirection.z * Math.sin(angleOffset),
        z: -baseDirection.x * Math.sin(angleOffset) + baseDirection.z * Math.cos(angleOffset),
      });
      const semiGridNormal = Object.freeze({ x: -semiGridDirection.z, z: semiGridDirection.x });
      const townOrigin = Object.freeze({
        x: townHub.x + semiGridNormal.x * town.coreRadius * (1 - parameters.centerConnectionBias) * 0.035,
        z: townHub.z + semiGridNormal.z * town.coreRadius * (1 - parameters.centerConnectionBias) * 0.035,
      });
      const townSpineHalfLength = town.coreRadius * 0.42
        * parameters.roadLengthMultiplier
        * (0.82 + parameters.outerRoadBias * 0.18);
      const minimumJunctionGap = localWidth * 1.5 * parameters.junctionSpacingMultiplier;
      const arcSign = town.type === 'church_town' ? 1 : -1;
      const pointOnTownSpine = distance => {
        const ratio = Math.max(-1, Math.min(1, distance / townSpineHalfLength));
        const arcOffset = Math.cos(ratio * Math.PI / 2)
          * town.coreRadius * parameters.localCurvature
          * (0.22 - parameters.gridBias * 0.07) * arcSign;
        return {
          x: townOrigin.x + semiGridDirection.x * distance + semiGridNormal.x * arcOffset,
          z: townOrigin.z + semiGridDirection.z * distance + semiGridNormal.z * arcOffset,
        };
      };
      const orderedIncidents = [...incidentRoads].sort((first, second) => {
        const firstDistance = (first.point.x - townOrigin.x) * semiGridDirection.x
          + (first.point.z - townOrigin.z) * semiGridDirection.z;
        const secondDistance = (second.point.x - townOrigin.x) * semiGridDirection.x
          + (second.point.z - townOrigin.z) * semiGridDirection.z;
        return firstDistance - secondDistance || first.roadId.localeCompare(second.roadId);
      });
      const reservedJunctions = orderedIncidents.map((incident, incidentIndex) => {
        const projectedDistance = (incident.point.x - townOrigin.x) * semiGridDirection.x
          + (incident.point.z - townOrigin.z) * semiGridDirection.z;
        const outwardSign = incidentIndex < orderedIncidents.length / 2 ? -1 : 1;
        const distance = Math.max(
          -townSpineHalfLength + localWidth * 2,
          Math.min(
            townSpineHalfLength - localWidth * 2,
            projectedDistance + outwardSign * localWidth * 2,
          ),
        );
        return {
          distance,
          width: localWidth,
          type: 'MAJOR_CONNECTOR',
          point: pointOnTownSpine(distance),
          incident,
          connectorIndex: incidentIndex,
        };
      });
      const desiredBranchFractions = [-0.76, -0.39, 0, 0.39, 0.76];
      const branchSpecs = [];
      const stableVariation = key => {
        const hash = [...key].reduce((total, character) => (
          (total * 31 + character.charCodeAt(0)) % 997
        ), 0);
        return (hash / 996 - 0.5) * 2;
      };

      for (let branchIndex = 0; branchIndex < parameters.localBranchCount; branchIndex++) {
        const parentRoadId = nearestIncident?.roadId ?? 'no-major';
        const variation = stableVariation(`${town.type}:${branchIndex}:${parentRoadId}`);
        const desiredDistance = townSpineHalfLength
          * (desiredBranchFractions[branchIndex] + variation * 0.018);
        const candidateOffsets = [
          0,
          minimumJunctionGap,
          -minimumJunctionGap,
          minimumJunctionGap * 2,
          -minimumJunctionGap * 2,
        ];
        let selected = null;
        for (const candidateOffset of candidateOffsets) {
          const distance = desiredDistance + candidateOffset;
          if (Math.abs(distance) > townSpineHalfLength - localWidth * 2) continue;
          if ([...reservedJunctions, ...branchSpecs].some(existing => (
            Math.abs(existing.distance - distance) < Math.max(existing.width ?? localWidth, localWidth)
              * 1.5 * parameters.junctionSpacingMultiplier
          ))) continue;
          const attach = pointOnTownSpine(distance);
          if (!isSafeJunctionPoint(attach, localWidth)) continue;
          selected = { branchIndex, distance, attach, variation };
          break;
        }
        if (selected) branchSpecs.push(selected);
        else omitRoute(`local-${townId}-branch-${branchIndex}`, ROAD_KINDS.LOCAL, 'JUNCTION_CLEARANCE');
      }

      const spineJunctionPoints = [
        ...reservedJunctions.map(spec => ({ ...spec, junctionKind: 'MAJOR' })),
        ...branchSpecs.map(spec => ({ ...spec, junctionKind: 'BRANCH', point: spec.attach })),
      ].sort((first, second) => first.distance - second.distance);
      const spineSegments = addPolyline({
        kind: ROAD_KINDS.LOCAL,
        routeId: `local-${townId}-spine-0`,
        points: [
          pointOnTownSpine(-townSpineHalfLength),
          ...spineJunctionPoints.map(spec => spec.point),
          pointOnTownSpine(townSpineHalfLength),
        ],
        townResolver: () => ({ town, townId }),
        parentRoadId: nearestIncident?.roadId ?? null,
        isTownSpine: true,
        width: localWidth,
        sampleSpacing: parameters.sampleSpacing,
        curvature: parameters.localCurvature,
        roadPattern: parameters.roadPattern,
        roadSurfaceOverlap: parameters.roadSurfaceOverlap,
      });

      for (const connector of reservedJunctions) {
        const spineRoads = roadsAtPoint(spineSegments, connector.point);
        if (spineRoads.length !== 2) throw new RangeError(`MAJOR connector is not inside TOWN LOCAL spine: ${townId}`);
        const connectorSegments = addPolyline({
          kind: ROAD_KINDS.LOCAL,
          routeId: `local-${townId}-major-connector-${connector.connectorIndex}`,
          points: [connector.incident.point, connector.point],
          townResolver: () => ({ town, townId }),
          parentRoadId: connector.incident.roadId,
          width: localWidth,
          sampleSpacing: parameters.sampleSpacing,
          curvature: parameters.localCurvature,
          roadPattern: parameters.roadPattern,
          roadSurfaceOverlap: parameters.roadSurfaceOverlap,
        });
        addJunction({
          type: 'CONNECTOR',
          x: connector.incident.point.x,
          z: connector.incident.point.z,
          roadIds: [connector.incident.roadId, connectorSegments[0].roadId],
          parentRoadId: connector.incident.roadId,
          childRoadId: connectorSegments[0].roadId,
        });
        addJunction({
          type: 'T',
          x: connector.point.x,
          z: connector.point.z,
          roadIds: [...spineRoads.map(road => road.roadId), connectorSegments.at(-1).roadId],
          parentRoadId: spineRoads[0].roadId,
          childRoadId: connectorSegments.at(-1).roadId,
        });
      }

      const generatedBranches = [];
      for (const spec of branchSpecs) {
        const parentRoads = roadsAtPoint(spineSegments, spec.attach);
        if (parentRoads.length !== 2) throw new RangeError(`TOWN branch is not inside LOCAL spine: ${townId}`);
        const parentRoad = parentRoads.find(road => (
          Math.hypot(road.end.x - spec.attach.x, road.end.z - spec.attach.z) <= EPSILON
        )) ?? parentRoads[0];
        let side = (spec.branchIndex + (town.type === 'church_town' ? 0 : 1)) % 2 === 0 ? 1 : -1;
        const branchLength = town.coreRadius
          * (0.185 + parameters.densityMultiplier * 0.025
            + parameters.deadEndBias * 0.015 + spec.variation * 0.008)
          * parameters.roadLengthMultiplier;
        const makeBranchPoints = directionSign => {
          const branchDirection = {
            x: parentRoad.tangentX * Math.cos(branchAngleRadians)
              + parentRoad.normalX * Math.sin(branchAngleRadians) * directionSign,
            z: parentRoad.tangentZ * Math.cos(branchAngleRadians)
              + parentRoad.normalZ * Math.sin(branchAngleRadians) * directionSign,
          };
          const initial = {
            x: spec.attach.x + branchDirection.x * localWidth * 2,
            z: spec.attach.z + branchDirection.z * localWidth * 2,
          };
          const end = {
            x: spec.attach.x + branchDirection.x * branchLength,
            z: spec.attach.z + branchDirection.z * branchLength,
          };
          const curveSign = (spec.branchIndex + townIndex) % 2 === 0 ? 1 : -1;
          const middle = {
            x: spec.attach.x + (end.x - spec.attach.x) * 0.58
              + parentRoad.tangentX * branchLength * parameters.localCurvature * 0.5 * curveSign,
            z: spec.attach.z + (end.z - spec.attach.z) * 0.58
              + parentRoad.tangentZ * branchLength * parameters.localCurvature * 0.5 * curveSign,
          };
          const alleyAttach = lerp(middle, end, 0.58);
          return { initial, middle, alleyAttach, end };
        };
        let branchPoints = makeBranchPoints(side);
        const ignoredRoadIds = new Set(parentRoads.map(road => road.roadId));
        const isBranchSafe = candidate => (
          isInitialCorridorClear(spec.attach, candidate.initial, localWidth)
          && isSafeJunctionPoint(candidate.end, localWidth)
          && isRoadEndClear(candidate.end, localWidth, ignoredRoadIds)
        );
        if (!isBranchSafe(branchPoints)) {
          side *= -1;
          branchPoints = makeBranchPoints(side);
        }
        if (!isInitialCorridorClear(spec.attach, branchPoints.initial, localWidth)) {
          omitRoute(`local-${townId}-branch-${spec.branchIndex}`, ROAD_KINDS.LOCAL, 'INITIAL_CORRIDOR_BLOCKED');
          continue;
        }
        if (!isSafeJunctionPoint(branchPoints.end, localWidth)) {
          omitRoute(`local-${townId}-branch-${spec.branchIndex}`, ROAD_KINDS.LOCAL, 'END_IN_EXCLUSION');
          continue;
        }
        if (!isRoadEndClear(branchPoints.end, localWidth, ignoredRoadIds)) {
          omitRoute(`local-${townId}-branch-${spec.branchIndex}`, ROAD_KINDS.LOCAL, 'END_NEAR_OTHER_ROAD');
          continue;
        }
        const branchSegments = addPolyline({
          kind: ROAD_KINDS.LOCAL,
          routeId: `local-${townId}-branch-${spec.branchIndex}`,
          points: [spec.attach, branchPoints.initial, branchPoints.middle, branchPoints.alleyAttach, branchPoints.end],
          preserveStartDirection: true,
          townResolver: () => ({ town, townId }),
          parentRoadId: parentRoads[0].roadId,
          width: localWidth,
          sampleSpacing: parameters.sampleSpacing,
          curvature: parameters.localCurvature,
          roadPattern: parameters.roadPattern,
          roadSurfaceOverlap: parameters.roadSurfaceOverlap,
        });
        addJunction({
          type: 'T',
          x: spec.attach.x,
          z: spec.attach.z,
          roadIds: [...parentRoads.map(road => road.roadId), branchSegments[0].roadId],
          parentRoadId: parentRoads[0].roadId,
          childRoadId: branchSegments[0].roadId,
        });
        generatedBranches.push({ spec, branchSegments, alleyAttach: branchPoints.alleyAttach });
      }

      let generatedAlleyCount = 0;
      for (const branch of generatedBranches) {
        if (generatedAlleyCount >= parameters.alleyCount) break;
        const parentRoads = roadsAtPoint(branch.branchSegments, branch.alleyAttach);
        if (parentRoads.length !== 2) continue;
        const parentRoad = parentRoads[1];
        const alleyLength = Math.max(alleyWidth * 3, town.coreRadius * 0.13 * parameters.roadLengthMultiplier);
        const makeAlleyPoints = directionSign => {
          const end = {
            x: branch.alleyAttach.x + parentRoad.normalX * alleyLength * directionSign,
            z: branch.alleyAttach.z + parentRoad.normalZ * alleyLength * directionSign,
          };
          const curveSign = (branch.spec.branchIndex + townIndex) % 2 === 0 ? 1 : -1;
          const middle = {
            x: branch.alleyAttach.x + (end.x - branch.alleyAttach.x) * 0.5
              + parentRoad.tangentX * alleyLength * parameters.alleyCurvature * 0.5 * curveSign,
            z: branch.alleyAttach.z + (end.z - branch.alleyAttach.z) * 0.5
              + parentRoad.tangentZ * alleyLength * parameters.alleyCurvature * 0.5 * curveSign,
          };
          return { middle, end };
        };
        let directionSign = (branch.spec.branchIndex + townIndex) % 2 === 0 ? 1 : -1;
        let alleyPoints = makeAlleyPoints(directionSign);
        const ignoredRoadIds = new Set(parentRoads.map(road => road.roadId));
        const isAlleySafe = candidate => (
          isSafeJunctionPoint(candidate.end, alleyWidth)
          && isInitialCorridorClear(branch.alleyAttach, candidate.end, alleyWidth)
          && isRoadEndClear(candidate.end, alleyWidth, ignoredRoadIds)
        );
        if (!isAlleySafe(alleyPoints)) {
          directionSign *= -1;
          alleyPoints = makeAlleyPoints(directionSign);
        }
        if (!isAlleySafe(alleyPoints)) continue;
        const alleySegments = addPolyline({
          kind: ROAD_KINDS.ALLEY,
          routeId: `alley-${townId}-${generatedAlleyCount}`,
          points: [branch.alleyAttach, alleyPoints.middle, alleyPoints.end],
          preserveStartDirection: true,
          townResolver: () => ({ town, townId }),
          parentRoadId: parentRoads[0].roadId,
          width: alleyWidth,
          sampleSpacing: parameters.sampleSpacing,
          curvature: parameters.alleyCurvature,
          roadPattern: parameters.roadPattern,
          roadSurfaceOverlap: parameters.roadSurfaceOverlap,
        });
        addJunction({
          type: 'T',
          x: branch.alleyAttach.x,
          z: branch.alleyAttach.z,
          roadIds: [...parentRoads.map(road => road.roadId), alleySegments[0].roadId],
          parentRoadId: parentRoads[0].roadId,
          childRoadId: alleySegments[0].roadId,
        });
        generatedAlleyCount++;
      }
      for (let alleyIndex = generatedAlleyCount; alleyIndex < parameters.alleyCount; alleyIndex++) {
        omitRoute(`alley-${townId}-${alleyIndex}`, ROAD_KINDS.ALLEY, 'END_OR_CORRIDOR_BLOCKED');
      }
      continue;
    }

    const reservedJunctions = incidentRoads.map(incident => ({
      distance: incident.point.distance,
      width: ROAD_WIDTHS[ROAD_KINDS.MAJOR],
      type: 'MAJOR',
      incident,
    }));

    const branchOffsets = [-0.72, -0.25, 0.25, 0.72];
    const branchSpecs = [];
    for (let branchIndex = 0; branchIndex < branchOffsets.length; branchIndex++) {
      const desiredDistance = spineHalfLength * branchOffsets[branchIndex];
      const minimumGap = ROAD_WIDTHS[ROAD_KINDS.LOCAL] * 1.5;
      const candidateOffsets = [0, minimumGap, -minimumGap, minimumGap * 2, -minimumGap * 2];
      let selected = null;
      for (const candidateOffset of candidateOffsets) {
        const distance = desiredDistance + candidateOffset;
        if (Math.abs(distance) > spineHalfLength - ROAD_WIDTHS[ROAD_KINDS.LOCAL] * 2) continue;
        const hasGap = reservedJunctions.every(existing => (
          Math.abs(existing.distance - distance) >= Math.max(existing.width, ROAD_WIDTHS[ROAD_KINDS.LOCAL]) * 1.5
        ));
        if (!hasGap) continue;
        const attach = pointAlongSpine(townHub, spineDirection, distance);
        if (!isSafeJunctionPoint(attach, ROAD_WIDTHS[ROAD_KINDS.LOCAL])) continue;
        selected = { branchIndex, distance, attach };
        break;
      }
      if (!selected) {
        omitRoute(`local-${townId}-branch-${branchIndex}`, ROAD_KINDS.LOCAL, 'JUNCTION_CLEARANCE');
        if (branchIndex === 0 || branchIndex === 2) {
          omitRoute(
            `alley-${townId}-${branchIndex === 0 ? 0 : 1}`,
            ROAD_KINDS.ALLEY,
            'PARENT_ROUTE_OMITTED',
          );
        }
        continue;
      }
      branchSpecs.push(selected);
      reservedJunctions.push({
        distance: selected.distance,
        width: ROAD_WIDTHS[ROAD_KINDS.LOCAL],
        type: 'LOCAL',
      });
    }

    const spineJunctionPoints = reservedJunctions
      .map(spec => pointAlongSpine(townHub, spineDirection, spec.distance))
      .sort((a, b) => (
        (a.x - townHub.x) * spineDirection.x + (a.z - townHub.z) * spineDirection.z
        - ((b.x - townHub.x) * spineDirection.x + (b.z - townHub.z) * spineDirection.z)
      ));
    const spinePoints = [
      pointAlongSpine(townHub, spineDirection, -spineHalfLength),
      ...spineJunctionPoints,
      pointAlongSpine(townHub, spineDirection, spineHalfLength),
    ];
    const spineSegments = addPolyline({
      kind: ROAD_KINDS.LOCAL,
      routeId: `local-${townId}-spine`,
      points: spinePoints,
      townResolver: () => ({ town, townId }),
      parentRoadId: incidentRoads[0]?.roadId ?? null,
      isTownSpine: true,
    });

    for (const incident of incidentRoads) {
      const spineRoads = roadsAtPoint(spineSegments, incident.point);
      if (spineRoads.length !== 2) throw new RangeError(`MAJOR port is not inside LOCAL spine: ${townId}`);
      addJunction({
        type: 'T',
        x: incident.point.x,
        z: incident.point.z,
        roadIds: [incident.roadId, ...spineRoads.map(road => road.roadId)],
        parentRoadId: incident.roadId,
        childRoadId: spineRoads[0].roadId,
      });
    }

    for (const spec of branchSpecs) {
      const { branchIndex, attach } = spec;
      const spineRoads = roadsAtPoint(spineSegments, attach);
      if (spineRoads.length !== 2) throw new RangeError(`LOCAL branch is not inside LOCAL spine: ${townId}`);
      const parentSpine = spineRoads.find(road => (
        Math.hypot(road.end.x - attach.x, road.end.z - attach.z) <= EPSILON
      )) ?? spineRoads[0];
      const alleyIndex = branchIndex === 0 ? 0 : branchIndex === 2 ? 1 : null;
      let side = branchIndex % 2 === 0 ? 1 : -1;
      const branchLength = town.coreRadius * (0.24 + (branchIndex % 2) * 0.035);
      const createBranchPoints = directionSign => {
        const end = {
          x: attach.x + parentSpine.normalX * branchLength * directionSign,
          z: attach.z + parentSpine.normalZ * branchLength * directionSign,
        };
        const middle = {
          x: attach.x + (end.x - attach.x) * 0.52 + parentSpine.tangentX * branchLength * 0.035,
          z: attach.z + (end.z - attach.z) * 0.52 + parentSpine.tangentZ * branchLength * 0.035,
        };
        return { end, middle };
      };
      let { end, middle } = createBranchPoints(side);
      if (!isInitialCorridorClear(attach, middle, ROAD_WIDTHS[ROAD_KINDS.LOCAL])) {
        side *= -1;
        ({ end, middle } = createBranchPoints(side));
      }
      if (!isInitialCorridorClear(attach, middle, ROAD_WIDTHS[ROAD_KINDS.LOCAL])) {
        omitRoute(`local-${townId}-branch-${branchIndex}`, ROAD_KINDS.LOCAL, 'INITIAL_CORRIDOR_BLOCKED');
        if (alleyIndex !== null) {
          omitRoute(`alley-${townId}-${alleyIndex}`, ROAD_KINDS.ALLEY, 'PARENT_ROUTE_OMITTED');
        }
        continue;
      }
      if (!isRoadEndClear(end, ROAD_WIDTHS[ROAD_KINDS.LOCAL], new Set(spineRoads.map(road => road.roadId)))) {
        omitRoute(`local-${townId}-branch-${branchIndex}`, ROAD_KINDS.LOCAL, 'END_NEAR_OTHER_ROAD');
        if (alleyIndex !== null) {
          omitRoute(`alley-${townId}-${alleyIndex}`, ROAD_KINDS.ALLEY, 'PARENT_ROUTE_OMITTED');
        }
        continue;
      }
      const alleyAttach = alleyIndex === null ? null : lerp(middle, end, 0.55);
      const canAttachAlley = alleyAttach
        && isSafeJunctionPoint(alleyAttach, ROAD_WIDTHS[ROAD_KINDS.LOCAL]);
      const branchPoints = canAttachAlley ? [attach, middle, alleyAttach, end] : [attach, middle, end];
      const branchSegments = addPolyline({
        kind: ROAD_KINDS.LOCAL,
        routeId: `local-${townId}-branch-${branchIndex}`,
        points: branchPoints,
        preserveStartDirection: true,
        townResolver: () => ({ town, townId }),
        parentRoadId: spineRoads[0].roadId,
      });
      addJunction({
        type: 'T',
        x: attach.x,
        z: attach.z,
        roadIds: [...spineRoads.map(road => road.roadId), branchSegments[0].roadId],
        parentRoadId: spineRoads[0].roadId,
        childRoadId: branchSegments[0].roadId,
      });

      if (!canAttachAlley) {
        if (alleyIndex !== null) {
          omitRoute(`alley-${townId}-${alleyIndex}`, ROAD_KINDS.ALLEY, 'JUNCTION_CLEARANCE');
        }
        continue;
      }
      const parentLocalRoads = roadsAtPoint(branchSegments, alleyAttach);
      if (parentLocalRoads.length !== 2) {
        omitRoute(`alley-${townId}-${alleyIndex}`, ROAD_KINDS.ALLEY, 'PARENT_SEGMENT_UNAVAILABLE');
        continue;
      }
      const parentLocal = parentLocalRoads[1];
      const alleyLength = Math.min(420, town.coreRadius * 0.18);
      let alleyDirectionSign = alleyIndex === 0 ? 1 : -1;
      let alleyEnd = {
        x: alleyAttach.x + parentLocal.normalX * alleyLength * alleyDirectionSign,
        z: alleyAttach.z + parentLocal.normalZ * alleyLength * alleyDirectionSign,
      };
      if (!isSafeJunctionPoint(alleyEnd, ROAD_WIDTHS[ROAD_KINDS.ALLEY])) {
        alleyDirectionSign *= -1;
        alleyEnd = {
          x: alleyAttach.x + parentLocal.normalX * alleyLength * alleyDirectionSign,
          z: alleyAttach.z + parentLocal.normalZ * alleyLength * alleyDirectionSign,
        };
      }
      if (!isSafeJunctionPoint(alleyEnd, ROAD_WIDTHS[ROAD_KINDS.ALLEY])
          || !isInitialCorridorClear(alleyAttach, alleyEnd, ROAD_WIDTHS[ROAD_KINDS.ALLEY])
          || !isRoadEndClear(
            alleyEnd,
            ROAD_WIDTHS[ROAD_KINDS.ALLEY],
            new Set(parentLocalRoads.map(road => road.roadId)),
          )) {
        omitRoute(`alley-${townId}-${alleyIndex}`, ROAD_KINDS.ALLEY, 'END_OR_CORRIDOR_BLOCKED');
        continue;
      }
      const alleySegments = addPolyline({
        kind: ROAD_KINDS.ALLEY,
        routeId: `alley-${townId}-${alleyIndex}`,
        points: [alleyAttach, alleyEnd],
        preserveStartDirection: true,
        townResolver: () => ({ town, townId }),
        parentRoadId: parentLocalRoads[0].roadId,
      });
      addJunction({
        type: 'T',
        x: alleyAttach.x,
        z: alleyAttach.z,
        roadIds: [...parentLocalRoads.map(road => road.roadId), alleySegments[0].roadId],
        parentRoadId: parentLocalRoads[0].roadId,
        childRoadId: alleySegments[0].roadId,
      });
    }
  }

  const ponds = waterZones.filter(zone => zone.isPond);
  for (let pondIndex = 0; pondIndex < ponds.length; pondIndex++) {
    const pond = ponds[pondIndex];
    let nearest = null;
    for (const road of roads) {
      if (road.kind === ROAD_KINDS.ALLEY || road.kind === ROAD_KINDS.START_APPROACH) continue;
      const closest = closestPointOnSegment(pond, road);
      const segmentLength = Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z);
      const clearanceStep = Math.max(road.width, ROAD_WIDTHS[ROAD_KINDS.START_APPROACH]) * 1.5 / segmentLength;
      const candidateTs = [
        closest.t,
        closest.t + clearanceStep,
        closest.t - clearanceStep,
        closest.t + clearanceStep * 2,
        closest.t - clearanceStep * 2,
      ];
      for (const rawT of candidateTs) {
        const t = Math.max(0.08, Math.min(0.92, rawT));
        const candidatePoint = lerp(road.start, road.end, t);
        const junctionClearance = Math.max(road.width, ROAD_WIDTHS[ROAD_KINDS.START_APPROACH]) * 2 + 18;
        if (isPointInWater(candidatePoint, waterZones, junctionClearance)) continue;
        if (isPointInExclusion(candidatePoint, junctionClearance)) continue;
        const hasJunctionGap = junctions.every(junction => (
          Math.hypot(candidatePoint.x - junction.x, candidatePoint.z - junction.z)
          >= Math.max(road.width, junction.width) * 1.5
        ));
        if (!hasJunctionGap) continue;
        const distanceSq = (pond.x - candidatePoint.x) ** 2 + (pond.z - candidatePoint.z) ** 2;
        if (!nearest || distanceSq < nearest.distanceSq) {
          nearest = { point: candidatePoint, distanceSq, road };
        }
      }
    }
    if (!nearest) throw new Error(`no road available for start pond ${pondIndex}`);
    const direction = normalize(nearest.point.x - pond.x, nearest.point.z - pond.z);
    const startClearance = pond.radius + ROAD_WIDTHS[ROAD_KINDS.START_APPROACH] / 2 + 10;
    const start = {
      x: pond.x + direction.x * startClearance,
      z: pond.z + direction.z * startClearance,
    };
    const approach = addPolyline({
      kind: ROAD_KINDS.START_APPROACH,
      routeId: `start-approach-${pondIndex}`,
      points: [start, nearest.point],
      preserveStartDirection: true,
      preserveEndDirection: true,
      townResolver: () => ({ town: nearest.road.town, townId: nearest.road.townId }),
      parentRoadId: nearest.road.roadId,
    })[0];
    addJunction({
      type: 'T',
      x: nearest.point.x,
      z: nearest.point.z,
      roadIds: [nearest.road.roadId, approach.roadId],
      parentRoadId: nearest.road.roadId,
      childRoadId: approach.roadId,
    });
  }

  const allPathSamples = [];
  let sequence = 0;
  for (const road of roads) {
    const segmentLength = Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z);
    const sampleSpacing = road.sampleSpacing ?? ROAD_SAMPLE_SPACING[road.kind];
    const sampleCount = Math.max(1, Math.ceil(segmentLength / sampleSpacing));
    const sampleLength = segmentLength / sampleCount;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      const sampleStart = lerp(road.start, road.end, sampleIndex / sampleCount);
      const sampleEnd = lerp(road.start, road.end, (sampleIndex + 1) / sampleCount);
      const midpoint = lerp(sampleStart, sampleEnd, 0.5);
      const isWater = isPointInWater(midpoint, waterZones, road.width / 2);
      const isBlocked = isPointInExclusion(midpoint, road.width / 2 + 8);
      allPathSamples.push(Object.freeze({
        x: midpoint.x,
        z: midpoint.z,
        tc: road.town,
        roadId: road.roadId,
        routeId: road.routeId,
        kind: road.kind,
        width: road.width,
        tangentX: road.tangentX,
        tangentZ: road.tangentZ,
        normalX: road.normalX,
        normalZ: road.normalZ,
        length: sampleLength,
        routeOrder: road.routeOrder,
        sampleIndex,
        sequence: sequence++,
        isWater,
        isBlocked,
      }));
    }
  }

  const bridgeSpans = [];
  const samplesByRoute = new Map();
  for (const sample of allPathSamples) {
    if (!samplesByRoute.has(sample.routeId)) samplesByRoute.set(sample.routeId, []);
    samplesByRoute.get(sample.routeId).push(sample);
  }
  for (const [routeId, routeSamples] of samplesByRoute) {
    routeSamples.sort((a, b) => a.sequence - b.sequence);
    let waterRunStart = -1;
    for (let sampleIndex = 0; sampleIndex < routeSamples.length; sampleIndex++) {
      const sample = routeSamples[sampleIndex];
      if (sample.isWater && waterRunStart === -1) waterRunStart = sampleIndex;
      const exitsWater = !sample.isWater && waterRunStart !== -1;
      if (!exitsWater) continue;
      const previousLand = routeSamples[waterRunStart - 1];
      if (previousLand) {
        const direction = normalize(sample.x - previousLand.x, sample.z - previousLand.z);
        if (direction) {
          bridgeSpans.push(Object.freeze({
            bridgeId: `bridge-${String(bridgeSpans.length).padStart(3, '0')}`,
            routeId,
            kind: sample.kind,
            start: Object.freeze({ x: previousLand.x, z: previousLand.z }),
            end: Object.freeze({ x: sample.x, z: sample.z }),
            width: Math.max(110, previousLand.width, sample.width),
            tangentX: direction.x,
            tangentZ: direction.z,
          }));
        }
      }
      waterRunStart = -1;
    }
  }

  const hasRoadConnectionAtPoint = (road, testPoint) => roads.some(other => (
    other.roadId !== road.roadId
    && (
      Math.hypot(other.start.x - testPoint.x, other.start.z - testPoint.z) <= EPSILON
      || Math.hypot(other.end.x - testPoint.x, other.end.z - testPoint.z) <= EPSILON
    )
  ));

  const specialJunctionAtPoint = (road, testPoint) => junctions.find(junction => (
    junction.surfaceMode === 'ATTACHED_ROAD_UNION'
    && junction.roadIds.includes(road.roadId)
    && Math.hypot(junction.x - testPoint.x, junction.z - testPoint.z) <= EPSILON
  ));

  // 表示面はSampleごとの正方形ではなく、連続する陸地区間を覆う長方形に集約する。
  const roadSurfaces = [];
  const samplesByRoad = new Map();
  for (const sample of allPathSamples) {
    if (!samplesByRoad.has(sample.roadId)) samplesByRoad.set(sample.roadId, []);
    samplesByRoad.get(sample.roadId).push(sample);
  }
  for (const road of roads) {
    const roadSamples = samplesByRoad.get(road.roadId) ?? [];
    let runStart = -1;
    for (let sampleIndex = 0; sampleIndex <= roadSamples.length; sampleIndex++) {
      const sample = roadSamples[sampleIndex];
      const isVisible = sample && !sample.isWater && !sample.isBlocked;
      if (isVisible && runStart === -1) runStart = sampleIndex;
      if (isVisible || runStart === -1) continue;

      const first = roadSamples[runStart];
      const last = roadSamples[sampleIndex - 1];
      const beginsAtRoadStart = runStart === 0;
      const endsAtRoadEnd = sampleIndex === roadSamples.length;
      const joinMargin = road.roadSurfaceOverlap ?? Math.min(2, road.width * 0.03);
      const startJunction = beginsAtRoadStart ? specialJunctionAtPoint(road, road.start) : null;
      const endJunction = endsAtRoadEnd ? specialJunctionAtPoint(road, road.end) : null;
      const startMargin = startJunction
        ? -road.width / 2
        : beginsAtRoadStart && hasRoadConnectionAtPoint(road, road.start) ? joinMargin : 0;
      const endMargin = endJunction
        ? -road.width / 2
        : endsAtRoadEnd && hasRoadConnectionAtPoint(road, road.end) ? joinMargin : 0;
      const startHalfLength = beginsAtRoadStart ? first.length / 2 : 0;
      const endHalfLength = endsAtRoadEnd ? last.length / 2 : 0;
      const start = {
        x: first.x - road.tangentX * (startHalfLength + startMargin),
        z: first.z - road.tangentZ * (startHalfLength + startMargin),
      };
      const end = {
        x: last.x + road.tangentX * (endHalfLength + endMargin),
        z: last.z + road.tangentZ * (endHalfLength + endMargin),
      };
      const direction = normalize(end.x - start.x, end.z - start.z);
      if (direction) {
        roadSurfaces.push(Object.freeze({
          surfaceId: `road-surface-${String(roadSurfaces.length).padStart(3, '0')}`,
          roadId: road.roadId,
          routeId: road.routeId,
          kind: road.kind,
          start: Object.freeze(start),
          end: Object.freeze(end),
          x: (start.x + end.x) / 2,
          z: (start.z + end.z) / 2,
          width: road.width,
          length: direction.length,
          tangentX: direction.x,
          tangentZ: direction.z,
          startCap: 'FLAT',
          endCap: 'FLAT',
        }));
      }
      runStart = -1;
    }
  }

  const createAttachedRoadUnionSurface = junction => {
    const attachedRoads = junction.roadIds.map(roadId => roadsById.get(roadId)).filter(Boolean);
    const patches = attachedRoads.map(road => {
      const startsHere = Math.hypot(road.start.x - junction.x, road.start.z - junction.z) <= EPSILON;
      const outwardX = startsHere ? road.tangentX : -road.tangentX;
      const outwardZ = startsHere ? road.tangentZ : -road.tangentZ;
      if (Math.min(Math.abs(outwardX), Math.abs(outwardZ)) > EPSILON) {
        throw new RangeError(`Capital junction road is not orthogonal: ${road.roadId}`);
      }
      const reach = road.width / 2;
      const halfRoadWidth = road.width / 2;
      return Object.freeze(Math.abs(outwardX) > Math.abs(outwardZ)
        ? {
          roadId: road.roadId,
          minX: Math.min(0, outwardX * reach),
          maxX: Math.max(0, outwardX * reach),
          minZ: -halfRoadWidth,
          maxZ: halfRoadWidth,
        }
        : {
          roadId: road.roadId,
          minX: -halfRoadWidth,
          maxX: halfRoadWidth,
          minZ: Math.min(0, outwardZ * reach),
          maxZ: Math.max(0, outwardZ * reach),
        });
    });
    const xCoordinates = [...new Set(patches.flatMap(patch => [patch.minX, patch.maxX]))].sort((a, b) => a - b);
    const zCoordinates = [...new Set(patches.flatMap(patch => [patch.minZ, patch.maxZ]))].sort((a, b) => a - b);
    const vertices = [];
    const triangles = [];
    const vertexByCoordinate = new Map();
    const getVertexIndex = (x, z) => {
      const key = `${x}:${z}`;
      if (!vertexByCoordinate.has(key)) {
        vertexByCoordinate.set(key, vertices.length);
        vertices.push(Object.freeze({ x, z }));
      }
      return vertexByCoordinate.get(key);
    };
    for (let xIndex = 0; xIndex < xCoordinates.length - 1; xIndex++) {
      for (let zIndex = 0; zIndex < zCoordinates.length - 1; zIndex++) {
        const minX = xCoordinates[xIndex];
        const maxX = xCoordinates[xIndex + 1];
        const minZ = zCoordinates[zIndex];
        const maxZ = zCoordinates[zIndex + 1];
        const midpointX = (minX + maxX) / 2;
        const midpointZ = (minZ + maxZ) / 2;
        if (!patches.some(patch => (
          midpointX >= patch.minX && midpointX <= patch.maxX
          && midpointZ >= patch.minZ && midpointZ <= patch.maxZ
        ))) continue;
        const bottomLeft = getVertexIndex(minX, minZ);
        const bottomRight = getVertexIndex(maxX, minZ);
        const topRight = getVertexIndex(maxX, maxZ);
        const topLeft = getVertexIndex(minX, maxZ);
        triangles.push(Object.freeze([bottomLeft, topRight, bottomRight]));
        triangles.push(Object.freeze([bottomLeft, topLeft, topRight]));
      }
    }
    const minimumX = Math.min(...vertices.map(vertex => vertex.x));
    const maximumX = Math.max(...vertices.map(vertex => vertex.x));
    const minimumZ = Math.min(...vertices.map(vertex => vertex.z));
    const maximumZ = Math.max(...vertices.map(vertex => vertex.z));
    return Object.freeze({
      surfaceId: `junction-surface-${junction.junctionId}`,
      junctionId: junction.junctionId,
      shape: 'ATTACHED_ROAD_UNION',
      x: junction.x,
      z: junction.z,
      width: maximumX - minimumX,
      length: maximumZ - minimumZ,
      tangentX: 0,
      tangentZ: 1,
      maxRoadWidth: junction.width,
      vertices: Object.freeze(vertices),
      triangles: Object.freeze(triangles),
      patches: Object.freeze(patches),
      sourceRoadIds: Object.freeze(attachedRoads.map(road => road.roadId)),
    });
  };

  const junctionSurfaces = junctions.map(junction => {
    if (junction.surfaceMode === 'ATTACHED_ROAD_UNION') {
      return createAttachedRoadUnionSurface(junction);
    }
    const parent = roadsById.get(junction.parentRoadId);
    const child = roadsById.get(junction.childRoadId);
    if (!parent || !child) throw new RangeError(`junction roads are missing: ${junction.junctionId}`);
    const width = parent.width;
    const length = Math.min(parent.width, child.width);
    const halfWidth = width / 2;
    const halfLength = length / 2;
    return Object.freeze({
      surfaceId: `junction-surface-${junction.junctionId}`,
      junctionId: junction.junctionId,
      shape: 'RECTANGLE',
      x: junction.x,
      z: junction.z,
      width,
      length,
      tangentX: parent.tangentX,
      tangentZ: parent.tangentZ,
      maxRoadWidth: junction.width,
      vertices: Object.freeze([
        Object.freeze({ x: -halfWidth, z: -halfLength }),
        Object.freeze({ x: halfWidth, z: -halfLength }),
        Object.freeze({ x: halfWidth, z: halfLength }),
        Object.freeze({ x: -halfWidth, z: halfLength }),
      ]),
      triangles: Object.freeze([
        Object.freeze([0, 1, 2]),
        Object.freeze([0, 2, 3]),
      ]),
    });
  });

  const roadsByRoute = new Map();
  for (const road of roads) {
    if (!roadsByRoute.has(road.routeId)) roadsByRoute.set(road.routeId, []);
    roadsByRoute.get(road.routeId).push(road);
  }
  const roadEnds = [];
  for (const [routeId, routeRoads] of roadsByRoute) {
    routeRoads.sort((a, b) => a.routeOrder - b.routeOrder);
    const endpoints = [
      { side: 'START', road: routeRoads[0], point: routeRoads[0].start },
      { side: 'END', road: routeRoads.at(-1), point: routeRoads.at(-1).end },
    ];
    for (const endpoint of endpoints) {
      const isJunction = junctions.some(junction => (
        Math.hypot(junction.x - endpoint.point.x, junction.z - endpoint.point.z) <= EPSILON
      ));
      if (isJunction) continue;
      roadEnds.push(Object.freeze({
        endId: `road-end-${String(roadEnds.length).padStart(3, '0')}`,
        routeId,
        roadId: endpoint.road.roadId,
        kind: endpoint.road.kind,
        side: endpoint.side,
        x: endpoint.point.x,
        z: endpoint.point.z,
        width: endpoint.road.width,
        style: 'FLAT',
      }));
    }
  }

  const capitalCivicCoreSummary = capitalCivicCore && capitalTopology
    ? (() => {
      const capitalRoads = roads.filter(road => road.townId === capitalTownId);
      const civicAccessRoads = capitalRoads.filter(road => road.isCivicAccess);
      const normalCoreRoads = capitalRoads.filter(road => (
        !road.isCivicAccess
        && segmentIntersectsCapitalCivicCore(
          road.start,
          road.end,
          road.width,
          capitalCivicCore,
        )
      ));
      const coreJunctions = junctions.filter(junction => (
        isPointInCapitalCivicCore(junction.x, junction.z, capitalCivicCore)
      ));
      const mainSurface = junctionSurfaces.find(surface => (
        surface.junctionId === capitalTopology.mainHubId
      ));
      const triangleMetrics = mainSurface.triangles.map(triangle => {
        const [first, second, third] = triangle.map(index => mainSurface.vertices[index]);
        const twiceArea = Math.abs(
          (second.x - first.x) * (third.z - first.z)
          - (second.z - first.z) * (third.x - first.x)
        );
        const longestEdgeSquared = Math.max(
          (second.x - first.x) ** 2 + (second.z - first.z) ** 2,
          (third.x - second.x) ** 2 + (third.z - second.z) ** 2,
          (first.x - third.x) ** 2 + (first.z - third.z) ** 2,
        );
        return { twiceArea, needleRatio: longestEdgeSquared / twiceArea };
      });
      let minimumPortSpacing = Infinity;
      for (let firstIndex = 0; firstIndex < capitalTopology.ports.length; firstIndex++) {
        for (let secondIndex = firstIndex + 1; secondIndex < capitalTopology.ports.length; secondIndex++) {
          minimumPortSpacing = Math.min(minimumPortSpacing, Math.hypot(
            capitalTopology.ports[firstIndex].x - capitalTopology.ports[secondIndex].x,
            capitalTopology.ports[firstIndex].z - capitalTopology.ports[secondIndex].z,
          ));
        }
      }
      return Object.freeze({
        normalCoreRoadCount: normalCoreRoads.length,
        civicAccessRoadCount: civicAccessRoads.length,
        coreInternalJunctionCount: coreJunctions.length,
        junctionCountWithin150: junctions.filter(junction => (
          Math.hypot(junction.x - capitalCivicCore.centerX, junction.z - capitalCivicCore.centerZ) <= 150
        )).length,
        junctionCountWithin300: junctions.filter(junction => (
          Math.hypot(junction.x - capitalCivicCore.centerX, junction.z - capitalCivicCore.centerZ) <= 300
        )).length,
        minimumPortSpacing,
        collectorSegmentCount: capitalTopology.collectorSegmentIds.length,
        mainJunctionSurfaceShape: mainSurface.shape,
        mainJunctionVertexCount: mainSurface.vertices.length,
        mainJunctionTriangleCount: mainSurface.triangles.length,
        mainJunctionMinimumTwiceArea: Math.min(...triangleMetrics.map(metric => metric.twiceArea)),
        mainJunctionMaximumNeedleRatio: Math.max(...triangleMetrics.map(metric => metric.needleRatio)),
      });
    })()
    : null;

  return Object.freeze({
    roads: Object.freeze(roads),
    junctions: Object.freeze(junctions),
    roadSurfaces: Object.freeze(roadSurfaces),
    junctionSurfaces: Object.freeze(junctionSurfaces),
    roadEnds: Object.freeze(roadEnds),
    omittedRoutes: Object.freeze(omittedRoutes),
    majorConnections,
    pathSamples: Object.freeze(allPathSamples.filter(sample => !sample.isWater && !sample.isBlocked)),
    allPathSamples: Object.freeze(allPathSamples),
    bridgeSpans: Object.freeze(bridgeSpans),
    capitalCivicCore,
    capitalTopology,
    capitalCivicCoreSummary,
  });
}
