import { BUILDING_LOT_PROFILES } from '../building-lot.js';
import { getFrontagePairGaps } from '../building-frontage.js';
import {
  BLOCK_GENERATOR_V1_ID,
  createRoadGraphV1Blocks,
  validateRoadGraphV1Blocks,
} from './block-generator-v1.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import {
  ROAD_GRAPH_V1_GENERATOR_ID,
  ROAD_GRAPH_V1_SCHEMA,
} from './road-graph-v1.js';
import { ROAD_GRAPH_V3_GENERATOR_ID } from './road-graph-v3.js';
import {
  SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
  createSettlementSemanticStableId,
} from './settlement-semantic-identity.js';

export const SETTLEMENT_LOT_V1_GENERATOR_ID = 'lot-v1';
export const SETTLEMENT_LOT_V1_SOURCE_BLOCK_VERSION = BLOCK_GENERATOR_V1_ID;

const GEOMETRY_EPSILON = 1e-7;
const STANDARD_PROFILE = BUILDING_LOT_PROFILES.house;
const STANDARD_PASSAGE_GAP = getFrontagePairGaps('house', 'house').passageGap;
const UNITS_PER_METER = 40;

export const SETTLEMENT_LOT_V1_PARAMETERS = Object.freeze({
  standardFootprintWidthMeters: STANDARD_PROFILE.footprintWidth / UNITS_PER_METER,
  requiredGapMeters: (STANDARD_PROFILE.sideMargin * 2 + STANDARD_PASSAGE_GAP)
    / UNITS_PER_METER,
  minimumFrontageWidthMeters: (STANDARD_PROFILE.footprintWidth
    + STANDARD_PROFILE.sideMargin * 2) / UNITS_PER_METER,
  targetFrontageWidthMeters: (STANDARD_PROFILE.footprintWidth
    + STANDARD_PROFILE.sideMargin * 2 + STANDARD_PASSAGE_GAP) / UNITS_PER_METER,
  depthMeters: 7,
  minimumAreaSquareMeters: (STANDARD_PROFILE.footprintWidth
    + STANDARD_PROFILE.sideMargin * 2) / UNITS_PER_METER * 7,
});

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const point = (x, z) => Object.freeze({ x: q6(x), z: q6(z) });

function asBlockV1RoadGraph(roadGraph) {
  if (roadGraph?.schemaVersion !== ROAD_GRAPH_V1_SCHEMA
    || roadGraph?.generatorId !== ROAD_GRAPH_V3_GENERATOR_ID) {
    throw new TypeError('lot-v1 requires road-graph-v3');
  }
  return Object.freeze({ ...roadGraph, generatorId: ROAD_GRAPH_V1_GENERATOR_ID });
}

export async function createRoadGraphV3Blocks({ worldSeedHash, roadGraph } = {}) {
  return createRoadGraphV1Blocks({
    worldSeedHash,
    roadGraph: asBlockV1RoadGraph(roadGraph),
  });
}

function signedArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    twiceArea += points[index].x * next.z - next.x * points[index].z;
  }
  return twiceArea / 2;
}

function orientation(first, second, third) {
  return (second.x - first.x) * (third.z - first.z)
    - (second.z - first.z) * (third.x - first.x);
}

function pointOnSegment(value, start, end) {
  return Math.abs(orientation(start, end, value)) <= GEOMETRY_EPSILON
    && value.x >= Math.min(start.x, end.x) - GEOMETRY_EPSILON
    && value.x <= Math.max(start.x, end.x) + GEOMETRY_EPSILON
    && value.z >= Math.min(start.z, end.z) - GEOMETRY_EPSILON
    && value.z <= Math.max(start.z, end.z) + GEOMETRY_EPSILON;
}

export function pointInSettlementPolygon(value, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const start = polygon[previous];
    const end = polygon[index];
    if (pointOnSegment(value, start, end)) return true;
    if ((end.z > value.z) !== (start.z > value.z)
      && value.x < (start.x - end.x) * (value.z - end.z) / (start.z - end.z) + end.x) {
      inside = !inside;
    }
  }
  return inside;
}

function properSegmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const a = orientation(firstStart, firstEnd, secondStart);
  const b = orientation(firstStart, firstEnd, secondEnd);
  const c = orientation(secondStart, secondEnd, firstStart);
  const d = orientation(secondStart, secondEnd, firstEnd);
  return ((a > GEOMETRY_EPSILON && b < -GEOMETRY_EPSILON)
      || (a < -GEOMETRY_EPSILON && b > GEOMETRY_EPSILON))
    && ((c > GEOMETRY_EPSILON && d < -GEOMETRY_EPSILON)
      || (c < -GEOMETRY_EPSILON && d > GEOMETRY_EPSILON));
}

function hasSelfIntersection(polygon) {
  for (let first = 0; first < polygon.length; first += 1) {
    const firstNext = (first + 1) % polygon.length;
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondNext = (second + 1) % polygon.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (properSegmentsIntersect(
        polygon[first], polygon[firstNext], polygon[second], polygon[secondNext],
      )) return true;
    }
  }
  return false;
}

function polygonInsidePolygon(inner, outer) {
  if (!inner.every(value => pointInSettlementPolygon(value, outer))) return false;
  for (let innerIndex = 0; innerIndex < inner.length; innerIndex += 1) {
    const innerNext = (innerIndex + 1) % inner.length;
    for (let outerIndex = 0; outerIndex < outer.length; outerIndex += 1) {
      const outerNext = (outerIndex + 1) % outer.length;
      if (properSegmentsIntersect(
        inner[innerIndex], inner[innerNext], outer[outerIndex], outer[outerNext],
      )) return false;
    }
  }
  return true;
}

function projectPolygon(polygon, axis) {
  const values = polygon.map(value => value.x * axis.x + value.z * axis.z);
  return { minimum: Math.min(...values), maximum: Math.max(...values) };
}

export function convexPolygonsOverlap(first, second) {
  for (const polygon of [first, second]) {
    for (let index = 0; index < polygon.length; index += 1) {
      const next = polygon[(index + 1) % polygon.length];
      const dx = next.x - polygon[index].x;
      const dz = next.z - polygon[index].z;
      const length = Math.hypot(dx, dz);
      if (length <= GEOMETRY_EPSILON) continue;
      const axis = { x: -dz / length, z: dx / length };
      const left = projectPolygon(first, axis);
      const right = projectPolygon(second, axis);
      if (left.maximum <= right.minimum + GEOMETRY_EPSILON
        || right.maximum <= left.minimum + GEOMETRY_EPSILON) return false;
    }
  }
  return true;
}

export function settlementPolygonsOverlap(first, second) {
  if (first.some(value => pointInSettlementPolygon(value, second))
    || second.some(value => pointInSettlementPolygon(value, first))) return true;
  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
    const firstNext = (firstIndex + 1) % first.length;
    for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
      const secondNext = (secondIndex + 1) % second.length;
      if (properSegmentsIntersect(
        first[firstIndex], first[firstNext], second[secondIndex], second[secondNext],
      )) return true;
    }
  }
  return false;
}

function graphMaps(roadGraph) {
  return {
    nodesById: new Map(roadGraph.nodes.map(node => [node.nodeId, node])),
    edgesById: new Map(roadGraph.edges.map(edge => [edge.edgeId, edge])),
    segmentsById: new Map(roadGraph.segments.map(segment => [segment.edgeId, segment])),
  };
}

function blockPolygon(block, nodesById) {
  if (!Array.isArray(block?.boundaryNodeIds) || block.boundaryNodeIds.length < 4) return null;
  const points = block.boundaryNodeIds.slice(0, -1)
    .map(nodeId => nodesById.get(nodeId)?.position)
    .filter(Boolean)
    .map(value => point(value.x, value.z));
  return points.length === block.boundaryNodeIds.length - 1 ? Object.freeze(points) : null;
}

export function deriveSettlementBlockPolygon({ roadGraph, block } = {}) {
  const { nodesById } = graphMaps(roadGraph);
  const polygon = blockPolygon(block, nodesById);
  if (!polygon) throw new RangeError('Block boundary cannot be resolved');
  return polygon;
}

function boundaryDescriptor({ block, edgeIndex, maps }) {
  const frontageEdgeId = block.boundaryEdgeIds[edgeIndex];
  const edge = maps.edgesById.get(frontageEdgeId);
  const segment = maps.segmentsById.get(frontageEdgeId);
  const fromNodeId = block.boundaryNodeIds[edgeIndex];
  const toNodeId = block.boundaryNodeIds[edgeIndex + 1];
  const from = maps.nodesById.get(fromNodeId)?.position;
  const to = maps.nodesById.get(toNodeId)?.position;
  if (!edge || !segment || !from || !to) return null;
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  if (length <= GEOMETRY_EPSILON) return null;
  const canonicalForward = edge.startNodeId === fromNodeId && edge.endNodeId === toNodeId;
  if (!canonicalForward && !(edge.startNodeId === toNodeId && edge.endNodeId === fromNodeId)) {
    return null;
  }
  return {
    edge,
    segment,
    frontageEdgeId,
    from,
    to,
    length,
    canonicalForward,
    inward: { x: -(to.z - from.z) / length, z: (to.x - from.x) / length },
  };
}

function footprintFromDescriptor(descriptor, frontageInterval, depth) {
  const canonicalStart = descriptor.canonicalForward ? descriptor.from : descriptor.to;
  const canonicalEnd = descriptor.canonicalForward ? descriptor.to : descriptor.from;
  const interpolate = value => ({
    x: canonicalStart.x + (canonicalEnd.x - canonicalStart.x) * value,
    z: canonicalStart.z + (canonicalEnd.z - canonicalStart.z) * value,
  });
  const canonicalPoints = frontageInterval.map(interpolate);
  const frontStart = descriptor.canonicalForward ? canonicalPoints[0] : canonicalPoints[1];
  const frontEnd = descriptor.canonicalForward ? canonicalPoints[1] : canonicalPoints[0];
  const roadInset = descriptor.segment.widthMeters / 2;
  const insetStart = {
    x: frontStart.x + descriptor.inward.x * roadInset,
    z: frontStart.z + descriptor.inward.z * roadInset,
  };
  const insetEnd = {
    x: frontEnd.x + descriptor.inward.x * roadInset,
    z: frontEnd.z + descriptor.inward.z * roadInset,
  };
  return Object.freeze([
    point(insetStart.x, insetStart.z),
    point(insetEnd.x, insetEnd.z),
    point(insetEnd.x + descriptor.inward.x * depth, insetEnd.z + descriptor.inward.z * depth),
    point(insetStart.x + descriptor.inward.x * depth, insetStart.z + descriptor.inward.z * depth),
  ]);
}

async function createLotId({ worldSeedHash, roadGraph, blockId, frontageEdgeId,
  frontageInterval }) {
  return (await createSettlementSemanticStableId({
    schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
    worldSeedHash,
    settlementId: roadGraph.settlementId,
    semanticKind: 'lot',
    semanticLocalKey: canonicalizeJson({
      blockId,
      frontageEdgeId,
      frontageInterval,
      lotGeneratorVersion: SETTLEMENT_LOT_V1_GENERATOR_ID,
    }),
  })).stableId;
}

async function candidateLotsForBlock({ worldSeedHash, roadGraph, block, maps, polygon }) {
  const candidates = [];
  let eligibleFrontageCount = 0;
  let frontageFailureCount = 0;
  for (let edgeIndex = 0; edgeIndex < block.boundaryEdgeIds.length; edgeIndex += 1) {
    const descriptor = boundaryDescriptor({ block, edgeIndex, maps });
    if (!descriptor || descriptor.edge.flags?.frontageEligible !== true) continue;
    eligibleFrontageCount += 1;
    if (descriptor.length + GEOMETRY_EPSILON
      < SETTLEMENT_LOT_V1_PARAMETERS.minimumFrontageWidthMeters) {
      frontageFailureCount += 1;
      continue;
    }
    const count = Math.floor(
      descriptor.length / SETTLEMENT_LOT_V1_PARAMETERS.targetFrontageWidthMeters,
    );
    if (count < 1) {
      frontageFailureCount += 1;
      continue;
    }
    const usedLength = count * SETTLEMENT_LOT_V1_PARAMETERS.targetFrontageWidthMeters;
    const remainder = descriptor.length - usedLength;
    for (let lotIndex = 0; lotIndex < count; lotIndex += 1) {
      const boundaryStart = (remainder / 2
        + lotIndex * SETTLEMENT_LOT_V1_PARAMETERS.targetFrontageWidthMeters)
        / descriptor.length;
      const boundaryEnd = (remainder / 2
        + (lotIndex + 1) * SETTLEMENT_LOT_V1_PARAMETERS.targetFrontageWidthMeters)
        / descriptor.length;
      const frontageInterval = Object.freeze(descriptor.canonicalForward
        ? [q6(boundaryStart), q6(boundaryEnd)]
        : [q6(1 - boundaryEnd), q6(1 - boundaryStart)]);
      const footprint = footprintFromDescriptor(
        descriptor,
        frontageInterval,
        SETTLEMENT_LOT_V1_PARAMETERS.depthMeters,
      );
      if (Math.abs(signedArea(footprint)) + GEOMETRY_EPSILON
          < SETTLEMENT_LOT_V1_PARAMETERS.minimumAreaSquareMeters
        || hasSelfIntersection(footprint)
        || !polygonInsidePolygon(footprint, polygon)) {
        frontageFailureCount += 1;
        continue;
      }
      const id = await createLotId({
        worldSeedHash,
        roadGraph,
        blockId: block.id,
        frontageEdgeId: descriptor.frontageEdgeId,
        frontageInterval,
      });
      candidates.push(Object.freeze({
        id,
        blockId: block.id,
        frontageEdgeId: descriptor.frontageEdgeId,
        frontageInterval,
        depth: SETTLEMENT_LOT_V1_PARAMETERS.depthMeters,
        footprint,
        isCorner: false,
        isFallback: false,
        sourceRoadGraphVersion: roadGraph.schemaVersion,
        sourceBlockVersion: SETTLEMENT_LOT_V1_SOURCE_BLOCK_VERSION,
        owner: roadGraph.sourceOwner,
      }));
    }
  }
  candidates.sort((left, right) => left.id.localeCompare(right.id));
  const accepted = [];
  for (const candidate of candidates) {
    if (accepted.some(existing => convexPolygonsOverlap(candidate.footprint, existing.footprint))) {
      frontageFailureCount += 1;
      continue;
    }
    accepted.push(candidate);
  }
  return { accepted, eligibleFrontageCount, frontageFailureCount };
}

export async function validateSettlementLotsV1({ worldSeedHash, roadGraph, blocks, lots } = {}) {
  asBlockV1RoadGraph(roadGraph);
  if (!Array.isArray(blocks) || !Array.isArray(lots)) {
    throw new TypeError('blocks and lots must be arrays');
  }
  const maps = graphMaps(roadGraph);
  const blocksById = new Map(blocks.map(block => [block.id, block]));
  const lotIds = new Set();
  const errors = [];
  let duplicateLotIdCount = 0;
  let orphanLotCount = 0;
  let invalidFrontageCount = 0;
  let outsideBlockCount = 0;
  let selfIntersectionCount = 0;
  let overlapCount = 0;
  let authorityMismatchCount = 0;
  for (const lot of lots) {
    if (lotIds.has(lot.id)) duplicateLotIdCount += 1;
    lotIds.add(lot.id);
    const block = blocksById.get(lot.blockId);
    if (!block) {
      orphanLotCount += 1;
      continue;
    }
    const edgeIndex = block.boundaryEdgeIds.indexOf(lot.frontageEdgeId);
    const interval = lot.frontageInterval;
    if (edgeIndex < 0 || !Array.isArray(interval) || interval.length !== 2
      || !interval.every(Number.isFinite) || interval[0] < 0 || interval[1] > 1
      || interval[1] - interval[0] <= GEOMETRY_EPSILON) {
      invalidFrontageCount += 1;
      continue;
    }
    const descriptor = boundaryDescriptor({ block, edgeIndex, maps });
    const polygon = blockPolygon(block, maps.nodesById);
    if (!descriptor || !polygon) {
      orphanLotCount += 1;
      continue;
    }
    const expectedFootprint = footprintFromDescriptor(descriptor, interval, lot.depth);
    const expectedId = await createLotId({
      worldSeedHash,
      roadGraph,
      blockId: lot.blockId,
      frontageEdgeId: lot.frontageEdgeId,
      frontageInterval: interval,
    });
    if (canonicalizeJson(expectedFootprint) !== canonicalizeJson(lot.footprint)
      || expectedId !== lot.id || lot.sourceRoadGraphVersion !== roadGraph.schemaVersion
      || lot.sourceBlockVersion !== SETTLEMENT_LOT_V1_SOURCE_BLOCK_VERSION
      || lot.isCorner !== false || lot.isFallback !== false) authorityMismatchCount += 1;
    if (hasSelfIntersection(lot.footprint)) selfIntersectionCount += 1;
    if (!polygonInsidePolygon(lot.footprint, polygon)) outsideBlockCount += 1;
  }
  for (let first = 0; first < lots.length; first += 1) {
    for (let second = first + 1; second < lots.length; second += 1) {
      if (convexPolygonsOverlap(lots[first].footprint, lots[second].footprint)) overlapCount += 1;
    }
  }
  const counts = {
    duplicateLotIdCount,
    orphanLotCount,
    invalidFrontageCount,
    outsideBlockCount,
    selfIntersectionCount,
    overlapCount,
    authorityMismatchCount,
  };
  for (const [name, count] of Object.entries(counts)) if (count) errors.push(`${name}: ${count}`);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), ...counts });
}

export async function createSettlementLotsV1({ worldSeedHash, roadGraph, blocks } = {}) {
  const blockRoadGraph = asBlockV1RoadGraph(roadGraph);
  if (!Array.isArray(blocks)) throw new TypeError('blocks must be an array');
  const maps = graphMaps(roadGraph);
  const blockResults = [];
  const lots = [];
  let frontageFailureCount = 0;
  const orderedBlocks = [...blocks].sort((left, right) => left.id.localeCompare(right.id));
  const seenBlockIds = new Set();
  for (const block of orderedBlocks) {
    const polygon = blockPolygon(block, maps.nodesById);
    let reason = null;
    const blockValidation = await validateRoadGraphV1Blocks({
      worldSeedHash,
      roadGraph: blockRoadGraph,
      blocks: [block],
    });
    if (!blockValidation.valid || seenBlockIds.has(block?.id)) reason = 'VALIDATION_FAILED';
    seenBlockIds.add(block?.id);
    if (!reason && (block?.isClosed !== true || !polygon || hasSelfIntersection(polygon)
      || signedArea(polygon) <= GEOMETRY_EPSILON)) reason = 'BLOCK_NOT_CLOSED';
    else if (!reason && signedArea(polygon) + GEOMETRY_EPSILON
      < SETTLEMENT_LOT_V1_PARAMETERS.minimumAreaSquareMeters) reason = 'BLOCK_TOO_SMALL';
    let generated = { accepted: [], eligibleFrontageCount: 0, frontageFailureCount: 0 };
    if (!reason) {
      generated = await candidateLotsForBlock({ worldSeedHash, roadGraph, block, maps, polygon });
      frontageFailureCount += generated.frontageFailureCount;
      if (generated.eligibleFrontageCount === 0) reason = 'NO_VALID_FRONTAGE';
      else if (generated.accepted.length === 0) reason = 'ZERO_LOTS';
      else {
        const blockLotValidation = await validateSettlementLotsV1({
          worldSeedHash,
          roadGraph,
          blocks: [block],
          lots: generated.accepted,
        });
        if (!blockLotValidation.valid) reason = 'VALIDATION_FAILED';
      }
    }
    if (!reason) lots.push(...generated.accepted);
    blockResults.push(Object.freeze({
      blockId: block.id,
      mode: reason ? 'SCATTER_FALLBACK' : 'LOT',
      fallbackReason: reason,
      lotIds: Object.freeze(reason ? [] : generated.accepted.map(lot => lot.id)),
      eligibleFrontageCount: generated.eligibleFrontageCount,
    }));
  }
  lots.sort((left, right) => left.id.localeCompare(right.id));
  let validation = await validateSettlementLotsV1({ worldSeedHash, roadGraph, blocks, lots });
  if (!validation.valid) {
    lots.length = 0;
    for (let index = 0; index < blockResults.length; index += 1) {
      blockResults[index] = Object.freeze({
        ...blockResults[index],
        mode: 'SCATTER_FALLBACK',
        fallbackReason: 'VALIDATION_FAILED',
        lotIds: Object.freeze([]),
      });
    }
    validation = await validateSettlementLotsV1({ worldSeedHash, roadGraph, blocks, lots });
  }
  return Object.freeze({
    lots: Object.freeze(lots),
    blockResults: Object.freeze(blockResults),
    frontageFailureCount,
    validation,
  });
}
