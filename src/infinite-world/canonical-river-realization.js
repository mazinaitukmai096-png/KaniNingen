import {
  LOGICAL_CHUNK_SIZE_METERS,
  createChunkKey,
  logicalWorldToOwnedChunk,
} from './chunk-coordinates.js';
import { createWorldFeatureId } from './legacy-core/g0/stable-id.js';
import { createFeaturePortIdentity } from './legacy-core/g1/feature-port.js';
import {
  G2_C_WORLD_FEATURES,
  createWorldBorderSampleKey,
} from './legacy-core/g2/world-chunk-generator.js';

const SOURCE = G2_C_WORLD_FEATURES.river;
const SAMPLE_STEP_METERS = G2_C_WORLD_FEATURES.chunkSize / 32;
const EPSILON = 1e-7;

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const lengthScale = Math.hypot(1, SOURCE.slope);
const tangent = Object.freeze({ x: 1 / lengthScale, z: SOURCE.slope / lengthScale });
const normal = Object.freeze({ x: -SOURCE.slope / lengthScale, z: 1 / lengthScale });
const origin = Object.freeze({ x: 0, z: SOURCE.intercept });
const sourceIdCache = new Map();

export const W8_CANONICAL_RIVER = Object.freeze({
  schemaVersion: 'w8-canonical-river-realization-1',
  sourceSchemaVersion: 'g2-c-world-features',
  sourceGeneratorMajor: 1,
  widthMeters: SOURCE.width,
  depthMeters: SOURCE.depth,
  sourceSurfaceElevationMeters: SOURCE.surfaceElevation,
  bankExtentMeters: q6(SOURCE.width * 1.5),
  flowDirection: 'startToEnd',
  curveSampleSpacingMeters: SAMPLE_STEP_METERS,
});

function textHash(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function alongCoordinate(point) {
  return (point.x - origin.x) * tangent.x + (point.z - origin.z) * tangent.z;
}

function signedNormalCoordinate(point) {
  return (point.x - origin.x) * normal.x + (point.z - origin.z) * normal.z;
}

function basePointAt(along) {
  return {
    x: origin.x + tangent.x * along,
    z: origin.z + tangent.z * along,
  };
}

function normalizeSettlement(reference) {
  const center = reference?.center ?? reference?.worldPosition;
  const radiusMeters = reference?.radiusMeters;
  const stableId = reference?.settlementId ?? reference?.stableId;
  if (typeof stableId !== 'string' || !stableId
    || !Number.isFinite(center?.x) || !Number.isFinite(center?.z)
    || !Number.isFinite(radiusMeters) || radiusMeters <= 0) return null;
  const centerAlong = alongCoordinate(center);
  const centerNormal = signedNormalCoordinate(center);
  // Polyline chords approximate the exact avoidance arc. One established terrain
  // sample step of clearance keeps the complete rendered bank outside the
  // Settlement radius rather than only keeping the sampled arc vertices outside.
  const clearanceRadiusMeters = radiusMeters + W8_CANONICAL_RIVER.bankExtentMeters
    + SAMPLE_STEP_METERS;
  if (Math.abs(centerNormal) >= clearanceRadiusMeters) return null;
  const halfChordMeters = Math.sqrt(Math.max(0,
    clearanceRadiusMeters ** 2 - centerNormal ** 2));
  const side = Math.abs(centerNormal) > EPSILON
    ? Math.sign(centerNormal)
    : (textHash(stableId) & 1 ? 1 : -1);
  return Object.freeze({
    stableId,
    center: Object.freeze({ x: center.x, z: center.z }),
    radiusMeters,
    clearanceRadiusMeters,
    centerAlong,
    centerNormal,
    halfChordMeters,
    side,
  });
}

function normalizedSettlements(settlementReferences) {
  const byId = new Map();
  for (const reference of settlementReferences ?? []) {
    const settlement = normalizeSettlement(reference);
    if (settlement) byId.set(settlement.stableId, settlement);
  }
  return [...byId.values()].sort((left, right) => (
    left.centerAlong - right.centerAlong || left.stableId.localeCompare(right.stableId)
  ));
}

export function resolveCanonicalRiverPoint(along, settlementReferences = []) {
  if (!Number.isFinite(along)) throw new TypeError('River along coordinate must be finite');
  const base = basePointAt(along);
  let selected = null;
  for (const settlement of normalizedSettlements(settlementReferences)) {
    const localAlong = along - settlement.centerAlong;
    if (Math.abs(localAlong) > settlement.halfChordMeters + EPSILON) continue;
    const circleNormal = Math.sqrt(Math.max(0,
      settlement.clearanceRadiusMeters ** 2 - localAlong ** 2));
    const offset = settlement.centerNormal - settlement.side * circleNormal;
    if (!selected || Math.abs(offset) > Math.abs(selected.offset)
      || (Math.abs(offset) === Math.abs(selected.offset)
        && settlement.stableId.localeCompare(selected.settlement.stableId) < 0)) {
      selected = { offset, settlement };
    }
  }
  const offset = selected?.offset ?? 0;
  return Object.freeze({
    x: q6(base.x + normal.x * offset),
    z: q6(base.z + normal.z * offset),
    along: q6(along),
    settlementAvoidanceId: selected?.settlement.stableId ?? null,
  });
}

function segmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared <= EPSILON ? 0 : clamp(
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared,
    0,
    1,
  );
  return Math.hypot(point.x - start.x - dx * t, point.z - start.z - dz * t);
}

export function distanceToCanonicalRiverCenterline(corridors, worldX, worldZ) {
  if (![worldX, worldZ].every(Number.isFinite)) {
    throw new TypeError('River distance requires finite world coordinates');
  }
  let distance = Infinity;
  let nearest = null;
  for (const corridor of corridors ?? []) {
    for (const line of corridor.centerlines ?? []) {
      for (let index = 0; index < line.length - 1; index += 1) {
        const candidate = segmentDistance({ x: worldX, z: worldZ }, line[index], line[index + 1]);
        if (candidate < distance) {
          distance = candidate;
          nearest = corridor;
        }
      }
    }
  }
  return Object.freeze({ distanceMeters: distance, corridor: nearest });
}

export function resolveCanonicalRiverBed(corridors, worldX, worldZ) {
  const river = distanceToCanonicalRiverCenterline(corridors, worldX, worldZ);
  if (!river.corridor) return Object.freeze({
    sourceStableId: null,
    distanceMeters: Infinity,
    depthMeters: 0,
    bankWeight: 0,
  });
  const halfWidth = river.corridor.widthMeters / 2;
  const bankExtent = Math.max(halfWidth, river.corridor.bankExtentMeters);
  if (river.distanceMeters > bankExtent) return Object.freeze({
    sourceStableId: river.corridor.sourceStableId,
    distanceMeters: river.distanceMeters,
    depthMeters: 0,
    bankWeight: 0,
  });
  const bankT = bankExtent <= halfWidth
    ? 0
    : clamp((river.distanceMeters - halfWidth) / (bankExtent - halfWidth), 0, 1);
  const smoothBankT = bankT * bankT * (3 - 2 * bankT);
  const depthWeight = river.distanceMeters <= halfWidth ? 1 : 1 - smoothBankT;
  return Object.freeze({
    sourceStableId: river.corridor.sourceStableId,
    distanceMeters: river.distanceMeters,
    depthMeters: river.corridor.depthMeters * depthWeight,
    bankWeight: 1 - clamp(river.distanceMeters / bankExtent, 0, 1),
  });
}

function chunkBounds(chunkX, chunkZ, padding = 0) {
  const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS - padding;
  const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS - padding;
  return Object.freeze({
    minimumX,
    minimumZ,
    maximumX: minimumX + LOGICAL_CHUNK_SIZE_METERS + padding * 2,
    maximumZ: minimumZ + LOGICAL_CHUNK_SIZE_METERS + padding * 2,
  });
}

function clipSegmentToBounds(start, end, bounds) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  let minimumT = 0;
  let maximumT = 1;
  for (const [p, q] of [
    [-dx, start.x - bounds.minimumX],
    [dx, bounds.maximumX - start.x],
    [-dz, start.z - bounds.minimumZ],
    [dz, bounds.maximumZ - start.z],
  ]) {
    if (Math.abs(p) <= EPSILON) {
      if (q < -EPSILON) return null;
      continue;
    }
    const ratio = q / p;
    if (p < 0) minimumT = Math.max(minimumT, ratio);
    else maximumT = Math.min(maximumT, ratio);
    if (minimumT > maximumT + EPSILON) return null;
  }
  const pointAt = t => Object.freeze({
    x: q6(start.x + dx * t),
    z: q6(start.z + dz * t),
  });
  return Object.freeze([pointAt(minimumT), pointAt(maximumT)]);
}

function samePoint(left, right) {
  return Math.abs(left.x - right.x) <= 0.000001
    && Math.abs(left.z - right.z) <= 0.000001;
}

function clipPolyline(points, bounds) {
  const lines = [];
  let current = null;
  for (let index = 0; index < points.length - 1; index += 1) {
    const clipped = clipSegmentToBounds(points[index], points[index + 1], bounds);
    if (!clipped || samePoint(clipped[0], clipped[1])) {
      current = null;
      continue;
    }
    if (!current || !samePoint(current.at(-1), clipped[0])) {
      current = [clipped[0], clipped[1]];
      lines.push(current);
    } else if (!samePoint(current.at(-1), clipped[1])) current.push(clipped[1]);
  }
  return Object.freeze(lines.map(line => Object.freeze(line)));
}

function sampleAdjustedPolyline(chunkX, chunkZ, settlementReferences, padding) {
  const bounds = chunkBounds(chunkX, chunkZ, padding);
  const corners = [
    { x: bounds.minimumX, z: bounds.minimumZ },
    { x: bounds.maximumX, z: bounds.minimumZ },
    { x: bounds.minimumX, z: bounds.maximumZ },
    { x: bounds.maximumX, z: bounds.maximumZ },
  ];
  const settlements = normalizedSettlements(settlementReferences);
  const maximumClearance = Math.max(0, ...settlements.map(value => value.clearanceRadiusMeters));
  const minimumAlong = Math.min(...corners.map(alongCoordinate)) - maximumClearance;
  const maximumAlong = Math.max(...corners.map(alongCoordinate)) + maximumClearance;
  const samples = new Set([minimumAlong, maximumAlong]);
  for (const settlement of settlements) {
    const start = settlement.centerAlong - settlement.halfChordMeters;
    const end = settlement.centerAlong + settlement.halfChordMeters;
    if (end < minimumAlong || start > maximumAlong) continue;
    const first = Math.max(minimumAlong, start);
    const last = Math.min(maximumAlong, end);
    samples.add(first);
    samples.add(last);
    const count = Math.max(1, Math.ceil((last - first) / SAMPLE_STEP_METERS));
    for (let index = 1; index < count; index += 1) {
      samples.add(first + (last - first) * index / count);
    }
  }
  const points = [...samples].sort((left, right) => left - right)
    .map(along => resolveCanonicalRiverPoint(along, settlements));
  return clipPolyline(points, bounds);
}

export function canonicalRiverMayAffectChunk({
  chunkX,
  chunkZ,
  settlementReferences = [],
  paddingMeters = W8_CANONICAL_RIVER.bankExtentMeters,
} = {}) {
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
    throw new TypeError('River projection requires safe Chunk coordinates');
  }
  return sampleAdjustedPolyline(chunkX, chunkZ, settlementReferences, paddingMeters).length > 0;
}

export async function createCanonicalRiverSourceId(worldSeedHash) {
  if (!sourceIdCache.has(worldSeedHash)) {
    sourceIdCache.set(worldSeedHash, createWorldFeatureId({
      stableIdSchema: 'wf1',
      worldSeedHash,
      generatorMajor: W8_CANONICAL_RIVER.sourceGeneratorMajor,
      featureType: 'river',
      parentStableId: '',
      purposeKey: 'world-main-river',
      semanticLocalKey: 'linear-primary',
    }).then(identity => identity.stableId));
  }
  return sourceIdCache.get(worldSeedHash);
}

export function createCanonicalRiverSurfaceCorridor({
  sourceStableId,
  chunkX,
  chunkZ,
  settlementReferences = [],
} = {}) {
  if (typeof sourceStableId !== 'string' || !sourceStableId) {
    throw new TypeError('River surface corridor requires sourceStableId');
  }
  const centerlines = sampleAdjustedPolyline(
    chunkX,
    chunkZ,
    settlementReferences,
    W8_CANONICAL_RIVER.bankExtentMeters,
  );
  return centerlines.length ? Object.freeze({
    schemaVersion: 'w8-canonical-river-surface-corridor-1',
    sourceStableId,
    centerlines,
    widthMeters: W8_CANONICAL_RIVER.widthMeters,
    depthMeters: W8_CANONICAL_RIVER.depthMeters,
    bankExtentMeters: W8_CANONICAL_RIVER.bankExtentMeters,
  }) : null;
}

async function projectedRiverId(worldSeedHash, sourceStableId, chunkX, chunkZ) {
  return (await createWorldFeatureId({
    stableIdSchema: 'wf1',
    worldSeedHash,
    generatorMajor: 8,
    featureType: 'river-projection',
    parentStableId: sourceStableId,
    purposeKey: 'canonical-river-chunk-projection',
    semanticLocalKey: createChunkKey(chunkX, chunkZ),
  })).stableId;
}

function boundaryForPoint(point, chunkX, chunkZ) {
  const bounds = chunkBounds(chunkX, chunkZ);
  if (Math.abs(point.x - bounds.minimumX) <= 0.000001) return 'west';
  if (Math.abs(point.x - bounds.maximumX) <= 0.000001) return 'east';
  if (Math.abs(point.z - bounds.minimumZ) <= 0.000001) return 'north';
  if (Math.abs(point.z - bounds.maximumZ) <= 0.000001) return 'south';
  return null;
}

async function createPorts({ worldSeedHash, sourceStableId, chunkX, chunkZ, centerlines }) {
  const ports = [];
  for (const line of centerlines) {
    for (const point of [line[0], line.at(-1)]) {
      const edge = boundaryForPoint(point, chunkX, chunkZ);
      if (!edge) continue;
      const axis = ['west', 'east'].includes(edge) ? 'x' : 'z';
      const identity = await createFeaturePortIdentity({
        worldSeedHash,
        generatorMajor: W8_CANONICAL_RIVER.sourceGeneratorMajor,
        featureId: sourceStableId,
        semanticType: 'river-continuation',
        boundaryAxis: axis,
        quantizedWorldBoundary: Math.round(point[axis] * 1000),
        semanticCrossingKey: createWorldBorderSampleKey(point.x, point.z, 'river'),
      });
      if (ports.some(port => port.portId === identity.portId)) continue;
      ports.push(Object.freeze({
        schemaVersion: 'feature-port-1',
        ...identity,
        featureId: sourceStableId,
        edge,
        worldPosition: Object.freeze({ x: point.x, z: point.z }),
        width: W8_CANONICAL_RIVER.widthMeters,
        semanticType: 'river-continuation',
      }));
    }
  }
  return Object.freeze(ports.sort((left, right) => left.portId.localeCompare(right.portId)));
}

function segmentIntersection(firstStart, firstEnd, secondStart, secondEnd) {
  const firstX = firstEnd.x - firstStart.x;
  const firstZ = firstEnd.z - firstStart.z;
  const secondX = secondEnd.x - secondStart.x;
  const secondZ = secondEnd.z - secondStart.z;
  const denominator = firstX * secondZ - firstZ * secondX;
  if (Math.abs(denominator) <= EPSILON) return null;
  const offsetX = secondStart.x - firstStart.x;
  const offsetZ = secondStart.z - firstStart.z;
  const firstT = (offsetX * secondZ - offsetZ * secondX) / denominator;
  const secondT = (offsetX * firstZ - offsetZ * firstX) / denominator;
  if (firstT < -EPSILON || firstT > 1 + EPSILON
    || secondT < -EPSILON || secondT > 1 + EPSILON) return null;
  return Object.freeze({
    x: q6(firstStart.x + firstX * clamp(firstT, 0, 1)),
    z: q6(firstStart.z + firstZ * clamp(firstT, 0, 1)),
  });
}

async function createRoadCrossings({
  worldSeedHash,
  sourceStableId,
  projectionStableId,
  chunkX,
  chunkZ,
  centerlines,
  roads,
}) {
  const crossings = new Map();
  for (const road of roads ?? []) {
    if (road?.featureType !== 'settlement-road' || !road.start || !road.end) continue;
    for (const line of centerlines) {
      for (let index = 0; index < line.length - 1; index += 1) {
        const point = segmentIntersection(line[index], line[index + 1], road.start, road.end);
        if (!point) continue;
        const owner = logicalWorldToOwnedChunk(point.x, point.z);
        if (owner.chunkX !== chunkX || owner.chunkZ !== chunkZ) continue;
        const roadStableId = road.sourceStableId ?? road.stableId;
        const semanticKey = `${roadStableId}:${Math.round(point.x * 1000)}:${Math.round(point.z * 1000)}`;
        if (crossings.has(semanticKey)) continue;
        const stableId = (await createWorldFeatureId({
          stableIdSchema: 'wf1',
          worldSeedHash,
          generatorMajor: 8,
          featureType: 'river-road-crossing',
          parentStableId: sourceStableId,
          purposeKey: 'bridge-required-handoff',
          semanticLocalKey: semanticKey,
        })).stableId;
        crossings.set(semanticKey, Object.freeze({
          schemaVersion: 'w8-river-road-crossing-1',
          stableId,
          riverStableId: sourceStableId,
          riverProjectionStableId: projectionStableId,
          roadStableId,
          projectedRoadStableId: road.stableId,
          worldPosition: Object.freeze(point),
          riverWidthMeters: W8_CANONICAL_RIVER.widthMeters,
          roadWidthMeters: road.widthMeters,
          bridgeRequired: true,
          owningChunkCoordinate: Object.freeze({ x: chunkX, z: chunkZ }),
        }));
      }
    }
  }
  return Object.freeze([...crossings.values()]
    .sort((left, right) => left.stableId.localeCompare(right.stableId)));
}

export async function createCanonicalRiverProjection({
  worldSeedHash,
  chunkX,
  chunkZ,
  settlementReferences = [],
  roads = [],
  sampleSurfaceHeight = null,
} = {}) {
  if (typeof worldSeedHash !== 'string' || !worldSeedHash) {
    throw new TypeError('River projection requires worldSeedHash');
  }
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
    throw new TypeError('River projection requires safe Chunk coordinates');
  }
  if (sampleSurfaceHeight !== null && typeof sampleSurfaceHeight !== 'function') {
    throw new TypeError('sampleSurfaceHeight must be a function when provided');
  }
  const sourceStableId = await createCanonicalRiverSourceId(worldSeedHash);
  const surfaceCorridor = createCanonicalRiverSurfaceCorridor({
    sourceStableId,
    chunkX,
    chunkZ,
    settlementReferences,
  });
  const centerlines = sampleAdjustedPolyline(chunkX, chunkZ, settlementReferences, 0);
  if (!centerlines.length) return Object.freeze({
    sourceStableId,
    surfaceCorridor,
    waterSurface: null,
    roadCrossings: Object.freeze([]),
    ports: Object.freeze([]),
    totalLengthMeters: 0,
  });
  const stableId = await projectedRiverId(worldSeedHash, sourceStableId, chunkX, chunkZ);
  const heightAt = point => q6(sampleSurfaceHeight?.(point.x, point.z) ?? 0);
  const groundedCenterlines = Object.freeze(centerlines.map(line => Object.freeze(line.map(point =>
    Object.freeze({ x: point.x, y: heightAt(point), z: point.z }))))) ;
  const flatPoints = groundedCenterlines.flat();
  const totalLengthMeters = q6(groundedCenterlines.reduce((total, line) => (
    total + line.slice(1).reduce((lineTotal, point, index) => lineTotal + Math.hypot(
      point.x - line[index].x,
      point.z - line[index].z,
    ), 0)
  ), 0));
  const worldPosition = Object.freeze({
    x: q6(flatPoints.reduce((sum, point) => sum + point.x, 0) / flatPoints.length),
    y: q6(flatPoints.reduce((sum, point) => sum + point.y, 0) / flatPoints.length),
    z: q6(flatPoints.reduce((sum, point) => sum + point.z, 0) / flatPoints.length),
  });
  const roadCrossings = await createRoadCrossings({
    worldSeedHash,
    sourceStableId,
    projectionStableId: stableId,
    chunkX,
    chunkZ,
    centerlines,
    roads,
  });
  const ports = await createPorts({
    worldSeedHash,
    sourceStableId,
    chunkX,
    chunkZ,
    centerlines,
  });
  const waterSurface = Object.freeze({
    schemaVersion: 'w8-water-surface-1',
    stableId,
    sourceStableId,
    featureType: 'canonical-river',
    waterType: 'river',
    worldPosition,
    centerlines: groundedCenterlines,
    widthMeters: W8_CANONICAL_RIVER.widthMeters,
    depthMeters: totalLengthMeters,
    riverDepthMeters: W8_CANONICAL_RIVER.depthMeters,
    bankExtentMeters: W8_CANONICAL_RIVER.bankExtentMeters,
    flowDirection: W8_CANONICAL_RIVER.flowDirection,
    sourceSurfaceElevationMeters: W8_CANONICAL_RIVER.sourceSurfaceElevationMeters,
    portIds: Object.freeze(ports.map(port => port.portId)),
    crossingReferences: Object.freeze(roadCrossings.map(crossing => crossing.stableId)),
    roadCrossings,
    owningChunkCoordinate: Object.freeze({ x: chunkX, z: chunkZ }),
    lodPolicy: Object.freeze({
      schemaVersion: 'w8-canonical-river-lod-1',
      visibilityMeters: Object.freeze({ high: Infinity, medium: Infinity, low: Infinity }),
      near: Object.freeze({ ownerSet: 'rendered', presentationTier: 'full' }),
      outer: Object.freeze({ ownerSet: 'active', presentationTier: 'full' }),
      far: Object.freeze({ ownerSet: 'queried', presentationTier: 'full' }),
      presentationTiers: Object.freeze(['full']),
      proxy: false,
    }),
  });
  return Object.freeze({
    sourceStableId,
    surfaceCorridor,
    waterSurface,
    roadCrossings,
    ports,
    totalLengthMeters,
  });
}
