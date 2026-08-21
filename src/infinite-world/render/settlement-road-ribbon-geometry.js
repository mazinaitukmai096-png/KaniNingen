const EPSILON = 1e-9;
const POSITION_QUANTIZATION = 1e6;
const DEFAULT_MITER_LIMIT = 3;

const q6 = value => {
  const rounded = Math.round(value * POSITION_QUANTIZATION) / POSITION_QUANTIZATION;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const q5 = value => {
  const rounded = Math.round(value * 1e5) / 1e5;
  return Object.is(rounded, -0) ? 0 : rounded;
};

// `localeCompare()` initializes the platform collator lazily and can otherwise
// charge several milliseconds to the first Road sort inside a rendered frame.
// Road geometry is imported during boot, so initialize that immutable runtime
// service before any resumable presentation work is admitted.
const compareText = (left, right) => String(left).localeCompare(String(right));
compareText('', '');

const coordinateKey = point => `${q6(point.x)},${q6(point.z)}`;
const cross = (left, right) => left.x * right.z - left.z * right.x;
const subtract = (left, right) => ({ x: left.x - right.x, z: left.z - right.z });
const addScaled = (point, direction, scale) => ({
  x: q6(point.x + direction.x * scale),
  z: q6(point.z + direction.z * scale),
});

function unitDirection(start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  if (!(length > EPSILON)) return null;
  return Object.freeze({ x: dx / length, z: dz / length });
}

function lineIntersection(firstPoint, firstDirection, secondPoint, secondDirection) {
  const denominator = cross(firstDirection, secondDirection);
  if (Math.abs(denominator) <= EPSILON) return null;
  const delta = subtract(secondPoint, firstPoint);
  const distance = cross(delta, secondDirection) / denominator;
  const point = addScaled(firstPoint, firstDirection, distance);
  return Number.isFinite(point.x) && Number.isFinite(point.z) ? point : null;
}

function clipPolygonAgainstBoundary(points, inside, intersection) {
  if (!points.length) return [];
  const output = [];
  let previous = points.at(-1);
  let previousInside = inside(previous);
  for (const current of points) {
    const currentInside = inside(current);
    if (currentInside !== previousInside) output.push(intersection(previous, current));
    if (currentInside) output.push(current);
    previous = current;
    previousInside = currentInside;
  }
  return output;
}

function clipPolygonToBounds(points, bounds) {
  if (!bounds) return points;
  const intersectX = (value, start, end) => {
    const denominator = end.x - start.x;
    const t = Math.abs(denominator) <= EPSILON ? 0 : (value - start.x) / denominator;
    return { x: q6(value), z: q6(start.z + (end.z - start.z) * t) };
  };
  const intersectZ = (value, start, end) => {
    const denominator = end.z - start.z;
    const t = Math.abs(denominator) <= EPSILON ? 0 : (value - start.z) / denominator;
    return { x: q6(start.x + (end.x - start.x) * t), z: q6(value) };
  };
  let clipped = points;
  clipped = clipPolygonAgainstBoundary(
    clipped, point => point.x >= bounds.minX - EPSILON,
    (start, end) => intersectX(bounds.minX, start, end),
  );
  clipped = clipPolygonAgainstBoundary(
    clipped, point => point.x <= bounds.maxX + EPSILON,
    (start, end) => intersectX(bounds.maxX, start, end),
  );
  clipped = clipPolygonAgainstBoundary(
    clipped, point => point.z >= bounds.minZ - EPSILON,
    (start, end) => intersectZ(bounds.minZ, start, end),
  );
  return clipPolygonAgainstBoundary(
    clipped, point => point.z <= bounds.maxZ + EPSILON,
    (start, end) => intersectZ(bounds.maxZ, start, end),
  );
}

function compareRoads(left, right) {
  return compareText(
    left.routeId ?? left.sourceStableId ?? left.stableId,
    right.routeId ?? right.sourceStableId ?? right.stableId,
  ) || (Number(left.routeOrder) || 0) - (Number(right.routeOrder) || 0)
    || compareText(left.stableId, right.stableId);
}

export function createRoadRibbonHeightSampler(roads, sampleEndpointHeight) {
  if (!Array.isArray(roads) || typeof sampleEndpointHeight !== 'function') {
    throw new TypeError('Road records and an endpoint height sampler are required');
  }
  const entries = roads.map(road => {
    const direction = unitDirection(road.start, road.end);
    if (!direction) return null;
    const length = Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z);
    return {
      road,
      direction,
      length,
      startY: sampleEndpointHeight(road, road.start, 'start'),
      endY: sampleEndpointHeight(road, road.end, 'end'),
    };
  }).filter(Boolean).sort((left, right) => compareRoads(left.road, right.road));
  return (worldX, worldZ) => {
    let nearest = null;
    for (const entry of entries) {
      const relativeX = worldX - entry.road.start.x;
      const relativeZ = worldZ - entry.road.start.z;
      const t = Math.max(0, Math.min(1,
        (relativeX * entry.direction.x + relativeZ * entry.direction.z) / entry.length,
      ));
      const centerX = entry.road.start.x + entry.direction.x * entry.length * t;
      const centerZ = entry.road.start.z + entry.direction.z * entry.length * t;
      const distanceSquared = (centerX - worldX) ** 2 + (centerZ - worldZ) ** 2;
      if (!nearest || distanceSquared < nearest.distanceSquared - EPSILON) {
        nearest = { entry, t, distanceSquared };
      }
    }
    if (!nearest) return 0;
    const height = nearest.entry.startY
      + (nearest.entry.endY - nearest.entry.startY) * nearest.t;
    if (!Number.isFinite(height)) throw new Error('Road endpoint height sampler returned a non-finite value');
    return q6(height);
  };
}

function boundaryExtension(node, incident, bounds) {
  if (!bounds) return 0;
  const outward = { x: -incident.direction.x, z: -incident.direction.z };
  let extension = 0;
  const consider = (onBoundary, outwardComponent, normalComponent) => {
    if (!onBoundary || !(outwardComponent > EPSILON)) return;
    extension = Math.max(
      extension,
      incident.halfWidth * Math.abs(normalComponent) / outwardComponent + 1e-6,
    );
  };
  consider(Math.abs(node.point.x - bounds.minX) <= EPSILON, -outward.x, incident.normal.x);
  consider(Math.abs(node.point.x - bounds.maxX) <= EPSILON, outward.x, incident.normal.x);
  consider(Math.abs(node.point.z - bounds.minZ) <= EPSILON, -outward.z, incident.normal.z);
  consider(Math.abs(node.point.z - bounds.maxZ) <= EPSILON, outward.z, incident.normal.z);
  return extension;
}

function validateRoadRibbonOptions({
  roads,
  heightAt,
  unitsPerMeter,
  miterLimit,
}) {
  if (!Array.isArray(roads) || typeof heightAt !== 'function') {
    throw new TypeError('Road records and a height sampler are required');
  }
  if (!(unitsPerMeter > 0) || !(miterLimit >= 1)) {
    throw new RangeError('Road ribbon scale and miter limit must be positive');
  }
}

function addRoadEdge(work, road) {
    const direction = unitDirection(road.start, road.end);
    const edge = { road, startIncident: null, endIncident: null };
    for (const endpoint of [
      { point: road.start, direction, side: 'startIncident' },
      { point: road.end, direction: { x: -direction.x, z: -direction.z }, side: 'endIncident' },
    ]) {
      const key = coordinateKey(endpoint.point);
      const node = work.nodes.get(key) ?? {
        key, point: { x: q6(endpoint.point.x), z: q6(endpoint.point.z) }, incidents: [],
      };
      const incident = {
        edge,
        road,
        direction: endpoint.direction,
        normal: { x: -endpoint.direction.z, z: endpoint.direction.x },
        halfWidth: road.widthMeters / 2,
        left: null,
        right: null,
      };
      node.incidents.push(incident);
      work.nodes.set(key, node);
      edge[endpoint.side] = incident;
    }
    work.edgeEntries.push(edge);
}

function resolveRoadNode(work, node) {
    node.incidents.sort((left, right) => (
      Math.atan2(left.direction.z, left.direction.x)
        - Math.atan2(right.direction.z, right.direction.x)
      || compareRoads(left.road, right.road)
    ));
    if (node.incidents.length === 1) {
      const [incident] = node.incidents;
      const extension = boundaryExtension(node, incident, work.clipBounds);
      const sectionCenter = addScaled(node.point, incident.direction, -extension);
      incident.left = addScaled(sectionCenter, incident.normal, incident.halfWidth);
      incident.right = addScaled(sectionCenter, incident.normal, -incident.halfWidth);
      node.boundary = [incident.right, incident.left];
      return;
    }
    if (node.incidents.length >= 3) {
      let trimDistance = Math.max(...node.incidents.map(incident => incident.halfWidth)) * 1.25;
      for (let index = 0; index < node.incidents.length; index += 1) {
        const current = node.incidents[index];
        const next = node.incidents[(index + 1) % node.incidents.length];
        const currentAngle = Math.atan2(current.direction.z, current.direction.x);
        const nextAngle = Math.atan2(next.direction.z, next.direction.x);
        const gap = ((nextAngle - currentAngle) + Math.PI * 2) % (Math.PI * 2);
        const tangent = Math.tan(Math.max(1e-6, Math.min(Math.PI - 1e-6, gap)) / 2);
        trimDistance = Math.max(
          trimDistance,
          (current.halfWidth + next.halfWidth) / 2 / tangent
            + Math.max(current.halfWidth, next.halfWidth) * 0.25,
        );
      }
      const boundary = [];
      for (const incident of node.incidents) {
        const sectionCenter = addScaled(node.point, incident.direction, trimDistance);
        incident.left = addScaled(sectionCenter, incident.normal, incident.halfWidth);
        incident.right = addScaled(sectionCenter, incident.normal, -incident.halfWidth);
        boundary.push(incident.right, incident.left);
      }
      node.boundary = boundary.sort((left, right) => (
        Math.atan2(left.z - node.point.z, left.x - node.point.x)
          - Math.atan2(right.z - node.point.z, right.x - node.point.x)
      ));
      work.junctionCount += 1;
      return;
    }
    const [firstIncident, secondIncident] = node.incidents;
    const firstAngle = Math.atan2(firstIncident.direction.z, firstIncident.direction.x);
    const secondAngle = Math.atan2(secondIncident.direction.z, secondIncident.direction.x);
    const rawGap = Math.abs(secondAngle - firstAngle);
    const bendGap = Math.min(rawGap, Math.PI * 2 - rawGap);
    if (bendGap < Math.PI - 1e-6
      && 1 / Math.tan(Math.max(1e-6, bendGap) / 2) > work.miterLimit) {
      const trimDistance = (firstIncident.halfWidth + secondIncident.halfWidth)
        / 2 / Math.tan(bendGap / 2)
        + Math.max(firstIncident.halfWidth, secondIncident.halfWidth) * 0.25;
      const boundary = [];
      for (const incident of node.incidents) {
        const sectionCenter = addScaled(node.point, incident.direction, trimDistance);
        incident.left = addScaled(sectionCenter, incident.normal, incident.halfWidth);
        incident.right = addScaled(sectionCenter, incident.normal, -incident.halfWidth);
        boundary.push(incident.right, incident.left);
      }
      node.boundary = boundary.sort((left, right) => (
        Math.atan2(left.z - node.point.z, left.x - node.point.x)
          - Math.atan2(right.z - node.point.z, right.x - node.point.x)
      ));
      work.bevelJoinCount += 1;
      return;
    }
    const boundary = [];
    for (let index = 0; index < node.incidents.length; index += 1) {
      const current = node.incidents[index];
      const next = node.incidents[(index + 1) % node.incidents.length];
      const currentLeft = addScaled(node.point, current.normal, current.halfWidth);
      const nextRight = addScaled(node.point, next.normal, -next.halfWidth);
      const intersection = lineIntersection(
        currentLeft, current.direction, nextRight, next.direction,
      );
      const maximumMiter = Math.max(current.halfWidth, next.halfWidth) * work.miterLimit;
      const safeMiter = intersection && Math.hypot(
        intersection.x - node.point.x, intersection.z - node.point.z,
      ) <= maximumMiter + EPSILON;
      if (safeMiter) {
        current.left = intersection;
        next.right = intersection;
        boundary.push(intersection);
        work.miterJoinCount += 1;
      } else {
        current.left = currentLeft;
        next.right = nextRight;
        boundary.push(currentLeft, nextRight);
        work.bevelJoinCount += 1;
      }
    }
    node.boundary = boundary.filter((point, index, values) => (
      coordinateKey(point) !== coordinateKey(values[(index + values.length - 1) % values.length])
    )).sort((left, right) => (
      Math.atan2(left.z - node.point.z, left.x - node.point.x)
        - Math.atan2(right.z - node.point.z, right.x - node.point.x)
    ));
}

function roadVertexIndex(work, point) {
    const height = q6(work.heightAt(point.x, point.z) + work.surfaceOffsetMeters);
    if (!Number.isFinite(height)) throw new Error('Road ribbon height sampler returned a non-finite value');
    const x = q5((point.x - work.originX) * work.unitsPerMeter);
    const y = q5(height * work.unitsPerMeter);
    const z = q5((point.z - work.originZ) * work.unitsPerMeter);
    const key = `${x},${y},${z}`;
    const existing = work.vertexByPosition.get(key);
    if (existing !== undefined) return existing;
    const index = work.positions.length / 3;
    work.positions.push(x, y, z);
    work.normals.push(0, 1, 0);
    work.vertexByPosition.set(key, index);
    return index;
}

function addRoadTriangle(work, triangle) {
    const clipped = clipPolygonToBounds(triangle, work.clipBounds);
    if (clipped.length < 3) return;
    for (let index = 1; index < clipped.length - 1; index += 1) {
      const points = [clipped[0], clipped[index], clipped[index + 1]];
      const signedArea = cross(subtract(points[1], points[0]), subtract(points[2], points[0]));
      if (Math.abs(signedArea) <= EPSILON) {
        work.degenerateTriangleCount += 1;
        continue;
      }
      if (signedArea > 0) [points[1], points[2]] = [points[2], points[1]];
      const face = points.map(point => roadVertexIndex(work, point));
      const faceKey = [...face].sort((left, right) => left - right).join(',');
      if (work.faceKeys.has(faceKey)) {
        work.duplicateFaceCount += 1;
        continue;
      }
      work.faceKeys.add(faceKey);
      work.indices.push(...face);
    }
}

function updateGeometryHash(work, value) {
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    work.hashValue ^= text.charCodeAt(index);
    work.hashValue = Math.imul(work.hashValue, 0x01000193) >>> 0;
  }
  work.hashValue ^= 124;
  work.hashValue = Math.imul(work.hashValue, 0x01000193) >>> 0;
}

/**
 * Creates deterministic, resumable work for one canonical Road ribbon.
 * Each call to advanceSettlementRoadRibbonMeshWork performs bounded cursor work;
 * no partial typed geometry is exposed before the final phase completes.
 */
export function createSettlementRoadRibbonMeshWork({
  roads,
  heightAt = () => 0,
  originX = 0,
  originZ = 0,
  unitsPerMeter = 1,
  surfaceOffsetMeters = 0.075,
  miterLimit = DEFAULT_MITER_LIMIT,
  clipBounds = null,
} = {}) {
  validateRoadRibbonOptions({ roads, heightAt, unitsPerMeter, miterLimit });
  return {
    roads,
    heightAt,
    originX,
    originZ,
    unitsPerMeter,
    surfaceOffsetMeters,
    miterLimit,
    clipBounds,
    stage: 'filter',
    sourceIndex: 0,
    sortedRoads: [],
    sortSource: null,
    sortTarget: null,
    sortWidth: 1,
    sortLeft: 0,
    sortMiddle: 0,
    sortRight: 0,
    sortSourceLeft: 0,
    sortSourceRight: 0,
    sortTargetIndex: 0,
    routeStats: null,
    routeGroups: new Map(),
    routeIndex: 0,
    nodes: new Map(),
    nodeEntries: null,
    nodeIndex: 0,
    edgeEntries: [],
    edgeIndex: 0,
    edgeTriangleIndex: 0,
    nodeFaceIndex: 0,
    boundaryIndex: 0,
    positions: [],
    normals: [],
    indices: [],
    vertexByPosition: new Map(),
    faceKeys: new Set(),
    miterJoinCount: 0,
    bevelJoinCount: 0,
    junctionCount: 0,
    degenerateTriangleCount: 0,
    duplicateFaceCount: 0,
    typedPositions: null,
    typedNormals: null,
    typedIndices: null,
    copyIndex: 0,
    hashValue: 0x811c9dc5,
    hashIndex: 0,
    result: null,
    done: false,
  };
}

const ROAD_RIBBON_COPY_VALUES_PER_UNIT = 512;
const ROAD_RIBBON_HASH_VALUES_PER_UNIT = 128;

function advanceRoadRibbonUnit(work) {
  switch (work.stage) {
    case 'filter': {
      const road = work.roads[work.sourceIndex];
      work.sourceIndex += 1;
      if (road?.featureType === 'settlement-road'
        && Number.isFinite(road?.widthMeters) && road.widthMeters > 0
        && unitDirection(road.start, road.end)) {
        work.sortedRoads.push(road);
      }
      if (work.sourceIndex >= work.roads.length) {
        work.sortSource = work.sortedRoads;
        work.sortTarget = new Array(work.sortedRoads.length);
        work.sortLeft = 0;
        work.sortMiddle = Math.min(work.sortWidth, work.sortedRoads.length);
        work.sortRight = Math.min(work.sortWidth * 2, work.sortedRoads.length);
        work.sortSourceLeft = work.sortLeft;
        work.sortSourceRight = work.sortMiddle;
        work.sortTargetIndex = work.sortLeft;
        work.stage = 'sort';
      }
      return;
    }
    case 'sort': {
      if (work.sortSource.length < 2 || work.sortWidth >= work.sortSource.length) {
        work.sortedRoads = work.sortSource;
        work.routeIndex = 0;
        work.stage = 'route-stats';
        return;
      }
      if (work.sortTargetIndex < work.sortRight) {
        const takeLeft = work.sortSourceLeft < work.sortMiddle && (
          work.sortSourceRight >= work.sortRight
            || compareRoads(
              work.sortSource[work.sortSourceLeft],
              work.sortSource[work.sortSourceRight],
            ) <= 0
        );
        work.sortTarget[work.sortTargetIndex] = takeLeft
          ? work.sortSource[work.sortSourceLeft++]
          : work.sortSource[work.sortSourceRight++];
        work.sortTargetIndex += 1;
        return;
      }
      work.sortLeft += work.sortWidth * 2;
      if (work.sortLeft >= work.sortSource.length) {
        const previousSource = work.sortSource;
        work.sortSource = work.sortTarget;
        work.sortTarget = previousSource;
        work.sortWidth *= 2;
        work.sortLeft = 0;
      }
      work.sortMiddle = Math.min(work.sortLeft + work.sortWidth, work.sortSource.length);
      work.sortRight = Math.min(work.sortLeft + work.sortWidth * 2, work.sortSource.length);
      work.sortSourceLeft = work.sortLeft;
      work.sortSourceRight = work.sortMiddle;
      work.sortTargetIndex = work.sortLeft;
      return;
    }
    case 'route-stats': {
      const road = work.sortedRoads[work.routeIndex];
      if (road) {
        const routeId = String(road.routeId ?? road.sourceStableId ?? road.stableId);
        const route = work.routeGroups.get(routeId) ?? {
          parent: [],
          endpoints: new Map(),
          components: 0,
        };
        const roadIndex = route.parent.length;
        route.parent.push(roadIndex);
        route.components += 1;
        const findRoot = value => {
          let root = value;
          while (route.parent[root] !== root) root = route.parent[root];
          while (route.parent[value] !== value) {
            const parent = route.parent[value];
            route.parent[value] = root;
            value = parent;
          }
          return root;
        };
        for (const point of [road.start, road.end]) {
          const key = coordinateKey(point);
          const incident = route.endpoints.get(key) ?? [];
          for (const neighborIndex of incident) {
            const leftRoot = findRoot(roadIndex);
            const rightRoot = findRoot(neighborIndex);
            if (leftRoot !== rightRoot) {
              route.parent[rightRoot] = leftRoot;
              route.components -= 1;
            }
          }
          incident.push(roadIndex);
          route.endpoints.set(key, incident);
        }
        work.routeGroups.set(routeId, route);
      }
      work.routeIndex += 1;
      if (work.routeIndex >= work.sortedRoads.length) {
        work.routeStats = Object.freeze({
          routeCount: work.routeGroups.size,
          polylineCount: [...work.routeGroups.values()]
            .reduce((total, route) => total + route.components, 0),
        });
        work.edgeIndex = 0;
        work.stage = 'edges';
      }
      return;
    }
    case 'edges': {
      const road = work.sortedRoads[work.edgeIndex];
      if (road) addRoadEdge(work, road);
      work.edgeIndex += 1;
      if (work.edgeIndex >= work.sortedRoads.length) {
        work.nodeEntries = [...work.nodes.values()]
          .sort((left, right) => left.key.localeCompare(right.key));
        work.nodeIndex = 0;
        work.stage = 'joins';
      }
      return;
    }
    case 'joins': {
      const node = work.nodeEntries[work.nodeIndex];
      if (node) resolveRoadNode(work, node);
      work.nodeIndex += 1;
      if (work.nodeIndex >= work.nodeEntries.length) {
        work.edgeIndex = 0;
        work.edgeTriangleIndex = 0;
        work.stage = 'edge-faces';
      }
      return;
    }
    case 'edge-faces': {
      const edge = work.edgeEntries[work.edgeIndex];
      if (edge) {
        const startLeft = edge.startIncident.left;
        const startRight = edge.startIncident.right;
        const endLeft = edge.endIncident.right;
        const endRight = edge.endIncident.left;
        addRoadTriangle(work, work.edgeTriangleIndex === 0
          ? [startLeft, endLeft, startRight]
          : [startRight, endLeft, endRight]);
        work.edgeTriangleIndex += 1;
        if (work.edgeTriangleIndex >= 2) {
          work.edgeTriangleIndex = 0;
          work.edgeIndex += 1;
        }
      } else {
        work.edgeIndex += 1;
      }
      if (work.edgeIndex >= work.edgeEntries.length) {
        work.nodeFaceIndex = 0;
        work.boundaryIndex = 0;
        work.stage = 'node-faces';
      }
      return;
    }
    case 'node-faces': {
      const node = work.nodeEntries[work.nodeFaceIndex];
      if (!node) {
        work.nodeFaceIndex += 1;
        work.boundaryIndex = 0;
      } else if (node.boundary.length < 3 || work.boundaryIndex >= node.boundary.length) {
        work.nodeFaceIndex += 1;
        work.boundaryIndex = 0;
      } else {
        addRoadTriangle(work, [
          node.point,
          node.boundary[(work.boundaryIndex + 1) % node.boundary.length],
          node.boundary[work.boundaryIndex],
        ]);
        work.boundaryIndex += 1;
      }
      if (work.nodeFaceIndex >= work.nodeEntries.length) work.stage = 'allocate';
      return;
    }
    case 'allocate':
      work.typedPositions = new Float32Array(work.positions.length);
      work.typedNormals = new Float32Array(work.normals.length);
      work.typedIndices = new Uint32Array(work.indices.length);
      work.copyIndex = 0;
      work.stage = 'copy-positions';
      return;
    case 'copy-positions': {
      const end = Math.min(work.positions.length, work.copyIndex + ROAD_RIBBON_COPY_VALUES_PER_UNIT);
      for (let index = work.copyIndex; index < end; index += 1) {
        work.typedPositions[index] = work.positions[index];
      }
      work.copyIndex = end;
      if (work.copyIndex >= work.positions.length) {
        work.copyIndex = 0;
        work.stage = 'copy-normals';
      }
      return;
    }
    case 'copy-normals': {
      const end = Math.min(work.normals.length, work.copyIndex + ROAD_RIBBON_COPY_VALUES_PER_UNIT);
      for (let index = work.copyIndex; index < end; index += 1) {
        work.typedNormals[index] = work.normals[index];
      }
      work.copyIndex = end;
      if (work.copyIndex >= work.normals.length) {
        work.copyIndex = 0;
        work.stage = 'copy-indices';
      }
      return;
    }
    case 'copy-indices': {
      const end = Math.min(work.indices.length, work.copyIndex + ROAD_RIBBON_COPY_VALUES_PER_UNIT);
      for (let index = work.copyIndex; index < end; index += 1) {
        work.typedIndices[index] = work.indices[index];
      }
      work.copyIndex = end;
      if (work.copyIndex >= work.indices.length) {
        work.hashIndex = 0;
        work.stage = 'hash-positions';
      }
      return;
    }
    case 'hash-positions': {
      const end = Math.min(
        work.typedPositions.length,
        work.hashIndex + ROAD_RIBBON_HASH_VALUES_PER_UNIT,
      );
      for (let index = work.hashIndex; index < end; index += 1) {
        updateGeometryHash(work, q6(work.typedPositions[index]));
      }
      work.hashIndex = end;
      if (work.hashIndex >= work.typedPositions.length) {
        work.hashIndex = 0;
        work.stage = 'hash-indices';
      }
      return;
    }
    case 'hash-indices': {
      const end = Math.min(
        work.typedIndices.length,
        work.hashIndex + ROAD_RIBBON_HASH_VALUES_PER_UNIT,
      );
      for (let index = work.hashIndex; index < end; index += 1) {
        updateGeometryHash(work, work.typedIndices[index]);
      }
      work.hashIndex = end;
      if (work.hashIndex >= work.typedIndices.length) work.stage = 'finalize';
      return;
    }
    case 'finalize': {
      const typedPositions = work.typedPositions;
      const typedNormals = work.typedNormals;
      const typedIndices = work.typedIndices;
      work.result = Object.freeze({
        positions: typedPositions,
        normals: typedNormals,
        indices: typedIndices,
        hash: work.hashValue.toString(16).padStart(8, '0'),
        stats: Object.freeze({
          roadRecordCount: work.sortedRoads.length,
          routeCount: work.routeStats.routeCount,
          polylineCount: work.routeStats.polylineCount,
          nodeCount: work.nodes.size,
          junctionCount: work.junctionCount,
          miterJoinCount: work.miterJoinCount,
          bevelJoinCount: work.bevelJoinCount,
          vertexCount: typedPositions.length / 3,
          indexCount: typedIndices.length,
          triangleCount: typedIndices.length / 3,
          duplicateFaceCount: work.duplicateFaceCount,
          degenerateTriangleCount: work.degenerateTriangleCount,
          uploadBytes: typedPositions.byteLength + typedNormals.byteLength
            + typedIndices.byteLength,
        }),
      });
      work.done = true;
      work.stage = 'done';
      return;
    }
    default:
      return;
  }
}

export function advanceSettlementRoadRibbonMeshWork(work, { unitLimit = 1 } = {}) {
  if (!work || typeof work !== 'object') throw new TypeError('Road ribbon work is required');
  if (!Number.isSafeInteger(unitLimit) || unitLimit < 1) {
    throw new RangeError('Road ribbon unit limit must be a positive safe integer');
  }
  let units = 0;
  while (!work.done && units < unitLimit) {
    advanceRoadRibbonUnit(work);
    units += 1;
  }
  return Object.freeze({
    done: work.done,
    stage: work.stage,
    units,
    result: work.result,
  });
}

export function buildSettlementRoadRibbonMeshData(options = {}) {
  const work = createSettlementRoadRibbonMeshWork(options);
  while (!work.done) {
    advanceSettlementRoadRibbonMeshWork(work, { unitLimit: 1_024 });
  }
  return work.result;
}
