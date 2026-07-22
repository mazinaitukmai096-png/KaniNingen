const TYPES = new Set(['point', 'circle', 'orientedBox', 'capsule', 'polylineWithWidth', 'polygon2D']);
const EPSILON_MM = 1;

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function point(value) {
  return plainObject(value) && Number.isFinite(value.x) && Number.isFinite(value.z);
}

function positive(value, maximum = 32) {
  return Number.isFinite(value) && value > 0 && value <= maximum;
}

export function quantizeMillimeters(value) {
  if (!Number.isFinite(value)) throw new TypeError('coordinate must be finite');
  return Math.round(value * 1000);
}

function orientation(a, b, c) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function onSegment(a, b, p) {
  return Math.abs(orientation(a, b, p)) <= EPSILON_MM
    && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
    && p.z >= Math.min(a.z, b.z) && p.z <= Math.max(a.z, b.z);
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c); const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a); const cdB = orientation(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
    && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function polygonSelfIntersects(vertices) {
  const points = vertices.map(item => ({ x: quantizeMillimeters(item.x), z: quantizeMillimeters(item.z) }));
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]; const b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j += 1) {
      if (j === i || j === (i + 1) % points.length || (j + 1) % points.length === i) continue;
      if (segmentsIntersect(a, b, points[j], points[(j + 1) % points.length])) return true;
    }
  }
  return false;
}

function polygonArea(vertices) {
  const points = vertices.map(item => ({ x: quantizeMillimeters(item.x), z: quantizeMillimeters(item.z) }));
  return Math.abs(points.reduce((sum, item, index) => {
    const next = points[(index + 1) % points.length];
    return sum + item.x * next.z - next.x * item.z;
  }, 0) / 2);
}

export function validateFeatureBounds(bounds) {
  const errors = [];
  if (!plainObject(bounds) || !TYPES.has(bounds?.type)) return { valid: false, errors: ['unsupported bounds type'] };
  if (bounds.type === 'point' && !point(bounds.position)) errors.push('point.position is invalid');
  if (bounds.type === 'circle' && (!point(bounds.center) || !positive(bounds.radius))) errors.push('circle is invalid');
  if (bounds.type === 'orientedBox') {
    if (!point(bounds.center) || !plainObject(bounds.halfExtents)
      || !positive(bounds.halfExtents.x) || !positive(bounds.halfExtents.z)
      || !Number.isFinite(bounds.rotationRadians) || bounds.rotationRadians < -Math.PI || bounds.rotationRadians >= Math.PI) {
      errors.push('orientedBox is invalid');
    }
  }
  if (bounds.type === 'capsule' && (!point(bounds.start) || !point(bounds.end)
    || (bounds.start.x === bounds.end.x && bounds.start.z === bounds.end.z) || !positive(bounds.radius))) errors.push('capsule is invalid');
  if (bounds.type === 'polylineWithWidth') {
    if (!Array.isArray(bounds.points) || bounds.points.length < 2 || bounds.points.length > 64
      || !bounds.points.every(point) || !Array.isArray(bounds.widths)
      || bounds.widths.length !== bounds.points.length || !bounds.widths.every(value => positive(value))) {
      errors.push('polylineWithWidth is invalid');
    } else if (bounds.points.some((item, index) => index > 0
      && item.x === bounds.points[index - 1].x && item.z === bounds.points[index - 1].z)) errors.push('polyline has repeated adjacent points');
  }
  if (bounds.type === 'polygon2D') {
    if (!Array.isArray(bounds.vertices) || bounds.vertices.length < 3 || bounds.vertices.length > 64
      || !bounds.vertices.every(point)) errors.push('polygon2D vertices are invalid');
    else if (polygonArea(bounds.vertices) < 1) errors.push('polygon2D has zero area after millimeter quantization');
    else if (polygonSelfIntersects(bounds.vertices)) errors.push('polygon2D self-intersects');
  }
  return { valid: errors.length === 0, errors };
}

function insideRect(item, rect) {
  return item.x >= rect.minX && item.x <= rect.maxX && item.z >= rect.minZ && item.z <= rect.maxZ;
}

function rectCorners(rect) {
  return [{ x: rect.minX, z: rect.minZ }, { x: rect.maxX, z: rect.minZ },
    { x: rect.maxX, z: rect.maxZ }, { x: rect.minX, z: rect.maxZ }];
}

function pointInPolygon(item, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const a = vertices[i]; const b = vertices[j];
    if (((a.z > item.z) !== (b.z > item.z))
      && item.x < (b.x - a.x) * (item.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function polygonIntersectsRect(vertices, rect) {
  if (vertices.some(item => insideRect(item, rect)) || rectCorners(rect).some(item => pointInPolygon(item, vertices))) return true;
  const corners = rectCorners(rect);
  const quantizedVertices = vertices.map(item => ({ x: quantizeMillimeters(item.x), z: quantizeMillimeters(item.z) }));
  const quantizedCorners = corners.map(item => ({ x: quantizeMillimeters(item.x), z: quantizeMillimeters(item.z) }));
  for (let i = 0; i < vertices.length; i += 1) for (let j = 0; j < corners.length; j += 1) {
    if (segmentsIntersect(quantizedVertices[i], quantizedVertices[(i + 1) % vertices.length], quantizedCorners[j], quantizedCorners[(j + 1) % corners.length])) return true;
  }
  return false;
}

function distanceToSegment(item, a, b) {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((item.x - a.x) * dx + (item.z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(item.x - (a.x + dx * t), item.z - (a.z + dz * t));
}

function thickSegmentIntersectsRect(a, b, radius, rect) {
  if (insideRect(a, rect) || insideRect(b, rect)) return true;
  const corners = rectCorners(rect);
  if (corners.some(item => distanceToSegment(item, a, b) <= radius)) return true;
  const closestA = { x: Math.max(rect.minX, Math.min(rect.maxX, a.x)), z: Math.max(rect.minZ, Math.min(rect.maxZ, a.z)) };
  const closestB = { x: Math.max(rect.minX, Math.min(rect.maxX, b.x)), z: Math.max(rect.minZ, Math.min(rect.maxZ, b.z)) };
  return Math.hypot(a.x - closestA.x, a.z - closestA.z) <= radius || Math.hypot(b.x - closestB.x, b.z - closestB.z) <= radius;
}

export function boundsIntersectsChunk(bounds, chunkBounds) {
  if (!validateFeatureBounds(bounds).valid) return false;
  if (bounds.type === 'point') return insideRect(bounds.position, chunkBounds);
  if (bounds.type === 'circle') return thickSegmentIntersectsRect(bounds.center, bounds.center, bounds.radius, chunkBounds);
  if (bounds.type === 'capsule') return thickSegmentIntersectsRect(bounds.start, bounds.end, bounds.radius, chunkBounds);
  if (bounds.type === 'polylineWithWidth') return bounds.points.some((item, index) => index < bounds.points.length - 1
    && thickSegmentIntersectsRect(item, bounds.points[index + 1], Math.max(bounds.widths[index], bounds.widths[index + 1]) / 2, chunkBounds));
  if (bounds.type === 'polygon2D') return polygonIntersectsRect(bounds.vertices, chunkBounds);
  const c = Math.cos(bounds.rotationRadians); const s = Math.sin(bounds.rotationRadians);
  const vertices = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
    const x = sx * bounds.halfExtents.x; const z = sz * bounds.halfExtents.z;
    return { x: bounds.center.x + x * c - z * s, z: bounds.center.z + x * s + z * c };
  });
  return polygonIntersectsRect(vertices, chunkBounds);
}
