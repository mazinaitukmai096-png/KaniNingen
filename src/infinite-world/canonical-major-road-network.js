import { orientedRectanglesOverlap } from '../building-lot.js';
import { ROAD_KINDS, ROAD_WIDTHS } from '../road-town-structure.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import {
  LOGICAL_CHUNK_SIZE_METERS,
  decomposeLogicalWorldPosition,
} from './chunk-coordinates.js';
import { FINITE_WORLD_UNITS_PER_METER } from './single-rural-settlement.js';
import {
  resolveDirectionalSettlementRoadGatewayHandoff,
  resolveSettlementRoadGatewayHandoff,
} from './settlement-road-gateway-handoff.js';

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const nowMs = () => globalThis.performance?.now?.() ?? Date.now();
const recordTiming = (observer, name, startedAt, details = {}) => {
  observer?.(name, Math.max(0, nowMs() - startedAt), details);
};

export const W8_CANONICAL_MAJOR_ROAD = Object.freeze({
  schemaVersion: 'w8-canonical-major-road-contract-1',
  roadKind: ROAD_KINDS.MAJOR,
  widthMeters: ROAD_WIDTHS[ROAD_KINDS.MAJOR] / FINITE_WORLD_UNITS_PER_METER,
  routeGridStepMeters: ROAD_WIDTHS[ROAD_KINDS.MAJOR] * 2 / FINITE_WORLD_UNITS_PER_METER,
  routeSearchGridStepMeters: ROAD_WIDTHS[ROAD_KINDS.MAJOR] * 4
    / FINITE_WORLD_UNITS_PER_METER,
  obstacleClearanceMeters: 0.25,
});

export function createCanonicalMajorRoadCacheKey({
  worldSeedHash,
  roadEdgeStableId,
  sourceContentHashes,
  surfacePolicyVersion,
  roadContractVersion = W8_CANONICAL_MAJOR_ROAD.schemaVersion,
} = {}) {
  if (typeof worldSeedHash !== 'string' || !worldSeedHash
    || typeof roadEdgeStableId !== 'string' || !roadEdgeStableId
    || !Array.isArray(sourceContentHashes)
    || !sourceContentHashes.every(value => (
      typeof value?.settlementStableId === 'string'
      && /^sha256:[0-9a-f]{64}$/.test(value?.contentHash ?? '')
    ))
    || typeof surfacePolicyVersion !== 'string' || !surfacePolicyVersion
    || typeof roadContractVersion !== 'string' || !roadContractVersion) {
    throw new TypeError('complete canonical MAJOR Road cache identity is required');
  }
  return canonicalizeJson({
    worldSeedHash,
    roadEdgeStableId,
    sourceContentHashes: [...sourceContentHashes].sort((left, right) => (
      left.settlementStableId.localeCompare(right.settlementStableId)
    )),
    surfacePolicyVersion,
    roadContractVersion,
  });
}

function rectangle(record, kind, stableId) {
  const centerX = record.centerX ?? record.x ?? record.worldPosition?.x;
  const centerZ = record.centerZ ?? record.z ?? record.worldPosition?.z;
  const width = record.width ?? record.widthMeters;
  const depth = record.depth ?? record.depthMeters;
  const rotationY = record.rotationY ?? 0;
  if (![centerX, centerZ, width, depth, rotationY].every(Number.isFinite)
    || width <= 0 || depth <= 0) return null;
  return Object.freeze({
    stableId,
    kind,
    centerX: q6(centerX),
    centerZ: q6(centerZ),
    rotationY: q6(rotationY),
    width: q6(width),
    depth: q6(depth),
  });
}

export function createCanonicalMajorRoadObstacles({
  buildings = [],
  landmarks = [],
  preserveFrontageRoadId = false,
} = {}) {
  const obstacles = [];
  for (const building of buildings) {
    const footprint = rectangle(building, 'BUILDING', `${building.stableId}:footprint`);
    if (footprint) obstacles.push(Object.freeze({
      ...footprint,
      ...(preserveFrontageRoadId && building.frontageRoadId
        ? { frontageRoadStableId: building.frontageRoadId } : {}),
    }));
    const lot = building.lot;
    if (lot?.lotStatus === 'ACTIVE') {
      const lotRecord = rectangle({
        centerX: lot.centerX,
        centerZ: lot.centerZ,
        rotationY: building.rotationY,
        width: lot.widthMeters ?? lot.width,
        depth: lot.depthMeters ?? lot.depth,
      }, 'LOT', `${building.stableId}:lot`);
      if (lotRecord) obstacles.push(Object.freeze({
        ...lotRecord,
        ...(preserveFrontageRoadId && building.frontageRoadId
          ? { frontageRoadStableId: building.frontageRoadId } : {}),
      }));
    }
  }
  for (const landmark of landmarks) {
    const landmarkRecord = rectangle(
      landmark,
      'LANDMARK',
      `${landmark.stableId}:landmark`,
    );
    if (landmarkRecord) obstacles.push(landmarkRecord);
  }
  return Object.freeze(obstacles.sort((left, right) => (
    left.stableId.localeCompare(right.stableId)
  )));
}

function roadRectangle(start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  return {
    centerX: (start.x + end.x) / 2,
    centerZ: (start.z + end.z) / 2,
    rotationY: Math.atan2(dx, dz),
    width: W8_CANONICAL_MAJOR_ROAD.widthMeters,
    depth: Math.hypot(dx, dz),
  };
}

export function majorRoadSegmentIntersectsObstacle(start, end, obstacle) {
  if (Math.hypot(end.x - start.x, end.z - start.z) <= 1e-9) return false;
  return orientedRectanglesOverlap(
    roadRectangle(start, end),
    obstacle,
    W8_CANONICAL_MAJOR_ROAD.obstacleClearanceMeters,
  );
}

function pointInsideExpandedObstacle(point, obstacle) {
  const cosine = Math.cos(obstacle.rotationY);
  const sine = Math.sin(obstacle.rotationY);
  const dx = point.x - obstacle.centerX;
  const dz = point.z - obstacle.centerZ;
  const right = dx * cosine - dz * sine;
  const front = dx * sine + dz * cosine;
  const expansion = W8_CANONICAL_MAJOR_ROAD.widthMeters / 2
    + W8_CANONICAL_MAJOR_ROAD.obstacleClearanceMeters;
  return Math.abs(right) < obstacle.width / 2 + expansion
    && Math.abs(front) < obstacle.depth / 2 + expansion;
}

function pointSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(point.x - start.x - dx * t, point.z - start.z - dz * t);
}

function segmentIsClear(start, end, obstacles) {
  return obstacles.every(obstacle => !majorRoadSegmentIntersectsObstacle(start, end, obstacle));
}

function gatewayApproachIsClear(start, end, obstacles, handoff) {
  return obstacles.every(obstacle => (
    obstacle.frontageRoadStableId === handoff.arterialRoadStableId
      || !majorRoadSegmentIntersectsObstacle(start, end, obstacle)
  ));
}

function createObstacleSpatialIndex(obstacles, cellSizeMeters) {
  const cells = new Map();
  const expansion = W8_CANONICAL_MAJOR_ROAD.widthMeters / 2
    + W8_CANONICAL_MAJOR_ROAD.obstacleClearanceMeters;
  for (const obstacle of obstacles) {
    const cosine = Math.cos(obstacle.rotationY);
    const sine = Math.sin(obstacle.rotationY);
    const halfWidth = obstacle.width / 2 + expansion;
    const halfDepth = obstacle.depth / 2 + expansion;
    const extentX = Math.abs(cosine) * halfWidth + Math.abs(sine) * halfDepth;
    const extentZ = Math.abs(sine) * halfWidth + Math.abs(cosine) * halfDepth;
    const minCellX = Math.floor((obstacle.centerX - extentX) / cellSizeMeters);
    const maxCellX = Math.floor((obstacle.centerX + extentX) / cellSizeMeters);
    const minCellZ = Math.floor((obstacle.centerZ - extentZ) / cellSizeMeters);
    const maxCellZ = Math.floor((obstacle.centerZ + extentZ) / cellSizeMeters);
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const key = `${cellX},${cellZ}`;
        const values = cells.get(key) ?? [];
        values.push(obstacle);
        cells.set(key, values);
      }
    }
  }
  const query = (minX, minZ, maxX, maxZ) => {
    const unique = new Map();
    for (let cellZ = Math.floor(minZ / cellSizeMeters);
      cellZ <= Math.floor(maxZ / cellSizeMeters); cellZ += 1) {
      for (let cellX = Math.floor(minX / cellSizeMeters);
        cellX <= Math.floor(maxX / cellSizeMeters); cellX += 1) {
        for (const obstacle of cells.get(`${cellX},${cellZ}`) ?? []) {
          unique.set(obstacle.stableId, obstacle);
        }
      }
    }
    return [...unique.values()];
  };
  return Object.freeze({ query });
}

function selectSettlementTerminal(
  settlementId,
  center,
  toward,
  radiusMeters,
  obstacles,
  localRoads,
) {
  const intendedAngle = Math.atan2(toward.z - center.z, toward.x - center.x);
  const angularStep = Math.PI / 24;
  const angleOffsets = [0];
  for (let index = 1; index <= 24; index += 1) {
    angleOffsets.push(index * angularStep, -index * angularStep);
  }
  const radialStep = W8_CANONICAL_MAJOR_ROAD.widthMeters;
  const portalRadius = radiusMeters + W8_CANONICAL_MAJOR_ROAD.widthMeters * 2
    + W8_CANONICAL_MAJOR_ROAD.obstacleClearanceMeters;
  const accessCandidates = localRoads.filter(road => (
    road.settlementId === settlementId
    && segmentIsClear(road.start, road.end, obstacles)
  )).flatMap(road => {
    const length = Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z);
    const count = Math.max(1, Math.ceil(
      length / (W8_CANONICAL_MAJOR_ROAD.widthMeters / 2),
    ));
    return Array.from({ length: count + 1 }, (_, index) => {
      const t = index / count;
      const point = Object.freeze({
        x: q6(road.start.x + (road.end.x - road.start.x) * t),
        z: q6(road.start.z + (road.end.z - road.start.z) * t),
      });
      const angle = Math.atan2(point.z - center.z, point.x - center.x);
      let angleError = Math.abs(angle - intendedAngle) % (Math.PI * 2);
      if (angleError > Math.PI) angleError = Math.PI * 2 - angleError;
      return { point, angle, angleError, roadStableId: road.stableId };
    });
  }).sort((left, right) => (
    Math.hypot(left.point.x - center.x, left.point.z - center.z)
      - Math.hypot(right.point.x - center.x, right.point.z - center.z)
    || left.angleError - right.angleError
    || left.roadStableId.localeCompare(right.roadStableId)
    || left.point.x - right.point.x
    || left.point.z - right.point.z
  ));
  for (const candidate of accessCandidates) {
    const portalAngle = Math.hypot(
      candidate.point.x - center.x,
      candidate.point.z - center.z,
    ) > 1e-9 ? candidate.angle : intendedAngle;
    const portal = {
      x: q6(center.x + Math.cos(portalAngle) * portalRadius),
      z: q6(center.z + Math.sin(portalAngle) * portalRadius),
    };
    if (!obstacles.some(obstacle => pointInsideExpandedObstacle(candidate.point, obstacle))
      && segmentIsClear(candidate.point, portal, obstacles)) {
      return Object.freeze({
        connection: candidate.point,
        portal: Object.freeze(portal),
        localRoadStableId: candidate.roadStableId,
      });
    }
  }
  for (let distance = 0; distance <= portalRadius + 1e-9; distance += radialStep) {
    for (const offset of angleOffsets) {
      const angle = intendedAngle + offset;
      const point = {
        x: q6(center.x + Math.cos(angle) * distance),
        z: q6(center.z + Math.sin(angle) * distance),
      };
      const portal = {
        x: q6(center.x + Math.cos(angle) * portalRadius),
        z: q6(center.z + Math.sin(angle) * portalRadius),
      };
      if (!obstacles.some(obstacle => pointInsideExpandedObstacle(point, obstacle))
        && segmentIsClear(point, portal, obstacles)) {
        return Object.freeze({
          connection: Object.freeze(point),
          portal: Object.freeze(portal),
          localRoadStableId: null,
        });
      }
    }
  }
  throw new Error('no obstacle-free Settlement terminal for canonical MAJOR Road');
}

function routeWithLateralDogleg(start, end, obstacles, maximumOffsetMeters) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  if (length <= 1e-9) return null;
  const rightX = dz / length;
  const rightZ = -dx / length;
  const step = W8_CANONICAL_MAJOR_ROAD.routeSearchGridStepMeters;
  const offsetCount = Math.ceil(maximumOffsetMeters / step);
  for (let index = 1; index <= offsetCount; index += 1) {
    for (const sign of [1, -1]) {
      const offset = index * step * sign;
      const first = {
        x: q6(start.x + dx * 0.2 + rightX * offset),
        z: q6(start.z + dz * 0.2 + rightZ * offset),
      };
      const second = {
        x: q6(start.x + dx * 0.8 + rightX * offset),
        z: q6(start.z + dz * 0.8 + rightZ * offset),
      };
      const points = [start, first, second, end];
      if (points.slice(1).every((point, pointIndex) => (
        segmentIsClear(points[pointIndex], point, obstacles)
      ))) return points;
    }
  }
  return null;
}

class MinimumHeap {
  constructor() { this.values = []; }

  push(value) {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (MinimumHeap.compare(this.values[parent], value) <= 0) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop() {
    if (!this.values.length) return null;
    const first = this.values[0];
    const last = this.values.pop();
    if (this.values.length) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.values.length) break;
        let child = left;
        if (right < this.values.length
          && MinimumHeap.compare(this.values[right], this.values[left]) < 0) child = right;
        if (MinimumHeap.compare(last, this.values[child]) <= 0) break;
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = last;
    }
    return first;
  }

  static compare(left, right) {
    return left.f - right.f || left.g - right.g || left.index - right.index;
  }
}

function routeOnGrid(start, end, obstacles, lateralMarginMeters) {
  const length = Math.hypot(end.x - start.x, end.z - start.z);
  if (length <= 1e-9) return null;
  const forwardX = (end.x - start.x) / length;
  const forwardZ = (end.z - start.z) / length;
  const rightX = forwardZ;
  const rightZ = -forwardX;
  const step = W8_CANONICAL_MAJOR_ROAD.routeSearchGridStepMeters;
  const obstacleIndex = createObstacleSpatialIndex(obstacles, step * 4);
  const indexedPointBlocked = point => obstacleIndex.query(
    point.x, point.z, point.x, point.z,
  ).some(obstacle => pointInsideExpandedObstacle(point, obstacle));
  const indexedSegmentClear = (first, second) => obstacleIndex.query(
    Math.min(first.x, second.x),
    Math.min(first.z, second.z),
    Math.max(first.x, second.x),
    Math.max(first.z, second.z),
  ).every(obstacle => !majorRoadSegmentIntersectsObstacle(first, second, obstacle));
  const longitudinalCount = Math.ceil(length / step);
  const lateralCount = Math.ceil(lateralMarginMeters / step);
  const rowSize = lateralCount * 2 + 1;
  const nodeCount = (longitudinalCount + 1) * rowSize;
  const pointAt = index => {
    const longitudinalIndex = Math.floor(index / rowSize);
    const lateralIndex = index % rowSize - lateralCount;
    const along = longitudinalIndex === longitudinalCount
      ? length : longitudinalIndex * step;
    const lateral = lateralIndex * step;
    return {
      x: q6(start.x + forwardX * along + rightX * lateral),
      z: q6(start.z + forwardZ * along + rightZ * lateral),
    };
  };
  const indexAt = (longitudinalIndex, lateralIndex) => (
    longitudinalIndex * rowSize + lateralIndex + lateralCount
  );
  const startIndex = indexAt(0, 0);
  const endIndex = indexAt(longitudinalCount, 0);
  const blocked = new Int8Array(nodeCount);
  const blockedAt = index => {
    if (index === startIndex || index === endIndex) return false;
    if (blocked[index] !== 0) return blocked[index] > 0;
    const point = pointAt(index);
    const result = indexedPointBlocked(point);
    blocked[index] = result ? 1 : -1;
    return result;
  };
  const scores = new Float64Array(nodeCount);
  scores.fill(Infinity);
  const previous = new Int32Array(nodeCount);
  previous.fill(-1);
  const closed = new Uint8Array(nodeCount);
  const heap = new MinimumHeap();
  scores[startIndex] = 0;
  heap.push({ index: startIndex, g: 0, f: length });
  const neighbors = [
    [1, 0], [1, -1], [1, 1], [0, -1], [0, 1],
    [-1, 0], [-1, -1], [-1, 1],
  ];
  while (heap.values.length) {
    const current = heap.pop();
    if (closed[current.index] || current.g !== scores[current.index]) continue;
    if (current.index === endIndex) break;
    closed[current.index] = 1;
    const longitudinalIndex = Math.floor(current.index / rowSize);
    const lateralIndex = current.index % rowSize - lateralCount;
    const currentPoint = pointAt(current.index);
    for (const [longitudinalDelta, lateralDelta] of neighbors) {
      const nextLongitudinal = longitudinalIndex + longitudinalDelta;
      const nextLateral = lateralIndex + lateralDelta;
      if (nextLongitudinal < 0 || nextLongitudinal > longitudinalCount
        || nextLateral < -lateralCount || nextLateral > lateralCount) continue;
      const nextIndex = indexAt(nextLongitudinal, nextLateral);
      if (closed[nextIndex] || blockedAt(nextIndex)) continue;
      const nextPoint = pointAt(nextIndex);
      if (!indexedSegmentClear(currentPoint, nextPoint)) continue;
      const movement = Math.hypot(nextPoint.x - currentPoint.x, nextPoint.z - currentPoint.z);
      const nextScore = current.g + movement + Math.abs(nextLateral) * 1e-8;
      if (nextScore >= scores[nextIndex]) continue;
      scores[nextIndex] = nextScore;
      previous[nextIndex] = current.index;
      const heuristic = Math.hypot(end.x - nextPoint.x, end.z - nextPoint.z);
      heap.push({ index: nextIndex, g: nextScore, f: nextScore + heuristic });
    }
  }
  if (!Number.isFinite(scores[endIndex])) return null;
  const reversed = [];
  for (let index = endIndex; index >= 0; index = previous[index]) {
    reversed.push(pointAt(index));
    if (index === startIndex) break;
  }
  if (reversed.at(-1)?.x !== start.x || reversed.at(-1)?.z !== start.z) return null;
  const gridPath = reversed.reverse();
  const simplified = [gridPath[0]];
  let cursor = 0;
  while (cursor < gridPath.length - 1) {
    let next = gridPath.length - 1;
    while (next > cursor + 1
      && !indexedSegmentClear(gridPath[cursor], gridPath[next])) next -= 1;
    simplified.push(gridPath[next]);
    cursor = next;
  }
  return simplified;
}

function subdividePath(points) {
  const result = [Object.freeze({ x: q6(points[0].x), z: q6(points[0].z) })];
  const maximumLength = W8_CANONICAL_MAJOR_ROAD.routeGridStepMeters;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const distance = Math.hypot(end.x - start.x, end.z - start.z);
    const count = Math.max(1, Math.ceil(distance / maximumLength));
    for (let step = 1; step <= count; step += 1) {
      const t = step / count;
      result.push(Object.freeze({
        x: q6(start.x + (end.x - start.x) * t),
        z: q6(start.z + (end.z - start.z) * t),
      }));
    }
  }
  return Object.freeze(result);
}

async function createRoad({
  worldSeedHash,
  edge,
  nodesById,
  obstacles,
  localRoads,
  gatewayHandoffs,
  timingObserver,
}) {
  const roadStartedAt = nowMs();
  const endpoints = edge.settlementIds.map(id => nodesById.get(id));
  if (endpoints.some(value => !value)) throw new Error('MAJOR Road edge has an unknown endpoint');
  const settlementCenters = Object.freeze(endpoints.map(endpoint => endpoint.center));
  const contractedHandoffs = endpoints.map((endpoint, index) => (
    resolveSettlementRoadGatewayHandoff({
      handoffs: gatewayHandoffs,
      connectivityEdgeId: edge.stableId,
      settlementId: endpoint.stableId,
    }) ?? (gatewayHandoffs.length > 0
      ? resolveDirectionalSettlementRoadGatewayHandoff({
        handoffs: gatewayHandoffs,
        connectivityEdgeId: edge.stableId,
        settlementId: endpoint.stableId,
        targetSettlementId: endpoints[1 - index].stableId,
        settlementCenter: endpoint.center,
        targetCenter: endpoints[1 - index].center,
      }) : null)
  ));
  if (gatewayHandoffs.length > 0 && contractedHandoffs.some(handoff => handoff === null)) {
    throw new Error(`orphan Settlement road gateway handoff: ${edge.stableId}`);
  }
  const createContractedAccess = (handoff, endpoint) => {
    if (!handoff) return null;
    const dx = handoff.logicalPosition.x - endpoint.center.x;
    const dz = handoff.logicalPosition.z - endpoint.center.z;
    const length = Math.hypot(dx, dz);
    if (length <= 1e-9) {
      throw new Error(`Settlement road gateway handoff equals its center: ${handoff.gatewayStableId}`);
    }
    const portalRadius = endpoint.radiusMeters + W8_CANONICAL_MAJOR_ROAD.widthMeters * 2
      + W8_CANONICAL_MAJOR_ROAD.obstacleClearanceMeters;
    const portal = Object.freeze({
      x: q6(endpoint.center.x + dx / length * portalRadius),
      z: q6(endpoint.center.z + dz / length * portalRadius),
    });
    const sharedGateway = handoff.bindingMode === 'directional-shared-gateway';
    return Object.freeze({
      connection: sharedGateway ? portal : handoff.logicalPosition,
      portal,
      localRoadStableId: sharedGateway ? null : handoff.arterialRoadStableId,
      gatewayHandoff: handoff,
      trimMode: sharedGateway ? 'SHARED_GATEWAY_TRUNK' : 'DIRECT_GATEWAY',
    });
  };
  const startAccess = createContractedAccess(contractedHandoffs[0], endpoints[0])
    ?? selectSettlementTerminal(
      endpoints[0].stableId,
      endpoints[0].center,
      endpoints[1].center,
      endpoints[0].radiusMeters,
      obstacles,
      localRoads,
    );
  const endAccess = createContractedAccess(contractedHandoffs[1], endpoints[1])
    ?? selectSettlementTerminal(
      endpoints[1].stableId,
      endpoints[1].center,
      endpoints[0].center,
      endpoints[1].radiusMeters,
      obstacles,
      localRoads,
    );
  const start = startAccess.portal;
  const end = endAccess.portal;
  const maximumRadius = Math.max(...endpoints.map(value => value.radiusMeters));
  const baseMargin = maximumRadius + W8_CANONICAL_MAJOR_ROAD.widthMeters * 4;
  const relevantObstacles = obstacles.filter(obstacle => (
    pointSegmentDistance({ x: obstacle.centerX, z: obstacle.centerZ }, start, end)
      <= baseMargin * 2 + Math.hypot(obstacle.width, obstacle.depth) / 2
  ));
  let routingStrategy = 'DIRECT';
  let stageStartedAt = nowMs();
  let waypoints = segmentIsClear(start, end, relevantObstacles)
    ? [start, end] : null;
  recordTiming(timingObserver, 'direct-route', stageStartedAt, { edgeId: edge.stableId });
  if (!waypoints) {
    stageStartedAt = nowMs();
    waypoints = routeWithLateralDogleg(start, end, relevantObstacles, baseMargin * 2);
    recordTiming(timingObserver, 'lateral-dogleg', stageStartedAt, { edgeId: edge.stableId });
    if (waypoints) routingStrategy = 'LATERAL_DOGLEG';
  }
  if (!waypoints) {
    routingStrategy = 'GRID_FALLBACK';
    stageStartedAt = nowMs();
    for (const multiplier of [1, 1.5, 2]) {
      waypoints = routeOnGrid(start, end, relevantObstacles, baseMargin * multiplier);
      if (waypoints) break;
    }
    recordTiming(timingObserver, 'grid-route', stageStartedAt, { edgeId: edge.stableId });
  }
  if (!waypoints) throw new Error(`no canonical MAJOR Road route for ${edge.stableId}`);
  waypoints = [startAccess.connection, ...waypoints, endAccess.connection]
    .filter((point, index, values) => index === 0
      || point.x !== values[index - 1].x || point.z !== values[index - 1].z);
  const lastSegmentIndex = waypoints.length - 2;
  if (!waypoints.slice(1).every((point, index) => {
    const first = waypoints[index];
    if (index === 0 && first.x === startAccess.connection.x
      && first.z === startAccess.connection.z
      && (first.x !== startAccess.portal.x || first.z !== startAccess.portal.z)
      && startAccess.gatewayHandoff) {
      return gatewayApproachIsClear(
        first,
        point,
        relevantObstacles,
        startAccess.gatewayHandoff,
      );
    }
    if (index === lastSegmentIndex && point.x === endAccess.connection.x
      && point.z === endAccess.connection.z
      && (point.x !== endAccess.portal.x || point.z !== endAccess.portal.z)
      && endAccess.gatewayHandoff) {
      return gatewayApproachIsClear(
        first,
        point,
        relevantObstacles,
        endAccess.gatewayHandoff,
      );
    }
    return segmentIsClear(first, point, relevantObstacles);
  })) throw new Error(`canonical MAJOR Road intersects an obstacle: ${edge.stableId}`);
  stageStartedAt = nowMs();
  const stableId = `major-road-v1:${(await sha256Hex(canonicalizeJson({
    schemaVersion: W8_CANONICAL_MAJOR_ROAD.schemaVersion,
    worldSeedHash,
    connectivityEdgeId: edge.stableId,
    settlementIds: edge.settlementIds,
    widthMeters: W8_CANONICAL_MAJOR_ROAD.widthMeters,
  }))).slice(0, 24)}`;
  recordTiming(timingObserver, 'road-stable-id', stageStartedAt, { edgeId: edge.stableId });
  stageStartedAt = nowMs();
  const points = subdividePath(waypoints);
  const segments = points.slice(1).map((point, index) => Object.freeze({
    stableId: `${stableId}:segment:${index}`,
    routeOrder: index,
    start: points[index],
    end: point,
  }));
  recordTiming(timingObserver, 'segment-subdivision', stageStartedAt, {
    edgeId: edge.stableId,
    segmentCount: segments.length,
  });
  recordTiming(timingObserver, 'canonical-road', roadStartedAt, {
    edgeId: edge.stableId,
    routingStrategy,
    segmentCount: segments.length,
  });
  return Object.freeze({
    schemaVersion: 'w8-canonical-major-road-1',
    stableId,
    featureType: 'settlement-road',
    roadKind: ROAD_KINDS.MAJOR,
    routingStrategy,
    connectivityEdgeId: edge.stableId,
    settlementIds: edge.settlementIds,
    settlementCenters,
    ownerRegion: edge.ownerRegion,
    widthMeters: W8_CANONICAL_MAJOR_ROAD.widthMeters,
    start: points[0],
    end: points.at(-1),
    terminals: Object.freeze([points[0], points.at(-1)]),
    settlementPortals: Object.freeze([startAccess.portal, endAccess.portal]),
    localRoadHandoffIds: Object.freeze([
      startAccess.localRoadStableId,
      endAccess.localRoadStableId,
    ]),
    ...(contractedHandoffs.every(Boolean) ? {
      gatewayHandoffs: Object.freeze(contractedHandoffs),
      gatewayConnections: Object.freeze([startAccess, endAccess].map(access => Object.freeze({
        gatewayStableId: access.gatewayHandoff.gatewayStableId,
        handoffPosition: access.gatewayHandoff.logicalPosition,
        majorConnectionPosition: access.connection,
        externalPortalPosition: access.portal,
        trimMode: access.trimMode,
        sharedTrunkConnectivityEdgeId: access.trimMode === 'SHARED_GATEWAY_TRUNK'
          ? access.gatewayHandoff.gatewaySourceConnectivityEdgeId : null,
      }))),
    } : {}),
    waypoints: Object.freeze(waypoints.map(point => Object.freeze({
      x: q6(point.x), z: q6(point.z),
    }))),
    points,
    segments: Object.freeze(segments),
    obstacleAudit: Object.freeze({
      buildingCount: relevantObstacles.filter(value => value.kind === 'BUILDING').length,
      lotCount: relevantObstacles.filter(value => value.kind === 'LOT').length,
      landmarkCount: relevantObstacles.filter(value => value.kind === 'LANDMARK').length,
    }),
  });
}

export async function createCanonicalMajorRoadNetwork({
  worldSeedHash,
  graph,
  resolveObstacles,
  timingObserver = null,
} = {}) {
  if (typeof worldSeedHash !== 'string' || !worldSeedHash
    || graph?.schemaVersion !== 'w5-settlement-connectivity-graph-1'
    || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || typeof resolveObstacles !== 'function') {
    throw new TypeError('worldSeedHash, Settlement graph, and obstacle resolver are required');
  }
  const nodesById = new Map(graph.nodes.map(node => [node.stableId, node]));
  const roads = [];
  for (const edge of graph.edges) {
    const obstacleStartedAt = nowMs();
    const resolved = await resolveObstacles({
      edge,
      endpoints: edge.settlementIds.map(id => nodesById.get(id)),
      graph,
    });
    recordTiming(timingObserver, 'obstacle-source', obstacleStartedAt, {
      edgeId: edge.stableId,
    });
    const obstacles = Array.isArray(resolved) ? resolved : resolved?.obstacles;
    const localRoads = Array.isArray(resolved) ? [] : resolved?.localRoads ?? [];
    const gatewayHandoffs = Array.isArray(resolved) ? [] : resolved?.gatewayHandoffs ?? [];
    if (!Array.isArray(obstacles) || !Array.isArray(localRoads)
      || !Array.isArray(gatewayHandoffs)) {
      throw new TypeError('MAJOR Road obstacle resolver returned an invalid result');
    }
    roads.push(await createRoad({
      worldSeedHash,
      edge,
      nodesById,
      obstacles: [...obstacles].sort((left, right) => left.stableId.localeCompare(right.stableId)),
      localRoads: [...localRoads].sort((left, right) => left.stableId.localeCompare(right.stableId)),
      gatewayHandoffs: [...gatewayHandoffs].sort((left, right) => (
        left.connectivityEdgeId.localeCompare(right.connectivityEdgeId)
          || left.gatewayStableId.localeCompare(right.gatewayStableId)
      )),
      timingObserver,
    }));
  }
  roads.sort((left, right) => left.stableId.localeCompare(right.stableId));
  if (roads.length !== graph.edges.length) throw new Error('MAJOR Road count does not match graph');
  return Object.freeze({
    schemaVersion: 'w8-canonical-major-road-network-1',
    graphCenter: graph.center,
    graphRadiusMeters: graph.radiusMeters,
    graphEdgeCount: graph.edges.length,
    roadCount: roads.length,
    roads: Object.freeze(roads),
  });
}

function clipSegment(start, end, bounds) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  let minimumT = 0;
  let maximumT = 1;
  for (const [p, q] of [
    [-dx, start.x - bounds.minX],
    [dx, bounds.maxX - start.x],
    [-dz, start.z - bounds.minZ],
    [dz, bounds.maxZ - start.z],
  ]) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > maximumT) return null;
      minimumT = Math.max(minimumT, t);
    } else {
      if (t < minimumT) return null;
      maximumT = Math.min(maximumT, t);
    }
  }
  if (maximumT - minimumT <= 1e-9) return null;
  return {
    start: {
      x: q6(start.x + dx * minimumT),
      z: q6(start.z + dz * minimumT),
    },
    end: {
      x: q6(start.x + dx * maximumT),
      z: q6(start.z + dz * maximumT),
    },
  };
}

/**
 * Enumerates the canonical 16 m owners that contain a clipped MAJOR Road
 * projected Road record whose clipped midpoint is inside the requested
 * circle. Ownership and distance use the same midpoint rule as
 * projectCanonicalMajorRoadsToChunk(), including exact grid boundaries.
 */
export function enumerateCanonicalMajorRoadOwnerCoordinates({
  roads,
  centerWorldX,
  centerWorldZ,
  radiusMeters,
} = {}) {
  if (!Array.isArray(roads)
    || ![centerWorldX, centerWorldZ, radiusMeters].every(Number.isFinite)
    || radiusMeters < 0) {
    throw new TypeError('roads and a valid canonical MAJOR Road owner query are required');
  }
  const owners = new Map();
  for (const road of roads) {
    if (!Array.isArray(road?.segments)) {
      throw new TypeError('canonical MAJOR Road records require segments');
    }
    for (const segment of road.segments) {
      if (![segment?.start?.x, segment?.start?.z, segment?.end?.x, segment?.end?.z]
        .every(Number.isFinite)) {
        throw new TypeError('canonical MAJOR Road segments require finite endpoints');
      }
      const startOwner = decomposeLogicalWorldPosition(segment.start.x, segment.start.z);
      const endOwner = decomposeLogicalWorldPosition(segment.end.x, segment.end.z);
      const minimumChunkX = Math.min(startOwner.chunkX, endOwner.chunkX) - 1;
      const maximumChunkX = Math.max(startOwner.chunkX, endOwner.chunkX) + 1;
      const minimumChunkZ = Math.min(startOwner.chunkZ, endOwner.chunkZ) - 1;
      const maximumChunkZ = Math.max(startOwner.chunkZ, endOwner.chunkZ) + 1;
      for (let chunkZ = minimumChunkZ; chunkZ <= maximumChunkZ; chunkZ += 1) {
        for (let chunkX = minimumChunkX; chunkX <= maximumChunkX; chunkX += 1) {
          const bounds = {
            minX: chunkX * LOGICAL_CHUNK_SIZE_METERS,
            minZ: chunkZ * LOGICAL_CHUNK_SIZE_METERS,
            maxX: (chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS,
            maxZ: (chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS,
          };
          const clipped = clipSegment(segment.start, segment.end, bounds);
          if (!clipped) continue;
          const midpoint = {
            x: q6((clipped.start.x + clipped.end.x) / 2),
            z: q6((clipped.start.z + clipped.end.z) / 2),
          };
          const midpointOwner = decomposeLogicalWorldPosition(midpoint.x, midpoint.z);
          if (midpointOwner.chunkX !== chunkX || midpointOwner.chunkZ !== chunkZ) continue;
          if (Math.hypot(
            midpoint.x - centerWorldX,
            midpoint.z - centerWorldZ,
          ) > radiusMeters) continue;
          const key = `${chunkX},${chunkZ}`;
          if (!owners.has(key)) owners.set(key, Object.freeze({ key, chunkX, chunkZ }));
        }
      }
    }
  }
  return Object.freeze([...owners.values()].sort((left, right) => (
    left.chunkZ - right.chunkZ || left.chunkX - right.chunkX
  )));
}

export function projectCanonicalMajorRoadsToChunk({
  roads,
  chunkX,
  chunkZ,
  sampleGroundHeight,
} = {}) {
  if (!Array.isArray(roads) || !Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)
    || typeof sampleGroundHeight !== 'function') {
    throw new TypeError('roads, Chunk coordinate, and canonical ground sampler are required');
  }
  const bounds = {
    minX: chunkX * LOGICAL_CHUNK_SIZE_METERS,
    minZ: chunkZ * LOGICAL_CHUNK_SIZE_METERS,
    maxX: (chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS,
    maxZ: (chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS,
  };
  const features = [];
  for (const road of roads) {
    for (const segment of road.segments) {
      const clipped = clipSegment(segment.start, segment.end, bounds);
      if (!clipped) continue;
      const midpoint = {
        x: q6((clipped.start.x + clipped.end.x) / 2),
        z: q6((clipped.start.z + clipped.end.z) / 2),
      };
      const midpointOwner = decomposeLogicalWorldPosition(midpoint.x, midpoint.z);
      if (midpointOwner.chunkX !== chunkX || midpointOwner.chunkZ !== chunkZ) continue;
      const start = Object.freeze({
        ...clipped.start,
        y: q6(sampleGroundHeight(clipped.start.x, clipped.start.z)),
      });
      const end = Object.freeze({
        ...clipped.end,
        y: q6(sampleGroundHeight(clipped.end.x, clipped.end.z)),
      });
      features.push(Object.freeze({
        schemaVersion: 'w8-canonical-major-road-chunk-feature-1',
        stableId: `${segment.stableId}:chunk:${chunkX}:${chunkZ}`,
        sourceStableId: road.stableId,
        sourceSegmentStableId: segment.stableId,
        featureType: 'settlement-road',
        canonicalMajorRoad: true,
        settlementId: road.settlementIds[0],
        settlementIds: road.settlementIds,
        settlementCenters: road.settlementCenters,
        routeTerminals: road.terminals,
        settlementPortals: road.settlementPortals,
        localRoadHandoffIds: road.localRoadHandoffIds,
        ...(road.gatewayHandoffs ? { gatewayHandoffs: road.gatewayHandoffs } : {}),
        ...(road.gatewayConnections ? { gatewayConnections: road.gatewayConnections } : {}),
        connectivityEdgeId: road.connectivityEdgeId,
        canonicalOwnerRegion: road.ownerRegion,
        roadKind: ROAD_KINDS.MAJOR,
        routeId: road.stableId,
        routeOrder: segment.routeOrder,
        widthMeters: road.widthMeters,
        start,
        end,
        worldPosition: Object.freeze({
          ...midpoint,
          y: q6(sampleGroundHeight(midpoint.x, midpoint.z)),
        }),
        owningChunkCoordinate: Object.freeze({ x: chunkX, z: chunkZ }),
      }));
    }
  }
  return Object.freeze(features.sort((left, right) => left.stableId.localeCompare(right.stableId)));
}

export function graphEdgesPotentiallyIntersectChunk({ graph, chunkX, chunkZ } = {}) {
  if (!graph?.nodes || !graph?.edges) return Object.freeze([]);
  const nodesById = new Map(graph.nodes.map(node => [node.stableId, node]));
  const corners = [
    { x: chunkX * LOGICAL_CHUNK_SIZE_METERS, z: chunkZ * LOGICAL_CHUNK_SIZE_METERS },
    { x: (chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS, z: chunkZ * LOGICAL_CHUNK_SIZE_METERS },
    { x: chunkX * LOGICAL_CHUNK_SIZE_METERS, z: (chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS },
    { x: (chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS, z: (chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS },
  ];
  return Object.freeze(graph.edges.filter(edge => {
    const endpoints = edge.settlementIds.map(id => nodesById.get(id));
    if (!endpoints.every(Boolean)) return false;
    const centerDx = endpoints[1].center.x - endpoints[0].center.x;
    const centerDz = endpoints[1].center.z - endpoints[0].center.z;
    const centerDistance = Math.hypot(centerDx, centerDz);
    if (centerDistance <= 1e-9) return false;
    const forwardX = centerDx / centerDistance;
    const forwardZ = centerDz / centerDistance;
    const rightX = forwardZ;
    const rightZ = -forwardX;
    const start = endpoints[0].center;
    const end = endpoints[1].center;
    const routeLength = Math.hypot(end.x - start.x, end.z - start.z);
    if (routeLength <= 1e-9) return false;
    const projections = corners.map(corner => {
      const dx = corner.x - start.x;
      const dz = corner.z - start.z;
      return { along: dx * forwardX + dz * forwardZ, lateral: dx * rightX + dz * rightZ };
    });
    const minimumAlong = Math.min(...projections.map(value => value.along));
    const maximumAlong = Math.max(...projections.map(value => value.along));
    const terminalClearance = W8_CANONICAL_MAJOR_ROAD.widthMeters * 2
      + W8_CANONICAL_MAJOR_ROAD.obstacleClearanceMeters;
    if (maximumAlong < -(endpoints[0].radiusMeters + terminalClearance)
      || minimumAlong > routeLength + endpoints[1].radiusMeters + terminalClearance) return false;
    const maximumLateralOffset = Math.max(...endpoints.map(value => value.radiusMeters)) * 2
      + W8_CANONICAL_MAJOR_ROAD.widthMeters * 8;
    const minimumLateral = Math.min(...projections.map(value => value.lateral));
    const maximumLateral = Math.max(...projections.map(value => value.lateral));
    return minimumLateral <= maximumLateralOffset && maximumLateral >= -maximumLateralOffset;
  }));
}
