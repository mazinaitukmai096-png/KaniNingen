import { ROAD_KINDS } from '../road-town-structure.js';
import {
  FINITE_WORLD_UNITS_PER_METER,
  MIGRATED_SETTLEMENT_PROFILES,
  W4_SINGLE_RURAL,
} from './single-rural-settlement.js';
import { createSettlementRoadGatewayHandoff } from './settlement-road-gateway-handoff.js';
import { resolveRoadGraphV1ConnectivityGateways } from './road-graph-v1-settlement-adapter.js';
import { ROAD_GRAPH_CLASSES } from './road-graph-v1.js';
import {
  ROAD_GRAPH_V3_EXPERIMENTAL_STAGE_GENERATOR_REGISTRY,
  ROAD_GRAPH_V3_GENERATOR_ID,
} from './road-graph-v3.js';

export const ROAD_GRAPH_V3_SETTLEMENT_TEMPLATE_SCHEMA = 'w5-road-graph-v3-road-only-template-1';

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const LEGACY_KIND_BY_CLASS = Object.freeze({
  [ROAD_GRAPH_CLASSES.ARTERIAL]: ROAD_KINDS.MAJOR,
  [ROAD_GRAPH_CLASSES.COLLECTOR]: ROAD_KINDS.LOCAL,
  [ROAD_GRAPH_CLASSES.LOCAL]: ROAD_KINDS.LOCAL,
  [ROAD_GRAPH_CLASSES.ALLEY]: ROAD_KINDS.ALLEY,
});

function createGatewayHandoffs(graph, candidate) {
  const nodesById = new Map(graph.nodes.map(node => [node.nodeId, node]));
  return Object.freeze(graph.edges
    .filter(edge => edge.flags.connectivityGateway === true)
    .map(edge => {
      const gatewayNode = [edge.startNodeId, edge.endNodeId]
        .map(nodeId => nodesById.get(nodeId))
        .find(node => node?.role === 'connectivity-gateway');
      if (!gatewayNode || gatewayNode.gatewayId !== edge.flags.routeId.slice(
        `${candidate.settlementId}:arterial:`.length,
      )) {
        throw new Error(`Road Graph arterial requires one gateway node: ${edge.stableId}`);
      }
      return createSettlementRoadGatewayHandoff({
        gatewayStableId: gatewayNode.stableId,
        connectivityEdgeId: gatewayNode.gatewayId,
        settlementId: candidate.settlementId,
        targetSettlementId: gatewayNode.targetSettlementId,
        arterialRoadStableId: edge.stableId,
        logicalPosition: gatewayNode.position,
      });
    })
    .sort((left, right) => left.connectivityEdgeId.localeCompare(right.connectivityEdgeId)
      || left.gatewayStableId.localeCompare(right.gatewayStableId)));
}

export async function createRoadGraphV3SettlementTemplate({
  worldSeedHash,
  candidate,
  connectivityGraph,
} = {}) {
  const profile = MIGRATED_SETTLEMENT_PROFILES[candidate?.townType];
  if (!profile || profile.settlementType !== candidate?.settlementType) {
    throw new RangeError('candidate does not match a migrated Settlement profile');
  }
  const gateways = resolveRoadGraphV1ConnectivityGateways({ candidate, connectivityGraph });
  const graph = await ROAD_GRAPH_V3_EXPERIMENTAL_STAGE_GENERATOR_REGISTRY.get(
    'roadGraph',
    ROAD_GRAPH_V3_GENERATOR_ID,
  ).generate({
    worldSeedHash,
    settlement: {
      settlementId: candidate.settlementId,
      settlementType: candidate.settlementType,
      center: candidate.center,
      radiusMeters: q6(profile.radius / FINITE_WORLD_UNITS_PER_METER),
      macroRegion: candidate.macroRegion,
    },
    gateways,
  });
  const roads = graph.segments.map(segment => Object.freeze({
    stableId: segment.stableId,
    featureType: 'settlement-road',
    settlementId: candidate.settlementId,
    sourceRoadId: segment.stableId,
    routeId: segment.flags.routeId,
    routeOrder: segment.flags.routeOrder,
    roadKind: LEGACY_KIND_BY_CLASS[segment.class],
    roadClass: segment.class,
    widthMeters: segment.widthMeters,
    start: segment.start,
    end: segment.end,
    sourceOwner: segment.sourceOwner,
    purpose: segment.purpose,
    flags: segment.flags,
  })).sort((left, right) => left.stableId.localeCompare(right.stableId));
  const maximumRoadDistance = roads.reduce((maximum, road) => Math.max(
    maximum,
    Math.hypot(road.start.x - candidate.center.x, road.start.z - candidate.center.z),
    Math.hypot(road.end.x - candidate.center.x, road.end.z - candidate.center.z),
  ), 0);
  const radiusMeters = q6(profile.radius / FINITE_WORLD_UNITS_PER_METER);
  const gatewayHandoffs = createGatewayHandoffs(graph, candidate);
  const roadClassCounts = Object.freeze(Object.fromEntries(
    Object.values(ROAD_GRAPH_CLASSES).map(roadClass => [
      roadClass,
      roads.filter(road => road.roadClass === roadClass).length,
    ]),
  ));
  return Object.freeze({
    schemaVersion: ROAD_GRAPH_V3_SETTLEMENT_TEMPLATE_SCHEMA,
    settlementId: candidate.settlementId,
    settlementType: candidate.settlementType,
    townType: candidate.townType,
    macroRegion: candidate.macroRegion,
    center: Object.freeze({ ...candidate.center }),
    radiusMeters,
    coreRadiusMeters: q6(profile.coreRadius / FINITE_WORLD_UNITS_PER_METER),
    influenceRadiusMeters: q6(Math.max(radiusMeters, maximumRoadDistance + 4)),
    urbanization: candidate.urbanization,
    terrainSuitability: candidate.terrainSuitability,
    scaleContract: Object.freeze({
      finiteWorldUnitsPerMeter: FINITE_WORLD_UNITS_PER_METER,
      productionHumanHeightMeters: W4_SINGLE_RURAL.productionHumanHeightMeters,
    }),
    requestedBuildingCount: 0,
    buildingShortageCount: 0,
    roads: Object.freeze(roads),
    buildings: Object.freeze([]),
    blocks: Object.freeze([]),
    gatewayHandoffs,
    roadSummary: Object.freeze({
      generatorId: ROAD_GRAPH_V3_GENERATOR_ID,
      roadClassCounts,
      gatewayMode: graph.metadata.gatewayMode,
      gatewayHandoffCount: gatewayHandoffs.length,
      fallbackType: graph.metadata.fallbackType,
      fictitiousGatewayCount: 0,
      blockCount: 0,
      roadOnly: true,
    }),
    roadGraph: graph,
  });
}
