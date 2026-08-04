import { SETTLEMENT_TYPES } from '../settlement-type.js';
import {
  BLOCK_V1_SOURCE_ROAD_GRAPH_VERSION,
  normalizeBoundaryEdgeCycle,
} from './block-generator-v1.js';

export const CANONICAL_SETTLEMENT_PLAN_SCHEMA = 'canonical-settlement-plan-1';

export const SETTLEMENT_NODE_QUANTIZATION = Object.freeze({
  gridWidthMeters: 0.000001,
  epsilonMeters: 0.000000001,
});

export const LEGACY_SETTLEMENT_CLASSES = Object.freeze([
  SETTLEMENT_TYPES.CITY,
  SETTLEMENT_TYPES.TOWN,
  SETTLEMENT_TYPES.RURAL,
]);

const LEGACY_SETTLEMENT_CLASS_SET = new Set(LEGACY_SETTLEMENT_CLASSES);

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireId(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function immutableJsonValue(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain only finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => immutableJsonValue(entry, `${label}[${index}]`)));
  }
  requireRecord(value, label);
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    immutableJsonValue(entry, `${label}.${key}`),
  ])));
}

function requireQuantizedCoordinate(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  const { gridWidthMeters, epsilonMeters } = SETTLEMENT_NODE_QUANTIZATION;
  const quantized = Math.round(value / gridWidthMeters) * gridWidthMeters;
  if (Math.abs(value - quantized) > epsilonMeters) {
    throw new RangeError(`${label} must be quantized to the Settlement node grid`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizeIdentifiedRecords(value, label, idField) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const ids = new Set();
  return Object.freeze(value.map((entry, index) => {
    const record = requireRecord(entry, `${label}[${index}]`);
    const id = requireId(record[idField], `${label}[${index}].${idField}`);
    if (ids.has(id)) throw new Error(`duplicate ${label} ${idField}: ${id}`);
    ids.add(id);
    return immutableJsonValue(record, `${label}[${index}]`);
  }));
}

function normalizeRoadGraph(value) {
  const graph = requireRecord(value, 'plan.roadGraph');
  if (!Array.isArray(graph.nodes)) throw new TypeError('plan.roadGraph.nodes must be an array');
  const nodeIds = new Set();
  const nodes = Object.freeze(graph.nodes.map((entry, index) => {
    const node = requireRecord(entry, `plan.roadGraph.nodes[${index}]`);
    const nodeId = requireId(node.nodeId, `plan.roadGraph.nodes[${index}].nodeId`);
    if (nodeIds.has(nodeId)) throw new Error(`duplicate Settlement road node: ${nodeId}`);
    nodeIds.add(nodeId);
    return Object.freeze({
      ...immutableJsonValue(node, `plan.roadGraph.nodes[${index}]`),
      nodeId,
      x: requireQuantizedCoordinate(node.x, `plan.roadGraph.nodes[${index}].x`),
      z: requireQuantizedCoordinate(node.z, `plan.roadGraph.nodes[${index}].z`),
    });
  }));
  const edges = normalizeIdentifiedRecords(graph.edges, 'plan.roadGraph.edges', 'edgeId');
  for (const edge of edges) {
    if (!nodeIds.has(requireId(edge.fromNodeId, `road edge ${edge.edgeId}.fromNodeId`))
      || !nodeIds.has(requireId(edge.toNodeId, `road edge ${edge.edgeId}.toNodeId`))) {
      throw new RangeError(`road edge ${edge.edgeId} references an unknown node`);
    }
  }
  return Object.freeze({ nodes, edges });
}

const BLOCK_FIELDS = Object.freeze([
  'id',
  'boundaryEdgeIds',
  'boundaryNodeIds',
  'isClosed',
  'districtTag',
  'sourceRoadGraphVersion',
]);
const BLOCK_FIELD_SET = new Set(BLOCK_FIELDS);

function requireIdArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return Object.freeze(value.map((entry, index) => requireId(entry, `${label}[${index}]`)));
}

function polygonSignedArea(points) {
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

function pointOnSegment(point, start, end) {
  const epsilon = SETTLEMENT_NODE_QUANTIZATION.epsilonMeters;
  return Math.abs(orientation(start, end, point)) <= epsilon
    && point.x >= Math.min(start.x, end.x) - epsilon
    && point.x <= Math.max(start.x, end.x) + epsilon
    && point.z >= Math.min(start.z, end.z) - epsilon
    && point.z <= Math.max(start.z, end.z) + epsilon;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const epsilon = SETTLEMENT_NODE_QUANTIZATION.epsilonMeters;
  const values = [
    orientation(firstStart, firstEnd, secondStart),
    orientation(firstStart, firstEnd, secondEnd),
    orientation(secondStart, secondEnd, firstStart),
    orientation(secondStart, secondEnd, firstEnd),
  ];
  if (((values[0] > epsilon && values[1] < -epsilon)
      || (values[0] < -epsilon && values[1] > epsilon))
    && ((values[2] > epsilon && values[3] < -epsilon)
      || (values[2] < -epsilon && values[3] > epsilon))) return true;
  return (Math.abs(values[0]) <= epsilon && pointOnSegment(secondStart, firstStart, firstEnd))
    || (Math.abs(values[1]) <= epsilon && pointOnSegment(secondEnd, firstStart, firstEnd))
    || (Math.abs(values[2]) <= epsilon && pointOnSegment(firstStart, secondStart, secondEnd))
    || (Math.abs(values[3]) <= epsilon && pointOnSegment(firstEnd, secondStart, secondEnd));
}

function hasSelfIntersection(points) {
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(
        points[first],
        points[firstNext],
        points[second],
        points[secondNext],
      )) return true;
    }
  }
  return false;
}

function normalizeBlocks(value, roadGraph) {
  if (!Array.isArray(value)) throw new TypeError('plan.blocks must be an array');
  const nodesById = new Map(roadGraph.nodes.map(node => [node.nodeId, node]));
  const edgesById = new Map(roadGraph.edges.map(edge => [edge.edgeId, edge]));
  const ids = new Set();
  const faceKeys = new Set();
  return Object.freeze(value.map((entry, blockIndex) => {
    const label = `plan.blocks[${blockIndex}]`;
    const block = requireRecord(entry, label);
    const unexpectedFields = Object.keys(block).filter(key => !BLOCK_FIELD_SET.has(key));
    if (unexpectedFields.length) {
      throw new TypeError(`${label} contains unsupported fields: ${unexpectedFields.join(', ')}`);
    }
    const id = requireId(block.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`duplicate plan.blocks id: ${id}`);
    ids.add(id);
    const boundaryEdgeIds = requireIdArray(block.boundaryEdgeIds, `${label}.boundaryEdgeIds`);
    const boundaryNodeIds = requireIdArray(block.boundaryNodeIds, `${label}.boundaryNodeIds`);
    if (boundaryEdgeIds.length < 3) throw new RangeError(`${label} requires at least three boundary edges`);
    if (new Set(boundaryEdgeIds).size !== boundaryEdgeIds.length) {
      throw new Error(`${label} contains a duplicate boundary edge`);
    }
    if (boundaryNodeIds.length !== boundaryEdgeIds.length + 1
      || boundaryNodeIds[0] !== boundaryNodeIds.at(-1)
      || block.isClosed !== true) {
      throw new Error(`${label} must be a closed cycle`);
    }
    const openNodeIds = boundaryNodeIds.slice(0, -1);
    if (new Set(openNodeIds).size !== openNodeIds.length) {
      throw new Error(`${label} contains a duplicate boundary node`);
    }
    for (let index = 0; index < boundaryEdgeIds.length; index += 1) {
      const edge = edgesById.get(boundaryEdgeIds[index]);
      const fromNodeId = boundaryNodeIds[index];
      const toNodeId = boundaryNodeIds[index + 1];
      if (!edge || !nodesById.has(fromNodeId) || !nodesById.has(toNodeId)) {
        throw new RangeError(`${label} references an unknown road node or edge`);
      }
      if (!((edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId)
        || (edge.toNodeId === fromNodeId && edge.fromNodeId === toNodeId))) {
        throw new Error(`${label} boundary edges are not continuous`);
      }
    }
    const points = openNodeIds.map(nodeId => nodesById.get(nodeId));
    if (hasSelfIntersection(points)) throw new Error(`${label} is self-intersecting`);
    if (polygonSignedArea(points) <= SETTLEMENT_NODE_QUANTIZATION.epsilonMeters) {
      throw new Error(`${label} area and winding must be positive`);
    }
    const faceKey = JSON.stringify(normalizeBoundaryEdgeCycle(boundaryEdgeIds));
    if (faceKeys.has(faceKey)) throw new Error(`${label} duplicates an existing face`);
    faceKeys.add(faceKey);
    if (block.districtTag !== null) throw new TypeError(`${label}.districtTag must be null`);
    if (block.sourceRoadGraphVersion !== BLOCK_V1_SOURCE_ROAD_GRAPH_VERSION) {
      throw new TypeError(
        `${label}.sourceRoadGraphVersion must be ${BLOCK_V1_SOURCE_ROAD_GRAPH_VERSION}`,
      );
    }
    return Object.freeze({
      id,
      boundaryEdgeIds,
      boundaryNodeIds,
      isClosed: true,
      districtTag: null,
      sourceRoadGraphVersion: BLOCK_V1_SOURCE_ROAD_GRAPH_VERSION,
    });
  }));
}

export function validateCanonicalSettlementPlan(input) {
  const plan = requireRecord(input, 'CanonicalSettlementPlan');
  if (plan.schemaVersion !== CANONICAL_SETTLEMENT_PLAN_SCHEMA) {
    throw new TypeError(`plan.schemaVersion must be ${CANONICAL_SETTLEMENT_PLAN_SCHEMA}`);
  }
  if (!LEGACY_SETTLEMENT_CLASS_SET.has(plan.legacySettlementClass)) {
    throw new RangeError(`unsupported legacySettlementClass: ${plan.legacySettlementClass}`);
  }
  const roadGraph = normalizeRoadGraph(plan.roadGraph);
  return Object.freeze({
    schemaVersion: CANONICAL_SETTLEMENT_PLAN_SCHEMA,
    settlementId: requireId(plan.settlementId, 'plan.settlementId'),
    biomeContext: immutableJsonValue(
      requireRecord(plan.biomeContext, 'plan.biomeContext'),
      'plan.biomeContext',
    ),
    settlementProfileId: requireId(plan.settlementProfileId, 'plan.settlementProfileId'),
    legacySettlementClass: plan.legacySettlementClass,
    center: Object.freeze({
      x: requireQuantizedCoordinate(plan.center?.x, 'plan.center.x'),
      z: requireQuantizedCoordinate(plan.center?.z, 'plan.center.z'),
    }),
    roadGraph,
    blocks: normalizeBlocks(plan.blocks, roadGraph),
    lots: normalizeIdentifiedRecords(plan.lots, 'plan.lots', 'lotId'),
    buildings: normalizeIdentifiedRecords(plan.buildings, 'plan.buildings', 'buildingId'),
  });
}

export function createCanonicalSettlementPlan(input) {
  return validateCanonicalSettlementPlan(input);
}
