import { boundsIntersectsChunk, quantizeMillimeters, validateFeatureBounds } from '../g1/feature-bounds.js';
import { getChunkWorldBounds } from './world-chunk-generator.js';

const TYPES = Object.freeze(['point', 'circle', 'orientedBox', 'capsule', 'polylineWithWidth', 'polygon2D']);

function expand(bounds, point, radius = 0) {
  bounds.minX = Math.min(bounds.minX, point.x - radius); bounds.maxX = Math.max(bounds.maxX, point.x + radius);
  bounds.minZ = Math.min(bounds.minZ, point.z - radius); bounds.maxZ = Math.max(bounds.maxZ, point.z + radius);
}

function orientedBoxVertices(geometry) {
  const c = Math.cos(geometry.rotationRadians); const s = Math.sin(geometry.rotationRadians);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
    const x = sx * geometry.halfExtents.x; const z = sz * geometry.halfExtents.z;
    return { x: geometry.center.x + x * c - z * s, z: geometry.center.z + x * s + z * c };
  });
}

export function validateWorldFeatureGeometry(geometry) {
  return validateFeatureBounds(geometry);
}

export function getFeatureWorldBounds(featureOrGeometry) {
  const geometry = featureOrGeometry?.geometry ?? featureOrGeometry;
  const validation = validateWorldFeatureGeometry(geometry);
  if (!validation.valid) throw new TypeError(`invalid WorldFeatureGeometry: ${validation.errors.join(', ')}`);
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  if (geometry.type === 'point') expand(bounds, geometry.position);
  if (geometry.type === 'circle') expand(bounds, geometry.center, geometry.radius);
  if (geometry.type === 'orientedBox') orientedBoxVertices(geometry).forEach(point => expand(bounds, point));
  if (geometry.type === 'capsule') [geometry.start, geometry.end].forEach(point => expand(bounds, point, geometry.radius));
  if (geometry.type === 'polylineWithWidth') geometry.points.forEach((point, index) => expand(bounds, point, geometry.widths[index] / 2));
  if (geometry.type === 'polygon2D') geometry.vertices.forEach(point => expand(bounds, point));
  return Object.freeze(Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, quantizeMillimeters(value) / 1000])));
}

function firstCandidate(value, chunkSize) {
  const quotient = value / chunkSize; const floor = Math.floor(quotient);
  return Number.isInteger(quotient) ? floor - 1 : floor;
}

function inside(item, bounds) {
  return item.x >= bounds.minX && item.x <= bounds.maxX && item.z >= bounds.minZ && item.z <= bounds.maxZ;
}

function distanceToSegment(item, a, b) {
  const dx = b.x - a.x; const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((item.x - a.x) * dx + (item.z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(item.x - a.x - dx * t, item.z - a.z - dz * t);
}

function segmentIntersectsRect(a, b, bounds) {
  if (inside(a, bounds) || inside(b, bounds)) return true;
  const dx = b.x - a.x; const dz = b.z - a.z; let t0 = 0; let t1 = 1;
  for (const [p, r] of [[-dx, a.x - bounds.minX], [dx, bounds.maxX - a.x], [-dz, a.z - bounds.minZ], [dz, bounds.maxZ - a.z]]) {
    if (Math.abs(p) < 1e-12) { if (r < 0) return false; continue; }
    const t = r / p;
    if (p < 0) { if (t > t1) return false; t0 = Math.max(t0, t); } else { if (t < t0) return false; t1 = Math.min(t1, t); }
  }
  return true;
}

function thickSegmentIntersectsRect(a, b, radius, bounds) {
  if (segmentIntersectsRect(a, b, bounds)) return true;
  const closest = item => ({ x: Math.max(bounds.minX, Math.min(bounds.maxX, item.x)), z: Math.max(bounds.minZ, Math.min(bounds.maxZ, item.z)) });
  if ([a, b].some(item => Math.hypot(item.x - closest(item).x, item.z - closest(item).z) <= radius)) return true;
  return [{ x: bounds.minX, z: bounds.minZ }, { x: bounds.maxX, z: bounds.minZ },
    { x: bounds.maxX, z: bounds.maxZ }, { x: bounds.minX, z: bounds.maxZ }].some(item => distanceToSegment(item, a, b) <= radius);
}

function worldGeometryIntersectsChunk(geometry, bounds) {
  if (geometry.type === 'capsule') return thickSegmentIntersectsRect(geometry.start, geometry.end, geometry.radius, bounds);
  if (geometry.type === 'polylineWithWidth') return geometry.points.some((item, index) => index < geometry.points.length - 1
    && thickSegmentIntersectsRect(item, geometry.points[index + 1], Math.max(geometry.widths[index], geometry.widths[index + 1]) / 2, bounds));
  return boundsIntersectsChunk(geometry, bounds);
}

export function getIntersectingChunkCoordinates(feature, chunkSize = 16) {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new TypeError('chunkSize must be positive');
  const geometry = feature?.geometry ?? feature; const bounds = getFeatureWorldBounds(geometry);
  const minX = firstCandidate(bounds.minX, chunkSize); const maxX = Math.floor(bounds.maxX / chunkSize);
  const minZ = firstCandidate(bounds.minZ, chunkSize); const maxZ = Math.floor(bounds.maxZ / chunkSize);
  if ((maxX - minX + 1) * (maxZ - minZ + 1) > 4096) throw new RangeError('Feature intersects too many candidate Chunks');
  const coordinates = [];
  for (let z = minZ; z <= maxZ; z += 1) for (let x = minX; x <= maxX; x += 1) {
    if (worldGeometryIntersectsChunk(geometry, getChunkWorldBounds({ x, z }, chunkSize))) coordinates.push({ x, z });
  }
  return coordinates;
}

export const WORLD_FEATURE_GEOMETRY_TYPES = TYPES;
