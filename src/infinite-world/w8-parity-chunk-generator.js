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
import {
  W5_CHUNK_DATA_SCHEMA,
  createDistributedSettlementChunkGenerator,
} from './distributed-settlement-chunk-generator.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { createChunkId } from './legacy-core/g0/chunk-id.js';
import { createWorldFeatureId } from './legacy-core/g0/stable-id.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { parseGeneratorVersion } from './legacy-core/g0/generator-version.js';
import { sampleFormalTerrainHeightMeters } from './player-vertical-movement.js';
import { FINITE_WORLD_UNITS_PER_METER } from './single-rural-settlement.js';
import { createW8SettlementParityOverlay } from './w8-settlement-parity-overlay.js';

export const W8_PARITY_GENERATOR_VERSION = parseGeneratorVersion('800.0.0');
export const W8_PARITY_CHUNK_DATA_SCHEMA = 'w8-finite-experience-parity-chunk-data-1';
export const W8_PARITY_CONTENT = Object.freeze({
  schemaVersion: 'w8-finite-experience-content-1',
  ambientCellSizeMeters: 2,
  maximumAmbientDetailsPerChunk: 48,
  maximumWaterSurfacesPerChunk: 24,
  wetlandMoistureThreshold: 0.64,
  streetSlotsPerRoadProjection: 2,
  landmarkByTownType: Object.freeze({
    military: 'militaryBase',
    residential: 'barn',
    suburb: 'factory',
  }),
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

export function sampleW8SurfaceHeightMeters(chunkData, logicalWorldX, logicalWorldZ) {
  const source = chunkData?.sourceChunkData ?? chunkData;
  if (!source?.terrain) throw new TypeError('W5-backed ChunkData is required');
  return sampleFormalTerrainHeightMeters(source, logicalWorldX, logicalWorldZ);
}

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

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

function createPresentationLayers(chunk, overlays, experienceSpawn) {
  const vegetation = (chunk.vegetationCandidates ?? []).filter(candidate => !conflictsWithPresentation(
    candidate.worldPosition,
    candidate.metadata?.candidateRadiusMeters ?? 0.625,
    chunk,
    { ...overlays, experienceSpawn },
  ));
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
    const landmarkType = W8_PARITY_CONTENT.landmarkByTownType[reference.townType];
    if (!landmarkType) continue;
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
      widthMeters: landmarkType === 'militaryBase' ? 11 : landmarkType === 'factory' ? 9 : 7,
      heightMeters: landmarkType === 'militaryBase' ? 6 : landmarkType === 'factory' ? 8 : 5,
      depthMeters: landmarkType === 'militaryBase' ? 11 : landmarkType === 'factory' ? 8 : 7,
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
  const roads = (chunk.settlementFeatures ?? []).filter(feature => feature.featureType === 'settlement-road');
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
    waterSurfaceIds: content.waterSurfaces.map(value => value.stableId),
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
  const seed = textSeed(`${base.worldSeedHash}:${W8_PARITY_CONTENT.schemaVersion}`);
  const warmSourceChunks = new Map();
  const pendingSourceChunks = new Map();
  const settlementOverlayTemplates = new Map();
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
    if (!settlementOverlayTemplates.has(reference.settlementId)) {
      const pending = createW8SettlementParityOverlay({
        worldSeedHash: base.worldSeedHash,
        candidate: {
          settlementId: reference.settlementId,
          settlementType: reference.settlementType,
          townType: reference.townType,
          macroRegion: reference.macroRegion,
          center: reference.center,
          urbanization: reference.urbanization,
          terrainSuitability: reference.terrainSuitability,
        },
      });
      settlementOverlayTemplates.set(reference.settlementId, pending);
    }
    return settlementOverlayTemplates.get(reference.settlementId);
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
    experienceSpawn = Object.freeze({
      ...experienceSpawn,
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
      });
      const settlementFeatures = [
        ...(sourceChunkData.settlementFeatures ?? []),
        ...settlementOverlayFeatures,
      ].sort((left, right) => left.stableId.localeCompare(right.stableId));
      const parityGameplayChunk = Object.freeze({
        ...sourceChunkData,
        settlementReferences: Object.freeze(settlementReferences),
        settlementFeatures: Object.freeze(settlementFeatures),
      });
      const [waterSurfaces, ambientDetails, settlementLandmarks, streetDetails] = await Promise.all([
        createWaterSurfaces(parityGameplayChunk, base.worldSeedHash),
        createAmbientDetails(parityGameplayChunk, seed, base.worldSeedHash),
        createSettlementLandmarks(parityGameplayChunk, seed, base.worldSeedHash),
        createStreetDetails(parityGameplayChunk, base.worldSeedHash),
      ]);
      const chunkId = createChunkId({
        worldSeedHash: base.worldSeedHash,
        generatorMajor: W8_PARITY_GENERATOR_VERSION.major,
        chunkCoordinate: { x: chunkX, z: chunkZ },
      });
      const presentationLayers = createPresentationLayers(parityGameplayChunk, {
        waterSurfaces, ambientDetails, settlementLandmarks, streetDetails,
      }, experienceSpawn);
      const content = {
        ...parityGameplayChunk,
        schemaVersion: W8_PARITY_CHUNK_DATA_SCHEMA,
        chunkId,
        generatorVersion: { ...W8_PARITY_GENERATOR_VERSION },
        sourceW5ContentHash: sourceChunkData.contentHash,
        sourceChunkData,
        settlementOverlayFeatures,
        waterSurfaces,
        ambientDetails,
        settlementLandmarks,
        streetDetails,
        presentationLayers,
        generationProof: Object.freeze({
          generator: 'w8-finite-experience-parity',
          sourceW5ContentHash: sourceChunkData.contentHash,
          finiteExperienceSourceCommit: 'f8bc9f80c2af417bb585bff26c99522c4229ab8e',
          finiteExperienceConnected: true,
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
      });
    },
  });
}
