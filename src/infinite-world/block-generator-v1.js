import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import {
  SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
  createSettlementSemanticStableId,
} from './settlement-semantic-identity.js';

export const BLOCK_GENERATOR_V1_ID = 'block-v1';
export const BLOCK_V1_SOURCE_ROAD_GRAPH_VERSION = 'settlement-road-graph-v1';

const GEOMETRY_EPSILON = 1e-12;

function requireRoadGraph(roadGraph) {
  if (!roadGraph || typeof roadGraph !== 'object' || Array.isArray(roadGraph)) {
    throw new TypeError('roadGraph is required');
  }
  if (roadGraph.schemaVersion !== BLOCK_V1_SOURCE_ROAD_GRAPH_VERSION
    || roadGraph.generatorId !== 'road-graph-v1') {
    throw new TypeError('block-v1 requires settlement-road-graph-v1');
  }
  if (typeof roadGraph.settlementId !== 'string' || !roadGraph.settlementId) {
    throw new TypeError('roadGraph.settlementId is required');
  }
  if (!Array.isArray(roadGraph.nodes) || !Array.isArray(roadGraph.edges)) {
    throw new TypeError('roadGraph nodes and edges are required');
  }
  return roadGraph;
}

function compareCycles(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function rotations(values) {
  return values.map((_, offset) => [
    ...values.slice(offset),
    ...values.slice(0, offset),
  ]);
}

export function normalizeBoundaryEdgeCycle(boundaryEdgeIds) {
  if (!Array.isArray(boundaryEdgeIds) || boundaryEdgeIds.length < 3
    || boundaryEdgeIds.some(edgeId => typeof edgeId !== 'string' || !edgeId)) {
    throw new TypeError('boundaryEdgeIds must contain at least three IDs');
  }
  const candidates = [
    ...rotations(boundaryEdgeIds),
    ...rotations([...boundaryEdgeIds].reverse()),
  ];
  candidates.sort(compareCycles);
  return Object.freeze(candidates[0]);
}

function rotateBoundary(edgeIds, nodeIds) {
  let bestOffset = 0;
  for (let offset = 1; offset < edgeIds.length; offset += 1) {
    const candidate = [...edgeIds.slice(offset), ...edgeIds.slice(0, offset)];
    const best = [...edgeIds.slice(bestOffset), ...edgeIds.slice(0, bestOffset)];
    if (compareCycles(candidate, best) < 0) bestOffset = offset;
  }
  const rotatedEdges = [...edgeIds.slice(bestOffset), ...edgeIds.slice(0, bestOffset)];
  const openNodes = nodeIds.slice(0, -1);
  const rotatedNodes = [...openNodes.slice(bestOffset), ...openNodes.slice(0, bestOffset)];
  rotatedNodes.push(rotatedNodes[0]);
  return { edgeIds: rotatedEdges, nodeIds: rotatedNodes };
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

function pointOnSegment(point, start, end) {
  return Math.abs(orientation(start, end, point)) <= GEOMETRY_EPSILON
    && point.x >= Math.min(start.x, end.x) - GEOMETRY_EPSILON
    && point.x <= Math.max(start.x, end.x) + GEOMETRY_EPSILON
    && point.z >= Math.min(start.z, end.z) - GEOMETRY_EPSILON
    && point.z <= Math.max(start.z, end.z) + GEOMETRY_EPSILON;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const values = [
    orientation(firstStart, firstEnd, secondStart),
    orientation(firstStart, firstEnd, secondEnd),
    orientation(secondStart, secondEnd, firstStart),
    orientation(secondStart, secondEnd, firstEnd),
  ];
  if (((values[0] > GEOMETRY_EPSILON && values[1] < -GEOMETRY_EPSILON)
      || (values[0] < -GEOMETRY_EPSILON && values[1] > GEOMETRY_EPSILON))
    && ((values[2] > GEOMETRY_EPSILON && values[3] < -GEOMETRY_EPSILON)
      || (values[2] < -GEOMETRY_EPSILON && values[3] > GEOMETRY_EPSILON))) return true;
  return (Math.abs(values[0]) <= GEOMETRY_EPSILON && pointOnSegment(secondStart, firstStart, firstEnd))
    || (Math.abs(values[1]) <= GEOMETRY_EPSILON && pointOnSegment(secondEnd, firstStart, firstEnd))
    || (Math.abs(values[2]) <= GEOMETRY_EPSILON && pointOnSegment(firstStart, secondStart, secondEnd))
    || (Math.abs(values[3]) <= GEOMETRY_EPSILON && pointOnSegment(firstEnd, secondStart, secondEnd));
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

function halfEdgeKey(edgeId, fromNodeId) {
  return `${edgeId}\u0000${fromNodeId}`;
}

function extractFaceCycles(roadGraph) {
  const nodesById = new Map(roadGraph.nodes.map(node => [node.nodeId, node]));
  const outgoing = new Map(roadGraph.nodes.map(node => [node.nodeId, []]));
  for (const edge of roadGraph.edges) {
    const start = nodesById.get(edge.startNodeId);
    const end = nodesById.get(edge.endNodeId);
    if (!start || !end || start.nodeId === end.nodeId) continue;
    outgoing.get(start.nodeId).push({
      edgeId: edge.edgeId,
      fromNodeId: start.nodeId,
      toNodeId: end.nodeId,
      angle: Math.atan2(end.position.z - start.position.z, end.position.x - start.position.x),
    });
    outgoing.get(end.nodeId).push({
      edgeId: edge.edgeId,
      fromNodeId: end.nodeId,
      toNodeId: start.nodeId,
      angle: Math.atan2(start.position.z - end.position.z, start.position.x - end.position.x),
    });
  }
  for (const halfEdges of outgoing.values()) halfEdges.sort((left, right) => (
    left.angle - right.angle
      || (left.edgeId < right.edgeId ? -1 : left.edgeId > right.edgeId ? 1 : 0)
      || (left.toNodeId < right.toNodeId ? -1 : left.toNodeId > right.toNodeId ? 1 : 0)
  ));

  const allHalfEdges = [...outgoing.values()].flat().sort((left, right) => (
    (left.edgeId < right.edgeId ? -1 : left.edgeId > right.edgeId ? 1 : 0)
      || (left.fromNodeId < right.fromNodeId ? -1 : left.fromNodeId > right.fromNodeId ? 1 : 0)
  ));
  const visited = new Set();
  const cycles = [];
  for (const start of allHalfEdges) {
    if (visited.has(halfEdgeKey(start.edgeId, start.fromNodeId))) continue;
    const edgeIds = [];
    const nodeIds = [];
    const localVisited = new Set();
    let current = start;
    let closed = false;
    for (let step = 0; step <= allHalfEdges.length; step += 1) {
      const key = halfEdgeKey(current.edgeId, current.fromNodeId);
      if (localVisited.has(key)) {
        closed = key === halfEdgeKey(start.edgeId, start.fromNodeId);
        break;
      }
      localVisited.add(key);
      visited.add(key);
      edgeIds.push(current.edgeId);
      nodeIds.push(current.fromNodeId);
      const nextOptions = outgoing.get(current.toNodeId) ?? [];
      const twinIndex = nextOptions.findIndex(candidate => (
        candidate.edgeId === current.edgeId && candidate.toNodeId === current.fromNodeId
      ));
      if (twinIndex < 0 || nextOptions.length === 0) break;
      current = nextOptions[(twinIndex - 1 + nextOptions.length) % nextOptions.length];
    }
    if (!closed || nodeIds.length < 3) continue;
    nodeIds.push(nodeIds[0]);
    cycles.push({ edgeIds, nodeIds });
  }
  return { cycles, nodesById };
}

function validateCycleGeometry({ edgeIds, nodeIds }, nodesById) {
  if (edgeIds.length < 3 || nodeIds.length !== edgeIds.length + 1
    || nodeIds[0] !== nodeIds.at(-1)) return null;
  if (new Set(edgeIds).size !== edgeIds.length) return null;
  if (new Set(nodeIds.slice(0, -1)).size !== nodeIds.length - 1) return null;
  const points = nodeIds.slice(0, -1).map(nodeId => nodesById.get(nodeId)?.position);
  if (points.some(value => !value)) return null;
  if (hasSelfIntersection(points)) return null;
  const area = signedArea(points);
  if (area <= GEOMETRY_EPSILON) return null;
  return { points, area };
}

export function deriveBlockPolygon({ roadGraph, block } = {}) {
  const graph = requireRoadGraph(roadGraph);
  const nodesById = new Map(graph.nodes.map(node => [node.nodeId, node]));
  if (!Array.isArray(block?.boundaryNodeIds)) throw new TypeError('block.boundaryNodeIds is required');
  return Object.freeze(block.boundaryNodeIds.map((nodeId, index) => {
    const node = nodesById.get(nodeId);
    if (!node) throw new RangeError(`block boundary references unknown node at index ${index}`);
    return Object.freeze({ x: node.position.x, z: node.position.z });
  }));
}

async function expectedBlockId({ worldSeedHash, settlementId, boundaryEdgeIds }) {
  return createSettlementSemanticStableId({
    schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
    worldSeedHash,
    settlementId,
    semanticKind: 'block',
    semanticLocalKey: canonicalizeJson(normalizeBoundaryEdgeCycle(boundaryEdgeIds)),
  });
}

export async function validateRoadGraphV1Blocks({ worldSeedHash, roadGraph, blocks } = {}) {
  const graph = requireRoadGraph(roadGraph);
  if (!Array.isArray(blocks)) throw new TypeError('blocks must be an array');
  const errors = [];
  const nodeIds = new Set(graph.nodes.map(node => node.nodeId));
  const edgesById = new Map(graph.edges.map(edge => [edge.edgeId, edge]));
  const nodesById = new Map(graph.nodes.map(node => [node.nodeId, node]));
  const blockIds = new Set();
  const faceKeys = new Set();
  let duplicateEdgeCount = 0;
  let duplicateNodeCount = 0;
  let selfIntersectionCount = 0;
  let unknownReferenceCount = 0;
  let duplicateFaceCount = 0;
  let nonPositiveAreaCount = 0;
  let nonNormalizedWindingCount = 0;
  let discontinuousBoundaryCount = 0;
  let openBoundaryCount = 0;
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      errors.push('Block must be an object');
      continue;
    }
    if (typeof block.id !== 'string' || !block.id || blockIds.has(block.id)) {
      errors.push(`duplicate or invalid Block ID: ${block.id}`);
    }
    blockIds.add(block.id);
    const edgeIds = Array.isArray(block.boundaryEdgeIds) ? block.boundaryEdgeIds : [];
    const boundaryNodeIds = Array.isArray(block.boundaryNodeIds) ? block.boundaryNodeIds : [];
    if (block.isClosed !== true || boundaryNodeIds.length !== edgeIds.length + 1
      || boundaryNodeIds[0] !== boundaryNodeIds.at(-1)) openBoundaryCount += 1;
    duplicateEdgeCount += edgeIds.length - new Set(edgeIds).size;
    const openNodeIds = boundaryNodeIds.slice(0, -1);
    duplicateNodeCount += openNodeIds.length - new Set(openNodeIds).size;
    unknownReferenceCount += edgeIds.filter(edgeId => !edgesById.has(edgeId)).length;
    unknownReferenceCount += boundaryNodeIds.filter(nodeId => !nodeIds.has(nodeId)).length;
    for (let index = 0; index < edgeIds.length; index += 1) {
      const edge = edgesById.get(edgeIds[index]);
      const fromNodeId = boundaryNodeIds[index];
      const toNodeId = boundaryNodeIds[index + 1];
      if (!edge || !((edge.startNodeId === fromNodeId && edge.endNodeId === toNodeId)
        || (edge.endNodeId === fromNodeId && edge.startNodeId === toNodeId))) {
        discontinuousBoundaryCount += 1;
      }
    }
    if (edgeIds.length >= 3 && edgeIds.every(edgeId => typeof edgeId === 'string' && edgeId)) {
      const faceKey = canonicalizeJson(normalizeBoundaryEdgeCycle(edgeIds));
      if (faceKeys.has(faceKey)) duplicateFaceCount += 1;
      faceKeys.add(faceKey);
    }
    const points = openNodeIds.map(nodeId => nodesById.get(nodeId)?.position);
    if (points.length >= 3 && points.every(Boolean)) {
      if (hasSelfIntersection(points)) selfIntersectionCount += 1;
      const area = signedArea(points);
      if (area <= GEOMETRY_EPSILON) nonPositiveAreaCount += 1;
      if (area < -GEOMETRY_EPSILON) nonNormalizedWindingCount += 1;
    } else nonPositiveAreaCount += 1;
    if (block.districtTag !== null) errors.push(`Block ${block.id} districtTag must be null`);
    if (block.sourceRoadGraphVersion !== graph.schemaVersion) {
      errors.push(`Block ${block.id} sourceRoadGraphVersion mismatch`);
    }
    if (typeof block.id === 'string' && block.id && edgeIds.length >= 3) {
      const expected = await expectedBlockId({
        worldSeedHash,
        settlementId: graph.settlementId,
        boundaryEdgeIds: edgeIds,
      });
      if (block.id !== expected.stableId) errors.push(`Block ${block.id} Stable ID mismatch`);
    }
  }
  const counts = {
    duplicateEdgeCount,
    duplicateNodeCount,
    selfIntersectionCount,
    unknownReferenceCount,
    duplicateFaceCount,
    nonPositiveAreaCount,
    nonNormalizedWindingCount,
    discontinuousBoundaryCount,
    openBoundaryCount,
  };
  for (const [name, count] of Object.entries(counts)) {
    if (count) errors.push(`${name}: ${count}`);
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    ...counts,
  });
}

export async function createRoadGraphV1Blocks({ worldSeedHash, roadGraph } = {}) {
  const graph = requireRoadGraph(roadGraph);
  const { cycles, nodesById } = extractFaceCycles(graph);
  const faceKeys = new Set();
  const boundaries = [];
  for (const cycle of cycles) {
    if (!validateCycleGeometry(cycle, nodesById)) continue;
    const canonicalEdgeIds = normalizeBoundaryEdgeCycle(cycle.edgeIds);
    const faceKey = canonicalizeJson(canonicalEdgeIds);
    if (faceKeys.has(faceKey)) continue;
    faceKeys.add(faceKey);
    boundaries.push(rotateBoundary(cycle.edgeIds, cycle.nodeIds));
  }
  boundaries.sort((left, right) => compareCycles(left.edgeIds, right.edgeIds));
  const blocks = await Promise.all(boundaries.map(async boundary => {
    const identity = await expectedBlockId({
      worldSeedHash,
      settlementId: graph.settlementId,
      boundaryEdgeIds: boundary.edgeIds,
    });
    return Object.freeze({
      id: identity.stableId,
      boundaryEdgeIds: Object.freeze(boundary.edgeIds),
      boundaryNodeIds: Object.freeze(boundary.nodeIds),
      isClosed: true,
      districtTag: null,
      sourceRoadGraphVersion: graph.schemaVersion,
    });
  }));
  blocks.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const result = Object.freeze(blocks);
  const validation = await validateRoadGraphV1Blocks({ worldSeedHash, roadGraph: graph, blocks: result });
  if (!validation.valid) throw new Error(`invalid block-v1 result: ${validation.errors.join('; ')}`);
  return result;
}

export const BLOCK_V1_STAGE_GENERATOR = Object.freeze({
  stage: 'block',
  generatorId: BLOCK_GENERATOR_V1_ID,
  generate: createRoadGraphV1Blocks,
});
