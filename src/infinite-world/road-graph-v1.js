import { SETTLEMENT_TYPES } from '../settlement-type.js';
import { SETTLEMENT_ROAD_PARAMETERS } from '../settlement-road-parameters.js';
import { SETTLEMENT_NODE_QUANTIZATION } from './canonical-settlement-plan.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import {
  createSemanticIdKeyedRandom,
  createSettlementSemanticStableId,
  SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
} from './settlement-semantic-identity.js';
import { createSettlementStageGeneratorRegistry } from './settlement-stage-generator-registry.js';

export const ROAD_GRAPH_V1_GENERATOR_ID = 'road-graph-v1';
export const ROAD_GRAPH_V1_SCHEMA = 'settlement-road-graph-v1';
export const ROAD_GRAPH_V1_PROFILE_REVISION = 'road-graph-profile-1';
export const ROAD_GRAPH_V1_SEGMENT_SCHEMA = 'settlement-road-segment-1';

export const ROAD_GRAPH_CLASSES = Object.freeze({
  ARTERIAL: 'arterial',
  COLLECTOR: 'collector',
  LOCAL: 'local',
  ALLEY: 'alley',
});

export const ROAD_GRAPH_ISOLATED_FALLBACK = 'OFFSET_COLLECTOR_SPINE_WITH_LOCAL_BRANCHES';

const ROAD_CLASS_SET = new Set(Object.values(ROAD_GRAPH_CLASSES));
const LEGACY_CLASS_SET = new Set(Object.values(SETTLEMENT_TYPES));
const q6 = value => {
  const rounded = Math.round(value / SETTLEMENT_NODE_QUANTIZATION.gridWidthMeters)
    * SETTLEMENT_NODE_QUANTIZATION.gridWidthMeters;
  return Object.is(rounded, -0) ? 0 : Number(rounded.toFixed(6));
};
const point = (x, z) => Object.freeze({ x: q6(x), z: q6(z) });
const vectorLength = value => Math.hypot(value.x, value.z);

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function samePoint(first, second) {
  return first?.x === second?.x && first?.z === second?.z;
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

function validateLogicalPoint(value, label, errors) {
  if (![value?.x, value?.z].every(Number.isFinite)) {
    errors.push(`${label} must be a finite logical position`);
    return;
  }
  for (const axis of ['x', 'z']) {
    const quantized = q6(value[axis]);
    if (Math.abs(value[axis] - quantized) > SETTLEMENT_NODE_QUANTIZATION.epsilonMeters) {
      errors.push(`${label}.${axis} is not quantized`);
    }
  }
}

export function validateRoadGraphV1Segment(segment) {
  const errors = [];
  if (segment?.schemaVersion !== ROAD_GRAPH_V1_SEGMENT_SCHEMA) errors.push('invalid segment schema');
  if (typeof segment?.stableId !== 'string' || !segment.stableId) errors.push('segment Stable ID is required');
  if (!ROAD_CLASS_SET.has(segment?.class)) errors.push('invalid segment class');
  validateLogicalPoint(segment?.start, 'segment.start', errors);
  validateLogicalPoint(segment?.end, 'segment.end', errors);
  for (const [label, vector] of [['tangent', segment?.tangent], ['normal', segment?.normal]]) {
    if (![vector?.x, vector?.z].every(Number.isFinite)) errors.push(`${label} must be finite`);
    else if (Math.abs(vectorLength(vector) - 1) > 0.000001) errors.push(`${label} must be unit length`);
  }
  if ([segment?.tangent?.x, segment?.tangent?.z, segment?.normal?.x, segment?.normal?.z]
    .every(Number.isFinite)
    && Math.abs(segment.tangent.x * segment.normal.x
      + segment.tangent.z * segment.normal.z) > 0.000001) errors.push('segment tangent and normal must be perpendicular');
  if (!Number.isFinite(segment?.widthMeters) || segment.widthMeters <= 0) errors.push('segment width is invalid');
  if (!segment?.sourceOwner || typeof segment.sourceOwner !== 'object') errors.push('segment source owner is required');
  if (typeof segment?.purpose !== 'string' || !segment.purpose) errors.push('segment purpose is required');
  if (!segment?.flags || typeof segment.flags !== 'object') errors.push('segment flags are required');
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function validateRoadGraphV1(graph) {
  const errors = [];
  if (graph?.schemaVersion !== ROAD_GRAPH_V1_SCHEMA) errors.push('invalid Road Graph schema');
  if (graph?.generatorId !== ROAD_GRAPH_V1_GENERATOR_ID) errors.push('invalid Road Graph generator');
  if (graph?.profileRevision !== ROAD_GRAPH_V1_PROFILE_REVISION) errors.push('invalid profile revision');
  if (graph?.coordinateSpace !== 'logical-world-meters') errors.push('Road Graph must use logical coordinates');
  if (!LEGACY_CLASS_SET.has(graph?.legacySettlementClass)) errors.push('invalid legacy Settlement class');
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const segments = Array.isArray(graph?.segments) ? graph.segments : [];
  if (!Array.isArray(graph?.nodes)) errors.push('Road Graph nodes must be an array');
  if (!Array.isArray(graph?.edges)) errors.push('Road Graph edges must be an array');
  if (!Array.isArray(graph?.segments)) errors.push('Road Graph segments must be an array');
  const nodeIds = new Set();
  for (const node of nodes) {
    if (typeof node?.nodeId !== 'string' || !node.nodeId) errors.push('invalid Road Node ID');
    else if (nodeIds.has(node.nodeId)) errors.push(`duplicate Road Node: ${node.nodeId}`);
    else nodeIds.add(node.nodeId);
    if (node?.stableId !== node?.nodeId) errors.push('Road Node stableId must equal nodeId');
    validateLogicalPoint(node?.position, `node ${node?.nodeId}`, errors);
    if (typeof node?.role !== 'string' || !node.role) errors.push('Road Node role is required');
    if (typeof node?.purpose !== 'string' || !node.purpose) errors.push('Road Node purpose is required');
  }
  const edgeIds = new Set();
  const adjacency = new Map([...nodeIds].map(nodeId => [nodeId, new Set()]));
  for (const edge of edges) {
    if (typeof edge?.edgeId !== 'string' || !edge.edgeId) errors.push('invalid Road Edge ID');
    else if (edgeIds.has(edge.edgeId)) errors.push(`duplicate Road Edge: ${edge.edgeId}`);
    else edgeIds.add(edge.edgeId);
    if (edge?.stableId !== edge?.edgeId) errors.push('Road Edge stableId must equal edgeId');
    if (!nodeIds.has(edge?.startNodeId) || !nodeIds.has(edge?.endNodeId)) errors.push(`orphan Road Edge: ${edge?.edgeId}`);
    if (edge?.startNodeId === edge?.endNodeId) errors.push(`self-loop Road Edge: ${edge?.edgeId}`);
    if (!ROAD_CLASS_SET.has(edge?.class)) errors.push(`invalid Road Edge class: ${edge?.edgeId}`);
    adjacency.get(edge?.startNodeId)?.add(edge?.endNodeId);
    adjacency.get(edge?.endNodeId)?.add(edge?.startNodeId);
  }
  const segmentIds = new Set();
  for (const segment of segments) {
    const validation = validateRoadGraphV1Segment(segment);
    errors.push(...validation.errors.map(error => `${segment?.stableId ?? 'segment'}: ${error}`));
    if (segmentIds.has(segment?.stableId)) errors.push(`duplicate Road Segment: ${segment.stableId}`);
    segmentIds.add(segment?.stableId);
    const edge = edges.find(candidate => candidate.edgeId === segment?.edgeId);
    if (!edge) errors.push(`Road Segment has no Edge: ${segment?.stableId}`);
    else {
      const start = nodes.find(node => node.nodeId === edge.startNodeId)?.position;
      const end = nodes.find(node => node.nodeId === edge.endNodeId)?.position;
      if (!samePoint(segment.start, start) || !samePoint(segment.end, end)) {
        errors.push(`Road Segment endpoints do not match Edge: ${segment.stableId}`);
      }
    }
  }
  if (segments.length !== edges.length) errors.push('Road Graph requires exactly one Segment per Edge');
  const requiredGatewayNodeIds = graph?.metadata?.requiredGatewayNodeIds ?? [];
  let disconnectedRequiredGatewayCount = 0;
  const root = nodes.find(node => node.role === 'collector-terminal')?.nodeId ?? nodes[0]?.nodeId;
  const reachable = new Set();
  if (root) {
    const pending = [root];
    while (pending.length) {
      const nodeId = pending.pop();
      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      for (const neighbor of adjacency.get(nodeId) ?? []) pending.push(neighbor);
    }
  }
  for (const nodeId of requiredGatewayNodeIds) {
    if (!nodeIds.has(nodeId) || !reachable.has(nodeId)) disconnectedRequiredGatewayCount += 1;
  }
  if (disconnectedRequiredGatewayCount) {
    errors.push(`${disconnectedRequiredGatewayCount} required connectivity gateways are disconnected`);
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    duplicateNodeCount: nodes.length - nodeIds.size,
    duplicateEdgeCount: edges.length - edgeIds.size,
    orphanEdgeCount: edges.filter(edge => (
      !nodeIds.has(edge?.startNodeId) || !nodeIds.has(edge?.endNodeId)
    )).length,
    selfLoopCount: edges.filter(edge => edge?.startNodeId === edge?.endNodeId).length,
    disconnectedRequiredGatewayCount,
  });
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

export async function createRoadGraphV1({
  worldSeedHash,
  settlement,
  gateways = [],
} = {}) {
  requireRecord(settlement, 'settlement');
  const settlementId = requireString(
    settlement.settlementId ?? settlement.semanticId,
    'settlement.settlementId',
  );
  if (!LEGACY_CLASS_SET.has(settlement.legacySettlementClass ?? settlement.settlementType)) {
    throw new RangeError('settlement requires CITY, TOWN, or RURAL legacy class');
  }
  const legacySettlementClass = settlement.legacySettlementClass ?? settlement.settlementType;
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
  if (sortedGateways.length) {
    const first = sortedGateways[0];
    const dx = first.target.x - center.x;
    const dz = first.target.z - center.z;
    const length = Math.hypot(dx, dz);
    if (length <= SETTLEMENT_NODE_QUANTIZATION.epsilonMeters) {
      throw new RangeError('connectivity gateway target cannot equal Settlement center');
    }
    axis = { x: -dz / length, z: dx / length };
  } else {
    const angle = await random.float01('isolated-collector-axis') * Math.PI;
    axis = { x: Math.cos(angle), z: Math.sin(angle) };
  }
  const normal = { x: -axis.z, z: axis.x };
  const offsetSign = await random.float01('collector-offset-side') < 0.5 ? -1 : 1;
  const spineCenter = point(
    center.x + normal.x * radius * 0.12 * offsetSign,
    center.z + normal.z * radius * 0.12 * offsetSign,
  );
  const widths = roadWidths(legacySettlementClass);
  const nodes = [];
  const edges = [];

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
        profileRevision: ROAD_GRAPH_V1_PROFILE_REVISION,
      }),
    });
    const edge = Object.freeze({
      edgeId: identity.stableId,
      stableId: identity.stableId,
      startNodeId: startNode.nodeId,
      endNodeId: endNode.nodeId,
      class: roadClass,
      purpose,
      profileRevision: ROAD_GRAPH_V1_PROFILE_REVISION,
      sourceOwner,
      flags: Object.freeze({ ...flags }),
    });
    edges.push(edge);
    return edge;
  }

  const localCount = SETTLEMENT_ROAD_PARAMETERS[legacySettlementClass].localBranchCount;
  const alleyCount = SETTLEMENT_ROAD_PARAMETERS[legacySettlementClass].alleyCount;
  const spineSpecs = [
    { scalar: -radius * 0.62, role: 'collector-terminal', purpose: 'collector:start' },
    { scalar: radius * 0.62, role: 'collector-terminal', purpose: 'collector:end' },
  ];
  for (let index = 0; index < sortedGateways.length; index += 1) {
    const scalar = radius * (-0.36 + (index + 1) * 0.72 / (sortedGateways.length + 1));
    spineSpecs.push({
      scalar,
      role: 'gateway-junction',
      purpose: `gateway-junction:${sortedGateways[index].gatewayId}`,
      gateway: sortedGateways[index],
    });
  }
  for (let index = 0; index < localCount; index += 1) {
    const scalar = radius * (-0.50 + (index + 1) / (localCount + 1));
    spineSpecs.push({ scalar, role: 'local-junction', purpose: `local-junction:${index}`, localIndex: index });
  }
  spineSpecs.sort((left, right) => left.scalar - right.scalar || left.purpose.localeCompare(right.purpose));
  for (const spec of spineSpecs) {
    spec.node = await addNode(spec.role, {
      x: spineCenter.x + axis.x * spec.scalar,
      z: spineCenter.z + axis.z * spec.scalar,
    }, spec.purpose, spec.gateway ? { gatewayId: spec.gateway.gatewayId } : {});
  }
  for (let index = 1; index < spineSpecs.length; index += 1) {
    await addEdge(
      spineSpecs[index - 1].node,
      spineSpecs[index].node,
      ROAD_GRAPH_CLASSES.COLLECTOR,
      `collector-spine:${spineSpecs[index - 1].purpose}:${spineSpecs[index].purpose}`,
      {
        frontageEligible: true,
        routeId: `${settlementId}:collector-spine`,
        routeOrder: index - 1,
      },
    );
  }

  const requiredGatewayNodeIds = [];
  for (const spec of spineSpecs.filter(value => value.gateway)) {
    const gateway = spec.gateway;
    const dx = gateway.target.x - center.x;
    const dz = gateway.target.z - center.z;
    const length = Math.hypot(dx, dz);
    const terminal = await addNode('connectivity-gateway', {
      x: center.x + dx / length * radius * 0.92,
      z: center.z + dz / length * radius * 0.92,
    }, `connectivity-gateway:${gateway.gatewayId}`, {
      gatewayId: gateway.gatewayId,
      targetSettlementId: gateway.targetSettlementId,
    });
    requiredGatewayNodeIds.push(terminal.nodeId);
    await addEdge(
      terminal,
      spec.node,
      ROAD_GRAPH_CLASSES.ARTERIAL,
      `connectivity-gateway:${gateway.gatewayId}`,
      {
        frontageEligible: false,
        connectivityGateway: true,
        targetSettlementId: gateway.targetSettlementId,
        routeId: `${settlementId}:arterial:${gateway.gatewayId}`,
        routeOrder: 0,
      },
    );
  }

  const localSpecs = spineSpecs.filter(value => Number.isInteger(value.localIndex));
  const branchPhase = await random.integer('local-branch-side-phase', 0, 1);
  const localEnds = [];
  for (const spec of localSpecs) {
    const side = (spec.localIndex + branchPhase) % 2 === 0 ? -1 : 1;
    const branchLength = radius * (legacySettlementClass === SETTLEMENT_TYPES.CITY ? 0.46 : 0.42);
    const end = await addNode('local-terminal', {
      x: spec.node.position.x + normal.x * side * branchLength,
      z: spec.node.position.z + normal.z * side * branchLength,
    }, `local-terminal:${spec.localIndex}`);
    localEnds.push(end);
    await addEdge(spec.node, end, ROAD_GRAPH_CLASSES.LOCAL, `local-branch:${spec.localIndex}`, {
      frontageEligible: true,
      routeId: `${settlementId}:local:${spec.localIndex}`,
      routeOrder: 0,
    });
  }
  for (let index = 0; index < alleyCount; index += 1) {
    const parent = localEnds[index % localEnds.length];
    const direction = index % 2 === 0 ? -1 : 1;
    const end = await addNode('alley-terminal', {
      x: parent.position.x + axis.x * direction * radius * 0.22,
      z: parent.position.z + axis.z * direction * radius * 0.22,
    }, `alley-terminal:${index}`);
    await addEdge(parent, end, ROAD_GRAPH_CLASSES.ALLEY, `alley-branch:${index}`, {
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
      schemaVersion: ROAD_GRAPH_V1_SEGMENT_SCHEMA,
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
    schemaVersion: ROAD_GRAPH_V1_SCHEMA,
    generatorId: ROAD_GRAPH_V1_GENERATOR_ID,
    profileRevision: ROAD_GRAPH_V1_PROFILE_REVISION,
    coordinateSpace: 'logical-world-meters',
    settlementId,
    legacySettlementClass,
    center,
    sourceOwner,
    metadata: Object.freeze({
      gatewayMode,
      fallbackType: sortedGateways.length ? null : ROAD_GRAPH_ISOLATED_FALLBACK,
      requiredGatewayIds: Object.freeze(sortedGateways.map(gateway => gateway.gatewayId)),
      requiredGatewayNodeIds: Object.freeze([...requiredGatewayNodeIds].sort()),
      fictitiousGatewayCount: 0,
      authority: ROAD_GRAPH_V1_GENERATOR_ID,
    }),
    nodes: Object.freeze(nodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId))),
    edges: Object.freeze(edges.sort((left, right) => left.edgeId.localeCompare(right.edgeId))),
    segments: Object.freeze(segments.sort((left, right) => left.stableId.localeCompare(right.stableId))),
  });
  const validation = validateRoadGraphV1(graph);
  if (!validation.valid) throw new Error(`invalid road-graph-v1: ${validation.errors.join('; ')}`);
  return graph;
}

export const ROAD_GRAPH_V1_STAGE_GENERATOR = Object.freeze({
  stage: 'roadGraph',
  generatorId: ROAD_GRAPH_V1_GENERATOR_ID,
  generate: createRoadGraphV1,
});

const experimentalRegistry = createSettlementStageGeneratorRegistry();
experimentalRegistry.register(ROAD_GRAPH_V1_STAGE_GENERATOR);
experimentalRegistry.freeze();

export const EXPERIMENTAL_SETTLEMENT_STAGE_GENERATOR_REGISTRY = experimentalRegistry;
