import { SETTLEMENT_TYPES } from '../settlement-type.js';

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

export function validateCanonicalSettlementPlan(input) {
  const plan = requireRecord(input, 'CanonicalSettlementPlan');
  if (plan.schemaVersion !== CANONICAL_SETTLEMENT_PLAN_SCHEMA) {
    throw new TypeError(`plan.schemaVersion must be ${CANONICAL_SETTLEMENT_PLAN_SCHEMA}`);
  }
  if (!LEGACY_SETTLEMENT_CLASS_SET.has(plan.legacySettlementClass)) {
    throw new RangeError(`unsupported legacySettlementClass: ${plan.legacySettlementClass}`);
  }
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
    roadGraph: normalizeRoadGraph(plan.roadGraph),
    blocks: normalizeIdentifiedRecords(plan.blocks, 'plan.blocks', 'blockId'),
    lots: normalizeIdentifiedRecords(plan.lots, 'plan.lots', 'lotId'),
    buildings: normalizeIdentifiedRecords(plan.buildings, 'plan.buildings', 'buildingId'),
  });
}

export function createCanonicalSettlementPlan(input) {
  return validateCanonicalSettlementPlan(input);
}
