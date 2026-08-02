import {
  BUILDING_FRONTAGE_PROFILES,
  buildFrontageAnchorPlan,
  getFrontagePairGaps,
  selectFrontageRoad,
} from '../building-frontage.js';
import { createBuildingLot, orientedRectanglesOverlap } from '../building-lot.js';
import { buildRoadHierarchy, ROAD_KINDS } from '../road-town-structure.js';
import {
  createSettlementBuildingVisual,
  isTowerPlacementAllowed,
} from '../settlement-building-visuals.js';
import { SETTLEMENT_TYPES } from '../settlement-type.js';
import { createW8SettlementBuildingTypeSelector } from './w8-settlement-building-visual-policy.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import {
  ROAD_GENERATION_COUNTER,
} from './road-generation-timing.js';

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
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const meters = value => q6(value / FINITE_WORLD_UNITS_PER_METER);
const frontagePairGaps = Object.freeze(Object.fromEntries(
  Object.keys(APPROXIMATE_BUILDING_RADIUS).map(firstType => [
    firstType,
    Object.freeze(Object.fromEntries(
      Object.keys(APPROXIMATE_BUILDING_RADIUS).map(secondType => [
        secondType,
        getFrontagePairGaps(firstType, secondType),
      ]),
    )),
  ]),
));

function stableFrontageHash(parts) {
  const text = parts.join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createPreparedFrontageRoute(roads) {
  const routeRoads = roads
    .filter(road => road.kind !== ROAD_KINDS.START_APPROACH)
    .sort((first, second) => first.routeOrder - second.routeOrder
      || first.roadId.localeCompare(second.roadId));
  const routeSegments = [];
  let routeLength = 0;
  for (const segment of routeRoads) {
    const length = Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z);
    routeSegments.push(Object.freeze({ segment, startDistance: routeLength, length }));
    routeLength += length;
  }
  return Object.freeze({ routeSegments: Object.freeze(routeSegments), routeLength });
}

function visitPreparedFrontageCandidatePlacements({
  type,
  road,
  preparedRoute,
  buildingIndex,
  townId,
  maximumSlotOffset,
  placementIdentity,
  visitor,
  roadTimingStats = null,
}) {
  const profile = BUILDING_FRONTAGE_PROFILES[type];
  if (roadTimingStats) roadTimingStats.spatialQueries += 1;
  const selectedSegment = preparedRoute.routeSegments.find(candidate => (
    candidate.segment.roadId === road.roadId
  ));
  if (!profile || !selectedSegment) return null;
  const baseDistance = selectedSegment.startDistance + road.roadT * selectedSegment.length;
  const { primarySide, setback } = placementIdentity;
  for (let attempt = 0; attempt <= maximumSlotOffset * 2; attempt += 1) {
    const magnitude = Math.ceil(attempt / 2);
    const slotOffset = attempt === 0 ? 0 : (attempt % 2 === 1 ? magnitude : -magnitude);
    const routeDistance = baseDistance + slotOffset * profile.slotSpacing;
    if (routeDistance < 0 || routeDistance > preparedRoute.routeLength) continue;
    if (roadTimingStats) roadTimingStats.spatialQueries += 1;
    const located = preparedRoute.routeSegments.find(candidate => (
      routeDistance <= candidate.startDistance + candidate.length + 1e-9
    )) ?? preparedRoute.routeSegments[preparedRoute.routeSegments.length - 1];
    const roadT = clamp((routeDistance - located.startDistance) / located.length, 0, 1);
    const segment = located.segment;
    const roadAtSlot = {
      roadId: segment.roadId,
      routeId: segment.routeId,
      kind: segment.kind,
      width: segment.width,
      tangentX: segment.tangentX,
      tangentZ: segment.tangentZ,
      normalX: segment.normalX,
      normalZ: segment.normalZ,
      closestX: segment.start.x + (segment.end.x - segment.start.x) * roadT,
      closestZ: segment.start.z + (segment.end.z - segment.start.z) * roadT,
      roadT,
      roadLength: located.length,
    };
    for (let sideAttempt = 0; sideAttempt < 2; sideAttempt += 1) {
      const side = sideAttempt === 0 ? primarySide : -primarySide;
      const centerDistance = roadAtSlot.width / 2 + profile.frontExtent + setback;
      const outwardNormalX = roadAtSlot.normalX * side;
      const outwardNormalZ = roadAtSlot.normalZ * side;
      const frontageNormalX = -outwardNormalX;
      const frontageNormalZ = -outwardNormalZ;
      const accepted = visitor({
        x: roadAtSlot.closestX + outwardNormalX * centerDistance,
        z: roadAtSlot.closestZ + outwardNormalZ * centerDistance,
        rotationY: Math.atan2(frontageNormalX, frontageNormalZ) + profile.frontRotationOffset,
        frontageRoadId: roadAtSlot.roadId,
        frontageRoadKind: roadAtSlot.kind,
        frontageX: roadAtSlot.closestX,
        frontageZ: roadAtSlot.closestZ,
        frontageNormalX,
        frontageNormalZ,
        setback,
        centerDistance,
        roadT: roadAtSlot.roadT,
        frontageAlong: routeDistance,
        side,
        frontageRouteId: road.routeId,
        slotOffset,
        sideAttempt,
      });
      if (accepted) return accepted;
    }
  }
  return null;
}

function migratedFrontageSpotsConflict(candidate, existing) {
  const gaps = frontagePairGaps[candidate.type][existing.type];
  const minimumDistance = candidate.radius + existing.radius + gaps.passageGap;
  if ((candidate.x - existing.x) ** 2 + (candidate.z - existing.z) ** 2
    < minimumDistance ** 2) return true;
  const sameRoadOrRoute = candidate.frontageRoadId !== null
    && (candidate.frontageRoadId === existing.frontageRoadId
      || (candidate.frontageRouteId
        && candidate.frontageRouteId === existing.frontageRouteId));
  return sameRoadOrRoute
    && Number.isFinite(candidate.frontageAlong)
    && Number.isFinite(existing.frontageAlong)
    && Math.abs(candidate.frontageAlong - existing.frontageAlong)
      < candidate.radius + existing.radius + gaps.alongGap;
}

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

function roadFunctionStarted(roadTimingRun) {
  return roadTimingRun ? (globalThis.performance?.now?.() ?? Date.now()) : null;
}

function recordRoadFunction(roadTimingRun, name, startedAt) {
  if (startedAt === null) return;
  const completedAt = globalThis.performance?.now?.() ?? Date.now();
  roadTimingRun?.recordFunction?.(name, Math.max(0, completedAt - startedAt));
}

function hasFrontageSpotConflict(placed, spot, roadTimingStats) {
  for (const existing of placed) {
    roadTimingStats.intersectionCandidates += 1;
    if (migratedFrontageSpotsConflict(spot, existing)) return true;
  }
  return false;
}

function hasFrontageLotConflict(lots, lot, roadTimingStats) {
  for (const existing of lots) {
    roadTimingStats.intersectionCandidates += 1;
    if (orientedRectanglesOverlap(lot, existing)) return true;
  }
  return false;
}

function buildDeterministicBuildings({ town, hierarchy, settlementId, roadTimingRun = null }) {
  const startedAt = roadFunctionStarted(roadTimingRun);
  const planStartedAt = roadFunctionStarted(roadTimingRun);
  const plan = buildFrontageAnchorPlan({
    samples: hierarchy.pathSamples,
    roads: hierarchy.roads,
    town,
  });
  recordRoadFunction(roadTimingRun, 'settlement-frontage-plan', planStartedAt);
  const anchors = [...plan.CORE, ...plan.MIDDLE, ...plan.OUTER];
  const roadsById = new Map(hierarchy.roads.map(road => [road.roadId, road]));
  const roadsByRoute = new Map();
  for (const road of hierarchy.roads) {
    if (!roadsByRoute.has(road.routeId)) roadsByRoute.set(road.routeId, []);
    roadsByRoute.get(road.routeId).push(road);
  }
  const preparedRoutes = new Map([...roadsByRoute].map(([routeId, roads]) => [
    routeId,
    createPreparedFrontageRoute(roads),
  ]));
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
  const frontageRoadByAnchor = new Map();
  const frontagePlacementIdentityCache = new Map();
  const selectBuildingType = createW8SettlementBuildingTypeSelector({
    settlementType: town.settlementType,
    townId: town.id,
  });
  const roadTimingStats = roadTimingRun ? {
    intersectionCandidates: 0,
    spatialQueries: 0,
  } : null;
  const placementStartedAt = roadFunctionStarted(roadTimingRun);
  for (let buildingIndex = 1; buildingIndex <= attemptedBuildingCount; buildingIndex += 1) {
    let type = selectBuildingType(buildingIndex);
    let accepted = null;
    let acceptedLot = null;
    let acceptedRouteId = null;
    for (let anchorOffset = 0; anchorOffset < anchorSearchLimit && !accepted; anchorOffset += 1) {
      const anchor = anchors[(buildingIndex * 17 + anchorOffset) % anchors.length];
      const anchorKey = `${anchor.x},${anchor.z}`;
      let selectedRoad = frontageRoadByAnchor.get(anchorKey);
      if (selectedRoad === undefined) {
        if (roadTimingStats) roadTimingStats.spatialQueries += 1;
        selectedRoad = selectFrontageRoad({
          x: anchor.x,
          z: anchor.z,
          roads: hierarchy.roads,
          townId: town.id,
        });
        frontageRoadByAnchor.set(anchorKey, selectedRoad);
      }
      if (!selectedRoad) continue;
      if (type === 'tower' && !isTowerPlacementAllowed({
        settlementType: town.settlementType,
        routeId: selectedRoad.routeId,
        x: anchor.x,
        z: anchor.z,
        records: visualRecords,
      })) type = 'house';
      const placementIdentityKey = `${buildingIndex}|${type}|${selectedRoad.roadId}`;
      let placementIdentity = frontagePlacementIdentityCache.get(placementIdentityKey);
      if (!placementIdentity) {
        const identity = [town.id, selectedRoad.roadId, type, buildingIndex];
        const variationUnit = stableFrontageHash([...identity, 'setback']) / 0xffffffff * 2 - 1;
        placementIdentity = Object.freeze({
          primarySide: stableFrontageHash([...identity, 'side']) % 2 === 0 ? -1 : 1,
          setback: clamp(
            BUILDING_FRONTAGE_PROFILES[type].setback
              * (1 + variationUnit * BUILDING_FRONTAGE_PROFILES[type].variation),
            BUILDING_FRONTAGE_PROFILES[type].minSetback,
            BUILDING_FRONTAGE_PROFILES[type].maxSetback,
          ),
        });
        frontagePlacementIdentityCache.set(placementIdentityKey, placementIdentity);
      }
      const acceptedCandidate = visitPreparedFrontageCandidatePlacements({
        type,
        road: selectedRoad,
        preparedRoute: preparedRoutes.get(selectedRoad.routeId),
        buildingIndex,
        townId: town.id,
        maximumSlotOffset: 8,
        placementIdentity,
        roadTimingStats,
        visitor: candidate => {
          const spot = {
            ...candidate,
            radius: APPROXIMATE_BUILDING_RADIUS[type],
            type,
            frontageRouteId: candidate.frontageRouteId ?? selectedRoad.routeId,
          };
          if (Math.hypot(candidate.x - town.x, candidate.z - town.z)
            > town.radius - APPROXIMATE_BUILDING_RADIUS[type]) return null;
          const spotConflict = roadTimingStats
            ? hasFrontageSpotConflict(placed, spot, roadTimingStats)
            : placed.some(existing => migratedFrontageSpotsConflict(spot, existing));
          if (spotConflict) return null;
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
            return null;
          }
          const lotConflict = roadTimingStats
            ? hasFrontageLotConflict(lots, lot, roadTimingStats)
            : lots.some(existing => orientedRectanglesOverlap(lot, existing));
          if (lotConflict) return null;
          return { spot, lot };
        },
      });
      if (acceptedCandidate) {
        accepted = acceptedCandidate.spot;
        acceptedLot = acceptedCandidate.lot;
        acceptedRouteId = acceptedCandidate.spot.frontageRouteId;
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
    const placedRecord = { ...accepted, buildingIndex, visual, lot: acceptedLot };
    placed.push(placedRecord);
    lots.push(acceptedLot);
    visualRecords.push(visualRecord);
  }

  if (roadTimingRun) {
    roadTimingRun.addCounter(
      ROAD_GENERATION_COUNTER.INTERSECTION_CANDIDATES,
      roadTimingStats.intersectionCandidates,
    );
    roadTimingRun.addCounter(
      ROAD_GENERATION_COUNTER.SPATIAL_QUERIES,
      roadTimingStats.spatialQueries,
    );
    recordRoadFunction(roadTimingRun, 'settlement-frontage-placement', placementStartedAt);
  }
  const stableIdStartedAt = roadFunctionStarted(roadTimingRun);
  const result = Promise.all(placed.map(async building => Object.freeze({
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
  if (!roadTimingRun) return result;
  return result.then(value => {
    roadTimingRun.addCounter(ROAD_GENERATION_COUNTER.SORT_DEDUPE_ITEMS, value.buildings.length);
    recordRoadFunction(roadTimingRun, 'settlement-building-stable-id', stableIdStartedAt);
    recordRoadFunction(roadTimingRun, 'settlement-building-placement', startedAt);
    return value;
  });
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

export async function createMigratedSettlementTemplate({ candidate, roadTimingRun = null }) {
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
  const hierarchyStartedAt = roadFunctionStarted(roadTimingRun);
  const hierarchy = createMigratedHierarchy(town);
  recordRoadFunction(roadTimingRun, 'settlement-road-hierarchy', hierarchyStartedAt);
  const resolveRoadIds = () => Promise.all(hierarchy.roads.map(road => stableId('settlement-road-v1', {
    settlementId: candidate.settlementId,
    sourceRoadId: road.roadId,
    routeId: road.routeId,
  })));
  const roadIdStartedAt = roadFunctionStarted(roadTimingRun);
  const roadIds = await resolveRoadIds();
  recordRoadFunction(roadTimingRun, 'settlement-road-stable-id', roadIdStartedAt);
  const createRoadRecords = () => hierarchy.roads.map((road, index) => Object.freeze({
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
  const roadRecordsStartedAt = roadFunctionStarted(roadTimingRun);
  const roads = createRoadRecords();
  recordRoadFunction(roadTimingRun, 'settlement-road-canonicalization', roadRecordsStartedAt);
  if (roadTimingRun) {
    roadTimingRun.addCounter(ROAD_GENERATION_COUNTER.SEGMENTS, roads.length);
    roadTimingRun.addCounter(ROAD_GENERATION_COUNTER.SORT_DEDUPE_ITEMS, roads.length);
  }
  const buildingResult = await buildDeterministicBuildings({
    town,
    hierarchy,
    settlementId: candidate.settlementId,
    roadTimingRun,
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
