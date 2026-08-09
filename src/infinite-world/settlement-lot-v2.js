import {
  BUILDING_FRONTAGE_PROFILES,
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
import { createSemanticIdKeyedRandom } from './settlement-semantic-identity.js';
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

export const RURAL_FRONTAGE_FALLBACK_PLACEMENT_MODE = 'RURAL_FRONTAGE_FALLBACK_V1';
export const RURAL_FRONTAGE_JUNCTION_CLEARANCE_METERS = 5;

// This is deliberately one placement grammar.  The class only changes its local
// density envelope; every candidate still uses the same frontage/lot adapter.
export const RURAL_FRONTAGE_EDGE_PLACEMENT_TABLE = Object.freeze({
  collector: Object.freeze({
    priority: 0,
    intervalMeters: 5.5,
    intervalJitter: 0.25,
    firstIntervalFraction: 0.62,
    setbackMeters: 0.7,
    setbackVariationMeters: 0.28,
    minimumLengthMeters: 8,
    junctionInfluenceMeters: 24,
    junctionIntervalMultiplier: 0.78,
    maximumCandidateAnchors: 24,
  }),
  local: Object.freeze({
    priority: 1,
    intervalMeters: 9,
    intervalJitter: 0.65,
    firstIntervalFraction: 0.55,
    setbackMeters: 0.82,
    setbackVariationMeters: 0.32,
    minimumLengthMeters: 8,
    junctionInfluenceMeters: 22,
    junctionIntervalMultiplier: 0.86,
    maximumCandidateAnchors: 6,
  }),
  'alley/dead-end': Object.freeze({
    priority: 2,
    intervalMeters: 20,
    intervalJitter: 0.24,
    firstIntervalFraction: 0.45,
    setbackMeters: 0.92,
    setbackVariationMeters: 0.34,
    minimumLengthMeters: 11,
    junctionInfluenceMeters: 20,
    junctionIntervalMultiplier: 0.9,
    maximumCandidateAnchors: 3,
  }),
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

function nodeDegrees(roadGraph) {
  const degrees = new Map();
  for (const edge of roadGraph.edges) {
    degrees.set(edge.startNodeId, (degrees.get(edge.startNodeId) ?? 0) + 1);
    degrees.set(edge.endNodeId, (degrees.get(edge.endNodeId) ?? 0) + 1);
  }
  return degrees;
}

function ruralFrontageEdgeClass(segment, degrees) {
  if (segment.class === ROAD_GRAPH_CLASSES.COLLECTOR) return 'collector';
  const deadEnd = (degrees.get(segment.startNodeId) ?? 0) <= 1
    || (degrees.get(segment.endNodeId) ?? 0) <= 1;
  if (segment.class === ROAD_GRAPH_CLASSES.ALLEY
    || (deadEnd && segment.class !== ROAD_GRAPH_CLASSES.LOCAL)) return 'alley/dead-end';
  return 'local';
}

function nearestJunctionDistance(position, junctions) {
  if (junctions.length === 0) return Infinity;
  return Math.min(...junctions.map(junction => Math.hypot(
    position.x - junction.x,
    position.z - junction.z,
  )));
}

function placementAtSetback(placement, type, setbackMeters) {
  const profile = BUILDING_FRONTAGE_PROFILES[type];
  const setback = setbackMeters * FINITE_WORLD_UNITS_PER_METER;
  const centerDistance = placement.frontageRoadKind === ROAD_KINDS.START_APPROACH
    ? 0
    : placement.centerDistance - placement.setback + setback;
  return Object.freeze({
    ...placement,
    x: placement.frontageX - placement.frontageNormalX * centerDistance,
    z: placement.frontageZ - placement.frontageNormalZ * centerDistance,
    setback,
    centerDistance,
    frontExtent: profile.frontExtent,
  });
}

async function createRuralFrontageFallbackSlots({ worldSeedHash, settlementId, roadGraph, candidate }) {
  const [intervalRandom, setbackRandom, sideRandom] = await Promise.all([
    createSemanticIdKeyedRandom({
      worldSeedHash,
      semanticStableId: `${settlementId}:rural-frontage-interval-v1`,
    }),
    createSemanticIdKeyedRandom({
      worldSeedHash,
      semanticStableId: `${settlementId}:rural-frontage-setback-v1`,
    }),
    createSemanticIdKeyedRandom({
      worldSeedHash,
      semanticStableId: `${settlementId}:rural-frontage-side-v1`,
    }),
  ]);
  const degrees = nodeDegrees(roadGraph);
  const junctions = junctionPositions(roadGraph);
  const routeStartMetersByEdgeId = new Map();
  const routes = new Map();
  for (const segment of roadGraph.segments) {
    if (segment.flags?.frontageEligible !== true) continue;
    const routeId = segment.flags.routeId;
    const route = routes.get(routeId) ?? [];
    route.push(segment);
    routes.set(routeId, route);
  }
  for (const route of routes.values()) {
    let routeStartMeters = 0;
    for (const segment of route.sort((left, right) => (
      left.flags.routeOrder - right.flags.routeOrder || left.edgeId.localeCompare(right.edgeId)
    ))) {
      routeStartMetersByEdgeId.set(segment.edgeId, routeStartMeters);
      routeStartMeters += Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z);
    }
  }
  const eligible = roadGraph.segments
    .filter(segment => segment.flags?.frontageEligible === true)
    .map(segment => Object.freeze({
      segment,
      edgeClass: ruralFrontageEdgeClass(segment, degrees),
    }))
    .sort((left, right) => (
      RURAL_FRONTAGE_EDGE_PLACEMENT_TABLE[left.edgeClass].priority
        - RURAL_FRONTAGE_EDGE_PLACEMENT_TABLE[right.edgeClass].priority
      || left.segment.edgeId.localeCompare(right.segment.edgeId)
    ));
  const slots = [];
  const candidateAnchorCountByClass = new Map();
  for (const { segment, edgeClass } of eligible) {
    const table = RURAL_FRONTAGE_EDGE_PLACEMENT_TABLE[edgeClass];
    const length = Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z);
    if (length < table.minimumLengthMeters) continue;
    let anchorIndex = 0;
    let frontageInterval = 0;
    while (frontageInterval < length) {
      const intervalKey = `${segment.edgeId}:anchor:${anchorIndex}`;
      const intervalUnit = await intervalRandom.float01(intervalKey);
      const baseInterval = table.intervalMeters * (
        1 + (intervalUnit * 2 - 1) * table.intervalJitter
      );
      const startOffset = anchorIndex === 0 ? baseInterval * table.firstIntervalFraction : 0;
      frontageInterval += anchorIndex === 0 ? startOffset : baseInterval;
      if (frontageInterval >= length) break;
      const roadT = frontageInterval / length;
      const position = Object.freeze({
        x: segment.start.x + (segment.end.x - segment.start.x) * roadT,
        z: segment.start.z + (segment.end.z - segment.start.z) * roadT,
      });
      const junctionDistance = nearestJunctionDistance(position, junctions);
      const nextMultiplier = junctionDistance < table.junctionInfluenceMeters
        ? table.junctionIntervalMultiplier : 1;
      // Keep rejected near-junction slots out, but let the following interval
      // become denser in that neighbourhood through the table above.
      if (junctionDistance >= RURAL_FRONTAGE_JUNCTION_CLEARANCE_METERS) {
        const quantizedInterval = q6(frontageInterval);
        const placementKey = `${segment.edgeId}:interval:${quantizedInterval}`;
        const [setbackUnit, sideUnit] = await Promise.all([
          setbackRandom.float01(placementKey),
          sideRandom.float01(placementKey),
        ]);
        const setbackMeters = q6(table.setbackMeters
          + (setbackUnit * 2 - 1) * table.setbackVariationMeters);
        const candidateAnchorCount = candidateAnchorCountByClass.get(edgeClass) ?? 0;
        if (candidateAnchorCount < table.maximumCandidateAnchors) {
          slots.push(Object.freeze({
            id: `rural-frontage:${segment.edgeId}:${quantizedInterval}`,
            frontageEdgeId: segment.edgeId,
            frontageRouteId: segment.flags.routeId,
            frontageInterval: quantizedInterval,
            frontageAlongMeters: q6(
              (routeStartMetersByEdgeId.get(segment.edgeId) ?? 0) + quantizedInterval,
            ),
            edgeClass,
            side: sideUnit < 0.5 ? -1 : 1,
            setbackMeters,
            junctionDistanceMeters: q6(junctionDistance),
            sourceOwner: segment.sourceOwner,
            road: Object.freeze({
              ...localRoad(segment, candidate),
              closestX: (position.x - candidate.center.x) * FINITE_WORLD_UNITS_PER_METER,
              closestZ: (position.z - candidate.center.z) * FINITE_WORLD_UNITS_PER_METER,
              roadT,
              roadLength: length * FINITE_WORLD_UNITS_PER_METER,
            }),
          }));
          candidateAnchorCountByClass.set(edgeClass, candidateAnchorCount + 1);
        }
      }
      frontageInterval += baseInterval * (nextMultiplier - 1);
      anchorIndex += 1;
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

export async function buildDeterministicRuralFrontageFallbackBuildingsV2({
  worldSeedHash,
  town,
  settlementId,
  roadGraph,
  candidate,
  blocks = Object.freeze([]),
  lots = Object.freeze([]),
  lotBuildings = Object.freeze([]),
} = {}) {
  if (town?.settlementType !== SETTLEMENT_TYPES.RURAL) {
    throw new RangeError('RURAL frontage fallback requires a RURAL Settlement');
  }
  if (!worldSeedHash || !settlementId || !roadGraph || !candidate) {
    throw new TypeError('RURAL frontage fallback requires world, Settlement, Road Graph, and candidate');
  }
  const requestedBuildingCount = Math.round((town.coreRadius * town.coreRadius) / 36_000);
  const slots = await createRuralFrontageFallbackSlots({
    worldSeedHash,
    settlementId,
    roadGraph,
    candidate,
  });
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
    frontageAlong: building.frontageAlongMeters
      ? building.frontageAlongMeters * FINITE_WORLD_UNITS_PER_METER : null,
  }));
  const visualRecords = lotBuildings
    .slice()
    .sort((left, right) => left.buildingIndex - right.buildingIndex)
    .map(building => lotVisualRecord(building, town));
  const selectBuildingType = createW8SettlementBuildingTypeSelector({
    settlementType: town.settlementType,
    townId: town.id,
  });
  const createCandidateIdentity = async (slot, slotIndex, sidePreferenceRank) => {
    const identity = Object.freeze({
      settlementId,
      frontageEdgeId: slot.frontageEdgeId,
      frontageInterval: slot.frontageInterval,
      side: slot.side,
      placementMode: RURAL_FRONTAGE_FALLBACK_PLACEMENT_MODE,
    });
    const [placementId, buildingStableId] = await Promise.all([
      stableId('rural-frontage-placement-v1', identity),
      stableId('settlement-building-v1', identity),
    ]);
    return Object.freeze({
      slot,
      slotIndex,
      buildingIndex: slotIndex + 1,
      sidePreferenceRank,
      identity,
      placementId,
      buildingStableId,
    });
  };
  const candidateIdentities = await Promise.all(slots.map(async (slot, slotIndex) => (
    Promise.all([
      createCandidateIdentity(slot, slotIndex, 0),
      createCandidateIdentity(Object.freeze({ ...slot, side: -slot.side }), slotIndex, 1),
    ])
  )));
  const preferredSideCandidates = [];
  const rawCandidates = [];
  for (const descriptorVariants of candidateIdentities) {
    const preferredDescriptor = descriptorVariants[0];
    const { slot, buildingIndex } = preferredDescriptor;
    let type = selectBuildingType(buildingIndex);
    const preferredPlacement = placementAtSetback(createFrontagePlacement({
      type,
      road: slot.road,
      buildingIndex,
      townId: town.id,
      sideOverride: slot.side,
      identityRoadId: slot.frontageEdgeId,
      frontageAlong: slot.frontageAlongMeters * FINITE_WORLD_UNITS_PER_METER,
    }), type, slot.setbackMeters);
    if (type === 'tower' && !isTowerPlacementAllowed({
      settlementType: town.settlementType,
      routeId: slot.frontageRouteId,
      x: preferredPlacement.x,
      z: preferredPlacement.z,
      records: visualRecords,
    })) {
      type = 'house';
    }
    const materializeCandidate = descriptor => {
      const candidateSlot = descriptor.slot;
      const placement = placementAtSetback(createFrontagePlacement({
        type,
        road: candidateSlot.road,
        buildingIndex,
        townId: town.id,
        sideOverride: candidateSlot.side,
        identityRoadId: candidateSlot.frontageEdgeId,
        frontageAlong: candidateSlot.frontageAlongMeters * FINITE_WORLD_UNITS_PER_METER,
      }), type, candidateSlot.setbackMeters);
      const spot = Object.freeze({
        ...placement,
        frontageRouteId: candidateSlot.frontageRouteId,
        radius: APPROXIMATE_BUILDING_RADIUS[type],
        type,
      });
      let buildingLot = null;
      let lotCreationFailed = false;
      try {
        buildingLot = createBuildingLot({
          buildingType: type,
          buildingIndex,
          buildingX: spot.x,
          buildingZ: spot.z,
          rotationY: spot.rotationY,
          frontage: spot,
          road: candidateSlot.road,
        });
      } catch {
        lotCreationFailed = true;
      }
      const footprint = buildingLot ? globalRectanglePolygon(buildingLot, candidate.center) : null;
      const immutableRejectReasons = [];
      if (Math.hypot(spot.x - town.x, spot.z - town.z)
        > town.radius - APPROXIMATE_BUILDING_RADIUS[type]) {
        immutableRejectReasons.push('OUTSIDE_SETTLEMENT');
      }
      if (placedSpots.some(existing => frontageSpotsConflict(spot, existing))) {
        immutableRejectReasons.push('EXISTING_FRONTAGE_CONFLICT');
      }
      if (lotCreationFailed) immutableRejectReasons.push('INVALID_BUILDING_LOT');
      if (buildingLot && occupiedRectangles.some(existing => (
        orientedRectanglesOverlap(buildingLot, existing)
      ))) immutableRejectReasons.push('EXISTING_BUILDING_OVERLAP');
      if (footprint && closedBlockPolygons.some(polygon => (
        settlementPolygonsOverlap(footprint, polygon)
      ))) immutableRejectReasons.push('CLOSED_BLOCK_OVERLAP');
      if (footprint && lotPolygons.some(polygon => (
        convexPolygonsOverlap(footprint, polygon)
      ))) immutableRejectReasons.push('LOT_OVERLAP');
      if (buildingLot && roadRectangles.some(rectangle => (
        orientedRectanglesOverlap(buildingLot, rectangle)
      ))) immutableRejectReasons.push('ROAD_OVERLAP');
      return {
        ...descriptor,
        type,
        spot,
        buildingLot,
        footprint,
        immutableRejectReasons: Object.freeze(immutableRejectReasons),
      };
    };
    // The semantic side remains authoritative when it is viable.  The opposite side is a
    // bounded feasibility alternative for the same frontage anchor, not another density slot.
    const materializedVariants = descriptorVariants.map(materializeCandidate);
    preferredSideCandidates.push(materializedVariants.find(value => (
      value.sidePreferenceRank === 0
    )));
    materializedVariants.sort((left, right) => (
      left.immutableRejectReasons.length - right.immutableRejectReasons.length
      || left.sidePreferenceRank - right.sidePreferenceRank
    ));
    const selectedVariant = materializedVariants[0];
    rawCandidates.push({
      ...selectedVariant,
      conflictStableIds: new Set(),
      distributionRank: 0,
    });
  }
  const immutableRejectReasonCounts = Object.fromEntries([
    'OUTSIDE_SETTLEMENT',
    'EXISTING_FRONTAGE_CONFLICT',
    'INVALID_BUILDING_LOT',
    'EXISTING_BUILDING_OVERLAP',
    'CLOSED_BLOCK_OVERLAP',
    'LOT_OVERLAP',
    'ROAD_OVERLAP',
  ].map(reason => [reason, rawCandidates.filter(value => (
    value.immutableRejectReasons.includes(reason)
  )).length]));
  const viableCandidates = rawCandidates.filter(value => (
    value.immutableRejectReasons.length === 0
  ));
  const candidatesByEdge = new Map();
  for (const value of viableCandidates) {
    const edgeCandidates = candidatesByEdge.get(value.slot.frontageEdgeId) ?? [];
    edgeCandidates.push(value);
    candidatesByEdge.set(value.slot.frontageEdgeId, edgeCandidates);
  }
  for (const edgeCandidates of candidatesByEdge.values()) {
    const pendingRanges = [[0, edgeCandidates.length - 1]];
    let distributionRank = 0;
    edgeCandidates.sort((left, right) => (
      left.slot.frontageInterval - right.slot.frontageInterval
      || left.buildingStableId.localeCompare(right.buildingStableId)
    ));
    while (pendingRanges.length > 0) {
      const [first, last] = pendingRanges.shift();
      if (first > last) continue;
      const middle = Math.floor((first + last) / 2);
      edgeCandidates[middle].distributionRank = distributionRank;
      distributionRank += 1;
      pendingRanges.push([first, middle - 1], [middle + 1, last]);
    }
  }
  const candidateConflictReasonPairCounts = { FRONTAGE: 0, BUILDING: 0 };
  let candidateConflictPairCount = 0;
  for (let first = 0; first < viableCandidates.length; first += 1) {
    for (let second = first + 1; second < viableCandidates.length; second += 1) {
      const left = viableCandidates[first];
      const right = viableCandidates[second];
      const frontageConflict = frontageSpotsConflict(left.spot, right.spot);
      const buildingConflict = orientedRectanglesOverlap(left.buildingLot, right.buildingLot);
      if (!frontageConflict && !buildingConflict) continue;
      candidateConflictPairCount += 1;
      left.conflictStableIds.add(right.buildingStableId);
      right.conflictStableIds.add(left.buildingStableId);
      if (frontageConflict) {
        candidateConflictReasonPairCounts.FRONTAGE += 1;
      }
      if (buildingConflict) {
        candidateConflictReasonPairCounts.BUILDING += 1;
      }
    }
  }
  const priorityTuple = value => {
    const table = RURAL_FRONTAGE_EDGE_PLACEMENT_TABLE[value.slot.edgeClass];
    const moderateJunctionMinimum = RURAL_FRONTAGE_JUNCTION_CLEARANCE_METERS + 3;
    const moderateJunctionMaximum = table.junctionInfluenceMeters;
    const junctionDistance = value.slot.junctionDistanceMeters;
    const junctionBandDistance = junctionDistance < moderateJunctionMinimum
      ? moderateJunctionMinimum - junctionDistance
      : junctionDistance > moderateJunctionMaximum
        ? junctionDistance - moderateJunctionMaximum : 0;
    return Object.freeze([
      table.priority,
      value.conflictStableIds.size,
      value.distributionRank,
      q6(junctionBandDistance),
      value.buildingStableId,
    ]);
  };
  const comparePriority = (left, right) => {
    const leftPriority = left.priority;
    const rightPriority = right.priority;
    for (let index = 0; index < leftPriority.length - 1; index += 1) {
      if (leftPriority[index] !== rightPriority[index]) {
        return leftPriority[index] - rightPriority[index];
      }
    }
    return leftPriority.at(-1).localeCompare(rightPriority.at(-1));
  };
  for (const value of viableCandidates) value.priority = priorityTuple(value);
  const selectGreedy = ordered => {
    const selected = [];
    const selectedIds = new Set();
    for (const value of ordered) {
      if (selected.length >= requestedBuildingCount) break;
      if ([...value.conflictStableIds].some(stableIdValue => selectedIds.has(stableIdValue))) {
        continue;
      }
      selected.push(value);
      selectedIds.add(value.buildingStableId);
    }
    return selected;
  };
  const legacySequentialSelection = [];
  const legacyPlacedSpots = [...placedSpots];
  const legacyOccupiedRectangles = [...occupiedRectangles];
  for (const value of preferredSideCandidates.sort((left, right) => (
    left.slotIndex - right.slotIndex
  ))) {
    if (legacySequentialSelection.length >= requestedBuildingCount) break;
    if (value.immutableRejectReasons.length > 0) continue;
    if (legacyPlacedSpots.some(existing => frontageSpotsConflict(value.spot, existing))) continue;
    if (legacyOccupiedRectangles.some(existing => (
      orientedRectanglesOverlap(value.buildingLot, existing)
    ))) continue;
    legacySequentialSelection.push(value);
    legacyPlacedSpots.push(value.spot);
    legacyOccupiedRectangles.push(value.buildingLot);
  }
  const selectedCandidates = selectGreedy([...viableCandidates].sort(comparePriority));
  const selectedClassCounts = Object.fromEntries(
    Object.keys(RURAL_FRONTAGE_EDGE_PLACEMENT_TABLE).map(edgeClass => [
      edgeClass,
      selectedCandidates.filter(value => value.slot.edgeClass === edgeClass).length,
    ]),
  );
  const placed = [];
  for (const value of selectedCandidates) {
    const { slot, type, spot, buildingLot, buildingIndex } = value;
    const visual = createSettlementBuildingVisual({
      settlementType: town.settlementType,
      townId: town.id,
      townType: town.type,
      type,
      buildingIndex,
      routeId: slot.frontageRouteId,
      records: visualRecords,
    });
    visualRecords.push(Object.freeze({
      townId: town.id,
      townType: town.type,
      settlementType: town.settlementType,
      type,
      buildingIndex,
      routeId: slot.frontageRouteId,
      x: spot.x,
      z: spot.z,
      heightVariant: visual.heightVariant,
      wallPaletteIndex: visual.wallPaletteIndex,
      roofPaletteIndex: visual.roofPaletteIndex,
    }));
    placed.push(Object.freeze({ ...value, visual }));
  }
  const buildings = placed.map(building => Object.freeze({
    stableId: building.buildingStableId,
    id: building.placementId,
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
    frontageInterval: building.slot.frontageInterval,
    frontageAlongMeters: building.slot.frontageAlongMeters,
    side: building.slot.side,
    frontageSide: building.slot.side,
    setback: building.slot.setbackMeters,
    setbackMeters: building.slot.setbackMeters,
    sourceRoadGraphVersion: roadGraph.generatorId,
    placementMode: RURAL_FRONTAGE_FALLBACK_PLACEMENT_MODE,
    placementSource: SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.FRONTAGE_FALLBACK,
    placementSourceOwner: Object.freeze({
      kind: 'RURAL_FRONTAGE_EDGE',
      frontageEdgeId: building.slot.frontageEdgeId,
      sourceOwner: building.slot.sourceOwner,
    }),
    owner: building.slot.sourceOwner,
    frontageEdgeClass: building.slot.edgeClass,
    junctionDistanceMeters: building.slot.junctionDistanceMeters,
    visual: building.visual,
    lot: convertFallbackLot(
      building.buildingLot,
      building.placementId,
      building.buildingStableId,
    ),
  }));
  buildings.sort((left, right) => left.stableId.localeCompare(right.stableId));
  const duplicateBuildingIdCount = buildings.length - new Set(buildings.map(building => (
    building.stableId
  ))).size;
  const orphanFrontageCount = buildings.filter(building => !roadGraph.edges.some(
    edge => edge.edgeId === building.frontageEdgeId,
  )).length;
  const candidateSnapshot = value => Object.freeze({
    stableId: value.buildingStableId,
    buildingIndex: value.buildingIndex,
    buildingType: value.type,
    frontageEdgeId: value.slot.frontageEdgeId,
    frontageInterval: value.slot.frontageInterval,
    side: value.slot.side,
    setbackMeters: value.slot.setbackMeters,
    x: meters(value.spot.x),
    z: meters(value.spot.z),
    rotationY: q6(value.spot.rotationY),
  });
  const [candidateSetHash, selectedSetHash] = await Promise.all([
    sha256Hex(canonicalizeJson(rawCandidates.map(candidateSnapshot)
      .sort((left, right) => left.stableId.localeCompare(right.stableId)))),
    sha256Hex(canonicalizeJson(selectedCandidates.map(candidateSnapshot)
      .sort((left, right) => left.stableId.localeCompare(right.stableId)))),
  ]);
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
      legacyScatterBuildingCount: 0,
      selectionMode: 'RURAL_FRONTAGE_DETERMINISTIC_GREEDY_V1',
      rawCandidateCount: rawCandidates.length,
      materializedCandidateVariantCount: candidateIdentities.flat().length,
      preferredSideImmutableRejectedCandidateCount: preferredSideCandidates.filter(value => (
        value.immutableRejectReasons.length > 0
      )).length,
      preferredSideRoadOverlapCount: preferredSideCandidates.filter(value => (
        value.immutableRejectReasons.includes('ROAD_OVERLAP')
      )).length,
      immutableRejectedCandidateCount: rawCandidates.length - viableCandidates.length,
      immutableRejectReasonCounts: Object.freeze(immutableRejectReasonCounts),
      viableCandidateCount: viableCandidates.length,
      candidateConflictPairCount,
      candidateConflictReasonPairCounts: Object.freeze(candidateConflictReasonPairCounts),
      legacySequentialSelectedCount: legacySequentialSelection.length,
      selectedCandidateCount: selectedCandidates.length,
      selectedClassCounts: Object.freeze(selectedClassCounts),
      alternateSideCandidateCount: rawCandidates.filter(value => (
        value.sidePreferenceRank === 1
      )).length,
      selectedAlternateSideCandidateCount: selectedCandidates.filter(value => (
        value.sidePreferenceRank === 1
      )).length,
      candidateConflictRejectedCount: viableCandidates.length - selectedCandidates.length,
      candidateSetHash: `sha256:${candidateSetHash}`,
      selectedSetHash: `sha256:${selectedSetHash}`,
    }),
  });
}
