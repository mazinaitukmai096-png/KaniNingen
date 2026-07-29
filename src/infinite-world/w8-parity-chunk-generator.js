import {
  LOGICAL_CHUNK_SIZE_METERS,
  createChunkKey,
  decomposeLogicalWorldPosition,
  squareChunkCoordinates,
} from './chunk-coordinates.js';
import {
  CAM_INITIAL_DIST,
  INTRO_DURATION_MS,
  PLAYER_RADIUS,
  PLAYER_SPEED,
} from '../constants.js';
import { orientedRectanglesOverlap } from '../building-lot.js';
import {
  W5_CHUNK_DATA_SCHEMA,
  createDistributedSettlementChunkGenerator,
} from './distributed-settlement-chunk-generator.js';
import { W5_SETTLEMENT_DISTRIBUTION } from './settlement-distributor.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { createChunkId } from './legacy-core/g0/chunk-id.js';
import { createWorldFeatureId } from './legacy-core/g0/stable-id.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { parseGeneratorVersion } from './legacy-core/g0/generator-version.js';
import { G2_C_WORLD_FEATURES } from './legacy-core/g2/world-chunk-generator.js';
import { sampleFormalTerrainHeightMeters } from './player-vertical-movement.js';
import {
  FINITE_WORLD_UNITS_PER_METER,
  MIGRATED_SETTLEMENT_PROFILES,
} from './single-rural-settlement.js';
import { createW8NaturalPresentationPhase1Policy } from './w8-natural-presentation-policy.js';
import {
  composeW8SettlementPresentationTemplate,
  createW8SettlementParityOverlay,
} from './w8-settlement-parity-overlay.js';
import {
  createSettlementSurfacePolicy,
  sampleW8SurfaceHeightMeters,
} from './w8-surface-policy.js';
import {
  createCanonicalRiverProjection,
  distanceToCanonicalRiverCenterline,
} from './canonical-river-realization.js';
import { W8_SETTLEMENT_ROLE_LANDMARKS } from './settlement-presentation-policy.js';
import {
  W8_CANONICAL_MAJOR_ROAD,
  createCanonicalMajorRoadCacheKey,
  createCanonicalMajorRoadNetwork,
  createCanonicalMajorRoadObstacles,
  graphEdgesPotentiallyIntersectChunk,
  projectCanonicalMajorRoadsToChunk,
} from './canonical-major-road-network.js';

export { sampleW8SurfaceHeightMeters } from './w8-surface-policy.js';

export const W8_PARITY_GENERATOR_VERSION = parseGeneratorVersion('800.0.0');
export const W8_PARITY_CHUNK_DATA_SCHEMA = 'w8-finite-experience-parity-chunk-data-1';
export const W8_PARITY_CONTENT = Object.freeze({
  schemaVersion: 'w8-finite-experience-content-1',
  ambientCellSizeMeters: 2,
  maximumAmbientDetailsPerChunk: 48,
  maximumWaterSurfacesPerChunk: 24,
  wetlandMoistureThreshold: 0.64,
  streetSlotsPerRoadProjection: 2,
  landmarkByTownType: Object.freeze(Object.fromEntries(
    Object.entries(W8_SETTLEMENT_ROLE_LANDMARKS)
      .map(([townType, descriptor]) => [townType, descriptor.landmarkType]),
  )),
});
const EXPERIENCE_SPAWN_CACHE = new Map();
const PROTECTED_SAFE_SPAWN_BOOTSTRAP = Object.freeze({
  worldSeedHash: 'sha256:0ee3540b10572232690cdefc6ee897c8a3a59ffe3ad582617ef0d1c80696c24d',
  x: 549.75,
  z: 431.25,
  pondStableId: 'wf1:water-surface:0fdcd2fc660122cf5e89d7a3f0d5c855',
});
export const W8_SPAWN_SAFETY_CONTRACT = Object.freeze({
  schemaVersion: 'w8-spawn-safety-contract-1',
  preparedDataRadiusChunks: 2,
  preferredPondDistanceMeters: 16,
  headingSampleCount: 32,
  introPathSampleCount: 72,
  playerClearanceMeters: PLAYER_RADIUS * 2 / FINITE_WORLD_UNITS_PER_METER,
  cameraClearanceMeters: 0.6,
  roadClearanceMeters: PLAYER_RADIUS / FINITE_WORLD_UNITS_PER_METER,
  introDistanceMeters: PLAYER_SPEED / FINITE_WORLD_UNITS_PER_METER
    * 60 * 0.35 * (INTRO_DURATION_MS / 1000),
});

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

function roadRectangle(road) {
  const dx = road.end.x - road.start.x;
  const dz = road.end.z - road.start.z;
  return {
    centerX: (road.start.x + road.end.x) / 2,
    centerZ: (road.start.z + road.end.z) / 2,
    rotationY: Math.atan2(dx, dz),
    width: road.widthMeters,
    depth: Math.hypot(dx, dz),
  };
}

export function roadIntersectsSettlementBuilding(road, building) {
  if (road.featureType !== 'settlement-road'
    || building.featureType !== 'settlement-building') return false;
  if (building.frontageRoadId === road.sourceRoadId) return false;
  return orientedRectanglesOverlap(roadRectangle(road), {
    centerX: building.x ?? building.worldPosition.x,
    centerZ: building.z ?? building.worldPosition.z,
    rotationY: building.rotationY,
    width: building.widthMeters,
    depth: building.depthMeters,
  });
}

function mix32(value) {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
}

function textSeed(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return mix32(hash);
}

function unit(seed, x, z, salt) {
  return mix32(seed ^ Math.imul(x | 0, 0x1f123bb5)
    ^ Math.imul(z | 0, 0x5f356495) ^ Math.imul(salt, 0x9e3779b9)) / 0xffffffff;
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - start.x, point.z - start.z);
  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared));
  return Math.hypot(point.x - start.x - dx * t, point.z - start.z - dz * t);
}

function circleIntersectsRotatedRectangle(point, radius, rectangle) {
  const cosine = Math.cos(-(rectangle.rotationY ?? 0));
  const sine = Math.sin(-(rectangle.rotationY ?? 0));
  const dx = point.x - rectangle.x;
  const dz = point.z - rectangle.z;
  const localX = dx * cosine - dz * sine;
  const localZ = dx * sine + dz * cosine;
  const nearestX = Math.max(-rectangle.width / 2, Math.min(rectangle.width / 2, localX));
  const nearestZ = Math.max(-rectangle.depth / 2, Math.min(rectangle.depth / 2, localZ));
  return (localX - nearestX) ** 2 + (localZ - nearestZ) ** 2 <= radius ** 2;
}

function pointToRotatedRectangleDistance(point, rectangle) {
  const cosine = Math.cos(-(rectangle.rotationY ?? 0));
  const sine = Math.sin(-(rectangle.rotationY ?? 0));
  const dx = point.x - rectangle.x;
  const dz = point.z - rectangle.z;
  const localX = dx * cosine - dz * sine;
  const localZ = dx * sine + dz * cosine;
  return Math.hypot(
    Math.max(Math.abs(localX) - rectangle.width / 2, 0),
    Math.max(Math.abs(localZ) - rectangle.depth / 2, 0),
  );
}

function normalizedAngle(value) {
  let result = value % (Math.PI * 2);
  if (result <= -Math.PI) result += Math.PI * 2;
  if (result > Math.PI) result -= Math.PI * 2;
  return result;
}

function createSpawnObstacleModel(sourceChunks, settlementLandmarks = []) {
  const rectangles = [];
  const cameraRectangles = [];
  const roads = [];
  const seen = new Set();
  const addRectangle = rectangle => {
    const key = `${rectangle.obstacleType}:${rectangle.stableId}`;
    if (seen.has(key)) return;
    seen.add(key);
    rectangles.push(Object.freeze(rectangle));
    if (rectangle.cameraCollision) cameraRectangles.push(rectangles.at(-1));
  };
  for (const chunk of sourceChunks) {
    for (const feature of chunk.settlementFeatures ?? []) {
      if (feature.featureType === 'settlement-road') {
        if (!seen.has(`road:${feature.stableId}`)) {
          seen.add(`road:${feature.stableId}`);
          roads.push(feature);
        }
        continue;
      }
      if (feature.featureType !== 'settlement-building') continue;
      addRectangle({
        stableId: feature.stableId,
        obstacleType: 'building',
        x: feature.worldPosition.x,
        z: feature.worldPosition.z,
        width: feature.widthMeters,
        depth: feature.depthMeters,
        rotationY: feature.rotationY,
        cameraCollision: true,
      });
      const lot = feature.lot;
      if (!lot) continue;
      addRectangle({
        stableId: `${feature.stableId}:lot`,
        obstacleType: 'lot',
        x: lot.centerX,
        z: lot.centerZ,
        width: lot.widthMeters,
        depth: lot.depthMeters,
        rotationY: feature.rotationY,
        cameraCollision: false,
      });
      for (const [surfaceType, surface] of [['lot-path', lot.path], ['lot-forecourt', lot.forecourt]]) {
        if (!surface) continue;
        addRectangle({
          stableId: `${feature.stableId}:${surfaceType}`,
          obstacleType: surfaceType,
          x: surface.centerX,
          z: surface.centerZ,
          width: surface.width,
          depth: surface.depth,
          rotationY: surface.rotationY,
          cameraCollision: false,
        });
      }
    }
  }
  for (const landmark of settlementLandmarks) {
    addRectangle({
      stableId: landmark.stableId,
      obstacleType: 'landmark',
      x: landmark.worldPosition.x,
      z: landmark.worldPosition.z,
      width: landmark.widthMeters,
      depth: landmark.depthMeters,
      rotationY: landmark.rotationY,
      cameraCollision: true,
    });
  }
  return Object.freeze({
    rectangles: Object.freeze(rectangles),
    cameraRectangles: Object.freeze(cameraRectangles),
    roads: Object.freeze(roads),
  });
}

function roadDistance(point, road) {
  return distanceToSegment(point, road.start, road.end) - road.widthMeters / 2;
}

function minimumRectangleDistance(point, rectangles) {
  let minimum = 999;
  for (const rectangle of rectangles) {
    minimum = Math.min(minimum, pointToRotatedRectangleDistance(point, rectangle));
  }
  return minimum;
}

function evaluateIntroHeading(point, facingY, obstacles) {
  const contract = W8_SPAWN_SAFETY_CONTRACT;
  const cameraYaw = normalizedAngle(facingY - Math.PI);
  const directionX = Math.sin(facingY);
  const directionZ = Math.cos(facingY);
  const normalCameraDistance = CAM_INITIAL_DIST / FINITE_WORLD_UNITS_PER_METER * Math.cos(0.45);
  let minimumPlayerClearanceMeters = 999;
  let minimumCameraClearanceMeters = 999;
  for (let sample = 0; sample <= contract.introPathSampleCount; sample += 1) {
    const introT = sample / contract.introPathSampleCount;
    const player = {
      x: point.x + directionX * contract.introDistanceMeters * introT,
      z: point.z + directionZ * contract.introDistanceMeters * introT,
    };
    minimumPlayerClearanceMeters = Math.min(
      minimumPlayerClearanceMeters,
      minimumRectangleDistance(player, obstacles.rectangles),
    );
    if (minimumPlayerClearanceMeters < contract.playerClearanceMeters) return null;

    const panT = Math.min(1, introT / 0.15);
    const eased = introT < 0.3 ? 0 : ((introT - 0.3) / 0.7) ** 2;
    const trackX = (150 + 50 * Math.sin(panT * Math.PI / 2)) / FINITE_WORLD_UNITS_PER_METER;
    const trackZ = (300 + 80 * Math.sin(panT * Math.PI / 2)) / FINITE_WORLD_UNITS_PER_METER;
    const trackCamera = {
      x: player.x + trackX * Math.cos(facingY) + trackZ * Math.sin(facingY),
      z: player.z - trackX * Math.sin(facingY) + trackZ * Math.cos(facingY),
    };
    const targetCamera = {
      x: player.x + Math.sin(cameraYaw) * normalCameraDistance,
      z: player.z + Math.cos(cameraYaw) * normalCameraDistance,
    };
    const camera = {
      x: trackCamera.x + (targetCamera.x - trackCamera.x) * eased,
      z: trackCamera.z + (targetCamera.z - trackCamera.z) * eased,
    };
    minimumCameraClearanceMeters = Math.min(
      minimumCameraClearanceMeters,
      minimumRectangleDistance(camera, obstacles.cameraRectangles),
    );
    if (minimumCameraClearanceMeters < contract.cameraClearanceMeters) return null;
  }
  return Object.freeze({
    facingY: q6(facingY),
    cameraYaw: q6(cameraYaw),
    minimumPlayerClearanceMeters: q6(minimumPlayerClearanceMeters),
    minimumCameraClearanceMeters: q6(minimumCameraClearanceMeters),
  });
}

export function selectSafeExperienceSpawn({
  reviewSpawn,
  waterSurfaces,
  sourceChunks,
  settlementLandmarks = [],
} = {}) {
  if (!reviewSpawn || !Array.isArray(waterSurfaces) || !Array.isArray(sourceChunks)) {
    throw new TypeError('reviewSpawn, waterSurfaces, and sourceChunks are required');
  }
  const contract = W8_SPAWN_SAFETY_CONTRACT;
  const obstacles = createSpawnObstacleModel(sourceChunks, settlementLandmarks);
  const candidates = [];
  for (const surface of waterSurfaces) {
    const point = surface.worldPosition;
    const pointObstacleIds = obstacles.rectangles
      .filter(rectangle => pointToRotatedRectangleDistance(point, rectangle)
        < contract.playerClearanceMeters)
      .map(rectangle => rectangle.stableId);
    const pointRoadIds = obstacles.roads
      .filter(road => roadDistance(point, road) < contract.roadClearanceMeters)
      .map(road => road.stableId);
    if (pointObstacleIds.length || pointRoadIds.length) continue;
    let bestHeading = null;
    for (let index = 0; index < contract.headingSampleCount; index += 1) {
      const facingY = -Math.PI + index * Math.PI * 2 / contract.headingSampleCount;
      const heading = evaluateIntroHeading(point, facingY, obstacles);
      if (!heading) continue;
      const headingClearance = Math.min(
        heading.minimumPlayerClearanceMeters,
        heading.minimumCameraClearanceMeters,
      );
      const bestClearance = bestHeading ? Math.min(
        bestHeading.minimumPlayerClearanceMeters,
        bestHeading.minimumCameraClearanceMeters,
      ) : -1;
      if (!bestHeading || headingClearance > bestClearance
        || (headingClearance === bestClearance && heading.facingY < bestHeading.facingY)) {
        bestHeading = heading;
      }
    }
    if (!bestHeading) continue;
    candidates.push({
      surface,
      heading: bestHeading,
      reviewDistanceMeters: Math.hypot(point.x - reviewSpawn.x, point.z - reviewSpawn.z),
      safetyClearanceMeters: Math.min(
        bestHeading.minimumPlayerClearanceMeters,
        bestHeading.minimumCameraClearanceMeters,
      ),
    });
  }
  const preferred = candidates.filter(candidate =>
    candidate.reviewDistanceMeters <= contract.preferredPondDistanceMeters);
  const selectionPool = preferred.length ? preferred : candidates;
  selectionPool.sort((left, right) =>
    right.safetyClearanceMeters - left.safetyClearanceMeters
    || left.reviewDistanceMeters - right.reviewDistanceMeters
    || left.surface.stableId.localeCompare(right.surface.stableId)
    || left.heading.facingY - right.heading.facingY);
  const selected = selectionPool[0];
  if (!selected) return null;
  return Object.freeze({
    x: selected.surface.worldPosition.x,
    z: selected.surface.worldPosition.z,
    y: selected.surface.worldPosition.y,
    facingY: selected.heading.facingY,
    cameraYaw: selected.heading.cameraYaw,
    pondStableId: selected.surface.stableId,
    settlementId: reviewSpawn.settlementId,
    spawnSafety: Object.freeze({
      schemaVersion: 'w8-safe-experience-spawn-1',
      safe: true,
      reviewDistanceMeters: q6(selected.reviewDistanceMeters),
      playerClearanceMeters: contract.playerClearanceMeters,
      cameraClearanceMeters: contract.cameraClearanceMeters,
      minimumPlayerClearanceMeters: selected.heading.minimumPlayerClearanceMeters,
      minimumCameraClearanceMeters: selected.heading.minimumCameraClearanceMeters,
      buildingLotLandmarkIntersections: Object.freeze([]),
      roadIntersections: Object.freeze([]),
      waterSurfaceIntersections: Object.freeze([selected.surface.stableId]),
      introPathClear: true,
      introCameraPathClear: true,
    }),
  });
}

function conflictsWithSettlement(point, chunk, clearance = 1.5) {
  for (const feature of chunk.settlementFeatures ?? []) {
    if (feature.featureType === 'settlement-road') {
      if (distanceToSegment(point, feature.start, feature.end) <= feature.widthMeters / 2 + clearance) return true;
    } else if (feature.featureType === 'settlement-building') {
      const radius = Math.hypot(feature.widthMeters, feature.depthMeters) / 2 + clearance;
      if (Math.hypot(point.x - feature.worldPosition.x, point.z - feature.worldPosition.z) <= radius) return true;
      const lot = feature.lot;
      if (lot && circleIntersectsRotatedRectangle(point, clearance, {
        x: lot.centerX, z: lot.centerZ, width: lot.widthMeters, depth: lot.depthMeters,
        rotationY: feature.rotationY,
      })) return true;
      for (const surface of [lot?.path, lot?.forecourt]) {
        if (surface && circleIntersectsRotatedRectangle(point, clearance, {
          x: surface.centerX, z: surface.centerZ, width: surface.width, depth: surface.depth,
          rotationY: surface.rotationY,
        })) return true;
      }
    }
  }
  return false;
}

function conflictsWithPresentation(point, radius, chunk, {
  waterSurfaces, settlementLandmarks, experienceSpawn,
}) {
  if (conflictsWithSettlement(point, chunk, radius + 2.25)) return true;
  for (const surface of waterSurfaces) {
    if (surface.waterType === 'river' && Array.isArray(surface.centerlines)) {
      const intersectsRiver = surface.centerlines.some(line => line.slice(1).some(
        (end, index) => distanceToSegment(point, line[index], end)
          <= surface.widthMeters / 2 + radius + 0.75,
      ));
      if (intersectsRiver) return true;
      continue;
    }
    if (circleIntersectsRotatedRectangle(point, radius + 0.75, {
      x: surface.worldPosition.x,
      z: surface.worldPosition.z,
      width: surface.widthMeters,
      depth: surface.depthMeters,
      rotationY: 0,
    })) return true;
  }
  for (const landmark of settlementLandmarks) {
    if (circleIntersectsRotatedRectangle(point, radius + 1.5, {
      x: landmark.worldPosition.x,
      z: landmark.worldPosition.z,
      width: landmark.widthMeters,
      depth: landmark.depthMeters,
      rotationY: landmark.rotationY,
    })) return true;
  }
  if (experienceSpawn) {
    const corridorEnd = {
      x: experienceSpawn.x + Math.sin(experienceSpawn.facingY)
        * W8_SPAWN_SAFETY_CONTRACT.introDistanceMeters,
      z: experienceSpawn.z + Math.cos(experienceSpawn.facingY)
        * W8_SPAWN_SAFETY_CONTRACT.introDistanceMeters,
    };
    // The finite intro camera travels up to about 11m beside/ahead of the Crab.
    if (distanceToSegment(point, experienceSpawn, corridorEnd) <= radius + 12) return true;
  }
  return false;
}

function createPresentationLayers(chunk, overlays, experienceSpawn, naturalPresentationPolicy) {
  const compatibleVegetation = (chunk.vegetationCandidates ?? []).filter(candidate => !conflictsWithPresentation(
    candidate.worldPosition,
    candidate.metadata?.candidateRadiusMeters ?? 0.625,
    chunk,
    { ...overlays, experienceSpawn },
  ));
  const vegetation = naturalPresentationPolicy.selectVegetation({
    candidates: compatibleVegetation,
    settlementReferences: chunk.settlementReferences,
    experienceSpawn,
    introDistanceMeters: W8_SPAWN_SAFETY_CONTRACT.introDistanceMeters,
  });
  const rocks = (chunk.rockCandidates ?? []).filter(candidate => !conflictsWithPresentation(
    candidate.worldPosition,
    candidate.metadata?.candidateRadiusMeters ?? 0.45,
    chunk,
    { ...overlays, experienceSpawn },
  ));
  return Object.freeze({
    schemaVersion: 'w8-presentation-layers-1',
    integrationOrder: Object.freeze([
      'terrain', 'roads', 'intersections', 'lots', 'buildings', 'water',
      'landmarks', 'street-details', 'natural', 'ambient-details',
    ]),
    heightSource: Object.freeze({
      schemaVersion: chunk.terrain.schemaVersion,
      sourceW5ContentHash: chunk.contentHash,
      heightUnitMeters: chunk.terrain.heightUnitMeters,
      verticalScale: 1,
    }),
    formal: Object.freeze({
      roadsAndBuildings: chunk.settlementFeatures,
      settlementReferences: chunk.settlementReferences,
    }),
    water: Object.freeze(overlays.waterSurfaces),
    landmarks: Object.freeze(overlays.settlementLandmarks),
    streetDetails: Object.freeze(overlays.streetDetails),
    natural: Object.freeze({
      vegetation: Object.freeze(vegetation),
      rocks: Object.freeze(rocks),
      excludedVegetationCount: (chunk.vegetationCandidates?.length ?? 0) - vegetation.length,
      excludedRockCount: (chunk.rockCandidates?.length ?? 0) - rocks.length,
    }),
    ambientDetails: Object.freeze(overlays.ambientDetails),
  });
}

function terrainSample(chunk, localX, localZ) {
  const terrain = chunk.terrain;
  const width = terrain.resolution.x;
  const depth = terrain.resolution.z;
  const x = Math.max(0, Math.min(width - 1,
    Math.round(localX / LOGICAL_CHUNK_SIZE_METERS * (width - 1))));
  const z = Math.max(0, Math.min(depth - 1,
    Math.round(localZ / LOGICAL_CHUNK_SIZE_METERS * (depth - 1))));
  const index = z * width + x;
  return Object.freeze({
    height: terrain.heights[index] * terrain.heightUnitMeters,
    moisture: terrain.moisture?.[index] ?? 0,
  });
}

function clampPointToChunk(chunk, point, margin = 0.001) {
  const minX = chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS + margin;
  const minZ = chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS + margin;
  return Object.freeze({
    x: q6(Math.max(minX, Math.min(minX + LOGICAL_CHUNK_SIZE_METERS - margin * 2, point.x))),
    z: q6(Math.max(minZ, Math.min(minZ + LOGICAL_CHUNK_SIZE_METERS - margin * 2, point.z))),
  });
}

async function stableFeatureId({ worldSeedHash, featureType, parentStableId = '', purposeKey, semanticLocalKey }) {
  return (await createWorldFeatureId({
    stableIdSchema: 'wf1',
    worldSeedHash,
    generatorMajor: W8_PARITY_GENERATOR_VERSION.major,
    featureType,
    parentStableId,
    purposeKey,
    semanticLocalKey,
  })).stableId;
}

async function createAmbientDetails(chunk, seed, worldSeedHash) {
  const details = [];
  const size = W8_PARITY_CONTENT.ambientCellSizeMeters;
  const cellsPerChunk = Math.round(LOGICAL_CHUNK_SIZE_METERS / size);
  const startCellX = chunk.chunkX * cellsPerChunk;
  const startCellZ = chunk.chunkZ * cellsPerChunk;
  for (let localZ = 0; localZ < cellsPerChunk; localZ += 1) {
    for (let localX = 0; localX < cellsPerChunk; localX += 1) {
      const cellX = startCellX + localX;
      const cellZ = startCellZ + localZ;
      const roll = unit(seed, cellX, cellZ, 1);
      if (roll > 0.72) continue;
      const x = q6((cellX + 0.5 + (unit(seed, cellX, cellZ, 2) - 0.5) * 0.58) * size);
      const z = q6((cellZ + 0.5 + (unit(seed, cellX, cellZ, 3) - 0.5) * 0.58) * size);
      if (conflictsWithSettlement({ x, z }, chunk)) continue;
      const localPointX = x - chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS;
      const localPointZ = z - chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
      const terrain = terrainSample(chunk, localPointX, localPointZ);
      const typeRoll = unit(seed, cellX, cellZ, 4);
      const detailType = typeRoll < 0.66 ? 'grass' : typeRoll < 0.88 ? 'flower' : 'shrub';
      const stableId = await stableFeatureId({
        worldSeedHash,
        featureType: 'ambient-detail',
        parentStableId: chunk.chunkId,
        purposeKey: detailType,
        semanticLocalKey: `${cellX}:${cellZ}:slot-0`,
      });
      details.push(Object.freeze({
        schemaVersion: 'w8-ambient-detail-1',
        stableId,
        detailType,
        worldPosition: Object.freeze({ x, y: q6(terrain.height), z }),
        rotationY: q6(unit(seed, cellX, cellZ, 5) * Math.PI * 2),
        variation: q6(0.72 + unit(seed, cellX, cellZ, 6) * 0.56),
        destructible: true,
        owningChunkCoordinate: Object.freeze({ x: chunk.chunkX, z: chunk.chunkZ }),
      }));
    }
  }
  return details.sort((a, b) => a.stableId.localeCompare(b.stableId))
    .slice(0, W8_PARITY_CONTENT.maximumAmbientDetailsPerChunk);
}

async function createWaterSurfaces(chunk, worldSeedHash) {
  const surfaces = [];
  const terrain = chunk.terrain;
  const width = terrain.resolution.x;
  const depth = terrain.resolution.z;
  const cellWidth = LOGICAL_CHUNK_SIZE_METERS / (width - 1);
  const cellDepth = LOGICAL_CHUNK_SIZE_METERS / (depth - 1);
  for (let z = 0; z < depth - 1; z += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const indices = [z * width + x, z * width + x + 1, (z + 1) * width + x, (z + 1) * width + x + 1];
      const moisture = indices.reduce((sum, index) => sum + (terrain.moisture?.[index] ?? 0), 0) / 4;
      if (moisture < W8_PARITY_CONTENT.wetlandMoistureThreshold) continue;
      const heights = indices.map(index => terrain.heights[index] * terrain.heightUnitMeters);
      const minimum = Math.min(...heights);
      const maximum = Math.max(...heights);
      if (maximum - minimum > 0.42) continue;
      const localX = (x + 0.5) * cellWidth;
      const localZ = (z + 0.5) * cellDepth;
      const worldX = q6(chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS + localX);
      const worldZ = q6(chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS + localZ);
      if (conflictsWithSettlement({ x: worldX, z: worldZ }, chunk, 0.5)) continue;
      const stableId = await stableFeatureId({
        worldSeedHash,
        featureType: 'water-surface',
        parentStableId: chunk.chunkId,
        purposeKey: 'wetland-shore',
        semanticLocalKey: `${x}:${z}`,
      });
      surfaces.push(Object.freeze({
        schemaVersion: 'w8-water-surface-1',
        stableId,
        waterType: 'wetland',
        worldPosition: Object.freeze({ x: worldX, y: q6(minimum + 0.035), z: worldZ }),
        widthMeters: q6(cellWidth * 1.015),
        depthMeters: q6(cellDepth * 1.015),
        moisture: q6(moisture),
        owningChunkCoordinate: Object.freeze({ x: chunk.chunkX, z: chunk.chunkZ }),
      }));
    }
  }
  return surfaces.sort((a, b) => a.stableId.localeCompare(b.stableId))
    .slice(0, W8_PARITY_CONTENT.maximumWaterSurfacesPerChunk);
}

async function createSettlementLandmarks(chunk, seed, worldSeedHash) {
  const landmarks = [];
  const chunkMinX = chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const chunkMinZ = chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  for (const reference of chunk.settlementReferences ?? []) {
    const landmark = W8_SETTLEMENT_ROLE_LANDMARKS[reference.townType];
    const landmarkType = landmark?.landmarkType;
    if (!landmark) continue;
    const centerOwner = decomposeLogicalWorldPosition(reference.center.x, reference.center.z);
    if (centerOwner.chunkX !== chunk.chunkX || centerOwner.chunkZ !== chunk.chunkZ) continue;
    const angle = unit(seed, reference.macroRegion.x, reference.macroRegion.z, 21) * Math.PI * 2;
    const distance = reference.townType === 'military' ? 18 : 25;
    const position = clampPointToChunk(chunk, {
      x: reference.center.x + Math.sin(angle) * distance,
      z: reference.center.z + Math.cos(angle) * distance,
    });
    const { x, z } = position;
    const stableId = await stableFeatureId({
      worldSeedHash,
      featureType: 'settlement-landmark',
      parentStableId: reference.settlementId,
      purposeKey: landmarkType,
      semanticLocalKey: 'primary',
    });
    landmarks.push(Object.freeze({
      schemaVersion: 'w8-settlement-landmark-1',
      stableId,
      parentSettlementId: reference.settlementId,
      settlementType: reference.settlementType,
      townType: reference.townType,
      landmarkType,
      worldPosition: Object.freeze({
        x,
        y: q6(sampleFormalTerrainHeightMeters(chunk, x, z)),
        z,
      }),
      rotationY: q6(angle + Math.PI),
      widthMeters: landmark.widthMeters,
      heightMeters: landmark.heightMeters,
      depthMeters: landmark.depthMeters,
      destructible: true,
      owningChunkCoordinate: Object.freeze({ x: chunk.chunkX, z: chunk.chunkZ }),
      logicalLocal: Object.freeze({ x: q6(x - chunkMinX), z: q6(z - chunkMinZ) }),
    }));
    if (landmarkType === 'barn') {
      for (const [secondaryType, radialOffset, radialAngle] of [
        ['haystack', 7.5, angle + Math.PI / 2],
        ['cow', 6.2, angle - Math.PI / 2],
      ]) {
        const secondary = clampPointToChunk(chunk, {
          x: x + Math.sin(radialAngle) * radialOffset,
          z: z + Math.cos(radialAngle) * radialOffset,
        });
        const secondaryStableId = await stableFeatureId({
          worldSeedHash,
          featureType: 'settlement-landmark',
          parentStableId: reference.settlementId,
          purposeKey: secondaryType,
          semanticLocalKey: 'primary-rural-detail',
        });
        landmarks.push(Object.freeze({
          schemaVersion: 'w8-settlement-landmark-1',
          stableId: secondaryStableId,
          parentSettlementId: reference.settlementId,
          settlementType: reference.settlementType,
          townType: reference.townType,
          landmarkType: secondaryType,
          worldPosition: Object.freeze({
            x: secondary.x,
            y: q6(sampleFormalTerrainHeightMeters(chunk, secondary.x, secondary.z)),
            z: secondary.z,
          }),
          rotationY: q6(radialAngle),
          widthMeters: secondaryType === 'cow' ? 1.8 : 2.2,
          heightMeters: secondaryType === 'cow' ? 1.5 : 2.4,
          depthMeters: secondaryType === 'cow' ? 0.9 : 2.2,
          destructible: true,
          owningChunkCoordinate: Object.freeze({ x: chunk.chunkX, z: chunk.chunkZ }),
          logicalLocal: Object.freeze({
            x: q6(secondary.x - chunkMinX), z: q6(secondary.z - chunkMinZ),
          }),
        }));
      }
    }
  }
  return landmarks.sort((a, b) => a.stableId.localeCompare(b.stableId));
}

async function createStreetDetails(chunk, worldSeedHash) {
  const details = [];
  const roads = (chunk.settlementFeatures ?? []).filter(feature => (
    feature.featureType === 'settlement-road' && feature.canonicalMajorRoad !== true
  ));
  for (const road of roads) {
    const dx = road.end.x - road.start.x;
    const dz = road.end.z - road.start.z;
    const length = Math.hypot(dx, dz);
    if (length < 8) continue;
    const nx = -dz / length;
    const nz = dx / length;
    for (let slot = 0; slot < W8_PARITY_CONTENT.streetSlotsPerRoadProjection; slot += 1) {
      const t = slot === 0 ? 0.34 : 0.66;
      const side = slot === 0 ? -1 : 1;
      const position = clampPointToChunk(chunk, {
        x: road.start.x + dx * t + nx * (road.widthMeters / 2 + 1.2) * side,
        z: road.start.z + dz * t + nz * (road.widthMeters / 2 + 1.2) * side,
      });
      const { x, z } = position;
      const detailType = slot === 0 ? 'streetLamp' : 'roadSign';
      const stableId = await stableFeatureId({
        worldSeedHash,
        featureType: 'street-detail',
        parentStableId: road.sourceStableId ?? road.stableId,
        purposeKey: detailType,
        semanticLocalKey: `${chunk.chunkX}:${chunk.chunkZ}:${slot}`,
      });
      details.push(Object.freeze({
        schemaVersion: 'w8-street-detail-1',
        stableId,
        parentRoadStableId: road.sourceStableId ?? road.stableId,
        detailType,
        worldPosition: Object.freeze({
          x,
          y: q6(sampleFormalTerrainHeightMeters(chunk, x, z)),
          z,
        }),
        rotationY: q6(Math.atan2(dx, dz)),
        destructible: true,
        owningChunkCoordinate: Object.freeze({ x: chunk.chunkX, z: chunk.chunkZ }),
      }));
    }
  }
  return details.sort((a, b) => a.stableId.localeCompare(b.stableId));
}

export async function hashW8ParityChunkContent(content) {
  return `sha256:${await sha256Hex(canonicalizeJson({
    schemaVersion: content.schemaVersion,
    chunkId: content.chunkId,
    sourceW5ContentHash: content.sourceW5ContentHash,
    settlementReferenceIds: content.settlementReferences.map(value => value.stableId),
    settlementFeatureIds: content.settlementFeatures.map(value => value.stableId),
    canonicalSurfacePolicy: content.canonicalSurfacePolicy,
    waterSurfaceIds: content.waterSurfaces.map(value => value.stableId),
    riverRoadCrossingIds: (content.riverRoadCrossings ?? []).map(value => value.stableId),
    riverPortIds: (content.riverPorts ?? []).map(value => value.portId),
    ambientDetailIds: content.ambientDetails.map(value => value.stableId),
    settlementLandmarkIds: content.settlementLandmarks.map(value => value.stableId),
    streetDetailIds: content.streetDetails.map(value => value.stableId),
    settlementOverlayFeatureIds: content.settlementOverlayFeatures.map(value => value.stableId),
    presentationLayerOrder: content.presentationLayers.integrationOrder,
    presentationVegetationIds: content.presentationLayers.natural.vegetation
      .map(value => value.candidateId ?? value.stableId),
    generationProof: content.generationProof,
  }))}`;
}

export function validateW8ParityChunkData(chunk) {
  const errors = [];
  if (chunk?.schemaVersion !== W8_PARITY_CHUNK_DATA_SCHEMA) errors.push('invalid W8 ChunkData schema');
  if (chunk?.generatorVersion?.id !== W8_PARITY_GENERATOR_VERSION.id) errors.push('invalid W8 generator version');
  if (chunk?.sourceChunkData?.schemaVersion !== W5_CHUNK_DATA_SCHEMA) errors.push('missing W5 source ChunkData');
  if (chunk?.sourceW5ContentHash !== chunk?.sourceChunkData?.contentHash) errors.push('W5 source hash mismatch');
  if (chunk?.canonicalSurfacePolicy?.schemaVersion !== 'w8-settlement-surface-policy-1'
    || !Array.isArray(chunk.canonicalSurfacePolicy.regions)) errors.push('invalid canonical surface policy');
  const ids = new Set();
  for (const name of ['waterSurfaces', 'ambientDetails', 'settlementLandmarks', 'streetDetails', 'settlementOverlayFeatures']) {
    if (!Array.isArray(chunk?.[name])) { errors.push(`${name} must be an array`); continue; }
    for (let index = 0; index < chunk[name].length; index += 1) {
      const value = chunk[name][index];
      if (typeof value?.stableId !== 'string' || ids.has(value.stableId)) errors.push(`duplicate or invalid ${name} Stable ID`);
      ids.add(value?.stableId);
      if (index && chunk[name][index - 1].stableId.localeCompare(value.stableId) > 0) errors.push(`${name} is not sorted`);
      if (value?.owningChunkCoordinate?.x !== chunk.chunkX || value?.owningChunkCoordinate?.z !== chunk.chunkZ) {
        errors.push(`invalid ${name} owner`);
      }
    }
  }
  const riverSurfaces = (chunk?.waterSurfaces ?? []).filter(surface => surface.waterType === 'river');
  for (const surface of riverSurfaces) {
    if (surface.featureType !== 'canonical-river'
      || typeof surface.sourceStableId !== 'string'
      || !Array.isArray(surface.centerlines)
      || !surface.centerlines.length
      || surface.centerlines.some(line => !Array.isArray(line) || line.length < 2
        || line.some(point => ![point?.x, point?.y, point?.z].every(Number.isFinite)))
      || surface.widthMeters !== G2_C_WORLD_FEATURES.river.width
      || surface.riverDepthMeters !== G2_C_WORLD_FEATURES.river.depth
      || surface.flowDirection !== 'startToEnd') {
      errors.push('invalid canonical River surface');
    }
  }
  if (!Array.isArray(chunk?.riverRoadCrossings) || !Array.isArray(chunk?.riverPorts)) {
    errors.push('invalid canonical River metadata');
  } else {
    const crossingIds = new Set();
    for (const crossing of chunk.riverRoadCrossings) {
      if (typeof crossing?.stableId !== 'string' || crossingIds.has(crossing.stableId)
        || crossing.bridgeRequired !== true
        || crossing.owningChunkCoordinate?.x !== chunk.chunkX
        || crossing.owningChunkCoordinate?.z !== chunk.chunkZ) {
        errors.push('invalid River/Road crossing metadata');
      }
      crossingIds.add(crossing?.stableId);
    }
    const referencedCrossings = new Set(riverSurfaces.flatMap(surface => surface.crossingReferences ?? []));
    if (crossingIds.size !== referencedCrossings.size
      || [...crossingIds].some(stableId => !referencedCrossings.has(stableId))) {
      errors.push('River crossing references do not match Chunk metadata');
    }
    const portIds = chunk.riverPorts.map(port => port?.portId);
    if (portIds.some(portId => typeof portId !== 'string')
      || new Set(portIds).size !== portIds.length) errors.push('invalid River continuation ports');
  }
  if (chunk?.presentationLayers?.schemaVersion !== 'w8-presentation-layers-1'
    || chunk.presentationLayers.heightSource.sourceW5ContentHash !== chunk.sourceW5ContentHash
    || chunk.presentationLayers.heightSource.verticalScale !== 1) {
    errors.push('invalid W8 presentationLayers height source');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(chunk?.contentHash ?? '')) errors.push('invalid W8 content hash');
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export async function createW8ParityChunkGenerator({
  worldSeed = 'KaniNingen Infinite Natural World',
  baseGeneratorFactory = createDistributedSettlementChunkGenerator,
} = {}) {
  const base = await baseGeneratorFactory({ worldSeed });
  const naturalPresentationPolicy = await createW8NaturalPresentationPhase1Policy({
    worldSeedHash: base.worldSeedHash,
  });
  const seed = textSeed(`${base.worldSeedHash}:${W8_PARITY_CONTENT.schemaVersion}`);
  const warmSourceChunks = new Map();
  const pendingSourceChunks = new Map();
  const settlementOverlayTemplates = new Map();
  const settlementDiagnostics = new Map();
  const majorRoadGraphCache = new Map();
  const majorRoadRouteCache = new Map();
  const majorRoadObstacleCache = new Map();
  const majorRoadPreparationCache = new Map();
  const majorRoadSourceHashCache = new Map();
  const majorRoadRouteKeyByEdge = new Map();
  const majorRoadObstacleKeyBySettlement = new Map();
  const nowMs = () => globalThis.performance?.now?.() ?? Date.now();
  const majorRoadDiagnostics = {
    graphsBuilt: 0,
    graphRequests: 0,
    graphCacheHits: 0,
    graphCacheMisses: 0,
    graphGenerationMs: 0,
    routesBuilt: 0,
    routeRequests: 0,
    routeCacheHits: 0,
    routeCacheMisses: 0,
    routeStaleCacheRejections: 0,
    preparationCacheHits: 0,
    preparationCacheMisses: 0,
    preparationBatchCount: 0,
    preparationBatchMs: 0,
    preparationBatchMaximumMs: 0,
    sourceContentHashCount: 0,
    sourceContentHashMs: 0,
    routeSegmentCount: 0,
    canonicalRoadMs: 0,
    directRouteMs: 0,
    directRouteCount: 0,
    lateralDoglegMs: 0,
    lateralDoglegCount: 0,
    gridRouteMs: 0,
    gridRouteCount: 0,
    roadStableIdMs: 0,
    segmentSubdivisionMs: 0,
    settlementCandidateQueryCount: 0,
    settlementCandidateQueryMs: 0,
    settlementTemplateRequests: 0,
    settlementTemplateCacheHits: 0,
    settlementTemplateCacheMisses: 0,
    settlementSourceTemplateResolutionMs: 0,
    settlementOverlayCompositionMs: 0,
    settlementOverlayGenerationMs: 0,
    obstacleRequests: 0,
    obstacleCacheHits: 0,
    obstacleCacheMisses: 0,
    obstacleStaleCacheRejections: 0,
    obstacleSourceMs: 0,
    obstacleBoundsBuildMs: 0,
    chunkProjectionCount: 0,
    chunkProjectionMs: 0,
    chunkRoadResolutionMs: 0,
    obstacleBuildingCount: 0,
    obstacleLotCount: 0,
    obstacleLandmarkCount: 0,
  };
  const warmSourceChunkCapacity = 256;
  const trimWarmSourceChunks = () => {
    while (warmSourceChunks.size > warmSourceChunkCapacity) {
      warmSourceChunks.delete(warmSourceChunks.keys().next().value);
    }
  };
  const getSourceChunk = async (chunkX, chunkZ) => {
    const key = createChunkKey(chunkX, chunkZ);
    if (warmSourceChunks.has(key)) {
      const cached = warmSourceChunks.get(key);
      warmSourceChunks.delete(key);
      warmSourceChunks.set(key, cached);
      return cached;
    }
    if (pendingSourceChunks.has(key)) return pendingSourceChunks.get(key);
    const pending = Promise.resolve(base.generateChunk(chunkX, chunkZ)).then(
      chunk => {
        pendingSourceChunks.delete(key);
        warmSourceChunks.set(key, chunk);
        trimWarmSourceChunks();
        return chunk;
      },
      error => {
        pendingSourceChunks.delete(key);
        throw error;
      },
    );
    pendingSourceChunks.set(key, pending);
    return pending;
  };
  const getSettlementOverlay = async reference => {
    if (!reference) return null;
    majorRoadDiagnostics.settlementTemplateRequests += 1;
    if (settlementOverlayTemplates.has(reference.settlementId)) {
      majorRoadDiagnostics.settlementTemplateCacheHits += 1;
      return settlementOverlayTemplates.get(reference.settlementId);
    }
    majorRoadDiagnostics.settlementTemplateCacheMisses += 1;
    if (!settlementOverlayTemplates.has(reference.settlementId)) {
      const startedAt = nowMs();
      const candidate = {
          settlementId: reference.settlementId,
          settlementType: reference.settlementType,
          townType: reference.townType,
          macroRegion: reference.macroRegion,
          center: reference.center,
          urbanization: reference.urbanization,
          terrainSuitability: reference.terrainSuitability,
      };
      const pending = (async () => {
        const sourceStartedAt = nowMs();
        const sourceTemplate = await base.resolveSettlementTemplate({ candidate });
        majorRoadDiagnostics.settlementSourceTemplateResolutionMs += nowMs() - sourceStartedAt;
        const overlayStartedAt = nowMs();
        const overlay = await createW8SettlementParityOverlay({
          worldSeedHash: base.worldSeedHash,
          candidate,
          sourceTemplate,
        });
        majorRoadDiagnostics.settlementOverlayCompositionMs += nowMs() - overlayStartedAt;
        majorRoadDiagnostics.settlementOverlayGenerationMs += nowMs() - startedAt;
        settlementDiagnostics.set(reference.settlementId, Object.freeze({
          settlementId: reference.settlementId,
          settlementType: reference.settlementType,
          townType: reference.townType,
          center: reference.center,
          macroRegion: reference.macroRegion,
          radiusMeters: reference.radiusMeters,
          sourceBuildingCount: overlay.sourceBuildingCount,
          overlayBuildingCount: overlay.overlayBuildingCount,
          buildingCount: overlay.sourceBuildingCount + overlay.overlayBuildingCount,
        }));
        return overlay;
      })();
      settlementOverlayTemplates.set(reference.settlementId, pending);
    }
    return settlementOverlayTemplates.get(reference.settlementId);
  };
  const referenceFromGraphNode = node => Object.freeze({
    stableId: `${node.stableId}:reference`,
    settlementId: node.stableId,
    settlementType: node.settlementType,
    townType: node.role,
    macroRegion: node.ownerRegion,
    center: node.center,
    radiusMeters: node.radiusMeters,
    urbanization: null,
    terrainSuitability: null,
  });
  const majorRoadSurfacePolicyVersion = 'w8-settlement-surface-policy-1';
  const majorRoadSourceContractVersion = 'w5-migrated-settlement-template-1';
  const getMajorRoadSourceContentHash = node => {
    if (majorRoadSourceHashCache.has(node.stableId)) {
      return majorRoadSourceHashCache.get(node.stableId);
    }
    const startedAt = nowMs();
    const pending = sha256Hex(canonicalizeJson({
      worldSeedHash: base.worldSeedHash,
      sourceContractVersion: majorRoadSourceContractVersion,
      settlementOverlayVersion: W8_PARITY_CONTENT.schemaVersion,
      surfacePolicyVersion: majorRoadSurfacePolicyVersion,
      roadContractVersion: W8_CANONICAL_MAJOR_ROAD.schemaVersion,
      settlement: {
        stableId: node.stableId,
        ownerRegion: node.ownerRegion,
        settlementType: node.settlementType,
        role: node.role,
        center: node.center,
        radiusMeters: node.radiusMeters,
      },
    })).then(hash => {
      majorRoadDiagnostics.sourceContentHashCount += 1;
      majorRoadDiagnostics.sourceContentHashMs += nowMs() - startedAt;
      return `sha256:${hash}`;
    }).catch(error => {
      majorRoadSourceHashCache.delete(node.stableId);
      throw error;
    });
    majorRoadSourceHashCache.set(node.stableId, pending);
    return pending;
  };
  const createMajorRoadLandmarkObstacles = reference => {
    const descriptor = W8_SETTLEMENT_ROLE_LANDMARKS[reference.townType];
    if (!descriptor) return Object.freeze([]);
    const owner = decomposeLogicalWorldPosition(reference.center.x, reference.center.z);
    const angle = unit(seed, reference.macroRegion.x, reference.macroRegion.z, 21) * Math.PI * 2;
    const distance = reference.townType === 'military' ? 18 : 25;
    const primary = clampPointToChunk(owner, {
      x: reference.center.x + Math.sin(angle) * distance,
      z: reference.center.z + Math.cos(angle) * distance,
    });
    const landmarks = [{
      stableId: `${reference.settlementId}:major-road-obstacle:${descriptor.landmarkType}`,
      worldPosition: primary,
      rotationY: q6(angle + Math.PI),
      widthMeters: descriptor.widthMeters,
      depthMeters: descriptor.depthMeters,
    }];
    if (descriptor.landmarkType === 'barn') {
      for (const [secondaryType, radialOffset, radialAngle, widthMeters, depthMeters] of [
        ['haystack', 7.5, angle + Math.PI / 2, 2.2, 2.2],
        ['cow', 6.2, angle - Math.PI / 2, 1.8, 0.9],
      ]) {
        landmarks.push({
          stableId: `${reference.settlementId}:major-road-obstacle:${secondaryType}`,
          worldPosition: clampPointToChunk(owner, {
            x: primary.x + Math.sin(radialAngle) * radialOffset,
            z: primary.z + Math.cos(radialAngle) * radialOffset,
          }),
          rotationY: q6(radialAngle),
          widthMeters,
          depthMeters,
        });
      }
    }
    return Object.freeze(landmarks.map(value => Object.freeze(value)));
  };
  const getMajorRoadObstacles = async (node, sourceContentHash) => {
    majorRoadDiagnostics.obstacleRequests += 1;
    const cacheKey = canonicalizeJson({
      worldSeedHash: base.worldSeedHash,
      settlementStableId: node.stableId,
      sourceContentHash,
      surfacePolicyVersion: majorRoadSurfacePolicyVersion,
      roadContractVersion: W8_CANONICAL_MAJOR_ROAD.schemaVersion,
    });
    const previousKey = majorRoadObstacleKeyBySettlement.get(node.stableId);
    if (previousKey && previousKey !== cacheKey) {
      majorRoadDiagnostics.obstacleStaleCacheRejections += 1;
    }
    majorRoadObstacleKeyBySettlement.set(node.stableId, cacheKey);
    if (majorRoadObstacleCache.has(cacheKey)) {
      majorRoadDiagnostics.obstacleCacheHits += 1;
      return majorRoadObstacleCache.get(cacheKey);
    }
    majorRoadDiagnostics.obstacleCacheMisses += 1;
    const reference = referenceFromGraphNode(node);
    const pending = (async () => {
      const sourceStartedAt = nowMs();
      const overlay = await getSettlementOverlay(reference);
      majorRoadDiagnostics.obstacleSourceMs += nowMs() - sourceStartedAt;
      const boundsStartedAt = nowMs();
      const presentation = composeW8SettlementPresentationTemplate(overlay);
      const obstacles = createCanonicalMajorRoadObstacles({
        buildings: presentation.buildings,
        landmarks: createMajorRoadLandmarkObstacles(reference),
      });
      majorRoadDiagnostics.obstacleBuildingCount += obstacles
        .filter(value => value.kind === 'BUILDING').length;
      majorRoadDiagnostics.obstacleLotCount += obstacles
        .filter(value => value.kind === 'LOT').length;
      majorRoadDiagnostics.obstacleLandmarkCount += obstacles
        .filter(value => value.kind === 'LANDMARK').length;
      majorRoadDiagnostics.obstacleBoundsBuildMs += nowMs() - boundsStartedAt;
      return Object.freeze({
        obstacles,
        localRoads: Object.freeze([...presentation.roads]),
      });
    })().catch(error => {
      majorRoadObstacleCache.delete(cacheKey);
      throw error;
    });
    majorRoadObstacleCache.set(cacheKey, pending);
    return pending;
  };
  const prepareMajorRoadSource = async ({ edge, graph }) => {
    const preparationKey = canonicalizeJson({
      worldSeedHash: base.worldSeedHash,
      roadContractVersion: W8_CANONICAL_MAJOR_ROAD.schemaVersion,
      edgeStableId: edge.stableId,
      settlementIds: edge.settlementIds,
    });
    if (majorRoadPreparationCache.has(preparationKey)) {
      majorRoadDiagnostics.preparationCacheHits += 1;
      return majorRoadPreparationCache.get(preparationKey);
    }
    majorRoadDiagnostics.preparationCacheMisses += 1;
    const pending = (async () => {
    const nodesById = new Map(graph.nodes.map(node => [node.stableId, node]));
    const endpoints = edge.settlementIds.map(id => nodesById.get(id));
    const maximumEndpointRadius = Math.max(...endpoints.map(node => node.radiusMeters));
    const midpoint = {
      x: (endpoints[0].center.x + endpoints[1].center.x) / 2,
      z: (endpoints[0].center.z + endpoints[1].center.z) / 2,
    };
    const endpointDistance = Math.hypot(
      endpoints[1].center.x - endpoints[0].center.x,
      endpoints[1].center.z - endpoints[0].center.z,
    );
    const queryStartedAt = nowMs();
    majorRoadDiagnostics.settlementCandidateQueryCount += 1;
    const corridorCandidates = await base.distributor.findSettlementCentersNear(
      midpoint.x,
      midpoint.z,
      endpointDistance / 2 + maximumEndpointRadius * 3
        + W8_CANONICAL_MAJOR_ROAD.widthMeters * 8,
    );
    majorRoadDiagnostics.settlementCandidateQueryMs += nowMs() - queryStartedAt;
    const relevantNodes = corridorCandidates.filter(candidate => (
      distanceToSegment(candidate.center, endpoints[0].center, endpoints[1].center)
        <= candidate.radiusMeters + maximumEndpointRadius * 2
          + W8_CANONICAL_MAJOR_ROAD.widthMeters * 8
    )).map(candidate => Object.freeze({
      stableId: candidate.settlementId,
      ownerRegion: candidate.macroRegion,
      settlementType: candidate.settlementType,
      role: candidate.townType,
      center: candidate.center,
      radiusMeters: candidate.radiusMeters,
    }));
    const sourceHashes = await Promise.all(
      relevantNodes.map(getMajorRoadSourceContentHash),
    );
    const resolved = await Promise.all(relevantNodes.map((node, index) => (
      getMajorRoadObstacles(node, sourceHashes[index])
    )));
    const sourceContentHashes = relevantNodes.map((node, index) => Object.freeze({
      settlementStableId: node.stableId,
      contentHash: sourceHashes[index],
    }));
    return Object.freeze({
      cacheKey: createCanonicalMajorRoadCacheKey({
        worldSeedHash: base.worldSeedHash,
        roadEdgeStableId: edge.stableId,
        sourceContentHashes,
        surfacePolicyVersion: majorRoadSurfacePolicyVersion,
        roadContractVersion: W8_CANONICAL_MAJOR_ROAD.schemaVersion,
      }),
      obstacles: Object.freeze(resolved.flatMap(value => value.obstacles)
        .sort((left, right) => left.stableId.localeCompare(right.stableId))),
      localRoads: Object.freeze(resolved.flatMap(value => value.localRoads)
        .sort((left, right) => left.stableId.localeCompare(right.stableId))),
    });
    })().catch(error => {
      majorRoadPreparationCache.delete(preparationKey);
      throw error;
    });
    majorRoadPreparationCache.set(preparationKey, pending);
    return pending;
  };
  const getMajorRoadForEdge = async (edge, graph, preparedSource = null) => {
    majorRoadDiagnostics.routeRequests += 1;
    const prepared = preparedSource ?? await prepareMajorRoadSource({ edge, graph });
    const previousKey = majorRoadRouteKeyByEdge.get(edge.stableId);
    if (previousKey && previousKey !== prepared.cacheKey) {
      majorRoadDiagnostics.routeStaleCacheRejections += 1;
    }
    majorRoadRouteKeyByEdge.set(edge.stableId, prepared.cacheKey);
    if (majorRoadRouteCache.has(prepared.cacheKey)) {
      majorRoadDiagnostics.routeCacheHits += 1;
      return majorRoadRouteCache.get(prepared.cacheKey);
    }
    majorRoadDiagnostics.routeCacheMisses += 1;
    const timingObserver = (name, durationMs, details) => {
      if (name === 'canonical-road') majorRoadDiagnostics.canonicalRoadMs += durationMs;
      else if (name === 'direct-route') {
        majorRoadDiagnostics.directRouteMs += durationMs;
        majorRoadDiagnostics.directRouteCount += 1;
      } else if (name === 'lateral-dogleg') {
        majorRoadDiagnostics.lateralDoglegMs += durationMs;
        majorRoadDiagnostics.lateralDoglegCount += 1;
      } else if (name === 'grid-route') {
        majorRoadDiagnostics.gridRouteMs += durationMs;
        majorRoadDiagnostics.gridRouteCount += 1;
      } else if (name === 'road-stable-id') majorRoadDiagnostics.roadStableIdMs += durationMs;
      else if (name === 'segment-subdivision') {
        majorRoadDiagnostics.segmentSubdivisionMs += durationMs;
      }
      void details;
    };
    const pending = createCanonicalMajorRoadNetwork({
      worldSeedHash: base.worldSeedHash,
      graph: Object.freeze({ ...graph, edges: Object.freeze([edge]) }),
      resolveObstacles: () => prepared,
      timingObserver,
    }).then(network => {
      const road = network.roads[0];
      majorRoadDiagnostics.routesBuilt += 1;
      majorRoadDiagnostics.routeSegmentCount += road.segments.length;
      return road;
    }).catch(error => {
      majorRoadRouteCache.delete(prepared.cacheKey);
      throw error;
    });
    majorRoadRouteCache.set(prepared.cacheKey, pending);
    return pending;
  };
  const getMajorRoads = async (edges, graph) => {
    const preparationStartedAt = nowMs();
    let preparationMissCount = 0;
    const preparedSources = await Promise.all(
      edges.map(edge => {
        const cacheKey = majorRoadRouteKeyByEdge.get(edge.stableId);
        if (cacheKey && majorRoadRouteCache.has(cacheKey)) return null;
        preparationMissCount += 1;
        return prepareMajorRoadSource({ edge, graph });
      }),
    );
    if (preparationMissCount > 0) {
      const durationMs = nowMs() - preparationStartedAt;
      majorRoadDiagnostics.preparationBatchCount += 1;
      majorRoadDiagnostics.preparationBatchMs += durationMs;
      majorRoadDiagnostics.preparationBatchMaximumMs = Math.max(
        majorRoadDiagnostics.preparationBatchMaximumMs,
        durationMs,
      );
    }
    const roads = [];
    // Route geometry stays serial inside the single generator transport. The
    // preparation pass only overlaps immutable template/hash waits and lets
    // pending caches deduplicate Settlements shared by multiple edges.
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index];
      const prepared = preparedSources[index];
      if (!prepared) {
        majorRoadDiagnostics.routeRequests += 1;
        majorRoadDiagnostics.routeCacheHits += 1;
        roads.push(await majorRoadRouteCache.get(majorRoadRouteKeyByEdge.get(edge.stableId)));
      } else {
        roads.push(await getMajorRoadForEdge(edge, graph, prepared));
      }
    }
    return roads;
  };
  const majorRoadGraphRadiusMeters = W5_SETTLEMENT_DISTRIBUTION
    .connectivity.queryRadiusMeters
      + W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters * Math.SQRT2 / 2;
  const getMajorRoadGraph = async (chunkX, chunkZ) => {
    majorRoadDiagnostics.graphRequests += 1;
    const chunkCenterX = (chunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const chunkCenterZ = (chunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const regionX = Math.floor(chunkCenterX / W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters);
    const regionZ = Math.floor(chunkCenterZ / W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters);
    const key = `${regionX},${regionZ}`;
    if (majorRoadGraphCache.has(key)) {
      majorRoadDiagnostics.graphCacheHits += 1;
      return majorRoadGraphCache.get(key);
    }
    majorRoadDiagnostics.graphCacheMisses += 1;
    const startedAt = nowMs();
    const pending = base.distributor.buildConnectivityGraphNear(
      (regionX + 0.5) * W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters,
      (regionZ + 0.5) * W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters,
      majorRoadGraphRadiusMeters,
    ).then(graph => {
      majorRoadDiagnostics.graphsBuilt += 1;
      majorRoadDiagnostics.graphGenerationMs += nowMs() - startedAt;
      return graph;
    }).catch(error => {
      majorRoadGraphCache.delete(key);
      throw error;
    });
    majorRoadGraphCache.set(key, pending);
    return pending;
  };
  const createMajorRoadFeatures = async (chunkX, chunkZ, surfaceBackedChunk) => {
    const resolutionStartedAt = nowMs();
    const graph = await getMajorRoadGraph(chunkX, chunkZ);
    const edges = graphEdgesPotentiallyIntersectChunk({ graph, chunkX, chunkZ });
    const roads = await getMajorRoads(edges, graph);
    majorRoadDiagnostics.chunkRoadResolutionMs += nowMs() - resolutionStartedAt;
    const projectionStartedAt = nowMs();
    const features = projectCanonicalMajorRoadsToChunk({
      roads,
      chunkX,
      chunkZ,
      sampleGroundHeight: (worldX, worldZ) => sampleW8SurfaceHeightMeters(
        surfaceBackedChunk,
        worldX,
        worldZ,
      ),
    });
    majorRoadDiagnostics.chunkProjectionCount += 1;
    majorRoadDiagnostics.chunkProjectionMs += nowMs() - projectionStartedAt;
    return features;
  };
  const prepareSourceSquare = async (centerChunkX, centerChunkZ, radius) => {
    // Materialize the owning Settlement template once before parallel edge projection.
    await getSourceChunk(centerChunkX, centerChunkZ);
    return Promise.all(squareChunkCoordinates(centerChunkX, centerChunkZ, radius)
      .map(coordinate => getSourceChunk(coordinate.chunkX, coordinate.chunkZ)));
  };
  let experienceSpawn = EXPERIENCE_SPAWN_CACHE.get(base.worldSeedHash) ?? null;
  if (!experienceSpawn) {
    let preparedSpawnSources = null;
    if (base.worldSeedHash === PROTECTED_SAFE_SPAWN_BOOTSTRAP.worldSeedHash) {
      const pinnedOwner = decomposeLogicalWorldPosition(
        PROTECTED_SAFE_SPAWN_BOOTSTRAP.x,
        PROTECTED_SAFE_SPAWN_BOOTSTRAP.z,
      );
      preparedSpawnSources = await prepareSourceSquare(
        pinnedOwner.chunkX,
        pinnedOwner.chunkZ,
        W8_SPAWN_SAFETY_CONTRACT.preparedDataRadiusChunks,
      );
      const owningSource = preparedSpawnSources.find(source =>
        source.chunkX === pinnedOwner.chunkX && source.chunkZ === pinnedOwner.chunkZ);
      const selectedSurface = (await createWaterSurfaces(owningSource, base.worldSeedHash))
        .find(surface => surface.stableId === PROTECTED_SAFE_SPAWN_BOOTSTRAP.pondStableId);
      if (!selectedSurface
        || selectedSurface.worldPosition.x !== PROTECTED_SAFE_SPAWN_BOOTSTRAP.x
        || selectedSurface.worldPosition.z !== PROTECTED_SAFE_SPAWN_BOOTSTRAP.z) {
        throw new Error('protected W8 safe pond bootstrap no longer matches canonical W5 data');
      }
      const settlementLandmarks = (await Promise.all(preparedSpawnSources
        .map(source => createSettlementLandmarks(source, seed, base.worldSeedHash)))).flat();
      experienceSpawn = selectSafeExperienceSpawn({
        reviewSpawn: base.reviewSpawn,
        waterSurfaces: [selectedSurface],
        sourceChunks: preparedSpawnSources,
        settlementLandmarks,
      });
      if (experienceSpawn?.pondStableId !== PROTECTED_SAFE_SPAWN_BOOTSTRAP.pondStableId) {
        throw new Error('protected W8 safe pond bootstrap failed its current corridor validation');
      }
    } else {
      const spawnOwner = decomposeLogicalWorldPosition(base.reviewSpawn.x, base.reviewSpawn.z);
      for (let radius = W8_SPAWN_SAFETY_CONTRACT.preparedDataRadiusChunks;
        radius <= 6 && !experienceSpawn; radius += 1) {
        const sourceChunks = await prepareSourceSquare(spawnOwner.chunkX, spawnOwner.chunkZ, radius);
        const waterSurfaces = (await Promise.all(sourceChunks
          .map(source => createWaterSurfaces(source, base.worldSeedHash)))).flat();
        const settlementLandmarks = (await Promise.all(sourceChunks
          .map(source => createSettlementLandmarks(source, seed, base.worldSeedHash)))).flat();
        experienceSpawn = selectSafeExperienceSpawn({
          reviewSpawn: base.reviewSpawn,
          waterSurfaces,
          sourceChunks,
          settlementLandmarks,
        });
      }
    }
    if (!experienceSpawn) throw new Error('no safe W8 pond spawn and intro camera corridor were found');
    const selectedOwner = decomposeLogicalWorldPosition(experienceSpawn.x, experienceSpawn.z);
    const preparedSources = preparedSpawnSources ?? await prepareSourceSquare(
        selectedOwner.chunkX,
        selectedOwner.chunkZ,
        W8_SPAWN_SAFETY_CONTRACT.preparedDataRadiusChunks,
      );
    const selectedSource = preparedSources.find(source =>
      source.chunkX === selectedOwner.chunkX && source.chunkZ === selectedOwner.chunkZ);
    const selectedSurfacePolicy = createSettlementSurfacePolicy(
      selectedSource?.settlementReferences ?? [],
    );
    const canonicalSpawnGround = sampleW8SurfaceHeightMeters({
      ...selectedSource,
      canonicalSurfacePolicy: selectedSurfacePolicy,
    }, experienceSpawn.x, experienceSpawn.z);
    experienceSpawn = Object.freeze({
      ...experienceSpawn,
      y: q6(canonicalSpawnGround + 0.0125),
      spawnSafety: Object.freeze({
        ...experienceSpawn.spawnSafety,
        preparedChunkKeys: Object.freeze(preparedSources.map(source =>
          createChunkKey(source.chunkX, source.chunkZ)).sort()),
      }),
    });
    EXPERIENCE_SPAWN_CACHE.set(base.worldSeedHash, experienceSpawn);
  } else {
    const selectedOwner = decomposeLogicalWorldPosition(experienceSpawn.x, experienceSpawn.z);
    await prepareSourceSquare(
      selectedOwner.chunkX,
      selectedOwner.chunkZ,
      W8_SPAWN_SAFETY_CONTRACT.preparedDataRadiusChunks,
    );
  }
  return Object.freeze({
    worldSeed: base.worldSeed,
    worldSeedHash: base.worldSeedHash,
    seed64: base.seed64,
    generatorVersion: W8_PARITY_GENERATOR_VERSION,
    distributor: base.distributor,
    reviewSpawn: base.reviewSpawn,
    experienceSpawn,
    async auditSettlementsNear(x, z, radiusMeters) {
      const candidates = await base.distributor.findSettlementsNear(x, z, radiusMeters);
      const overlays = await Promise.all(candidates.map(getSettlementOverlay));
      return Object.freeze(candidates.map((candidate, index) => {
        const profile = MIGRATED_SETTLEMENT_PROFILES[candidate.townType];
        const nearestTownDistanceMeters = Math.min(
          ...candidates.filter(other => other.settlementId !== candidate.settlementId)
            .map(other => Math.hypot(
              candidate.center.x - other.center.x,
              candidate.center.z - other.center.z,
            )),
          Infinity,
        );
        const landmarkType = W8_PARITY_CONTENT.landmarkByTownType[candidate.townType];
        const landmarkCount = landmarkType === 'barn' ? 3 : landmarkType ? 1 : 0;
        return Object.freeze({
          role: candidate.townType,
          settlementType: candidate.settlementType,
          finiteLocalCenter: null,
          translatedWorldCenter: candidate.center,
          radiusMeters: profile.radius / FINITE_WORLD_UNITS_PER_METER,
          ownerRegion: candidate.macroRegion,
          buildingCount: overlays[index].sourceBuildingCount + overlays[index].overlayBuildingCount,
          landmarkCount,
          nearestTownDistanceMeters,
        });
      }));
    },
    async resolveSettlementPresentationTemplate({ candidate } = {}) {
      return composeW8SettlementPresentationTemplate(await getSettlementOverlay(candidate));
    },
    async resolveCanonicalMajorRoadNetwork({
      centerWorldX,
      centerWorldZ,
      radiusMeters,
    } = {}) {
      if (![centerWorldX, centerWorldZ, radiusMeters].every(Number.isFinite)
        || radiusMeters < 0) throw new TypeError('valid MAJOR Road query is required');
      const graph = await base.distributor.buildConnectivityGraphNear(
        centerWorldX,
        centerWorldZ,
        radiusMeters,
      );
      const roads = await getMajorRoads(graph.edges, graph);
      return Object.freeze({
        schemaVersion: 'w8-canonical-major-road-network-1',
        graph,
        graphEdgeCount: graph.edges.length,
        roadCount: roads.length,
        roads: Object.freeze(roads.sort((left, right) => left.stableId.localeCompare(right.stableId))),
      });
    },
    async generateChunk(chunkX, chunkZ) {
      const sourceChunkData = await getSourceChunk(chunkX, chunkZ);
      const overlayTemplates = await Promise.all(
        (sourceChunkData.settlementReferences ?? []).map(getSettlementOverlay),
      );
      const settlementOverlayFeatures = overlayTemplates.filter(Boolean)
        .flatMap(template => template.buildings)
        .filter(building => building.owningChunkCoordinate.x === chunkX
          && building.owningChunkCoordinate.z === chunkZ)
        .map(building => Object.freeze({
          ...building,
          worldPosition: Object.freeze({
            x: building.x,
            y: q6(sampleFormalTerrainHeightMeters(sourceChunkData, building.x, building.z)),
            z: building.z,
          }),
        }))
        .sort((left, right) => left.stableId.localeCompare(right.stableId));
      const overlayBySettlement = new Map(overlayTemplates.filter(Boolean)
        .map(template => [template.settlementId, template]));
      const settlementReferences = (sourceChunkData.settlementReferences ?? []).map(reference => {
        const overlay = overlayBySettlement.get(reference.settlementId);
        return overlay ? Object.freeze({
          ...reference,
          parityTargetBuildingCount: overlay.targetBuildingCount,
          parityOverlayBuildingCount: overlay.overlayBuildingCount,
          parityBuildingShortageCount: overlay.shortageCount,
        }) : reference;
      }).sort((left, right) => left.stableId.localeCompare(right.stableId));
      const fullSettlementBuildings = overlayTemplates.filter(Boolean).flatMap(template => [
        ...template.sourceBuildings,
        ...template.buildings,
      ]);
      const sourceFeatures = (sourceChunkData.settlementFeatures ?? []).filter(feature => (
        feature.featureType !== 'settlement-road'
        || !fullSettlementBuildings.some(building =>
          roadIntersectsSettlementBuilding(feature, building))
      ));
      const localSettlementFeatures = [
        ...sourceFeatures,
        ...settlementOverlayFeatures,
      ].sort((left, right) => left.stableId.localeCompare(right.stableId));
      const settlementSurfacePolicy = createSettlementSurfacePolicy(settlementReferences);
      const localSurfaceBackedChunk = Object.freeze({
        ...sourceChunkData,
        settlementReferences: Object.freeze(settlementReferences),
        settlementFeatures: Object.freeze(localSettlementFeatures),
        canonicalSurfacePolicy: settlementSurfacePolicy,
      });
      const majorRoadFeatures = await createMajorRoadFeatures(
        chunkX,
        chunkZ,
        localSurfaceBackedChunk,
      );
      const settlementFeatures = [
        ...localSettlementFeatures,
        ...majorRoadFeatures,
      ].sort((left, right) => left.stableId.localeCompare(right.stableId));
      const riverProjection = await createCanonicalRiverProjection({
        worldSeedHash: base.worldSeedHash,
        chunkX,
        chunkZ,
        settlementReferences,
        roads: settlementFeatures,
        sampleSurfaceHeight: (worldX, worldZ) => sampleW8SurfaceHeightMeters(
          localSurfaceBackedChunk,
          worldX,
          worldZ,
        ),
      });
      const canonicalSurfacePolicy = createSettlementSurfacePolicy(
        settlementReferences,
        riverProjection.surfaceCorridor ? [riverProjection.surfaceCorridor] : [],
      );
      const surfaceBackedChunk = Object.freeze({
        ...localSurfaceBackedChunk,
        settlementFeatures: Object.freeze(settlementFeatures),
        canonicalSurfacePolicy,
      });
      const groundPosition = position => Object.freeze({
        ...position,
        y: q6(sampleW8SurfaceHeightMeters(surfaceBackedChunk, position.x, position.z)),
      });
      const settlementGroundPosition = position => Object.freeze({
        ...position,
        y: q6(sampleW8SurfaceHeightMeters(localSurfaceBackedChunk, position.x, position.z)),
      });
      const reground = record => Object.freeze({
        ...record,
        worldPosition: groundPosition(record.worldPosition),
      });
      const groundedSettlementFeatures = settlementFeatures.map(record => Object.freeze({
        ...record,
        worldPosition: settlementGroundPosition(record.worldPosition),
      }));
      const groundedOverlayFeatures = groundedSettlementFeatures.filter(feature => feature.parityOverlay);
      const parityGameplayChunk = Object.freeze({
        ...surfaceBackedChunk,
        vegetationCandidates: surfaceBackedChunk.vegetationCandidates,
        rockCandidates: surfaceBackedChunk.rockCandidates,
        settlementFeatures: Object.freeze(groundedSettlementFeatures),
      });
      const [naturalWater, ambientDetailsRaw, distributedLandmarks, streetDetailsRaw] = await Promise.all([
        createWaterSurfaces(parityGameplayChunk, base.worldSeedHash),
        createAmbientDetails(parityGameplayChunk, seed, base.worldSeedHash),
        createSettlementLandmarks(parityGameplayChunk, seed, base.worldSeedHash),
        createStreetDetails(parityGameplayChunk, base.worldSeedHash),
      ]);
      const naturalWaterWithoutRiverOverlap = naturalWater.filter(surface => {
        const river = distanceToCanonicalRiverCenterline(
          canonicalSurfacePolicy.riverCorridors,
          surface.worldPosition.x,
          surface.worldPosition.z,
        );
        return !river.corridor
          || river.distanceMeters > river.corridor.bankExtentMeters;
      });
      const waterSurfaces = [
        ...naturalWaterWithoutRiverOverlap
        .map(surface => Object.freeze({
          ...surface,
          worldPosition: Object.freeze({
            ...groundPosition(surface.worldPosition),
            y: q6(groundPosition(surface.worldPosition).y + 0.0125),
          }),
        })),
        ...(riverProjection.waterSurface ? [riverProjection.waterSurface] : []),
      ].sort((left, right) => left.stableId.localeCompare(right.stableId));
      const ambientDetails = ambientDetailsRaw.filter(detail => {
        const river = distanceToCanonicalRiverCenterline(
          canonicalSurfacePolicy.riverCorridors,
          detail.worldPosition.x,
          detail.worldPosition.z,
        );
        return !river.corridor
          || river.distanceMeters > river.corridor.widthMeters / 2 + 0.2;
      }).map(reground)
        .sort((left, right) => left.stableId.localeCompare(right.stableId));
      const settlementLandmarks = distributedLandmarks
        .map(reground).sort((left, right) => left.stableId.localeCompare(right.stableId));
      for (const reference of settlementReferences) {
        const diagnostic = settlementDiagnostics.get(reference.settlementId);
        if (!diagnostic) continue;
        const landmarkCount = settlementLandmarks.filter(value =>
          value.parentSettlementId === reference.settlementId).length;
        settlementDiagnostics.set(reference.settlementId, Object.freeze({
          ...diagnostic,
          landmarkCount: Math.max(diagnostic.landmarkCount ?? 0, landmarkCount),
        }));
      }
      const streetDetails = streetDetailsRaw.map(reground)
        .sort((left, right) => left.stableId.localeCompare(right.stableId));
      const chunkId = createChunkId({
        worldSeedHash: base.worldSeedHash,
        generatorMajor: W8_PARITY_GENERATOR_VERSION.major,
        chunkCoordinate: { x: chunkX, z: chunkZ },
      });
      const presentationLayers = createPresentationLayers(parityGameplayChunk, {
        waterSurfaces, ambientDetails, settlementLandmarks, streetDetails,
      }, experienceSpawn, naturalPresentationPolicy);
      const content = {
        ...parityGameplayChunk,
        schemaVersion: W8_PARITY_CHUNK_DATA_SCHEMA,
        chunkId,
        generatorVersion: { ...W8_PARITY_GENERATOR_VERSION },
        sourceW5ContentHash: sourceChunkData.contentHash,
        sourceChunkData,
        settlementOverlayFeatures: Object.freeze(groundedOverlayFeatures),
        waterSurfaces,
        ambientDetails,
        settlementLandmarks,
        streetDetails,
        riverRoadCrossings: riverProjection.roadCrossings,
        riverPorts: riverProjection.ports,
        presentationLayers,
        generationProof: Object.freeze({
          generator: 'w8-finite-experience-parity',
          sourceW5ContentHash: sourceChunkData.contentHash,
          finiteExperienceSourceCommit: 'f8bc9f80c2af417bb585bff26c99522c4229ab8e',
          finiteExperienceConnected: true,
          distributedSettlementSurfacePolicyConnected: true,
          canonicalRiverCorridorConnected: true,
        }),
      };
      const chunk = Object.freeze({ ...content, contentHash: await hashW8ParityChunkContent(content) });
      const validation = validateW8ParityChunkData(chunk);
      if (!validation.valid) throw new Error(`invalid W8 ChunkData: ${validation.errors.join('; ')}`);
      return chunk;
    },
    snapshot: () => {
      const source = base.snapshot?.() ?? null;
      return Object.freeze({
        ...(source ?? {}),
        schemaVersion: W8_PARITY_CONTENT.schemaVersion,
        source,
        safeSpawnPreparedChunkCount: experienceSpawn.spawnSafety?.preparedChunkKeys?.length ?? 0,
        safeSpawn: experienceSpawn.spawnSafety ?? null,
        warmSourceChunkCacheSize: warmSourceChunks.size,
        warmSourceChunkCacheCapacity: warmSourceChunkCapacity,
        warmSourceChunkPendingCount: pendingSourceChunks.size,
        canonicalMajorRoad: Object.freeze({
          schemaVersion: W8_CANONICAL_MAJOR_ROAD.schemaVersion,
          widthMeters: W8_CANONICAL_MAJOR_ROAD.widthMeters,
          graphCacheSize: majorRoadGraphCache.size,
          routeCacheSize: majorRoadRouteCache.size,
          obstacleCacheSize: majorRoadObstacleCache.size,
          preparationCacheSize: majorRoadPreparationCache.size,
          sourceHashCacheSize: majorRoadSourceHashCache.size,
          ...majorRoadDiagnostics,
        }),
        observedSettlementDiagnostics: Object.freeze([...settlementDiagnostics.values()]
          .sort((left, right) => left.settlementId.localeCompare(right.settlementId))
          .map(value => Object.freeze({
            ...value,
            nearestObservedSettlementDistanceMeters: Math.min(
              ...[...settlementDiagnostics.values()]
                .filter(other => other.settlementId !== value.settlementId)
                .map(other => Math.hypot(
                  value.center.x - other.center.x,
                  value.center.z - other.center.z,
                )),
              Infinity,
            ),
          }))),
      });
    },
  });
}
