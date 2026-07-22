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

  const routeAroundExclusions = (routePoints, kind, routeId) => {
    if (exclusionZones.length === 0) return routePoints;
    const width = ROAD_WIDTHS[kind];
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
    parentRoadId = null,
    isTownSpine = false,
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
      width: ROAD_WIDTHS[kind],
      tangentX: direction.x,
      tangentZ: direction.z,
      normalX: -direction.z,
      normalZ: direction.x,
      parentRoadId,
      isTownSpine,
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
  }) => {
    const segments = [];
    let nextParentRoadId = parentRoadId;
    let routedPoints = routeAroundExclusions(points, kind, routeId);
    const protectedLength = ROAD_WIDTHS[kind] * 2;
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
        parentRoadId: kind === ROAD_KINDS.MAJOR ? null : nextParentRoadId,
        isTownSpine,
      });
      segments.push(segment);
      if (kind !== ROAD_KINDS.MAJOR) nextParentRoadId = segment.roadId;
    }
    return segments;
  };

  const addJunction = ({ type, x, z, roadIds, parentRoadId, childRoadId, isHub = false }) => {
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
    const direction = normalize(toPoint.x - fromPoint.x, toPoint.z - fromPoint.z);
    const bendSign = connectionIndex % 2 === 0 ? 1 : -1;
    const bend = Math.min(220, direction.length * 0.025) * bendSign;
    const normalX = -direction.z;
    const normalZ = direction.x;
    const chooseTownExit = (spineDirection, targetDirection) => {
      const first = { x: -spineDirection.z, z: spineDirection.x };
      const dot = first.x * targetDirection.x + first.z * targetDirection.z;
      return dot >= 0 ? first : { x: -first.x, z: -first.z };
    };
    const fromExit = chooseTownExit(townSpineDirections[connection.fromIndex], direction);
    const toOutward = chooseTownExit(townSpineDirections[connection.toIndex], {
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
        x: fromPoint.x + direction.x * direction.length * 0.34 + normalX * bend * 0.65,
        z: fromPoint.z + direction.z * direction.length * 0.34 + normalZ * bend * 0.65,
      },
      {
        x: fromPoint.x + direction.x * direction.length * 0.67 + normalX * bend,
        z: fromPoint.z + direction.z * direction.length * 0.67 + normalZ * bend,
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
    const sampleCount = Math.max(1, Math.ceil(segmentLength / ROAD_SAMPLE_SPACING[road.kind]));
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
      const joinMargin = Math.min(2, road.width * 0.03);
      const startMargin = beginsAtRoadStart && hasRoadConnectionAtPoint(road, road.start) ? joinMargin : 0;
      const endMargin = endsAtRoadEnd && hasRoadConnectionAtPoint(road, road.end) ? joinMargin : 0;
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

  const junctionSurfaces = junctions.map(junction => {
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
  });
}
