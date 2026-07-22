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

export const MIGRATED_SETTLEMENT_PROFILES = Object.freeze({
  capital: Object.freeze({ settlementType: SETTLEMENT_TYPES.CITY, radius: 4860, coreRadius: 2700 }),
  church_town: Object.freeze({ settlementType: SETTLEMENT_TYPES.TOWN, radius: 3780, coreRadius: 2100 }),
  school_town: Object.freeze({ settlementType: SETTLEMENT_TYPES.TOWN, radius: 3780, coreRadius: 2100 }),
  residential: Object.freeze({ settlementType: SETTLEMENT_TYPES.RURAL, radius: 3510, coreRadius: 1950 }),
  military: Object.freeze({ settlementType: SETTLEMENT_TYPES.RURAL, radius: 3510, coreRadius: 1950 }),
  suburb: Object.freeze({ settlementType: SETTLEMENT_TYPES.RURAL, radius: 3240, coreRadius: 1800 }),
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
  const attemptedBuildingCount = town.settlementType === SETTLEMENT_TYPES.CITY
    ? Math.min(requestedBuildingCount, 64)
    : requestedBuildingCount;
  const anchorSearchLimit = town.settlementType === SETTLEMENT_TYPES.CITY
    ? Math.min(anchors.length, 16)
    : anchors.length;
  const placed = [];
  const lots = [];
  const visualRecords = [];

  for (let buildingIndex = 1; buildingIndex <= attemptedBuildingCount; buildingIndex += 1) {
    let type = selectSettlementBuildingType({
      settlementType: town.settlementType,
      townId: town.id,
      buildingIndex,
    });
    let accepted = null;
    let acceptedLot = null;
    let acceptedRouteId = null;
    for (let anchorOffset = 0; anchorOffset < anchorSearchLimit && !accepted; anchorOffset += 1) {
      const anchor = anchors[(buildingIndex * 17 + anchorOffset) % anchors.length];
      const selectedRoad = selectFrontageRoad({
        x: anchor.x,
        z: anchor.z,
        roads: hierarchy.roads,
        townId: town.id,
      });
      if (!selectedRoad) continue;
      if (type === 'tower' && !isTowerPlacementAllowed({
        settlementType: town.settlementType,
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
      settlementType: town.settlementType,
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
      settlementType: town.settlementType,
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

function createMigratedHierarchy(town) {
  if (town.settlementType !== SETTLEMENT_TYPES.CITY) {
    return buildRoadHierarchy({ townCenters: [town], waterZones: [], exclusionZones: [] });
  }
  const gatewayRadius = 8000;
  const gatewayTypes = ['church_town', 'school_town', 'residential'];
  const gateways = gatewayTypes.map((type, index) => {
    const angle = index * Math.PI * 2 / gatewayTypes.length;
    return Object.freeze({
      id: `${town.id}:gateway:${index}`,
      x: town.x + Math.cos(angle) * gatewayRadius,
      z: town.z + Math.sin(angle) * gatewayRadius,
      radius: 1000,
      coreRadius: 600,
      type,
    });
  });
  const hierarchy = buildRoadHierarchy({
    townCenters: [town, ...gateways],
    waterZones: [],
    exclusionZones: [],
  });
  const roads = hierarchy.roads.filter(road => road.kind === 'MAJOR' || road.townId === town.id);
  const roadIds = new Set(roads.map(road => road.roadId));
  return Object.freeze({
    ...hierarchy,
    roads: Object.freeze(roads),
    pathSamples: Object.freeze(hierarchy.pathSamples.filter(sample => roadIds.has(sample.roadId))),
  });
}

function summarizeMigratedRoads(hierarchy, town) {
  const counts = Object.fromEntries(['MAJOR', 'LOCAL', 'ALLEY', 'START_APPROACH'].map(kind => [
    kind,
    hierarchy.roads.filter(road => road.kind === kind).length,
  ]));
  return Object.freeze({
    settlementType: town.settlementType,
    townType: town.type,
    roadSegmentCounts: Object.freeze(counts),
    junctionCount: hierarchy.junctions.filter(junction => (
      junction.roadIds.some(roadId => hierarchy.roads.some(road => road.roadId === roadId))
    )).length,
    omittedRouteCount: hierarchy.omittedRoutes.length,
    capitalCivicCoreSummary: hierarchy.capitalCivicCoreSummary,
    ruralRoadSummary: hierarchy.ruralRoadSummary[0] ?? null,
  });
}

export async function createMigratedSettlementTemplate({ candidate }) {
  const profile = MIGRATED_SETTLEMENT_PROFILES[candidate?.townType];
  if (!profile || profile.settlementType !== candidate?.settlementType) {
    throw new RangeError('candidate does not match a migrated Settlement profile');
  }
  if (typeof candidate?.settlementId !== 'string'
    || !Number.isFinite(candidate?.center?.x) || !Number.isFinite(candidate?.center?.z)) {
    throw new TypeError('valid distributed Settlement identity and center are required');
  }
  const town = Object.freeze({
    id: candidate.settlementId,
    x: 0,
    z: 0,
    radius: profile.radius,
    coreRadius: profile.coreRadius,
    type: candidate.townType,
    settlementType: candidate.settlementType,
  });
  const hierarchy = createMigratedHierarchy(town);
  const roadIds = await Promise.all(hierarchy.roads.map(road => stableId('settlement-road-v1', {
    settlementId: candidate.settlementId,
    sourceRoadId: road.roadId,
    routeId: road.routeId,
  })));
  const roads = hierarchy.roads.map((road, index) => Object.freeze({
    stableId: roadIds[index],
    featureType: 'settlement-road',
    settlementId: candidate.settlementId,
    sourceRoadId: road.roadId,
    routeId: road.routeId,
    routeOrder: road.routeOrder,
    roadKind: road.kind,
    widthMeters: meters(road.width),
    start: Object.freeze({ x: q6(meters(road.start.x) + candidate.center.x), z: q6(meters(road.start.z) + candidate.center.z) }),
    end: Object.freeze({ x: q6(meters(road.end.x) + candidate.center.x), z: q6(meters(road.end.z) + candidate.center.z) }),
  })).sort((a, b) => a.stableId.localeCompare(b.stableId));
  const buildingResult = await buildDeterministicBuildings({
    town,
    hierarchy,
    settlementId: candidate.settlementId,
  });
  const translateRectangle = rectangle => Object.freeze({
    ...rectangle,
    centerX: q6(rectangle.centerX + candidate.center.x),
    centerZ: q6(rectangle.centerZ + candidate.center.z),
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
      path: translateRectangle(building.lot.path),
      forecourt: translateRectangle(building.lot.forecourt),
    }),
  }));
  const maximumRoadDistance = roads.reduce((maximum, road) => Math.max(
    maximum,
    Math.hypot(road.start.x - candidate.center.x, road.start.z - candidate.center.z),
    Math.hypot(road.end.x - candidate.center.x, road.end.z - candidate.center.z),
  ), 0);
  const radiusMeters = meters(town.radius);
  return Object.freeze({
    schemaVersion: 'w5-migrated-settlement-template-1',
    settlementId: candidate.settlementId,
    settlementType: candidate.settlementType,
    townType: candidate.townType,
    macroRegion: candidate.macroRegion,
    center: Object.freeze({ ...candidate.center }),
    radiusMeters,
    coreRadiusMeters: meters(town.coreRadius),
    influenceRadiusMeters: q6(Math.max(radiusMeters, maximumRoadDistance + 4)),
    urbanization: candidate.urbanization,
    terrainSuitability: candidate.terrainSuitability,
    scaleContract: Object.freeze({
      finiteWorldUnitsPerMeter: FINITE_WORLD_UNITS_PER_METER,
      productionHumanHeightMeters: W4_SINGLE_RURAL.productionHumanHeightMeters,
    }),
    requestedBuildingCount: buildingResult.requestedBuildingCount,
    buildingShortageCount: buildingResult.requestedBuildingCount - buildingResult.buildings.length,
    roads: Object.freeze(roads),
    buildings: Object.freeze(buildings),
    roadSummary: summarizeMigratedRoads(hierarchy, town),
  });
}
