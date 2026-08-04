import { SETTLEMENT_TYPES } from '../settlement-type.js';
import { SETTLEMENT_ROAD_PARAMETERS } from '../settlement-road-parameters.js';
import { SETTLEMENT_NODE_QUANTIZATION } from './canonical-settlement-plan.js';
import {
  BLOCK_GENERATOR_V1_ID,
  createRoadGraphV1Blocks,
} from './block-generator-v1.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import {
  ROAD_GRAPH_CLASSES,
  ROAD_GRAPH_V1_GENERATOR_ID,
  ROAD_GRAPH_V1_SCHEMA,
  ROAD_GRAPH_V1_SEGMENT_SCHEMA,
} from './road-graph-v1.js';
import {
  createSemanticIdKeyedRandom,
  createSettlementSemanticStableId,
  SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
} from './settlement-semantic-identity.js';
import { createSettlementStageGeneratorRegistry } from './settlement-stage-generator-registry.js';

export const ROAD_GRAPH_V2_GENERATOR_ID = 'road-graph-v2';
// Phase B-2 evolves the generator while retaining the Block-v1 Road Graph contract.
export const ROAD_GRAPH_V2_SCHEMA = ROAD_GRAPH_V1_SCHEMA;
export const ROAD_GRAPH_V2_PROFILE_REVISION = 'road-graph-profile-2';
export const ROAD_GRAPH_V2_SEGMENT_SCHEMA = ROAD_GRAPH_V1_SEGMENT_SCHEMA;
export const ROAD_GRAPH_V2_ISOLATED_FALLBACK = 'PARALLEL_COLLECTORS_WITH_LOCAL_BLOCK_BOUNDARIES';

const ROAD_CLASS_SET = new Set(Object.values(ROAD_GRAPH_CLASSES));
const SETTLEMENT_CLASS_SET = new Set(Object.values(SETTLEMENT_TYPES));
const GEOMETRY_EPSILON = 1e-9;
const q6 = value => {
  const rounded = Math.round(value / SETTLEMENT_NODE_QUANTIZATION.gridWidthMeters)
    * SETTLEMENT_NODE_QUANTIZATION.gridWidthMeters;
  return Object.is(rounded, -0) ? 0 : Number(rounded.toFixed(6));
};
const point = (x, z) => Object.freeze({ x: q6(x), z: q6(z) });
const coordinateKey = value => `${value.x},${value.z}`;

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} is required`);
  return value;
}

function normalizeGateway(gateway, index) {
  requireRecord(gateway, `gateways[${index}]`);
  const target = gateway.target ?? gateway.center;
  if (![target?.x, target?.z].every(Number.isFinite)) {
    throw new TypeError(`gateways[${index}] requires a logical target position`);
  }
  return Object.freeze({
    gatewayId: requireString(gateway.gatewayId ?? gateway.stableId, `gateways[${index}].gatewayId`),
    targetSettlementId: requireString(
      gateway.targetSettlementId ?? gateway.settlementId,
      `gateways[${index}].targetSettlementId`,
    ),
    target: point(target.x, target.z),
    sourceOwner: Object.freeze({ ...(gateway.sourceOwner ?? {}) }),
  });
}

function roadWidths(settlementType) {
  const profile = SETTLEMENT_ROAD_PARAMETERS[settlementType];
  if (!profile) throw new RangeError(`unsupported Settlement class: ${settlementType}`);
  return Object.freeze({
    [ROAD_GRAPH_CLASSES.ARTERIAL]: q6(profile.majorWidth / 40),
    [ROAD_GRAPH_CLASSES.COLLECTOR]: q6((profile.majorWidth + profile.localWidth) / 80),
    [ROAD_GRAPH_CLASSES.LOCAL]: q6(profile.localWidth / 40),
    [ROAD_GRAPH_CLASSES.ALLEY]: q6(profile.alleyWidth / 40),
  });
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

export function validateRoadGraphV2(graph) {
  const errors = [];
  if (graph?.schemaVersion !== ROAD_GRAPH_V2_SCHEMA) errors.push('invalid Road Graph schema');
  if (graph?.generatorId !== ROAD_GRAPH_V2_GENERATOR_ID) errors.push('invalid Road Graph generator');
  if (graph?.profileRevision !== ROAD_GRAPH_V2_PROFILE_REVISION) errors.push('invalid profile revision');
  if (graph?.coordinateSpace !== 'logical-world-meters') errors.push('Road Graph must use logical coordinates');
  if (!SETTLEMENT_CLASS_SET.has(graph?.legacySettlementClass)) errors.push('invalid legacy Settlement class');
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const segments = Array.isArray(graph?.segments) ? graph.segments : [];
  if (!Array.isArray(graph?.nodes)) errors.push('Road Graph nodes must be an array');
  if (!Array.isArray(graph?.edges)) errors.push('Road Graph edges must be an array');
  if (!Array.isArray(graph?.segments)) errors.push('Road Graph segments must be an array');

  const nodeIds = new Set();
  const nodePositions = new Set();
  let duplicateNodeCount = 0;
  let duplicateNodePositionCount = 0;
  for (const node of nodes) {
    if (typeof node?.nodeId !== 'string' || !node.nodeId || nodeIds.has(node.nodeId)) {
      duplicateNodeCount += 1;
    } else nodeIds.add(node.nodeId);
    if (node?.stableId !== node?.nodeId) errors.push('Road Node stableId must equal nodeId');
    if (![node?.position?.x, node?.position?.z].every(Number.isFinite)) {
      errors.push(`Road Node position is invalid: ${node?.nodeId}`);
    } else {
      const key = coordinateKey(node.position);
      if (nodePositions.has(key)) duplicateNodePositionCount += 1;
      nodePositions.add(key);
    }
  }
  if (duplicateNodeCount) errors.push(`duplicate Road Node count: ${duplicateNodeCount}`);
  if (duplicateNodePositionCount) errors.push(`duplicate Road Node position count: ${duplicateNodePositionCount}`);

  const edgeIds = new Set();
  const undirectedEdges = new Set();
  const degree = new Map([...nodeIds].map(nodeId => [nodeId, 0]));
  let duplicateEdgeCount = 0;
  let orphanEdgeCount = 0;
  let selfLoopCount = 0;
  for (const edge of edges) {
    if (typeof edge?.edgeId !== 'string' || !edge.edgeId || edgeIds.has(edge.edgeId)) {
      duplicateEdgeCount += 1;
    } else edgeIds.add(edge.edgeId);
    const endpointKey = [edge?.startNodeId, edge?.endNodeId].sort().join('\u0000');
    if (undirectedEdges.has(endpointKey)) duplicateEdgeCount += 1;
    undirectedEdges.add(endpointKey);
    if (!nodeIds.has(edge?.startNodeId) || !nodeIds.has(edge?.endNodeId)) orphanEdgeCount += 1;
    if (edge?.startNodeId === edge?.endNodeId) selfLoopCount += 1;
    if (edge?.stableId !== edge?.edgeId) errors.push('Road Edge stableId must equal edgeId');
    if (!ROAD_CLASS_SET.has(edge?.class)) errors.push(`invalid Road Edge class: ${edge?.edgeId}`);
    if (edge?.profileRevision !== ROAD_GRAPH_V2_PROFILE_REVISION) {
      errors.push(`invalid Road Edge profile: ${edge?.edgeId}`);
    }
    if (degree.has(edge?.startNodeId)) degree.set(edge.startNodeId, degree.get(edge.startNodeId) + 1);
    if (degree.has(edge?.endNodeId)) degree.set(edge.endNodeId, degree.get(edge.endNodeId) + 1);
  }
  if (duplicateEdgeCount) errors.push(`duplicate Road Edge count: ${duplicateEdgeCount}`);
  if (orphanEdgeCount) errors.push(`orphan Road Edge count: ${orphanEdgeCount}`);
  if (selfLoopCount) errors.push(`self-loop Road Edge count: ${selfLoopCount}`);
  const orphanNodeCount = [...degree.values()].filter(value => value === 0).length;
  if (orphanNodeCount) errors.push(`orphan Road Node count: ${orphanNodeCount}`);

  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  let selfIntersectionCount = 0;
  for (let firstIndex = 0; firstIndex < edges.length; firstIndex += 1) {
    const first = edges[firstIndex];
    const firstStart = nodesById.get(first.startNodeId)?.position;
    const firstEnd = nodesById.get(first.endNodeId)?.position;
    if (!firstStart || !firstEnd) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < edges.length; secondIndex += 1) {
      const second = edges[secondIndex];
      if ([first.startNodeId, first.endNodeId].some(nodeId => (
        nodeId === second.startNodeId || nodeId === second.endNodeId
      ))) continue;
      const secondStart = nodesById.get(second.startNodeId)?.position;
      const secondEnd = nodesById.get(second.endNodeId)?.position;
      if (secondStart && secondEnd && segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) {
        selfIntersectionCount += 1;
      }
    }
  }
  if (selfIntersectionCount) errors.push(`self-intersection count: ${selfIntersectionCount}`);

  const segmentIds = new Set();
  for (const segment of segments) {
    if (segment?.schemaVersion !== ROAD_GRAPH_V2_SEGMENT_SCHEMA) errors.push('invalid segment schema');
    if (segmentIds.has(segment?.stableId)) errors.push(`duplicate Road Segment: ${segment.stableId}`);
    segmentIds.add(segment?.stableId);
    const edge = edges.find(value => value.edgeId === segment?.edgeId);
    if (!edge) errors.push(`Road Segment has no Edge: ${segment?.stableId}`);
    else {
      const start = nodesById.get(edge.startNodeId)?.position;
      const end = nodesById.get(edge.endNodeId)?.position;
      if (coordinateKey(segment.start) !== coordinateKey(start)
        || coordinateKey(segment.end) !== coordinateKey(end)) {
        errors.push(`Road Segment endpoints do not match Edge: ${segment.stableId}`);
      }
    }
  }
  if (segments.length !== edges.length) errors.push('Road Graph requires exactly one Segment per Edge');

  const adjacency = new Map([...nodeIds].map(nodeId => [nodeId, []]));
  for (const edge of edges) {
    adjacency.get(edge.startNodeId)?.push(edge.endNodeId);
    adjacency.get(edge.endNodeId)?.push(edge.startNodeId);
  }
  const reachable = new Set();
  const pending = nodes[0] ? [nodes[0].nodeId] : [];
  while (pending.length) {
    const nodeId = pending.pop();
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    pending.push(...(adjacency.get(nodeId) ?? []));
  }
  const disconnectedNodeCount = nodes.length - reachable.size;
  if (disconnectedNodeCount) errors.push(`disconnected Road Node count: ${disconnectedNodeCount}`);
  const requiredGatewayNodeIds = graph?.metadata?.requiredGatewayNodeIds ?? [];
  const disconnectedRequiredGatewayCount = requiredGatewayNodeIds
    .filter(nodeId => !reachable.has(nodeId)).length;
  if (disconnectedRequiredGatewayCount) {
    errors.push(`${disconnectedRequiredGatewayCount} required connectivity gateways are disconnected`);
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    duplicateNodeCount,
    duplicateNodePositionCount,
    duplicateEdgeCount,
    orphanEdgeCount,
    orphanNodeCount,
    selfLoopCount,
    selfIntersectionCount,
    disconnectedNodeCount,
    disconnectedRequiredGatewayCount,
  });
}

export async function createRoadGraphV2({
  worldSeedHash,
  settlement,
  gateways = [],
} = {}) {
  requireRecord(settlement, 'settlement');
  const settlementId = requireString(
    settlement.settlementId ?? settlement.semanticId,
    'settlement.settlementId',
  );
  const legacySettlementClass = settlement.legacySettlementClass ?? settlement.settlementType;
  if (!SETTLEMENT_CLASS_SET.has(legacySettlementClass)) {
    throw new RangeError('settlement requires CITY, TOWN, or RURAL legacy class');
  }
  if (![settlement.center?.x, settlement.center?.z, settlement.radiusMeters].every(Number.isFinite)
    || settlement.radiusMeters <= 0) {
    throw new TypeError('settlement requires a logical center and positive radiusMeters');
  }
  const center = point(settlement.center.x, settlement.center.z);
  const radius = q6(settlement.radiusMeters);
  const sourceOwner = Object.freeze({
    settlementId,
    macroRegion: Object.freeze({ ...(settlement.sourceOwner?.macroRegion ?? settlement.macroRegion ?? {}) }),
  });
  const sortedGateways = Object.freeze(gateways.map(normalizeGateway)
    .sort((left, right) => left.gatewayId.localeCompare(right.gatewayId)));
  const random = await createSemanticIdKeyedRandom({
    worldSeedHash,
    semanticStableId: settlementId,
  });

  let axis;
  let normal;
  if (sortedGateways.length) {
    const first = sortedGateways[0];
    const dx = first.target.x - center.x;
    const dz = first.target.z - center.z;
    const length = Math.hypot(dx, dz);
    if (length <= SETTLEMENT_NODE_QUANTIZATION.epsilonMeters) {
      throw new RangeError('connectivity gateway target cannot equal Settlement center');
    }
    normal = { x: dx / length, z: dz / length };
    axis = { x: -normal.z, z: normal.x };
  } else {
    const angle = await random.float01('isolated-collector-axis-v2') * Math.PI;
    axis = { x: Math.cos(angle), z: Math.sin(angle) };
    normal = { x: -axis.z, z: axis.x };
  }

  const widths = roadWidths(legacySettlementClass);
  const nodes = [];
  const edges = [];
  const collectorHalfSpacing = radius * (
    legacySettlementClass === SETTLEMENT_TYPES.RURAL ? 0.20 : 0.23
  );
  const collectorHalfLength = radius * 0.62;
  const localBoundaryCount = Object.freeze({
    [SETTLEMENT_TYPES.CITY]: 4,
    [SETTLEMENT_TYPES.TOWN]: 3,
    [SETTLEMENT_TYPES.RURAL]: 2,
  })[legacySettlementClass];
  const localScalars = Array.from({ length: localBoundaryCount }, (_, index) => (
    radius * (-0.42 + index * 0.84 / (localBoundaryCount - 1))
  ));
  const gatewaySpecs = sortedGateways.map((gateway, index) => {
    const dx = gateway.target.x - center.x;
    const dz = gateway.target.z - center.z;
    const side = dx * normal.x + dz * normal.z >= 0 ? 1 : -1;
    return Object.freeze({
      gateway,
      side,
      scalar: radius * (-0.50 + (index + 1) / (sortedGateways.length + 1)),
    });
  });
  const stationReasons = new Map();
  const stationKey = (side, scalar) => `${side}:${q6(scalar)}`;
  const addStationReason = (side, scalar, reason) => {
    const key = stationKey(side, scalar);
    const station = stationReasons.get(key) ?? { side, scalar: q6(scalar), reasons: [] };
    station.reasons.push(reason);
    stationReasons.set(key, station);
  };
  for (const side of [-1, 1]) {
    addStationReason(side, -collectorHalfLength, 'collector-terminal:start');
    addStationReason(side, collectorHalfLength, 'collector-terminal:end');
    localScalars.forEach((scalar, index) => addStationReason(side, scalar, `local-boundary:${index}`));
  }
  gatewaySpecs.forEach(spec => addStationReason(
    spec.side,
    spec.scalar,
    `gateway-junction:${spec.gateway.gatewayId}`,
  ));

  async function addNode(role, position, purpose, extra = {}) {
    const logicalPosition = point(position.x, position.z);
    const identity = await createSettlementSemanticStableId({
      schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
      worldSeedHash,
      settlementId,
      semanticKind: 'road-node',
      semanticLocalKey: canonicalizeJson({
        settlementSemanticId: settlementId,
        nodeRole: role,
        logicalPosition,
        purpose,
      }),
    });
    const node = Object.freeze({
      nodeId: identity.stableId,
      stableId: identity.stableId,
      role,
      position: logicalPosition,
      purpose,
      ...extra,
    });
    nodes.push(node);
    return node;
  }

  async function addEdge(startNode, endNode, roadClass, purpose, flags = {}) {
    const endpointNodeIds = [startNode.nodeId, endNode.nodeId].sort();
    const identity = await createSettlementSemanticStableId({
      schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
      worldSeedHash,
      settlementId,
      semanticKind: 'road-edge',
      semanticLocalKey: canonicalizeJson({
        endpointNodeIds,
        roadClass,
        edgePurpose: purpose,
        profileRevision: ROAD_GRAPH_V2_PROFILE_REVISION,
      }),
    });
    const edge = Object.freeze({
      edgeId: identity.stableId,
      stableId: identity.stableId,
      startNodeId: startNode.nodeId,
      endNodeId: endNode.nodeId,
      class: roadClass,
      purpose,
      profileRevision: ROAD_GRAPH_V2_PROFILE_REVISION,
      sourceOwner,
      flags: Object.freeze({ ...flags }),
    });
    edges.push(edge);
    return edge;
  }

  const stationsByKey = new Map();
  for (const station of [...stationReasons.values()].sort((left, right) => (
    left.side - right.side || left.scalar - right.scalar
  ))) {
    station.reasons.sort();
    const hasGateway = station.reasons.some(reason => reason.startsWith('gateway-junction:'));
    const hasLocal = station.reasons.some(reason => reason.startsWith('local-boundary:'));
    const role = hasGateway ? 'gateway-junction' : hasLocal ? 'local-junction' : 'collector-terminal';
    const purpose = `collector-station:${station.side}:${station.reasons.join('|')}`;
    const node = await addNode(role, {
      x: center.x + axis.x * station.scalar + normal.x * collectorHalfSpacing * station.side,
      z: center.z + axis.z * station.scalar + normal.z * collectorHalfSpacing * station.side,
    }, purpose);
    stationsByKey.set(stationKey(station.side, station.scalar), node);
  }

  for (const side of [-1, 1]) {
    const sideStations = [...stationReasons.values()]
      .filter(station => station.side === side)
      .sort((left, right) => left.scalar - right.scalar);
    for (let index = 1; index < sideStations.length; index += 1) {
      const start = stationsByKey.get(stationKey(side, sideStations[index - 1].scalar));
      const end = stationsByKey.get(stationKey(side, sideStations[index].scalar));
      await addEdge(start, end, ROAD_GRAPH_CLASSES.COLLECTOR,
        `collector-corridor:${side}:${index - 1}`, {
          frontageEligible: true,
          routeId: `${settlementId}:collector:${side}`,
          routeOrder: index - 1,
        });
    }
  }

  const localBoundaryNodes = [];
  for (let index = 0; index < localScalars.length; index += 1) {
    const scalar = localScalars[index];
    const start = stationsByKey.get(stationKey(-1, scalar));
    const end = stationsByKey.get(stationKey(1, scalar));
    localBoundaryNodes.push(Object.freeze({ start, end }));
    await addEdge(start, end, ROAD_GRAPH_CLASSES.LOCAL, `block-boundary-local:${index}`, {
      frontageEligible: true,
      blockBoundary: true,
      routeId: `${settlementId}:local-boundary:${index}`,
      routeOrder: 0,
    });
  }

  const requiredGatewayNodeIds = [];
  for (const spec of gatewaySpecs) {
    const junction = stationsByKey.get(stationKey(spec.side, spec.scalar));
    const terminal = await addNode('connectivity-gateway', {
      x: junction.position.x + normal.x * spec.side * (radius * 0.92 - collectorHalfSpacing),
      z: junction.position.z + normal.z * spec.side * (radius * 0.92 - collectorHalfSpacing),
    }, `connectivity-gateway:${spec.gateway.gatewayId}`, {
      gatewayId: spec.gateway.gatewayId,
      targetSettlementId: spec.gateway.targetSettlementId,
    });
    requiredGatewayNodeIds.push(terminal.nodeId);
    await addEdge(terminal, junction, ROAD_GRAPH_CLASSES.ARTERIAL,
      `connectivity-gateway:${spec.gateway.gatewayId}`, {
        frontageEligible: false,
        connectivityGateway: true,
        targetSettlementId: spec.gateway.targetSettlementId,
        routeId: `${settlementId}:arterial:${spec.gateway.gatewayId}`,
        routeOrder: 0,
      });
  }

  const alleyCount = SETTLEMENT_ROAD_PARAMETERS[legacySettlementClass].alleyCount;
  for (let index = 0; index < alleyCount; index += 1) {
    const boundary = localBoundaryNodes[index % localBoundaryNodes.length];
    const side = Math.floor(index / localBoundaryNodes.length) % 2 === 0 ? -1 : 1;
    const parent = side === -1 ? boundary.start : boundary.end;
    const terminal = await addNode('alley-terminal', {
      x: parent.position.x + normal.x * side * radius * 0.18,
      z: parent.position.z + normal.z * side * radius * 0.18,
    }, `alley-terminal:${index}`);
    await addEdge(parent, terminal, ROAD_GRAPH_CLASSES.ALLEY, `alley-branch:${index}`, {
      frontageEligible: true,
      routeId: `${settlementId}:alley:${index}`,
      routeOrder: 0,
    });
  }

  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const segments = edges.map(edge => {
    const start = nodesById.get(edge.startNodeId).position;
    const end = nodesById.get(edge.endNodeId).position;
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    const tangent = Object.freeze({ x: dx / length, z: dz / length });
    return Object.freeze({
      schemaVersion: ROAD_GRAPH_V2_SEGMENT_SCHEMA,
      stableId: edge.edgeId,
      edgeId: edge.edgeId,
      class: edge.class,
      start,
      end,
      tangent,
      normal: Object.freeze({ x: -tangent.z, z: tangent.x }),
      widthMeters: widths[edge.class],
      sourceOwner,
      purpose: edge.purpose,
      flags: edge.flags,
    });
  });
  const gatewayMode = sortedGateways.length ? 'CONNECTIVITY_GATEWAYS' : 'ISOLATED_FALLBACK';
  const graph = Object.freeze({
    schemaVersion: ROAD_GRAPH_V2_SCHEMA,
    generatorId: ROAD_GRAPH_V2_GENERATOR_ID,
    profileRevision: ROAD_GRAPH_V2_PROFILE_REVISION,
    coordinateSpace: 'logical-world-meters',
    settlementId,
    legacySettlementClass,
    center,
    sourceOwner,
    metadata: Object.freeze({
      gatewayMode,
      fallbackType: sortedGateways.length ? null : ROAD_GRAPH_V2_ISOLATED_FALLBACK,
      requiredGatewayIds: Object.freeze(sortedGateways.map(gateway => gateway.gatewayId)),
      requiredGatewayNodeIds: Object.freeze([...requiredGatewayNodeIds].sort()),
      fictitiousGatewayCount: 0,
      authority: ROAD_GRAPH_V2_GENERATOR_ID,
      planar: true,
      localBlockBoundaryCount: localBoundaryCount,
      blockCandidateCount: localBoundaryCount - 1,
    }),
    nodes: Object.freeze(nodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId))),
    edges: Object.freeze(edges.sort((left, right) => left.edgeId.localeCompare(right.edgeId))),
    segments: Object.freeze(segments.sort((left, right) => left.stableId.localeCompare(right.stableId))),
  });
  const validation = validateRoadGraphV2(graph);
  if (!validation.valid) throw new Error(`invalid road-graph-v2: ${validation.errors.join('; ')}`);
  return graph;
}

function asBlockV1RoadGraph(roadGraph) {
  if (roadGraph?.schemaVersion !== ROAD_GRAPH_V2_SCHEMA
    || roadGraph?.generatorId !== ROAD_GRAPH_V2_GENERATOR_ID) {
    throw new TypeError('road-graph-v2 is required');
  }
  return Object.freeze({ ...roadGraph, generatorId: ROAD_GRAPH_V1_GENERATOR_ID });
}

export async function createRoadGraphV2Blocks({ worldSeedHash, roadGraph } = {}) {
  return createRoadGraphV1Blocks({
    worldSeedHash,
    roadGraph: asBlockV1RoadGraph(roadGraph),
  });
}

export const ROAD_GRAPH_V2_STAGE_GENERATOR = Object.freeze({
  stage: 'roadGraph',
  generatorId: ROAD_GRAPH_V2_GENERATOR_ID,
  generate: createRoadGraphV2,
});

export const ROAD_GRAPH_V2_BLOCK_STAGE_GENERATOR = Object.freeze({
  stage: 'block',
  generatorId: BLOCK_GENERATOR_V1_ID,
  generate: createRoadGraphV2Blocks,
});

const experimentalRegistry = createSettlementStageGeneratorRegistry();
experimentalRegistry.register(ROAD_GRAPH_V2_STAGE_GENERATOR);
experimentalRegistry.register(ROAD_GRAPH_V2_BLOCK_STAGE_GENERATOR);
experimentalRegistry.freeze();

export const ROAD_GRAPH_V2_EXPERIMENTAL_STAGE_GENERATOR_REGISTRY = experimentalRegistry;
