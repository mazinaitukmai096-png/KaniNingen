import { SETTLEMENT_TYPES } from '../settlement-type.js';
import { SETTLEMENT_ROAD_PARAMETERS } from '../settlement-road-parameters.js';
import { SETTLEMENT_NODE_QUANTIZATION } from './canonical-settlement-plan.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import {
  ROAD_GRAPH_CLASSES,
  ROAD_GRAPH_V1_SCHEMA,
  ROAD_GRAPH_V1_SEGMENT_SCHEMA,
} from './road-graph-v1.js';
import {
  createSemanticIdKeyedRandom,
  createSettlementSemanticStableId,
  SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
} from './settlement-semantic-identity.js';
import { createSettlementStageGeneratorRegistry } from './settlement-stage-generator-registry.js';

export const ROAD_GRAPH_V3_GENERATOR_ID = 'road-graph-v3';
export const ROAD_GRAPH_V3_SCHEMA = ROAD_GRAPH_V1_SCHEMA;
export const ROAD_GRAPH_V3_SEGMENT_SCHEMA = ROAD_GRAPH_V1_SEGMENT_SCHEMA;
export const ROAD_GRAPH_V3_PROFILE_REVISION = 'road-graph-profile-3';
export const ROAD_GRAPH_V3_ISOLATED_FALLBACK = 'CLASS_GRAMMAR_WITHOUT_FICTITIOUS_GATEWAYS';

const GEOMETRY_EPSILON = 1e-7;
const ROAD_CLASS_SET = new Set(Object.values(ROAD_GRAPH_CLASSES));
// The floor for CITY's street-bearing concentration, the measured form of the
// `roadPattern: GRID` the profile declares. It has to reject what a non-grid produces -
// the radial CITY this replaced measured 0.245 and the SEMI_GRID TOWN measures 0.422 -
// while leaving room under the 0.90 to 0.95 band a deliberately loosened grid targets.
const CITY_GRID_CONCENTRATION_MINIMUM = 0.75;
const SETTLEMENT_CLASS_SET = new Set(Object.values(SETTLEMENT_TYPES));
const q6 = value => {
  const rounded = Math.round(value / SETTLEMENT_NODE_QUANTIZATION.gridWidthMeters)
    * SETTLEMENT_NODE_QUANTIZATION.gridWidthMeters;
  return Object.is(rounded, -0) ? 0 : Number(rounded.toFixed(6));
};
const point = (x, z) => Object.freeze({ x: q6(x), z: q6(z) });
const coordinateKey = value => `${value.x},${value.z}`;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const add = (left, right) => ({ x: left.x + right.x, z: left.z + right.z });
const subtract = (left, right) => ({ x: left.x - right.x, z: left.z - right.z });
const scale = (value, scalar) => ({ x: value.x * scalar, z: value.z * scalar });
const length = value => Math.hypot(value.x, value.z);
const unit = value => {
  const magnitude = length(value);
  if (magnitude <= GEOMETRY_EPSILON) throw new RangeError('zero-length Road Graph direction');
  return { x: value.x / magnitude, z: value.z / magnitude };
};
const perpendicular = value => ({ x: -value.z, z: value.x });
const lerp = (start, end, t) => add(scale(start, 1 - t), scale(end, t));
const fromPolar = (angle, radius) => ({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });
const angleOf = value => Math.atan2(value.z, value.x);
const positiveAngle = value => ((value % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

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

function normalizeGateway(gateway, index, center) {
  requireRecord(gateway, `gateways[${index}]`);
  const target = gateway.target ?? gateway.center;
  if (![target?.x, target?.z].every(Number.isFinite)) {
    throw new TypeError(`gateways[${index}] requires a logical target position`);
  }
  const logicalTarget = point(target.x, target.z);
  const direction = unit(subtract(logicalTarget, center));
  return Object.freeze({
    gatewayId: requireString(gateway.gatewayId ?? gateway.stableId, `gateways[${index}].gatewayId`),
    targetSettlementId: requireString(
      gateway.targetSettlementId ?? gateway.settlementId,
      `gateways[${index}].targetSettlementId`,
    ),
    target: logicalTarget,
    direction: Object.freeze(direction),
    angle: positiveAngle(angleOf(direction)),
    sourceOwner: Object.freeze({ ...(gateway.sourceOwner ?? {}) }),
  });
}

function roadWidths(settlementType) {
  const profile = SETTLEMENT_ROAD_PARAMETERS[settlementType];
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

function angleBetween(first, second) {
  const denominator = length(first) * length(second);
  if (denominator <= GEOMETRY_EPSILON) return 0;
  return Math.acos(clamp((first.x * second.x + first.z * second.z) / denominator, -1, 1))
    * 180 / Math.PI;
}

function coefficientOfVariation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= GEOMETRY_EPSILON) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function selectMostSeparatedGatewayPair(gateways) {
  if (gateways.length < 2) return null;
  const pairs = [];
  for (let first = 0; first < gateways.length; first += 1) {
    for (let second = first + 1; second < gateways.length; second += 1) {
      pairs.push({
        first: gateways[first],
        second: gateways[second],
        separation: angleBetween(gateways[first].direction, gateways[second].direction),
      });
    }
  }
  pairs.sort((left, right) => right.separation - left.separation
    || left.first.gatewayId.localeCompare(right.first.gatewayId)
    || left.second.gatewayId.localeCompare(right.second.gatewayId));
  return pairs[0];
}

function createProfileUsage(profile, localGrowthCount, majorRouteCount) {
  return Object.freeze({
    roadPattern: profile.roadPattern,
    localSpineCount: profile.localSpineCount,
    localBranchCount: profile.localBranchCount,
    junctionSpacingMultiplier: profile.junctionSpacingMultiplier,
    localCurvature: profile.localCurvature,
    gridBias: profile.gridBias,
    deadEndBias: profile.deadEndBias,
    densityMultiplier: profile.densityMultiplier,
    centerConnectionBias: profile.centerConnectionBias,
    outerRoadBias: profile.outerRoadBias,
    resolvedLocalGrowthCount: localGrowthCount,
    resolvedMajorRouteCount: majorRouteCount,
  });
}

async function createBuilder({ worldSeedHash, settlementId, sourceOwner, widths }) {
  const nodes = [];
  const edges = [];
  const positions = new Set();

  async function addNode(role, position, purpose, extra = {}) {
    const logicalPosition = point(position.x, position.z);
    const key = coordinateKey(logicalPosition);
    if (positions.has(key)) throw new Error(`duplicate planned Road Node position: ${key} (${purpose})`);
    positions.add(key);
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
        profileRevision: ROAD_GRAPH_V3_PROFILE_REVISION,
      }),
    });
    const edge = Object.freeze({
      edgeId: identity.stableId,
      stableId: identity.stableId,
      startNodeId: startNode.nodeId,
      endNodeId: endNode.nodeId,
      class: roadClass,
      purpose,
      profileRevision: ROAD_GRAPH_V3_PROFILE_REVISION,
      sourceOwner,
      // Every Road Edge carries a frontage verdict. addPolyline used to be the only place
      // this default lived, so an edge added through addEdge directly got no verdict at
      // all and silently dropped out of both frontage selection and Block Lot generation.
      // The CITY lattice was built that way and lost its entire skeleton to it: 23 lanes
      // frontage-ineligible, the closed Blocks rejected as NO_VALID_FRONTAGE, and a
      // capital with 73% more road and half the buildable length. The default belongs on
      // the primitive that makes the edge, not on one of its two callers. An explicit flag
      // still wins - addGatewayConnection sets frontageEligible on an ARTERIAL on purpose.
      flags: Object.freeze({
        frontageEligible: roadClass !== ROAD_GRAPH_CLASSES.ARTERIAL,
        ...flags,
      }),
    });
    edges.push(edge);
    return edge;
  }

  async function addPolyline({
    startNode,
    endNode = null,
    intermediatePositions = [],
    roadClass,
    purpose,
    routeId,
    routeOrderStart = 0,
    flags = {},
    endRole = 'road-terminal',
    endPosition = null,
    endPurpose = `${purpose}:end`,
  }) {
    const routeNodes = [startNode];
    for (let index = 0; index < intermediatePositions.length; index += 1) {
      routeNodes.push(await addNode(
        'bend',
        intermediatePositions[index],
        `${purpose}:bend:${index}`,
        { degreeContract: 2 },
      ));
    }
    const resolvedEnd = endNode ?? await addNode(endRole, endPosition, endPurpose);
    routeNodes.push(resolvedEnd);
    for (let index = 1; index < routeNodes.length; index += 1) {
      await addEdge(routeNodes[index - 1], routeNodes[index], roadClass, `${purpose}:segment:${index - 1}`, {
        ...flags,
        routeId,
        routeOrder: routeOrderStart + index - 1,
      });
    }
    return Object.freeze({ endNode: resolvedEnd, nodes: Object.freeze(routeNodes) });
  }

  function buildSegments() {
    const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
    return edges.map(edge => {
      const start = nodesById.get(edge.startNodeId).position;
      const end = nodesById.get(edge.endNodeId).position;
      const direction = unit(subtract(end, start));
      return Object.freeze({
        schemaVersion: ROAD_GRAPH_V3_SEGMENT_SCHEMA,
        stableId: edge.edgeId,
        edgeId: edge.edgeId,
        class: edge.class,
        start,
        end,
        tangent: Object.freeze(direction),
        normal: Object.freeze(perpendicular(direction)),
        widthMeters: widths[edge.class],
        sourceOwner,
        purpose: edge.purpose,
        flags: edge.flags,
      });
    });
  }

  return Object.freeze({ nodes, edges, addNode, addEdge, addPolyline, buildSegments });
}

async function keyedSigned(random, key) {
  return (await random.float01(key)) * 2 - 1;
}

function polylinePlanIsPlanar(builder, startNode, endNode, endPosition, intermediatePositions) {
  const positions = [startNode.position, ...intermediatePositions, endNode?.position ?? endPosition];
  const nodesById = new Map(builder.nodes.map(node => [node.nodeId, node]));
  for (let index = 1; index < positions.length; index += 1) {
    for (const edge of builder.edges) {
      const edgeStart = nodesById.get(edge.startNodeId).position;
      const edgeEnd = nodesById.get(edge.endNodeId).position;
      if (!segmentsIntersect(positions[index - 1], positions[index], edgeStart, edgeEnd)) continue;
      const candidateEndpoints = [positions[index - 1], positions[index]].map(coordinateKey);
      const existingEndpoints = [edgeStart, edgeEnd].map(coordinateKey);
      if (candidateEndpoints.some(key => existingEndpoints.includes(key))) continue;
      return false;
    }
  }
  return true;
}

async function addGatewayConnection({
  builder,
  gateway,
  innerNode,
  center,
  radius,
  settlementId,
  requiredGatewayNodeIds,
}) {
  const terminal = await builder.addNode('connectivity-gateway', add(center, scale(gateway.direction, radius * 0.92)),
    `connectivity-gateway:${gateway.gatewayId}`, {
      gatewayId: gateway.gatewayId,
      targetSettlementId: gateway.targetSettlementId,
    });
  requiredGatewayNodeIds.push(terminal.nodeId);
  await builder.addEdge(terminal, innerNode, ROAD_GRAPH_CLASSES.ARTERIAL,
    `connectivity-gateway:${gateway.gatewayId}`, {
      // The finite game never forbade frontage on a MAJOR road. selectFrontageRoad
      // adds ROAD_KIND_DISTANCE_BIAS to the distance when choosing one,
      // buildFrontageAnchorPlan sorts MAJOR last, and createFrontagePlacement says
      // outright that a frontage road must be "MAJOR, LOCAL, or ALLEY". That graded
      // last-resort collapsed into a boolean during the port to road-graph-v3, and
      // it cost the outer half of every Settlement its only buildable road: this
      // edge runs 0.64R to 0.92R, and past radius/sqrt(2) - half the area - it is
      // the only class present in a CITY or TOWN. The suppression is restored where
      // the finite game spends it - as a distance, in majorRoadFrontageIsPermitted in
      // settlement-lot-v2.js - rather than dropped.
      frontageEligible: true,
      connectivityGateway: true,
      targetSettlementId: gateway.targetSettlementId,
      routeId: `${settlementId}:arterial:${gateway.gatewayId}`,
      routeOrder: 0,
    });
}

async function createOrganicOrTownGrammar({
  builder,
  random,
  center,
  radius,
  settlementId,
  profile,
  gateways,
  settlementType,
  requiredGatewayNodeIds,
}) {
  const pair = selectMostSeparatedGatewayPair(gateways);
  const fallbackAngle = await random.float01(`${profile.roadPattern}:main-axis`) * Math.PI * 2;
  const startDirection = pair?.first.direction ?? fromPolar(fallbackAngle + Math.PI, 1);
  const endDirection = pair?.second.direction ?? fromPolar(fallbackAngle, 1);
  const primaryGatewayIds = new Set(pair ? [pair.first.gatewayId, pair.second.gatewayId] : []);
  const mainRouteId = `${settlementId}:collector:main`;
  const localGrowthCount = clamp(
    Math.round(profile.localBranchCount * (0.8 + profile.densityMultiplier * 0.2)),
    settlementType === SETTLEMENT_TYPES.RURAL ? 2 : 3,
    settlementType === SETTLEMENT_TYPES.RURAL ? 4 : 6,
  );
  const stationCount = localGrowthCount + 2;
  const stationParameters = [0];
  for (let index = 1; index < stationCount - 1; index += 1) {
    const regular = index / (stationCount - 1);
    const spacingScale = 0.055 / profile.junctionSpacingMultiplier;
    const jitter = await keyedSigned(random, `${profile.roadPattern}:station:${index}`);
    stationParameters.push(clamp(regular + jitter * spacingScale, 0.04, 0.96));
  }
  stationParameters.push(1);
  stationParameters.sort((left, right) => left - right);

  const startPosition = add(center, scale(startDirection, radius * (0.64 + profile.outerRoadBias * 0.03)));
  const endPosition = add(center, scale(endDirection, radius * (0.64 + profile.outerRoadBias * 0.03)));
  const chord = subtract(endPosition, startPosition);
  const chordNormal = perpendicular(unit(chord));
  const routeCenter = add(center,
    scale(chordNormal, radius * (0.5 - profile.centerConnectionBias) * 0.04));
  const curveSign = (await random.float01(`${profile.roadPattern}:collector-curve-side`)) < 0.5 ? -1 : 1;
  const stationPositions = stationParameters.map((t, index) => {
    const base = t <= 0.5
      ? lerp(startPosition, routeCenter, t * 2)
      : lerp(routeCenter, endPosition, (t - 0.5) * 2);
    const irregularWave = Math.sin(t * Math.PI * 2 + 0.37) * profile.localCurvature * radius * 0.17;
    const gridDamping = 1 - profile.gridBias * 0.35;
    return point(
      base.x + chordNormal.x * irregularWave * curveSign * gridDamping,
      base.z + chordNormal.z * irregularWave * curveSign * gridDamping,
    );
  });

  const stationNodes = [];
  for (let index = 0; index < stationPositions.length; index += 1) {
    const endpointGateway = index === 0 ? pair?.first : index === stationPositions.length - 1 ? pair?.second : null;
    stationNodes.push(await builder.addNode(
      endpointGateway ? 'gateway-junction' : index === 0 || index === stationPositions.length - 1
        ? 'collector-terminal' : 'local-junction',
      stationPositions[index],
      `main-collector-station:${index}`,
      endpointGateway ? { gatewayId: endpointGateway.gatewayId } : {},
    ));
  }
  let routeOrder = 0;
  for (let index = 1; index < stationNodes.length; index += 1) {
    const start = stationNodes[index - 1].position;
    const end = stationNodes[index].position;
    const tangent = unit(subtract(end, start));
    const bendNormal = perpendicular(tangent);
    const bendAmount = radius * profile.localCurvature
      * (0.12 + (await random.float01(`${profile.roadPattern}:collector-bend:${index}`)) * 0.12)
      * (index % 2 === 0 ? -1 : 1);
    let bend = null;
    for (const amountScale of [1, -1, 0.5, -0.5, 0]) {
      const candidate = add(lerp(start, end, 0.5), scale(bendNormal, bendAmount * amountScale));
      if (polylinePlanIsPlanar(
        builder,
        stationNodes[index - 1],
        stationNodes[index],
        null,
        [candidate],
      )) {
        bend = candidate;
        break;
      }
    }
    if (!bend) throw new Error(`unable to curve planar collector segment: ${index}`);
    const polyline = await builder.addPolyline({
      startNode: stationNodes[index - 1],
      endNode: stationNodes[index],
      intermediatePositions: [bend],
      roadClass: ROAD_GRAPH_CLASSES.COLLECTOR,
      purpose: `main-collector:${index - 1}`,
      routeId: mainRouteId,
      routeOrderStart: routeOrder,
      flags: { hierarchy: 'major-route', grammar: profile.roadPattern },
    });
    routeOrder += polyline.nodes.length - 1;
  }

  if (pair) {
    await addGatewayConnection({ builder, gateway: pair.first, innerNode: stationNodes[0], center, radius,
      settlementId, requiredGatewayNodeIds });
    await addGatewayConnection({ builder, gateway: pair.second, innerNode: stationNodes.at(-1), center, radius,
      settlementId, requiredGatewayNodeIds });
  }
  for (const gateway of gateways.filter(value => !primaryGatewayIds.has(value.gatewayId))) {
    const hubIndex = Math.floor(stationNodes.length / 2);
    const hub = stationNodes[hubIndex];
    const spokeJunction = await builder.addNode('gateway-junction',
      add(center, scale(gateway.direction, radius * 0.58)),
      `extra-gateway-junction:${gateway.gatewayId}`,
      { gatewayId: gateway.gatewayId });
    const spokeBend = add(center, scale(gateway.direction, radius * 0.29));
    await builder.addPolyline({
      startNode: hub,
      endNode: spokeJunction,
      intermediatePositions: [spokeBend],
      roadClass: ROAD_GRAPH_CLASSES.COLLECTOR,
      purpose: `extra-gateway-route:${gateway.gatewayId}`,
      routeId: `${settlementId}:collector:gateway:${gateway.gatewayId}`,
      flags: { hierarchy: 'major-route', grammar: profile.roadPattern },
    });
    await addGatewayConnection({ builder, gateway, innerNode: spokeJunction, center, radius,
      settlementId, requiredGatewayNodeIds });
  }

  const branchRecords = [];
  const sidePhase = await random.integer(`${profile.roadPattern}:branch-side-phase`, 0, 1);
  for (let index = 0; index < localGrowthCount; index += 1) {
    const stationIndex = index + 1;
    const station = stationNodes[stationIndex];
    const previous = stationNodes[Math.max(0, stationIndex - 1)].position;
    const next = stationNodes[Math.min(stationNodes.length - 1, stationIndex + 1)].position;
    const tangent = unit(subtract(next, previous));
    const preferredSide = (index + sidePhase) % 2 === 0 ? -1 : 1;
    const angleMinimum = profile.preferredBranchAngleMin;
    const angleMaximum = profile.preferredBranchAngleMax;
    const rawAngle = angleMinimum + (angleMaximum - angleMinimum)
      * await random.float01(`${profile.roadPattern}:branch-angle:${index}`);
    const gridAngle = 90 + (rawAngle - 90) * (1 - profile.gridBias);
    const lengthJitter = 0.84 + await random.float01(`${profile.roadPattern}:branch-length:${index}`) * 0.32;
    const branchLength = radius * (0.20 + profile.outerRoadBias * 0.13)
      * profile.junctionSpacingMultiplier ** -0.18 * lengthJitter;
    const preferredCurveSide = (await random.float01(`${profile.roadPattern}:branch-curve-side:${index}`)) < 0.5 ? -1 : 1;
    let branchPlan = null;
    for (const side of [preferredSide, -preferredSide]) {
      for (const angleOffset of [0, 11, -11, 22, -22, 34, -34]) {
        const angle = (gridAngle + angleOffset + (side > 0 ? 3.25 : -3.25)) * Math.PI / 180 * side;
        const direction = {
          x: tangent.x * Math.cos(angle) - tangent.z * Math.sin(angle),
          z: tangent.x * Math.sin(angle) + tangent.z * Math.cos(angle),
        };
        for (const lengthScale of [1, 0.82, 0.66, 0.48, 0.34, 0.24]) {
          const resolvedLength = branchLength * lengthScale;
          const terminalPosition = add(station.position, scale(direction, resolvedLength));
          const curveNormal = perpendicular(direction);
          for (const curveSide of [preferredCurveSide, -preferredCurveSide]) {
            const bend = add(
              lerp(station.position, terminalPosition, 0.52),
              scale(curveNormal, resolvedLength * profile.localCurvature * 0.42 * curveSide),
            );
            if (polylinePlanIsPlanar(builder, station, null, terminalPosition, [bend])) {
              branchPlan = { side, terminalPosition, bend };
              break;
            }
          }
          if (branchPlan) break;
        }
        if (branchPlan) break;
      }
      if (branchPlan) break;
    }
    if (!branchPlan) throw new Error(`unable to grow planar local branch: ${index}`);
    const { side, terminalPosition, bend } = branchPlan;
    const routeId = `${settlementId}:local:${index}`;
    const branch = await builder.addPolyline({
      startNode: station,
      intermediatePositions: [bend],
      roadClass: ROAD_GRAPH_CLASSES.LOCAL,
      purpose: `local-growth:${index}`,
      routeId,
      flags: { localGrowth: true, through: false, grammar: profile.roadPattern, side },
      endRole: 'dead-end',
      endPosition: terminalPosition,
      endPurpose: `local-dead-end:${index}`,
    });
    branchRecords.push(Object.freeze({ ...branch, side, index }));
  }

  const sameSidePairs = [];
  for (let first = 0; first < branchRecords.length; first += 1) {
    for (let second = first + 1; second < branchRecords.length; second += 1) {
      if (branchRecords[first].side === branchRecords[second].side) {
        sameSidePairs.push([branchRecords[first], branchRecords[second]]);
      }
    }
  }
  const requestedLoops = settlementType === SETTLEMENT_TYPES.TOWN
    ? 1 + (await random.float01('SEMI_GRID:secondary-loop') > profile.deadEndBias + 0.35 ? 1 : 0)
    : (await random.float01('ORGANIC:optional-loop') > profile.deadEndBias ? 1 : 0);
  const loopPairs = [];
  const loopBranchIndexes = new Set();
  const loopCandidates = sameSidePairs.sort((left, right) => (
    length(subtract(left[0].endNode.position, left[1].endNode.position))
      - length(subtract(right[0].endNode.position, right[1].endNode.position))
  ));
  for (const pair of loopCandidates) {
    if (loopPairs.length >= requestedLoops) break;
    if (pair.some(branch => loopBranchIndexes.has(branch.index))) continue;
    const [first, second] = pair;
    const firstPosition = first.endNode.position;
    const secondPosition = second.endNode.position;
    const firstOutward = unit(subtract(firstPosition, center));
    const secondOutward = unit(subtract(secondPosition, center));
    let loopBends = null;
    for (const outsideFactor of [0.07, 0.13, 0.22, 0.34]) {
      const outsideDistance = radius * (outsideFactor + profile.localCurvature * 0.09);
      const candidateBends = [
        add(firstPosition, scale(firstOutward, outsideDistance)),
        add(
          lerp(firstPosition, secondPosition, 0.5),
          scale(unit(add(firstOutward, secondOutward)), outsideDistance * 1.1),
        ),
        add(secondPosition, scale(secondOutward, outsideDistance)),
      ];
      if (polylinePlanIsPlanar(builder, first.endNode, second.endNode, null, candidateBends)) {
        loopBends = candidateBends;
        break;
      }
    }
    if (!loopBends) {
      const firstAngle = angleOf(subtract(firstPosition, center));
      const secondAngle = angleOf(subtract(secondPosition, center));
      let shortDelta = positiveAngle(secondAngle - firstAngle);
      if (shortDelta > Math.PI) shortDelta -= Math.PI * 2;
      const deltas = [shortDelta, shortDelta >= 0 ? shortDelta - Math.PI * 2 : shortDelta + Math.PI * 2];
      for (const outerScale of [0.78, 0.92, 1.08]) {
        for (const delta of deltas) {
          const arcRadius = radius * outerScale;
          const stepCount = Math.max(2, Math.ceil(Math.abs(delta) * outerScale / 0.42));
          const arcBends = Array.from({ length: stepCount + 1 }, (_, step) => (
            add(center, fromPolar(firstAngle + delta * step / stepCount, arcRadius))
          ));
          const candidateBends = [
            lerp(firstPosition, arcBends[0], 0.5),
            ...arcBends,
            lerp(arcBends.at(-1), secondPosition, 0.5),
          ];
          if (polylinePlanIsPlanar(builder, first.endNode, second.endNode, null, candidateBends)) {
            loopBends = candidateBends;
            break;
          }
        }
        if (loopBends) break;
      }
    }
    if (!loopBends) continue;
    const index = loopPairs.length;
    await builder.addPolyline({
      startNode: first.endNode,
      endNode: second.endNode,
      intermediatePositions: loopBends,
      roadClass: ROAD_GRAPH_CLASSES.LOCAL,
      purpose: `partial-loop:${index}`,
      routeId: `${settlementId}:local-loop:${index}`,
      flags: { snapped: true, partialLoop: true, grammar: profile.roadPattern },
    });
    loopPairs.push(pair);
    pair.forEach(branch => loopBranchIndexes.add(branch.index));
  }

  return Object.freeze({
    localGrowthCount,
    majorRouteCount: profile.localSpineCount,
    loopCount: loopPairs.length,
    grammar: settlementType === SETTLEMENT_TYPES.RURAL ? 'CURVED_COLLECTOR_WITH_ALTERNATING_SPURS'
      : 'CURVED_COLLECTOR_WITH_PARTIAL_LOOPS_AND_DEAD_ENDS',
  });
}

function adjacentAngularPairs(records) {
  const sorted = [...records].sort((left, right) => left.angle - right.angle || left.key.localeCompare(right.key));
  const pairs = sorted.map((record, index) => {
    const next = sorted[(index + 1) % sorted.length];
    const gap = positiveAngle(next.angle - record.angle);
    return { first: record, second: next, gap };
  });
  return pairs.sort((left, right) => left.gap - right.gap
    || left.first.key.localeCompare(right.first.key));
}

async function addArcConnection({ builder, center, radius, first, second, purpose, routeId, profile, outwardScale = 1 }) {
  let delta = positiveAngle(second.angle - first.angle);
  if (delta > Math.PI) delta -= Math.PI * 2;
  const curveScale = outwardScale * (1 + profile.localCurvature * 0.9 + (1 - profile.gridBias) * 0.035);
  const positions = [1 / 3, 2 / 3].map(t => add(center,
    fromPolar(first.angle + delta * t, radius * curveScale)));
  return builder.addPolyline({
    startNode: first.node,
    endNode: second.node,
    intermediatePositions: positions,
    roadClass: ROAD_GRAPH_CLASSES.LOCAL,
    purpose,
    routeId,
    flags: { snapped: true, crossConnection: true, incomplete: true, grammar: profile.roadPattern },
  });
}

// The profile declares `roadPattern: GRID` for CITY and nothing in this file ever branched
// on that string; the grammar built radial COLLECTOR spokes from a hub with concentric arcs
// between them. Measured, the class declared GRID was the least rectilinear of the three
// (bearing concentration 0.245 against TOWN 0.422 and RURAL 0.329), while the finite
// capital puts every one of its 42 street segments at exactly 0 or 90 degrees.
//
// The cause is the frame, not the angle term. Branches grown perpendicular to the local
// tangent of a curved parent land on arbitrary absolute bearings, which is why `gridBias`
// explains 0.01% of CITY's measured spread and 3.7% of TOWN's. A grid needs a global axis
// frame, so this grammar lays a lattice on the `GRID:base-axis` frame it already computed
// and used only to fan its spokes out.
//
// The lattice is deliberately not the finite capital's perfect one: that is regular in
// angle and in spacing (380/380 and 400/400) and reads as mechanical. Angles stay rigid
// here and the irregularity is spent on lane spacing instead, which is how real street
// grids read - orthogonal streets, uneven blocks.
async function createCityGrammar({
  builder,
  random,
  center,
  radius,
  settlementId,
  profile,
  gateways,
  requiredGatewayNodeIds,
}) {
  const localGrowthCount = clamp(
    Math.round(profile.localBranchCount * (0.8 + profile.densityMultiplier * 0.2)),
    3,
    6,
  );
  const baseAngle = await random.float01('GRID:base-axis') * Math.PI * 2;
  const axisA = fromPolar(baseAngle, 1);
  const axisB = perpendicular(axisA);
  const outerRadius = radius * (0.62 + profile.outerRoadBias * 0.035);

  // A 2 x n lattice encloses (2-1)(n-1) = n-1 bounded faces, so n of 3 or 4 puts the cycle
  // rank on exactly 2 or 3, and which one it is varies by seed.
  const extraCycleProbability = clamp(
    (profile.densityMultiplier - 1) * 0.8
      + profile.centerConnectionBias * 0.3
      - profile.deadEndBias * 0.4,
    0.25,
    0.75,
  );
  const laneBCount = (await random.float01('GRID:extra-cycle') < extraCycleProbability) ? 4 : 3;

  // Lane positions carry the whole of the irregularity. The jitter scale is the one
  // createOrganicOrTownGrammar already uses for its collector stations.
  const spacingJitter = 0.055 / profile.junctionSpacingMultiplier;
  const lanePositions = async (count, span, key) => {
    const offsets = [];
    for (let index = 0; index < count; index += 1) {
      const regular = count === 1 ? 0 : (index / (count - 1) - 0.5) * span;
      const jitter = await keyedSigned(random, `${key}:${index}`) * spacingJitter;
      offsets.push(radius * (regular + jitter));
    }
    return offsets.sort((left, right) => left - right);
  };
  // Kept inside 0.45R so every lattice crossing counts as a center junction.
  const laneA = await lanePositions(2, 0.52, 'GRID:lane-a');
  const laneB = await lanePositions(laneBCount, 0.60, 'GRID:lane-b');
  const laneEndScalar = offset =>
    Math.sqrt(Math.max(outerRadius ** 2 - offset ** 2, (radius * 0.1) ** 2));

  // localSpineCount is 2, so two lanes carry the branches: the outermost of each family,
  // where growing away from the lattice leaves clear ground. Three branches each is what
  // the finite capital grows (spine0BranchPoints 3 + spine1BranchPoints 3).
  const outermost = offsets => offsets.reduce((best, value) =>
    Math.abs(value) > Math.abs(best) ? value : best, offsets[0]);
  const spineOffsets = [outermost(laneA), outermost(laneB)].slice(0, profile.localSpineCount);
  const branchesPerSpine = Math.round(localGrowthCount / Math.max(1, spineOffsets.length));

  // Branch attachment scalars are planned before the lanes are built so each one can be a
  // node in its lane's chain. Splitting an existing edge afterwards would break planarity.
  const branchPlans = [];
  let branchIndex = 0;
  for (let spine = 0; spine < spineOffsets.length; spine += 1) {
    const acrossOffset = spineOffsets[spine];
    const alongAxis = spine === 0 ? axisA : axisB;
    const reach = laneEndScalar(acrossOffset);
    for (let step = 0; step < branchesPerSpine; step += 1) {
      const fraction = (step + 1) / (branchesPerSpine + 1);
      const jitter = await keyedSigned(random, `GRID:branch-offset:${branchIndex}`) * spacingJitter;
      branchPlans.push({
        index: branchIndex,
        spine,
        alongAxis,
        acrossOffset,
        scalar: (fraction - 0.5 + jitter) * 2 * reach * 0.86,
      });
      branchIndex += 1;
    }
  }

  const laneBase = (alongAxis, acrossOffset) =>
    add(center, scale(alongAxis === axisA ? axisB : axisA, acrossOffset));
  const branchNodes = new Map();
  for (const plan of branchPlans) {
    const position = add(laneBase(plan.alongAxis, plan.acrossOffset), scale(plan.alongAxis, plan.scalar));
    branchNodes.set(plan.index, await builder.addNode(
      'local-junction', position, `city-branch-junction:${plan.index}`,
    ));
  }

  // Gateway entry points are planned before the lanes are built, the same way the branch
  // attachments are, so each one can be a node in its lane's chain. Routing to a lane end
  // afterwards and turning to reach it cannot be made reliable: segmentsIntersect counts a
  // bare touch as an intersection, and any turn that reaches a lane end either lands its
  // corner on a lane or runs along one. Entering where the gateway's own bearing first
  // meets a lane avoids the problem entirely - the approach is one radial leg, it stops at
  // the first thing it reaches, and the lane already has a node there.
  const axisComponent = (vector, axis) => vector.x * axis.x + vector.z * axis.z;
  const gatewayEntries = [];
  for (const gateway of [...gateways].sort((left, right) => left.angle - right.angle
    || left.gatewayId.localeCompare(right.gatewayId))) {
    const alongA = axisComponent(gateway.direction, axisA);
    const alongB = axisComponent(gateway.direction, axisB);
    let best = null;
    for (let i = 0; i < laneA.length; i += 1) {
      if (Math.abs(alongB) < 1e-6) continue;
      const distance = laneA[i] / alongB;
      const scalar = alongA * distance;
      if (distance <= radius * 0.05 || distance >= outerRadius) continue;
      if (Math.abs(scalar) >= laneEndScalar(laneA[i]) - 1e-6) continue;
      if (!best || distance > best.distance) best = { family: 'a', index: i, distance, scalar };
    }
    for (let j = 0; j < laneB.length; j += 1) {
      if (Math.abs(alongA) < 1e-6) continue;
      const distance = laneB[j] / alongA;
      const scalar = alongB * distance;
      if (distance <= radius * 0.05 || distance >= outerRadius) continue;
      if (Math.abs(scalar) >= laneEndScalar(laneB[j]) - 1e-6) continue;
      if (!best || distance > best.distance) best = { family: 'b', index: j, distance, scalar };
    }
    if (!best) continue;
    gatewayEntries.push({ gateway, ...best });
  }
  // Two gateways whose bearings meet the same lane at nearly the same point would put two
  // nodes on top of each other, which the builder refuses.
  const acceptedEntries = [];
  for (const entry of gatewayEntries) {
    const clash = acceptedEntries.some(other => other.family === entry.family
      && other.index === entry.index && Math.abs(other.scalar - entry.scalar) < radius * 0.08);
    if (!clash) acceptedEntries.push(entry);
  }
  const gatewayEntryNodes = new Map();
  for (const entry of acceptedEntries) {
    const alongAxis = entry.family === 'a' ? axisA : axisB;
    const acrossOffset = entry.family === 'a' ? laneA[entry.index] : laneB[entry.index];
    const position = add(laneBase(alongAxis, acrossOffset), scale(alongAxis, entry.scalar));
    gatewayEntryNodes.set(entry.gateway.gatewayId, await builder.addNode(
      'gateway-junction', position, `city-gateway-entry:${entry.gateway.gatewayId}`,
      { gatewayId: entry.gateway.gatewayId },
    ));
  }

  const crossings = [];
  for (let i = 0; i < laneA.length; i += 1) {
    crossings.push([]);
    for (let j = 0; j < laneB.length; j += 1) {
      crossings[i].push(await builder.addNode(
        'cross-junction',
        add(center, add(scale(axisA, laneB[j]), scale(axisB, laneA[i]))),
        `city-lattice-crossing:${i}:${j}`,
      ));
    }
  }

  // Each lane runs out to the same outer circle the radial routes used, so the Settlement
  // keeps its footprint.
  const laneEndNodes = [];
  const laneRecords = [];
  const addLane = async (kind, index, alongAxis, acrossOffset, through) => {
    const reach = laneEndScalar(acrossOffset);
    const base = laneBase(alongAxis, acrossOffset);
    const lowEnd = await builder.addNode('collector-terminal',
      add(base, scale(alongAxis, -reach)), `city-lane-${kind}:${index}:low-end`);
    const highEnd = await builder.addNode('collector-terminal',
      add(base, scale(alongAxis, reach)), `city-lane-${kind}:${index}:high-end`);
    const ordered = [...through].sort((left, right) => left.scalar - right.scalar);
    const nodes = [lowEnd, ...ordered.map(entry => entry.node), highEnd];
    laneEndNodes.push(
      { node: lowEnd, axis: alongAxis, inward: 1, acrossOffset },
      { node: highEnd, axis: alongAxis, inward: -1, acrossOffset },
    );
    for (let step = 1; step < nodes.length; step += 1) {
      await builder.addEdge(nodes[step - 1], nodes[step], ROAD_GRAPH_CLASSES.LOCAL,
        `city-lane-${kind}:${index}:segment:${step - 1}`, {
          latticeLane: true,
          grammar: profile.roadPattern,
          routeId: `${settlementId}:local:lane-${kind}:${index}`,
          routeOrder: step - 1,
        });
    }
    laneRecords.push({ kind, index, base, alongAxis, acrossOffset, reach });
  };

  for (let i = 0; i < laneA.length; i += 1) {
    const through = laneB.map((offset, j) => ({ node: crossings[i][j], scalar: offset }));
    for (const plan of branchPlans) {
      if (plan.spine === 0 && plan.acrossOffset === laneA[i]) {
        through.push({ node: branchNodes.get(plan.index), scalar: plan.scalar });
      }
    }
    for (const entry of acceptedEntries) {
      if (entry.family !== 'a' || entry.index !== i) continue;
      through.push({ node: gatewayEntryNodes.get(entry.gateway.gatewayId), scalar: entry.scalar });
    }
    await addLane('a', i, axisA, laneA[i], through);
  }
  for (let j = 0; j < laneB.length; j += 1) {
    const through = laneA.map((offset, i) => ({ node: crossings[i][j], scalar: offset }));
    for (const plan of branchPlans) {
      if (plan.spine === 1 && plan.acrossOffset === laneB[j]) {
        through.push({ node: branchNodes.get(plan.index), scalar: plan.scalar });
      }
    }
    for (const entry of acceptedEntries) {
      if (entry.family !== 'b' || entry.index !== j) continue;
      through.push({ node: gatewayEntryNodes.get(entry.gateway.gatewayId), scalar: entry.scalar });
    }
    await addLane('b', j, axisB, laneB[j], through);
  }

  // Gateways. The approach node sits on the outer circle along the gateway bearing, so the
  // ARTERIAL edge stays radial exactly as before, and the single COLLECTOR leg continues
  // along that same bearing to the entry node planned into the lane above. One collinear
  // leg is what holds gatewayContinuityAngles at zero, and stopping at the first lane the
  // bearing reaches is what keeps it from crossing anything.
  const routeRecords = [];
  const usedLaneEnds = new Set();
  const gatewayRouteIds = [];
  for (const gateway of [...gateways].sort((left, right) => left.angle - right.angle
    || left.gatewayId.localeCompare(right.gatewayId))) {
    const entryNode = gatewayEntryNodes.get(gateway.gatewayId);
    if (!entryNode) continue;
    const approachNode = await builder.addNode('gateway-junction',
      add(center, scale(gateway.direction, outerRadius)),
      `city-gateway-approach:${gateway.gatewayId}`, { gatewayId: gateway.gatewayId });
    // At most three trunk routes are allowed, so gateways past the third share the last id.
    const routeId = gatewayRouteIds.length < 3
      ? `${settlementId}:collector:gateway:${gateway.gatewayId}`
      : gatewayRouteIds[gatewayRouteIds.length - 1];
    if (gatewayRouteIds.length < 3) gatewayRouteIds.push(routeId);
    await builder.addEdge(approachNode, entryNode, ROAD_GRAPH_CLASSES.COLLECTOR,
      `city-gateway-route:${gateway.gatewayId}`, {
        hierarchy: 'major-route',
        gatewayRoute: true,
        grammar: profile.roadPattern,
        routeId,
        routeOrder: 0,
      });
    await addGatewayConnection({ builder, gateway, innerNode: approachNode, center, radius,
      settlementId, requiredGatewayNodeIds });
    routeRecords.push(gateway.gatewayId);
  }
  // Branches grow outward, away from the lattice interior.
  const omittedRoutes = [];
  for (const plan of branchPlans) {
    const attachNode = branchNodes.get(plan.index);
    const outward = scale(plan.alongAxis === axisA ? axisB : axisA,
      plan.acrossOffset >= 0 ? 1 : -1);
    const branchLength = radius * (0.20 + profile.outerRoadBias * 0.13);
    let endPosition = null;
    for (const lengthScale of [1, 0.82, 0.66, 0.48, 0.34, 0.24]) {
      const candidate = add(attachNode.position, scale(outward, branchLength * lengthScale));
      if (!polylinePlanIsPlanar(builder, attachNode, null, candidate, [])) continue;
      endPosition = candidate;
      break;
    }
    if (!endPosition) {
      // A street that will not fit is one street fewer, not a Settlement that cannot exist.
      omittedRoutes.push(Object.freeze({
        routeId: `${settlementId}:local:branch:${plan.index}`,
        class: ROAD_GRAPH_CLASSES.LOCAL,
        reason: 'END_OR_CORRIDOR_BLOCKED',
      }));
      continue;
    }
    await builder.addPolyline({
      startNode: attachNode,
      roadClass: ROAD_GRAPH_CLASSES.LOCAL,
      purpose: `city-local-branch:${plan.index}`,
      routeId: `${settlementId}:local:branch:${plan.index}`,
      flags: { localGrowth: true, through: false, grammar: profile.roadPattern },
      endRole: 'dead-end',
      endPosition,
      endPurpose: `city-local-branch:${plan.index}:terminal`,
    });
  }

  // A Settlement with no accepted neighbour still needs its two trunk routes, so promote
  // lane ends to COLLECTOR stubs pointing out along their own lane.
  let stubIndex = 0;
  while (routeRecords.length < 2) {
    const entry = laneEndNodes.find(value => !usedLaneEnds.has(value.node.nodeId));
    if (!entry) break;
    // The finite capital's trunk is an L - west to hub to corner, then a right angle north
    // (road-town-structure.js:679) - so the stub bends once rather than running straight
    // out. It also gives an isolated CITY, which has no gateway route, the bend nodes every
    // Road Graph is expected to carry.
    const outward = scale(entry.axis, -entry.inward);
    const sideways = scale(entry.axis === axisA ? axisB : axisA,
      entry.acrossOffset >= 0 ? 1 : -1);
    const bendPosition = add(entry.node.position, scale(outward, radius * 0.09));
    const stubPosition = add(bendPosition, scale(sideways, radius * 0.09));
    if (!polylinePlanIsPlanar(builder, entry.node, null, stubPosition, [bendPosition])) {
      usedLaneEnds.add(entry.node.nodeId);
      continue;
    }
    await builder.addPolyline({
      startNode: entry.node,
      intermediatePositions: [bendPosition],
      roadClass: ROAD_GRAPH_CLASSES.COLLECTOR,
      purpose: `city-trunk-stub:${stubIndex}`,
      routeId: `${settlementId}:collector:trunk:${stubIndex}`,
      flags: { hierarchy: 'major-route', grammar: profile.roadPattern },
      endRole: 'collector-terminal',
      endPosition: stubPosition,
      endPurpose: `city-trunk-stub:${stubIndex}:terminal`,
    });
    usedLaneEnds.add(entry.node.nodeId);
    routeRecords.push(`trunk:${stubIndex}`);
    stubIndex += 1;
  }

  return Object.freeze({
    localGrowthCount,
    majorRouteCount: routeRecords.length,
    loopCount: (laneA.length - 1) * (laneB.length - 1),
    omittedRoutes: Object.freeze(omittedRoutes),
    grammar: 'GLOBAL_AXIS_LATTICE_WITH_PERPENDICULAR_BRANCHES',
  });
}
export function analyzeRoadGraphV3(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const adjacency = new Map(nodes.map(node => [node.nodeId, []]));
  for (const edge of edges) {
    adjacency.get(edge.startNodeId)?.push({ edge, other: edge.endNodeId });
    adjacency.get(edge.endNodeId)?.push({ edge, other: edge.startNodeId });
  }
  const junctions = nodes.filter(node => (adjacency.get(node.nodeId)?.length ?? 0) >= 3);
  const deadEnds = nodes.filter(node => (adjacency.get(node.nodeId)?.length ?? 0) === 1
    && node.role !== 'connectivity-gateway');
  const localDeadEnds = nodes.filter(node => (adjacency.get(node.nodeId)?.length ?? 0) === 1
    && node.role === 'dead-end');
  const intersectionAngles = [];
  for (const node of junctions) {
    const incident = adjacency.get(node.nodeId);
    for (let first = 0; first < incident.length; first += 1) {
      for (let second = first + 1; second < incident.length; second += 1) {
        const firstVector = subtract(nodesById.get(incident[first].other).position, node.position);
        const secondVector = subtract(nodesById.get(incident[second].other).position, node.position);
        const angle = angleBetween(firstVector, secondVector);
        intersectionAngles.push(Math.min(angle, 180 - angle));
      }
    }
  }
  const exactRightAngleCount = intersectionAngles.filter(angle => Math.abs(angle - 90) <= 1).length;
  const center = graph?.center ?? { x: 0, z: 0 };
  const radius = graph?.metadata?.radiusMeters ?? 1;
  const centerJunctionCount = junctions.filter(node => length(subtract(node.position, center)) <= radius * 0.45).length;
  const outerJunctionCount = junctions.length - centerJunctionCount;
  const centerArea = Math.PI * (radius * 0.45) ** 2;
  const outerArea = Math.PI * radius ** 2 - centerArea;
  const routeGroups = new Map();
  for (const edge of edges) {
    const routeId = edge.flags?.routeId;
    if (!routeGroups.has(routeId)) routeGroups.set(routeId, []);
    routeGroups.get(routeId).push(edge);
  }
  let maximumStraightContinuationLength = 0;
  for (const routeEdges of routeGroups.values()) {
    for (const edge of routeEdges) {
      const start = nodesById.get(edge.startNodeId)?.position;
      const end = nodesById.get(edge.endNodeId)?.position;
      if (start && end) maximumStraightContinuationLength = Math.max(
        maximumStraightContinuationLength,
        length(subtract(end, start)),
      );
    }
  }
  const junctionSpacings = [];
  for (let first = 0; first < junctions.length; first += 1) {
    for (let second = first + 1; second < junctions.length; second += 1) {
      junctionSpacings.push(length(subtract(junctions[first].position, junctions[second].position)));
    }
  }
  // How tightly the street bearings sit on two perpendicular axes. Folding each bearing
  // modulo 90 degrees collapses a rectilinear grid's two families onto one value, so the
  // circular concentration of the folded angles is 1 for a perfect grid and 0 for bearings
  // spread uniformly. Roads that leave for a neighbouring Settlement are excluded, because
  // they are aimed at that neighbour rather than laid along the town plan: the arterial by
  // class, and the collector approach that carries it inward by its gatewayRoute flag. The
  // same exclusion applied to the finite capital is what shows all 42 of its street
  // segments sitting at exactly 0 or 90 degrees.
  const streetEdges = edges.filter(edge => (edge.class === ROAD_GRAPH_CLASSES.COLLECTOR
    || edge.class === ROAD_GRAPH_CLASSES.LOCAL) && edge.flags?.gatewayRoute !== true);
  let bearingCosine = 0;
  let bearingSine = 0;
  for (const edge of streetEdges) {
    const start = nodesById.get(edge.startNodeId)?.position;
    const end = nodesById.get(edge.endNodeId)?.position;
    if (!start || !end) continue;
    const folded = Math.atan2(end.z - start.z, end.x - start.x) * 4;
    bearingCosine += Math.cos(folded);
    bearingSine += Math.sin(folded);
  }
  const streetBearingConcentration = streetEdges.length
    ? Math.hypot(bearingCosine, bearingSine) / streetEdges.length
    : 0;

  // Trunk routes are the ones carrying gateway or major-route traffic. Two are "linked"
  // when a single street route touches nodes on both of them.
  const trunkRouteIds = [...new Set(edges
    .filter(edge => edge.flags?.hierarchy === 'major-route')
    .map(edge => edge.flags?.routeId))].filter(Boolean).sort();
  const nodeTrunkRoutes = new Map();
  for (const edge of edges) {
    if (edge.flags?.hierarchy !== 'major-route') continue;
    for (const nodeId of [edge.startNodeId, edge.endNodeId]) {
      if (!nodeTrunkRoutes.has(nodeId)) nodeTrunkRoutes.set(nodeId, new Set());
      nodeTrunkRoutes.get(nodeId).add(edge.flags.routeId);
    }
  }
  const linkedPairs = new Set();
  const routeTouchedTrunks = new Map();
  for (const edge of edges) {
    if (edge.flags?.hierarchy === 'major-route') continue;
    const routeId = edge.flags?.routeId;
    if (!routeId) continue;
    if (!routeTouchedTrunks.has(routeId)) routeTouchedTrunks.set(routeId, new Set());
    for (const nodeId of [edge.startNodeId, edge.endNodeId]) {
      for (const trunkId of nodeTrunkRoutes.get(nodeId) ?? []) {
        routeTouchedTrunks.get(routeId).add(trunkId);
      }
    }
  }
  for (const touched of routeTouchedTrunks.values()) {
    const list = [...touched].sort();
    for (let first = 0; first < list.length; first += 1) {
      for (let second = first + 1; second < list.length; second += 1) {
        linkedPairs.add(`${list[first]}\u0000${list[second]}`);
      }
    }
  }
  const trunkRoutePairs = trunkRouteIds.length * (trunkRouteIds.length - 1) / 2;
  const linkedTrunkRoutePairs = linkedPairs.size;

  const gatewayContinuityAngles = [];
  for (const edge of edges.filter(value => value.flags?.connectivityGateway)) {
    const gatewayNode = [edge.startNodeId, edge.endNodeId]
      .map(nodeId => nodesById.get(nodeId)).find(node => node?.role === 'connectivity-gateway');
    const junctionNode = nodesById.get(edge.startNodeId === gatewayNode?.nodeId ? edge.endNodeId : edge.startNodeId);
    if (!gatewayNode || !junctionNode) continue;
    const inward = subtract(junctionNode.position, gatewayNode.position);
    const continuation = (adjacency.get(junctionNode.nodeId) ?? [])
      .filter(value => value.edge.edgeId !== edge.edgeId)
      .map(value => subtract(nodesById.get(value.other).position, junctionNode.position))
      .sort((left, right) => angleBetween(inward, left) - angleBetween(inward, right))[0];
    if (continuation) gatewayContinuityAngles.push(angleBetween(inward, continuation));
  }
  return Object.freeze({
    nodeCount: nodes.length,
    edgeCount: edges.length,
    junctionCount: junctions.length,
    deadEndCount: deadEnds.length,
    deadEndRatio: nodes.length ? deadEnds.length / nodes.length : 0,
    localDeadEndCount: localDeadEnds.length,
    localDeadEndRatio: localDeadEnds.length
      / Math.max(1, graph?.metadata?.profileUsage?.resolvedLocalGrowthCount ?? 1),
    cycleRank: edges.length - nodes.length + (nodes.length ? 1 : 0),
    exactRightAngleRate: intersectionAngles.length ? exactRightAngleCount / intersectionAngles.length : 0,
    intersectionAngles: Object.freeze(intersectionAngles.map(q6)),
    junctionSpacingCoefficientOfVariation: coefficientOfVariation(junctionSpacings),
    centerJunctionDensity: centerJunctionCount / centerArea,
    outerJunctionDensity: outerJunctionCount / outerArea,
    maximumStraightContinuationLength,
    streetBearingConcentration: q6(streetBearingConcentration),
    trunkRoutePairs,
    linkedTrunkRoutePairs,
    gatewayContinuityAngles: Object.freeze(gatewayContinuityAngles.map(q6)),
    maximumGatewayContinuityAngle: gatewayContinuityAngles.length ? Math.max(...gatewayContinuityAngles) : 0,
  });
}

export function validateRoadGraphV3(graph) {
  const errors = [];
  if (graph?.schemaVersion !== ROAD_GRAPH_V3_SCHEMA) errors.push('invalid Road Graph schema');
  if (graph?.generatorId !== ROAD_GRAPH_V3_GENERATOR_ID) errors.push('invalid Road Graph generator');
  if (graph?.profileRevision !== ROAD_GRAPH_V3_PROFILE_REVISION) errors.push('invalid profile revision');
  if (graph?.coordinateSpace !== 'logical-world-meters') errors.push('Road Graph must use logical coordinates');
  if (!SETTLEMENT_CLASS_SET.has(graph?.legacySettlementClass)) errors.push('invalid legacy Settlement class');
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const segments = Array.isArray(graph?.segments) ? graph.segments : [];
  if (!Array.isArray(graph?.nodes)) errors.push('Road Graph nodes must be an array');
  if (!Array.isArray(graph?.edges)) errors.push('Road Graph edges must be an array');
  if (!Array.isArray(graph?.segments)) errors.push('Road Graph segments must be an array');

  const nodeIds = new Set();
  const positions = new Set();
  let duplicateNodeCount = 0;
  let duplicateNodePositionCount = 0;
  for (const node of nodes) {
    if (typeof node?.nodeId !== 'string' || !node.nodeId || nodeIds.has(node.nodeId)) duplicateNodeCount += 1;
    else nodeIds.add(node.nodeId);
    if (node?.stableId !== node?.nodeId) errors.push('Road Node stableId must equal nodeId');
    if (![node?.position?.x, node?.position?.z].every(Number.isFinite)) errors.push('invalid Road Node position');
    else {
      const key = coordinateKey(node.position);
      if (positions.has(key)) duplicateNodePositionCount += 1;
      positions.add(key);
    }
  }
  if (duplicateNodeCount) errors.push(`duplicate Road Node count: ${duplicateNodeCount}`);
  if (duplicateNodePositionCount) errors.push(`duplicate Road Node position count: ${duplicateNodePositionCount}`);

  const edgeIds = new Set();
  const endpointPairs = new Set();
  const degree = new Map([...nodeIds].map(nodeId => [nodeId, 0]));
  let duplicateEdgeCount = 0;
  let orphanEdgeCount = 0;
  let selfLoopCount = 0;
  for (const edge of edges) {
    if (typeof edge?.edgeId !== 'string' || !edge.edgeId || edgeIds.has(edge.edgeId)) duplicateEdgeCount += 1;
    else edgeIds.add(edge.edgeId);
    const pair = [edge?.startNodeId, edge?.endNodeId].sort().join('\u0000');
    if (endpointPairs.has(pair)) duplicateEdgeCount += 1;
    endpointPairs.add(pair);
    if (!nodeIds.has(edge?.startNodeId) || !nodeIds.has(edge?.endNodeId)) orphanEdgeCount += 1;
    if (edge?.startNodeId === edge?.endNodeId) selfLoopCount += 1;
    if (edge?.stableId !== edge?.edgeId) errors.push('Road Edge stableId must equal edgeId');
    if (!ROAD_CLASS_SET.has(edge?.class)) errors.push(`invalid Road Edge class: ${edge?.edgeId}`);
    if (edge?.profileRevision !== ROAD_GRAPH_V3_PROFILE_REVISION) errors.push(`invalid Road Edge profile: ${edge?.edgeId}`);
    if (degree.has(edge?.startNodeId)) degree.set(edge.startNodeId, degree.get(edge.startNodeId) + 1);
    if (degree.has(edge?.endNodeId)) degree.set(edge.endNodeId, degree.get(edge.endNodeId) + 1);
  }
  if (duplicateEdgeCount) errors.push(`duplicate Road Edge count: ${duplicateEdgeCount}`);
  if (orphanEdgeCount) errors.push(`orphan Road Edge count: ${orphanEdgeCount}`);
  if (selfLoopCount) errors.push(`self-loop Road Edge count: ${selfLoopCount}`);
  const orphanNodeCount = [...degree.values()].filter(value => value === 0).length;
  if (orphanNodeCount) errors.push(`orphan Road Node count: ${orphanNodeCount}`);
  for (const node of nodes.filter(value => value.role === 'bend')) {
    if (degree.get(node.nodeId) !== 2) errors.push(`bend node must have degree 2: ${node.nodeId}`);
  }

  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  let selfIntersectionCount = 0;
  const selfIntersectionPairs = [];
  for (let firstIndex = 0; firstIndex < edges.length; firstIndex += 1) {
    const first = edges[firstIndex];
    const firstStart = nodesById.get(first.startNodeId)?.position;
    const firstEnd = nodesById.get(first.endNodeId)?.position;
    if (!firstStart || !firstEnd) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < edges.length; secondIndex += 1) {
      const second = edges[secondIndex];
      if ([first.startNodeId, first.endNodeId].some(nodeId => nodeId === second.startNodeId
        || nodeId === second.endNodeId)) continue;
      const secondStart = nodesById.get(second.startNodeId)?.position;
      const secondEnd = nodesById.get(second.endNodeId)?.position;
      if (secondStart && secondEnd && segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) {
        selfIntersectionCount += 1;
        selfIntersectionPairs.push(`${first.purpose}<->${second.purpose}`);
      }
    }
  }
  if (selfIntersectionCount) {
    errors.push(`self-intersection count: ${selfIntersectionCount} (${selfIntersectionPairs.join(', ')})`);
  }

  const segmentIds = new Set();
  const edgesById = new Map(edges.map(edge => [edge.edgeId, edge]));
  for (const segment of segments) {
    if (segment?.schemaVersion !== ROAD_GRAPH_V3_SEGMENT_SCHEMA) errors.push('invalid segment schema');
    if (segmentIds.has(segment?.stableId)) errors.push(`duplicate Road Segment: ${segment.stableId}`);
    segmentIds.add(segment?.stableId);
    const edge = edgesById.get(segment?.edgeId);
    if (!edge) errors.push(`Road Segment has no Edge: ${segment?.stableId}`);
    else if (coordinateKey(segment.start) !== coordinateKey(nodesById.get(edge.startNodeId)?.position)
      || coordinateKey(segment.end) !== coordinateKey(nodesById.get(edge.endNodeId)?.position)) {
      errors.push(`Road Segment endpoints do not match Edge: ${segment.stableId}`);
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
    .filter(nodeId => !nodeIds.has(nodeId) || !reachable.has(nodeId)).length;
  if (disconnectedRequiredGatewayCount) {
    errors.push(`${disconnectedRequiredGatewayCount} required connectivity gateways are disconnected`);
  }

  if (nodes.length && edges.length && SETTLEMENT_CLASS_SET.has(graph?.legacySettlementClass)) {
    const metrics = analyzeRoadGraphV3(graph);
    if (metrics.junctionSpacingCoefficientOfVariation <= 0) {
      errors.push('junction spacing must be non-uniform');
    }
    if (metrics.maximumStraightContinuationLength
      > (graph?.metadata?.straightContinuationLimitMeters ?? 0) + GEOMETRY_EPSILON) {
      errors.push('straight continuation limit exceeded');
    }
    if (metrics.gatewayContinuityAngles.some(angle => angle >= 25)) {
      errors.push('gateway route direction continuity exceeded');
    }
    const collectorRouteCount = new Set(edges.filter(edge => edge.class === ROAD_GRAPH_CLASSES.COLLECTOR)
      .map(edge => edge.flags?.routeId)).size;
    if (graph.legacySettlementClass === SETTLEMENT_TYPES.RURAL) {
      if (collectorRouteCount !== 1) errors.push('RURAL requires one collector route');
      if (metrics.cycleRank < 0 || metrics.cycleRank > 1) errors.push('RURAL cycle rank must be within 0..1');
      if (metrics.exactRightAngleRate >= 0.25) errors.push('RURAL right-angle rate must be below 25%');
    } else if (graph.legacySettlementClass === SETTLEMENT_TYPES.TOWN) {
      if (collectorRouteCount !== 1) errors.push('TOWN requires one collector route');
      if (metrics.cycleRank < 1 || metrics.cycleRank > 3) errors.push('TOWN cycle rank must be within 1..3');
      if (metrics.exactRightAngleRate >= 0.5) errors.push('TOWN right-angle rate must be below 50%');
      if (metrics.localDeadEndRatio < (graph?.metadata?.deadEndTargetRange?.minimum ?? 0)
        || metrics.localDeadEndRatio > (graph?.metadata?.deadEndTargetRange?.maximum ?? 1)) {
        errors.push('TOWN dead-end ratio is outside its profile range');
      }
    } else if (graph.legacySettlementClass === SETTLEMENT_TYPES.CITY) {
      if (collectorRouteCount < 2 || collectorRouteCount > 3) {
        errors.push('CITY requires two or three major routes');
      }
      if (metrics.cycleRank < 2 || metrics.cycleRank > 3) errors.push('CITY cycle rank must be within 2..3');
      if (metrics.centerJunctionDensity <= metrics.outerJunctionDensity) {
        errors.push('CITY center junction density must exceed outer density');
      }
      // The check this replaces was `edges.some(e => e.flags.crossConnection &&
      // e.flags.incomplete)`, and both flags are hardcoded literals at the single
      // addArcConnection call site - never computed, never false. It therefore tested which
      // function drew the edge rather than any property of the result, and the finite
      // capital fails it outright because it has no arcs at all. What CITY actually
      // declares is `roadPattern: GRID`, which nothing enforced, so that is checked now.
      if (metrics.streetBearingConcentration < CITY_GRID_CONCENTRATION_MINIMUM) {
        errors.push('CITY streets must align to two perpendicular axes');
      }
      // The other half of "incomplete cross connections". Phrasing it as "not every trunk
      // pair may be linked" does not survive contact with a lattice, where every lane
      // reaches both trunks; that reading only ever made sense for radial spokes. What the
      // word was reaching for is that a capital is not a closed figure - it still has
      // streets that stop. The finite capital satisfies this emphatically with 24 dead-end
      // branches, and a fully closed lattice with no stubs would not.
      if (metrics.localDeadEndCount < 1) {
        errors.push('CITY requires local streets that terminate');
      }
    }
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

export async function createRoadGraphV3({ worldSeedHash, settlement, gateways = [] } = {}) {
  requireRecord(settlement, 'settlement');
  const settlementId = requireString(settlement.settlementId ?? settlement.semanticId, 'settlement.settlementId');
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
  const profile = SETTLEMENT_ROAD_PARAMETERS[legacySettlementClass];
  const sourceOwner = Object.freeze({
    settlementId,
    macroRegion: Object.freeze({ ...(settlement.sourceOwner?.macroRegion ?? settlement.macroRegion ?? {}) }),
  });
  const sortedGateways = Object.freeze(gateways.map((gateway, index) => normalizeGateway(gateway, index, center))
    .sort((left, right) => left.gatewayId.localeCompare(right.gatewayId)));
  const random = await createSemanticIdKeyedRandom({ worldSeedHash, semanticStableId: settlementId });
  const builder = await createBuilder({
    worldSeedHash,
    settlementId,
    sourceOwner,
    widths: roadWidths(legacySettlementClass),
  });
  const requiredGatewayNodeIds = [];
  const grammarResult = legacySettlementClass === SETTLEMENT_TYPES.CITY
    ? await createCityGrammar({
      builder, random, center, radius, settlementId, profile, gateways: sortedGateways,
      requiredGatewayNodeIds,
    })
    : await createOrganicOrTownGrammar({
      builder, random, center, radius, settlementId, profile, gateways: sortedGateways,
      settlementType: legacySettlementClass, requiredGatewayNodeIds,
    });
  const segments = builder.buildSegments();
  const graph = Object.freeze({
    schemaVersion: ROAD_GRAPH_V3_SCHEMA,
    generatorId: ROAD_GRAPH_V3_GENERATOR_ID,
    profileRevision: ROAD_GRAPH_V3_PROFILE_REVISION,
    coordinateSpace: 'logical-world-meters',
    settlementId,
    legacySettlementClass,
    center,
    sourceOwner,
    metadata: Object.freeze({
      gatewayMode: sortedGateways.length ? 'CONNECTIVITY_GATEWAYS' : 'ISOLATED_FALLBACK',
      fallbackType: sortedGateways.length ? null : ROAD_GRAPH_V3_ISOLATED_FALLBACK,
      requiredGatewayIds: Object.freeze(sortedGateways.map(gateway => gateway.gatewayId)),
      requiredGatewayNodeIds: Object.freeze([...requiredGatewayNodeIds].sort()),
      fictitiousGatewayCount: 0,
      authority: ROAD_GRAPH_V3_GENERATOR_ID,
      planar: true,
      roadOnly: true,
      blockGeneratorConnected: false,
      radiusMeters: radius,
      straightContinuationLimitMeters: q6(radius * 0.64),
      deadEndTargetRange: Object.freeze({
        minimum: q6(clamp(profile.deadEndBias - 0.2, 0, 1)),
        maximum: q6(clamp(profile.deadEndBias + 0.3, 0, 1)),
      }),
      grammar: grammarResult.grammar,
      loopTarget: grammarResult.loopCount,
      // Counted, not silent: a local street the grammar could not fit shows up here the
      // way the finite game surfaces omittedRouteCount on its town summary.
      omittedRoutes: grammarResult.omittedRoutes ?? Object.freeze([]),
      profileUsage: createProfileUsage(profile, grammarResult.localGrowthCount, grammarResult.majorRouteCount),
    }),
    nodes: Object.freeze(builder.nodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId))),
    edges: Object.freeze(builder.edges.sort((left, right) => left.edgeId.localeCompare(right.edgeId))),
    segments: Object.freeze(segments.sort((left, right) => left.stableId.localeCompare(right.stableId))),
  });
  const validation = validateRoadGraphV3(graph);
  if (!validation.valid) throw new Error(`invalid road-graph-v3: ${validation.errors.join('; ')}`);
  return graph;
}

export const ROAD_GRAPH_V3_STAGE_GENERATOR = Object.freeze({
  stage: 'roadGraph',
  generatorId: ROAD_GRAPH_V3_GENERATOR_ID,
  generate: createRoadGraphV3,
});

const experimentalRegistry = createSettlementStageGeneratorRegistry();
experimentalRegistry.register(ROAD_GRAPH_V3_STAGE_GENERATOR);
experimentalRegistry.freeze();

export const ROAD_GRAPH_V3_EXPERIMENTAL_STAGE_GENERATOR_REGISTRY = experimentalRegistry;
