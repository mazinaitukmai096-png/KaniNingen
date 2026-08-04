import { ROAD_KINDS } from '../road-town-structure.js';
import {
  FINITE_WORLD_UNITS_PER_METER,
  MIGRATED_SETTLEMENT_PROFILES,
  W4_SINGLE_RURAL,
  buildDeterministicBuildings,
} from './single-rural-settlement.js';
import {
  EXPERIMENTAL_SETTLEMENT_STAGE_GENERATOR_REGISTRY,
  ROAD_GRAPH_CLASSES,
  ROAD_GRAPH_V1_GENERATOR_ID,
} from './road-graph-v1.js';

export const ROAD_GRAPH_V1_SETTLEMENT_TEMPLATE_SCHEMA = 'w5-road-graph-v1-settlement-template-1';

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

export function resolveRoadGraphV1ConnectivityGateways({ candidate, connectivityGraph } = {}) {
  if (!candidate?.settlementId || !connectivityGraph?.nodes || !connectivityGraph?.edges) {
    throw new TypeError('candidate and Settlement connectivity graph are required');
  }
  const nodesById = new Map(connectivityGraph.nodes.map(node => [node.stableId, node]));
  return Object.freeze(connectivityGraph.edges
    .filter(edge => edge.settlementIds.includes(candidate.settlementId))
    .map(edge => {
      const targetSettlementId = edge.settlementIds.find(id => id !== candidate.settlementId);
      const target = nodesById.get(targetSettlementId);
      if (!target) throw new Error(`connectivity gateway has no target Settlement: ${edge.stableId}`);
      return Object.freeze({
        gatewayId: edge.stableId,
        targetSettlementId,
        target: target.center,
        sourceOwner: Object.freeze({
          connectivityEdgeId: edge.stableId,
          macroRegion: edge.ownerRegion,
        }),
      });
    })
    .sort((left, right) => left.gatewayId.localeCompare(right.gatewayId)));
}

function adaptRoadGraphToLegacyHierarchy({ graph, candidate, town }) {
  const roads = graph.segments.map(segment => {
    const start = {
      x: (segment.start.x - candidate.center.x) * FINITE_WORLD_UNITS_PER_METER,
      z: (segment.start.z - candidate.center.z) * FINITE_WORLD_UNITS_PER_METER,
    };
    const end = {
      x: (segment.end.x - candidate.center.x) * FINITE_WORLD_UNITS_PER_METER,
      z: (segment.end.z - candidate.center.z) * FINITE_WORLD_UNITS_PER_METER,
    };
    return Object.freeze({
      roadId: segment.stableId,
      routeId: segment.flags.routeId,
      routeOrder: segment.flags.routeOrder,
      kind: LEGACY_KIND_BY_CLASS[segment.class],
      roadClass: segment.class,
      width: segment.widthMeters * FINITE_WORLD_UNITS_PER_METER,
      start: Object.freeze(start),
      end: Object.freeze(end),
      tangentX: segment.tangent.x,
      tangentZ: segment.tangent.z,
      normalX: segment.normal.x,
      normalZ: segment.normal.z,
      town,
      townId: town.id,
      isTownSpine: segment.class === ROAD_GRAPH_CLASSES.COLLECTOR,
      sourceOwner: segment.sourceOwner,
      purpose: segment.purpose,
      flags: segment.flags,
    });
  });
  const pathSamples = [];
  let sequence = 0;
  for (const road of roads) {
    const length = Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z);
    const sampleCount = Math.max(1, Math.ceil(length / 52));
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const t = (sampleIndex + 0.5) / sampleCount;
      pathSamples.push(Object.freeze({
        x: road.start.x + (road.end.x - road.start.x) * t,
        z: road.start.z + (road.end.z - road.start.z) * t,
        tc: town,
        roadId: road.roadId,
        routeId: road.routeId,
        kind: road.kind,
        width: road.width,
        tangentX: road.tangentX,
        tangentZ: road.tangentZ,
        normalX: road.normalX,
        normalZ: road.normalZ,
        length: length / sampleCount,
        routeOrder: road.routeOrder,
        sampleIndex,
        sequence: sequence++,
        isWater: false,
        isBlocked: false,
      }));
    }
  }
  return Object.freeze({ roads: Object.freeze(roads), pathSamples: Object.freeze(pathSamples) });
}

function translateRectangle(rectangle, center) {
  return Object.freeze({
    ...rectangle,
    centerX: q6(rectangle.centerX + center.x),
    centerZ: q6(rectangle.centerZ + center.z),
  });
}

export async function createRoadGraphV1SettlementTemplate({
  worldSeedHash,
  candidate,
  connectivityGraph,
  roadTimingRun = null,
} = {}) {
  const profile = MIGRATED_SETTLEMENT_PROFILES[candidate?.townType];
  if (!profile || profile.settlementType !== candidate?.settlementType) {
    throw new RangeError('candidate does not match a migrated Settlement profile');
  }
  const gateways = resolveRoadGraphV1ConnectivityGateways({ candidate, connectivityGraph });
  const graph = await EXPERIMENTAL_SETTLEMENT_STAGE_GENERATOR_REGISTRY.get(
    'roadGraph',
    ROAD_GRAPH_V1_GENERATOR_ID,
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
  const town = Object.freeze({
    id: candidate.settlementId,
    x: 0,
    z: 0,
    radius: profile.radius,
    coreRadius: profile.coreRadius,
    type: candidate.townType,
    settlementType: candidate.settlementType,
  });
  const hierarchy = adaptRoadGraphToLegacyHierarchy({ graph, candidate, town });
  const buildingResult = await buildDeterministicBuildings({
    town,
    hierarchy,
    settlementId: candidate.settlementId,
    roadTimingRun,
  });
  const buildings = buildingResult.buildings.map(building => Object.freeze({
    ...building,
    x: q6(building.x + candidate.center.x),
    z: q6(building.z + candidate.center.z),
    lot: Object.freeze({
      ...building.lot,
      centerX: q6(building.lot.centerX + candidate.center.x),
      centerZ: q6(building.lot.centerZ + candidate.center.z),
      entranceX: q6(building.lot.entranceX + candidate.center.x),
      entranceZ: q6(building.lot.entranceZ + candidate.center.z),
      roadAccessX: q6(building.lot.roadAccessX + candidate.center.x),
      roadAccessZ: q6(building.lot.roadAccessZ + candidate.center.z),
      path: translateRectangle(building.lot.path, candidate.center),
      forecourt: translateRectangle(building.lot.forecourt, candidate.center),
    }),
  }));
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
  const roadClassCounts = Object.freeze(Object.fromEntries(
    Object.values(ROAD_GRAPH_CLASSES).map(roadClass => [
      roadClass,
      roads.filter(road => road.roadClass === roadClass).length,
    ]),
  ));
  return Object.freeze({
    schemaVersion: ROAD_GRAPH_V1_SETTLEMENT_TEMPLATE_SCHEMA,
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
    requestedBuildingCount: buildingResult.requestedBuildingCount,
    buildingShortageCount: buildingResult.requestedBuildingCount - buildings.length,
    roads: Object.freeze(roads),
    buildings: Object.freeze(buildings),
    roadSummary: Object.freeze({
      generatorId: ROAD_GRAPH_V1_GENERATOR_ID,
      roadClassCounts,
      gatewayMode: graph.metadata.gatewayMode,
      fallbackType: graph.metadata.fallbackType,
      fictitiousGatewayCount: 0,
    }),
    roadGraph: graph,
  });
}
