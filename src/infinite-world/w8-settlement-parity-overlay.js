import { BUILDING_LOT_PROFILES, orientedRectanglesOverlap } from '../building-lot.js';
import {
  createSettlementBuildingVisual,
  selectSettlementBuildingType,
} from '../settlement-building-visuals.js';
import { createWorldFeatureId } from './legacy-core/g0/stable-id.js';
import { logicalWorldToOwnedChunk } from './chunk-coordinates.js';
import {
  FINITE_WORLD_UNITS_PER_METER,
  createMigratedSettlementTemplate,
} from './single-rural-settlement.js';

export const W8_SETTLEMENT_PARITY_DENSITY = Object.freeze({
  schemaVersion: 'w8-settlement-parity-density-1',
  sourceCommit: 'f8bc9f80c2af417bb585bff26c99522c4229ab8e',
  highQualityHumanDensity: 1,
  buildingOpportunityRatioByTownType: Object.freeze({
    capital: 0.78,
    church_town: 0.78,
    school_town: 0.78,
    residential: 0.78,
    military: 0.60,
    suburb: 0.50,
  }),
  roadSlotSpacingMeters: Object.freeze({ CITY: 6.5, TOWN: 7, RURAL: 7.5 }),
  minimumRoadSegmentMeters: 1.25,
  maximumRoadAccessMeters: 50,
  lotSeparationMeters: 0.35,
});
const W8_PARITY_GENERATOR_MAJOR = 800;

const BUILDING_HEIGHT_UNITS = Object.freeze({
  house: 180,
  tower: 420,
  school: 190,
  church: 335,
});

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const meters = value => q6(value / FINITE_WORLD_UNITS_PER_METER);

function finiteLotFromRoad({ type, buildingIndex, buildingX, buildingZ, rotationY,
  road, centerline, frontX, frontZ }) {
  const profile = BUILDING_LOT_PROFILES[type];
  const footprintWidth = meters(profile.footprintWidth);
  const footprintDepth = meters(profile.footprintDepth);
  const sideMargin = meters(profile.sideMargin);
  const frontMargin = meters(profile.frontMargin);
  const backMargin = meters(profile.backMargin);
  const width = footprintWidth + sideMargin * 2;
  const depth = footprintDepth + frontMargin + backMargin;
  const centerShift = (frontMargin - backMargin) / 2;
  const centerX = buildingX + frontX * centerShift;
  const centerZ = buildingZ + frontZ * centerShift;
  const entranceX = buildingX + frontX * meters(profile.entranceOffset);
  const entranceZ = buildingZ + frontZ * meters(profile.entranceOffset);
  const roadAccessX = centerline.x - frontX * road.widthMeters / 2;
  const roadAccessZ = centerline.z - frontZ * road.widthMeters / 2;
  const pathLength = Math.max(0,
    (roadAccessX - entranceX) * frontX + (roadAccessZ - entranceZ) * frontZ);
  const pathCenterX = entranceX + frontX * pathLength / 2;
  const pathCenterZ = entranceZ + frontZ * pathLength / 2;
  const forecourtDepth = Math.max(meters(8), frontMargin);
  const forecourtCenterX = buildingX + frontX * (footprintDepth / 2 + forecourtDepth / 2);
  const forecourtCenterZ = buildingZ + frontZ * (footprintDepth / 2 + forecourtDepth / 2);
  const rectangle = (x, z, rectangleWidth, rectangleDepth) => Object.freeze({
    centerX: q6(x),
    centerZ: q6(z),
    rotationY: q6(rotationY),
    width: q6(rectangleWidth),
    depth: q6(rectangleDepth),
  });
  return Object.freeze({
    lotId: `w8-overlay-lot-${String(buildingIndex).padStart(4, '0')}`,
    lotStatus: 'ACTIVE',
    widthMeters: q6(width),
    depthMeters: q6(depth),
    centerX: q6(centerX),
    centerZ: q6(centerZ),
    entranceX: q6(entranceX),
    entranceZ: q6(entranceZ),
    roadAccessX: q6(roadAccessX),
    roadAccessZ: q6(roadAccessZ),
    path: rectangle(pathCenterX, pathCenterZ, meters(profile.pathWidth), pathLength),
    forecourt: rectangle(
      forecourtCenterX,
      forecourtCenterZ,
      Math.min(meters(profile.forecourtWidth), width),
      forecourtDepth,
    ),
  });
}

function lotRectangle(lot) {
  return {
    centerX: lot.centerX,
    centerZ: lot.centerZ,
    rotationY: lot.rotationY ?? 0,
    width: lot.widthMeters ?? lot.width,
    depth: lot.depthMeters ?? lot.depth,
  };
}

function nearestPointOnSegment(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) return { x: start.x, z: start.z, distance: Math.hypot(point.x - start.x, point.z - start.z) };
  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared));
  const x = start.x + dx * t;
  const z = start.z + dz * t;
  return { x, z, distance: Math.hypot(point.x - x, point.z - z) };
}

async function overlayStableId({ worldSeedHash, settlementId, type, road, slot, side }) {
  return (await createWorldFeatureId({
    stableIdSchema: 'wf1',
    worldSeedHash,
    generatorMajor: W8_PARITY_GENERATOR_MAJOR,
    featureType: 'settlement-building-overlay',
    parentStableId: settlementId,
    purposeKey: type,
    semanticLocalKey: `${road.sourceStableId ?? road.stableId}:slot:${slot}:side:${side}`,
  })).stableId;
}

function targetBuildingCount(template) {
  const ratio = W8_SETTLEMENT_PARITY_DENSITY
    .buildingOpportunityRatioByTownType[template.townType];
  if (!Number.isFinite(ratio)) throw new RangeError(`unsupported W8 town type: ${template.townType}`);
  return Math.round(template.requestedBuildingCount * ratio);
}

export async function createW8SettlementParityOverlay({ candidate, worldSeedHash } = {}) {
  if (typeof worldSeedHash !== 'string') throw new TypeError('worldSeedHash is required');
  const template = await createMigratedSettlementTemplate({ candidate });
  const targetCount = targetBuildingCount(template);
  const additionsRequired = Math.max(0, targetCount - template.buildings.length);
  const lots = template.buildings.map(building => lotRectangle({
    ...building.lot,
    rotationY: building.rotationY,
  }));
  const buildings = [];
  const visualRecords = template.buildings.map(building => ({
    townId: template.settlementId,
    townType: template.townType,
    settlementType: template.settlementType,
    type: building.buildingType,
    buildingIndex: building.buildingIndex,
    routeId: building.frontageRouteId,
    x: building.x,
    z: building.z,
  }));
  const roads = template.roads
    .filter(road => road.roadKind !== 'START_APPROACH')
    .toSorted((left, right) => left.stableId.localeCompare(right.stableId));
  const spacing = W8_SETTLEMENT_PARITY_DENSITY.roadSlotSpacingMeters[template.settlementType];
  let buildingIndex = template.requestedBuildingCount + 1;

  for (const road of roads) {
    if (buildings.length >= additionsRequired) break;
    const dx = road.end.x - road.start.x;
    const dz = road.end.z - road.start.z;
    const length = Math.hypot(dx, dz);
    if (length < W8_SETTLEMENT_PARITY_DENSITY.minimumRoadSegmentMeters) continue;
    const tangentX = dx / length;
    const tangentZ = dz / length;
    const normalX = -tangentZ;
    const normalZ = tangentX;
    const slotCount = Math.max(1, Math.floor(length / spacing));
    for (let slot = 0; slot < slotCount && buildings.length < additionsRequired; slot += 1) {
      const along = (slot + 0.5) / slotCount;
      const centerline = {
        x: road.start.x + dx * along,
        z: road.start.z + dz * along,
      };
      for (const side of [-1, 1]) {
        if (buildings.length >= additionsRequired) break;
        let type = selectSettlementBuildingType({
          settlementType: template.settlementType,
          townId: template.settlementId,
          buildingIndex,
        });
        const profile = BUILDING_LOT_PROFILES[type];
        const outwardX = normalX * side;
        const outwardZ = normalZ * side;
        const frontX = -outwardX;
        const frontZ = -outwardZ;
        const offset = road.widthMeters / 2
          + meters(profile.footprintDepth) / 2 + meters(profile.frontMargin);
        const x = q6(centerline.x + outwardX * offset);
        const z = q6(centerline.z + outwardZ * offset);
        if (Math.hypot(x - template.center.x, z - template.center.z)
          > template.radiusMeters * 0.98) continue;
        const rotationY = q6(Math.atan2(frontX, frontZ));
        const lot = finiteLotFromRoad({
          type,
          buildingIndex,
          buildingX: x,
          buildingZ: z,
          rotationY,
          road,
          centerline,
          frontX,
          frontZ,
        });
        const rectangle = { ...lotRectangle({ ...lot, rotationY }) };
        if (lots.some(existing => orientedRectanglesOverlap(
          rectangle,
          existing,
          W8_SETTLEMENT_PARITY_DENSITY.lotSeparationMeters,
        ))) continue;
        const buildingRadius = Math.hypot(
          meters(profile.footprintWidth),
          meters(profile.footprintDepth),
        ) / 2;
        const visual = createSettlementBuildingVisual({
          settlementType: template.settlementType,
          townId: template.settlementId,
          townType: template.townType,
          type,
          buildingIndex,
          routeId: road.routeId,
          records: visualRecords,
        });
        const stableId = await overlayStableId({
          worldSeedHash,
          settlementId: template.settlementId,
          type,
          road,
          slot,
          side,
        });
        const owner = logicalWorldToOwnedChunk(x, z);
        buildings.push(Object.freeze({
          schemaVersion: 'w8-settlement-building-overlay-1',
          stableId,
          featureType: 'settlement-building',
          parityOverlay: true,
          settlementId: template.settlementId,
          settlementType: template.settlementType,
          townType: template.townType,
          buildingIndex,
          buildingType: type,
          x,
          z,
          rotationY,
          radiusMeters: q6(buildingRadius),
          widthMeters: meters(profile.footprintWidth),
          depthMeters: meters(profile.footprintDepth),
          heightMeters: q6(meters(BUILDING_HEIGHT_UNITS[type]) * visual.heightScale),
          frontageRoadId: road.stableId,
          frontageRouteId: road.routeId,
          visual,
          lot,
          owningChunkCoordinate: Object.freeze({ x: owner.chunkX, z: owner.chunkZ }),
        }));
        lots.push(rectangle);
        visualRecords.push({
          townId: template.settlementId,
          townType: template.townType,
          settlementType: template.settlementType,
          type,
          buildingIndex,
          routeId: road.routeId,
          x,
          z,
        });
        buildingIndex += 1;
      }
    }
  }

  const gridSpacing = spacing;
  const gridRadius = template.radiusMeters * 0.88;
  const gridMinimum = {
    x: Math.floor((template.center.x - gridRadius) / gridSpacing),
    z: Math.floor((template.center.z - gridRadius) / gridSpacing),
  };
  const gridMaximum = {
    x: Math.ceil((template.center.x + gridRadius) / gridSpacing),
    z: Math.ceil((template.center.z + gridRadius) / gridSpacing),
  };
  for (let gridZ = gridMinimum.z; gridZ <= gridMaximum.z && buildings.length < additionsRequired; gridZ += 1) {
    for (let gridX = gridMinimum.x; gridX <= gridMaximum.x && buildings.length < additionsRequired; gridX += 1) {
      const parityOffset = ((gridX * 31 + gridZ * 17) & 3) / 4 - 0.375;
      const point = {
        x: (gridX + 0.5) * gridSpacing + parityOffset * gridSpacing * 0.35,
        z: (gridZ + 0.5) * gridSpacing - parityOffset * gridSpacing * 0.35,
      };
      if (Math.hypot(point.x - template.center.x, point.z - template.center.z) > gridRadius) continue;
      let nearest = null;
      for (const road of roads) {
        const projection = nearestPointOnSegment(point, road.start, road.end);
        if (!nearest || projection.distance < nearest.distance
          || (projection.distance === nearest.distance && road.stableId.localeCompare(nearest.road.stableId) < 0)) {
          nearest = { ...projection, road };
        }
      }
      if (!nearest || nearest.distance > W8_SETTLEMENT_PARITY_DENSITY.maximumRoadAccessMeters
        || nearest.distance < 1e-6) continue;
      const type = selectSettlementBuildingType({
        settlementType: template.settlementType,
        townId: template.settlementId,
        buildingIndex,
      });
      const profile = BUILDING_LOT_PROFILES[type];
      const outwardX = (point.x - nearest.x) / nearest.distance;
      const outwardZ = (point.z - nearest.z) / nearest.distance;
      const frontX = -outwardX;
      const frontZ = -outwardZ;
      const minimumOffset = nearest.road.widthMeters / 2
        + meters(profile.footprintDepth) / 2 + meters(profile.frontMargin);
      const offset = Math.max(nearest.distance, minimumOffset);
      const x = q6(nearest.x + outwardX * offset);
      const z = q6(nearest.z + outwardZ * offset);
      if (Math.hypot(x - template.center.x, z - template.center.z) > template.radiusMeters * 0.98) continue;
      const rotationY = q6(Math.atan2(frontX, frontZ));
      const lot = finiteLotFromRoad({
        type,
        buildingIndex,
        buildingX: x,
        buildingZ: z,
        rotationY,
        road: nearest.road,
        centerline: { x: nearest.x, z: nearest.z },
        frontX,
        frontZ,
      });
      const rectangle = { ...lotRectangle({ ...lot, rotationY }) };
      if (lots.some(existing => orientedRectanglesOverlap(
        rectangle,
        existing,
        W8_SETTLEMENT_PARITY_DENSITY.lotSeparationMeters,
      ))) continue;
      const visual = createSettlementBuildingVisual({
        settlementType: template.settlementType,
        townId: template.settlementId,
        townType: template.townType,
        type,
        buildingIndex,
        routeId: nearest.road.routeId,
        records: visualRecords,
      });
      const stableId = await overlayStableId({
        worldSeedHash,
        settlementId: template.settlementId,
        type,
        road: nearest.road,
        slot: `grid-${gridX}-${gridZ}`,
        side: 0,
      });
      const owner = logicalWorldToOwnedChunk(x, z);
      const buildingRadius = Math.hypot(
        meters(profile.footprintWidth),
        meters(profile.footprintDepth),
      ) / 2;
      buildings.push(Object.freeze({
        schemaVersion: 'w8-settlement-building-overlay-1',
        stableId,
        featureType: 'settlement-building',
        parityOverlay: true,
        settlementId: template.settlementId,
        settlementType: template.settlementType,
        townType: template.townType,
        buildingIndex,
        buildingType: type,
        x,
        z,
        rotationY,
        radiusMeters: q6(buildingRadius),
        widthMeters: meters(profile.footprintWidth),
        depthMeters: meters(profile.footprintDepth),
        heightMeters: q6(meters(BUILDING_HEIGHT_UNITS[type]) * visual.heightScale),
        frontageRoadId: nearest.road.stableId,
        frontageRouteId: nearest.road.routeId,
        visual,
        lot,
        owningChunkCoordinate: Object.freeze({ x: owner.chunkX, z: owner.chunkZ }),
      }));
      lots.push(rectangle);
      visualRecords.push({
        townId: template.settlementId,
        townType: template.townType,
        settlementType: template.settlementType,
        type,
        buildingIndex,
        routeId: nearest.road.routeId,
        x,
        z,
      });
      buildingIndex += 1;
    }
  }

  return Object.freeze({
    schemaVersion: 'w8-settlement-parity-overlay-template-1',
    settlementId: template.settlementId,
    settlementType: template.settlementType,
    townType: template.townType,
    requestedOpportunityCount: template.requestedBuildingCount,
    targetBuildingCount: targetCount,
    sourceBuildingCount: template.buildings.length,
    overlayBuildingCount: buildings.length,
    shortageCount: Math.max(0, additionsRequired - buildings.length),
    buildings: Object.freeze(buildings.sort((left, right) => left.stableId.localeCompare(right.stableId))),
  });
}
