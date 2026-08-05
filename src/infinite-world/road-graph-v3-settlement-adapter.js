import { ROAD_KINDS } from '../road-town-structure.js';
import {
  FINITE_WORLD_UNITS_PER_METER,
  MIGRATED_SETTLEMENT_PROFILES,
  W4_SINGLE_RURAL,
  buildDeterministicBuildings,
} from './single-rural-settlement.js';
import { createSettlementRoadGatewayHandoff } from './settlement-road-gateway-handoff.js';
import { resolveRoadGraphV1ConnectivityGateways } from './road-graph-v1-settlement-adapter.js';
import { ROAD_GRAPH_CLASSES } from './road-graph-v1.js';
import {
  ROAD_GRAPH_V3_EXPERIMENTAL_STAGE_GENERATOR_REGISTRY,
  ROAD_GRAPH_V3_GENERATOR_ID,
} from './road-graph-v3.js';
import {
  SETTLEMENT_LOT_V1_GENERATOR_ID,
  createRoadGraphV3Blocks,
  createSettlementLotsV1,
} from './settlement-lot-v1.js';
import {
  buildDeterministicBuildingsFromLots,
  filterScatterBuildingsForLotCoverage,
} from './lot-building-adapter-v1.js';
import {
  SETTLEMENT_LOT_V2_GENERATOR_ID,
  SETTLEMENT_LOT_V2_PLACEMENT_SOURCES,
  buildDeterministicFrontageFallbackBuildingsV2,
  decorateLotV2Buildings,
} from './settlement-lot-v2.js';

export const ROAD_GRAPH_V3_SETTLEMENT_TEMPLATE_SCHEMA = 'w5-road-graph-v3-road-only-template-1';
export const ROAD_GRAPH_V3_LOT_V1_SETTLEMENT_TEMPLATE_SCHEMA = 'w5-road-graph-v3-lot-v1-template-1';
export const ROAD_GRAPH_V3_LOT_V2_SETTLEMENT_TEMPLATE_SCHEMA = 'w5-road-graph-v3-lot-v2-template-1';

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
  roadTimingRun = null,
  settlementLotMode = null,
} = {}) {
  if (settlementLotMode !== null
    && settlementLotMode !== SETTLEMENT_LOT_V1_GENERATOR_ID
    && settlementLotMode !== SETTLEMENT_LOT_V2_GENERATOR_ID) {
    throw new RangeError(`unsupported experimental Settlement Lot mode: ${settlementLotMode}`);
  }
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
  const scatterBuildingResult = await buildDeterministicBuildings({
    town,
    hierarchy,
    settlementId: candidate.settlementId,
    roadTimingRun,
  });
  let blocks = Object.freeze([]);
  let lots = Object.freeze([]);
  let blockResults = Object.freeze([]);
  let buildingResult = scatterBuildingResult;
  let lotSummary = null;
  if (settlementLotMode === SETTLEMENT_LOT_V1_GENERATOR_ID) {
    blocks = await createRoadGraphV3Blocks({ worldSeedHash, roadGraph: graph });
    const generatedLots = await createSettlementLotsV1({ worldSeedHash, roadGraph: graph, blocks });
    lots = generatedLots.lots;
    blockResults = generatedLots.blockResults;
    const lotBuildings = await buildDeterministicBuildingsFromLots({
      town,
      settlementId: candidate.settlementId,
      roadGraph: graph,
      candidate,
      lots,
    });
    if (!generatedLots.validation.valid || !lotBuildings.validation.valid) {
      lots = Object.freeze([]);
      blockResults = Object.freeze(blockResults.map(result => Object.freeze({
        ...result,
        mode: 'SCATTER_FALLBACK',
        fallbackReason: 'VALIDATION_FAILED',
        lotIds: Object.freeze([]),
      })));
      lotSummary = Object.freeze({
        blockResults,
        blockCount: blocks.length,
        lotCount: 0,
        usedLotCount: 0,
        lotUtilization: 0,
        scatterFallbackBlockCount: Math.max(1, blocks.length),
        scatterFallbackBuildingCount: scatterBuildingResult.buildings.length,
        emptyLotCount: 0,
        frontageFailureCount: generatedLots.frontageFailureCount,
        lotValidation: generatedLots.validation,
        buildingValidation: lotBuildings.validation,
      });
    } else {
      const fallback = filterScatterBuildingsForLotCoverage({
        scatterBuildings: scatterBuildingResult.buildings,
        lots,
        blocks,
        blockResults,
        roadGraph: graph,
        candidate,
      });
      const lotBuildingIndexes = new Set(lotBuildings.buildings.map(building => building.buildingIndex));
      const fallbackBuildings = fallback.buildings.filter(
        building => !lotBuildingIndexes.has(building.buildingIndex),
      );
      const combined = [...lotBuildings.buildings, ...fallbackBuildings]
        .sort((left, right) => left.stableId.localeCompare(right.stableId));
      const unique = [];
      const buildingIds = new Set();
      for (const building of combined) {
        if (buildingIds.has(building.stableId)) continue;
        buildingIds.add(building.stableId);
        unique.push(building);
      }
      buildingResult = Object.freeze({
        requestedBuildingCount: scatterBuildingResult.requestedBuildingCount,
        buildings: Object.freeze(unique),
      });
      lotSummary = Object.freeze({
        blockResults,
        blockCount: blocks.length,
        lotCount: lots.length,
        usedLotCount: lotBuildings.usedLotIds.length,
        lotUtilization: lots.length === 0 ? 0 : q6(lotBuildings.usedLotIds.length / lots.length),
        scatterFallbackBlockCount: blockResults.filter(result => (
          result.mode === 'SCATTER_FALLBACK'
        )).length + (blocks.length === 0 ? 1 : 0),
        scatterFallbackBuildingCount: fallbackBuildings.length,
        excludedScatterBuildingCount: fallback.excludedCount,
        emptyLotCount: lotBuildings.emptyLotCount,
        frontageFailureCount: generatedLots.frontageFailureCount,
        lotValidation: generatedLots.validation,
        buildingValidation: lotBuildings.validation,
      });
    }
  } else if (settlementLotMode === SETTLEMENT_LOT_V2_GENERATOR_ID) {
    blocks = await createRoadGraphV3Blocks({ worldSeedHash, roadGraph: graph });
    const generatedLots = await createSettlementLotsV1({ worldSeedHash, roadGraph: graph, blocks });
    lots = generatedLots.validation.valid ? generatedLots.lots : Object.freeze([]);
    blockResults = Object.freeze(generatedLots.blockResults.map(result => Object.freeze({
      ...result,
      mode: result.mode === 'SCATTER_FALLBACK' ? 'EMPTY' : result.mode,
    })));
    const generatedLotBuildings = await buildDeterministicBuildingsFromLots({
      town,
      settlementId: candidate.settlementId,
      roadGraph: graph,
      candidate,
      lots,
    });
    const lotBuildings = generatedLotBuildings.validation.valid
      ? decorateLotV2Buildings(generatedLotBuildings.buildings)
      : Object.freeze([]);
    const closedBlockCount = blocks.filter(block => block.isClosed === true).length;
    let frontageFallbackBuildings = Object.freeze([]);
    let legacyScatterBuildings = Object.freeze([]);
    let fallbackValidation = Object.freeze({
      valid: true,
      duplicateBuildingIdCount: 0,
      orphanFrontageCount: 0,
      blockCoverageOverlapCount: 0,
      lotOverlapCount: 0,
      buildingOverlapCount: 0,
      roadOverlapCount: 0,
      junctionClearanceFailureCount: 0,
    });
    if (closedBlockCount === 0) {
      legacyScatterBuildings = scatterBuildingResult.buildings;
    } else {
      const fallback = await buildDeterministicFrontageFallbackBuildingsV2({
        town,
        settlementId: candidate.settlementId,
        roadGraph: graph,
        candidate,
        blocks,
        lots,
        lotBuildings,
      });
      frontageFallbackBuildings = fallback.buildings;
      fallbackValidation = fallback.validation;
    }
    const combined = [...lotBuildings, ...frontageFallbackBuildings, ...legacyScatterBuildings]
      .sort((left, right) => left.stableId.localeCompare(right.stableId));
    const unique = [];
    const buildingIds = new Set();
    for (const building of combined) {
      if (buildingIds.has(building.stableId)) continue;
      buildingIds.add(building.stableId);
      unique.push(building);
    }
    buildingResult = Object.freeze({
      requestedBuildingCount: scatterBuildingResult.requestedBuildingCount,
      buildings: Object.freeze(unique),
    });
    lotSummary = Object.freeze({
      blockResults,
      blockCount: blocks.length,
      closedBlockCount,
      lotCount: lots.length,
      usedLotCount: lotBuildings.length,
      lotUtilization: lots.length === 0 ? 0 : q6(lotBuildings.length / lots.length),
      scatterFallbackBlockCount: blockResults.filter(result => result.mode === 'EMPTY').length
        + (blocks.length === 0 ? 1 : 0),
      scatterFallbackBuildingCount: legacyScatterBuildings.length,
      frontageFallbackBuildingCount: frontageFallbackBuildings.length,
      legacyScatterBuildingCount: legacyScatterBuildings.length,
      excludedScatterBuildingCount: closedBlockCount > 0
        ? scatterBuildingResult.buildings.length : 0,
      emptyLotCount: lots.length - lotBuildings.length,
      frontageFailureCount: generatedLots.frontageFailureCount,
      lotValidation: generatedLots.validation,
      buildingValidation: generatedLotBuildings.validation,
      fallbackValidation,
    });
  }
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
  const gatewayHandoffs = createGatewayHandoffs(graph, candidate);
  const roadClassCounts = Object.freeze(Object.fromEntries(
    Object.values(ROAD_GRAPH_CLASSES).map(roadClass => [
      roadClass,
      roads.filter(road => road.roadClass === roadClass).length,
    ]),
  ));
  return Object.freeze({
    schemaVersion: settlementLotMode === SETTLEMENT_LOT_V1_GENERATOR_ID
      ? ROAD_GRAPH_V3_LOT_V1_SETTLEMENT_TEMPLATE_SCHEMA
      : settlementLotMode === SETTLEMENT_LOT_V2_GENERATOR_ID
        ? ROAD_GRAPH_V3_LOT_V2_SETTLEMENT_TEMPLATE_SCHEMA
        : ROAD_GRAPH_V3_SETTLEMENT_TEMPLATE_SCHEMA,
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
    blocks,
    ...(settlementLotMode === SETTLEMENT_LOT_V1_GENERATOR_ID
      || settlementLotMode === SETTLEMENT_LOT_V2_GENERATOR_ID ? {
      settlementLotMode,
      lots,
      lotSummary,
    } : {}),
    gatewayHandoffs,
    roadSummary: Object.freeze({
      generatorId: ROAD_GRAPH_V3_GENERATOR_ID,
      roadClassCounts,
      gatewayMode: graph.metadata.gatewayMode,
      gatewayHandoffCount: gatewayHandoffs.length,
      fallbackType: graph.metadata.fallbackType,
      fictitiousGatewayCount: 0,
      blockCount: blocks.length,
      roadOnly: settlementLotMode !== SETTLEMENT_LOT_V1_GENERATOR_ID
        && settlementLotMode !== SETTLEMENT_LOT_V2_GENERATOR_ID,
      ...(settlementLotMode === SETTLEMENT_LOT_V1_GENERATOR_ID
        || settlementLotMode === SETTLEMENT_LOT_V2_GENERATOR_ID ? {
        lotGeneratorId: settlementLotMode,
        lotCount: lots.length,
        lotBuildingCount: lotSummary.usedLotCount,
        scatterFallbackBlockCount: lotSummary.scatterFallbackBlockCount,
        scatterFallbackBuildingCount: lotSummary.scatterFallbackBuildingCount,
        ...(settlementLotMode === SETTLEMENT_LOT_V2_GENERATOR_ID ? {
          frontageFallbackBuildingCount: lotSummary.frontageFallbackBuildingCount,
          legacyScatterBuildingCount: lotSummary.legacyScatterBuildingCount,
          fallbackPlacementSource: SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.FRONTAGE_FALLBACK,
        } : {}),
      } : {}),
    }),
    roadGraph: graph,
  });
}
