import {
  createFrontagePlacement,
  frontageSpotsConflict,
} from '../building-frontage.js';
import { createBuildingLot, orientedRectanglesOverlap } from '../building-lot.js';
import { ROAD_KINDS } from '../road-town-structure.js';
import {
  createSettlementBuildingVisual,
  isTowerPlacementAllowed,
} from '../settlement-building-visuals.js';
import { SETTLEMENT_TYPES } from '../settlement-type.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { ROAD_GRAPH_CLASSES } from './road-graph-v1.js';
import {
  convexPolygonsOverlap,
  deriveSettlementBlockPolygon,
  settlementPolygonsOverlap,
} from './settlement-lot-v1.js';
import { FINITE_WORLD_UNITS_PER_METER } from './single-rural-settlement.js';
import { createW8SettlementBuildingTypeSelector } from './w8-settlement-building-visual-policy.js';

export const SETTLEMENT_LOT_V2_GENERATOR_ID = 'lot-v2';

export const SETTLEMENT_LOT_V2_FALLBACK_PARAMETERS = Object.freeze({
  slotSpacingMeters: 12,
  junctionClearanceMeters: 8,
});

export const SETTLEMENT_LOT_V2_PLACEMENT_SOURCES = Object.freeze({
  LOT: 'LOT',
  FRONTAGE_FALLBACK: 'FRONTAGE_FALLBACK',
  LEGACY_SCATTER: 'LEGACY_SCATTER',
});

const APPROXIMATE_BUILDING_RADIUS = Object.freeze({
  house: 90,
  tower: 65,
  church: 115,
  school: 145,
});
const BUILDING_HEIGHT_UNITS = Object.freeze({
  house: 180,
  tower: 420,
  school: 190,
  church: 335,
});
const LEGACY_KIND_BY_CLASS = Object.freeze({
  [ROAD_GRAPH_CLASSES.ARTERIAL]: ROAD_KINDS.MAJOR,
  [ROAD_GRAPH_CLASSES.COLLECTOR]: ROAD_KINDS.LOCAL,
  [ROAD_GRAPH_CLASSES.LOCAL]: ROAD_KINDS.LOCAL,
  [ROAD_GRAPH_CLASSES.ALLEY]: ROAD_KINDS.ALLEY,
});

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const meters = value => q6(value / FINITE_WORLD_UNITS_PER_METER);

async function stableId(prefix, input) {
  return `${prefix}:${(await sha256Hex(canonicalizeJson(input))).slice(0, 24)}`;
}

function localPoint(value, center) {
  return Object.freeze({
    x: (value.x - center.x) * FINITE_WORLD_UNITS_PER_METER,
    z: (value.z - center.z) * FINITE_WORLD_UNITS_PER_METER,
  });
}

function rectangleCorners(rectangle) {
  const rightX = Math.cos(rectangle.rotationY);
  const rightZ = -Math.sin(rectangle.rotationY);
  const frontX = Math.sin(rectangle.rotationY);
  const frontZ = Math.cos(rectangle.rotationY);
  return [
    [-1, -1], [-1, 1], [1, 1], [1, -1],
  ].map(([rightSign, frontSign]) => Object.freeze({
    x: rectangle.centerX + rightX * rectangle.width / 2 * rightSign
      + frontX * rectangle.depth / 2 * frontSign,
    z: rectangle.centerZ + rightZ * rectangle.width / 2 * rightSign
      + frontZ * rectangle.depth / 2 * frontSign,
  }));
}

function globalRectanglePolygon(rectangle, center) {
  return rectangleCorners(rectangle).map(value => Object.freeze({
    x: q6(value.x / FINITE_WORLD_UNITS_PER_METER + center.x),
    z: q6(value.z / FINITE_WORLD_UNITS_PER_METER + center.z),
  }));
}

function localRoad(segment, candidate) {
  return Object.freeze({
    roadId: segment.edgeId,
    routeId: segment.flags.routeId,
    routeOrder: segment.flags.routeOrder,
    kind: LEGACY_KIND_BY_CLASS[segment.class],
    width: segment.widthMeters * FINITE_WORLD_UNITS_PER_METER,
    start: localPoint(segment.start, candidate.center),
    end: localPoint(segment.end, candidate.center),
    tangentX: segment.tangent.x,
    tangentZ: segment.tangent.z,
    normalX: segment.normal.x,
    normalZ: segment.normal.z,
    townId: candidate.settlementId,
  });
}

function roadRectangle(road) {
  return Object.freeze({
    centerX: (road.start.x + road.end.x) / 2,
    centerZ: (road.start.z + road.end.z) / 2,
    rotationY: Math.atan2(road.tangentX, road.tangentZ),
    width: road.width,
    depth: Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z),
  });
}

function buildingRectangle(building) {
  return Object.freeze({
    centerX: building.lot.centerX * FINITE_WORLD_UNITS_PER_METER,
    centerZ: building.lot.centerZ * FINITE_WORLD_UNITS_PER_METER,
    rotationY: building.rotationY,
    width: building.lot.widthMeters * FINITE_WORLD_UNITS_PER_METER,
    depth: building.lot.depthMeters * FINITE_WORLD_UNITS_PER_METER,
  });
}

function convertRectangle(rectangle, parentBuildingId) {
  return Object.freeze({
    centerX: meters(rectangle.centerX),
    centerZ: meters(rectangle.centerZ),
    rotationY: q6(rectangle.rotationY),
    width: meters(rectangle.width),
    depth: meters(rectangle.depth),
    parentBuildingId,
  });
}

function convertFallbackLot(lot, fallbackAnchorId, buildingStableId) {
  const lotId = `frontage-fallback:${fallbackAnchorId}`;
  return Object.freeze({
    lotId,
    parentBuildingId: buildingStableId,
    lotStatus: lot.lotStatus,
    widthMeters: meters(lot.width),
    depthMeters: meters(lot.depth),
    centerX: meters(lot.centerX),
    centerZ: meters(lot.centerZ),
    entranceX: meters(lot.entranceX),
    entranceZ: meters(lot.entranceZ),
    roadAccessX: meters(lot.roadAccessX),
    roadAccessZ: meters(lot.roadAccessZ),
    path: Object.freeze({
      ...convertRectangle(lot.pathRectangle, buildingStableId),
      parentLotId: lotId,
    }),
    forecourt: Object.freeze({
      ...convertRectangle(lot.forecourtRectangle, buildingStableId),
      parentLotId: lotId,
    }),
  });
}

function junctionPositions(roadGraph) {
  const degreeByNodeId = new Map();
  for (const edge of roadGraph.edges) {
    degreeByNodeId.set(edge.startNodeId, (degreeByNodeId.get(edge.startNodeId) ?? 0) + 1);
    degreeByNodeId.set(edge.endNodeId, (degreeByNodeId.get(edge.endNodeId) ?? 0) + 1);
  }
  return roadGraph.nodes
    .filter(node => node.role?.includes('junction') || (degreeByNodeId.get(node.nodeId) ?? 0) >= 3)
    .map(node => node.position);
}

function createFallbackSlots({ roadGraph, candidate }) {
  const routes = new Map();
  for (const segment of roadGraph.segments) {
    if (segment.flags?.frontageEligible !== true) continue;
    if (!routes.has(segment.flags.routeId)) routes.set(segment.flags.routeId, []);
    routes.get(segment.flags.routeId).push(segment);
  }
  const junctions = junctionPositions(roadGraph);
  const spacing = SETTLEMENT_LOT_V2_FALLBACK_PARAMETERS.slotSpacingMeters;
  const slots = [];
  for (const [routeId, unorderedSegments] of [...routes].sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    const segments = unorderedSegments.sort((left, right) => (
      left.flags.routeOrder - right.flags.routeOrder
      || left.edgeId.localeCompare(right.edgeId)
    ));
    const prepared = [];
    let routeLength = 0;
    for (const segment of segments) {
      const length = Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z);
      if (length <= 1e-9) continue;
      prepared.push(Object.freeze({ segment, startDistance: routeLength, length }));
      routeLength += length;
    }
    const slotCount = Math.floor(routeLength / spacing);
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      const routeDistance = (slotIndex + 0.5) * spacing;
      const located = prepared.find(value => (
        routeDistance <= value.startDistance + value.length + 1e-9
      ));
      if (!located) continue;
      const roadT = Math.max(0, Math.min(
        1,
        (routeDistance - located.startDistance) / located.length,
      ));
      const position = {
        x: located.segment.start.x
          + (located.segment.end.x - located.segment.start.x) * roadT,
        z: located.segment.start.z
          + (located.segment.end.z - located.segment.start.z) * roadT,
      };
      if (junctions.some(junction => Math.hypot(
        position.x - junction.x,
        position.z - junction.z,
      ) < SETTLEMENT_LOT_V2_FALLBACK_PARAMETERS.junctionClearanceMeters)) continue;
      const road = localRoad(located.segment, candidate);
      const closest = localPoint(position, candidate.center);
      const roadAtSlot = Object.freeze({
        ...road,
        closestX: closest.x,
        closestZ: closest.z,
        roadT,
        roadLength: located.length * FINITE_WORLD_UNITS_PER_METER,
      });
      for (const side of [-1, 1]) {
        slots.push(Object.freeze({
          fallbackAnchorId: `${located.segment.edgeId}:route-slot:${slotIndex}:side:${side}`,
          frontageEdgeId: located.segment.edgeId,
          frontageRouteId: routeId,
          routeDistanceMeters: q6(routeDistance),
          side,
          road: roadAtSlot,
          sourceOwner: located.segment.sourceOwner,
        }));
      }
    }
  }
  return Object.freeze(slots);
}

function lotVisualRecord(building, town) {
  return Object.freeze({
    townId: town.id,
    townType: town.type,
    settlementType: town.settlementType,
    type: building.buildingType,
    buildingIndex: building.buildingIndex,
    routeId: building.frontageRouteId,
    x: building.x * FINITE_WORLD_UNITS_PER_METER,
    z: building.z * FINITE_WORLD_UNITS_PER_METER,
    heightVariant: building.visual.heightVariant,
    wallPaletteIndex: building.visual.wallPaletteIndex,
    roofPaletteIndex: building.visual.roofPaletteIndex,
  });
}

export function decorateLotV2Buildings(buildings) {
  return Object.freeze(buildings.map(building => Object.freeze({
    ...building,
    placementSource: SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.LOT,
    frontageEdgeId: building.frontageRoadId,
    fallbackAnchorId: null,
  })));
}

export async function buildDeterministicFrontageFallbackBuildingsV2({
  town,
  settlementId,
  roadGraph,
  candidate,
  blocks,
  lots,
  lotBuildings,
} = {}) {
  const requestedBuildingCount = Math.round((town.coreRadius * town.coreRadius) / 36_000);
  const attemptedBuildingCount = town.settlementType === SETTLEMENT_TYPES.CITY
    ? Math.min(requestedBuildingCount, 64)
    : requestedBuildingCount;
  const usedBuildingIndexes = new Set(lotBuildings.map(building => building.buildingIndex));
  const closedBlockPolygons = blocks
    .filter(block => block.isClosed === true)
    .map(block => deriveSettlementBlockPolygon({ roadGraph, block }));
  const lotPolygons = lots.map(lot => lot.footprint);
  const roads = roadGraph.segments.map(segment => localRoad(segment, candidate));
  const roadRectangles = roads.map(roadRectangle);
  const occupiedRectangles = lotBuildings.map(buildingRectangle);
  const placedSpots = lotBuildings.map(building => Object.freeze({
    x: building.x * FINITE_WORLD_UNITS_PER_METER,
    z: building.z * FINITE_WORLD_UNITS_PER_METER,
    rotationY: building.rotationY,
    radius: APPROXIMATE_BUILDING_RADIUS[building.buildingType],
    type: building.buildingType,
    frontageRoadId: building.frontageRoadId,
    frontageRouteId: building.frontageRouteId,
    frontageAlong: null,
  }));
  const visualRecords = lotBuildings
    .slice()
    .sort((left, right) => left.buildingIndex - right.buildingIndex)
    .map(building => lotVisualRecord(building, town));
  const slots = createFallbackSlots({ roadGraph, candidate });
  const selectBuildingType = createW8SettlementBuildingTypeSelector({
    settlementType: town.settlementType,
    townId: town.id,
  });
  const placed = [];
  for (let buildingIndex = 1; buildingIndex <= attemptedBuildingCount; buildingIndex += 1) {
    if (usedBuildingIndexes.has(buildingIndex)) continue;
    let type = selectBuildingType(buildingIndex);
    let accepted = null;
    for (const slot of slots) {
      let candidateType = type;
      let placement = createFrontagePlacement({
        type: candidateType,
        road: slot.road,
        buildingIndex,
        townId: town.id,
        sideOverride: slot.side,
        identityRoadId: slot.frontageEdgeId,
        frontageAlong: slot.routeDistanceMeters * FINITE_WORLD_UNITS_PER_METER,
      });
      if (candidateType === 'tower' && !isTowerPlacementAllowed({
        settlementType: town.settlementType,
        routeId: slot.frontageRouteId,
        x: placement.x,
        z: placement.z,
        records: visualRecords,
      })) {
        candidateType = 'house';
        placement = createFrontagePlacement({
          type: candidateType,
          road: slot.road,
          buildingIndex,
          townId: town.id,
          sideOverride: slot.side,
          identityRoadId: slot.frontageEdgeId,
          frontageAlong: slot.routeDistanceMeters * FINITE_WORLD_UNITS_PER_METER,
        });
      }
      const spot = Object.freeze({
        ...placement,
        frontageRouteId: slot.frontageRouteId,
        radius: APPROXIMATE_BUILDING_RADIUS[candidateType],
        type: candidateType,
      });
      if (Math.hypot(spot.x - town.x, spot.z - town.z)
        > town.radius - APPROXIMATE_BUILDING_RADIUS[candidateType]) continue;
      if (placedSpots.some(existing => frontageSpotsConflict(spot, existing))) continue;
      let buildingLot;
      try {
        buildingLot = createBuildingLot({
          buildingType: candidateType,
          buildingIndex,
          buildingX: spot.x,
          buildingZ: spot.z,
          rotationY: spot.rotationY,
          frontage: spot,
          road: slot.road,
        });
      } catch {
        continue;
      }
      if (occupiedRectangles.some(existing => orientedRectanglesOverlap(buildingLot, existing))) {
        continue;
      }
      const footprint = globalRectanglePolygon(buildingLot, candidate.center);
      if (closedBlockPolygons.some(polygon => settlementPolygonsOverlap(footprint, polygon))) {
        continue;
      }
      if (lotPolygons.some(polygon => convexPolygonsOverlap(footprint, polygon))) continue;
      if (roadRectangles.some(rectangle => orientedRectanglesOverlap(buildingLot, rectangle))) {
        continue;
      }
      accepted = Object.freeze({
        slot,
        type: candidateType,
        spot,
        buildingLot,
        footprint,
      });
      break;
    }
    if (!accepted) continue;
    const visual = createSettlementBuildingVisual({
      settlementType: town.settlementType,
      townId: town.id,
      townType: town.type,
      type: accepted.type,
      buildingIndex,
      routeId: accepted.slot.frontageRouteId,
      records: visualRecords,
    });
    visualRecords.push(Object.freeze({
      townId: town.id,
      townType: town.type,
      settlementType: town.settlementType,
      type: accepted.type,
      buildingIndex,
      routeId: accepted.slot.frontageRouteId,
      x: accepted.spot.x,
      z: accepted.spot.z,
      heightVariant: visual.heightVariant,
      wallPaletteIndex: visual.wallPaletteIndex,
      roofPaletteIndex: visual.roofPaletteIndex,
    }));
    const record = Object.freeze({ ...accepted, buildingIndex, visual });
    placed.push(record);
    placedSpots.push(Object.freeze({ ...accepted.spot }));
    occupiedRectangles.push(accepted.buildingLot);
  }
  const buildings = await Promise.all(placed.map(async building => {
    const buildingStableId = await stableId('settlement-building-v1', {
      settlementId,
      buildingIndex: building.buildingIndex,
      type: building.type,
      frontageRoadId: building.slot.frontageEdgeId,
    });
    return Object.freeze({
      stableId: buildingStableId,
      featureType: 'settlement-building',
      settlementId,
      buildingIndex: building.buildingIndex,
      buildingType: building.type,
      x: meters(building.spot.x),
      z: meters(building.spot.z),
      rotationY: q6(building.spot.rotationY),
      radiusMeters: meters(building.spot.radius),
      widthMeters: meters(building.buildingLot.footprintWidth),
      depthMeters: meters(building.buildingLot.footprintDepth),
      heightMeters: meters(BUILDING_HEIGHT_UNITS[building.type] * building.visual.heightScale),
      frontageRoadId: building.slot.frontageEdgeId,
      frontageRouteId: building.slot.frontageRouteId,
      frontageEdgeId: building.slot.frontageEdgeId,
      frontageAlongMeters: building.slot.routeDistanceMeters,
      frontageSide: building.slot.side,
      fallbackAnchorId: building.slot.fallbackAnchorId,
      placementSource: SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.FRONTAGE_FALLBACK,
      owner: building.slot.sourceOwner,
      visual: building.visual,
      lot: convertFallbackLot(
        building.buildingLot,
        building.slot.fallbackAnchorId,
        buildingStableId,
      ),
    });
  }));
  buildings.sort((left, right) => left.stableId.localeCompare(right.stableId));
  const duplicateBuildingIdCount = buildings.length - new Set(
    buildings.map(building => building.stableId),
  ).size;
  const orphanFrontageCount = buildings.filter(building => !roadGraph.edges.some(
    edge => edge.edgeId === building.frontageEdgeId,
  )).length;
  return Object.freeze({
    requestedBuildingCount,
    buildings: Object.freeze(buildings),
    validation: Object.freeze({
      valid: duplicateBuildingIdCount === 0 && orphanFrontageCount === 0,
      duplicateBuildingIdCount,
      orphanFrontageCount,
      blockCoverageOverlapCount: 0,
      lotOverlapCount: 0,
      buildingOverlapCount: 0,
      roadOverlapCount: 0,
      junctionClearanceFailureCount: 0,
    }),
  });
}
