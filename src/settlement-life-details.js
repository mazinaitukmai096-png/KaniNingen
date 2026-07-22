import {
  LOT_STATUS,
  TINY_MINIMUM_LOT_PASSAGE,
  bridgeToRectangle,
  roadSurfaceToRectangle,
} from './building-lot.js';
import {
  CIVIC_SPACE_STATUS,
  civicSpaceToAccessRectangle,
  civicSpaceToBodyRectangle,
} from './civic-space.js';
import { ROAD_KINDS } from './road-town-structure.js';
import {
  WORLD_DETAIL_INSTANCE_CAPACITY,
  WORLD_DETAIL_INTERACTION_RADII,
  WORLD_DETAIL_PARTS,
  WORLD_DETAIL_TYPES,
} from './world-scale-rebalance.js';

export const SETTLEMENT_LIFE_DETAIL_CONTEXTS = Object.freeze({
  CIVIC_SPACE: 'CIVIC_SPACE',
  BUILDING_ENTRANCE: 'BUILDING_ENTRANCE',
  PARK_EDGE: 'PARK_EDGE',
  MAJOR_ROAD: 'MAJOR_ROAD',
  LOCAL_ROAD: 'LOCAL_ROAD',
  INTERSECTION: 'INTERSECTION',
  RURAL_EDGE: 'RURAL_EDGE',
  MILITARY_EDGE: 'MILITARY_EDGE',
});

export const SETTLEMENT_LIFE_DETAIL_TOWN_COUNTS = Object.freeze({
  capital: 30,
  church_town: 18,
  school_town: 18,
  residential: 10,
  military: 10,
  suburb: 10,
});

export const SETTLEMENT_LIFE_DETAIL_TYPE_COUNTS_BY_TOWN = Object.freeze({
  capital: Object.freeze({
    streetLamp: 6, bench: 4, trashBin: 4, roadSign: 5,
    planter: 4, vendingMachine: 3, parkedCar: 3, fence: 1,
  }),
  church_town: Object.freeze({
    streetLamp: 2, bench: 5, trashBin: 3, roadSign: 3,
    planter: 3, vendingMachine: 1, parkedCar: 0, fence: 1,
  }),
  school_town: Object.freeze({
    streetLamp: 2, bench: 5, trashBin: 3, roadSign: 3,
    planter: 3, vendingMachine: 1, parkedCar: 0, fence: 1,
  }),
  residential: Object.freeze({
    streetLamp: 1, bench: 1, trashBin: 3, roadSign: 1,
    planter: 1, vendingMachine: 1, parkedCar: 1, fence: 1,
  }),
  military: Object.freeze({
    streetLamp: 0, bench: 1, trashBin: 2, roadSign: 3,
    planter: 0, vendingMachine: 0, parkedCar: 2, fence: 2,
  }),
  suburb: Object.freeze({
    streetLamp: 1, bench: 2, trashBin: 3, roadSign: 3,
    planter: 1, vendingMachine: 0, parkedCar: 0, fence: 0,
  }),
});

export const SETTLEMENT_LIFE_DETAIL_PLACEMENT_RADII = Object.freeze({
  streetLamp: 9,
  bench: 30,
  trashBin: 15,
  roadSign: 14,
  planter: 18,
  vendingMachine: 18,
  parkedCar: 48,
  fence: 34,
});

const CONTEXT_VALUES = Object.freeze(Object.values(SETTLEMENT_LIFE_DETAIL_CONTEXTS));
const CIVIC_ALLOWED_TYPES = Object.freeze({
  capital: new Set(['streetLamp', 'bench', 'trashBin', 'roadSign', 'planter', 'vendingMachine']),
  church_town: new Set(['streetLamp', 'bench', 'trashBin', 'roadSign', 'planter']),
  school_town: new Set(['streetLamp', 'bench', 'trashBin', 'roadSign', 'planter']),
});
const TYPE_CONTEXTS = Object.freeze({
  streetLamp: Object.freeze(['CIVIC_SPACE', 'MAJOR_ROAD', 'LOCAL_ROAD', 'BUILDING_ENTRANCE', 'INTERSECTION']),
  bench: Object.freeze(['CIVIC_SPACE', 'PARK_EDGE', 'BUILDING_ENTRANCE']),
  trashBin: Object.freeze(['BUILDING_ENTRANCE', 'CIVIC_SPACE', 'PARK_EDGE', 'RURAL_EDGE', 'MILITARY_EDGE']),
  roadSign: Object.freeze(['INTERSECTION', 'MAJOR_ROAD', 'LOCAL_ROAD', 'MILITARY_EDGE', 'CIVIC_SPACE']),
  planter: Object.freeze(['CIVIC_SPACE', 'BUILDING_ENTRANCE', 'PARK_EDGE']),
  vendingMachine: Object.freeze(['BUILDING_ENTRANCE', 'CIVIC_SPACE', 'PARK_EDGE']),
  parkedCar: Object.freeze(['MAJOR_ROAD', 'LOCAL_ROAD', 'BUILDING_ENTRANCE', 'RURAL_EDGE', 'MILITARY_EDGE']),
  fence: Object.freeze(['BUILDING_ENTRANCE', 'RURAL_EDGE', 'MILITARY_EDGE', 'LOCAL_ROAD']),
});
const RURAL_CONTEXTS = Object.freeze({
  streetLamp: Object.freeze(['LOCAL_ROAD', 'BUILDING_ENTRANCE', 'RURAL_EDGE']),
  bench: Object.freeze(['PARK_EDGE', 'BUILDING_ENTRANCE', 'RURAL_EDGE']),
  trashBin: Object.freeze(['BUILDING_ENTRANCE', 'RURAL_EDGE', 'PARK_EDGE']),
  roadSign: Object.freeze(['INTERSECTION', 'LOCAL_ROAD', 'RURAL_EDGE']),
  planter: Object.freeze(['BUILDING_ENTRANCE', 'PARK_EDGE', 'RURAL_EDGE']),
  vendingMachine: Object.freeze(['BUILDING_ENTRANCE', 'PARK_EDGE']),
  parkedCar: Object.freeze(['RURAL_EDGE', 'BUILDING_ENTRANCE', 'LOCAL_ROAD']),
  fence: Object.freeze(['RURAL_EDGE', 'BUILDING_ENTRANCE', 'LOCAL_ROAD']),
});

function finite(...values) {
  return values.every(Number.isFinite);
}

function townId(town, townIndex) {
  return town.id ?? `town-${townIndex}-${town.type}`;
}

function axes(rotationY) {
  return {
    rightX: Math.cos(rotationY),
    rightZ: -Math.sin(rotationY),
    frontX: Math.sin(rotationY),
    frontZ: Math.cos(rotationY),
  };
}

function circleIntersectsRectangle(x, z, radius, rectangle, clearance = 0) {
  if (!rectangle || !finite(
    rectangle.centerX, rectangle.centerZ, rectangle.rotationY,
    rectangle.width, rectangle.depth,
  )) return false;
  const basis = axes(rectangle.rotationY);
  const dx = x - rectangle.centerX;
  const dz = z - rectangle.centerZ;
  const localRight = dx * basis.rightX + dz * basis.rightZ;
  const localFront = dx * basis.frontX + dz * basis.frontZ;
  const halfWidth = rectangle.width / 2 + clearance;
  const halfDepth = rectangle.depth / 2 + clearance;
  const closestRight = Math.max(-halfWidth, Math.min(halfWidth, localRight));
  const closestFront = Math.max(-halfDepth, Math.min(halfDepth, localFront));
  return Math.hypot(localRight - closestRight, localFront - closestFront) < radius;
}

function surfaceToRectangle(surface) {
  if (finite(surface?.x, surface?.z, surface?.width, surface?.length)) {
    return roadSurfaceToRectangle(surface);
  }
  if (!Array.isArray(surface?.vertices) || surface.vertices.length < 3) return null;
  const xs = surface.vertices.map(vertex => vertex.x);
  const zs = surface.vertices.map(vertex => vertex.z);
  return {
    centerX: (Math.min(...xs) + Math.max(...xs)) / 2,
    centerZ: (Math.min(...zs) + Math.max(...zs)) / 2,
    rotationY: 0,
    width: Math.max(...xs) - Math.min(...xs),
    depth: Math.max(...zs) - Math.min(...zs),
  };
}

function bridgeRectangle(bridge) {
  if (finite(bridge?.x, bridge?.z, bridge?.angle, bridge?.halfWidth, bridge?.halfLength)) {
    return bridgeToRectangle(bridge);
  }
  if (!bridge?.start || !bridge?.end || !Number.isFinite(bridge.width)) return null;
  return {
    centerX: (bridge.start.x + bridge.end.x) / 2,
    centerZ: (bridge.start.z + bridge.end.z) / 2,
    rotationY: Math.atan2(bridge.end.x - bridge.start.x, bridge.end.z - bridge.start.z),
    width: bridge.width,
    depth: Math.hypot(bridge.end.x - bridge.start.x, bridge.end.z - bridge.start.z),
  };
}

function nearestTown(x, z, towns) {
  return towns.reduce((nearest, town) => {
    const distance = Math.hypot(x - town.x, z - town.z);
    return !nearest || distance < nearest.distance ? { town, distance } : nearest;
  }, null)?.town ?? null;
}

function candidateAllowedForType(candidate, type, townType) {
  const allowedContexts = new Set([
    ...TYPE_CONTEXTS[type],
    ...(RURAL_CONTEXTS[type] ?? []),
  ]);
  if (!allowedContexts.has(candidate.placementContext)) return false;
  if (candidate.placementContext !== SETTLEMENT_LIFE_DETAIL_CONTEXTS.CIVIC_SPACE) return true;
  return CIVIC_ALLOWED_TYPES[townType]?.has(type) ?? false;
}

function orderedContexts(type, town, occurrence) {
  let contexts = town.settlementType === 'RURAL' ? RURAL_CONTEXTS[type] : TYPE_CONTEXTS[type];
  if (town.type === 'military') {
    const militaryFirst = type === 'fence' || type === 'parkedCar' || type === 'roadSign';
    if (militaryFirst) {
      contexts = Object.freeze([
        SETTLEMENT_LIFE_DETAIL_CONTEXTS.MILITARY_EDGE,
        ...contexts.filter(context => context !== SETTLEMENT_LIFE_DETAIL_CONTEXTS.MILITARY_EDGE),
      ]);
    }
  }
  const offset = occurrence % contexts.length;
  return [...contexts.slice(offset), ...contexts.slice(0, offset)];
}

function orientationFor(type, candidate) {
  const towardAngle = Number.isFinite(candidate.towardX) && Number.isFinite(candidate.towardZ)
    ? Math.atan2(candidate.towardX - candidate.x, candidate.towardZ - candidate.z)
    : candidate.baseAngle;
  const tangentAngle = finite(candidate.tangentX, candidate.tangentZ)
    ? Math.atan2(candidate.tangentX, candidate.tangentZ)
    : candidate.baseAngle;
  if (type === 'bench') return { angle: towardAngle, rule: 'FACE_ACTIVITY_CENTER' };
  if (type === 'parkedCar') return { angle: tangentAngle, rule: 'PARALLEL_TO_ROAD_TANGENT' };
  if (type === 'roadSign') return { angle: tangentAngle, rule: 'ALIGN_TO_ROAD_DIRECTION' };
  if (type === 'streetLamp') return { angle: towardAngle, rule: 'FACE_ROAD_OR_SPACE' };
  if (type === 'planter') return { angle: towardAngle, rule: 'FACE_ENTRANCE_OR_SPACE' };
  if (type === 'fence') return { angle: tangentAngle, rule: 'PARALLEL_TO_BOUNDARY' };
  if (type === 'vendingMachine') return { angle: towardAngle, rule: 'FACE_PUBLIC_APPROACH' };
  return { angle: candidate.baseAngle, rule: 'CONTEXT_DEFAULT' };
}

function makeCandidateCollector(towns) {
  const candidatesByTown = new Map(towns.map((town, index) => [town.type, {
    town,
    townId: townId(town, index),
    candidates: [],
  }]));
  let sequence = 0;
  const add = (townType, candidate) => {
    const group = candidatesByTown.get(townType);
    if (!group || !finite(candidate.x, candidate.z, candidate.baseAngle)) return;
    group.candidates.push(Object.freeze({
      candidateId: `life-candidate-${String(sequence++).padStart(5, '0')}`,
      relatedTownType: townType,
      ...candidate,
    }));
  };
  return { candidatesByTown, add };
}

function addCivicCandidates(add, civicSpaces) {
  for (const civicSpace of civicSpaces.filter(space => space.status === CIVIC_SPACE_STATUS.ACTIVE)) {
    const basis = axes(civicSpace.rotationY);
    const sides = [
      { name: 'front', axisX: basis.frontX, axisZ: basis.frontZ, lateralX: basis.rightX, lateralZ: basis.rightZ, extent: civicSpace.depth / 2, span: civicSpace.width },
      { name: 'back', axisX: -basis.frontX, axisZ: -basis.frontZ, lateralX: basis.rightX, lateralZ: basis.rightZ, extent: civicSpace.depth / 2, span: civicSpace.width },
      { name: 'right', axisX: basis.rightX, axisZ: basis.rightZ, lateralX: basis.frontX, lateralZ: basis.frontZ, extent: civicSpace.width / 2, span: civicSpace.depth },
      { name: 'left', axisX: -basis.rightX, axisZ: -basis.rightZ, lateralX: basis.frontX, lateralZ: basis.frontZ, extent: civicSpace.width / 2, span: civicSpace.depth },
    ];
    for (const side of sides) {
      [-0.36, 0, 0.36].forEach((fraction, slot) => {
        const offset = side.extent + 66;
        const x = civicSpace.centerX + side.axisX * offset + side.lateralX * side.span * fraction;
        const z = civicSpace.centerZ + side.axisZ * offset + side.lateralZ * side.span * fraction;
        add(civicSpace.townType, {
          x, z,
          baseAngle: Math.atan2(side.axisX, side.axisZ),
          tangentX: side.lateralX,
          tangentZ: side.lateralZ,
          towardX: civicSpace.centerX,
          towardZ: civicSpace.centerZ,
          placementContext: SETTLEMENT_LIFE_DETAIL_CONTEXTS.CIVIC_SPACE,
          relatedRoadId: civicSpace.accessRoadId,
          relatedBuildingIndex: null,
          relatedCivicSpaceId: civicSpace.civicSpaceId,
          sourceGroupId: `civic-${civicSpace.civicSpaceId}-${side.name}-${Math.floor(slot / 2)}`,
        });
      });
    }
  }
}

function addBuildingEntranceCandidates(add, towns, buildingLots) {
  for (const lot of buildingLots.filter(candidate => candidate.lotStatus === LOT_STATUS.ACTIVE)) {
    const town = nearestTown(lot.centerX, lot.centerZ, towns);
    if (!town) continue;
    const basis = axes(lot.rotationY);
    const specs = [
      { front: lot.depth / 2 + 54, side: lot.width * 0.34 + 42 },
      { front: lot.depth / 2 + 54, side: -(lot.width * 0.34 + 42) },
      { front: lot.depth * 0.20, side: lot.width / 2 + 62 },
      { front: lot.depth * 0.20, side: -(lot.width / 2 + 62) },
    ];
    specs.forEach((spec, slot) => {
      add(town.type, {
        x: lot.centerX + basis.frontX * spec.front + basis.rightX * spec.side,
        z: lot.centerZ + basis.frontZ * spec.front + basis.rightZ * spec.side,
        baseAngle: lot.rotationY,
        tangentX: basis.rightX,
        tangentZ: basis.rightZ,
        towardX: lot.entranceX,
        towardZ: lot.entranceZ,
        placementContext: SETTLEMENT_LIFE_DETAIL_CONTEXTS.BUILDING_ENTRANCE,
        relatedRoadId: lot.frontageRoadId,
        relatedBuildingIndex: lot.buildingIndex,
        relatedCivicSpaceId: null,
        sourceGroupId: `entrance-${lot.lotId}-${Math.floor(slot / 2)}`,
      });
    });
  }
}

function addParkCandidates(add, towns, parkZones) {
  for (const park of parkZones) {
    const town = park.tc ?? nearestTown(park.x, park.z, towns);
    if (!town) continue;
    for (let slot = 0; slot < 16; slot++) {
      const angle = slot / 16 * Math.PI * 2;
      const radialX = Math.sin(angle);
      const radialZ = Math.cos(angle);
      add(town.type, {
        x: park.x + radialX * (park.radius + 72),
        z: park.z + radialZ * (park.radius + 72),
        baseAngle: angle,
        tangentX: Math.cos(angle),
        tangentZ: -Math.sin(angle),
        towardX: park.x,
        towardZ: park.z,
        placementContext: SETTLEMENT_LIFE_DETAIL_CONTEXTS.PARK_EDGE,
        relatedRoadId: null,
        relatedBuildingIndex: null,
        relatedCivicSpaceId: null,
        sourceGroupId: `park-${town.type}-${Math.floor(slot / 2)}`,
      });
    }
  }
}

function sampleBelongsToTown(sample, town, id) {
  return sample.tc === town || sample.tc?.type === town.type || sample.townId === id;
}

function addRoadCandidates(add, towns, pathSamples, roads) {
  const roadIds = new Set(roads.map(road => road.roadId));
  towns.forEach((town, townIndex) => {
    const id = townId(town, townIndex);
    const samples = pathSamples.filter(sample => (
      sampleBelongsToTown(sample, town, id)
      && roadIds.has(sample.roadId)
      && (sample.kind === ROAD_KINDS.MAJOR || sample.kind === ROAD_KINDS.LOCAL)
      && Math.hypot(sample.x - town.x, sample.z - town.z) <= town.radius * 0.92
    ));
    samples.forEach((sample, sampleIndex) => {
      const normalX = Number.isFinite(sample.normalX) ? sample.normalX : -sample.tangentZ;
      const normalZ = Number.isFinite(sample.normalZ) ? sample.normalZ : sample.tangentX;
      for (const side of [-1, 1]) {
        const offset = sample.width / 2 + 72;
        add(town.type, {
          x: sample.x + normalX * side * offset,
          z: sample.z + normalZ * side * offset,
          baseAngle: Math.atan2(sample.tangentX, sample.tangentZ),
          tangentX: sample.tangentX,
          tangentZ: sample.tangentZ,
          towardX: sample.x,
          towardZ: sample.z,
          placementContext: sample.kind === ROAD_KINDS.MAJOR
            ? SETTLEMENT_LIFE_DETAIL_CONTEXTS.MAJOR_ROAD
            : SETTLEMENT_LIFE_DETAIL_CONTEXTS.LOCAL_ROAD,
          relatedRoadId: sample.roadId,
          relatedBuildingIndex: null,
          relatedCivicSpaceId: null,
          sourceGroupId: `road-${sample.roadId}-${Math.floor(sampleIndex / 2)}`,
        });
      }
    });
  });
}

function addIntersectionCandidates(add, towns, junctions) {
  for (const junction of junctions) {
    const town = nearestTown(junction.x, junction.z, towns);
    if (!town || Math.hypot(junction.x - town.x, junction.z - town.z) > town.radius) continue;
    for (let slot = 0; slot < 8; slot++) {
      const angle = (slot + 0.5) / 8 * Math.PI * 2;
      const radius = (junction.width ?? 64) / 2 + 92;
      add(town.type, {
        x: junction.x + Math.sin(angle) * radius,
        z: junction.z + Math.cos(angle) * radius,
        baseAngle: angle,
        tangentX: Math.cos(angle),
        tangentZ: -Math.sin(angle),
        towardX: junction.x,
        towardZ: junction.z,
        placementContext: SETTLEMENT_LIFE_DETAIL_CONTEXTS.INTERSECTION,
        relatedRoadId: junction.parentRoadId ?? junction.roadIds?.[0] ?? null,
        relatedBuildingIndex: null,
        relatedCivicSpaceId: null,
        sourceGroupId: `junction-${junction.junctionId}-${Math.floor(slot / 2)}`,
      });
    }
  }
}

function addRuralEdgeCandidates(add, towns) {
  for (const town of towns.filter(candidate => candidate.settlementType === 'RURAL')) {
    for (let slot = 0; slot < 32; slot++) {
      const angle = slot / 32 * Math.PI * 2;
      const distance = town.radius * (0.58 + (slot % 3) * 0.035);
      add(town.type, {
        x: town.x + Math.sin(angle) * distance,
        z: town.z + Math.cos(angle) * distance,
        baseAngle: angle + Math.PI / 2,
        tangentX: Math.cos(angle),
        tangentZ: -Math.sin(angle),
        towardX: town.x,
        towardZ: town.z,
        placementContext: SETTLEMENT_LIFE_DETAIL_CONTEXTS.RURAL_EDGE,
        relatedRoadId: null,
        relatedBuildingIndex: null,
        relatedCivicSpaceId: null,
        sourceGroupId: `rural-${town.type}-${Math.floor(slot / 3)}`,
      });
    }
  }
}

function addMilitaryEdgeCandidates(add, towns, militaryBaseZones) {
  const town = towns.find(candidate => candidate.type === 'military');
  if (!town || militaryBaseZones.length === 0) return;
  const base = militaryBaseZones.reduce((nearest, zone) => {
    const distance = Math.hypot(zone.x - town.x, zone.z - town.z);
    return !nearest || distance < nearest.distance ? { zone, distance } : nearest;
  }, null).zone;
  for (let slot = 0; slot < 20; slot++) {
    const angle = slot / 20 * Math.PI * 2;
    const distance = base.radius + 86;
    add(town.type, {
      x: base.x + Math.sin(angle) * distance,
      z: base.z + Math.cos(angle) * distance,
      baseAngle: angle + Math.PI / 2,
      tangentX: Math.cos(angle),
      tangentZ: -Math.sin(angle),
      towardX: base.x,
      towardZ: base.z,
      placementContext: SETTLEMENT_LIFE_DETAIL_CONTEXTS.MILITARY_EDGE,
      relatedRoadId: null,
      relatedBuildingIndex: null,
      relatedCivicSpaceId: null,
      sourceGroupId: `military-edge-${Math.floor(slot / 3)}`,
    });
  }
}

export function createSettlementLifeDetailCollisionContext({
  civicSpaces,
  buildingLots,
  parkZones,
  roadSurfaces,
  junctionSurfaces,
  bridges,
  waterZones,
  exclusionZones,
  buildingSpots,
  militaryBaseZones,
}) {
  return {
    civicBodies: civicSpaces.filter(space => space.status === CIVIC_SPACE_STATUS.ACTIVE).map(civicSpaceToBodyRectangle),
    civicAccesses: civicSpaces.filter(space => space.status === CIVIC_SPACE_STATUS.ACTIVE).map(civicSpaceToAccessRectangle).filter(Boolean),
    lots: buildingLots.filter(lot => lot.lotStatus === LOT_STATUS.ACTIVE),
    lotPaths: buildingLots.filter(lot => lot.lotStatus === LOT_STATUS.ACTIVE).flatMap(lot => [lot.pathRectangle, lot.forecourtRectangle]).filter(Boolean),
    parks: parkZones,
    roads: roadSurfaces.map(surfaceToRectangle).filter(Boolean),
    junctions: junctionSurfaces.map(surfaceToRectangle).filter(Boolean),
    bridges: bridges.map(bridgeRectangle).filter(Boolean),
    water: waterZones,
    exclusions: exclusionZones,
    buildings: buildingSpots.filter(spot => Number.isFinite(spot.radius)),
    militaryBases: militaryBaseZones,
  };
}

export function getSettlementLifeDetailCollisionReason(candidate, radius, context) {
  if (context.civicBodies.some(rectangle => circleIntersectsRectangle(candidate.x, candidate.z, radius, rectangle, 2))) return 'civicSpace';
  if (context.civicAccesses.some(rectangle => circleIntersectsRectangle(candidate.x, candidate.z, radius, rectangle, 2))) return 'civicAccess';
  if (context.roads.some(rectangle => circleIntersectsRectangle(candidate.x, candidate.z, radius, rectangle, 3))) return 'road';
  if (context.junctions.some(rectangle => circleIntersectsRectangle(candidate.x, candidate.z, radius, rectangle, 3))) return 'junction';
  if (context.bridges.some(rectangle => circleIntersectsRectangle(candidate.x, candidate.z, radius, rectangle, 4))) return 'bridge';
  if (context.water.some(zone => Math.hypot(candidate.x - zone.x, candidate.z - zone.z) < radius + zone.radius + 5)) return 'water';
  if (context.parks.some(zone => Math.hypot(candidate.x - zone.x, candidate.z - zone.z) < radius + zone.radius + 5)) return 'parkCenter';
  const exclusion = context.exclusions.find(zone => (
    Math.hypot(candidate.x - zone.x, candidate.z - zone.z) < radius + zone.radius + 5
  ));
  if (exclusion) return exclusion.type === 'militaryBase' ? 'militaryBase' : 'landmark';
  if (context.militaryBases.some(zone => Math.hypot(candidate.x - zone.x, candidate.z - zone.z) < radius + zone.radius + 5)) return 'militaryBase';
  if (context.lots.some(rectangle => circleIntersectsRectangle(candidate.x, candidate.z, radius, rectangle, 5))) return 'lot';
  if (context.lotPaths.some(rectangle => circleIntersectsRectangle(candidate.x, candidate.z, radius, rectangle, 5))) return 'entranceOrForecourt';
  if (context.buildings.some(spot => Math.hypot(candidate.x - spot.x, candidate.z - spot.z) < radius + spot.radius + 6)) return 'building';
  return null;
}

function assignClusters(placements) {
  const byGroup = new Map();
  placements.forEach((placement, index) => {
    if (!byGroup.has(placement.sourceGroupId)) byGroup.set(placement.sourceGroupId, []);
    byGroup.get(placement.sourceGroupId).push(index);
  });
  let clusterNumber = 0;
  const clusterSizes = [];
  const clusterIdByPlacement = new Map();
  for (const indices of byGroup.values()) {
    for (let start = 0; start < indices.length; start += 4) {
      const group = indices.slice(start, start + 4);
      if (group.length < 2) continue;
      const clusterId = `life-cluster-${String(clusterNumber++).padStart(3, '0')}`;
      clusterSizes.push(group.length);
      group.forEach(index => clusterIdByPlacement.set(index, clusterId));
    }
  }
  return {
    placements: placements.map((placement, index) => Object.freeze({
      ...placement,
      clusterId: clusterIdByPlacement.get(index) ?? null,
    })),
    clusterSizes: Object.freeze(clusterSizes),
  };
}

function countBy(values, keys) {
  const counts = Object.fromEntries(keys.map(key => [key, 0]));
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function getSettlementLifeDetailBaselineTypeCounts() {
  const counts = Object.fromEntries(WORLD_DETAIL_TYPES.map(type => [type, 0]));
  for (const townCounts of Object.values(SETTLEMENT_LIFE_DETAIL_TYPE_COUNTS_BY_TOWN)) {
    for (const type of WORLD_DETAIL_TYPES) counts[type] += townCounts[type];
  }
  return counts;
}

export function createSettlementLifeDetailPlacements({
  towns,
  civicSpaces = [],
  buildingLots = [],
  parkZones = [],
  roads = [],
  pathSamples = [],
  junctions = [],
  roadSurfaces = [],
  junctionSurfaces = [],
  bridges = [],
  waterZones = [],
  exclusionZones = [],
  buildingSpots = [],
  militaryBaseZones = [],
}) {
  const expectedTownTypes = Object.keys(SETTLEMENT_LIFE_DETAIL_TOWN_COUNTS);
  if (towns.length !== expectedTownTypes.length
      || expectedTownTypes.some(type => !towns.some(town => town.type === type))) {
    throw new RangeError('the approved six-town fixture is required');
  }
  const { candidatesByTown, add } = makeCandidateCollector(towns);
  addCivicCandidates(add, civicSpaces);
  addBuildingEntranceCandidates(add, towns, buildingLots);
  addParkCandidates(add, towns, parkZones);
  addRoadCandidates(add, towns, pathSamples, roads);
  addIntersectionCandidates(add, towns, junctions);
  addRuralEdgeCandidates(add, towns);
  addMilitaryEdgeCandidates(add, towns, militaryBaseZones);

  const collisionContext = createSettlementLifeDetailCollisionContext({
    civicSpaces,
    buildingLots,
    parkZones,
    roadSurfaces,
    junctionSurfaces,
    bridges,
    waterZones,
    exclusionZones,
    buildingSpots,
    militaryBaseZones,
  });
  const placements = [];
  const usedCandidateIds = new Set();
  const rejectedCandidateCounts = {};

  for (const town of towns) {
    const townGroup = candidatesByTown.get(town.type);
    const counts = SETTLEMENT_LIFE_DETAIL_TYPE_COUNTS_BY_TOWN[town.type];
    const typeOccurrences = Object.fromEntries(WORLD_DETAIL_TYPES.map(type => [type, 0]));
    const requestedTypes = WORLD_DETAIL_TYPES.flatMap(type => Array(counts[type]).fill(type));
    for (const type of requestedTypes) {
      const occurrence = typeOccurrences[type]++;
      const preferredContexts = orderedContexts(type, town, occurrence);
      const fallbackContexts = CONTEXT_VALUES.filter(context => !preferredContexts.includes(context));
      let selected = null;
      for (const placementContext of [...preferredContexts, ...fallbackContexts]) {
        for (const candidate of townGroup.candidates) {
          if (candidate.placementContext !== placementContext
              || usedCandidateIds.has(candidate.candidateId)
              || !candidateAllowedForType(candidate, type, town.type)) continue;
          const radius = SETTLEMENT_LIFE_DETAIL_PLACEMENT_RADII[type];
          const collisionReason = getSettlementLifeDetailCollisionReason(candidate, radius, collisionContext);
          if (collisionReason) {
            rejectedCandidateCounts[collisionReason] = (rejectedCandidateCounts[collisionReason] ?? 0) + 1;
            continue;
          }
          const objectConflict = placements.some(placement => (
            Math.hypot(candidate.x - placement.x, candidate.z - placement.z)
            < Math.max(
              radius + placement.placementRadius + 10,
              TINY_MINIMUM_LOT_PASSAGE,
            )
          ));
          if (objectConflict) {
            rejectedCandidateCounts.objectSpacing = (rejectedCandidateCounts.objectSpacing ?? 0) + 1;
            continue;
          }
          selected = candidate;
          break;
        }
        if (selected) break;
      }
      if (!selected) throw new RangeError(`no safe ${type} placement in ${town.type}`);
      usedCandidateIds.add(selected.candidateId);
      const orientation = orientationFor(type, selected);
      placements.push({
        type,
        x: selected.x,
        z: selected.z,
        angle: orientation.angle,
        placementRadius: SETTLEMENT_LIFE_DETAIL_PLACEMENT_RADII[type],
        placementContext: selected.placementContext,
        relatedTownType: town.type,
        relatedRoadId: selected.relatedRoadId,
        relatedBuildingIndex: selected.relatedBuildingIndex,
        relatedCivicSpaceId: selected.relatedCivicSpaceId,
        orientationRule: orientation.rule,
        sourceGroupId: selected.sourceGroupId,
      });
    }
  }

  const clustered = assignClusters(placements);
  const finalPlacements = Object.freeze(clustered.placements);
  const typeCounts = countBy(finalPlacements.map(placement => placement.type), WORLD_DETAIL_TYPES);
  const townCounts = countBy(finalPlacements.map(placement => placement.relatedTownType), expectedTownTypes);
  const contextCounts = countBy(finalPlacements.map(placement => placement.placementContext), CONTEXT_VALUES);
  const totalInstanceCount = finalPlacements.reduce(
    (sum, placement) => sum + WORLD_DETAIL_PARTS[placement.type].length,
    0,
  );
  if (finalPlacements.length !== 96 || totalInstanceCount !== 258
      || totalInstanceCount > WORLD_DETAIL_INSTANCE_CAPACITY) {
    throw new RangeError('settlement life detail totals changed');
  }
  const contextTownCounts = context => countBy(
    finalPlacements.filter(placement => placement.placementContext === context)
      .map(placement => placement.relatedTownType),
    expectedTownTypes,
  );
  const civicSpaceObjectCounts = countBy(
    finalPlacements.filter(placement => placement.relatedCivicSpaceId)
      .map(placement => placement.relatedCivicSpaceId),
    civicSpaces.map(space => space.civicSpaceId),
  );

  return Object.freeze({
    placements: finalPlacements,
    summary: Object.freeze({
      totalObjectCount: finalPlacements.length,
      totalInstanceCount,
      capacity: WORLD_DETAIL_INSTANCE_CAPACITY,
      townCounts: Object.freeze(townCounts),
      typeCounts: Object.freeze(typeCounts),
      contextCounts: Object.freeze(contextCounts),
      civicSpaceObjectCounts: Object.freeze(civicSpaceObjectCounts),
      buildingEntranceObjectCounts: Object.freeze(contextTownCounts(SETTLEMENT_LIFE_DETAIL_CONTEXTS.BUILDING_ENTRANCE)),
      parkEdgeObjectCounts: Object.freeze(contextTownCounts(SETTLEMENT_LIFE_DETAIL_CONTEXTS.PARK_EDGE)),
      intersectionObjectCounts: Object.freeze(contextTownCounts(SETTLEMENT_LIFE_DETAIL_CONTEXTS.INTERSECTION)),
      ruralEdgeObjectCounts: Object.freeze(contextTownCounts(SETTLEMENT_LIFE_DETAIL_CONTEXTS.RURAL_EDGE)),
      militaryEdgeObjectCounts: Object.freeze(contextTownCounts(SETTLEMENT_LIFE_DETAIL_CONTEXTS.MILITARY_EDGE)),
      clusterCount: clustered.clusterSizes.length,
      clusterSizes: clustered.clusterSizes,
      rejectedCandidateCounts: Object.freeze({ ...rejectedCandidateCounts }),
    }),
  });
}
