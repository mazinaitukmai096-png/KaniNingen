import {
  buildFrontageAnchorPlan,
  createFrontageCandidatePlacements,
  frontageSpotsConflict,
  selectFrontageRoad,
} from '../building-frontage.js';
import { createBuildingLot, orientedRectanglesOverlap } from '../building-lot.js';
import { buildRoadHierarchy } from '../road-town-structure.js';
import {
  createSettlementBuildingVisual,
  isTowerPlacementAllowed,
  selectSettlementBuildingType,
} from '../settlement-building-visuals.js';
import { SETTLEMENT_TYPES } from '../settlement-type.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';

export const FINITE_WORLD_UNITS_PER_METER = 40;
export const W4_SINGLE_RURAL = Object.freeze({
  schemaVersion: 'w4-single-rural-settlement-1',
  townType: 'residential',
  settlementType: SETTLEMENT_TYPES.RURAL,
  centerMeters: Object.freeze({ x: 8, z: 8 }),
  radiusFiniteWorldUnits: 3510,
  coreRadiusFiniteWorldUnits: 1950,
  sourceHumanHeightUnits: 140,
  productionHumanVisualScale: 0.5,
  productionHumanHeightMeters: 1.75,
});

const APPROXIMATE_BUILDING_RADIUS = Object.freeze({ house: 90, tower: 65, church: 115, school: 145 });
const BUILDING_HEIGHT_UNITS = Object.freeze({ house: 180, tower: 420, school: 190, church: 335 });
const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const meters = value => q6(value / FINITE_WORLD_UNITS_PER_METER);

async function stableId(prefix, input) {
  return `${prefix}:${(await sha256Hex(canonicalizeJson(input))).slice(0, 24)}`;
}

function convertLot(lot) {
  const convertRectangle = rectangle => Object.freeze({
    centerX: meters(rectangle.centerX),
    centerZ: meters(rectangle.centerZ),
    rotationY: q6(rectangle.rotationY),
    width: meters(rectangle.width),
    depth: meters(rectangle.depth),
  });
  return Object.freeze({
    lotId: lot.lotId,
    lotStatus: lot.lotStatus,
    widthMeters: meters(lot.width),
    depthMeters: meters(lot.depth),
    centerX: meters(lot.centerX),
    centerZ: meters(lot.centerZ),
    entranceX: meters(lot.entranceX),
    entranceZ: meters(lot.entranceZ),
    roadAccessX: meters(lot.roadAccessX),
    roadAccessZ: meters(lot.roadAccessZ),
    path: convertRectangle(lot.pathRectangle),
    forecourt: convertRectangle(lot.forecourtRectangle),
  });
}

function buildDeterministicBuildings({ town, hierarchy, settlementId }) {
  const plan = buildFrontageAnchorPlan({
    samples: hierarchy.pathSamples,
    roads: hierarchy.roads,
    town,
  });
  const anchors = [...plan.CORE, ...plan.MIDDLE, ...plan.OUTER];
  const roadsById = new Map(hierarchy.roads.map(road => [road.roadId, road]));
  const requestedBuildingCount = Math.round((town.coreRadius * town.coreRadius) / 36_000);
  const placed = [];
  const lots = [];
  const visualRecords = [];

  for (let buildingIndex = 1; buildingIndex <= requestedBuildingCount; buildingIndex += 1) {
    let type = selectSettlementBuildingType({
      settlementType: SETTLEMENT_TYPES.RURAL,
      townId: town.id,
      buildingIndex,
    });
    let accepted = null;
    let acceptedLot = null;
    let acceptedRouteId = null;
    for (let anchorOffset = 0; anchorOffset < anchors.length && !accepted; anchorOffset += 1) {
      const anchor = anchors[(buildingIndex * 17 + anchorOffset) % anchors.length];
      const selectedRoad = selectFrontageRoad({
        x: anchor.x,
        z: anchor.z,
        roads: hierarchy.roads,
        townId: town.id,
      });
      if (!selectedRoad) continue;
      if (type === 'tower' && !isTowerPlacementAllowed({
        settlementType: SETTLEMENT_TYPES.RURAL,
        routeId: selectedRoad.routeId,
        x: anchor.x,
        z: anchor.z,
        records: visualRecords,
      })) type = 'house';
      const candidates = createFrontageCandidatePlacements({
        type,
        road: selectedRoad,
        roads: hierarchy.roads,
        buildingIndex,
        townId: town.id,
        maximumSlotOffset: 8,
      }).placements;
      for (const candidate of candidates) {
        const spot = {
          ...candidate,
          radius: APPROXIMATE_BUILDING_RADIUS[type],
          type,
          frontageRouteId: candidate.frontageRouteId ?? selectedRoad.routeId,
        };
        if (Math.hypot(candidate.x - town.x, candidate.z - town.z)
          > town.radius - APPROXIMATE_BUILDING_RADIUS[type]) continue;
        if (placed.some(existing => frontageSpotsConflict(spot, existing))) continue;
        const road = roadsById.get(candidate.frontageRoadId);
        let lot;
        try {
          lot = createBuildingLot({
            buildingType: type,
            buildingIndex,
            buildingX: candidate.x,
            buildingZ: candidate.z,
            rotationY: candidate.rotationY,
            frontage: candidate,
            road,
          });
        } catch {
          continue;
        }
        if (lots.some(existing => orientedRectanglesOverlap(lot, existing))) continue;
        accepted = spot;
        acceptedLot = lot;
        acceptedRouteId = spot.frontageRouteId;
        break;
      }
    }
    if (!accepted) continue;
    const visual = createSettlementBuildingVisual({
      settlementType: SETTLEMENT_TYPES.RURAL,
      townId: town.id,
      townType: town.type,
      type,
      buildingIndex,
      routeId: acceptedRouteId,
      records: visualRecords,
    });
    const visualRecord = Object.freeze({
      townId: town.id,
      townType: town.type,
      settlementType: SETTLEMENT_TYPES.RURAL,
      type,
      buildingIndex,
      routeId: acceptedRouteId,
      x: accepted.x,
      z: accepted.z,
      heightVariant: visual.heightVariant,
      wallPaletteIndex: visual.wallPaletteIndex,
      roofPaletteIndex: visual.roofPaletteIndex,
    });
    placed.push({ ...accepted, buildingIndex, visual, lot: acceptedLot });
    lots.push(acceptedLot);
    visualRecords.push(visualRecord);
  }

  return Promise.all(placed.map(async building => Object.freeze({
    stableId: await stableId('settlement-building-v1', {
      settlementId,
      buildingIndex: building.buildingIndex,
      type: building.type,
      frontageRoadId: building.frontageRoadId,
    }),
    featureType: 'settlement-building',
    settlementId,
    buildingIndex: building.buildingIndex,
    buildingType: building.type,
    x: meters(building.x),
    z: meters(building.z),
    rotationY: q6(building.rotationY),
    radiusMeters: meters(building.radius),
    widthMeters: meters(building.lot.footprintWidth),
    depthMeters: meters(building.lot.footprintDepth),
    heightMeters: meters(BUILDING_HEIGHT_UNITS[building.type] * building.visual.heightScale),
    frontageRoadId: building.frontageRoadId,
    frontageRouteId: building.frontageRouteId,
    visual: building.visual,
    lot: convertLot(building.lot),
  }))).then(buildings => ({
    requestedBuildingCount,
    buildings: buildings.sort((a, b) => a.stableId.localeCompare(b.stableId)),
  }));
}

export async function createSingleRuralSettlementTemplate({ worldSeedHash }) {
  const settlementId = await stableId('settlement-v1', {
    worldSeedHash,
    phase: 'W4',
    settlementType: SETTLEMENT_TYPES.RURAL,
    ordinal: 0,
  });
  const town = Object.freeze({
    id: settlementId,
    x: W4_SINGLE_RURAL.centerMeters.x * FINITE_WORLD_UNITS_PER_METER,
    z: W4_SINGLE_RURAL.centerMeters.z * FINITE_WORLD_UNITS_PER_METER,
    radius: W4_SINGLE_RURAL.radiusFiniteWorldUnits,
    coreRadius: W4_SINGLE_RURAL.coreRadiusFiniteWorldUnits,
    type: W4_SINGLE_RURAL.townType,
    settlementType: SETTLEMENT_TYPES.RURAL,
  });
  const hierarchy = buildRoadHierarchy({ townCenters: [town], waterZones: [], exclusionZones: [] });
  const roadIds = await Promise.all(hierarchy.roads.map(road => stableId('settlement-road-v1', {
    settlementId,
    sourceRoadId: road.roadId,
    routeId: road.routeId,
  })));
  const roads = hierarchy.roads.map((road, index) => Object.freeze({
    stableId: roadIds[index],
    featureType: 'settlement-road',
    settlementId,
    sourceRoadId: road.roadId,
    routeId: road.routeId,
    routeOrder: road.routeOrder,
    roadKind: road.kind,
    widthMeters: meters(road.width),
    start: Object.freeze({ x: meters(road.start.x), z: meters(road.start.z) }),
    end: Object.freeze({ x: meters(road.end.x), z: meters(road.end.z) }),
  })).sort((a, b) => a.stableId.localeCompare(b.stableId));
  const buildingResult = await buildDeterministicBuildings({ town, hierarchy, settlementId });
  return Object.freeze({
    schemaVersion: W4_SINGLE_RURAL.schemaVersion,
    settlementId,
    settlementType: SETTLEMENT_TYPES.RURAL,
    townType: town.type,
    center: W4_SINGLE_RURAL.centerMeters,
    radiusMeters: meters(town.radius),
    coreRadiusMeters: meters(town.coreRadius),
    scaleContract: Object.freeze({
      finiteWorldUnitsPerMeter: FINITE_WORLD_UNITS_PER_METER,
      productionHumanHeightMeters: W4_SINGLE_RURAL.productionHumanHeightMeters,
    }),
    requestedBuildingCount: buildingResult.requestedBuildingCount,
    buildingShortageCount: buildingResult.requestedBuildingCount - buildingResult.buildings.length,
    roads: Object.freeze(roads),
    buildings: Object.freeze(buildingResult.buildings),
    roadSummary: hierarchy.ruralRoadSummary[0],
  });
}
