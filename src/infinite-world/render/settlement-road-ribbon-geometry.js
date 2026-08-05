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
  return String(left.routeId ?? left.sourceStableId ?? left.stableId).localeCompare(
    String(right.routeId ?? right.sourceStableId ?? right.stableId),
  ) || (Number(left.routeOrder) || 0) - (Number(right.routeOrder) || 0)
    || String(left.stableId).localeCompare(String(right.stableId));
}

function countRoutePolylines(roads) {
  const routes = new Map();
  for (const road of roads) {
    const routeId = String(road.routeId ?? road.sourceStableId ?? road.stableId);
    const entries = routes.get(routeId) ?? [];
    entries.push(road);
    routes.set(routeId, entries);
  }
  let polylineCount = 0;
  for (const routeRoads of routes.values()) {
    const endpoints = new Map();
    for (const road of routeRoads) {
      for (const point of [road.start, road.end]) {
        const key = coordinateKey(point);
        const incident = endpoints.get(key) ?? [];
        incident.push(road);
        endpoints.set(key, incident);
      }
    }
    const visited = new Set();
    const ordered = [...routeRoads].sort(compareRoads);
    for (const road of ordered) {
      if (visited.has(road.stableId)) continue;
      polylineCount += 1;
      const pending = [road];
      while (pending.length) {
        const current = pending.pop();
        if (visited.has(current.stableId)) continue;
        visited.add(current.stableId);
        for (const point of [current.start, current.end]) {
          const neighbors = endpoints.get(coordinateKey(point)) ?? [];
          for (const neighbor of [...neighbors].sort(compareRoads).reverse()) {
            if (!visited.has(neighbor.stableId)) pending.push(neighbor);
          }
        }
      }
    }
  }
  return Object.freeze({ routeCount: routes.size, polylineCount });
}

function hashGeometry(positions, indices) {
  let hash = 0x811c9dc5;
  const update = value => {
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 124;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const value of positions) update(q6(value));
  for (const value of indices) update(value);
  return hash.toString(16).padStart(8, '0');
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

export function buildSettlementRoadRibbonMeshData({
  roads,
  heightAt = () => 0,
  originX = 0,
  originZ = 0,
  unitsPerMeter = 1,
  surfaceOffsetMeters = 0.075,
  miterLimit = DEFAULT_MITER_LIMIT,
  clipBounds = null,
} = {}) {
  if (!Array.isArray(roads) || typeof heightAt !== 'function') {
    throw new TypeError('Road records and a height sampler are required');
  }
  if (!(unitsPerMeter > 0) || !(miterLimit >= 1)) {
    throw new RangeError('Road ribbon scale and miter limit must be positive');
  }
  const sortedRoads = roads.filter(road => road?.featureType === 'settlement-road'
    && Number.isFinite(road?.widthMeters) && road.widthMeters > 0
    && unitDirection(road.start, road.end)).sort(compareRoads);
  const routeStats = countRoutePolylines(sortedRoads);
  const nodes = new Map();
  const edgeEntries = [];
  for (const road of sortedRoads) {
    const direction = unitDirection(road.start, road.end);
    const edge = { road, startIncident: null, endIncident: null };
    for (const endpoint of [
      { point: road.start, direction, side: 'startIncident' },
      { point: road.end, direction: { x: -direction.x, z: -direction.z }, side: 'endIncident' },
    ]) {
      const key = coordinateKey(endpoint.point);
      const node = nodes.get(key) ?? {
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
      nodes.set(key, node);
      edge[endpoint.side] = incident;
    }
    edgeEntries.push(edge);
  }

  let miterJoinCount = 0;
  let bevelJoinCount = 0;
  let junctionCount = 0;
  for (const node of [...nodes.values()].sort((left, right) => left.key.localeCompare(right.key))) {
    node.incidents.sort((left, right) => (
      Math.atan2(left.direction.z, left.direction.x)
        - Math.atan2(right.direction.z, right.direction.x)
      || compareRoads(left.road, right.road)
    ));
    if (node.incidents.length === 1) {
      const [incident] = node.incidents;
      const extension = boundaryExtension(node, incident, clipBounds);
      const sectionCenter = addScaled(node.point, incident.direction, -extension);
      incident.left = addScaled(sectionCenter, incident.normal, incident.halfWidth);
      incident.right = addScaled(sectionCenter, incident.normal, -incident.halfWidth);
      node.boundary = [incident.right, incident.left];
      continue;
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
      junctionCount += 1;
      continue;
    }
    const [firstIncident, secondIncident] = node.incidents;
    const firstAngle = Math.atan2(firstIncident.direction.z, firstIncident.direction.x);
    const secondAngle = Math.atan2(secondIncident.direction.z, secondIncident.direction.x);
    const rawGap = Math.abs(secondAngle - firstAngle);
    const bendGap = Math.min(rawGap, Math.PI * 2 - rawGap);
    if (bendGap < Math.PI - 1e-6
      && 1 / Math.tan(Math.max(1e-6, bendGap) / 2) > miterLimit) {
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
      bevelJoinCount += 1;
      continue;
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
      const maximumMiter = Math.max(current.halfWidth, next.halfWidth) * miterLimit;
      const safeMiter = intersection && Math.hypot(
        intersection.x - node.point.x, intersection.z - node.point.z,
      ) <= maximumMiter + EPSILON;
      if (safeMiter) {
        current.left = intersection;
        next.right = intersection;
        boundary.push(intersection);
        miterJoinCount += 1;
      } else {
        current.left = currentLeft;
        next.right = nextRight;
        boundary.push(currentLeft, nextRight);
        bevelJoinCount += 1;
      }
    }
    node.boundary = boundary.filter((point, index, values) => (
      coordinateKey(point) !== coordinateKey(values[(index + values.length - 1) % values.length])
    )).sort((left, right) => (
      Math.atan2(left.z - node.point.z, left.x - node.point.x)
        - Math.atan2(right.z - node.point.z, right.x - node.point.x)
    ));
  }

  const positions = [];
  const normals = [];
  const indices = [];
  const vertexByPosition = new Map();
  const faceKeys = new Set();
  let degenerateTriangleCount = 0;
  let duplicateFaceCount = 0;
  const vertexIndex = point => {
    const height = q6(heightAt(point.x, point.z) + surfaceOffsetMeters);
    if (!Number.isFinite(height)) throw new Error('Road ribbon height sampler returned a non-finite value');
    const x = q5((point.x - originX) * unitsPerMeter);
    const y = q5(height * unitsPerMeter);
    const z = q5((point.z - originZ) * unitsPerMeter);
    const key = `${x},${y},${z}`;
    const existing = vertexByPosition.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(x, y, z);
    normals.push(0, 1, 0);
    vertexByPosition.set(key, index);
    return index;
  };
  const addTriangle = triangle => {
    const clipped = clipPolygonToBounds(triangle, clipBounds);
    if (clipped.length < 3) return;
    for (let index = 1; index < clipped.length - 1; index += 1) {
      const points = [clipped[0], clipped[index], clipped[index + 1]];
      const signedArea = cross(subtract(points[1], points[0]), subtract(points[2], points[0]));
      if (Math.abs(signedArea) <= EPSILON) {
        degenerateTriangleCount += 1;
        continue;
      }
      if (signedArea > 0) [points[1], points[2]] = [points[2], points[1]];
      const face = points.map(vertexIndex);
      const faceKey = [...face].sort((left, right) => left - right).join(',');
      if (faceKeys.has(faceKey)) {
        duplicateFaceCount += 1;
        continue;
      }
      faceKeys.add(faceKey);
      indices.push(...face);
    }
  };

  for (const edge of edgeEntries) {
    const startLeft = edge.startIncident.left;
    const startRight = edge.startIncident.right;
    const endLeft = edge.endIncident.right;
    const endRight = edge.endIncident.left;
    addTriangle([startLeft, endLeft, startRight]);
    addTriangle([startRight, endLeft, endRight]);
  }
  for (const node of [...nodes.values()].sort((left, right) => left.key.localeCompare(right.key))) {
    if (node.boundary.length < 3) continue;
    for (let index = 0; index < node.boundary.length; index += 1) {
      addTriangle([
        node.point,
        node.boundary[(index + 1) % node.boundary.length],
        node.boundary[index],
      ]);
    }
  }
  const typedPositions = new Float32Array(positions);
  const typedNormals = new Float32Array(normals);
  const typedIndices = new Uint32Array(indices);
  return Object.freeze({
    positions: typedPositions,
    normals: typedNormals,
    indices: typedIndices,
    hash: hashGeometry(typedPositions, typedIndices),
    stats: Object.freeze({
      roadRecordCount: sortedRoads.length,
      routeCount: routeStats.routeCount,
      polylineCount: routeStats.polylineCount,
      nodeCount: nodes.size,
      junctionCount,
      miterJoinCount,
      bevelJoinCount,
      vertexCount: typedPositions.length / 3,
      indexCount: typedIndices.length,
      triangleCount: typedIndices.length / 3,
      duplicateFaceCount,
      degenerateTriangleCount,
      uploadBytes: typedPositions.byteLength + typedNormals.byteLength + typedIndices.byteLength,
    }),
  });
}
