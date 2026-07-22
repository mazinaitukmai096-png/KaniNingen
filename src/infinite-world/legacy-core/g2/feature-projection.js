import { canonicalizeJson } from '../g0/canonical-json.js';
import { sha256Hex } from '../g0/sha256.js';
import { createFeaturePortIdentity } from '../g1/feature-port.js';
import { validateFeatureBounds } from '../g1/feature-bounds.js';
import { EDGE_DEFINITIONS } from './terrain-edge.js';
import { getChunkWorldBounds } from './world-chunk-generator.js';
import { getIntersectingChunkCoordinates, validateWorldFeatureGeometry } from './world-feature-geometry.js';

const EPSILON = 0.001;
const q = value => Math.round(value * 1000) / 1000;
const point = value => ({ x: q(value.x), z: q(value.z) });
const local = (value, bounds) => point({ x: value.x - bounds.minX, z: value.z - bounds.minZ });

function translateGeometry(geometry, bounds) {
  const shift = item => local(item, bounds);
  if (geometry.type === 'point') return { ...geometry, position: shift(geometry.position) };
  if (geometry.type === 'circle') return { ...geometry, center: shift(geometry.center) };
  if (geometry.type === 'orientedBox') return { ...geometry, center: shift(geometry.center) };
  if (geometry.type === 'capsule') return { ...geometry, start: shift(geometry.start), end: shift(geometry.end) };
  if (geometry.type === 'polygon2D') return { ...geometry, vertices: geometry.vertices.map(shift) };
  return { ...geometry, points: geometry.points.map(shift) };
}

function clipSegment(a, b, bounds) {
  const dx = b.x - a.x; const dz = b.z - a.z; let t0 = 0; let t1 = 1;
  for (const [p, r] of [[-dx, a.x - bounds.minX], [dx, bounds.maxX - a.x], [-dz, a.z - bounds.minZ], [dz, bounds.maxZ - a.z]]) {
    if (Math.abs(p) < 1e-12) { if (r < 0) return null; continue; }
    const t = r / p;
    if (p < 0) { if (t > t1) return null; t0 = Math.max(t0, t); } else { if (t < t0) return null; t1 = Math.min(t1, t); }
  }
  return { start: point({ x: a.x + dx * t0, z: a.z + dz * t0 }), end: point({ x: a.x + dx * t1, z: a.z + dz * t1 }), t0, t1 };
}

function edgesAt(item, bounds) {
  const edges = [];
  if (Math.abs(item.x - bounds.minX) <= EPSILON) edges.push('west');
  if (Math.abs(item.x - bounds.maxX) <= EPSILON) edges.push('east');
  if (Math.abs(item.z - bounds.minZ) <= EPSILON) edges.push('north');
  if (Math.abs(item.z - bounds.maxZ) <= EPSILON) edges.push('south');
  return edges;
}

async function createPort(feature, worldPoint, width, edge, bounds, input) {
  const definition = EDGE_DEFINITIONS[edge]; const crossingKey = `feature-boundary-v1:${q(worldPoint.x)}:${q(worldPoint.z)}`;
  const identity = await createFeaturePortIdentity({ worldSeedHash: input.worldSeedHash, generatorMajor: input.generatorMajor,
    featureId: feature.stableId, semanticType: 'feature-continuation', boundaryAxis: definition.axis,
    quantizedWorldBoundary: Math.round(worldPoint[definition.axis] * 1000), semanticCrossingKey: crossingKey });
  return { schemaVersion: 'feature-port-1', ...identity, featureId: feature.stableId, edge,
    position: local(worldPoint, bounds), direction: { ...definition.direction }, width: q(width), elevation: q(input.elevation ?? 0),
    semanticType: 'feature-continuation' };
}

export async function projectPolylineToChunk(feature, chunkCoordinate, input = {}) {
  const geometry = feature.geometry; const bounds = getChunkWorldBounds(chunkCoordinate, input.chunkSize ?? 16);
  const parts = []; const ports = [];
  for (let index = 0; index < geometry.points.length - 1; index += 1) {
    const clipped = clipSegment(geometry.points[index], geometry.points[index + 1], bounds); if (!clipped) continue;
    const w0 = geometry.widths[index] + (geometry.widths[index + 1] - geometry.widths[index]) * clipped.t0;
    const w1 = geometry.widths[index] + (geometry.widths[index + 1] - geometry.widths[index]) * clipped.t1;
    const previous = parts.at(-1);
    if (previous && canonicalizeJson(previous.points.at(-1)) === canonicalizeJson(local(clipped.start, bounds))) {
      previous.points.push(local(clipped.end, bounds)); previous.widths.push(q(w1));
    } else parts.push({ type: 'polylineWithWidth', points: [local(clipped.start, bounds), local(clipped.end, bounds)], widths: [q(w0), q(w1)] });
    const candidates = [{ item: clipped.start, t: clipped.t0, width: w0 }, { item: clipped.end, t: clipped.t1, width: w1 }];
    for (const candidate of candidates) {
      const isWorldStart = index === 0 && candidate.t <= 1e-9; const isWorldEnd = index === geometry.points.length - 2 && candidate.t >= 1 - 1e-9;
      for (const edge of edgesAt(candidate.item, bounds)) if (!isWorldStart && !isWorldEnd
        && !ports.some(port => port.edge === edge && canonicalizeJson(port.position) === canonicalizeJson(local(candidate.item, bounds)))) {
        ports.push(await createPort(feature, candidate.item, candidate.width, edge, bounds, input));
      }
    }
  }
  if (!parts.length) {
    const margin = Math.max(...geometry.widths) / 2;
    const expanded = { minX: bounds.minX - margin, minZ: bounds.minZ - margin, maxX: bounds.maxX + margin, maxZ: bounds.maxZ + margin };
    for (let index = 0; index < geometry.points.length - 1; index += 1) {
      const clipped = clipSegment(geometry.points[index], geometry.points[index + 1], expanded); if (!clipped) continue;
      const w0 = geometry.widths[index] + (geometry.widths[index + 1] - geometry.widths[index]) * clipped.t0;
      const w1 = geometry.widths[index] + (geometry.widths[index + 1] - geometry.widths[index]) * clipped.t1;
      parts.push({ type: 'polylineWithWidth', points: [local(clipped.start, bounds), local(clipped.end, bounds)], widths: [q(w0), q(w1)] });
    }
  }
  return { localBounds: parts, ports };
}

function intersect(a, b, axis, value) {
  const t = (value - a[axis]) / (b[axis] - a[axis]);
  return point({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
}

function clipPolygon(vertices, bounds) {
  let output = vertices.map(point);
  for (const [axis, value, keepGreater] of [['x', bounds.minX, true], ['x', bounds.maxX, false], ['z', bounds.minZ, true], ['z', bounds.maxZ, false]]) {
    const input = output; output = []; if (!input.length) break;
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index]; const previous = input[(index + input.length - 1) % input.length];
      const currentInside = keepGreater ? current[axis] >= value - 1e-9 : current[axis] <= value + 1e-9;
      const previousInside = keepGreater ? previous[axis] >= value - 1e-9 : previous[axis] <= value + 1e-9;
      if (currentInside !== previousInside) output.push(intersect(previous, current, axis, value));
      if (currentInside) output.push(current);
    }
  }
  return output;
}

export function projectPolygonToChunk(feature, chunkCoordinate, input = {}) {
  const bounds = getChunkWorldBounds(chunkCoordinate, input.chunkSize ?? 16); const vertices = clipPolygon(feature.geometry.vertices, bounds);
  return { localBounds: vertices.length >= 3
    ? [{ type: 'polygon2D', vertices: vertices.map(item => local(item, bounds)) }]
    : [translateGeometry(feature.geometry, bounds)], ports: [] };
}

export async function projectWorldFeatureToChunk(feature, chunkCoordinate, input = {}) {
  const validation = validateWorldFeatureGeometry(feature?.geometry);
  if (!validation.valid || typeof feature?.stableId !== 'string' || !feature.stableId) throw new TypeError('invalid WorldFeature');
  const intersects = getIntersectingChunkCoordinates(feature, input.chunkSize ?? 16).some(item => item.x === chunkCoordinate.x && item.z === chunkCoordinate.z);
  if (!intersects) return null;
  let projection;
  if (feature.geometry.type === 'polylineWithWidth') projection = await projectPolylineToChunk(feature, chunkCoordinate, input);
  else if (feature.geometry.type === 'polygon2D') projection = projectPolygonToChunk(feature, chunkCoordinate, input);
  else projection = { localBounds: [translateGeometry(feature.geometry, getChunkWorldBounds(chunkCoordinate, input.chunkSize ?? 16))], ports: [] };
  return { schemaVersion: 'world-feature-projection-1', stableId: feature.stableId, featureType: feature.featureType,
    chunkCoordinate: { ...chunkCoordinate }, localBounds: projection.localBounds, ports: projection.ports };
}

export async function projectSectorFeaturesToCoordinate(features, chunkCoordinate, input = {}) {
  const projections = await Promise.all(features.map(feature => projectWorldFeatureToChunk(feature, chunkCoordinate, input)));
  return projections.filter(Boolean).sort((a, b) => a.stableId.localeCompare(b.stableId));
}

function ownerAxis(value, chunkSize) {
  const millimeters = Math.round(value * 1000); const chunkMillimeters = Math.round(chunkSize * 1000);
  return millimeters % chunkMillimeters === 0 ? Math.floor(millimeters / chunkMillimeters) - 1 : Math.floor(millimeters / chunkMillimeters);
}

export function determineLocalFeatureOwner(worldPosition, chunkSize = 16) {
  if (!Number.isFinite(worldPosition?.x) || !Number.isFinite(worldPosition?.z)) throw new TypeError('worldPosition is invalid');
  return { x: ownerAxis(worldPosition.x, chunkSize), z: ownerAxis(worldPosition.z, chunkSize) };
}

export async function validateFeatureCoverage(feature, projections, input = {}) {
  const errors = []; const expected = getIntersectingChunkCoordinates(feature, input.chunkSize ?? 16).map(item => `${item.x},${item.z}`).sort();
  const actual = projections.map(item => `${item.chunkCoordinate.x},${item.chunkCoordinate.z}`).sort();
  if (new Set(actual).size !== actual.length) errors.push('Feature is projected more than once into a Chunk');
  if (canonicalizeJson(expected) !== canonicalizeJson(actual)) errors.push('Feature projection coverage differs from intersecting Chunks');
  if (projections.some(item => item.stableId !== feature.stableId)) errors.push('Feature Stable ID changed during projection');
  return { valid: errors.length === 0, errors };
}

export function validateFeatureProjection(feature, projection) {
  const errors = [];
  if (projection?.stableId !== feature?.stableId) errors.push('projection Stable ID differs');
  if (!Array.isArray(projection?.localBounds) || projection.localBounds.length === 0) errors.push('projection localBounds are missing');
  else projection.localBounds.forEach((bounds, index) => {
    const validation = validateFeatureBounds(bounds);
    if (!validation.valid) errors.push(`localBounds[${index}] is invalid: ${validation.errors.join(', ')}`);
  });
  if (!Array.isArray(projection?.ports)) errors.push('projection ports are missing');
  return { valid: errors.length === 0, errors };
}

export async function hashFeatureProjections(projections) {
  const ordered = [...projections].sort((a, b) => a.stableId.localeCompare(b.stableId)
    || a.chunkCoordinate.z - b.chunkCoordinate.z || a.chunkCoordinate.x - b.chunkCoordinate.x);
  return `sha256:${await sha256Hex(canonicalizeJson({ schemaVersion: 'feature-projection-output-1', projections: ordered }))}`;
}
