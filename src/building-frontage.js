import { ROAD_KINDS } from './road-town-structure.js';

export const FRONTAGE_BUILDING_TYPES = Object.freeze(['house', 'tower', 'school', 'church']);

export const BUILDING_FRONTAGE_PROFILES = Object.freeze({
  // The generated models expose their entrance/front detail on local +Z; tower is symmetric and uses +Z as its canonical front.
  house: Object.freeze({ frontExtent: 105, setback: 26, minSetback: 20, maxSetback: 45, variation: 0.10, slotSpacing: 215, frontRotationOffset: 0 }),
  tower: Object.freeze({ frontExtent: 55, setback: 38, minSetback: 25, maxSetback: 50, variation: 0.12, slotSpacing: 180, frontRotationOffset: 0 }),
  school: Object.freeze({ frontExtent: 95, setback: 64, minSetback: 45, maxSetback: 80, variation: 0.12, slotSpacing: 365, frontRotationOffset: 0 }),
  church: Object.freeze({ frontExtent: 190, setback: 70, minSetback: 50, maxSetback: 90, variation: 0.12, slotSpacing: 310, frontRotationOffset: 0 }),
});

const ROAD_KIND_DISTANCE_BIAS = Object.freeze({
  [ROAD_KINDS.LOCAL]: 0,
  [ROAD_KINDS.ALLEY]: 24,
  [ROAD_KINDS.MAJOR]: 320,
});

const EPSILON = 1e-9;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stableHash(parts) {
  const text = parts.join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function closestPointOnRoad(x, z, road) {
  const dx = road.end.x - road.start.x;
  const dz = road.end.z - road.start.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq <= EPSILON
    ? 0
    : clamp(((x - road.start.x) * dx + (z - road.start.z) * dz) / lengthSq, 0, 1);
  const pointX = road.start.x + dx * t;
  const pointZ = road.start.z + dz * t;
  return Object.freeze({
    x: pointX,
    z: pointZ,
    distance: Math.hypot(x - pointX, z - pointZ),
    t,
  });
}

export function selectFrontageRoad({ x, z, roads, townId = null }) {
  const candidates = roads
    .filter(road => (
      road.kind !== ROAD_KINDS.START_APPROACH
      && ROAD_KIND_DISTANCE_BIAS[road.kind] !== undefined
      && (townId === null || road.townId === townId)
    ))
    .map(road => {
      const closest = closestPointOnRoad(x, z, road);
      return {
        road,
        closest,
        score: closest.distance + ROAD_KIND_DISTANCE_BIAS[road.kind],
      };
    })
    .sort((first, second) => (
      first.score - second.score
      || first.closest.distance - second.closest.distance
      || first.road.roadId.localeCompare(second.road.roadId)
    ));

  if (candidates.length === 0) return null;
  const selected = candidates[0];
  return Object.freeze({
    roadId: selected.road.roadId,
    routeId: selected.road.routeId,
    kind: selected.road.kind,
    width: selected.road.width,
    tangentX: selected.road.tangentX,
    tangentZ: selected.road.tangentZ,
    normalX: selected.road.normalX,
    normalZ: selected.road.normalZ,
    closestX: selected.closest.x,
    closestZ: selected.closest.z,
    distance: selected.closest.distance,
    roadT: selected.closest.t,
    roadLength: Math.hypot(
      selected.road.end.x - selected.road.start.x,
      selected.road.end.z - selected.road.start.z,
    ),
  });
}

const FRONTAGE_REGION_PATTERN = Object.freeze([
  'CORE', 'MIDDLE', 'CORE', 'MIDDLE', 'CORE',
  'MIDDLE', 'CORE', 'MIDDLE', 'CORE', 'MIDDLE',
  'CORE', 'MIDDLE', 'CORE', 'MIDDLE', 'CORE',
  'MIDDLE', 'MIDDLE', 'OUTER', 'OUTER', 'OUTER',
]);

export function buildFrontageAnchorPlan({ samples, roads, town }) {
  const roadsById = new Map(roads.map(road => [road.roadId, road]));
  const groups = { CORE: [], MIDDLE: [], OUTER: [] };
  for (const sample of samples) {
    const road = roadsById.get(sample.roadId);
    if (!road || road.kind === ROAD_KINDS.START_APPROACH) continue;
    const ratio = Math.hypot(sample.x - town.x, sample.z - town.z) / town.radius;
    const region = ratio <= 0.35 ? 'CORE' : ratio <= 0.70 ? 'MIDDLE' : 'OUTER';
    groups[region].push(sample);
  }

  const roadPriority = road => (
    road.kind === ROAD_KINDS.LOCAL && road.isTownSpine ? 0
      : road.kind === ROAD_KINDS.LOCAL ? 1
        : road.kind === ROAD_KINDS.ALLEY ? 2 : 3
  );
  for (const group of Object.values(groups)) {
    group.sort((first, second) => {
      const firstRoad = roadsById.get(first.roadId);
      const secondRoad = roadsById.get(second.roadId);
      return roadPriority(firstRoad) - roadPriority(secondRoad)
        || firstRoad.routeId.localeCompare(secondRoad.routeId)
        || firstRoad.routeOrder - secondRoad.routeOrder
        || first.sampleIndex - second.sampleIndex
        || first.roadId.localeCompare(second.roadId);
    });
  }
  return Object.freeze({
    CORE: Object.freeze(groups.CORE),
    MIDDLE: Object.freeze(groups.MIDDLE),
    OUTER: Object.freeze(groups.OUTER),
  });
}

export function selectFrontageAnchorSample({ plan, buildingIndex, type, townId }) {
  const requestedRegion = FRONTAGE_REGION_PATTERN[(Math.max(1, buildingIndex) - 1) % FRONTAGE_REGION_PATTERN.length];
  const fallbackOrder = [requestedRegion, 'MIDDLE', 'CORE', 'OUTER'];
  const region = fallbackOrder.find(candidate => plan[candidate]?.length > 0);
  if (!region) return null;
  const candidates = plan[region];
  const clusterIndex = Math.floor((Math.max(1, buildingIndex) - 1) / 3);
  const focusCount = Math.max(1, Math.ceil(candidates.length * 0.45));
  const startOffset = stableHash([townId, type, region, 'anchor']) % focusCount;
  return candidates[(startOffset + clusterIndex) % candidates.length];
}

export function createFrontagePlacement({
  type,
  road,
  buildingIndex,
  townId,
  sideOverride = null,
  identityRoadId = road?.roadId,
  frontageAlong = null,
}) {
  const profile = BUILDING_FRONTAGE_PROFILES[type];
  if (!profile) throw new RangeError(`unsupported frontage building type: ${type}`);
  if (!road || road.kind === ROAD_KINDS.START_APPROACH) {
    throw new RangeError('frontage road must be MAJOR, LOCAL, or ALLEY');
  }

  const identity = [townId, identityRoadId, type, buildingIndex];
  const side = sideOverride ?? (stableHash([...identity, 'side']) % 2 === 0 ? -1 : 1);
  const variationUnit = stableHash([...identity, 'setback']) / 0xffffffff * 2 - 1;
  const setback = clamp(
    profile.setback * (1 + variationUnit * profile.variation),
    profile.minSetback,
    profile.maxSetback,
  );
  const centerDistance = road.width / 2 + profile.frontExtent + setback;
  const outwardNormalX = road.normalX * side;
  const outwardNormalZ = road.normalZ * side;
  const frontageNormalX = -outwardNormalX;
  const frontageNormalZ = -outwardNormalZ;

  return Object.freeze({
    x: road.closestX + outwardNormalX * centerDistance,
    z: road.closestZ + outwardNormalZ * centerDistance,
    rotationY: Math.atan2(frontageNormalX, frontageNormalZ) + profile.frontRotationOffset,
    frontageRoadId: road.roadId,
    frontageRoadKind: road.kind,
    frontageX: road.closestX,
    frontageZ: road.closestZ,
    frontageNormalX,
    frontageNormalZ,
    setback,
    centerDistance,
    roadT: road.roadT,
    frontageAlong: frontageAlong ?? road.roadT * road.roadLength,
    side,
  });
}

export function createFrontageCandidatePlacements({
  type,
  road,
  roads,
  buildingIndex,
  townId,
  maximumSlotOffset = 3,
}) {
  const profile = BUILDING_FRONTAGE_PROFILES[type];
  if (!profile) throw new RangeError(`unsupported frontage building type: ${type}`);
  const routeRoads = roads
    .filter(candidate => candidate.routeId === road.routeId && candidate.kind !== ROAD_KINDS.START_APPROACH)
    .sort((first, second) => first.routeOrder - second.routeOrder || first.roadId.localeCompare(second.roadId));
  const routeSegments = [];
  let routeLength = 0;
  for (const segment of routeRoads) {
    const length = Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z);
    routeSegments.push({ segment, startDistance: routeLength, length });
    routeLength += length;
  }
  const selectedSegment = routeSegments.find(candidate => candidate.segment.roadId === road.roadId);
  if (!selectedSegment) return Object.freeze({ placements: Object.freeze([]), routeEndCount: 1 });

  const baseDistance = selectedSegment.startDistance + road.roadT * selectedSegment.length;
  const primarySide = stableHash([townId, road.roadId, type, buildingIndex, 'side']) % 2 === 0 ? -1 : 1;
  const slotOffsets = [0];
  for (let offset = 1; offset <= maximumSlotOffset; offset++) slotOffsets.push(offset, -offset);

  const placements = [];
  let routeEndCount = 0;
  for (const slotOffset of slotOffsets) {
    const routeDistance = baseDistance + slotOffset * profile.slotSpacing;
    if (routeDistance < 0 || routeDistance > routeLength) {
      routeEndCount++;
      continue;
    }
    const located = routeSegments.find(candidate => (
      routeDistance <= candidate.startDistance + candidate.length + EPSILON
    )) ?? routeSegments[routeSegments.length - 1];
    const roadT = clamp((routeDistance - located.startDistance) / located.length, 0, 1);
    const segment = located.segment;
    const roadAtSlot = {
      roadId: segment.roadId,
      routeId: segment.routeId,
      kind: segment.kind,
      width: segment.width,
      tangentX: segment.tangentX,
      tangentZ: segment.tangentZ,
      normalX: segment.normalX,
      normalZ: segment.normalZ,
      closestX: segment.start.x + (segment.end.x - segment.start.x) * roadT,
      closestZ: segment.start.z + (segment.end.z - segment.start.z) * roadT,
      roadT,
      roadLength: located.length,
    };
    for (const side of [primarySide, -primarySide]) {
      placements.push(Object.freeze({
        ...createFrontagePlacement({
          type,
          road: roadAtSlot,
          buildingIndex,
          townId,
          sideOverride: side,
          identityRoadId: road.roadId,
          frontageAlong: routeDistance,
        }),
        frontageRouteId: road.routeId,
        slotOffset,
        sideAttempt: side === primarySide ? 0 : 1,
      }));
    }
  }
  return Object.freeze({
    placements: Object.freeze(placements),
    routeEndCount,
  });
}

export function circleIntersectsOrientedSurface(x, z, radius, surface, clearance = 0) {
  const tangentX = surface.tangentX;
  const tangentZ = surface.tangentZ;
  const normalX = -tangentZ;
  const normalZ = tangentX;
  const dx = x - surface.x;
  const dz = z - surface.z;
  const localTangent = dx * tangentX + dz * tangentZ;
  const localNormal = dx * normalX + dz * normalZ;
  const halfLength = surface.length / 2 + clearance;
  const halfWidth = surface.width / 2 + clearance;
  const closestTangent = clamp(localTangent, -halfLength, halfLength);
  const closestNormal = clamp(localNormal, -halfWidth, halfWidth);
  return Math.hypot(localTangent - closestTangent, localNormal - closestNormal) < radius;
}

export function circleIntersectsBridge(x, z, radius, bridge, clearance = 0) {
  const tangentX = Math.sin(bridge.angle);
  const tangentZ = Math.cos(bridge.angle);
  return circleIntersectsOrientedSurface(x, z, radius, {
    x: bridge.x,
    z: bridge.z,
    width: bridge.halfWidth * 2,
    length: bridge.halfLength * 2,
    tangentX,
    tangentZ,
  }, clearance);
}

export function circleIntersectsCircle(x, z, radius, zone, clearance = 0) {
  const minimumDistance = radius + zone.radius + clearance;
  return (x - zone.x) ** 2 + (z - zone.z) ** 2 < minimumDistance ** 2;
}

export function getFrontagePairGaps(firstType, secondType) {
  const pair = [firstType, secondType].sort().join('|');
  if (pair === 'house|house') return Object.freeze({ passageGap: 35, alongGap: 20 });
  if (pair === 'house|tower') return Object.freeze({ passageGap: 42, alongGap: 20 });
  if (pair === 'tower|tower') return Object.freeze({ passageGap: 48, alongGap: 20 });
  return Object.freeze({ passageGap: 75, alongGap: 30 });
}

export function getMaximumAlongRoadGap(positions, routeLength) {
  const ordered = [0, ...positions.filter(Number.isFinite).sort((first, second) => first - second), routeLength];
  let maximumGap = 0;
  for (let index = 1; index < ordered.length; index++) {
    maximumGap = Math.max(maximumGap, ordered[index] - ordered[index - 1]);
  }
  return maximumGap;
}

export function frontageSpotsConflict(candidate, existing) {
  const { passageGap, alongGap } = getFrontagePairGaps(candidate.type, existing.type);
  const minimumDistance = candidate.radius + existing.radius + passageGap;
  if ((candidate.x - existing.x) ** 2 + (candidate.z - existing.z) ** 2 < minimumDistance ** 2) {
    return true;
  }
  const sameRoadOrRoute = candidate.frontageRoadId !== null
    && (candidate.frontageRoadId === existing.frontageRoadId
      || (candidate.frontageRouteId && candidate.frontageRouteId === existing.frontageRouteId));
  return sameRoadOrRoute
    && Number.isFinite(candidate.frontageAlong)
    && Number.isFinite(existing.frontageAlong)
    && Math.abs(candidate.frontageAlong - existing.frontageAlong)
      < candidate.radius + existing.radius + alongGap;
}
