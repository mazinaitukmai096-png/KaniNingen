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
import { createPresentationOwnerGenerator } from './presentation-owner-generator.js';
import { ROAD_GRAPH_V1_GENERATOR_ID } from './road-graph-v1.js';
import { ROAD_GRAPH_V1_SETTLEMENT_TEMPLATE_SCHEMA } from './road-graph-v1-settlement-adapter.js';
import { ROAD_GRAPH_V2_GENERATOR_ID } from './road-graph-v2.js';
import { ROAD_GRAPH_V2_SETTLEMENT_TEMPLATE_SCHEMA } from './road-graph-v2-settlement-adapter.js';
import { ROAD_GRAPH_V3_GENERATOR_ID } from './road-graph-v3.js';
import {
  ROAD_GRAPH_V3_LOT_V1_SETTLEMENT_TEMPLATE_SCHEMA,
  ROAD_GRAPH_V3_LOT_V2_SETTLEMENT_TEMPLATE_SCHEMA,
  ROAD_GRAPH_V3_SETTLEMENT_TEMPLATE_SCHEMA,
} from './road-graph-v3-settlement-adapter.js';
import { SETTLEMENT_LOT_V1_GENERATOR_ID } from './settlement-lot-v1.js';
import { SETTLEMENT_LOT_V2_GENERATOR_ID } from './settlement-lot-v2.js';
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
import {
  W8_NATURAL_PRESENTATION_PHASE_1,
  createW8NaturalPresentationPhase1Policy,
} from './w8-natural-presentation-policy.js';
import { createHashedW8ForestHorizonManifest } from './forest-horizon-manifest.js';
import { createCanonicalOwnerCache } from './canonical-owner-cache.js';
import { createPresentationManifestCache } from './presentation-manifest-cache.js';
import {
  CHUNK_GENERATION_STAGE,
  measureChunkGenerationStage,
  measureChunkGenerationStageSync,
} from './chunk-generation-stage-timing.js';
import {
  composeW8SettlementPresentationTemplate,
  createW8SettlementParityOverlay,
} from './w8-settlement-parity-overlay.js';
import {
  W8_CANONICAL_NATURAL_GROUND_REVISION,
  createSettlementSurfacePolicy,
  resolveCanonicalSettlementGroundSurface,
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
  enumerateCanonicalMajorRoadOwnerCoordinates,
  graphEdgesPotentiallyIntersectChunk,
  projectCanonicalMajorRoadsToChunk,
} from './canonical-major-road-network.js';
import {
  ROAD_GENERATION_COUNTER,
  ROAD_GENERATION_SPAN,
  ROAD_GENERATION_WARMTH,
} from './road-generation-timing.js';

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
// The 875 m Settlement horizon spans at most 16 of the 768 m Macro Regions;
// graph history keeps the current and previous footprints. Settlement-derived
// entries match the W5 template bound, while 256 Road entries exceed one
// graph's 49-region x 3-edge theoretical working set (147).
export const W8_PARITY_CACHE_CAPACITIES = Object.freeze({
  canonicalOwner: 256,
  presentationManifest: 320,
  warmSourceChunk: 256,
  settlementOverlay: 128,
  settlementDiagnostics: 128,
  majorRoadGraph: 32,
  majorRoadRoute: 256,
  majorRoadObstacle: 128,
  majorRoadPreparation: 256,
  majorRoadSourceHash: 128,
});
// A service generation owns one seed; fallback reuses that same seed.
const EXPERIENCE_SPAWN_CACHE_CAPACITY = 1;
const EXPERIENCE_SPAWN_CACHE = new Map();

function setLruValue(map, key, value, capacity) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > capacity) map.delete(map.keys().next().value);
  return value;
}

function getLruValue(map, key) {
  if (!map.has(key)) return undefined;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
  return value;
}

export function createPendingSafeLruCache({ capacity, onRemove = null } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('pending-safe LRU capacity must be a positive safe integer');
  }
  if (onRemove !== null && typeof onRemove !== 'function') {
    throw new TypeError('pending-safe LRU onRemove must be a function');
  }
  const entries = new Map();
  let closed = false;
  let evictionCount = 0;

  const removeEntry = (key, reason) => {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    if (reason === 'capacity') evictionCount += 1;
    onRemove?.(key, entry.meta, reason);
    return true;
  };
  const trim = () => {
    while (entries.size > capacity) {
      let found = false;
      let evictionKey;
      for (const [key, entry] of entries) {
        if (entry.pending) continue;
        found = true;
        evictionKey = key;
        break;
      }
      if (!found) break;
      removeEntry(evictionKey, 'capacity');
    }
  };
  const get = key => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    entries.delete(key);
    entries.set(key, entry);
    return entry.promise;
  };
  const getOrCreate = (key, loader, meta = null) => {
    if (closed) throw new Error('pending-safe LRU cache is closed');
    if (typeof loader !== 'function') throw new TypeError('pending-safe LRU loader is required');
    if (entries.has(key)) return get(key);
    let promise;
    try {
      promise = Promise.resolve(loader());
    } catch (error) {
      return Promise.reject(error);
    }
    const entry = { promise, pending: true, meta };
    entries.set(key, entry);
    void promise.then(
      () => {
        if (closed || entries.get(key) !== entry) return;
        entry.pending = false;
        trim();
      },
      () => {
        if (entries.get(key) === entry) removeEntry(key, 'rejected');
      },
    );
    trim();
    return promise;
  };

  return Object.freeze({
    getOrCreate,
    get,
    has: key => entries.has(key),
    delete: key => removeEntry(key, 'deleted'),
    close() {
      if (closed) return;
      closed = true;
      for (const key of [...entries.keys()]) removeEntry(key, 'closed');
    },
    snapshot: () => Object.freeze({
      capacity,
      size: entries.size,
      pendingCount: [...entries.values()].filter(entry => entry.pending).length,
      evictionCount,
      closed,
    }),
    get capacity() { return capacity; },
    get size() { return entries.size; },
    get pendingCount() {
      return [...entries.values()].filter(entry => entry.pending).length;
    },
    get evictionCount() { return evictionCount; },
    get closed() { return closed; },
  });
}

function resolveW8CacheCapacities(overrides) {
  if (overrides === undefined) return W8_PARITY_CACHE_CAPACITIES;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('cacheCapacities must be an object');
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(W8_PARITY_CACHE_CAPACITIES, key)) {
      throw new RangeError(`unknown W8 cache capacity: ${key}`);
    }
  }
  const resolved = { ...W8_PARITY_CACHE_CAPACITIES, ...overrides };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${key} cache capacity must be a positive safe integer`);
    }
  }
  return Object.freeze(resolved);
}
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

function createNaturalPresentationLayer(
  chunk,
  { waterSurfaces, settlementLandmarks },
  experienceSpawn,
  naturalPresentationPolicy,
  settlementDensityReferences = chunk.settlementReferences,
) {
  const compatibleVegetation = (chunk.vegetationCandidates ?? []).filter(candidate => !conflictsWithPresentation(
    candidate.worldPosition,
    candidate.metadata?.candidateRadiusMeters ?? 0.625,
    chunk,
    { waterSurfaces, settlementLandmarks, experienceSpawn },
  ));
  const vegetation = naturalPresentationPolicy.selectVegetation({
    candidates: compatibleVegetation,
    settlementReferences: settlementDensityReferences,
    experienceSpawn,
    introDistanceMeters: W8_SPAWN_SAFETY_CONTRACT.introDistanceMeters,
  });
  const rocks = (chunk.rockCandidates ?? []).filter(candidate => !conflictsWithPresentation(
    candidate.worldPosition,
    candidate.metadata?.candidateRadiusMeters ?? 0.45,
    chunk,
    { waterSurfaces, settlementLandmarks, experienceSpawn },
  ));
  return Object.freeze({
    vegetation: Object.freeze(vegetation),
    rocks: Object.freeze(rocks),
    excludedVegetationCount: (chunk.vegetationCandidates?.length ?? 0) - vegetation.length,
    excludedRockCount: (chunk.rockCandidates?.length ?? 0) - rocks.length,
  });
}

function createPresentationLayers(
  chunk,
  overlays,
  experienceSpawn,
  naturalPresentationPolicy,
  natural = createNaturalPresentationLayer(
    chunk,
    overlays,
    experienceSpawn,
    naturalPresentationPolicy,
  ),
) {
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
    natural,
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
        // Ambient Grass/Flower/Bush are visual decoration only.
        destructible: false,
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

async function createSettlementLandmarks(
  chunk,
  seed,
  worldSeedHash,
  { sampleHeightMeters = null } = {},
) {
  const sampleHeight = sampleHeightMeters
    ?? ((worldX, worldZ) => sampleFormalTerrainHeightMeters(chunk, worldX, worldZ));
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
        y: q6(sampleHeight(x, z)),
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
            y: q6(sampleHeight(secondary.x, secondary.z)),
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

async function createStreetDetails(
  chunk,
  worldSeedHash,
  { sampleHeightMeters = null } = {},
) {
  const sampleHeight = sampleHeightMeters
    ?? ((worldX, worldZ) => sampleFormalTerrainHeightMeters(chunk, worldX, worldZ));
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
          y: q6(sampleHeight(x, z)),
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

export async function hashW8ParityChunkContent(content, { stageRecorder = null } = {}) {
  const serialize = () => canonicalizeJson({
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
  });
  const serialized = stageRecorder
    ? measureChunkGenerationStageSync(
      stageRecorder,
      CHUNK_GENERATION_STAGE.SERIALIZE,
      serialize,
    )
    : serialize();
  const digest = stageRecorder
    ? await measureChunkGenerationStage(
      stageRecorder,
      CHUNK_GENERATION_STAGE.HASH,
      () => sha256Hex(serialized),
    )
    : await sha256Hex(serialized);
  return `sha256:${digest}`;
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
  cacheCapacities: cacheCapacityOverrides,
  settlementRoadGraphGeneratorId = null,
  settlementLotMode = null,
} = {}) {
  if (settlementRoadGraphGeneratorId !== null
    && settlementRoadGraphGeneratorId !== ROAD_GRAPH_V1_GENERATOR_ID
    && settlementRoadGraphGeneratorId !== ROAD_GRAPH_V2_GENERATOR_ID
    && settlementRoadGraphGeneratorId !== ROAD_GRAPH_V3_GENERATOR_ID) {
    throw new RangeError(`unsupported experimental Settlement Road Graph: ${settlementRoadGraphGeneratorId}`);
  }
  const useRoadGraphV1 = settlementRoadGraphGeneratorId === ROAD_GRAPH_V1_GENERATOR_ID;
  const useRoadGraphV2 = settlementRoadGraphGeneratorId === ROAD_GRAPH_V2_GENERATOR_ID;
  const useRoadGraphV3 = settlementRoadGraphGeneratorId === ROAD_GRAPH_V3_GENERATOR_ID;
  const useExperimentalRoadGraph = useRoadGraphV1 || useRoadGraphV2 || useRoadGraphV3;
  if (settlementLotMode !== null
    && settlementLotMode !== SETTLEMENT_LOT_V1_GENERATOR_ID
    && settlementLotMode !== SETTLEMENT_LOT_V2_GENERATOR_ID) {
    throw new RangeError(`unsupported experimental Settlement Lot mode: ${settlementLotMode}`);
  }
  if ((settlementLotMode === SETTLEMENT_LOT_V1_GENERATOR_ID
    || settlementLotMode === SETTLEMENT_LOT_V2_GENERATOR_ID) && !useRoadGraphV3) {
    throw new RangeError(`${settlementLotMode} requires settlementRoadGraphGeneratorId=road-graph-v3`);
  }
  const cacheCapacities = resolveW8CacheCapacities(cacheCapacityOverrides);
  const base = await baseGeneratorFactory({
    worldSeed,
    ...(useExperimentalRoadGraph ? { settlementRoadGraphGeneratorId } : {}),
    ...(settlementLotMode ? { settlementLotMode } : {}),
  });
  const naturalPresentationPolicy = await createW8NaturalPresentationPhase1Policy({
    worldSeedHash: base.worldSeedHash,
  });
  const seed = textSeed(`${base.worldSeedHash}:${W8_PARITY_CONTENT.schemaVersion}`);
  const warmSourceChunks = new Map();
  const pendingSourceChunks = new Map();
  const settlementDiagnostics = new Map();
  const settlementOverlayCandidateIdentities = new Map();
  const majorRoadRouteKeyByEdge = new Map();
  const majorRoadObstacleKeyBySettlement = new Map();
  const settlementOverlayTemplates = createPendingSafeLruCache({
    capacity: cacheCapacities.settlementOverlay,
    onRemove: settlementId => {
      settlementDiagnostics.delete(settlementId);
      settlementOverlayCandidateIdentities.delete(settlementId);
    },
  });
  const majorRoadGraphCache = createPendingSafeLruCache({
    capacity: cacheCapacities.majorRoadGraph,
  });
  const majorRoadRouteCache = createPendingSafeLruCache({
    capacity: cacheCapacities.majorRoadRoute,
    onRemove: (cacheKey, edgeStableId) => {
      if (majorRoadRouteKeyByEdge.get(edgeStableId) === cacheKey) {
        majorRoadRouteKeyByEdge.delete(edgeStableId);
      }
    },
  });
  const majorRoadObstacleCache = createPendingSafeLruCache({
    capacity: cacheCapacities.majorRoadObstacle,
    onRemove: (cacheKey, settlementStableId) => {
      if (majorRoadObstacleKeyBySettlement.get(settlementStableId) === cacheKey) {
        majorRoadObstacleKeyBySettlement.delete(settlementStableId);
      }
    },
  });
  const majorRoadPreparationCache = createPendingSafeLruCache({
    capacity: cacheCapacities.majorRoadPreparation,
  });
  const majorRoadSourceHashCache = createPendingSafeLruCache({
    capacity: cacheCapacities.majorRoadSourceHash,
  });
  const canonicalSourceRevision = `${base.worldSeedHash}:${W8_PARITY_GENERATOR_VERSION.major}:${W8_CANONICAL_NATURAL_GROUND_REVISION}:${naturalPresentationPolicy.schemaVersion}`;
  const canonicalOwnerCache = createCanonicalOwnerCache({
    capacity: cacheCapacities.canonicalOwner,
    identityOf: context => Object.freeze({
      chunkId: context.chunkId,
      contentHash: context.sourceChunkData.contentHash,
    }),
  });
  const presentationManifestCache = createPresentationManifestCache({
    capacity: cacheCapacities.presentationManifest,
  });
  let isShutdown = false;
  const resourceGenerationCounts = {
    fullChunkRequests: 0,
    fullChunkCompleted: 0,
    presentationOwnerRequests: 0,
    presentationOwnerCompleted: 0,
    canonicalTreeCellRequests: 0,
    canonicalTreeCellCompleted: 0,
    forestHorizonManifestRequests: 0,
    forestHorizonManifestCompleted: 0,
  };
  const assertGeneratorActive = () => {
    if (isShutdown) throw new Error('W8 parity Chunk generator is shut down');
  };
  const nowMs = () => globalThis.performance?.now?.() ?? Date.now();
  const measureRoadSpan = (roadTimingRun, span, operation) => (
    roadTimingRun ? roadTimingRun.measure(span, operation) : operation()
  );
  const measureRoadSpanSync = (roadTimingRun, span, operation) => (
    roadTimingRun ? roadTimingRun.measureSync(span, operation) : operation()
  );
  const recordRoadFunction = (roadTimingRun, name, startedAt) => {
    if (!roadTimingRun || !Number.isFinite(startedAt)) return;
    roadTimingRun.recordFunction?.(name, Math.max(0, nowMs() - startedAt));
  };
  const recordRoadCache = (roadTimingContext, hit) => {
    const roadTimingRun = roadTimingContext?.run ?? null;
    if (!roadTimingRun) return;
    if (hit) roadTimingRun.recordCacheHit();
    else {
      roadTimingRun.recordCacheMiss();
      roadTimingContext.cold = true;
    }
  };
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
  const warmSourceChunkCapacity = cacheCapacities.warmSourceChunk;
  const trimWarmSourceChunks = () => {
    while (warmSourceChunks.size > warmSourceChunkCapacity) {
      warmSourceChunks.delete(warmSourceChunks.keys().next().value);
    }
  };
  const getSourceChunk = async (chunkX, chunkZ, stageRecorder = null) => {
    if (isShutdown) throw new Error('W8 parity Chunk generator is shut down');
    const key = createChunkKey(chunkX, chunkZ);
    if (warmSourceChunks.has(key)) {
      const cached = warmSourceChunks.get(key);
      warmSourceChunks.delete(key);
      warmSourceChunks.set(key, cached);
      return cached;
    }
    if (pendingSourceChunks.has(key)) return pendingSourceChunks.get(key);
    const source = stageRecorder
      ? base.generateChunk(chunkX, chunkZ, { stageRecorder })
      : base.generateChunk(chunkX, chunkZ);
    const pending = Promise.resolve(source).then(
      chunk => {
        pendingSourceChunks.delete(key);
        if (!isShutdown) {
          warmSourceChunks.set(key, chunk);
          trimWarmSourceChunks();
        }
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
  const assertCanonicalCandidateField = (settlementId, field, actual, expected) => {
    if (canonicalizeJson(actual) === canonicalizeJson(expected)) return;
    throw new Error(`canonical Settlement candidate mismatch for ${settlementId}: ${field}`);
  };
  const snapshotSettlementTemplateCandidate = candidate => Object.freeze({
    settlementId: candidate?.settlementId,
    settlementType: candidate?.settlementType,
    townType: candidate?.townType,
    macroRegion: candidate?.macroRegion && typeof candidate.macroRegion === 'object'
      ? Object.freeze({ ...candidate.macroRegion })
      : candidate?.macroRegion,
    center: candidate?.center && typeof candidate.center === 'object'
      ? Object.freeze({ ...candidate.center })
      : candidate?.center,
    radiusMeters: candidate?.radiusMeters,
    urbanization: candidate?.urbanization,
    terrainSuitability: candidate?.terrainSuitability,
  });
  const resolveCanonicalCandidateAt = async (settlementId, center, ownerRegion = null) => {
    if (typeof settlementId !== 'string' || settlementId.length === 0
      || ![center?.x, center?.z].every(Number.isFinite)) {
      throw new TypeError('canonical Settlement candidate identity and center are required');
    }
    let matches = await base.distributor.findSettlementCentersNear(
      center.x,
      center.z,
      0,
    );
    let candidate = matches.find(value => value.settlementId === settlementId);
    if (!candidate && Number.isSafeInteger(ownerRegion?.x)
      && Number.isSafeInteger(ownerRegion?.z)) {
      const regionSize = W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters;
      matches = await base.distributor.findSettlementCentersNear(
        (ownerRegion.x + 0.5) * regionSize,
        (ownerRegion.z + 0.5) * regionSize,
        Math.SQRT2 * regionSize,
      );
      candidate = matches.find(value => value.settlementId === settlementId);
    }
    if (!candidate) {
      throw new Error(`canonical Settlement candidate not found for ${settlementId}`);
    }
    if (typeof candidate.settlementType !== 'string'
      || typeof candidate.townType !== 'string'
      || !Number.isSafeInteger(candidate.macroRegion?.x)
      || !Number.isSafeInteger(candidate.macroRegion?.z)
      || ![candidate.center?.x, candidate.center?.z, candidate.radiusMeters,
        candidate.urbanization, candidate.terrainSuitability].every(Number.isFinite)
      || candidate.radiusMeters <= 0) {
      throw new Error(`invalid canonical Settlement candidate for ${settlementId}`);
    }
    assertCanonicalCandidateField(settlementId, 'center', candidate.center, center);
    return candidate;
  };
  const hasCompleteSettlementTemplateMetadata = reference => (
    typeof reference?.settlementId === 'string'
      && reference.settlementId.length > 0
      && typeof reference.settlementType === 'string'
      && reference.settlementType.length > 0
      && typeof reference.townType === 'string'
      && reference.townType.length > 0
      && Number.isSafeInteger(reference.macroRegion?.x)
      && Number.isSafeInteger(reference.macroRegion?.z)
      && [reference.center?.x, reference.center?.z, reference.radiusMeters,
        reference.urbanization, reference.terrainSuitability].every(Number.isFinite)
      && reference.radiusMeters > 0
  );
  const resolveSettlementTemplateCandidate = async reference => {
    if (!reference) return null;
    const referenceSnapshot = snapshotSettlementTemplateCandidate(reference);
    if (hasCompleteSettlementTemplateMetadata(referenceSnapshot)) return referenceSnapshot;
    const candidate = await resolveCanonicalCandidateAt(
      referenceSnapshot.settlementId,
      referenceSnapshot.center,
      referenceSnapshot.macroRegion,
    );
    for (const [field, expected] of [
      ['settlementType', candidate.settlementType],
      ['townType', candidate.townType],
      ['macroRegion', candidate.macroRegion],
      ['center', candidate.center],
      ['radiusMeters', candidate.radiusMeters],
      ['urbanization', candidate.urbanization],
      ['terrainSuitability', candidate.terrainSuitability],
    ]) {
      if (!Object.hasOwn(referenceSnapshot, field)
        || referenceSnapshot[field] === null
        || referenceSnapshot[field] === undefined) continue;
      assertCanonicalCandidateField(
        candidate.settlementId,
        field,
        referenceSnapshot[field],
        expected,
      );
    }
    return snapshotSettlementTemplateCandidate(candidate);
  };
  const resolveCanonicalCandidateFromGraphNode = async node => {
    const candidate = await resolveCanonicalCandidateAt(
      node?.stableId,
      node?.center,
      node?.ownerRegion,
    );
    for (const [field, actual, expected] of [
      ['settlementType', node.settlementType, candidate.settlementType],
      ['role', node.role, candidate.townType],
      ['ownerRegion', node.ownerRegion, candidate.macroRegion],
      ['center', node.center, candidate.center],
      ['radiusMeters', node.radiusMeters, candidate.radiusMeters],
    ]) {
      assertCanonicalCandidateField(candidate.settlementId, field, actual, expected);
    }
    return candidate;
  };
  const getCanonicalSettlementOverlay = async (candidate, roadTimingContext = null) => {
    if (!candidate) return null;
    candidate = snapshotSettlementTemplateCandidate(candidate);
    const roadTimingRun = roadTimingContext?.run ?? null;
    const candidateIdentity = canonicalizeJson({
      settlementId: candidate.settlementId,
      settlementType: candidate.settlementType,
      townType: candidate.townType,
      macroRegion: candidate.macroRegion,
      center: candidate.center,
      radiusMeters: candidate.radiusMeters,
      urbanization: candidate.urbanization,
      terrainSuitability: candidate.terrainSuitability,
    });
    const previousCandidateIdentity = settlementOverlayCandidateIdentities
      .get(candidate.settlementId);
    if (previousCandidateIdentity && previousCandidateIdentity !== candidateIdentity) {
      throw new Error(
        `Settlement overlay candidate identity conflict for ${candidate.settlementId}`,
      );
    }
    majorRoadDiagnostics.settlementTemplateRequests += 1;
    // A resident overlay identity is checked before touching the source cache.
    // Once accepted, resolve through the source cache so its finite/signature
    // guard remains authoritative even for W8 overlay hits.
    const sourceStartedAt = nowMs();
    const sourceTemplate = await base.resolveSettlementTemplate({
      candidate,
      roadTimingRun,
    });
    majorRoadDiagnostics.settlementSourceTemplateResolutionMs += nowMs() - sourceStartedAt;
    recordRoadFunction(roadTimingRun, 'settlement-template-resolution', sourceStartedAt);
    const overlayCacheLookupStartedAt = roadTimingRun ? nowMs() : null;
    const hasCachedOverlay = settlementOverlayTemplates.has(candidate.settlementId);
    recordRoadFunction(roadTimingRun, 'settlement-overlay-cache-lookup', overlayCacheLookupStartedAt);
    if (hasCachedOverlay) {
      majorRoadDiagnostics.settlementTemplateCacheHits += 1;
      recordRoadCache(roadTimingContext, true);
      settlementOverlayCandidateIdentities.set(candidate.settlementId, candidateIdentity);
      return settlementOverlayTemplates.get(candidate.settlementId);
    }
    majorRoadDiagnostics.settlementTemplateCacheMisses += 1;
    recordRoadCache(roadTimingContext, false);
    const overlayPromise = settlementOverlayTemplates.getOrCreate(
      candidate.settlementId,
      async () => {
        const startedAt = nowMs();
        const overlayStartedAt = nowMs();
        const overlay = await createW8SettlementParityOverlay({
          worldSeedHash: base.worldSeedHash,
          candidate,
          sourceTemplate,
          roadTimingRun,
        });
        majorRoadDiagnostics.settlementOverlayCompositionMs += nowMs() - overlayStartedAt;
        majorRoadDiagnostics.settlementOverlayGenerationMs += nowMs() - startedAt;
        recordRoadFunction(roadTimingRun, 'settlement-overlay-generation', overlayStartedAt);
        if (!isShutdown) {
          setLruValue(settlementDiagnostics, candidate.settlementId, Object.freeze({
            settlementId: candidate.settlementId,
            settlementType: candidate.settlementType,
            townType: candidate.townType,
            center: candidate.center,
            macroRegion: candidate.macroRegion,
            radiusMeters: candidate.radiusMeters,
            sourceBuildingCount: overlay.sourceBuildingCount,
            overlayBuildingCount: overlay.overlayBuildingCount,
            buildingCount: overlay.sourceBuildingCount + overlay.overlayBuildingCount,
          }), cacheCapacities.settlementDiagnostics);
        }
        return overlay;
      },
    );
    settlementOverlayCandidateIdentities.set(candidate.settlementId, candidateIdentity);
    return overlayPromise;
  };
  const getSettlementOverlay = async (reference, roadTimingContext = null) => (
    getCanonicalSettlementOverlay(
      await resolveSettlementTemplateCandidate(reference),
      roadTimingContext,
    )
  );
  const majorRoadSurfacePolicyVersion = 'w8-settlement-surface-policy-1';
  const majorRoadSourceContractVersion = useRoadGraphV3
    ? (settlementLotMode === SETTLEMENT_LOT_V1_GENERATOR_ID
      ? ROAD_GRAPH_V3_LOT_V1_SETTLEMENT_TEMPLATE_SCHEMA
      : settlementLotMode === SETTLEMENT_LOT_V2_GENERATOR_ID
        ? ROAD_GRAPH_V3_LOT_V2_SETTLEMENT_TEMPLATE_SCHEMA
        : ROAD_GRAPH_V3_SETTLEMENT_TEMPLATE_SCHEMA)
    : useRoadGraphV2
      ? ROAD_GRAPH_V2_SETTLEMENT_TEMPLATE_SCHEMA
    : useRoadGraphV1
      ? ROAD_GRAPH_V1_SETTLEMENT_TEMPLATE_SCHEMA
      : 'w5-migrated-settlement-template-1';
  const getMajorRoadSourceContentHash = (node, roadTimingContext = null) => {
    const roadTimingRun = roadTimingContext?.run ?? null;
    const cacheLookupStartedAt = roadTimingRun ? nowMs() : null;
    const hasCachedHash = majorRoadSourceHashCache.has(node.stableId);
    recordRoadFunction(roadTimingRun, 'road-source-hash-cache-lookup', cacheLookupStartedAt);
    if (hasCachedHash) {
      recordRoadCache(roadTimingContext, true);
      return majorRoadSourceHashCache.get(node.stableId);
    }
    recordRoadCache(roadTimingContext, false);
    return majorRoadSourceHashCache.getOrCreate(node.stableId, async () => {
      const startedAt = nowMs();
      const hash = await sha256Hex(canonicalizeJson({
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
      }));
      majorRoadDiagnostics.sourceContentHashCount += 1;
      majorRoadDiagnostics.sourceContentHashMs += nowMs() - startedAt;
      recordRoadFunction(roadTimingRun, 'road-source-hash', startedAt);
      return `sha256:${hash}`;
    });
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
  const getMajorRoadObstacles = async (node, sourceContentHash, roadTimingContext = null) => {
    const roadTimingRun = roadTimingContext?.run ?? null;
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
    const cacheLookupStartedAt = roadTimingRun ? nowMs() : null;
    const hasCachedObstacles = majorRoadObstacleCache.has(cacheKey);
    recordRoadFunction(roadTimingRun, 'road-obstacle-cache-lookup', cacheLookupStartedAt);
    if (hasCachedObstacles) {
      majorRoadDiagnostics.obstacleCacheHits += 1;
      recordRoadCache(roadTimingContext, true);
      return majorRoadObstacleCache.get(cacheKey);
    }
    majorRoadDiagnostics.obstacleCacheMisses += 1;
    recordRoadCache(roadTimingContext, false);
    return majorRoadObstacleCache.getOrCreate(cacheKey, async () => {
      const sourceStartedAt = nowMs();
      const candidate = await resolveCanonicalCandidateFromGraphNode(node);
      const overlay = await getCanonicalSettlementOverlay(candidate, roadTimingContext);
      majorRoadDiagnostics.obstacleSourceMs += nowMs() - sourceStartedAt;
      recordRoadFunction(roadTimingRun, 'road-obstacle-settlement-source', sourceStartedAt);
      const boundsStartedAt = nowMs();
      const presentation = composeW8SettlementPresentationTemplate(overlay);
      const obstacles = createCanonicalMajorRoadObstacles({
        buildings: presentation.buildings,
        landmarks: createMajorRoadLandmarkObstacles(candidate),
        preserveFrontageRoadId: useExperimentalRoadGraph,
      });
      majorRoadDiagnostics.obstacleBuildingCount += obstacles
        .filter(value => value.kind === 'BUILDING').length;
      majorRoadDiagnostics.obstacleLotCount += obstacles
        .filter(value => value.kind === 'LOT').length;
      majorRoadDiagnostics.obstacleLandmarkCount += obstacles
        .filter(value => value.kind === 'LANDMARK').length;
      majorRoadDiagnostics.obstacleBoundsBuildMs += nowMs() - boundsStartedAt;
      if (roadTimingRun) {
        roadTimingRun.addCounter(ROAD_GENERATION_COUNTER.SORT_DEDUPE_ITEMS, obstacles.length);
      }
      recordRoadFunction(roadTimingRun, 'road-obstacle-bounds', boundsStartedAt);
      return Object.freeze({
        obstacles,
        localRoads: Object.freeze([...presentation.roads]),
        gatewayHandoffs: Object.freeze([...(presentation.gatewayHandoffs ?? [])]),
      });
    }, node.stableId);
  };
  const prepareMajorRoadSource = async ({ edge, graph, roadTimingContext = null }) => {
    const roadTimingRun = roadTimingContext?.run ?? null;
    const cacheLookupStartedAt = roadTimingRun ? nowMs() : null;
    const preparationKey = canonicalizeJson({
      worldSeedHash: base.worldSeedHash,
      roadContractVersion: W8_CANONICAL_MAJOR_ROAD.schemaVersion,
      edgeStableId: edge.stableId,
      settlementIds: edge.settlementIds,
    });
    const hasCachedPreparation = majorRoadPreparationCache.has(preparationKey);
    recordRoadFunction(roadTimingRun, 'road-preparation-cache-lookup', cacheLookupStartedAt);
    if (hasCachedPreparation) {
      majorRoadDiagnostics.preparationCacheHits += 1;
      recordRoadCache(roadTimingContext, true);
      return majorRoadPreparationCache.get(preparationKey);
    }
    majorRoadDiagnostics.preparationCacheMisses += 1;
    recordRoadCache(roadTimingContext, false);
    return majorRoadPreparationCache.getOrCreate(preparationKey, async () => {
      const sourceStartedAt = roadTimingRun ? nowMs() : null;
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
      recordRoadFunction(roadTimingRun, 'road-settlement-corridor-query', queryStartedAt);
      const relevantFilterStartedAt = roadTimingRun ? nowMs() : null;
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
      recordRoadFunction(roadTimingRun, 'road-relevant-settlement-filter', relevantFilterStartedAt);
      const sourceHashes = await Promise.all(
        relevantNodes.map(node => getMajorRoadSourceContentHash(node, roadTimingContext)),
      );
      const resolved = await Promise.all(relevantNodes.map((node, index) => (
        getMajorRoadObstacles(node, sourceHashes[index], roadTimingContext)
      )));
      const sourceContentHashes = relevantNodes.map((node, index) => Object.freeze({
        settlementStableId: node.stableId,
        contentHash: sourceHashes[index],
      }));
      const canonicalizationStartedAt = roadTimingRun ? nowMs() : null;
      const prepared = Object.freeze({
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
        gatewayHandoffs: Object.freeze(resolved.flatMap(value => value.gatewayHandoffs)
          .sort((left, right) => (
            left.connectivityEdgeId.localeCompare(right.connectivityEdgeId)
              || left.gatewayStableId.localeCompare(right.gatewayStableId)
          ))),
      });
      if (roadTimingRun) {
        roadTimingRun.addCounter(
          ROAD_GENERATION_COUNTER.SORT_DEDUPE_ITEMS,
          prepared.obstacles.length + prepared.localRoads.length,
        );
      }
      recordRoadFunction(roadTimingRun, 'road-preparation-canonicalization', canonicalizationStartedAt);
      recordRoadFunction(roadTimingRun, 'road-preparation-build', sourceStartedAt);
      return prepared;
    });
  };
  const getMajorRoadForEdge = async (
    edge,
    graph,
    preparedSource = null,
    roadTimingContext = null,
  ) => {
    const roadTimingRun = roadTimingContext?.run ?? null;
    majorRoadDiagnostics.routeRequests += 1;
    const prepared = preparedSource ?? await prepareMajorRoadSource({
      edge,
      graph,
      roadTimingContext,
    });
    const previousKey = majorRoadRouteKeyByEdge.get(edge.stableId);
    if (previousKey && previousKey !== prepared.cacheKey) {
      majorRoadDiagnostics.routeStaleCacheRejections += 1;
    }
    majorRoadRouteKeyByEdge.set(edge.stableId, prepared.cacheKey);
    const routeCacheLookupStartedAt = roadTimingRun ? nowMs() : null;
    const hasCachedRoute = measureRoadSpanSync(
      roadTimingRun,
      ROAD_GENERATION_SPAN.CACHE_LOOKUP_BUILD,
      () => majorRoadRouteCache.has(prepared.cacheKey),
    );
    recordRoadFunction(roadTimingRun, 'road-route-cache-lookup', routeCacheLookupStartedAt);
    if (hasCachedRoute) {
      majorRoadDiagnostics.routeCacheHits += 1;
      recordRoadCache(roadTimingContext, true);
      return majorRoadRouteCache.get(prepared.cacheKey);
    }
    majorRoadDiagnostics.routeCacheMisses += 1;
    recordRoadCache(roadTimingContext, false);
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
      roadTimingRun?.recordFunction?.(`canonical-major-road:${name}`, durationMs);
      void details;
    };
    return majorRoadRouteCache.getOrCreate(prepared.cacheKey, async () => {
      const network = await measureRoadSpan(
        roadTimingRun,
        ROAD_GENERATION_SPAN.SEGMENT_CONNECTIONS_INTERSECTIONS,
        () => createCanonicalMajorRoadNetwork({
          worldSeedHash: base.worldSeedHash,
          graph: Object.freeze({ ...graph, edges: Object.freeze([edge]) }),
          resolveObstacles: () => prepared,
          timingObserver,
        }),
      );
      const road = network.roads[0];
      majorRoadDiagnostics.routesBuilt += 1;
      majorRoadDiagnostics.routeSegmentCount += road.segments.length;
      return road;
    }, edge.stableId);
  };
  const getMajorRoads = async (edges, graph, roadTimingContext = null) => {
    const roadTimingRun = roadTimingContext?.run ?? null;
    const preparationStartedAt = nowMs();
    let preparationMissCount = 0;
    const pendingPreparedSources = edges.map(async edge => {
      const routeCacheLookupStartedAt = roadTimingRun ? nowMs() : null;
      const cacheKey = majorRoadRouteKeyByEdge.get(edge.stableId);
      const hasCachedRoute = measureRoadSpanSync(
        roadTimingRun,
        ROAD_GENERATION_SPAN.CACHE_LOOKUP_BUILD,
        () => Boolean(cacheKey && majorRoadRouteCache.has(cacheKey)),
      );
      recordRoadFunction(roadTimingRun, 'road-route-key-cache-lookup', routeCacheLookupStartedAt);
      if (hasCachedRoute) {
        recordRoadCache(roadTimingContext, true);
        return Object.freeze({
          cachedRoadPromise: majorRoadRouteCache.get(cacheKey),
          prepared: null,
        });
      }
      preparationMissCount += 1;
      return Object.freeze({
        cachedRoadPromise: null,
        prepared: await prepareMajorRoadSource({ edge, graph, roadTimingContext }),
      });
    });
    const preparedSources = preparationMissCount > 0
      ? await measureRoadSpan(
        roadTimingRun,
        ROAD_GENERATION_SPAN.SETTLEMENT_PLAN,
        () => Promise.all(pendingPreparedSources),
      )
      : await Promise.all(pendingPreparedSources);
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
      const source = preparedSources[index];
      if (source.cachedRoadPromise) {
        majorRoadDiagnostics.routeRequests += 1;
        majorRoadDiagnostics.routeCacheHits += 1;
        const road = await source.cachedRoadPromise;
        roadTimingRun?.addCounter(ROAD_GENERATION_COUNTER.SEGMENTS, road.segments.length);
        roads.push(road);
      } else {
        const road = await getMajorRoadForEdge(edge, graph, source.prepared, roadTimingContext);
        roadTimingRun?.addCounter(ROAD_GENERATION_COUNTER.SEGMENTS, road.segments.length);
        roads.push(road);
      }
    }
    return roads;
  };
  const majorRoadGraphRadiusMeters = W5_SETTLEMENT_DISTRIBUTION
    .connectivity.queryRadiusMeters
      + W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters * Math.SQRT2 / 2;
  const getMajorRoadGraph = async (chunkX, chunkZ, roadTimingContext = null) => {
    const roadTimingRun = roadTimingContext?.run ?? null;
    majorRoadDiagnostics.graphRequests += 1;
    const graphInput = measureRoadSpanSync(
      roadTimingRun,
      ROAD_GENERATION_SPAN.SEED_INPUT,
      () => {
        const chunkCenterX = (chunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
        const chunkCenterZ = (chunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
        const regionX = Math.floor(
          chunkCenterX / W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters,
        );
        const regionZ = Math.floor(
          chunkCenterZ / W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters,
        );
        return Object.freeze({ regionX, regionZ, key: `${regionX},${regionZ}` });
      },
    );
    const graphCacheLookupStartedAt = roadTimingRun ? nowMs() : null;
    const hasCachedGraph = measureRoadSpanSync(
      roadTimingRun,
      ROAD_GENERATION_SPAN.CACHE_LOOKUP_BUILD,
      () => majorRoadGraphCache.has(graphInput.key),
    );
    recordRoadFunction(roadTimingRun, 'road-graph-cache-lookup', graphCacheLookupStartedAt);
    if (hasCachedGraph) {
      majorRoadDiagnostics.graphCacheHits += 1;
      recordRoadCache(roadTimingContext, true);
      return majorRoadGraphCache.get(graphInput.key);
    }
    majorRoadDiagnostics.graphCacheMisses += 1;
    recordRoadCache(roadTimingContext, false);
    return majorRoadGraphCache.getOrCreate(graphInput.key, async () => {
      const startedAt = nowMs();
      const graph = await measureRoadSpan(
        roadTimingRun,
        ROAD_GENERATION_SPAN.HIERARCHY_PARAMETERS,
        () => base.distributor.buildConnectivityGraphNear(
          (graphInput.regionX + 0.5) * W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters,
          (graphInput.regionZ + 0.5) * W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters,
          majorRoadGraphRadiusMeters,
        ),
      );
      majorRoadDiagnostics.graphsBuilt += 1;
      majorRoadDiagnostics.graphGenerationMs += nowMs() - startedAt;
      recordRoadFunction(roadTimingRun, 'settlement-connectivity-graph', startedAt);
      return graph;
    });
  };
  const projectMajorRoadFeaturesToOwner = ({
    chunkX,
    chunkZ,
    roads,
    surfaceBackedChunk,
    roadTimingContext = null,
    sampleGroundHeightOverride = null,
  }) => {
    const roadTimingRun = roadTimingContext?.run ?? null;
    const projectionStartedAt = nowMs();
    const sampleGroundHeight = (worldX, worldZ) => {
      const sampleStartedAt = roadTimingRun ? nowMs() : null;
      const sample = sampleGroundHeightOverride === null
        ? sampleW8SurfaceHeightMeters(surfaceBackedChunk, worldX, worldZ)
        : sampleGroundHeightOverride(worldX, worldZ);
      roadTimingRun?.addCounter(ROAD_GENERATION_COUNTER.TERRAIN_SAMPLES);
      recordRoadFunction(roadTimingRun, 'road-terrain-height-sample', sampleStartedAt);
      return sample;
    };
    const features = measureRoadSpanSync(
      roadTimingRun,
      ROAD_GENERATION_SPAN.SURFACE_METADATA,
      () => projectCanonicalMajorRoadsToChunk({
        roads,
        chunkX,
        chunkZ,
        sampleGroundHeight,
      }),
    );
    roadTimingRun?.addCounter(ROAD_GENERATION_COUNTER.SORT_DEDUPE_ITEMS, features.length);
    recordRoadFunction(roadTimingRun, 'road-surface-metadata', projectionStartedAt);
    majorRoadDiagnostics.chunkProjectionCount += 1;
    majorRoadDiagnostics.chunkProjectionMs += nowMs() - projectionStartedAt;
    return features;
  };
  const createMajorRoadFeatures = async (
    chunkX,
    chunkZ,
    surfaceBackedChunk,
    roadTimingContext = null,
    { sampleGroundHeight: sampleGroundHeightOverride = null } = {},
  ) => {
    const roadTimingRun = roadTimingContext?.recorder?.beginRun({
      owner: { x: chunkX, z: chunkZ },
      deadlineMiss: roadTimingContext?.deadlineMissAtStart === true,
    }) ?? null;
    if (roadTimingContext) roadTimingContext.run = roadTimingRun;
    const completeRoadTiming = status => {
      if (!roadTimingRun) return null;
      roadTimingRun.setWarmth({
        warmth: roadTimingContext?.cold === true
          ? ROAD_GENERATION_WARMTH.COLD : ROAD_GENERATION_WARMTH.WARM,
      });
      const deadlineMiss = roadTimingContext?.deadlineMissAtStart === true
        || (Number.isFinite(roadTimingContext?.deadlineAtMs)
          && nowMs() > roadTimingContext.deadlineAtMs);
      const snapshot = roadTimingRun.complete({ deadlineMiss, status });
      if (roadTimingContext) {
        roadTimingContext.completedRun = snapshot;
        roadTimingContext.run = null;
      }
      return snapshot;
    };
    try {
      const resolutionStartedAt = nowMs();
      const graph = await getMajorRoadGraph(chunkX, chunkZ, roadTimingContext);
      roadTimingRun?.setCounter(ROAD_GENERATION_COUNTER.NODES, graph.nodes.length);
      roadTimingRun?.setSettlementTypes(graph.nodes.map(node => (
        node.settlementType ?? node.townType
      )));
      const graphSegmentsStartedAt = roadTimingRun ? nowMs() : null;
      const edges = measureRoadSpanSync(
        roadTimingRun,
        ROAD_GENERATION_SPAN.GRAPH_SEGMENTS,
        () => graphEdgesPotentiallyIntersectChunk({ graph, chunkX, chunkZ }),
      );
      recordRoadFunction(roadTimingRun, 'road-graph-segment-filter', graphSegmentsStartedAt);
      const roads = await getMajorRoads(edges, graph, roadTimingContext);
      majorRoadDiagnostics.chunkRoadResolutionMs += nowMs() - resolutionStartedAt;
      const features = projectMajorRoadFeaturesToOwner({
        chunkX,
        chunkZ,
        roads,
        surfaceBackedChunk,
        roadTimingContext,
        sampleGroundHeightOverride,
      });
      completeRoadTiming('completed');
      return features;
    } catch (error) {
      completeRoadTiming('failed');
      throw error;
    }
  };
  const prepareSourceSquare = async (centerChunkX, centerChunkZ, radius) => {
    // Materialize the owning Settlement template once before parallel edge projection.
    await getSourceChunk(centerChunkX, centerChunkZ);
    return Promise.all(squareChunkCoordinates(centerChunkX, centerChunkZ, radius)
      .map(coordinate => getSourceChunk(coordinate.chunkX, coordinate.chunkZ)));
  };
  let experienceSpawn = getLruValue(EXPERIENCE_SPAWN_CACHE, base.worldSeedHash) ?? null;
  if (!experienceSpawn) {
    let preparedSpawnSources = null;
    if (base.worldSeedHash === PROTECTED_SAFE_SPAWN_BOOTSTRAP.worldSeedHash
      && !useExperimentalRoadGraph) {
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
    setLruValue(
      EXPERIENCE_SPAWN_CACHE,
      base.worldSeedHash,
      experienceSpawn,
      EXPERIENCE_SPAWN_CACHE_CAPACITY,
    );
  } else {
    const selectedOwner = decomposeLogicalWorldPosition(experienceSpawn.x, experienceSpawn.z);
    await prepareSourceSquare(
      selectedOwner.chunkX,
      selectedOwner.chunkZ,
      W8_SPAWN_SAFETY_CONTRACT.preparedDataRadiusChunks,
    );
  }
  const presentationInfluenceByType = Object.freeze({ CITY: 204, TOWN: 95, RURAL: 88 });
  const naturalSettlementRecoveryScale =
    W8_NATURAL_PRESENTATION_PHASE_1.settlementDensity.fullRecoveryRadiusScale;
  const maximumSettlementRadiusMeters = Math.max(...Object.values(
    MIGRATED_SETTLEMENT_PROFILES,
  ).map(profile => profile.radius / FINITE_WORLD_UNITS_PER_METER));
  if (maximumSettlementRadiusMeters * naturalSettlementRecoveryScale
    > W5_SETTLEMENT_DISTRIBUTION.maximumInfluenceRadiusMeters + 1e-9) {
    throw new RangeError(
      'Natural Settlement Tree-density recovery exceeds Settlement distributor query coverage',
    );
  }
  const settlementInfluencesNaturalOwner = (candidate, { chunkX, chunkZ }) => {
    const radius = candidate?.radiusMeters;
    if (!Number.isFinite(radius) || radius <= 0) return false;
    const ownerCenterX = (chunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const ownerCenterZ = (chunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const ownerHalfDiagonal = Math.SQRT2 * LOGICAL_CHUNK_SIZE_METERS / 2;
    return Math.hypot(
      ownerCenterX - candidate.center.x,
      ownerCenterZ - candidate.center.z,
    ) <= radius * naturalSettlementRecoveryScale + ownerHalfDiagonal;
  };
  const compactNaturalSettlementReference = candidate => Object.freeze({
    stableId: candidate.settlementId,
    center: candidate.center,
    radiusMeters: candidate.radiusMeters,
  });
  const settlementIntersectsPresentationOwner = (candidate, { chunkX, chunkZ }) => {
    const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
    const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const maximumX = minimumX + LOGICAL_CHUNK_SIZE_METERS;
    const maximumZ = minimumZ + LOGICAL_CHUNK_SIZE_METERS;
    const closestX = Math.max(minimumX, Math.min(maximumX, candidate.center.x));
    const closestZ = Math.max(minimumZ, Math.min(maximumZ, candidate.center.z));
    return Math.hypot(
      closestX - candidate.center.x,
      closestZ - candidate.center.z,
    ) <= presentationInfluenceByType[candidate.settlementType];
  };
  const createPresentationContextForOwner = (
    { chunkX, chunkZ },
    overlayEntries,
    sharedMajorRoadsPromise = null,
    naturalDensityCandidates = [],
  ) => {
    const overlays = overlayEntries.map(entry => entry.overlay);
    const settlementTemplates = overlayEntries.map(entry => entry.presentationTemplate);
    return Object.freeze({
      settlementTemplates: Object.freeze(settlementTemplates),
      settlementDensityReferences: Object.freeze(
        naturalDensityCandidates.map(compactNaturalSettlementReference),
      ),
      naturalExclusionTemplates: Object.freeze(
        overlays.map(overlay => overlay.sourceTemplate),
      ),
      includeCanonicalRiver: true,
      resolvePresentationAuxiliary: async ({
        settlementReferences,
        structures,
        ground,
        naturalOnly = false,
      }) => {
        const [landmarks, street] = await Promise.all([
          createSettlementLandmarks({
            chunkX,
            chunkZ,
            settlementReferences,
          }, seed, base.worldSeedHash, {
            sampleHeightMeters: (worldX, worldZ) => (
              ground.finalGround(worldX, worldZ).heightMeters
            ),
          }),
          naturalOnly ? [] : createStreetDetails({
            chunkX,
            chunkZ,
            settlementFeatures: structures,
          }, base.worldSeedHash, {
            sampleHeightMeters: (worldX, worldZ) => (
              ground.finalGround(worldX, worldZ).heightMeters
            ),
          }),
        ]);
        return Object.freeze({
          landmarks: Object.freeze(landmarks),
          street: Object.freeze(street),
        });
      },
      isNaturalCandidateAllowed: ({ candidate, structures, water, landmarks }) => (
        !conflictsWithPresentation(
          candidate.worldPosition,
          candidate.metadata?.candidateRadiusMeters
            ?? (candidate.candidateType === 'rock' ? 0.45 : 0.625),
          { settlementFeatures: structures },
          {
            waterSurfaces: water,
            settlementLandmarks: landmarks,
            experienceSpawn,
          },
        )
      ),
      resolveMajorRoadFeatures: async ({ ground }) => {
        const sampleGroundHeightOverride = (worldX, worldZ) => (
          ground.settlementGround(worldX, worldZ).heightMeters
        );
        if (!sharedMajorRoadsPromise) {
          return createMajorRoadFeatures(
            chunkX,
            chunkZ,
            null,
            null,
            { sampleGroundHeight: sampleGroundHeightOverride },
          );
        }
        const shared = await sharedMajorRoadsPromise;
        const edges = graphEdgesPotentiallyIntersectChunk({
          graph: shared.graph,
          chunkX,
          chunkZ,
        });
        const roads = edges.map(edge => {
          const road = shared.roadByEdgeStableId.get(edge.stableId);
          if (!road) throw new Error(`missing canonical Major Road ${edge.stableId}`);
          return road;
        });
        return projectMajorRoadFeaturesToOwner({
          chunkX,
          chunkZ,
          roads,
          surfaceBackedChunk: null,
          sampleGroundHeightOverride,
        });
      },
    });
  };
  const majorRoadGraphRegionKeyForOwner = ({ chunkX, chunkZ }) => {
    const regionSize = W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters;
    return `${Math.floor(((chunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS) / regionSize)},${
      Math.floor(((chunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS) / regionSize)}`;
  };
  const prepareSharedMajorRoadsForOwners = async owners => {
    const startedAt = nowMs();
    const graph = await getMajorRoadGraph(owners[0].chunkX, owners[0].chunkZ);
    const requiredEdgeIds = new Set(owners.flatMap(owner => (
      graphEdgesPotentiallyIntersectChunk({
        graph,
        chunkX: owner.chunkX,
        chunkZ: owner.chunkZ,
      }).map(edge => edge.stableId)
    )));
    const edges = graph.edges.filter(edge => requiredEdgeIds.has(edge.stableId));
    const roads = await getMajorRoads(edges, graph);
    majorRoadDiagnostics.chunkRoadResolutionMs += nowMs() - startedAt;
    return Object.freeze({
      graph,
      roadByEdgeStableId: new Map(edges.map((edge, index) => (
        [edge.stableId, roads[index]]
      ))),
    });
  };
  const resolveCanonicalMajorRoadOwnerCoverage = async ({
    centerWorldX,
    centerWorldZ,
    radiusMeters,
  } = {}) => {
    if (![centerWorldX, centerWorldZ, radiusMeters].every(Number.isFinite)
      || radiusMeters < 0) throw new TypeError('valid MAJOR Road owner query is required');
    const regionSize = W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters;
    const chunksPerRegion = regionSize / LOGICAL_CHUNK_SIZE_METERS;
    if (!Number.isSafeInteger(chunksPerRegion) || chunksPerRegion <= 0) {
      throw new Error('MAJOR Road owner coverage requires integral macro regions');
    }
    const minimumChunkX = Math.floor(
      (centerWorldX - radiusMeters) / LOGICAL_CHUNK_SIZE_METERS,
    ) - 1;
    const maximumChunkX = Math.floor(
      (centerWorldX + radiusMeters) / LOGICAL_CHUNK_SIZE_METERS,
    ) + 1;
    const minimumChunkZ = Math.floor(
      (centerWorldZ - radiusMeters) / LOGICAL_CHUNK_SIZE_METERS,
    ) - 1;
    const maximumChunkZ = Math.floor(
      (centerWorldZ + radiusMeters) / LOGICAL_CHUNK_SIZE_METERS,
    ) + 1;
    const minimumRegionX = Math.floor(minimumChunkX / chunksPerRegion);
    const maximumRegionX = Math.floor(maximumChunkX / chunksPerRegion);
    const minimumRegionZ = Math.floor(minimumChunkZ / chunksPerRegion);
    const maximumRegionZ = Math.floor(maximumChunkZ / chunksPerRegion);
    const regions = [];
    for (let regionZ = minimumRegionZ; regionZ <= maximumRegionZ; regionZ += 1) {
      for (let regionX = minimumRegionX; regionX <= maximumRegionX; regionX += 1) {
        regions.push({ regionX, regionZ });
      }
    }
    const resolvedRegions = [];
    for (const region of regions) {
      const graph = await getMajorRoadGraph(
        region.regionX * chunksPerRegion,
        region.regionZ * chunksPerRegion,
      );
      const requiredEdgeIds = new Set();
      const regionMinimumChunkX = Math.max(
        minimumChunkX,
        region.regionX * chunksPerRegion,
      );
      const regionMaximumChunkX = Math.min(
        maximumChunkX,
        (region.regionX + 1) * chunksPerRegion - 1,
      );
      const regionMinimumChunkZ = Math.max(
        minimumChunkZ,
        region.regionZ * chunksPerRegion,
      );
      const regionMaximumChunkZ = Math.min(
        maximumChunkZ,
        (region.regionZ + 1) * chunksPerRegion - 1,
      );
      for (let chunkZ = regionMinimumChunkZ; chunkZ <= regionMaximumChunkZ; chunkZ += 1) {
        for (let chunkX = regionMinimumChunkX; chunkX <= regionMaximumChunkX; chunkX += 1) {
          const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
          const maximumX = (chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS;
          const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
          const maximumZ = (chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS;
          const nearestX = Math.max(minimumX, Math.min(maximumX, centerWorldX));
          const nearestZ = Math.max(minimumZ, Math.min(maximumZ, centerWorldZ));
          if (Math.hypot(nearestX - centerWorldX, nearestZ - centerWorldZ)
            > radiusMeters) continue;
          for (const edge of graphEdgesPotentiallyIntersectChunk({ graph, chunkX, chunkZ })) {
            requiredEdgeIds.add(edge.stableId);
          }
        }
      }
      const edges = graph.edges.filter(edge => requiredEdgeIds.has(edge.stableId));
      const roads = await getMajorRoads(edges, graph);
      const ownerCoordinates = enumerateCanonicalMajorRoadOwnerCoordinates({
        roads,
        centerWorldX,
        centerWorldZ,
        radiusMeters,
      }).filter(coordinate => (
        Math.floor(coordinate.chunkX / chunksPerRegion) === region.regionX
          && Math.floor(coordinate.chunkZ / chunksPerRegion) === region.regionZ
      ));
      resolvedRegions.push({ graph, edges, roads, ownerCoordinates });
    }
    const graphEdgeIds = new Set();
    const roadIds = new Set();
    const owners = new Map();
    for (const resolved of resolvedRegions) {
      for (const edge of resolved.edges) graphEdgeIds.add(edge.stableId);
      for (const road of resolved.roads) roadIds.add(road.stableId);
      for (const coordinate of resolved.ownerCoordinates) {
        owners.set(coordinate.key, coordinate);
      }
    }
    const ownerCoordinates = Object.freeze([...owners.values()].sort((left, right) => (
      left.chunkZ - right.chunkZ || left.chunkX - right.chunkX
    )));
    return Object.freeze({
      schemaVersion: 'w8-canonical-major-road-owner-coverage-1',
      centerWorldX,
      centerWorldZ,
      radiusMeters,
      regionCount: regions.length,
      graphEdgeCount: graphEdgeIds.size,
      roadCount: roadIds.size,
      ownerCount: ownerCoordinates.length,
      ownerCoordinates,
    });
  };
  const resolvePresentationContextsForOwners = async owners => {
    if (!Array.isArray(owners) || owners.length === 0) {
      throw new TypeError('Presentation owner context batch is required');
    }
    const minimumX = Math.min(...owners.map(owner => (
      owner.chunkX * LOGICAL_CHUNK_SIZE_METERS
    )));
    const minimumZ = Math.min(...owners.map(owner => (
      owner.chunkZ * LOGICAL_CHUNK_SIZE_METERS
    )));
    const maximumX = Math.max(...owners.map(owner => (
      (owner.chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS
    )));
    const maximumZ = Math.max(...owners.map(owner => (
      (owner.chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS
    )));
    const centerX = (minimumX + maximumX) / 2;
    const centerZ = (minimumZ + maximumZ) / 2;
    const graphRegionKeys = new Set(owners.map(majorRoadGraphRegionKeyForOwner));
    const sharedMajorRoadsPromise = owners.length > 1 && graphRegionKeys.size === 1
      ? prepareSharedMajorRoadsForOwners(owners) : null;
    // Context lookup may independently fail before owner projections attach
    // their awaits. Keep the original rejecting Promise for those owners while
    // marking its early rejection as observed.
    sharedMajorRoadsPromise?.catch(() => {});
    const candidates = await base.distributor.findSettlementsNear(
      centerX,
      centerZ,
      Math.hypot(maximumX - minimumX, maximumZ - minimumZ) / 2,
    );
    const candidatesByOwner = owners.map(owner => candidates.filter(candidate => (
      settlementIntersectsPresentationOwner(candidate, owner)
    )));
    const naturalDensityCandidatesByOwner = owners.map(owner => candidates.filter(candidate => (
      settlementInfluencesNaturalOwner(candidate, owner)
    )));
    const requiredIds = new Set(candidatesByOwner.flatMap(ownerCandidates => (
      ownerCandidates.map(candidate => candidate.settlementId)
    )));
    const requiredCandidates = candidates.filter(candidate => requiredIds.has(candidate.settlementId));
    const overlayEntries = await Promise.all(requiredCandidates.map(async candidate => {
      const overlay = await getSettlementOverlay(candidate);
      const presentation = composeW8SettlementPresentationTemplate(overlay);
      const buildings = [...overlay.sourceBuildings, ...overlay.buildings];
      return Object.freeze({
        settlementId: candidate.settlementId,
        overlay,
        presentationTemplate: Object.freeze({
          ...presentation,
          roads: Object.freeze(presentation.roads.filter(road => (
            !buildings.some(building => roadIntersectsSettlementBuilding(road, building))
          ))),
        }),
      });
    }));
    const entryBySettlementId = new Map(overlayEntries.map(entry => (
      [entry.settlementId, entry]
    )));
    return Object.freeze(owners.map((owner, index) => createPresentationContextForOwner(
      owner,
      candidatesByOwner[index].map(candidate => entryBySettlementId.get(candidate.settlementId)),
      sharedMajorRoadsPromise,
      naturalDensityCandidatesByOwner[index],
    )));
  };
  const presentationOwnerGeneratorPromise = createPresentationOwnerGenerator({
    worldSeed: base.worldSeed,
    experienceSpawn,
    resolveCanonicalNaturalCandidates: ({ ownerKey }) => {
      // Full generation already owns an immutable candidate source. Reuse it
      // opportunistically without starting Full generation from the sparse path.
      const cachedContext = canonicalOwnerCache.peek({
        ownerKey,
        sourceRevision: canonicalSourceRevision,
      });
      if (!cachedContext) return null;
      return Object.freeze({
        vegetationCandidates:
          cachedContext.parityGameplayChunk.vegetationCandidates ?? Object.freeze([]),
        rockCandidates:
          cachedContext.parityGameplayChunk.rockCandidates ?? Object.freeze([]),
      });
    },
    resolvePresentationContext: async owner => (
      (await resolvePresentationContextsForOwners([owner]))[0]
    ),
    resolvePresentationContexts: ({ owners }) => (
      resolvePresentationContextsForOwners(owners)
    ),
  });
  // Canonical Natural kernels are an always-used W8 service dependency. Make
  // Worker initialization own this one-time setup instead of charging the
  // first visible Tree cell.
  await presentationOwnerGeneratorPromise;
  const getPresentationOwnerGenerator = () => presentationOwnerGeneratorPromise;

  const buildW8CanonicalChunkContext = async (
    chunkX,
    chunkZ,
    stageRecorder = null,
    roadTimingContext = null,
  ) => {
    assertGeneratorActive();
    const sourceChunkData = stageRecorder
      ? await getSourceChunk(chunkX, chunkZ, stageRecorder)
      : await getSourceChunk(chunkX, chunkZ);
    const settlementToken = stageRecorder?.start(CHUNK_GENERATION_STAGE.SETTLEMENT);
    const ownerCenterX = (chunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const ownerCenterZ = (chunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const ownerHalfDiagonal = Math.SQRT2 * LOGICAL_CHUNK_SIZE_METERS / 2;
    const [overlayTemplates, naturalDensityCandidates] = await Promise.all([
      Promise.all((sourceChunkData.settlementReferences ?? []).map(getSettlementOverlay)),
      base.distributor.findSettlementsNear(
        ownerCenterX,
        ownerCenterZ,
        ownerHalfDiagonal,
      ).then(candidates => candidates.filter(candidate => (
        settlementInfluencesNaturalOwner(candidate, { chunkX, chunkZ })
      ))),
    ]);
    const naturalDensityReferences = Object.freeze(
      naturalDensityCandidates.map(compactNaturalSettlementReference),
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
    if (stageRecorder) stageRecorder.end(settlementToken);
    const majorRoadFeatures = stageRecorder
      ? await measureChunkGenerationStage(
        stageRecorder,
        CHUNK_GENERATION_STAGE.ROAD,
        () => createMajorRoadFeatures(
          chunkX,
          chunkZ,
          localSurfaceBackedChunk,
          roadTimingContext,
        ),
      )
      : await createMajorRoadFeatures(
        chunkX,
        chunkZ,
        localSurfaceBackedChunk,
        roadTimingContext,
      );
    const canonicalBeforeRiverToken = stageRecorder?.start(CHUNK_GENERATION_STAGE.CANONICAL);
    const settlementFeatures = [
      ...localSettlementFeatures,
      ...majorRoadFeatures,
    ].sort((left, right) => left.stableId.localeCompare(right.stableId));
    if (stageRecorder) stageRecorder.end(canonicalBeforeRiverToken);
    const riverProjection = stageRecorder
      ? await measureChunkGenerationStage(
        stageRecorder,
        CHUNK_GENERATION_STAGE.RIVER,
        () => createCanonicalRiverProjection({
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
        }),
      )
      : await createCanonicalRiverProjection({
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
    const canonicalToken = stageRecorder?.start(CHUNK_GENERATION_STAGE.CANONICAL);
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
      y: q6(resolveCanonicalSettlementGroundSurface({
        chunkData: localSurfaceBackedChunk,
        worldX: position.x,
        worldZ: position.z,
      }).heightMeters),
    });
    const reground = record => Object.freeze({
      ...record,
      worldPosition: groundPosition(record.worldPosition),
    });
    const regroundNaturalCandidate = candidate => {
      const worldPosition = groundPosition(candidate.worldPosition);
      if (candidate.worldPosition.y === worldPosition.y) return candidate;
      return Object.freeze({
        ...candidate,
        worldPosition,
      });
    };
    const groundedSettlementFeatures = settlementFeatures.map(record => Object.freeze({
      ...record,
      worldPosition: settlementGroundPosition(record.worldPosition),
    }));
    const parityGameplayChunk = Object.freeze({
      ...surfaceBackedChunk,
      vegetationCandidates: surfaceBackedChunk.vegetationCandidates,
      rockCandidates: surfaceBackedChunk.rockCandidates,
      settlementFeatures: Object.freeze(groundedSettlementFeatures),
    });
    const chunkId = createChunkId({
      worldSeedHash: base.worldSeedHash,
      generatorMajor: W8_PARITY_GENERATOR_VERSION.major,
      chunkCoordinate: { x: chunkX, z: chunkZ },
    });
    const context = Object.freeze({
      chunkX,
      chunkZ,
      chunkId,
      sourceChunkData,
      settlementReferences: Object.freeze(settlementReferences),
      naturalDensityReferences,
      canonicalSurfacePolicy,
      riverProjection,
      groundPosition,
      reground,
      regroundNaturalCandidate,
      groundedOverlayFeatures: Object.freeze(
        groundedSettlementFeatures.filter(feature => feature.parityOverlay),
      ),
      parityGameplayChunk,
    });
    if (stageRecorder) stageRecorder.end(canonicalToken);
    return context;
  };

  const prepareW8CanonicalChunkContext = (
    chunkX,
    chunkZ,
    stageRecorder = null,
    roadTimingContext = null,
  ) => canonicalOwnerCache.getOrCreate({
    ownerKey: createChunkKey(chunkX, chunkZ),
    sourceRevision: canonicalSourceRevision,
    load: () => buildW8CanonicalChunkContext(
      chunkX,
      chunkZ,
      stageRecorder,
      roadTimingContext,
    ),
  });

  const prepareW8NaturalPresentation = async (
    context,
    { includeFullPresentation = false } = {},
  ) => {
    const {
      parityGameplayChunk,
      canonicalSurfacePolicy,
      riverProjection,
      groundPosition,
      reground,
      regroundNaturalCandidate,
      settlementReferences,
      naturalDensityReferences,
    } = context;
    const [naturalWater, ambientDetailsRaw, distributedLandmarks, streetDetailsRaw] =
      await Promise.all([
        createWaterSurfaces(parityGameplayChunk, base.worldSeedHash),
        includeFullPresentation
          ? createAmbientDetails(parityGameplayChunk, seed, base.worldSeedHash)
          : Promise.resolve([]),
        createSettlementLandmarks(parityGameplayChunk, seed, base.worldSeedHash),
        includeFullPresentation
          ? createStreetDetails(parityGameplayChunk, base.worldSeedHash)
          : Promise.resolve([]),
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
    const settlementLandmarks = distributedLandmarks
      .map(reground).sort((left, right) => left.stableId.localeCompare(right.stableId));
    const selectedNatural = createNaturalPresentationLayer(
      parityGameplayChunk,
      { waterSurfaces, settlementLandmarks },
      experienceSpawn,
      naturalPresentationPolicy,
      naturalDensityReferences,
    );
    const natural = Object.freeze({
      ...selectedNatural,
      vegetation: Object.freeze(
        selectedNatural.vegetation.map(regroundNaturalCandidate),
      ),
      rocks: Object.freeze(selectedNatural.rocks.map(regroundNaturalCandidate)),
    });
    if (!includeFullPresentation) {
      return Object.freeze({
        waterSurfaces: Object.freeze(waterSurfaces),
        settlementLandmarks: Object.freeze(settlementLandmarks),
        natural,
      });
    }
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
    for (const reference of settlementReferences) {
      const diagnostic = getLruValue(settlementDiagnostics, reference.settlementId);
      if (!diagnostic) continue;
      const landmarkCount = settlementLandmarks.filter(value =>
        value.parentSettlementId === reference.settlementId).length;
      setLruValue(settlementDiagnostics, reference.settlementId, Object.freeze({
        ...diagnostic,
        landmarkCount: Math.max(diagnostic.landmarkCount ?? 0, landmarkCount),
      }), cacheCapacities.settlementDiagnostics);
    }
    const streetDetails = streetDetailsRaw.map(reground)
      .sort((left, right) => left.stableId.localeCompare(right.stableId));
    return Object.freeze({
      waterSurfaces: Object.freeze(waterSurfaces),
      ambientDetails: Object.freeze(ambientDetails),
      settlementLandmarks: Object.freeze(settlementLandmarks),
      streetDetails: Object.freeze(streetDetails),
      natural,
    });
  };

  const generateW8ParityChunk = async (
    chunkX,
    chunkZ,
    stageRecorder = null,
    roadTimingContext = null,
  ) => {
    assertGeneratorActive();
    resourceGenerationCounts.fullChunkRequests += 1;
    const ownerKey = createChunkKey(chunkX, chunkZ);
    const chunk = await presentationManifestCache.getOrCreate({
      manifestKind: 'w8-full-chunk',
      ownerKey,
      sourceRevision: canonicalSourceRevision,
      loadCanonical: () => prepareW8CanonicalChunkContext(
        chunkX,
        chunkZ,
        stageRecorder,
        roadTimingContext,
      ),
      build: async context => {
        const preparePresentation = () => prepareW8NaturalPresentation(context, {
          includeFullPresentation: true,
        });
        const presentation = stageRecorder
          ? await measureChunkGenerationStage(
            stageRecorder,
            CHUNK_GENERATION_STAGE.NATURAL,
            preparePresentation,
          )
          : await preparePresentation();
        const buildContent = () => {
          const presentationLayers = createPresentationLayers(
            context.parityGameplayChunk,
            presentation,
            experienceSpawn,
            naturalPresentationPolicy,
            presentation.natural,
          );
          return {
            ...context.parityGameplayChunk,
            schemaVersion: W8_PARITY_CHUNK_DATA_SCHEMA,
            chunkId: context.chunkId,
            generatorVersion: { ...W8_PARITY_GENERATOR_VERSION },
            sourceW5ContentHash: context.sourceChunkData.contentHash,
            sourceChunkData: context.sourceChunkData,
            settlementOverlayFeatures: context.groundedOverlayFeatures,
            waterSurfaces: presentation.waterSurfaces,
            ambientDetails: presentation.ambientDetails,
            settlementLandmarks: presentation.settlementLandmarks,
            streetDetails: presentation.streetDetails,
            riverRoadCrossings: context.riverProjection.roadCrossings,
            riverPorts: context.riverProjection.ports,
            presentationLayers,
            generationProof: Object.freeze({
              generator: 'w8-finite-experience-parity',
              sourceW5ContentHash: context.sourceChunkData.contentHash,
              finiteExperienceSourceCommit: 'f8bc9f80c2af417bb585bff26c99522c4229ab8e',
              finiteExperienceConnected: true,
              distributedSettlementSurfacePolicyConnected: true,
              canonicalRiverCorridorConnected: true,
              canonicalNaturalGroundRevision: W8_CANONICAL_NATURAL_GROUND_REVISION,
            }),
          };
        };
        const content = stageRecorder
          ? measureChunkGenerationStageSync(
            stageRecorder,
            CHUNK_GENERATION_STAGE.CANONICAL,
            buildContent,
          )
          : buildContent();
        const contentHash = stageRecorder
          ? await hashW8ParityChunkContent(content, { stageRecorder })
          : await hashW8ParityChunkContent(content);
        const nextChunk = Object.freeze({ ...content, contentHash });
        const validate = () => validateW8ParityChunkData(nextChunk);
        const validation = stageRecorder
          ? measureChunkGenerationStageSync(
            stageRecorder,
            CHUNK_GENERATION_STAGE.CANONICAL,
            validate,
          )
          : validate();
        if (!validation.valid) {
          throw new Error(`invalid W8 ChunkData: ${validation.errors.join('; ')}`);
        }
        return nextChunk;
      },
    });
    resourceGenerationCounts.fullChunkCompleted += 1;
    return chunk;
  };

  const generateW8ForestHorizonManifest = async (
    chunkX,
    chunkZ,
    stageRecorder = null,
    roadTimingContext = null,
  ) => {
    assertGeneratorActive();
    resourceGenerationCounts.forestHorizonManifestRequests += 1;
    const manifest = await presentationManifestCache.getOrCreate({
      manifestKind: 'w8-forest-horizon',
      ownerKey: createChunkKey(chunkX, chunkZ),
      sourceRevision: canonicalSourceRevision,
      loadCanonical: () => prepareW8CanonicalChunkContext(
        chunkX,
        chunkZ,
        stageRecorder,
        roadTimingContext,
      ),
      build: async context => {
        const preparePresentation = () => prepareW8NaturalPresentation(context);
        const presentation = stageRecorder
          ? await measureChunkGenerationStage(
            stageRecorder,
            CHUNK_GENERATION_STAGE.NATURAL,
            preparePresentation,
          )
          : await preparePresentation();
        const manifestInput = {
          chunkId: context.chunkId,
          chunkX,
          chunkZ,
          sourceW5ContentHash: context.sourceChunkData.contentHash,
          sourceChunkData: context.sourceChunkData,
          generatorVersion: W8_PARITY_GENERATOR_VERSION,
          canonicalSurfacePolicy: context.canonicalSurfacePolicy,
          presentationLayers: Object.freeze({
            natural: presentation.natural,
          }),
        };
        return stageRecorder
          ? createHashedW8ForestHorizonManifest(manifestInput, { stageRecorder })
          : createHashedW8ForestHorizonManifest(manifestInput);
      },
    });
    resourceGenerationCounts.forestHorizonManifestCompleted += 1;
    return manifest;
  };

  return Object.freeze({
    worldSeed: base.worldSeed,
    worldSeedHash: base.worldSeedHash,
    seed64: base.seed64,
    generatorVersion: W8_PARITY_GENERATOR_VERSION,
    distributor: base.distributor,
    reviewSpawn: base.reviewSpawn,
    experienceSpawn,
    ...(useExperimentalRoadGraph ? { settlementRoadGraphGeneratorId } : {}),
    ...(settlementLotMode ? { settlementLotMode } : {}),
    async auditSettlementsNear(x, z, radiusMeters) {
      assertGeneratorActive();
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
      assertGeneratorActive();
      return composeW8SettlementPresentationTemplate(await getSettlementOverlay(candidate));
    },
    async generatePresentationOwner(chunkX, chunkZ) {
      assertGeneratorActive();
      resourceGenerationCounts.presentationOwnerRequests += 1;
      const generated = await (await getPresentationOwnerGenerator()).generateOwner(
        chunkX,
        chunkZ,
      );
      // Sampling functions stay inside the Worker. The compact resource,
      // surface policy, and already-grounded canonical records are cloneable.
      const result = Object.freeze({
        schemaVersion: generated.schemaVersion,
        chunkId: generated.chunkId,
        contentHash: generated.contentHash,
        chunkX: generated.chunkX,
        chunkZ: generated.chunkZ,
        resource: generated.resource,
        canonicalSurfacePolicy: generated.canonicalSurfacePolicy,
        riverProjection: generated.riverProjection,
        diagnostics: generated.diagnostics,
      });
      resourceGenerationCounts.presentationOwnerCompleted += 1;
      return result;
    },
    async generateCanonicalTreeCell(macroX, macroZ) {
      assertGeneratorActive();
      resourceGenerationCounts.canonicalTreeCellRequests += 1;
      const generated = await (await getPresentationOwnerGenerator())
        .generateCanonicalTreeCell(macroX, macroZ);
      resourceGenerationCounts.canonicalTreeCellCompleted += 1;
      return generated;
    },
    async resolveCanonicalMajorRoadOwnerCoverage(query = {}) {
      assertGeneratorActive();
      return resolveCanonicalMajorRoadOwnerCoverage(query);
    },
    async resolveCanonicalMajorRoadNetwork({
      centerWorldX,
      centerWorldZ,
      radiusMeters,
    } = {}) {
      assertGeneratorActive();
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
    async generateChunk(
      chunkX,
      chunkZ,
      { stageRecorder = null, roadTimingContext = null } = {},
    ) {
      return generateW8ParityChunk(chunkX, chunkZ, stageRecorder, roadTimingContext);
    },
    async generateForestHorizonManifest(
      chunkX,
      chunkZ,
      { stageRecorder = null, roadTimingContext = null } = {},
    ) {
      return generateW8ForestHorizonManifest(
        chunkX,
        chunkZ,
        stageRecorder,
        roadTimingContext,
      );
    },
    async shutdown() {
      if (isShutdown) return;
      isShutdown = true;
      warmSourceChunks.clear();
      pendingSourceChunks.clear();
      settlementOverlayTemplates.close();
      settlementDiagnostics.clear();
      majorRoadGraphCache.close();
      majorRoadRouteCache.close();
      majorRoadObstacleCache.close();
      majorRoadPreparationCache.close();
      majorRoadSourceHashCache.close();
      canonicalOwnerCache.close();
      presentationManifestCache.close();
      majorRoadRouteKeyByEdge.clear();
      majorRoadObstacleKeyBySettlement.clear();
      await base.shutdown?.();
    },
    snapshot: () => {
      const source = base.snapshot?.() ?? null;
      const overlayCache = settlementOverlayTemplates.snapshot();
      const graphCache = majorRoadGraphCache.snapshot();
      const routeCache = majorRoadRouteCache.snapshot();
      const obstacleCache = majorRoadObstacleCache.snapshot();
      const preparationCache = majorRoadPreparationCache.snapshot();
      const sourceHashCache = majorRoadSourceHashCache.snapshot();
      const canonicalCache = canonicalOwnerCache.snapshot();
      const manifestCache = presentationManifestCache.snapshot();
      const observedSettlements = [...settlementDiagnostics.values()]
        .sort((left, right) => left.settlementId.localeCompare(right.settlementId));
      return Object.freeze({
        ...(source ?? {}),
        schemaVersion: W8_PARITY_CONTENT.schemaVersion,
        source,
        isShutdown,
        resourceGeneration: Object.freeze({ ...resourceGenerationCounts }),
        canonicalOwnerCache: canonicalCache,
        presentationManifestCache: manifestCache,
        safeSpawnPreparedChunkCount: experienceSpawn.spawnSafety?.preparedChunkKeys?.length ?? 0,
        safeSpawn: experienceSpawn.spawnSafety ?? null,
        experienceSpawnCacheSize: EXPERIENCE_SPAWN_CACHE.size,
        experienceSpawnCacheCapacity: EXPERIENCE_SPAWN_CACHE_CAPACITY,
        warmSourceChunkCacheSize: warmSourceChunks.size,
        warmSourceChunkCacheCapacity: warmSourceChunkCapacity,
        warmSourceChunkPendingCount: pendingSourceChunks.size,
        settlementOverlayCacheSize: overlayCache.size,
        settlementOverlayCacheCapacity: overlayCache.capacity,
        settlementOverlayCachePendingCount: overlayCache.pendingCount,
        settlementOverlayCacheEvictionCount: overlayCache.evictionCount,
        settlementDiagnosticCacheSize: settlementDiagnostics.size,
        settlementDiagnosticCacheCapacity: cacheCapacities.settlementDiagnostics,
        canonicalMajorRoad: Object.freeze({
          schemaVersion: W8_CANONICAL_MAJOR_ROAD.schemaVersion,
          widthMeters: W8_CANONICAL_MAJOR_ROAD.widthMeters,
          graphCacheSize: graphCache.size,
          graphCacheCapacity: graphCache.capacity,
          graphCachePendingCount: graphCache.pendingCount,
          graphCacheEvictionCount: graphCache.evictionCount,
          routeCacheSize: routeCache.size,
          routeCacheCapacity: routeCache.capacity,
          routeCachePendingCount: routeCache.pendingCount,
          routeCacheEvictionCount: routeCache.evictionCount,
          routeKeyIndexSize: majorRoadRouteKeyByEdge.size,
          obstacleCacheSize: obstacleCache.size,
          obstacleCacheCapacity: obstacleCache.capacity,
          obstacleCachePendingCount: obstacleCache.pendingCount,
          obstacleCacheEvictionCount: obstacleCache.evictionCount,
          obstacleKeyIndexSize: majorRoadObstacleKeyBySettlement.size,
          preparationCacheSize: preparationCache.size,
          preparationCacheCapacity: preparationCache.capacity,
          preparationCachePendingCount: preparationCache.pendingCount,
          preparationCacheEvictionCount: preparationCache.evictionCount,
          sourceHashCacheSize: sourceHashCache.size,
          sourceHashCacheCapacity: sourceHashCache.capacity,
          sourceHashCachePendingCount: sourceHashCache.pendingCount,
          sourceHashCacheEvictionCount: sourceHashCache.evictionCount,
          ...majorRoadDiagnostics,
        }),
        observedSettlementDiagnostics: Object.freeze(observedSettlements
          .map(value => Object.freeze({
            ...value,
            nearestObservedSettlementDistanceMeters: Math.min(
              ...observedSettlements
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
