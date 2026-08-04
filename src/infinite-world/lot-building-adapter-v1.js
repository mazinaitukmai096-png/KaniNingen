import {
  BUILDING_FRONTAGE_PROFILES,
  frontageSpotsConflict,
} from '../building-frontage.js';
import {
  createBuildingLot,
  orientedRectanglesOverlap,
  pointInOrientedRectangle,
} from '../building-lot.js';
import { ROAD_KINDS } from '../road-town-structure.js';
import {
  createSettlementBuildingVisual,
  isTowerPlacementAllowed,
} from '../settlement-building-visuals.js';
import { SETTLEMENT_TYPES } from '../settlement-type.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { ROAD_GRAPH_CLASSES } from './road-graph-v1.js';
import { FINITE_WORLD_UNITS_PER_METER } from './single-rural-settlement.js';
import { createW8SettlementBuildingTypeSelector } from './w8-settlement-building-visual-policy.js';
import {
  convexPolygonsOverlap,
  deriveSettlementBlockPolygon,
  pointInSettlementPolygon,
  settlementPolygonsOverlap,
} from './settlement-lot-v1.js';

export const LOT_BUILDING_INPUT_ADAPTER_V1 = 'lot-building-input-v1';

const APPROXIMATE_BUILDING_RADIUS = Object.freeze({
  house: 90,
  tower: 65,
  church: 115,
  school: 145,
});
const BUILDING_HEIGHT_UNITS = Object.freeze({ house: 180, tower: 420, school: 190, church: 335 });
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
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const meters = value => q6(value / FINITE_WORLD_UNITS_PER_METER);

function stableFrontageHash(parts) {
  const text = parts.join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

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
  ].map(([rightSign, frontSign]) => ({
    x: rectangle.centerX + rightX * rectangle.width / 2 * rightSign
      + frontX * rectangle.depth / 2 * frontSign,
    z: rectangle.centerZ + rightZ * rectangle.width / 2 * rightSign
      + frontZ * rectangle.depth / 2 * frontSign,
  }));
}

function rectangleContainsRectangle(outer, inner) {
  return rectangleCorners(inner).every(value => pointInOrientedRectangle(
    value.x,
    value.z,
    outer,
    1e-5,
  ));
}

function convertRectangle(rectangle) {
  return Object.freeze({
    centerX: meters(rectangle.centerX),
    centerZ: meters(rectangle.centerZ),
    rotationY: q6(rectangle.rotationY),
    width: meters(rectangle.width),
    depth: meters(rectangle.depth),
  });
}

function convertBuildingLot(lot, phaseLot, buildingStableId) {
  return Object.freeze({
    lotId: phaseLot.id,
    parentLotId: phaseLot.id,
    parentBuildingId: buildingStableId,
    blockId: phaseLot.blockId,
    owner: phaseLot.owner,
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
      ...convertRectangle(lot.pathRectangle),
      parentLotId: phaseLot.id,
      parentBuildingId: buildingStableId,
    }),
    forecourt: Object.freeze({
      ...convertRectangle(lot.forecourtRectangle),
      parentLotId: phaseLot.id,
      parentBuildingId: buildingStableId,
    }),
  });
}

function phaseLotDescriptor({ lot, roadGraph, candidate }) {
  const segment = roadGraph.segments.find(value => value.edgeId === lot.frontageEdgeId);
  if (!segment) throw new RangeError(`Lot frontage edge is missing: ${lot.frontageEdgeId}`);
  const localFootprint = lot.footprint.map(value => localPoint(value, candidate.center));
  const lotFrontMidpoint = {
    x: (localFootprint[0].x + localFootprint[1].x) / 2,
    z: (localFootprint[0].z + localFootprint[1].z) / 2,
  };
  const backMidpoint = {
    x: (localFootprint[2].x + localFootprint[3].x) / 2,
    z: (localFootprint[2].z + localFootprint[3].z) / 2,
  };
  const inwardLength = Math.hypot(
    backMidpoint.x - lotFrontMidpoint.x,
    backMidpoint.z - lotFrontMidpoint.z,
  );
  if (inwardLength <= 1e-9) throw new RangeError(`Lot depth is invalid: ${lot.id}`);
  const inward = {
    x: (backMidpoint.x - lotFrontMidpoint.x) / inwardLength,
    z: (backMidpoint.z - lotFrontMidpoint.z) / inwardLength,
  };
  const outward = { x: -inward.x, z: -inward.z };
  const centerX = (lotFrontMidpoint.x + backMidpoint.x) / 2;
  const centerZ = (lotFrontMidpoint.z + backMidpoint.z) / 2;
  const availableFootprintBounds = Object.freeze({
    centerX,
    centerZ,
    rotationY: Math.atan2(outward.x, outward.z),
    width: Math.hypot(
      localFootprint[1].x - localFootprint[0].x,
      localFootprint[1].z - localFootprint[0].z,
    ),
    depth: inwardLength,
  });
  const start = localPoint(segment.start, candidate.center);
  const end = localPoint(segment.end, candidate.center);
  const frontageT = (lot.frontageInterval[0] + lot.frontageInterval[1]) / 2;
  const frontageMidpoint = Object.freeze({
    x: start.x + (end.x - start.x) * frontageT,
    z: start.z + (end.z - start.z) * frontageT,
  });
  const road = Object.freeze({
    roadId: segment.edgeId,
    routeId: segment.flags.routeId,
    routeOrder: segment.flags.routeOrder,
    kind: LEGACY_KIND_BY_CLASS[segment.class],
    width: segment.widthMeters * FINITE_WORLD_UNITS_PER_METER,
    start,
    end,
    tangentX: segment.tangent.x,
    tangentZ: segment.tangent.z,
    normalX: segment.normal.x,
    normalZ: segment.normal.z,
    townId: roadGraph.settlementId,
  });
  return Object.freeze({
    lot,
    road,
    frontageMidpoint,
    inward: Object.freeze(inward),
    outward: Object.freeze(outward),
    availableFootprintBounds,
    frontageAlong: frontageT * Math.hypot(end.x - start.x, end.z - start.z),
  });
}

export function adaptSettlementLotsToBuildingDescriptors({ lots, roadGraph, candidate } = {}) {
  if (!Array.isArray(lots)) throw new TypeError('lots must be an array');
  return Object.freeze(lots
    .map(lot => phaseLotDescriptor({ lot, roadGraph, candidate }))
    .sort((left, right) => left.lot.id.localeCompare(right.lot.id)));
}

export function createLotBuildingPlacementInput({
  descriptor,
  town,
  settlementId,
  buildingType,
  buildingIndex,
} = {}) {
  const profile = BUILDING_FRONTAGE_PROFILES[buildingType];
  if (!profile) throw new RangeError(`unsupported frontage building type: ${buildingType}`);
  const identity = [town.id, descriptor.road.roadId, buildingType, buildingIndex];
  const variationUnit = stableFrontageHash([...identity, 'setback']) / 0xffffffff * 2 - 1;
  const setback = clamp(
    profile.setback * (1 + variationUnit * profile.variation),
    profile.minSetback,
    profile.maxSetback,
  );
  const centerDistance = descriptor.road.width / 2 + profile.frontExtent + setback;
  const buildingX = descriptor.frontageMidpoint.x + descriptor.inward.x * centerDistance;
  const buildingZ = descriptor.frontageMidpoint.z + descriptor.inward.z * centerDistance;
  const rotationY = Math.atan2(descriptor.outward.x, descriptor.outward.z)
    + profile.frontRotationOffset;
  const frontage = Object.freeze({
    frontageRoadId: descriptor.road.roadId,
    frontageRoadKind: descriptor.road.kind,
    frontageRouteId: descriptor.road.routeId,
    frontageX: descriptor.frontageMidpoint.x,
    frontageZ: descriptor.frontageMidpoint.z,
    frontageNormalX: descriptor.outward.x,
    frontageNormalZ: descriptor.outward.z,
    setback,
    centerDistance,
    roadT: (descriptor.lot.frontageInterval[0] + descriptor.lot.frontageInterval[1]) / 2,
    frontageAlong: descriptor.frontageAlong,
    side: null,
    slotOffset: 0,
    sideAttempt: 0,
  });
  const buildingLot = createBuildingLot({
    buildingType,
    buildingIndex,
    buildingX,
    buildingZ,
    rotationY,
    frontage,
    road: descriptor.road,
  });
  if (!rectangleContainsRectangle(descriptor.availableFootprintBounds, buildingLot)
    || buildingLot.hasEntrancePath !== true) {
    throw new RangeError(`Building does not fit Lot ${descriptor.lot.id}`);
  }
  return Object.freeze({
    adapterVersion: LOT_BUILDING_INPUT_ADAPTER_V1,
    lotId: descriptor.lot.id,
    blockId: descriptor.lot.blockId,
    anchorPosition: Object.freeze({ x: buildingX, z: buildingZ }),
    roadFacingRotation: rotationY,
    frontageRoad: descriptor.road,
    frontageEdgeId: descriptor.lot.frontageEdgeId,
    entrancePosition: Object.freeze({ x: buildingLot.entranceX, z: buildingLot.entranceZ }),
    availableFootprintBounds: descriptor.availableFootprintBounds,
    ownerContext: descriptor.lot.owner,
    settlementContext: Object.freeze({ settlementId, townId: town.id }),
    frontage,
    buildingLot,
  });
}

export async function buildDeterministicBuildingsFromLots({
  town,
  settlementId,
  roadGraph,
  candidate,
  lots,
} = {}) {
  const requestedBuildingCount = Math.round((town.coreRadius * town.coreRadius) / 36_000);
  const attemptedBuildingCount = town.settlementType === SETTLEMENT_TYPES.CITY
    ? Math.min(requestedBuildingCount, 64)
    : requestedBuildingCount;
  const descriptors = adaptSettlementLotsToBuildingDescriptors({ lots, roadGraph, candidate });
  const placed = [];
  const buildingLots = [];
  const visualRecords = [];
  const usedLotIds = new Set();
  const selectBuildingType = createW8SettlementBuildingTypeSelector({
    settlementType: town.settlementType,
    townId: town.id,
  });
  for (let buildingIndex = 1; buildingIndex <= attemptedBuildingCount; buildingIndex += 1) {
    let type = selectBuildingType(buildingIndex);
    let accepted = null;
    for (let offset = 0; offset < descriptors.length && !accepted; offset += 1) {
      const descriptor = descriptors[(buildingIndex * 17 + offset) % descriptors.length];
      if (usedLotIds.has(descriptor.lot.id)) continue;
      let input;
      try {
        input = createLotBuildingPlacementInput({
          descriptor,
          town,
          settlementId,
          buildingType: type,
          buildingIndex,
        });
      } catch {
        continue;
      }
      if (type === 'tower' && !isTowerPlacementAllowed({
        settlementType: town.settlementType,
        routeId: input.frontageRoad.routeId,
        x: input.anchorPosition.x,
        z: input.anchorPosition.z,
        records: visualRecords,
      })) {
        type = 'house';
        try {
          input = createLotBuildingPlacementInput({
            descriptor,
            town,
            settlementId,
            buildingType: type,
            buildingIndex,
          });
        } catch {
          continue;
        }
      }
      const spot = {
        x: input.anchorPosition.x,
        z: input.anchorPosition.z,
        rotationY: input.roadFacingRotation,
        radius: APPROXIMATE_BUILDING_RADIUS[type],
        type,
        ...input.frontage,
      };
      if (Math.hypot(spot.x - town.x, spot.z - town.z)
        > town.radius - APPROXIMATE_BUILDING_RADIUS[type]) continue;
      if (placed.some(existing => frontageSpotsConflict(spot, existing))) continue;
      if (buildingLots.some(existing => orientedRectanglesOverlap(input.buildingLot, existing))) continue;
      accepted = { descriptor, input, spot };
    }
    if (!accepted) continue;
    const visual = createSettlementBuildingVisual({
      settlementType: town.settlementType,
      townId: town.id,
      townType: town.type,
      type,
      buildingIndex,
      routeId: accepted.input.frontageRoad.routeId,
      records: visualRecords,
    });
    visualRecords.push(Object.freeze({
      townId: town.id,
      townType: town.type,
      settlementType: town.settlementType,
      type,
      buildingIndex,
      routeId: accepted.input.frontageRoad.routeId,
      x: accepted.spot.x,
      z: accepted.spot.z,
      heightVariant: visual.heightVariant,
      wallPaletteIndex: visual.wallPaletteIndex,
      roofPaletteIndex: visual.roofPaletteIndex,
    }));
    placed.push({
      ...accepted.spot,
      buildingIndex,
      visual,
      phaseLot: accepted.descriptor.lot,
      buildingLot: accepted.input.buildingLot,
      input: accepted.input,
    });
    buildingLots.push(accepted.input.buildingLot);
    usedLotIds.add(accepted.descriptor.lot.id);
  }
  const buildings = await Promise.all(placed.map(async building => {
    const buildingStableId = await stableId('settlement-building-v1', {
      settlementId,
      buildingIndex: building.buildingIndex,
      type: building.type,
      frontageRoadId: building.frontageRoadId,
    });
    return Object.freeze({
      stableId: buildingStableId,
      featureType: 'settlement-building',
      settlementId,
      buildingIndex: building.buildingIndex,
      buildingType: building.type,
      x: meters(building.x),
      z: meters(building.z),
      rotationY: q6(building.rotationY),
      radiusMeters: meters(building.radius),
      widthMeters: meters(building.buildingLot.footprintWidth),
      depthMeters: meters(building.buildingLot.footprintDepth),
      heightMeters: meters(BUILDING_HEIGHT_UNITS[building.type] * building.visual.heightScale),
      frontageRoadId: building.frontageRoadId,
      frontageRouteId: building.frontageRouteId,
      sourceLotId: building.phaseLot.id,
      blockId: building.phaseLot.blockId,
      owner: building.phaseLot.owner,
      visual: building.visual,
      lot: convertBuildingLot(building.buildingLot, building.phaseLot, buildingStableId),
    });
  }));
  buildings.sort((left, right) => left.stableId.localeCompare(right.stableId));
  const duplicateBuildingIdCount = buildings.length - new Set(
    buildings.map(building => building.stableId),
  ).size;
  const duplicateLotPlacementCount = buildings.length - new Set(
    buildings.map(building => building.sourceLotId),
  ).size;
  const lotsById = new Map(lots.map(lot => [lot.id, lot]));
  const orphanBuildingCount = buildings.filter(building => !lotsById.has(building.sourceLotId)).length;
  const ownerMismatchCount = buildings.filter(building => (
    canonicalizeJson(building.owner) !== canonicalizeJson(lotsById.get(building.sourceLotId)?.owner)
  )).length;
  const frontageConnectionFailureCount = placed.filter(building => (
    building.buildingLot.hasEntrancePath !== true || building.buildingLot.pathLength <= 2
  )).length;
  const validation = Object.freeze({
    valid: duplicateBuildingIdCount === 0 && duplicateLotPlacementCount === 0
      && orphanBuildingCount === 0 && ownerMismatchCount === 0
      && frontageConnectionFailureCount === 0,
    duplicateBuildingIdCount,
    duplicateLotPlacementCount,
    orphanBuildingCount,
    ownerMismatchCount,
    frontageConnectionFailureCount,
  });
  return Object.freeze({
    requestedBuildingCount,
    buildings: Object.freeze(buildings),
    usedLotIds: Object.freeze([...usedLotIds].sort()),
    emptyLotCount: lots.length - usedLotIds.size,
    validation,
  });
}

function globalBuildingLotPolygon(building, candidate) {
  const rectangle = {
    centerX: building.lot.centerX + candidate.center.x,
    centerZ: building.lot.centerZ + candidate.center.z,
    rotationY: building.rotationY,
    width: building.lot.widthMeters,
    depth: building.lot.depthMeters,
  };
  return rectangleCorners(rectangle);
}

export function filterScatterBuildingsForLotCoverage({
  scatterBuildings,
  lots,
  blocks,
  blockResults,
  roadGraph,
  candidate,
} = {}) {
  const lotBlockIds = new Set(blockResults
    .filter(result => result.mode === 'LOT')
    .map(result => result.blockId));
  if (lotBlockIds.size === 0) {
    return Object.freeze({ buildings: Object.freeze([...scatterBuildings]), excludedCount: 0 });
  }
  const coveragePolygons = blocks
    .filter(block => lotBlockIds.has(block.id))
    .map(block => deriveSettlementBlockPolygon({ roadGraph, block }));
  const kept = [];
  let excludedCount = 0;
  for (const building of scatterBuildings) {
    const position = { x: building.x + candidate.center.x, z: building.z + candidate.center.z };
    const footprint = globalBuildingLotPolygon(building, candidate);
    const covered = coveragePolygons.some(polygon => (
      pointInSettlementPolygon(position, polygon)
      || settlementPolygonsOverlap(footprint, polygon)
    ))
      || lots.some(lot => convexPolygonsOverlap(footprint, lot.footprint));
    if (covered) excludedCount += 1;
    else kept.push(building);
  }
  return Object.freeze({ buildings: Object.freeze(kept), excludedCount });
}
