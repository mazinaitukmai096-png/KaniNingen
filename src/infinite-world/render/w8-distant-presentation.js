import {
  LOGICAL_CHUNK_SIZE_METERS,
  UNITS_PER_METER,
} from '../chunk-coordinates.js';
import { determineDetailCandidateOwner } from '../legacy-core/g3/detail-candidates.js';
import {
  createChunkCoverageSignature,
  isRuntimeTransitionContract,
  sameRuntimeTransitionContract,
} from '../runtime-transition-contract.js';
import { createMacroTerrainEvaluator, G5_MACRO_TERRAIN } from '../legacy-core/g5/macro-terrain.js';
import { createNaturalBiomeEvaluator, naturalMaterialWeights } from '../natural-biome-field.js';
import {
  W8_NATURAL_CANONICAL_VISIBILITY_METERS,
  isW8NaturalCandidateVisible,
} from '../w8-natural-presentation-policy.js';
import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
  W8_RENDER_DISTANCE_PRESETS,
  normalizeW8RenderDistancePreset,
  resolveW8RenderDistancePolicy,
} from '../render-distance-policy.js';
import {
  resolveW8RockCanonicalObject,
  resolveW8RockVisibilityMeters,
} from '../rock-canonical-object.js';
import {
  W8_CANONICAL_VISIBILITY_METERS,
  resolveW8CanonicalWorldObject,
  resolveW8NaturalCandidateVisual,
  resolveW8ObjectVisibilityMeters,
} from '../world-object-canonical-contract.js';
import {
  resolveCanonicalGroundSurface,
  resolveCanonicalSurfaceColorRgb,
  resolveCanonicalSurfaceWeights,
} from '../w8-surface-policy.js';
import {
  canonicalRiverMayAffectChunk,
  createCanonicalRiverSourceId,
  createCanonicalRiverSurfaceCorridor,
  createCanonicalRiverProjection,
  resolveCanonicalRiverBed,
} from '../canonical-river-realization.js';
import {
  W8_SETTLEMENT_ROLE_LANDMARKS,
  resolveW8SettlementPresentationPolicy,
  selectRemoteHorizonBuildings,
  selectW8SettlementPresentationCandidates,
  settlementCandidateDistance,
} from '../settlement-presentation-policy.js';

export {
  W8_NATURAL_CANONICAL_VISIBILITY_METERS,
  isW8NaturalCandidateVisible,
} from '../w8-natural-presentation-policy.js';
export {
  W8_FINITE_ROCK_PRESENTATION_METERS,
  resolveW8RockCandidateVisual,
  resolveW8RockCanonicalObject,
  resolveW8RockVisibilityMeters,
} from '../rock-canonical-object.js';
export {
  W8_CANONICAL_VISIBILITY_METERS,
  resolveW8CanonicalWorldObject,
  resolveW8NaturalCandidateVisual,
} from '../world-object-canonical-contract.js';

const FIVE_BY_FIVE_HALF_EXTENT_METERS = LOGICAL_CHUNK_SIZE_METERS * 2.5;
const CLIPMAP_BLEND_METERS = 16;
const CLIPMAP_SAMPLE_CACHE_CAPACITY = 65_536;
const RIVER_CORRIDOR_WINDOW_CACHE_CAPACITY = 6;
const DISTANT_ROCK_PROXY_LIMIT = 0;
const DISTANT_WATER_PROXY_LIMIT = 24;
const TEMPLATE_CACHE_CAPACITY = 5;
const FAR_OWNER_CHUNK_CACHE_CAPACITY = 128;
const ULTRA_OWNER_CHUNK_CACHE_CAPACITY = 256;
const CANONICAL_QUERY_CONCURRENCY = 4;
const CANONICAL_QUERY_MARGIN_METERS = Math.SQRT2 * LOGICAL_CHUNK_SIZE_METERS;
const PRESENTATION_SLICE_BUDGET_MS = 8;
const PRESENTATION_SLICE_UNIT_LIMIT = 256;

export const W8_PRESENTATION_TERRAIN_PALETTE = Object.freeze([
  Object.freeze([0x7d / 255, 0x8f / 255, 0x4f / 255]),
  Object.freeze([0x9a / 255, 0x82 / 255, 0x64 / 255]),
  Object.freeze([0x5c / 255, 0x6b / 255, 0x38 / 255]),
  Object.freeze([0x8f / 255, 0xae / 255, 0x4f / 255]),
  Object.freeze([0xa0 / 255, 0x78 / 255, 0x5a / 255]),
]);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const smoothstep = value => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

function validateTransitionCoverage(
  transitionContract,
  { activeDataKeys, renderedKeys, centerChunkX = null, centerChunkZ = null },
) {
  if (transitionContract === null || transitionContract === undefined) return null;
  if (!isRuntimeTransitionContract(transitionContract)) {
    throw new TypeError('invalid Runtime transition contract');
  }
  if (transitionContract.activeDataSignature
      !== createChunkCoverageSignature(activeDataKeys, 'activeDataKeys')
    || transitionContract.renderedSignature
      !== createChunkCoverageSignature(renderedKeys, 'renderedKeys')) {
    throw new Error('Runtime transition coverage does not match presentation input');
  }
  if (centerChunkX !== null && centerChunkZ !== null
    && (transitionContract.centerChunkX !== centerChunkX
      || transitionContract.centerChunkZ !== centerChunkZ)) {
    throw new Error('Runtime transition center does not match presentation input');
  }
  return transitionContract;
}

function assignTransitionContract(generation, transitionContract) {
  if (!generation || !transitionContract) return;
  generation.transitionContract = transitionContract;
  generation.root.userData = {
    ...(generation.root.userData ?? {}),
    transitionGeneration: transitionContract.generation,
    coverageSignature: transitionContract.coverageSignature,
    renderedSignature: transitionContract.renderedSignature,
    activeDataSignature: transitionContract.activeDataSignature,
  };
}

const chunkAabbIntersectsCircle = (chunkX, chunkZ, centerX, centerZ, radiusMeters) => {
  const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const maximumX = minimumX + LOGICAL_CHUNK_SIZE_METERS;
  const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const maximumZ = minimumZ + LOGICAL_CHUNK_SIZE_METERS;
  const nearestX = clamp(centerX, minimumX, maximumX);
  const nearestZ = clamp(centerZ, minimumZ, maximumZ);
  return Math.hypot(centerX - nearestX, centerZ - nearestZ) <= radiusMeters;
};

export function resolveW8CanonicalCandidateSet(chunkData) {
  const layers = chunkData?.presentationLayers;
  const vegetationSource = layers?.natural?.vegetation
    ?? chunkData?.vegetationCandidates ?? chunkData?.vegetationProxies ?? [];
  const vegetation = vegetationSource.filter(candidate => {
    const formal = candidate?.candidateId !== undefined;
    return !(formal && chunkData?.generatorVersion?.major >= 800)
      || isW8NaturalCandidateVisible(candidate);
  });
  return Object.freeze({
    vegetation: Object.freeze(vegetation),
    rocks: Object.freeze([...(layers?.natural?.rocks
      ?? chunkData?.rockCandidates ?? chunkData?.rockProxies ?? [])]),
  });
}

export function isW8DistantNaturalProxyInRange(
  distanceMeters,
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  const extent = resolveW8RenderDistancePolicy(renderDistancePreset).terrainRiverExtentMeters;
  return Number.isFinite(distanceMeters)
    && distanceMeters >= 0
    && distanceMeters < extent - 12;
}

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new TypeError(`THREE.${name} is required`);
  return THREE[name];
}

export function w8TerrainColorFromWeights(weights) {
  const color = [0, 0, 0];
  for (let material = 0; material < W8_PRESENTATION_TERRAIN_PALETTE.length; material += 1) {
    const weight = weights[material];
    const palette = W8_PRESENTATION_TERRAIN_PALETTE[material];
    color[0] += weight * palette[0];
    color[1] += weight * palette[1];
    color[2] += weight * palette[2];
  }
  return color;
}

function textHash(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function cellRoll(seed, x, z, salt = 0) {
  let value = seed ^ Math.imul(x | 0, 0x1f123bb5)
    ^ Math.imul(z | 0, 0x5f356495) ^ Math.imul(salt, 0x9e3779b9);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

function clipmapAxis(extentMeters) {
  const values = [];
  const addRange = (from, to, step) => {
    for (let value = from; value < to - 1e-9; value += step) values.push(value);
  };
  addRange(-extentMeters, -192, 16);
  addRange(-192, -96, 8);
  addRange(-96, 96, 4);
  addRange(96, 192, 8);
  addRange(192, extentMeters, 16);
  values.push(extentMeters);
  return values;
}

export function createW8ClipmapTopology(
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  const extentMeters = resolveW8RenderDistancePolicy(
    renderDistancePreset,
  ).terrainRiverExtentMeters;
  const axis = clipmapAxis(extentMeters);
  const vertices = [];
  const indices = [];
  const vertexByCoordinate = new Map();
  const vertexIndex = (x, z) => {
    const key = `${x},${z}`;
    if (vertexByCoordinate.has(key)) return vertexByCoordinate.get(key);
    const index = vertices.length;
    vertices.push(Object.freeze({ x, z }));
    vertexByCoordinate.set(key, index);
    return index;
  };
  for (let z = 0; z < axis.length - 1; z += 1) {
    for (let x = 0; x < axis.length - 1; x += 1) {
      const x0 = axis[x]; const x1 = axis[x + 1];
      const z0 = axis[z]; const z1 = axis[z + 1];
      const centerX = (x0 + x1) / 2;
      const centerZ = (z0 + z1) / 2;
      if (Math.max(Math.abs(centerX), Math.abs(centerZ)) < FIVE_BY_FIVE_HALF_EXTENT_METERS) {
        continue;
      }
      const northwest = vertexIndex(x0, z0);
      const northeast = vertexIndex(x1, z0);
      const southwest = vertexIndex(x0, z1);
      const southeast = vertexIndex(x1, z1);
      indices.push(northwest, southwest, northeast, northeast, southwest, southeast);
    }
  }
  return Object.freeze({
    extentMeters,
    vertices: Object.freeze(vertices),
    indices: Object.freeze(indices),
  });
}

const CLIPMAP_TOPOLOGY_BY_PRESET = new Map();
const clipmapTopologyFor = renderDistancePreset => {
  const presetId = normalizeW8RenderDistancePreset(renderDistancePreset);
  if (!CLIPMAP_TOPOLOGY_BY_PRESET.has(presetId)) {
    CLIPMAP_TOPOLOGY_BY_PRESET.set(presetId, createW8ClipmapTopology(presetId));
  }
  return CLIPMAP_TOPOLOGY_BY_PRESET.get(presetId);
};

export function sampleW8DistantTerrainAt(chunkData, worldX, worldZ) {
  const terrain = chunkData?.terrain;
  if (!terrain) return null;
  const originX = chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const originZ = chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const fx = clamp((worldX - originX) / LOGICAL_CHUNK_SIZE_METERS, 0, 1)
    * (terrain.resolution.x - 1);
  const fz = clamp((worldZ - originZ) / LOGICAL_CHUNK_SIZE_METERS, 0, 1)
    * (terrain.resolution.z - 1);
  const x0 = Math.floor(fx); const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, terrain.resolution.x - 1);
  const z1 = Math.min(z0 + 1, terrain.resolution.z - 1);
  const tx = fx - x0; const tz = fz - z0;
  const northwest = z0 * terrain.resolution.x + x0;
  const northeast = z0 * terrain.resolution.x + x1;
  const southwest = z1 * terrain.resolution.x + x0;
  const southeast = z1 * terrain.resolution.x + x1;
  const northWeight = 1 - tz;
  const southWeight = tz;
  const westWeight = 1 - tx;
  const eastWeight = tx;
  const naturalHeight = ((terrain.heights[northwest] * westWeight
    + terrain.heights[northeast] * eastWeight) * northWeight
    + (terrain.heights[southwest] * westWeight
      + terrain.heights[southeast] * eastWeight) * southWeight)
    * terrain.heightUnitMeters;
  const color = [0, 0, 0];
  for (let material = 0; material < W8_PRESENTATION_TERRAIN_PALETTE.length; material += 1) {
    const weight = ((terrain.materialWeights[
      northwest * W8_PRESENTATION_TERRAIN_PALETTE.length + material
    ] * westWeight + terrain.materialWeights[
      northeast * W8_PRESENTATION_TERRAIN_PALETTE.length + material
    ] * eastWeight) * northWeight + (terrain.materialWeights[
      southwest * W8_PRESENTATION_TERRAIN_PALETTE.length + material
    ] * westWeight + terrain.materialWeights[
      southeast * W8_PRESENTATION_TERRAIN_PALETTE.length + material
    ] * eastWeight) * southWeight);
    const palette = W8_PRESENTATION_TERRAIN_PALETTE[material];
    color[0] += weight * palette[0];
    color[1] += weight * palette[1];
    color[2] += weight * palette[2];
  }
  if (!chunkData.canonicalSurfacePolicy) return { height: naturalHeight, color };
  const surface = resolveCanonicalGroundSurface({ chunkData, worldX, worldZ });
  return {
    height: surface.heightMeters,
    color: resolveCanonicalSurfaceColorRgb({
      naturalColor: color, surface, worldX, worldZ,
    }),
  };
}

function sampleActiveTerrain(activeChunks, worldX, worldZ) {
  const epsilon = 1e-6;
  const chunkX = Math.floor((worldX - epsilon) / LOGICAL_CHUNK_SIZE_METERS);
  const chunkZ = Math.floor((worldZ - epsilon) / LOGICAL_CHUNK_SIZE_METERS);
  const direct = activeChunks.get(`${chunkX},${chunkZ}`);
  if (direct) return sampleW8DistantTerrainAt(direct, worldX, worldZ);
  for (const chunk of activeChunks.values()) {
    const minimumX = chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS - epsilon;
    const minimumZ = chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS - epsilon;
    if (worldX >= minimumX && worldX <= minimumX + LOGICAL_CHUNK_SIZE_METERS + epsilon
      && worldZ >= minimumZ && worldZ <= minimumZ + LOGICAL_CHUNK_SIZE_METERS + epsilon) {
      return sampleW8DistantTerrainAt(chunk, worldX, worldZ);
    }
  }
  return null;
}

function makeGeometry(THREE, positions, colors, indices) {
  const BufferGeometry = requireConstructor(THREE, 'BufferGeometry');
  const Float32BufferAttribute = requireConstructor(THREE, 'Float32BufferAttribute');
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  if (typeof geometry.computeVertexNormals === 'function') geometry.computeVertexNormals();
  else {
    const normals = new Float32Array(positions.length);
    for (let index = 1; index < normals.length; index += 3) normals[index] = 1;
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  }
  return geometry;
}

export async function createW8DistantPresentation({
  THREE,
  scene,
  worldSeedHash,
  visualAssets,
  findSettlementsNear,
  resolveTemplate,
  getCanonicalChunkData,
  cancelCanonicalChunkRequests = null,
  isFeatureDestroyed = () => false,
  getNearVisibleStableIds = () => [],
  getNearVisibleSettlementIds = () => [],
  measure = (_stage, operation) => operation(),
  yieldToMainThread = () => new Promise(resolve => globalThis.setTimeout(resolve, 0)),
} = {}) {
  if (!scene?.add || !scene?.remove) throw new TypeError('a Three.js scene is required');
  if (typeof findSettlementsNear !== 'function'
    || typeof resolveTemplate !== 'function'
    || typeof getCanonicalChunkData !== 'function') {
    throw new TypeError('canonical Settlement query, template, and ChunkData providers are required');
  }
  if (cancelCanonicalChunkRequests !== null && typeof cancelCanonicalChunkRequests !== 'function') {
    throw new TypeError('cancelCanonicalChunkRequests must be a function when provided');
  }
  if (typeof getNearVisibleStableIds !== 'function'
    || typeof getNearVisibleSettlementIds !== 'function') {
    throw new TypeError('Near presentation identity providers must be functions');
  }
  const Group = requireConstructor(THREE, 'Group');
  const Mesh = requireConstructor(THREE, 'Mesh');
  const InstancedMesh = requireConstructor(THREE, 'InstancedMesh');
  const Object3D = requireConstructor(THREE, 'Object3D');
  const PlaneGeometry = requireConstructor(THREE, 'PlaneGeometry');
  const Material = typeof THREE.MeshPhongMaterial === 'function'
    ? THREE.MeshPhongMaterial : requireConstructor(THREE, 'MeshLambertMaterial');
  const macroEvaluator = await createMacroTerrainEvaluator(worldSeedHash);
  const biomeEvaluator = await createNaturalBiomeEvaluator({ worldSeedHash });
  const canonicalRiverSourceStableId = await createCanonicalRiverSourceId(worldSeedHash);
  const root = new Group();
  root.name = 'w8-scene-owned-distant-world';
  root.userData = { presentationOnly: true };
  root.visible = true;
  scene.add(root);
  const terrainMaterial = new Material({ vertexColors: true, flatShading: true, shininess: 0 });
  const roadGeometry = new PlaneGeometry(1, 1);
  const transform = new Object3D();
  const createStats = () => ({
    midgroundChunkCount: 0,
    clipmapMeshCount: 0,
    maximumInnerBoundaryErrorMeters: 0,
    maximumInnerBoundaryColorDifference: 0,
    clipmapDeterministicChecksum: 0,
    distantNaturalProxyCount: 0,
    distantTreeProxyCount: 0,
    distantRockProxyCount: 0,
    distantWaterProxyCount: 0,
    distantProxyInstancedMeshCount: 0,
    canonicalRecordCount: 0,
    canonicalBuildingRecordCount: 0,
    canonicalVegetationRecordCount: 0,
    canonicalTreeRecordCount: 0,
    canonicalShrubRecordCount: 0,
    canonicalRockRecordCount: 0,
    canonicalLandmarkRecordCount: 0,
    canonicalRoadRecordCount: 0,
    canonicalRiverRecordCount: 0,
    canonicalRiverSegmentCount: 0,
    canonicalRiverLengthMeters: 0,
    canonicalRiverRoadCrossingCount: 0,
    canonicalActiveRiverRecordCount: 0,
    canonicalActiveRiverSegmentCount: 0,
    canonicalActiveRiverLengthMeters: 0,
    visibleFarRiverSegmentCount: 0,
    visibleFarRiverLengthMeters: 0,
    visibleFarRiverOwnerCount: 0,
    canonicalWorldDetailRecordCount: 0,
    canonicalMeshCount: 0,
    canonicalVisibleMeshCount: 0,
    canonicalFarObjectCount: 0,
    canonicalMidObjectCount: 0,
    canonicalNearObjectCount: 0,
    canonicalHiddenObjectCount: 0,
    canonicalDestroyedObjectCount: 0,
    canonicalActiveOwnerCount: 0,
    canonicalRenderedOwnerCount: 0,
    visibleCanonicalObjectCount: 0,
    visibleCanonicalVegetationCount: 0,
    visibleCanonicalTreeCount: 0,
    visibleCanonicalShrubCount: 0,
    visibleCanonicalRockCount: 0,
    visibleCanonicalFullTreeCount: 0,
    visibleCanonicalSilhouetteTreeCount: 0,
    visibleCanonicalUltraTreeCount: 0,
    visibleCanonicalTreePartInstanceCount: 0,
    visibleCanonicalTreeMidBandCount: 0,
    visibleCanonicalTreeOuterBandCount: 0,
    visibleCanonicalTreeUltraInnerBandCount: 0,
    visibleCanonicalTreeUltraOuterBandCount: 0,
    visibleCanonicalHorizonBuildingCount: 0,
    visibleCanonicalHorizonLandmarkCount: 0,
    visibleCanonicalBuildingPartInstanceCount: 0,
    visibleCanonicalHorizonPartInstanceCount: 0,
    destroyedHorizonBuildingCount: 0,
    duplicateVisibleStableIdCount: 0,
    duplicateVisibleStableIds: Object.freeze([]),
    remoteSettlementCandidateCount: 0,
    remoteSettlementSelectedCount: 0,
    remoteHorizonSettlementCount: 0,
    remoteHorizonCanonicalBuildingCount: 0,
    visibleRemoteHorizonSettlementCount: 0,
    remoteHorizonBuildingCount: 0,
    remoteHorizonSyntheticBuildingCount: 0,
    remoteHorizonMergedBuildingCount: 0,
    remoteHorizonMissingBuildingCount: 0,
    remoteHorizonLandmarkCount: 0,
    remoteHorizonSyntheticLandmarkCount: 0,
    remoteHorizonMergedLandmarkCount: 0,
    remoteHorizonPartInstanceCount: 0,
    remoteHorizonSuppressedByNearCount: 0,
    identityAuditErrorCount: 0,
    canonicalComposeCount: 0,
    canonicalMatrixUpdateCount: 0,
    canonicalNeedsUpdateCount: 0,
    canonicalDirtyBucketCount: 0,
    canonicalRoadMeshBucketCount: 0,
    canonicalRoadMeshComposeMs: 0,
    canonicalRoadMatrixComposeMs: 0,
    syncCancelledDuringQueryCount: 0,
  });
  const emptyStats = createStats();
  let activeGeneration = null;
  let activeLocalTerrainGeneration = null;
  const localTerrainOwnerIndexData = new WeakMap();
  let committedRuntimeTransitionContract = null;
  const acceptRuntimeTransitionContract = transitionContract => {
    if (!transitionContract) return true;
    if (!committedRuntimeTransitionContract) {
      committedRuntimeTransitionContract = transitionContract;
      return true;
    }
    if (sameRuntimeTransitionContract(
      transitionContract,
      committedRuntimeTransitionContract,
    )) return true;
    if (transitionContract.generation < committedRuntimeTransitionContract.generation) {
      return false;
    }
    if (transitionContract.generation === committedRuntimeTransitionContract.generation) {
      throw new Error('conflicting Runtime transition contracts share one generation');
    }
    committedRuntimeTransitionContract = transitionContract;
    return true;
  };
  const transitionIsCurrent = transitionContract => !transitionContract
    || sameRuntimeTransitionContract(
      transitionContract,
      committedRuntimeTransitionContract,
    );
  let syncEpoch = 0;
  let committedEpoch = 0;
  let staleEpochDiscardCount = 0;
  let committedRenderOrigin = null;
  let staleRenderOriginRejectCount = 0;
  let localTerrainSyncEpoch = 0;
  let committedLocalTerrainEpoch = 0;
  let localTerrainCommitCount = 0;
  let localTerrainRejectionCount = 0;
  let localTerrainStaleDiscardCount = 0;
  let localTerrainLastRequestedEpoch = 0;
  let localTerrainLastActiveKeyCount = 0;
  let localTerrainLastResolvedChunkCount = 0;
  let localTerrainLastRenderedKeyCount = 0;
  let localTerrainLastMidgroundOwnerCount = 0;
  let localTerrainLastMissingOwnerKeys = Object.freeze([]);
  let localTerrainLastRejectionReason = null;
  let localTerrainLastSyncDurationMs = 0;
  let localTerrainLastRootSwapDurationMs = 0;
  let localTerrainLastMaximumSliceMs = 0;
  let localTerrainLastSliceCount = 0;
  let farLastMaximumSliceMs = 0;
  let farLastSliceCount = 0;
  let stagingLocalTerrainRootId = null;
  const pendingFarSyncEpochs = new Set();
  let activeQueryCount = 0;
  let maximumObservedQueryConcurrency = 0;
  const queryWaiters = [];
  const templateCache = new Map();
  const farOwnerChunkCache = new Map();
  const ultraOwnerChunkCache = new Map();
  const clipmapSampleCache = new Map();
  const riverCorridorWindowCache = new Map();
  let currentCanonicalSurfacePolicy = null;
  const surfacePolicyIds = new WeakMap();
  let nextSurfacePolicyId = 1;
  const surfacePolicyForChunks = (chunks, additionalRiverCorridors = []) => {
    const regions = new Map();
    const riverCorridors = new Map();
    for (const chunk of chunks) {
      for (const region of chunk?.canonicalSurfacePolicy?.regions ?? []) {
        regions.set(region.settlementId, region);
      }
      for (const corridor of chunk?.canonicalSurfacePolicy?.riverCorridors ?? []) {
        riverCorridors.set(JSON.stringify(corridor), corridor);
      }
    }
    for (const corridor of additionalRiverCorridors) {
      if (corridor) riverCorridors.set(JSON.stringify(corridor), corridor);
    }
    return Object.freeze({
      schemaVersion: 'w8-settlement-surface-policy-1',
      regions: Object.freeze([...regions.values()]
        .sort((left, right) => left.settlementId.localeCompare(right.settlementId))),
      riverCorridors: Object.freeze([...riverCorridors.values()]
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))),
    });
  };
  const riverSurfaceCorridorsForClipmap = (
    centerChunkX,
    centerChunkZ,
    policy,
    terrainRiverExtentMeters,
  ) => {
    const cacheKey = `${centerChunkX},${centerChunkZ}:${terrainRiverExtentMeters}`;
    if (riverCorridorWindowCache.has(cacheKey)) {
      const cached = riverCorridorWindowCache.get(cacheKey);
      riverCorridorWindowCache.delete(cacheKey);
      riverCorridorWindowCache.set(cacheKey, cached);
      return cached;
    }
    const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const settlementReferences = (policy?.regions ?? []).map(region => ({
      settlementId: region.settlementId,
      center: region.center,
      radiusMeters: region.flatCoreRadiusMeters + region.transitionWidthMeters,
    }));
    const minimumChunkX = Math.floor(
      (centerWorldX - terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumChunkX = Math.floor(
      (centerWorldX + terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const minimumChunkZ = Math.floor(
      (centerWorldZ - terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumChunkZ = Math.floor(
      (centerWorldZ + terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const corridors = [];
    for (let chunkZ = minimumChunkZ; chunkZ <= maximumChunkZ; chunkZ += 1) {
      for (let chunkX = minimumChunkX; chunkX <= maximumChunkX; chunkX += 1) {
        if (!canonicalRiverMayAffectChunk({
          chunkX,
          chunkZ,
          settlementReferences,
        })) continue;
        const corridor = createCanonicalRiverSurfaceCorridor({
          sourceStableId: canonicalRiverSourceStableId,
          chunkX,
          chunkZ,
          settlementReferences,
        });
        if (corridor) corridors.push(corridor);
      }
    }
    const result = Object.freeze(corridors);
    riverCorridorWindowCache.set(cacheKey, result);
    if (riverCorridorWindowCache.size > RIVER_CORRIDOR_WINDOW_CACHE_CAPACITY) {
      riverCorridorWindowCache.delete(riverCorridorWindowCache.keys().next().value);
    }
    return result;
  };
  const riverSurfaceCorridorsForClipmapIncrementally = async (
    centerChunkX,
    centerChunkZ,
    policy,
    terrainRiverExtentMeters,
    scheduler,
  ) => {
    const cacheKey = `${centerChunkX},${centerChunkZ}:${terrainRiverExtentMeters}`;
    if (riverCorridorWindowCache.has(cacheKey)) {
      const cached = riverCorridorWindowCache.get(cacheKey);
      riverCorridorWindowCache.delete(cacheKey);
      riverCorridorWindowCache.set(cacheKey, cached);
      return cached;
    }
    const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const settlementReferences = (policy?.regions ?? []).map(region => ({
      settlementId: region.settlementId,
      center: region.center,
      radiusMeters: region.flatCoreRadiusMeters + region.transitionWidthMeters,
    }));
    const minimumChunkX = Math.floor(
      (centerWorldX - terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumChunkX = Math.floor(
      (centerWorldX + terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const minimumChunkZ = Math.floor(
      (centerWorldZ - terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumChunkZ = Math.floor(
      (centerWorldZ + terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const corridors = [];
    for (let chunkZ = minimumChunkZ; chunkZ <= maximumChunkZ; chunkZ += 1) {
      for (let chunkX = minimumChunkX; chunkX <= maximumChunkX; chunkX += 1) {
        if (canonicalRiverMayAffectChunk({ chunkX, chunkZ, settlementReferences })) {
          const corridor = createCanonicalRiverSurfaceCorridor({
            sourceStableId: canonicalRiverSourceStableId,
            chunkX,
            chunkZ,
            settlementReferences,
          });
          if (corridor) corridors.push(corridor);
        }
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
    }
    const result = Object.freeze(corridors);
    riverCorridorWindowCache.set(cacheKey, result);
    if (riverCorridorWindowCache.size > RIVER_CORRIDOR_WINDOW_CACHE_CAPACITY) {
      riverCorridorWindowCache.delete(riverCorridorWindowCache.keys().next().value);
    }
    return result;
  };
  const rememberRiverCorridorWindow = ({
    centerChunkX,
    centerChunkZ,
    terrainRiverExtentMeters,
    corridors,
  }) => {
    const cacheKey = `${centerChunkX},${centerChunkZ}:${terrainRiverExtentMeters}`;
    riverCorridorWindowCache.delete(cacheKey);
    riverCorridorWindowCache.set(cacheKey, Object.freeze([...corridors]));
    if (riverCorridorWindowCache.size > RIVER_CORRIDOR_WINDOW_CACHE_CAPACITY) {
      riverCorridorWindowCache.delete(riverCorridorWindowCache.keys().next().value);
    }
  };
  let clipmapSampleCacheHits = 0;
  let clipmapSampleCacheMisses = 0;
  let clipmapSampleCacheEvictions = 0;
  let farOwnerChunkCacheHits = 0;
  let farOwnerChunkCacheMisses = 0;
  let farOwnerChunkCacheEvictions = 0;
  let ultraOwnerChunkCacheHits = 0;
  let ultraOwnerChunkCacheMisses = 0;
  let ultraOwnerChunkCacheEvictions = 0;
  let treeLodDiagnosticsEnabled = false;
  let disposed = false;
  const SYNC_CANCELLED = Symbol('w8-distant-sync-cancelled');
  const LOCAL_SYNC_CANCELLED = Symbol('w8-local-terrain-sync-cancelled');

  const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
  const createSliceScheduler = ({ assertCurrent, budgetMs = PRESENTATION_SLICE_BUDGET_MS } = {}) => {
    let sliceStartedAt = monotonicNow();
    let units = 0;
    let maximumSliceMs = 0;
    let sliceCount = 0;
    const recordSlice = () => {
      maximumSliceMs = Math.max(maximumSliceMs, monotonicNow() - sliceStartedAt);
    };
    return Object.freeze({
      checkpoint({ force = false, units: completedUnits = 1 } = {}) {
        assertCurrent?.();
        units += completedUnits;
        const elapsed = monotonicNow() - sliceStartedAt;
        if (!force && elapsed < budgetMs && units < PRESENTATION_SLICE_UNIT_LIMIT) return null;
        recordSlice();
        sliceCount += 1;
        return Promise.resolve(yieldToMainThread()).then(() => {
          assertCurrent?.();
          sliceStartedAt = monotonicNow();
          units = 0;
        });
      },
      finish() {
        assertCurrent?.();
        recordSlice();
        return Object.freeze({ maximumSliceMs, sliceCount });
      },
      snapshot() {
        recordSlice();
        return Object.freeze({ maximumSliceMs, sliceCount });
      },
    });
  };

  const acceptCommittedRenderOrigin = renderOrigin => {
    if (!Number.isSafeInteger(renderOrigin?.renderOriginChunkX)
      || !Number.isSafeInteger(renderOrigin?.renderOriginChunkZ)) {
      throw new TypeError('Distant presentation requires a committed render origin');
    }
    const incomingEpoch = Number.isSafeInteger(renderOrigin.rebaseCount)
      ? renderOrigin.rebaseCount : null;
    const currentEpoch = Number.isSafeInteger(committedRenderOrigin?.rebaseCount)
      ? committedRenderOrigin.rebaseCount : null;
    if (incomingEpoch !== null && currentEpoch !== null && incomingEpoch < currentEpoch) {
      staleRenderOriginRejectCount += 1;
      return false;
    }
    if (incomingEpoch !== null && currentEpoch !== null && incomingEpoch === currentEpoch
      && (renderOrigin.renderOriginChunkX !== committedRenderOrigin.renderOriginChunkX
        || renderOrigin.renderOriginChunkZ !== committedRenderOrigin.renderOriginChunkZ)) {
      throw new Error(`Distant render origin identity mismatch at epoch ${incomingEpoch}`);
    }
    const changed = !committedRenderOrigin
      || renderOrigin.renderOriginChunkX !== committedRenderOrigin.renderOriginChunkX
      || renderOrigin.renderOriginChunkZ !== committedRenderOrigin.renderOriginChunkZ
      || (incomingEpoch !== null && incomingEpoch !== currentEpoch);
    if (!changed) return true;
    committedRenderOrigin = Object.freeze({
      renderOriginChunkX: renderOrigin.renderOriginChunkX,
      renderOriginChunkZ: renderOrigin.renderOriginChunkZ,
      rebaseCount: incomingEpoch,
    });
    if (pendingFarSyncEpochs.size > 0 && incomingEpoch !== null
      && (currentEpoch === null || incomingEpoch > currentEpoch)) {
      syncEpoch += 1;
      cancelCanonicalChunkRequests?.({
        consumerId: 'distant-owner-query',
        beforeEpoch: syncEpoch + 1,
      });
    }
    return true;
  };

  const disposeGeneration = generation => {
    if (!generation) return;
    root.remove(generation.root);
    for (const child of generation.root.children ?? []) child.dispose?.();
    generation.root.clear?.();
    for (const geometry of generation.ownedGeometries) geometry.dispose?.();
    generation.ownedGeometries.clear();
    for (const material of generation.ownedMaterials ?? []) material.dispose?.();
    generation.ownedMaterials?.clear?.();
  };

  const readThroughLru = async (cache, key, capacity, load, onCacheEvent = null) => {
    if (cache.has(key)) {
      onCacheEvent?.('hit');
      const entry = cache.get(key);
      cache.delete(key);
      cache.set(key, entry);
      return entry.promise;
    }
    onCacheEvent?.('miss');
    const entry = { pending: true, promise: null };
    entry.promise = Promise.resolve().then(load).then(
      value => {
        entry.pending = false;
        return value;
      },
      error => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      },
    );
    cache.set(key, entry);
    while (cache.size > capacity) {
      const eviction = [...cache].find(([entryKey, value]) => entryKey !== key && !value.pending);
      if (!eviction) break;
      cache.delete(eviction[0]);
      onCacheEvent?.('eviction');
    }
    return entry.promise;
  };

  const baseClipmapSample = (
    worldX,
    worldZ,
    surfacePolicy = currentCanonicalSurfacePolicy,
  ) => {
    let surfacePolicyId = 0;
    if (surfacePolicy && typeof surfacePolicy === 'object') {
      if (!surfacePolicyIds.has(surfacePolicy)) {
        surfacePolicyIds.set(surfacePolicy, nextSurfacePolicyId);
        nextSurfacePolicyId += 1;
      }
      surfacePolicyId = surfacePolicyIds.get(surfacePolicy);
    }
    const key = `${surfacePolicyId}:${worldX},${worldZ}`;
    const cached = clipmapSampleCache.get(key);
    if (cached) {
      clipmapSampleCacheHits += 1;
      return cached;
    }
    const macro = macroEvaluator.evaluate(worldX, worldZ);
    const step = 0.5;
    const dx = (macroEvaluator.evaluate(worldX + step, worldZ).offsetMm
      - macroEvaluator.evaluate(worldX - step, worldZ).offsetMm) * 0.001 / (2 * step);
    const dz = (macroEvaluator.evaluate(worldX, worldZ + step).offsetMm
      - macroEvaluator.evaluate(worldX, worldZ - step).offsetMm) * 0.001 / (2 * step);
    const slope = Math.hypot(dx, dz);
    const biome = biomeEvaluator.evaluate({ x: worldX, z: worldZ }, macro, slope);
    const ridge = clamp(macro.components.ridgesMm / G5_MACRO_TERRAIN.ridges.amplitudeMm, 0, 1);
    const moisture = clamp(biome.climate.moisture
      + clamp(-macro.components.valleysMm / G5_MACRO_TERRAIN.valleys.amplitudeMm, 0, 1) * 0.12
      - ridge * 0.09, 0, 1);
    const rockiness = clamp(0.035 + ridge * 0.36
      + clamp(slope / G5_MACRO_TERRAIN.maximumSlope, 0, 1) * 0.58, 0, 1);
    const naturalHeight = 0.4 + macro.offsetMm * 0.001;
    const naturalColor = w8TerrainColorFromWeights(naturalMaterialWeights(
        biome.memberships, moisture, rockiness, slope,
      ));
    const transition = resolveCanonicalSurfaceWeights(
      surfacePolicy,
      worldX,
      worldZ,
    ).naturalWeight;
    const river = resolveCanonicalRiverBed(
      surfacePolicy?.riverCorridors,
      worldX,
      worldZ,
    );
    const baseHeight = naturalHeight * transition;
    const surface = Object.freeze({
      naturalWeight: transition,
      finiteWeight: 1 - transition,
      riverBankWeight: river.bankWeight,
    });
    const value = Object.freeze({
      height: baseHeight - river.depthMeters,
      baseHeight,
      riverSurfaceHeight: river.depthMeters > 0 ? baseHeight : null,
      color: resolveCanonicalSurfaceColorRgb({ naturalColor, surface, worldX, worldZ }),
      moisture,
      ridge,
    });
    clipmapSampleCache.set(key, value);
    clipmapSampleCacheMisses += 1;
    while (clipmapSampleCache.size > CLIPMAP_SAMPLE_CACHE_CAPACITY) {
      clipmapSampleCache.delete(clipmapSampleCache.keys().next().value);
      clipmapSampleCacheEvictions += 1;
    }
    return value;
  };

  const sampleCanonicalObjectGround = (
    worldX,
    worldZ,
    surfacePolicy = currentCanonicalSurfacePolicy,
  ) => {
    const ownerX = Math.floor(worldX / LOGICAL_CHUNK_SIZE_METERS);
    const ownerZ = Math.floor(worldZ / LOGICAL_CHUNK_SIZE_METERS);
    const localX = worldX - ownerX * LOGICAL_CHUNK_SIZE_METERS;
    const localZ = worldZ - ownerZ * LOGICAL_CHUNK_SIZE_METERS;
    const sampleSpacingMeters = 0.5;
    const fx = clamp(localX / sampleSpacingMeters, 0, 32);
    const fz = clamp(localZ / sampleSpacingMeters, 0, 32);
    const x0 = Math.floor(fx); const z0 = Math.floor(fz);
    const x1 = Math.min(32, x0 + 1); const z1 = Math.min(32, z0 + 1);
    const tx = fx - x0; const tz = fz - z0;
    const at = (sampleX, sampleZ) => Math.round(400 + macroEvaluator.evaluate(
      ownerX * LOGICAL_CHUNK_SIZE_METERS + sampleX * sampleSpacingMeters,
      ownerZ * LOGICAL_CHUNK_SIZE_METERS + sampleZ * sampleSpacingMeters,
    ).offsetMm) * 0.001;
    const northwest = at(x0, z0);
    const northeast = at(x1, z0);
    const southwest = at(x0, z1);
    const southeast = at(x1, z1);
    const naturalHeight = tx + tz <= 1
      ? northwest + tx * (northeast - northwest) + tz * (southwest - northwest)
      : northeast * (1 - tz) + southwest * (1 - tx) + southeast * (tx + tz - 1);
    const naturalWeight = resolveCanonicalSurfaceWeights(
      surfacePolicy,
      worldX,
      worldZ,
    ).naturalWeight;
    return Math.round(naturalHeight * naturalWeight * 1e6) / 1e6;
  };

  const prepareMidgroundTerrainBuild = () => ({
    positions: [],
    colors: [],
    indices: [],
    ownerIndexRanges: new Map(),
  });

  const appendMidgroundTerrainChunk = (build, chunk, origin) => {
    const { positions, colors, indices, ownerIndexRanges } = build;
      const ownerKey = `${chunk.chunkX},${chunk.chunkZ}`;
      const ownerIndexStart = indices.length;
      const terrain = chunk.terrain;
      const sampleAxis = length => {
        const values = [];
        for (let index = 0; index < length - 1; index += 2) values.push(index);
        values.push(length - 1);
        return values;
      };
      const sampleX = sampleAxis(terrain.resolution.x);
      const sampleZ = sampleAxis(terrain.resolution.z);
      const width = sampleX.length; const depth = sampleZ.length;
      const base = positions.length / 3;
      for (let z = 0; z < depth; z += 1) {
        for (let x = 0; x < width; x += 1) {
          const sourceX = sampleX[x];
          const sourceZ = sampleZ[z];
          const index = sourceZ * terrain.resolution.x + sourceX;
          const worldX = chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS
            + sourceX / (terrain.resolution.x - 1) * LOGICAL_CHUNK_SIZE_METERS;
          const worldZ = chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS
            + sourceZ / (terrain.resolution.z - 1) * LOGICAL_CHUNK_SIZE_METERS;
          const surface = chunk.canonicalSurfacePolicy
            ? resolveCanonicalGroundSurface({ chunkData: chunk, worldX, worldZ })
            : { heightMeters: terrain.heights[index] * terrain.heightUnitMeters, naturalWeight: 1, finiteWeight: 0 };
          positions.push(
            (worldX - origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS) * UNITS_PER_METER,
            surface.heightMeters * UNITS_PER_METER,
            (worldZ - origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS) * UNITS_PER_METER,
          );
          const naturalColor = w8TerrainColorFromWeights(
            terrain.materialWeights.slice(index * 5, index * 5 + 5),
          );
          colors.push(...resolveCanonicalSurfaceColorRgb({
            naturalColor, surface, worldX, worldZ,
          }));
        }
      }
      for (let z = 0; z < depth - 1; z += 1) for (let x = 0; x < width - 1; x += 1) {
        const northwest = base + z * width + x;
        indices.push(northwest, northwest + width, northwest + 1,
          northwest + 1, northwest + width, northwest + width + 1);
      }
      ownerIndexRanges.set(ownerKey, Object.freeze({
        start: ownerIndexStart,
        count: indices.length - ownerIndexStart,
      }));
  };

  const finishMidgroundTerrainBuild = (build, context) => {
    const { positions, colors, indices, ownerIndexRanges } = build;
    if (!positions.length) return;
    const allIndices = Object.freeze([...indices]);
    const initialOwnerKeys = sortedKeyList(context.generation.midgroundOwnerKeys);
    const initialIndices = [];
    for (const ownerKey of initialOwnerKeys) {
      const range = ownerIndexRanges.get(ownerKey);
      if (!range) continue;
      initialIndices.push(...allIndices.slice(range.start, range.start + range.count));
    }
    const geometry = makeGeometry(THREE, positions, colors, initialIndices);
    localTerrainOwnerIndexData.set(geometry, Object.freeze({
      allIndices,
      ownerIndexRanges,
      ownerKeys: Object.freeze(sortedKeyList(ownerIndexRanges.keys())),
    }));
    context.ownedGeometries.add(geometry);
    const mesh = new Mesh(geometry, terrainMaterial);
    mesh.name = 'w8-midground-outer-sixteen-terrain';
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.userData = {
      presentationOnly: true,
      localTerrainOwnerHandoff: true,
      ownerKeys: Object.freeze(sortedKeyList(ownerIndexRanges.keys())),
      visibleOwnerKeys: Object.freeze(initialOwnerKeys),
      visibleOwnerIndexCount: initialIndices.length,
    };
    context.generation.localTerrainMesh = mesh;
    context.generation.currentVisibleMidgroundOwnerKeys = new Set(initialOwnerKeys);
    context.target.add(mesh);
  };

  const applyLocalTerrainOwnerHandoff = (
    generation,
    activeDataKeys,
    renderedKeys,
  ) => {
    if (!generation) return false;
    const mesh = generation.localTerrainMesh ?? generation.root.children?.find(child => (
      child.name === 'w8-midground-outer-sixteen-terrain'
    ));
    const ownerData = mesh ? localTerrainOwnerIndexData.get(mesh.geometry) : null;
    if (!mesh || !ownerData) return false;
    generation.localTerrainMesh = mesh;
    const currentActiveKeys = new Set(activeDataKeys);
    const currentRenderedKeys = new Set(renderedKeys);
    const visibleOwnerKeys = ownerData.ownerKeys.filter(ownerKey => (
      generation.activeKeys.has(ownerKey)
        && !currentRenderedKeys.has(ownerKey)
    ));
    const previousSignature = sortedKeyList(
      generation.currentVisibleMidgroundOwnerKeys ?? [],
    ).join('\n');
    const nextSignature = visibleOwnerKeys.join('\n');
    if (previousSignature !== nextSignature) {
      const visibleIndices = [];
      for (const ownerKey of visibleOwnerKeys) {
        const range = ownerData.ownerIndexRanges.get(ownerKey);
        if (!range) continue;
        visibleIndices.push(...ownerData.allIndices.slice(
          range.start,
          range.start + range.count,
        ));
      }
      mesh.geometry.setIndex(visibleIndices);
      mesh.userData.visibleOwnerIndexCount = visibleIndices.length;
      generation.currentVisibleMidgroundOwnerKeys = new Set(visibleOwnerKeys);
    }
    mesh.userData.visibleOwnerKeys = Object.freeze([...visibleOwnerKeys]);
    mesh.userData.handoffActiveDataKeys = Object.freeze(sortedKeyList(currentActiveKeys));
    mesh.userData.handoffRenderedKeys = Object.freeze(sortedKeyList(currentRenderedKeys));
    return true;
  };

  const createMidgroundTerrain = (chunks, origin, context) => {
    const build = prepareMidgroundTerrainBuild();
    for (const chunk of chunks) appendMidgroundTerrainChunk(build, chunk, origin);
    finishMidgroundTerrainBuild(build, context);
  };

  const createMidgroundTerrainIncrementally = async (
    chunks,
    origin,
    context,
    scheduler,
  ) => {
    const build = prepareMidgroundTerrainBuild();
    for (const chunk of chunks) {
      appendMidgroundTerrainChunk(build, chunk, origin);
      const pendingYield = scheduler.checkpoint();
      if (pendingYield) await pendingYield;
    }
    finishMidgroundTerrainBuild(build, context);
    await scheduler.checkpoint({ force: true });
  };

  const canonicalPartsFor = record => {
    if (record.objectType === 'building') {
      return visualAssets.resolveBuildingParts?.(record)
        ?? visualAssets.featureParts[record.presentation.partSetKey]
        ?? record.presentation.parts;
    }
    if (record.presentation?.partSetKey) {
      return visualAssets.featureParts[record.presentation.partSetKey]
        ?? (record.presentation?.parts?.length ? record.presentation.parts : null);
    }
    return null;
  };

  const canonicalIdentity = (record, chunk, parts) => ({
    stableId: record.stableId,
    settlementId: record.settlementId ?? record.parentSettlementId ?? null,
    ...(record.candidateId ? {
      candidateId: record.candidateId,
      subtype: record.subtype ?? null,
    } : {}),
    buildingType: record.buildingType ?? null,
    landmarkType: record.landmarkType ?? null,
    featureType: record.featureType ?? (record.landmarkType ? 'settlement-landmark' : null),
    worldPosition: {
      x: record.worldPosition.x,
      y: record.worldPosition.y,
      z: record.worldPosition.z,
    },
    rotationY: record.rotationY ?? 0,
    dimensions: {
      widthMeters: record.widthMeters ?? null,
      heightMeters: record.heightMeters ?? null,
      depthMeters: record.depthMeters ?? null,
    },
    visual: record.visual ?? null,
    parts: parts?.map(part => ({
      geometry: part.geometry,
      material: part.material,
      position: [...part.position],
      scale: [...part.scale],
      rotation: [...part.rotation],
      materialRole: part.materialRole ?? null,
    })) ?? null,
    owningChunkCoordinate: {
      x: record.owningChunkCoordinate.x,
      z: record.owningChunkCoordinate.z,
    },
    chunkId: chunk.chunkId,
    contentHash: chunk.contentHash,
    sourceW5ContentHash: chunk.sourceW5ContentHash ?? chunk.sourceChunkData?.contentHash ?? null,
  });

  const addCanonicalMatrix = (
    object,
    geometry,
    material,
    name,
    matrix,
    visibilityTiers = Object.freeze(['full']),
    context,
  ) => {
    const key = `${geometry}:${material}:${name}`;
    if (!context.generation.canonicalBuckets.has(key)) {
      context.generation.canonicalBuckets.set(key, {
        geometry,
        material,
        name,
        items: [],
      });
    }
    context.generation.canonicalBuckets.get(key).items.push({
      object,
      matrix: matrix.clone?.() ?? structuredClone(matrix),
      visibilityTiers,
    });
  };

  const registerCanonicalRecord = ({
    record,
    chunk,
    parts,
    farEligible,
    context,
  }) => {
    if (typeof record?.stableId !== 'string'
      || !Number.isFinite(record?.worldPosition?.x)
      || !Number.isFinite(record?.worldPosition?.y)
      || !Number.isFinite(record?.worldPosition?.z)
      || !Number.isInteger(record?.owningChunkCoordinate?.x)
      || !Number.isInteger(record?.owningChunkCoordinate?.z)) {
      throw new Error('canonical distant record is missing identity or ownership');
    }
    const identity = canonicalIdentity(record, chunk, parts);
    const identityKey = JSON.stringify(identity);
    const existing = context.generation.canonicalObjects.get(record.stableId);
    if (existing) {
      if (existing.identityKey !== identityKey) {
        context.stats.identityAuditErrorCount += 1;
        throw new Error(`canonical LOD identity mismatch: ${record.stableId}`);
      }
      existing.farEligible ||= farEligible;
      return { object: existing, isNew: false };
    }
    const object = {
      stableId: record.stableId,
      settlementId: identity.settlementId,
      record,
      identity,
      identityKey,
      ownerKey: `${record.owningChunkCoordinate.x},${record.owningChunkCoordinate.z}`,
      worldX: record.worldPosition.x,
      worldZ: record.worldPosition.z,
      destructible: record.featureType === 'settlement-building' || record.destructible === true,
      farEligible,
      visibleLod: null,
      presentationTier: null,
      instances: [],
    };
    context.generation.canonicalObjects.set(record.stableId, object);
    context.stats.canonicalRecordCount += 1;
    if (record.remotePresentationOnly === true) {
      // Remote silhouettes have dedicated counters below and must not inflate
      // the canonical full-detail category counts.
    } else if (record.featureType === 'settlement-building') {
      context.stats.canonicalBuildingRecordCount += 1;
    } else if (record.featureType === 'natural-vegetation') {
      context.stats.canonicalVegetationRecordCount += 1;
      if (record.subtype === 'shrub') context.stats.canonicalShrubRecordCount += 1;
      else context.stats.canonicalTreeRecordCount += 1;
    } else if (record.featureType === 'natural-rock') {
      context.stats.canonicalRockRecordCount += 1;
    } else if (record.featureType === 'settlement-road') {
      context.stats.canonicalRoadRecordCount += 1;
    } else if (record.featureType === 'canonical-river') {
      context.stats.canonicalActiveRiverRecordCount += 1;
      context.stats.canonicalRiverRecordCount += 1;
      context.stats.canonicalRiverRoadCrossingCount += record.roadCrossings?.length ?? 0;
    } else if (record.objectType === 'streetLamp' || record.objectType === 'roadSign') {
      context.stats.canonicalWorldDetailRecordCount += 1;
    } else if (record.landmarkType) {
      context.stats.canonicalLandmarkRecordCount += 1;
    }
    return { object, isNew: true };
  };

  const canonicalPartMatrix = (record, part, dimensions, origin) => {
    const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const rotationY = Number.isFinite(record.rotationY) ? record.rotationY : 0;
    const offsetX = part.position[0] * dimensions.width;
    const offsetZ = part.position[2] * dimensions.depth;
    const cosine = Math.cos(rotationY); const sine = Math.sin(rotationY);
    transform.position.set(
      (record.worldPosition.x - originMetersX) * UNITS_PER_METER
        + offsetX * cosine + offsetZ * sine,
      record.worldPosition.y * UNITS_PER_METER + part.position[1] * dimensions.height,
      (record.worldPosition.z - originMetersZ) * UNITS_PER_METER
        - offsetX * sine + offsetZ * cosine,
    );
    transform.rotation.set(part.rotation[0], rotationY + part.rotation[1], part.rotation[2]);
    transform.scale.set(
      dimensions.width * part.scale[0],
      dimensions.height * part.scale[1],
      dimensions.depth * part.scale[2],
    );
    transform.updateMatrix();
    return transform.matrix;
  };

  const canonicalTreeSilhouettePart = (record, parts) => {
    if (record.featureType !== 'natural-vegetation' || record.subtype === 'shrub') return null;
    const geometry = record.subtype === 'conifer-tree' ? 'cone' : 'sphere';
    return parts.find(part => part.geometry === geometry) ?? null;
  };

  const isHorizonRecord = record => record?.lodPolicy?.presentationTiers?.includes('horizon') === true;

  const canonicalHorizonParts = (parts, quality = 'high') => {
    const body = parts.find(part => part.materialRole === 'wall') ?? parts[0] ?? null;
    const cap = parts.find(part => part !== body && part.materialRole === 'roof')
      ?? parts.find(part => part !== body && /tower|roof/i.test(part.geometry ?? ''))
      ?? parts.find(part => part !== body)
      ?? null;
    return (quality === 'high' ? [body, cap] : [body]).filter(Boolean);
  };

  const remoteHorizonRecord = ({
    source,
    candidate,
    index,
    kind,
    surfacePolicy,
  }) => {
    const center = candidate.center ?? candidate.worldPosition;
    const x = source.x ?? source.worldPosition?.x ?? center.x;
    const z = source.z ?? source.worldPosition?.z ?? center.z;
    const groundY = sampleCanonicalObjectGround(x, z, surfacePolicy);
    const landmarkType = source.landmarkType ?? null;
    const buildingType = source.buildingType ?? source.type ?? null;
    const partSetKey = landmarkType ?? buildingType;
    const owner = determineDetailCandidateOwner({ x, z });
    return Object.freeze({
      schemaVersion: 'w8-remote-settlement-horizon-record-1',
      objectType: landmarkType ?? 'building',
      stableId: source.stableId ?? `${candidate.settlementId}:remote-horizon:${kind}:${index}`,
      settlementId: candidate.settlementId,
      featureType: kind === 'landmark'
        ? 'settlement-landmark' : 'settlement-building',
      remotePresentationOnly: true,
      buildingType,
      landmarkType,
      visual: source.visual ?? null,
      settlementType: candidate.settlementType ?? null,
      townType: candidate.townType ?? null,
      worldPosition: Object.freeze({ x, y: groundY, z }),
      position: Object.freeze({ x, y: groundY, z }),
      rotationY: source.rotationY ?? 0,
      widthMeters: source.widthMeters ?? 5,
      heightMeters: source.heightMeters ?? 4,
      depthMeters: source.depthMeters ?? 5,
      owningChunkCoordinate: Object.freeze({ x: owner.x, z: owner.z }),
      lodPolicy: Object.freeze({
        schemaVersion: 'w8-remote-settlement-horizon-lod-1',
        visibilityMeters: Object.freeze({ high: Infinity, medium: Infinity, low: 0 }),
        near: null,
        outer: null,
        far: Object.freeze({ ownerSet: 'queried', presentationTier: 'remote-horizon' }),
        presentationTiers: Object.freeze(['remote-horizon']),
        proxy: true,
      }),
      presentation: Object.freeze({
        partSetKey,
        parts: Object.freeze(visualAssets.featureParts[partSetKey] ?? []),
        presentationTiers: Object.freeze(['remote-horizon']),
      }),
      sourceStableId: source.stableId ?? null,
    });
  };

  const remoteHandoffIdentity = record => JSON.stringify({
    stableId: record.stableId,
    settlementId: record.settlementId ?? record.parentSettlementId ?? null,
    buildingType: record.buildingType ?? null,
    landmarkType: record.landmarkType ?? null,
    x: record.worldPosition.x,
    y: record.worldPosition.y,
    z: record.worldPosition.z,
    rotationY: record.rotationY ?? 0,
    widthMeters: record.widthMeters ?? null,
    heightMeters: record.heightMeters ?? null,
    depthMeters: record.depthMeters ?? null,
    ownerX: record.owningChunkCoordinate.x,
    ownerZ: record.owningChunkCoordinate.z,
  });

  const registerRemoteHorizonRecord = ({ record, chunk, parts, context }) => {
    const existing = context.generation.canonicalObjects.get(record.stableId);
    if (!existing) return registerCanonicalRecord({
      record,
      chunk,
      parts,
      farEligible: true,
      context,
    });
    const existingIdentity = remoteHandoffIdentity(existing.record);
    const remoteIdentity = remoteHandoffIdentity(record);
    if (existingIdentity !== remoteIdentity) {
      context.stats.identityAuditErrorCount += 1;
      throw new Error(`canonical remote handoff identity mismatch: ${record.stableId}; ${existingIdentity} !== ${remoteIdentity}`);
    }
    existing.farEligible = true;
    return { object: existing, isNew: false };
  };

  const addRemoteSettlementHorizon = async ({ remote, origin, context, scheduler }) => {
    const { candidate, template, landmarks, radiusMeters } = remote;
    const canonicalBuildings = selectRemoteHorizonBuildings({
      template,
      quality: context.generation.quality,
      renderDistancePreset: context.generation.renderDistancePreset,
    });
    const sources = [
      ...canonicalBuildings.map(source => ({ source, kind: 'building' })),
      ...(landmarks ?? []).map(source => ({ source, kind: 'landmark' })),
    ];
    context.stats.remoteHorizonCanonicalBuildingCount += canonicalBuildings.length;
    let added = 0;
    let addedBuilding = 0;
    for (let index = 0; index < sources.length; index += 1) {
      try {
        const { source, kind } = sources[index];
        const record = remoteHorizonRecord({
          source, candidate, index, kind, surfacePolicy: context.surfacePolicy,
        });
        const parts = kind === 'building'
          ? (visualAssets.resolveBuildingParts?.(record)
            ?? visualAssets.featureParts[record.buildingType]
            ?? record.presentation.parts)
          : visualAssets.featureParts[record.landmarkType] ?? record.presentation.parts;
        const horizonParts = canonicalHorizonParts(parts ?? [], context.generation.quality);
        if (!horizonParts.length) continue;
        const syntheticChunk = {
          chunkId: `remote-horizon:${candidate.settlementId}`,
          contentHash: `remote-horizon:${candidate.settlementId}`,
          sourceW5ContentHash: null,
        };
        const registration = registerRemoteHorizonRecord({
          record,
          chunk: syntheticChunk,
          parts,
          context,
        });
        Object.assign(registration.object, {
          remoteHorizon: true,
          settlementCenterX: (candidate.center ?? candidate.worldPosition).x,
          settlementCenterZ: (candidate.center ?? candidate.worldPosition).z,
          settlementRadiusMeters: radiusMeters,
        });
        if (registration.object.instances.some(instance => (
          instance.item.visibilityTiers.includes('remote-horizon')
        ))) continue;
        const dimensions = {
          width: record.widthMeters * UNITS_PER_METER,
          height: record.heightMeters * UNITS_PER_METER,
          depth: record.depthMeters * UNITS_PER_METER,
        };
        for (const part of horizonParts) {
          addCanonicalMatrix(
            registration.object,
            part.geometry,
            '__remote-horizon__',
            kind === 'building' ? 'remote-horizon-building' : 'remote-horizon-landmark',
            canonicalPartMatrix(record, part, dimensions, origin),
            Object.freeze(['remote-horizon']),
            context,
          );
        }
        context.generation.remotePartBudgetRemaining -= horizonParts.length;
        if (context.generation.remotePartBudgetRemaining < 0) {
          throw new Error('remote Settlement silhouette exceeded its finite-derived part budget');
        }
        if (kind === 'building') {
          context.stats.remoteHorizonBuildingCount += 1;
          if (registration.isNew) context.stats.remoteHorizonSyntheticBuildingCount += 1;
          else context.stats.remoteHorizonMergedBuildingCount += 1;
          addedBuilding += 1;
        } else {
          context.stats.remoteHorizonLandmarkCount += 1;
          if (registration.isNew) context.stats.remoteHorizonSyntheticLandmarkCount += 1;
          else context.stats.remoteHorizonMergedLandmarkCount += 1;
        }
        added += 1;
      } finally {
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
    }
    context.stats.remoteHorizonMissingBuildingCount += canonicalBuildings.length - addedBuilding;
    if (added) context.stats.remoteHorizonSettlementCount += 1;
  };

  const addCanonicalRecord = ({ record, chunk, origin, farEligible, context }) => {
    if (record.featureType === 'canonical-river') {
      const registration = registerCanonicalRecord({
        record,
        chunk,
        parts: [{
          geometry: '__road__',
          material: 'water',
          position: [0, 0, 0],
          scale: [1, 1, 1],
          rotation: [-Math.PI / 2, 0, 0],
        }],
        farEligible,
        context,
      });
      if (!registration.isNew) return;
      const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
      const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
      for (const line of record.centerlines ?? []) {
        for (let index = 0; index < line.length - 1; index += 1) {
          const start = line[index];
          const end = line[index + 1];
          const dx = end.x - start.x;
          const dz = end.z - start.z;
          const worldX = (start.x + end.x) / 2;
          const worldZ = (start.z + end.z) / 2;
          const surfaceY = record.remoteRiverProjection
            ? (baseClipmapSample(worldX, worldZ, context.surfacePolicy).riverSurfaceHeight
              ?? baseClipmapSample(worldX, worldZ, context.surfacePolicy).baseHeight)
            : ((start.y + end.y) / 2);
          transform.position.set(
            (worldX - originMetersX) * UNITS_PER_METER,
            surfaceY * UNITS_PER_METER + 1.5,
            (worldZ - originMetersZ) * UNITS_PER_METER,
          );
          transform.rotation.set(-Math.PI / 2, 0, Math.atan2(dz, dx));
          transform.scale.set(
            (Math.hypot(dx, dz) + 0.01) * UNITS_PER_METER,
            record.widthMeters * UNITS_PER_METER,
            1,
          );
          transform.updateMatrix();
          addCanonicalMatrix(
            registration.object, '__road__', 'water', 'river', transform.matrix, undefined, context,
          );
          context.stats.canonicalActiveRiverSegmentCount += 1;
          context.stats.canonicalActiveRiverLengthMeters += Math.hypot(dx, dz);
          context.stats.canonicalRiverSegmentCount += 1;
          context.stats.canonicalRiverLengthMeters += Math.hypot(dx, dz);
        }
      }
      return;
    }
    if (record.featureType === 'settlement-road') {
      const registration = registerCanonicalRecord({
        record,
        chunk,
        parts: [{
          geometry: '__road__',
          material: 'road',
          position: [0, 0, 0],
          scale: [1, 1, 1],
          rotation: [-Math.PI / 2, 0, 0],
        }],
        farEligible,
        context,
      });
      if (!registration.isNew) return;
      const dx = record.end.x - record.start.x;
      const dz = record.end.z - record.start.z;
      const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
      const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
      transform.position.set(
        ((record.start.x + record.end.x) / 2 - originMetersX) * UNITS_PER_METER,
        (record.worldPosition.y + 0.075) * UNITS_PER_METER,
        ((record.start.z + record.end.z) / 2 - originMetersZ) * UNITS_PER_METER,
      );
      transform.rotation.set(-Math.PI / 2, 0, Math.atan2(dz, dx));
      transform.scale.set(
        Math.hypot(dx, dz) * UNITS_PER_METER,
        record.widthMeters * UNITS_PER_METER,
        1,
      );
      transform.updateMatrix();
      addCanonicalMatrix(
        registration.object, '__road__', 'road', 'road', transform.matrix, undefined, context,
      );
      return;
    }

    const parts = canonicalPartsFor(record);
    if (!parts?.length) {
      throw new Error(`canonical record has no finite visual parts: ${record.stableId}`);
    }
    const registration = registerCanonicalRecord({ record, chunk, parts, farEligible, context });
    if (!registration.isNew) return;
    const dimensions = {
      width: record.widthMeters * UNITS_PER_METER,
      height: record.heightMeters * UNITS_PER_METER,
      depth: record.depthMeters * UNITS_PER_METER,
    };
    if (record.featureType === 'settlement-building') {
      const civic = ['school', 'church'].includes(record.buildingType);
      for (const surface of [record.lot?.path, record.lot?.forecourt]) {
        if (!surface || !(surface.width > 0) || !(surface.depth > 0)) continue;
        const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
        const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
        transform.position.set(
          (surface.centerX - originMetersX) * UNITS_PER_METER,
          (record.worldPosition.y + 0.07575) * UNITS_PER_METER,
          (surface.centerZ - originMetersZ) * UNITS_PER_METER,
        );
        transform.rotation.set(-Math.PI / 2, 0, surface.rotationY);
        transform.scale.set(surface.width * UNITS_PER_METER, surface.depth * UNITS_PER_METER, 1);
        transform.updateMatrix();
        addCanonicalMatrix(
          registration.object,
          '__road__',
          civic ? 'lotCivic' : 'lotResidential',
          'lot',
          transform.matrix,
          undefined,
          context,
        );
      }
    }
    const silhouettePart = canonicalTreeSilhouettePart(record, parts);
    for (const part of parts) {
      const silhouette = part === silhouettePart;
      addCanonicalMatrix(
        registration.object,
        part.geometry,
        part.material,
        silhouette ? 'natural-silhouette'
          : ['natural-vegetation', 'natural-rock'].includes(record.featureType)
            ? 'natural'
            : record.landmarkType ? 'landmark' : 'building',
        canonicalPartMatrix(record, part, dimensions, origin),
        silhouette ? Object.freeze(['full', 'silhouette']) : undefined,
        context,
      );
      if (silhouette && context.generation.quality === 'high') {
        addCanonicalMatrix(
          registration.object,
          part.geometry,
          part.material,
          'natural-ultra',
          canonicalPartMatrix(record, part, dimensions, origin),
          Object.freeze(['ultra']),
          context,
        );
      }
    }
    if (isHorizonRecord(record)) {
      const horizonBucket = record.featureType === 'settlement-building'
        ? 'horizon-building' : 'horizon-landmark';
      for (const part of canonicalHorizonParts(parts, context.generation.quality)) {
        addCanonicalMatrix(
          registration.object,
          part.geometry,
          '__horizon__',
          horizonBucket,
          canonicalPartMatrix(record, part, dimensions, origin),
          Object.freeze(['horizon']),
          context,
        );
      }
    }
  };

  const addCanonicalChunk = async ({
    chunk,
    origin,
    farEligibleSettlementIds = null,
    coveredSettlementIds = null,
    includeNatural = false,
    farNaturalEligible = false,
    includeNearDetails = false,
    queryCenter = null,
    naturalQueryCenter = null,
    queryRadius = Infinity,
    naturalQueryRadius = Infinity,
    naturalDetailQueryRadius = Infinity,
    context,
    scheduler,
  }) => {
    const layers = chunk.presentationLayers;
    if (includeNatural) {
      const candidates = resolveW8CanonicalCandidateSet(chunk);
      for (const candidate of candidates.vegetation) {
        try {
          if (naturalQueryCenter && Math.hypot(
            candidate.worldPosition.x - naturalQueryCenter.x,
            candidate.worldPosition.z - naturalQueryCenter.z,
          ) > naturalQueryRadius) continue;
          const canonical = resolveW8CanonicalWorldObject(candidate);
          const canonicalGroundY = chunk.canonicalSurfacePolicy
            ? resolveCanonicalGroundSurface({
              chunkData: chunk, worldX: canonical.position.x, worldZ: canonical.position.z,
            }).heightMeters : canonical.position.y;
          addCanonicalRecord({
            record: Object.freeze({
              ...canonical,
              worldPosition: Object.freeze({
                ...canonical.worldPosition,
                y: canonicalGroundY,
              }),
              position: Object.freeze({
                ...canonical.position,
                y: canonicalGroundY,
              }),
            }),
            chunk,
            origin,
            farEligible: farNaturalEligible,
            context,
          });
        } finally {
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
      for (const candidate of candidates.rocks) {
        try {
          const sourceRecord = resolveW8RockCanonicalObject(candidate);
          const groundY = chunk.canonicalSurfacePolicy ? resolveCanonicalGroundSurface({
            chunkData: chunk, worldX: sourceRecord.worldPosition.x, worldZ: sourceRecord.worldPosition.z,
          }).heightMeters : sourceRecord.worldPosition.y;
          const record = Object.freeze({
            ...sourceRecord,
            worldPosition: Object.freeze({ ...sourceRecord.worldPosition, y: groundY }),
            position: Object.freeze({ ...sourceRecord.position, y: groundY }),
          });
          const rockVisibilityMeters = resolveW8RockVisibilityMeters(
            record,
            context.generation.renderDistancePreset,
          );
          if (naturalQueryCenter && Math.hypot(
            candidate.worldPosition.x - naturalQueryCenter.x,
            candidate.worldPosition.z - naturalQueryCenter.z,
          ) > Math.min(naturalDetailQueryRadius, rockVisibilityMeters)) continue;
          addCanonicalRecord({
            record,
            chunk,
            origin,
            farEligible: farNaturalEligible,
            context,
          });
        } finally {
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
    }
    if (includeNearDetails) {
      for (const detail of layers?.streetDetails ?? chunk.streetDetails ?? []) {
        try {
          if (!['streetLamp', 'roadSign'].includes(detail.detailType)) continue;
          addCanonicalRecord({
            record: resolveW8CanonicalWorldObject(detail),
            chunk,
            origin,
            farEligible: false,
            context,
          });
        } finally {
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
    }
    if (context.generation.activeKeys.has(`${chunk.chunkX},${chunk.chunkZ}`)) {
      for (const surface of layers?.water ?? chunk.waterSurfaces ?? []) {
        try {
          if (surface.waterType !== 'river') continue;
          // Active Chunk River is owned exclusively by Near/Outer presentation.
          // The staged Far projection is the only representation allowed after
          // this owner leaves the active set, avoiding a duplicate during the
          // delayed Far-root replacement.
          addCanonicalRecord({ record: surface, chunk, origin, farEligible: false, context });
        } finally {
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
    }
    const records = [
      ...(layers?.formal?.roadsAndBuildings ?? chunk.settlementFeatures ?? []),
      ...(layers?.landmarks ?? chunk.settlementLandmarks ?? []),
    ];
    for (const sourceRecord of records) {
      try {
        const record = sourceRecord.featureType === 'settlement-road'
          ? sourceRecord : resolveW8CanonicalWorldObject(sourceRecord);
        const settlementId = record.settlementId ?? record.parentSettlementId;
        const canonicalMajorRoad = record.canonicalMajorRoad === true;
        const queriedOwner = canonicalMajorRoad
          || farEligibleSettlementIds?.has(settlementId) === true;
        const farEligible = canonicalMajorRoad
          || queriedOwner || coveredSettlementIds?.has(settlementId) === true;
        if (farEligibleSettlementIds && !queriedOwner) continue;
        if (queryCenter && Math.hypot(
          record.worldPosition.x - queryCenter.x,
          record.worldPosition.z - queryCenter.z,
        ) > queryRadius) continue;
        addCanonicalRecord({ record, chunk, origin, farEligible, context });
      } finally {
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
    }
  };

  const createHorizonSilhouetteMaterial = () => new Material({
    color: 0x3a3932,
    flatShading: true,
    shininess: 0,
  });

  const createRemoteHorizonSilhouetteMaterial = () => new Material({
    color: 0x3a3932,
    flatShading: true,
    shininess: 0,
    fog: false,
  });

  const prepareCanonicalBucketMesh = (bucket, context) => {
    if (!bucket.items.length) return null;
    const roadBucketStartedAt = bucket.geometry === '__road__' ? monotonicNow() : null;
    const geometry = bucket.geometry === '__road__'
      ? roadGeometry : visualAssets.geometries[bucket.geometry];
    const sourceMaterial = visualAssets.materials[bucket.material];
    const localHorizon = bucket.name === 'horizon-building'
      || bucket.name === 'horizon-landmark';
    const remoteHorizon = bucket.name === 'remote-horizon-building'
      || bucket.name === 'remote-horizon-landmark';
    const generatedMaterial = localHorizon || remoteHorizon;
    if (!geometry || (!sourceMaterial && !generatedMaterial)) {
      throw new Error(`canonical finite visual resource is missing: ${bucket.geometry}/${bucket.material}`);
    }
    let material = sourceMaterial;
    if (localHorizon) {
      material = context.generation.horizonSilhouetteMaterial
        ?? createHorizonSilhouetteMaterial();
      context.generation.horizonSilhouetteMaterial = material;
      context.generation.ownedMaterials.add(material);
    } else if (remoteHorizon) {
      material = context.generation.remoteHorizonSilhouetteMaterial
        ?? createRemoteHorizonSilhouetteMaterial();
      context.generation.remoteHorizonSilhouetteMaterial = material;
      context.generation.ownedMaterials.add(material);
    }
    const mesh = new InstancedMesh(geometry, material, bucket.items.length);
    mesh.name = `w8-canonical-lod-${bucket.name}-${bucket.geometry}-${bucket.material}`;
    mesh.count = 0;
    mesh.visible = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData = {
      presentationOnly: true,
      canonicalStableIds: [],
      canonicalObjects: [],
    };
    return { mesh, roadBucketStartedAt };
  };

  const completeCanonicalBucketMesh = (bucket, context, prepared) => {
    bucket.mesh = prepared.mesh;
    context.target.add(prepared.mesh);
    if (prepared.roadBucketStartedAt !== null) {
      context.stats.canonicalRoadMeshBucketCount += 1;
      context.stats.canonicalRoadMeshComposeMs += monotonicNow() - prepared.roadBucketStartedAt;
    }
    context.stats.canonicalMeshCount += 1;
    if (prepared.mesh.visible !== false) context.stats.canonicalVisibleMeshCount += 1;
  };

  const finalizeCanonicalMeshesIncrementally = async (context, scheduler) => {
    for (const bucket of context.generation.canonicalBuckets.values()) {
      const prepared = prepareCanonicalBucketMesh(bucket, context);
      if (!prepared) continue;
      for (const item of bucket.items) {
        item.object.instances.push({ bucket, item });
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
      completeCanonicalBucketMesh(bucket, context, prepared);
      const pendingYield = scheduler.checkpoint();
      if (pendingYield) await pendingYield;
    }
  };

  const positionGenerationForOrigin = (generation, renderOrigin) => {
    if (!generation || !renderOrigin) return;
    generation.currentOriginChunkX = renderOrigin.renderOriginChunkX;
    generation.currentOriginChunkZ = renderOrigin.renderOriginChunkZ;
    generation.root.position.set(
      (generation.buildOriginChunkX - renderOrigin.renderOriginChunkX)
        * LOGICAL_CHUNK_SIZE_METERS * UNITS_PER_METER,
      0,
      (generation.buildOriginChunkZ - renderOrigin.renderOriginChunkZ)
        * LOGICAL_CHUNK_SIZE_METERS * UNITS_PER_METER,
    );
  };

  const finishCanonicalCompose = (generation, composed, matrixUpdates) => {
    const nearStableIds = generation.nearVisibleStableIds ?? new Set();
    generation.stats.canonicalComposeCount += 1;
    generation.stats.canonicalDirtyBucketCount += composed;
    generation.stats.canonicalMatrixUpdateCount += matrixUpdates;
    generation.stats.canonicalNeedsUpdateCount += composed;
    generation.stats.remoteHorizonSuppressedByNearCount = [...generation.canonicalObjects.values()]
      .filter(object => object.remoteHorizon && nearStableIds.has(object.stableId)).length;
    const distantVisibleStableIds = new Set();
    for (const bucket of generation.canonicalBuckets.values()) {
      for (const stableId of bucket.mesh?.userData?.canonicalStableIds ?? []) {
        distantVisibleStableIds.add(stableId);
      }
    }
    const nearVisibleStableIds = new Set(getNearVisibleStableIds() ?? []);
    const duplicates = [...distantVisibleStableIds]
      .filter(stableId => nearVisibleStableIds.has(stableId))
      .sort((left, right) => left.localeCompare(right));
    generation.stats.duplicateVisibleStableIds = Object.freeze(duplicates);
    generation.stats.duplicateVisibleStableIdCount = duplicates.length;
    generation.distantVisibleStableIds = distantVisibleStableIds;
    return Object.freeze({ buckets: composed, matrices: matrixUpdates });
  };

  const composeCanonicalMeshes = (generation, dirtyBuckets = generation.canonicalBuckets) => {
    let composed = 0;
    let matrixUpdates = 0;
    const nearStableIds = generation.nearVisibleStableIds ?? new Set();
    for (const bucket of dirtyBuckets.values()) {
      const mesh = bucket.mesh;
      if (!mesh) continue;
      const roadBucketStartedAt = bucket.geometry === '__road__' ? monotonicNow() : null;
      let count = 0;
      const stableIds = [];
      const canonicalObjects = [];
      for (const item of bucket.items) {
        if (!['mid', 'far'].includes(item.object.visibleLod)
          || (item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
          || !item.object.presentationTier
          || !item.visibilityTiers.includes(item.object.presentationTier)) continue;
        mesh.setMatrixAt(count, item.matrix);
        matrixUpdates += 1;
        stableIds.push(item.object.stableId);
        canonicalObjects.push(item.object.record);
        count += 1;
      }
      mesh.count = count;
      mesh.userData.canonicalStableIds = stableIds;
      mesh.userData.canonicalObjects = canonicalObjects;
      mesh.instanceMatrix.needsUpdate = true;
      if (roadBucketStartedAt !== null) {
        generation.stats.canonicalRoadMatrixComposeMs += monotonicNow() - roadBucketStartedAt;
      }
      composed += 1;
    }
    return finishCanonicalCompose(generation, composed, matrixUpdates);
  };

  const composeCanonicalMeshesIncrementally = async (
    generation,
    dirtyBuckets,
    scheduler,
  ) => {
    let composed = 0;
    let matrixUpdates = 0;
    const nearStableIds = generation.nearVisibleStableIds ?? new Set();
    for (const bucket of dirtyBuckets.values()) {
      const mesh = bucket.mesh;
      if (!mesh) continue;
      const roadBucketStartedAt = bucket.geometry === '__road__' ? monotonicNow() : null;
      let count = 0;
      const stableIds = [];
      const canonicalObjects = [];
      for (const item of bucket.items) {
        if (['mid', 'far'].includes(item.object.visibleLod)
          && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
          && item.object.presentationTier
          && item.visibilityTiers.includes(item.object.presentationTier)) {
          mesh.setMatrixAt(count, item.matrix);
          matrixUpdates += 1;
          stableIds.push(item.object.stableId);
          canonicalObjects.push(item.object.record);
          count += 1;
        }
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
      mesh.count = count;
      mesh.userData.canonicalStableIds = stableIds;
      mesh.userData.canonicalObjects = canonicalObjects;
      mesh.instanceMatrix.needsUpdate = true;
      if (roadBucketStartedAt !== null) {
        generation.stats.canonicalRoadMatrixComposeMs += monotonicNow() - roadBucketStartedAt;
      }
      composed += 1;
      const pendingYield = scheduler.checkpoint();
      if (pendingYield) await pendingYield;
    }
    return finishCanonicalCompose(generation, composed, matrixUpdates);
  };

  const sortedKeyList = values => [...values].sort((left, right) => left.localeCompare(right));
  const equalKeySets = (left, right) => left.size === right.size
    && [...left].every(key => right.has(key));

  const updateTreeLodDiagnosticRing = generation => {
    const diagnostic = generation.treeLodDiagnostics;
    if (!diagnostic?.ringGeometry) return;
    const originX = generation.buildOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originZ = generation.buildOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const positions = [];
    const segmentCount = 64;
    for (let index = 0; index < segmentCount; index += 1) {
      const firstAngle = index / segmentCount * Math.PI * 2;
      const secondAngle = (index + 1) / segmentCount * Math.PI * 2;
      for (const angle of [firstAngle, secondAngle]) {
        const ringMeters = generation.renderDistancePolicy.treeLod.silhouetteVisibility;
        const worldX = generation.playerX + Math.cos(angle) * ringMeters;
        const worldZ = generation.playerZ + Math.sin(angle) * ringMeters;
        positions.push(
          (worldX - originX) * UNITS_PER_METER,
          (baseClipmapSample(worldX, worldZ, generation.surfacePolicy).height + 0.18)
            * UNITS_PER_METER,
          (worldZ - originZ) * UNITS_PER_METER,
        );
      }
    }
    diagnostic.ringGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    );
    const position = diagnostic.ringGeometry.getAttribute?.('position')
      ?? diagnostic.ringGeometry.attributes?.position;
    if (position) position.needsUpdate = true;
  };

  const updateTreeLodDiagnostics = generation => {
    const diagnostic = generation.treeLodDiagnostics;
    if (!diagnostic) return;
    diagnostic.root.visible = treeLodDiagnosticsEnabled;
    if (!treeLodDiagnosticsEnabled) return;
    for (const entry of diagnostic.entries) {
      let fullCount = 0;
      let silhouetteCount = 0;
      let ultraCount = 0;
      for (const item of entry.bucket.items) {
        if (entry.full && item.object.presentationTier === 'full') {
          entry.full.setMatrixAt(fullCount, item.matrix);
          fullCount += 1;
        } else if (entry.silhouette && item.object.presentationTier === 'silhouette') {
          entry.silhouette?.setMatrixAt(silhouetteCount, item.matrix);
          silhouetteCount += 1;
        } else if (entry.ultra && item.object.presentationTier === 'ultra') {
          entry.ultra?.setMatrixAt(ultraCount, item.matrix);
          ultraCount += 1;
        }
      }
      if (entry.full) {
        entry.full.count = fullCount;
        entry.full.instanceMatrix.needsUpdate = true;
      }
      if (entry.silhouette) {
        entry.silhouette.count = silhouetteCount;
        entry.silhouette.instanceMatrix.needsUpdate = true;
      }
      if (entry.ultra) {
        entry.ultra.count = ultraCount;
        entry.ultra.instanceMatrix.needsUpdate = true;
      }
    }
    updateTreeLodDiagnosticRing(generation);
  };

  const createTreeLodDiagnostics = generation => {
    if (generation.treeLodDiagnostics || !treeLodDiagnosticsEnabled) return;
    if (typeof THREE.LineSegments !== 'function' || typeof THREE.LineBasicMaterial !== 'function') return;
    const BufferGeometry = requireConstructor(THREE, 'BufferGeometry');
    const LineSegments = requireConstructor(THREE, 'LineSegments');
    const DiagnosticMaterial = typeof THREE.MeshBasicMaterial === 'function'
      ? THREE.MeshBasicMaterial : Material;
    const rootDiagnostic = new Group();
    rootDiagnostic.name = 'w8-tree-lod-diagnostics';
    rootDiagnostic.userData = { presentationOnly: true, debugOnly: true };
    const entries = [];
    for (const bucket of generation.canonicalBuckets.values()) {
      if (!['natural-silhouette', 'natural-ultra'].includes(bucket.name) || !bucket.mesh) continue;
      const fullMaterial = new DiagnosticMaterial({
        color: 0xffe600, transparent: true, opacity: 0.92, depthTest: false, depthWrite: false,
      });
      const silhouetteMaterial = new DiagnosticMaterial({
        color: 0x168bff, transparent: true, opacity: 0.96, depthTest: false, depthWrite: false,
      });
      if (bucket.name === 'natural-silhouette') {
        const full = new InstancedMesh(bucket.mesh.geometry, fullMaterial, bucket.items.length);
        const silhouette = new InstancedMesh(bucket.mesh.geometry, silhouetteMaterial, bucket.items.length);
        full.name = `w8-tree-lod-debug-full-${bucket.geometry}`;
        silhouette.name = `w8-tree-lod-debug-silhouette-${bucket.geometry}`;
        full.userData = { presentationOnly: true, debugOnly: true, treeLodTier: 'full' };
        silhouette.userData = { presentationOnly: true, debugOnly: true, treeLodTier: 'silhouette' };
        full.renderOrder = 10_000; silhouette.renderOrder = 10_001;
        full.frustumCulled = false; silhouette.frustumCulled = false;
        rootDiagnostic.add(full); rootDiagnostic.add(silhouette);
        generation.ownedMaterials.add(fullMaterial); generation.ownedMaterials.add(silhouetteMaterial);
        entries.push({ bucket, full, silhouette });
      } else {
        const ultra = new InstancedMesh(bucket.mesh.geometry, silhouetteMaterial, bucket.items.length);
        ultra.name = `w8-tree-lod-debug-ultra-${bucket.geometry}`;
        ultra.userData = { presentationOnly: true, debugOnly: true, treeLodTier: 'ultra' };
        ultra.renderOrder = 10_001; ultra.frustumCulled = false;
        rootDiagnostic.add(ultra);
        fullMaterial.dispose?.();
        generation.ownedMaterials.add(silhouetteMaterial);
        entries.push({ bucket, ultra });
      }
    }
    const ringGeometry = new BufferGeometry();
    const ringMaterial = new THREE.LineBasicMaterial({
      color: 0x28d7ff, transparent: true, opacity: 1, depthTest: false, depthWrite: false,
    });
    const ring = new LineSegments(ringGeometry, ringMaterial);
    ring.name = 'w8-tree-lod-debug-84m-ring';
    ring.userData = {
      presentationOnly: true,
      debugOnly: true,
      radiusMeters: generation.renderDistancePolicy.treeLod.silhouetteVisibility,
    };
    ring.renderOrder = 10_002;
    ring.frustumCulled = false;
    rootDiagnostic.add(ring);
    generation.ownedGeometries.add(ringGeometry);
    generation.ownedMaterials.add(ringMaterial);
    generation.root.add(rootDiagnostic);
    generation.treeLodDiagnostics = { root: rootDiagnostic, entries, ringGeometry };
    updateTreeLodDiagnostics(generation);
  };

  const disposeTreeLodDiagnostics = generation => {
    const diagnostic = generation?.treeLodDiagnostics;
    if (!diagnostic) return;
    generation.root.remove(diagnostic.root);
    for (const entry of diagnostic.entries) {
      entry.full?.material?.dispose?.(); entry.silhouette?.material?.dispose?.();
      entry.ultra?.material?.dispose?.();
      generation.ownedMaterials.delete(entry.full?.material);
      generation.ownedMaterials.delete(entry.silhouette?.material);
      generation.ownedMaterials.delete(entry.ultra?.material);
    }
    const ring = diagnostic.root.children?.find?.(child => (
      child.name === 'w8-tree-lod-debug-84m-ring'
    ));
    ring?.material?.dispose?.();
    generation.ownedMaterials.delete(ring?.material);
    diagnostic.ringGeometry.dispose?.();
    generation.ownedGeometries.delete(diagnostic.ringGeometry);
    diagnostic.root.clear?.();
    generation.treeLodDiagnostics = null;
  };

  const canonicalTreePresentationTier = (
    object,
    distanceMeters,
    quality,
    visible,
    treeLod,
  ) => {
    if (!visible) return null;
    if (object.record.featureType !== 'natural-vegetation'
      || object.record.subtype === 'shrub') return 'full';
    if (distanceMeters >= treeLod.ultraVisibility) return null;
    if (distanceMeters >= treeLod.ultraFadeStart) {
      const fade = 1 - smoothstep((distanceMeters - treeLod.ultraFadeStart)
        / (treeLod.ultraVisibility - treeLod.ultraFadeStart));
      const ditherRank = textHash(`${object.stableId}:w8-high-tree-ultra-fade`) / 0x1_0000_0000;
      if (!(ditherRank < fade)) return null;
    }
    const rank = textHash(object.stableId) / 0x1_0000_0000;
    const fullHandoff = treeLod.fullToSilhouette.minimum
      + (treeLod.fullToSilhouette.maximum
        - treeLod.fullToSilhouette.minimum) * rank;
    if (distanceMeters < fullHandoff) return 'full';
    if (quality !== 'high') return 'silhouette';
    const ultraHandoff = treeLod.silhouetteToUltra.minimum
      + (treeLod.silhouetteToUltra.maximum
        - treeLod.silhouetteToUltra.minimum) * rank;
    return distanceMeters < ultraHandoff ? 'silhouette' : 'ultra';
  };

  const canonicalSettlementPresentationTier = (
    object,
    distanceMeters,
    quality,
    visible,
    currentSettlementId,
    settlementLod,
  ) => {
    if (!visible) return null;
    if (!isHorizonRecord(object.record)) return 'full';
    if (!currentSettlementId || object.settlementId !== currentSettlementId) return 'full';
    if (distanceMeters >= settlementLod.visibilityMeters) return null;
    if (distanceMeters >= settlementLod.fadeStartMeters) {
      const fade = 1 - smoothstep((distanceMeters - settlementLod.fadeStartMeters)
        / (settlementLod.visibilityMeters - settlementLod.fadeStartMeters));
      const ditherRank = textHash(`${object.stableId}:w8-high-building-horizon-fade`) / 0x1_0000_0000;
      if (!(ditherRank < fade)) return null;
    }
    return distanceMeters < settlementLod.fullDistanceMeters ? 'full' : 'horizon';
  };

  const remoteSettlementPresentationTier = (
    object,
    boundaryDistanceMeters,
    quality,
    renderDistancePreset,
    visible,
  ) => {
    if (!visible || !object.remoteHorizon) return null;
    const policy = resolveW8SettlementPresentationPolicy(
      quality,
      renderDistancePreset,
    ).remote;
    if (boundaryDistanceMeters > policy.hiddenDistanceMeters) return null;
    return 'remote-horizon';
  };

  const updateCanonicalVisibility = (
    generation,
    playerX,
    playerZ,
    { compose = true } = {},
  ) => {
    if (!generation) return;
    const renderDistancePolicy = generation.renderDistancePolicy
      ?? resolveW8RenderDistancePolicy(generation.renderDistancePreset);
    const visibility = renderDistancePolicy.generalObjectVisibilityMeters;
    const naturalVisibility = renderDistancePolicy.naturalVisibilityMeters;
    let farCount = 0;
    let midCount = 0;
    let nearCount = 0;
    let hiddenCount = 0;
    let destroyedCount = 0;
    let visibleCount = 0;
    let visibleVegetationCount = 0;
    let visibleTreeCount = 0;
    let visibleShrubCount = 0;
    let visibleRockCount = 0;
    let visibleFullTreeCount = 0;
    let visibleSilhouetteTreeCount = 0;
    let visibleUltraTreeCount = 0;
    let visibleTreePartInstanceCount = 0;
    let visibleTreeMidBandCount = 0;
    let visibleTreeOuterBandCount = 0;
    let visibleTreeUltraInnerBandCount = 0;
    let visibleTreeUltraOuterBandCount = 0;
    let visibleHorizonBuildingCount = 0;
    let visibleHorizonLandmarkCount = 0;
    let visibleBuildingPartInstanceCount = 0;
    let visibleHorizonPartInstanceCount = 0;
    let destroyedHorizonBuildingCount = 0;
    const visibleRemoteSettlementIds = new Set();
    const activeOwners = new Set();
    const renderedOwners = new Set();
    const dirtyBuckets = new Map();
    const nearVisibleStableIds = new Set(getNearVisibleStableIds() ?? []);
    const nearVisibleSettlementIds = new Set([...generation.canonicalObjects.values()]
      .filter(object => nearVisibleStableIds.has(object.stableId))
      .map(object => object.settlementId)
      .filter(Boolean));
    const nearStableSignature = sortedKeyList(nearVisibleStableIds).join('\n');
    if (nearStableSignature !== generation.nearVisibleStableSignature) {
      for (const object of generation.canonicalObjects.values()) {
        if (!object.remoteHorizon) continue;
        for (const instance of object.instances) {
          dirtyBuckets.set(
            instance.bucket.name + ':' + instance.bucket.geometry + ':' + instance.bucket.material,
            instance.bucket,
          );
        }
      }
      generation.nearVisibleStableSignature = nearStableSignature;
    }
    generation.nearVisibleStableIds = nearVisibleStableIds;
    generation.nearVisibleSettlementIds = nearVisibleSettlementIds;
    for (const object of generation.canonicalObjects.values()) {
      let nextLod = 'hidden';
      const distanceMeters = Math.hypot(object.worldX - playerX, object.worldZ - playerZ);
      const remoteCenterDistanceMeters = object.remoteHorizon ? Math.hypot(
        object.settlementCenterX - playerX,
        object.settlementCenterZ - playerZ,
      ) : distanceMeters;
      const remoteBoundaryDistanceMeters = object.remoteHorizon
        ? Math.max(0, remoteCenterDistanceMeters - object.settlementRadiusMeters)
        : distanceMeters;
      const tree = object.record.featureType === 'natural-vegetation'
        && object.record.subtype !== 'shrub';
      const rock = object.record.featureType === 'natural-rock';
      const natural = object.record.featureType === 'natural-vegetation'
        || rock;
      const policyVisibility = object.record.lodPolicy
        ? resolveW8ObjectVisibilityMeters(object.record, generation.renderDistancePreset)
        : null;
      const objectNaturalVisibility = policyVisibility ?? naturalVisibility;
      const objectVisibility = policyVisibility ?? visibility;
      const insideNaturalVisibility = generation.quality === 'high' && tree
        ? distanceMeters < objectNaturalVisibility
        : distanceMeters <= objectNaturalVisibility;
      const remoteTier = remoteSettlementPresentationTier(
        object,
        remoteBoundaryDistanceMeters,
        generation.quality,
        generation.renderDistancePreset,
        !nearVisibleStableIds.has(object.stableId),
      );
      const hasLocalPresentation = object.instances.some(instance => (
        instance.item.visibilityTiers.includes('full')
          || instance.item.visibilityTiers.includes('horizon')
      ));
      if (object.destructible && isFeatureDestroyed(object.stableId)) {
        nextLod = 'destroyed';
        if (isHorizonRecord(object.record)
          && distanceMeters >= renderDistancePolicy.settlementLod.fullDistanceMeters
          && distanceMeters < renderDistancePolicy.settlementLod.visibilityMeters) {
          destroyedHorizonBuildingCount += 1;
        }
      } else if (nearVisibleStableIds.has(object.stableId)
        || (hasLocalPresentation && generation.renderedKeys.has(object.ownerKey))) {
        nextLod = 'near';
      } else if (hasLocalPresentation && generation.activeKeys.has(object.ownerKey)
        && (object.record.lodPolicy?.outer !== null)
        && (!natural || insideNaturalVisibility)) {
        nextLod = 'mid';
      } else if (hasLocalPresentation
        && object.farEligible && object.record.lodPolicy?.far !== null) {
        const insideVisibility = natural
          ? insideNaturalVisibility
          : distanceMeters <= objectVisibility;
        if (insideVisibility) nextLod = 'far';
      }
      if (nextLod === 'hidden' && remoteTier) nextLod = 'far';
      const distantVisible = nextLod === 'far' || nextLod === 'mid';
      let presentationTier = tree
        ? canonicalTreePresentationTier(
          object,
          distanceMeters,
          generation.quality,
          distantVisible,
          renderDistancePolicy.treeLod,
        )
        : canonicalSettlementPresentationTier(
          object,
          distanceMeters,
          generation.quality,
          distantVisible,
          generation.currentSettlementId,
          renderDistancePolicy.settlementLod,
        );
      if (distantVisible && object.remoteHorizon && !hasLocalPresentation) {
        presentationTier = remoteTier;
      }
      if (distantVisible && !presentationTier && remoteTier) {
        nextLod = 'far';
        presentationTier = remoteTier;
      }
      if (nextLod === 'near') {
        presentationTier = object.record.lodPolicy?.outer === null ? null : 'full';
      }
      if ((tree || isHorizonRecord(object.record) || object.remoteHorizon)
        && distantVisible && !presentationTier) {
        nextLod = 'hidden';
        presentationTier = null;
      }
      if (nextLod === 'far') farCount += 1;
      if (nextLod === 'mid') midCount += 1;
      if (nextLod === 'near') nearCount += 1;
      if (nextLod === 'hidden') hiddenCount += 1;
      if (nextLod === 'destroyed') destroyedCount += 1;
      if (generation.activeKeys.has(object.ownerKey)) activeOwners.add(object.ownerKey);
      if (generation.renderedKeys.has(object.ownerKey)) renderedOwners.add(object.ownerKey);
      if (nextLod === 'far' || nextLod === 'mid') visibleCount += 1;
      if (object.remoteHorizon && nextLod === 'far'
        && presentationTier === 'remote-horizon') {
        visibleRemoteSettlementIds.add(object.settlementId);
      }
      if ((nextLod === 'far' || nextLod === 'mid' || nextLod === 'near')
        && object.record.featureType === 'natural-vegetation') {
        visibleVegetationCount += 1;
        if (object.record.subtype === 'shrub') visibleShrubCount += 1;
        else {
          visibleTreeCount += 1;
          if ((nextLod === 'far' || nextLod === 'mid')
            && distanceMeters >= renderDistancePolicy.treeLod.fullToSilhouette.maximum
            && distanceMeters < renderDistancePolicy.treeLod.silhouetteToUltra.minimum) {
            visibleTreeMidBandCount += 1;
          } else if ((nextLod === 'far' || nextLod === 'mid')
            && distanceMeters >= renderDistancePolicy.treeLod.silhouetteToUltra.minimum
            && distanceMeters < renderDistancePolicy.treeLod.silhouetteVisibility) {
            visibleTreeOuterBandCount += 1;
          } else if ((nextLod === 'far' || nextLod === 'mid')
            && distanceMeters >= renderDistancePolicy.treeLod.silhouetteVisibility
            && distanceMeters < renderDistancePolicy.treeLod.ultraFadeStart) {
            visibleTreeUltraInnerBandCount += 1;
          } else if ((nextLod === 'far' || nextLod === 'mid')
            && distanceMeters >= renderDistancePolicy.treeLod.ultraFadeStart
            && distanceMeters < renderDistancePolicy.treeLod.ultraVisibility) {
            visibleTreeUltraOuterBandCount += 1;
          }
          const visibleTreeTier = nextLod === 'near'
            ? 'full'
            : presentationTier;
          if (visibleTreeTier === 'silhouette') {
            visibleSilhouetteTreeCount += 1;
            visibleTreePartInstanceCount += 1;
          } else if (visibleTreeTier === 'ultra') {
            visibleUltraTreeCount += 1;
            visibleTreePartInstanceCount += 1;
          } else {
            visibleFullTreeCount += 1;
            visibleTreePartInstanceCount += object.instances.filter(instance => (
              instance.item.visibilityTiers.includes('full')
            )).length;
          }
        }
      } else if ((nextLod === 'far' || nextLod === 'mid' || nextLod === 'near')
        && object.record.featureType === 'natural-rock') {
        visibleRockCount += 1;
      } else if ((isHorizonRecord(object.record) || object.remoteHorizon)
        && (nextLod === 'far' || nextLod === 'mid' || nextLod === 'near')) {
        if (presentationTier === 'horizon' || presentationTier === 'remote-horizon') {
          if (object.record.featureType === 'settlement-building') visibleHorizonBuildingCount += 1;
          else if (!object.remoteHorizon) visibleHorizonLandmarkCount += 1;
          visibleHorizonPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes(presentationTier)
          )).length;
        } else {
          visibleBuildingPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes('full')
          )).length;
        }
      }
      if (object.visibleLod === nextLod && object.presentationTier === presentationTier) continue;
      for (const instance of object.instances) {
        dirtyBuckets.set(instance.bucket.name + ':' + instance.bucket.geometry + ':' + instance.bucket.material, instance.bucket);
      }
      object.visibleLod = nextLod;
      object.presentationTier = presentationTier;
    }
    generation.playerX = playerX;
    generation.playerZ = playerZ;
    generation.stats.remoteHorizonPartInstanceCount = 0;
    for (const object of generation.canonicalObjects.values()) {
      if (object.remoteHorizon && object.visibleLod === 'far'
        && object.presentationTier === 'remote-horizon') {
        generation.stats.remoteHorizonPartInstanceCount += object.instances.filter(instance => (
          instance.item.visibilityTiers.includes('remote-horizon')
        )).length;
      }
    }
    if (compose && dirtyBuckets.size) composeCanonicalMeshes(generation, dirtyBuckets);
    generation.stats.canonicalFarObjectCount = farCount;
    generation.stats.canonicalMidObjectCount = midCount;
    generation.stats.canonicalNearObjectCount = nearCount;
    generation.stats.canonicalHiddenObjectCount = hiddenCount;
    generation.stats.canonicalDestroyedObjectCount = destroyedCount;
    generation.stats.canonicalActiveOwnerCount = activeOwners.size;
    generation.stats.canonicalRenderedOwnerCount = renderedOwners.size;
    generation.stats.visibleCanonicalObjectCount = visibleCount;
    generation.stats.visibleCanonicalVegetationCount = visibleVegetationCount;
    generation.stats.visibleCanonicalTreeCount = visibleTreeCount;
    generation.stats.visibleCanonicalShrubCount = visibleShrubCount;
    generation.stats.visibleCanonicalRockCount = visibleRockCount;
    generation.stats.visibleCanonicalFullTreeCount = visibleFullTreeCount;
    generation.stats.visibleCanonicalSilhouetteTreeCount = visibleSilhouetteTreeCount;
    generation.stats.visibleCanonicalUltraTreeCount = visibleUltraTreeCount;
    generation.stats.visibleCanonicalTreePartInstanceCount = visibleTreePartInstanceCount;
    generation.stats.visibleCanonicalTreeMidBandCount = visibleTreeMidBandCount;
    generation.stats.visibleCanonicalTreeOuterBandCount = visibleTreeOuterBandCount;
    generation.stats.visibleCanonicalTreeUltraInnerBandCount = visibleTreeUltraInnerBandCount;
    generation.stats.visibleCanonicalTreeUltraOuterBandCount = visibleTreeUltraOuterBandCount;
    generation.stats.visibleCanonicalHorizonBuildingCount = visibleHorizonBuildingCount;
    generation.stats.visibleCanonicalHorizonLandmarkCount = visibleHorizonLandmarkCount;
    generation.stats.visibleCanonicalBuildingPartInstanceCount = visibleBuildingPartInstanceCount;
    generation.stats.visibleCanonicalHorizonPartInstanceCount = visibleHorizonPartInstanceCount;
    generation.stats.destroyedHorizonBuildingCount = destroyedHorizonBuildingCount;
    generation.stats.visibleRemoteHorizonSettlementCount = visibleRemoteSettlementIds.size;
    if (treeLodDiagnosticsEnabled && !generation.treeLodDiagnostics) {
      createTreeLodDiagnostics(generation);
    } else if (generation.treeLodDiagnostics) {
      updateTreeLodDiagnostics(generation);
    }
    return dirtyBuckets;
  };

  const commitRuntimePresentationState = ({
    transitionContract = null,
    activeDataKeys = [],
    renderedKeys = [],
    renderOrigin,
    quality = activeGeneration?.quality ?? 'high',
    playerLogicalX = activeGeneration?.playerX ?? 0,
    playerLogicalZ = activeGeneration?.playerZ ?? 0,
  } = {}) => {
    if (!acceptCommittedRenderOrigin(renderOrigin)) return false;
    const acceptedTransition = validateTransitionCoverage(transitionContract, {
      activeDataKeys,
      renderedKeys,
    });
    if (!acceptRuntimeTransitionContract(acceptedTransition)) return false;
    positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
    applyLocalTerrainOwnerHandoff(
      activeLocalTerrainGeneration,
      activeDataKeys,
      renderedKeys,
    );
    if (!activeGeneration) return true;
    activeGeneration.activeKeys = new Set(activeDataKeys);
    activeGeneration.renderedKeys = new Set(renderedKeys);
    positionGenerationForOrigin(activeGeneration, renderOrigin);
    updateFarRiverVisibility(activeGeneration);
    updateDistantWaterProxyVisibility(activeGeneration);
    updateCanonicalVisibility(activeGeneration, playerLogicalX, playerLogicalZ);
    return true;
  };

  const prepareClipmapBuild = ({
    centerChunkX,
    centerChunkZ,
    activeChunks,
    origin,
    renderDistancePreset,
    surfacePolicy,
    stats,
    target,
    ownedGeometries,
  }) => {
    const topology = clipmapTopologyFor(renderDistancePreset);
    const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const positions = []; const colors = [];
    const sampleVertex = ({ x, z }) => {
      const worldX = centerWorldX + x; const worldZ = centerWorldZ + z;
      const base = baseClipmapSample(worldX, worldZ, surfacePolicy);
      let height = base.height;
      const color = [...base.color];
      const distanceOutside = Math.max(Math.abs(x), Math.abs(z)) - FIVE_BY_FIVE_HALF_EXTENT_METERS;
      if (distanceOutside <= CLIPMAP_BLEND_METERS) {
        const boundaryX = centerWorldX + clamp(x,
          -FIVE_BY_FIVE_HALF_EXTENT_METERS, FIVE_BY_FIVE_HALF_EXTENT_METERS);
        const boundaryZ = centerWorldZ + clamp(z,
          -FIVE_BY_FIVE_HALF_EXTENT_METERS, FIVE_BY_FIVE_HALF_EXTENT_METERS);
        const actual = sampleActiveTerrain(activeChunks, boundaryX, boundaryZ);
        if (actual !== null) {
          const boundaryBase = baseClipmapSample(boundaryX, boundaryZ, surfacePolicy);
          const activeWeight = 1 - smoothstep(distanceOutside / CLIPMAP_BLEND_METERS);
          height += (actual.height - boundaryBase.height) * activeWeight;
          for (let channel = 0; channel < 3; channel += 1) {
            color[channel] += (actual.color[channel] - boundaryBase.color[channel]) * activeWeight;
          }
          if (Math.abs(distanceOutside) < 1e-9) {
            stats.maximumInnerBoundaryErrorMeters = Math.max(
              stats.maximumInnerBoundaryErrorMeters,
              Math.abs(height - actual.height),
            );
            stats.maximumInnerBoundaryColorDifference = Math.max(
              stats.maximumInnerBoundaryColorDifference,
              ...color.map((channel, index) => Math.abs(channel - actual.color[index])),
            );
          }
        }
      }
      positions.push((worldX - originMetersX) * UNITS_PER_METER, height * UNITS_PER_METER,
        (worldZ - originMetersZ) * UNITS_PER_METER);
      colors.push(...color);
    };
    return { topology, positions, colors, sampleVertex, stats, target, ownedGeometries };
  };

  const finishClipmapBuild = ({
    topology, positions, colors, stats, target, ownedGeometries,
  }) => {
    const geometry = makeGeometry(THREE, positions, colors, topology.indices);
    let checksum = 0x811c9dc5;
    for (const value of [...positions, ...colors]) {
      checksum ^= Math.round(value * 1000);
      checksum = Math.imul(checksum, 0x01000193) >>> 0;
    }
    stats.clipmapDeterministicChecksum = checksum;
    ownedGeometries.add(geometry);
    const mesh = new Mesh(geometry, terrainMaterial);
    mesh.name = 'w8-seeded-macro-terrain-clipmap';
    mesh.castShadow = false; mesh.receiveShadow = false;
    target.add(mesh); stats.clipmapMeshCount = 1;
  };

  const createClipmap = input => {
    const build = prepareClipmapBuild(input);
    for (const vertex of build.topology.vertices) build.sampleVertex(vertex);
    finishClipmapBuild(build);
  };

  const createClipmapIncrementally = async (input, assertCurrent, scheduler = null) => {
    const build = prepareClipmapBuild(input);
    const sliceScheduler = scheduler ?? createSliceScheduler({ assertCurrent });
    const verticesPerCheckpoint = 32;
    for (let start = 0; start < build.topology.vertices.length; start += verticesPerCheckpoint) {
      assertCurrent();
      const end = Math.min(build.topology.vertices.length, start + verticesPerCheckpoint);
      for (let index = start; index < end; index += 1) {
        build.sampleVertex(build.topology.vertices[index]);
      }
      const pendingYield = sliceScheduler.checkpoint({ units: end - start });
      if (pendingYield) await pendingYield;
    }
    assertCurrent();
    finishClipmapBuild(build);
    const finishYield = sliceScheduler.checkpoint({ force: true });
    if (finishYield) await finishYield;
    return scheduler ? sliceScheduler.snapshot().maximumSliceMs
      : sliceScheduler.finish().maximumSliceMs;
  };

  const createFarRiverPresentation = async ({
    projections,
    origin: renderOrigin,
    context,
    scheduler,
  }) => {
    const instances = [];
    const originMetersX = renderOrigin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = renderOrigin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    for (const projection of projections) {
      const surface = projection.waterSurface;
      if (!surface) continue;
      for (const line of surface.centerlines ?? []) {
        for (let index = 0; index < line.length - 1; index += 1) {
          const start = line[index];
          const end = line[index + 1];
          const dx = end.x - start.x;
          const dz = end.z - start.z;
          const worldX = (start.x + end.x) / 2;
          const worldZ = (start.z + end.z) / 2;
          const sample = baseClipmapSample(worldX, worldZ, context.surfacePolicy);
          transform.position.set(
            (worldX - originMetersX) * UNITS_PER_METER,
            (sample.riverSurfaceHeight ?? sample.baseHeight) * UNITS_PER_METER + 1.5,
            (worldZ - originMetersZ) * UNITS_PER_METER,
          );
          transform.rotation.set(-Math.PI / 2, 0, Math.atan2(dz, dx));
          transform.scale.set(
            (Math.hypot(dx, dz) + 0.01) * UNITS_PER_METER,
            surface.widthMeters * UNITS_PER_METER,
            1,
          );
          transform.updateMatrix();
          instances.push({
            matrix: transform.matrix.clone?.() ?? structuredClone(transform.matrix),
            stableId: surface.stableId,
            ownerKey: `${surface.owningChunkCoordinate.x},${surface.owningChunkCoordinate.z}`,
            lengthMeters: Math.hypot(dx, dz),
          });
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
    }
    if (!instances.length) return;
    const mesh = new InstancedMesh(
      roadGeometry,
      visualAssets.materials.water,
      instances.length,
    );
    mesh.name = 'w8-far-canonical-river-water';
    mesh.count = instances.length;
    mesh.userData = {
      presentationOnly: true,
      waterType: 'river',
      canonicalStableIds: instances.map(instance => instance.stableId),
      ownerKeys: instances.map(instance => instance.ownerKey),
    };
    for (let index = 0; index < instances.length; index += 1) {
      mesh.setMatrixAt(index, instances[index].matrix);
      const pendingYield = scheduler.checkpoint();
      if (pendingYield) await pendingYield;
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    context.target.add(mesh);
    context.generation.farRiverPresentation = {
      mesh,
      instances,
      activeSignature: null,
    };
    updateFarRiverVisibility(context.generation);
    context.stats.distantProxyInstancedMeshCount += 1;
  };

  function updateFarRiverVisibility(generation) {
    const presentation = generation?.farRiverPresentation;
    if (!presentation?.mesh) return;
    const activeSignature = sortedKeyList(generation.activeKeys ?? []).join('\n');
    if (presentation.activeSignature === activeSignature) return;
    transform.position.set(0, 0, 0);
    transform.rotation.set(0, 0, 0);
    transform.scale.set(0, 0, 0);
    transform.updateMatrix();
    const hidden = transform.matrix.clone?.() ?? structuredClone(transform.matrix);
    let visibleOwnerCount = 0;
    let visibleSegmentCount = 0;
    let visibleLengthMeters = 0;
    const visibleOwners = new Set();
    presentation.instances.forEach((instance, index) => {
      const visible = !generation.activeKeys.has(instance.ownerKey);
      presentation.mesh.setMatrixAt(index, visible ? instance.matrix : hidden);
      if (visible) {
        visibleOwners.add(instance.ownerKey);
        visibleSegmentCount += 1;
        visibleLengthMeters += instance.lengthMeters;
      }
    });
    visibleOwnerCount = visibleOwners.size;
    presentation.mesh.instanceMatrix.needsUpdate = true;
    presentation.activeSignature = activeSignature;
    generation.stats.visibleFarRiverOwnerCount = visibleOwnerCount;
    generation.stats.visibleFarRiverSegmentCount = visibleSegmentCount;
    generation.stats.visibleFarRiverLengthMeters = visibleLengthMeters;
    generation.stats.canonicalRiverRecordCount =
      generation.stats.canonicalActiveRiverRecordCount + visibleOwnerCount;
    generation.stats.canonicalRiverSegmentCount =
      generation.stats.canonicalActiveRiverSegmentCount + visibleSegmentCount;
    generation.stats.canonicalRiverLengthMeters =
      generation.stats.canonicalActiveRiverLengthMeters + visibleLengthMeters;
  }

  function updateDistantWaterProxyVisibility(generation) {
    const presentations = generation?.distantWaterProxyPresentations;
    if (!presentations?.length) return;
    const coverageKeys = new Set([
      ...(generation.activeKeys ?? []),
      ...(generation.renderedKeys ?? []),
    ]);
    const coverageSignature = sortedKeyList(coverageKeys).join('\n');
    const coverageBounds = [...coverageKeys].map(key => {
      const [chunkX, chunkZ] = key.split(',').map(Number);
      return {
        minimumX: chunkX * LOGICAL_CHUNK_SIZE_METERS,
        maximumX: (chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS,
        minimumZ: chunkZ * LOGICAL_CHUNK_SIZE_METERS,
        maximumZ: (chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS,
      };
    });
    transform.position.set(0, 0, 0);
    transform.rotation.set(0, 0, 0);
    transform.scale.set(0, 0, 0);
    transform.updateMatrix();
    const hidden = transform.matrix.clone?.() ?? structuredClone(transform.matrix);
    for (const presentation of presentations) {
      if (presentation.coverageSignature === coverageSignature) continue;
      let visibleCount = 0;
      presentation.instances.forEach((instance, index) => {
        const intersectsCurrentCoverage = coverageBounds.some(bounds => (
          instance.logicalBounds.maximumX >= bounds.minimumX
          && instance.logicalBounds.minimumX <= bounds.maximumX
          && instance.logicalBounds.maximumZ >= bounds.minimumZ
          && instance.logicalBounds.minimumZ <= bounds.maximumZ
        ));
        presentation.mesh.setMatrixAt(index, intersectsCurrentCoverage ? hidden : instance.matrix);
        if (!intersectsCurrentCoverage) visibleCount += 1;
      });
      presentation.mesh.instanceMatrix.needsUpdate = true;
      presentation.coverageSignature = coverageSignature;
      presentation.visibleCount = visibleCount;
    }
  }

  const createDistantWaterProxies = async ({
    centerChunkX,
    centerChunkZ,
    origin,
    terrainRiverExtentMeters,
    context,
    scheduler,
  }) => {
    const seed = textHash(worldSeedHash);
    const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const buckets = new Map();
    const push = (geometry, material, name, instance) => {
      const key = `${geometry}:${material}:${name}`;
      if (!buckets.has(key)) buckets.set(key, { geometry, material, name, instances: [] });
      buckets.get(key).instances.push({
        ...instance,
        matrix: transform.matrix.clone?.() ?? structuredClone(transform.matrix),
      });
    };
    const fadeAt = (worldX, worldZ) => smoothstep((
      Math.max(Math.abs(worldX - centerWorldX), Math.abs(worldZ - centerWorldZ))
      - FIVE_BY_FIVE_HALF_EXTENT_METERS
    ) / CLIPMAP_BLEND_METERS);
    const forAnchoredGrid = async (spacing, operation) => {
      const minimumX = Math.floor((centerWorldX - terrainRiverExtentMeters) / spacing);
      const maximumX = Math.ceil((centerWorldX + terrainRiverExtentMeters) / spacing);
      const minimumZ = Math.floor((centerWorldZ - terrainRiverExtentMeters) / spacing);
      const maximumZ = Math.ceil((centerWorldZ + terrainRiverExtentMeters) / spacing);
      for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ += 1) {
        for (let cellX = minimumX; cellX <= maximumX; cellX += 1) {
          operation(cellX, cellZ);
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
    };

    await forAnchoredGrid(64, (cellX, cellZ) => {
      if (context.stats.distantWaterProxyCount >= DISTANT_WATER_PROXY_LIMIT
        || cellRoll(seed, cellX, cellZ, 21) > 0.2) return;
      const worldX = (cellX + 0.5) * 64; const worldZ = (cellZ + 0.5) * 64;
      const distance = Math.max(Math.abs(worldX - centerWorldX), Math.abs(worldZ - centerWorldZ));
      if (distance <= FIVE_BY_FIVE_HALF_EXTENT_METERS + 12
        || distance >= terrainRiverExtentMeters - 28) return;
      const sample = baseClipmapSample(worldX, worldZ, context.surfacePolicy);
      if (sample.moisture < 0.61) return;
      const size = 18 + cellRoll(seed, cellX, cellZ, 22) * 26;
      const depth = size * 0.58;
      const rotationZ = cellRoll(seed, cellX, cellZ, 23) * Math.PI;
      const cosine = Math.abs(Math.cos(rotationZ));
      const sine = Math.abs(Math.sin(rotationZ));
      const halfExtentX = (cosine * size + sine * depth) / 2;
      const halfExtentZ = (sine * size + cosine * depth) / 2;
      const owner = determineDetailCandidateOwner({ x: worldX, z: worldZ });
      transform.position.set((worldX - originMetersX) * UNITS_PER_METER,
        (sample.height + 0.02) * UNITS_PER_METER,
        (worldZ - originMetersZ) * UNITS_PER_METER);
      transform.rotation.set(-Math.PI / 2, 0, rotationZ);
      transform.scale.set(size * UNITS_PER_METER * fadeAt(worldX, worldZ),
        depth * UNITS_PER_METER * fadeAt(worldX, worldZ), 1);
      transform.updateMatrix();
      push('__road__', 'water', 'water-proxy', {
        stableId: `water-proxy-v1:${worldSeedHash}:${cellX},${cellZ}`,
        ownerKey: `${owner.x},${owner.z}`,
        logicalBounds: Object.freeze({
          minimumX: worldX - halfExtentX,
          maximumX: worldX + halfExtentX,
          minimumZ: worldZ - halfExtentZ,
          maximumZ: worldZ + halfExtentZ,
        }),
      });
      context.stats.distantWaterProxyCount += 1;
    });

    for (const bucket of buckets.values()) {
      const geometry = bucket.geometry === '__road__'
        ? roadGeometry : visualAssets.geometries[bucket.geometry];
      const material = visualAssets.materials[bucket.material];
      const mesh = new InstancedMesh(geometry, material, Math.max(1, bucket.instances.length));
      mesh.name = `w8-distant-${bucket.name}-${bucket.geometry}-${bucket.material}`;
      mesh.count = bucket.instances.length;
      for (let index = 0; index < bucket.instances.length; index += 1) {
        mesh.setMatrixAt(index, bucket.instances[index].matrix);
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.userData = {
        presentationOnly: true,
        waterType: 'proxy',
        canonicalStableIds: bucket.instances.map(instance => instance.stableId),
        ownerKeys: bucket.instances.map(instance => instance.ownerKey),
        logicalBounds: bucket.instances.map(instance => instance.logicalBounds),
      };
      context.target.add(mesh); context.stats.distantProxyInstancedMeshCount += 1;
      context.generation.distantWaterProxyPresentations ??= [];
      context.generation.distantWaterProxyPresentations.push({
        mesh,
        instances: bucket.instances,
        coverageSignature: null,
        visibleCount: bucket.instances.length,
      });
    }
    updateDistantWaterProxyVisibility(context.generation);
  };

  const mapWithQueryConcurrency = async (values, operation, assertCurrent = null) => {
    const results = new Array(values.length);
    let cursor = 0;
    const acquireQuerySlot = () => {
      if (activeQueryCount < CANONICAL_QUERY_CONCURRENCY) {
        activeQueryCount += 1;
        maximumObservedQueryConcurrency = Math.max(
          maximumObservedQueryConcurrency,
          activeQueryCount,
        );
        return Promise.resolve();
      }
      return new Promise(resolve => queryWaiters.push(resolve));
    };
    const releaseQuerySlot = () => {
      activeQueryCount -= 1;
      const next = queryWaiters.shift();
      if (next) {
        activeQueryCount += 1;
        maximumObservedQueryConcurrency = Math.max(
          maximumObservedQueryConcurrency,
          activeQueryCount,
        );
        next();
      }
    };
    const worker = async () => {
      while (cursor < values.length) {
        assertCurrent?.();
        const index = cursor;
        cursor += 1;
        await acquireQuerySlot();
        try {
          results[index] = await operation(values[index], index);
          assertCurrent?.();
        } finally {
          releaseQuerySlot();
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(CANONICAL_QUERY_CONCURRENCY, values.length) },
      () => worker(),
    ));
    return results;
  };

  const prepareCanonicalFarChunks = async ({
    centerWorldX,
    centerWorldZ,
    naturalCenterWorldX,
    naturalCenterWorldZ,
    quality,
    renderDistancePreset,
    activeKeys,
    includeFarNatural,
    includeUltraNatural = true,
    consumerEpoch,
    assertCurrent = null,
  }) => {
    assertCurrent?.();
    const queryStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const renderDistancePolicy = resolveW8RenderDistancePolicy(renderDistancePreset);
    const visibilityMeters = renderDistancePolicy.generalObjectVisibilityMeters;
    const naturalVisibilityMeters = renderDistancePolicy.naturalVisibilityMeters;
    // Chunk AABB coverage is conservative at the circle boundary; no owner-range
    // expansion is needed beyond the selected preset.
    const naturalQueryRadius = includeUltraNatural
      ? naturalVisibilityMeters
      : renderDistancePolicy.naturalInnerWarmMeters;
    const settlementPolicy = resolveW8SettlementPresentationPolicy(
      quality,
      renderDistancePolicy.id,
    );
    const localQueryRadius = visibilityMeters + CANONICAL_QUERY_MARGIN_METERS;
    const queryRadius = Math.max(localQueryRadius, settlementPolicy.remote.hiddenDistanceMeters);
    const [candidateResult] = await mapWithQueryConcurrency(
      [{ centerWorldX, centerWorldZ, queryRadius }],
      query => findSettlementsNear(
        query.centerWorldX,
        query.centerWorldZ,
        query.queryRadius,
      ),
      assertCurrent,
    );
    assertCurrent?.();
    const candidates = [...candidateResult].filter(candidate => (
      settlementCandidateDistance(candidate, centerWorldX, centerWorldZ).boundaryDistanceMeters
        <= queryRadius
    )).sort((left, right) => left.settlementId.localeCompare(right.settlementId));
    const selection = selectW8SettlementPresentationCandidates({
      candidates,
      playerX: centerWorldX,
      playerZ: centerWorldZ,
      quality,
      renderDistancePreset: renderDistancePolicy.id,
    });
    const selectedEntries = [selection.current, ...selection.remote].filter(Boolean);
    const templateResolutionStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const resolvedTemplates = await mapWithQueryConcurrency(selectedEntries, entry => readThroughLru(
      templateCache,
      entry.candidate.settlementId,
      TEMPLATE_CACHE_CAPACITY,
      () => resolveTemplate({ candidate: entry.candidate }),
    ), assertCurrent);
    const templateResolutionDurationMs = (globalThis.performance?.now?.() ?? Date.now())
      - templateResolutionStartedAt;
    assertCurrent?.();
    const selected = selectedEntries.map((entry, index) => ({
      ...entry,
      template: resolvedTemplates[index],
    })).filter(value => value.template);
    const currentSelection = selected.find(value => (
      value.candidate.settlementId === selection.current?.candidate.settlementId
    )) ?? null;
    const remoteSelections = selected.filter(value => (
      value.candidate.settlementId !== currentSelection?.candidate.settlementId
    ));
    const horizonSelections = [
      ...(currentSelection ? [{ ...currentSelection, standby: true }] : []),
      ...remoteSelections.map(value => ({ ...value, standby: false })),
    ];
    const ownerQueries = new Map();
    const addOwnerCoordinate = (chunkX, chunkZ) => {
      const key = `${chunkX},${chunkZ}`;
      if (!ownerQueries.has(key)) {
        ownerQueries.set(key, {
          key,
          chunkX,
          chunkZ,
          settlementIds: new Set(),
          remoteHorizonSettlementIds: new Set(),
          includeNaturalInner: false,
          includeNaturalUltra: false,
        });
      }
      return ownerQueries.get(key);
    };
    const addSettlementOwner = (point, settlementId) => {
      const owner = determineDetailCandidateOwner(point);
      addOwnerCoordinate(owner.x, owner.z).settlementIds.add(settlementId);
    };
    for (const template of currentSelection ? [currentSelection.template] : []) {
      assertCurrent?.();
      for (const building of template.buildings) {
        if (Math.hypot(
          building.x - centerWorldX,
          building.z - centerWorldZ,
        ) <= localQueryRadius) addSettlementOwner(building, template.settlementId);
      }
      for (const road of template.roads) {
        const dx = road.end.x - road.start.x;
        const dz = road.end.z - road.start.z;
        const sampleCount = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 8));
        for (let sample = 0; sample <= sampleCount; sample += 1) {
          const t = sample / sampleCount;
          const point = {
            x: road.start.x + dx * t,
            z: road.start.z + dz * t,
          };
          if (Math.hypot(
            point.x - centerWorldX,
            point.z - centerWorldZ,
          ) <= localQueryRadius) addSettlementOwner(point, template.settlementId);
        }
      }
      if (Math.hypot(
        template.center.x - centerWorldX,
        template.center.z - centerWorldZ,
      ) <= localQueryRadius + 32) addSettlementOwner(template.center, template.settlementId);
    }
    for (const remote of horizonSelections) {
      const center = remote.candidate.center ?? remote.candidate.worldPosition;
      const owner = determineDetailCandidateOwner(center);
      addOwnerCoordinate(owner.x, owner.z)
        .remoteHorizonSettlementIds.add(remote.candidate.settlementId);
    }
    let excludedActiveNaturalOwnerCount = 0;
    if (includeFarNatural) {
      const minimumNaturalChunkX = Math.floor(
        (naturalCenterWorldX - naturalQueryRadius) / LOGICAL_CHUNK_SIZE_METERS,
      );
      const maximumNaturalChunkX = Math.floor(
        (naturalCenterWorldX + naturalQueryRadius) / LOGICAL_CHUNK_SIZE_METERS,
      );
      const minimumNaturalChunkZ = Math.floor(
        (naturalCenterWorldZ - naturalQueryRadius) / LOGICAL_CHUNK_SIZE_METERS,
      );
      const maximumNaturalChunkZ = Math.floor(
        (naturalCenterWorldZ + naturalQueryRadius) / LOGICAL_CHUNK_SIZE_METERS,
      );
      for (let chunkZ = minimumNaturalChunkZ; chunkZ <= maximumNaturalChunkZ; chunkZ += 1) {
        for (let chunkX = minimumNaturalChunkX; chunkX <= maximumNaturalChunkX; chunkX += 1) {
          if (!chunkAabbIntersectsCircle(
            chunkX,
            chunkZ,
            naturalCenterWorldX,
            naturalCenterWorldZ,
            naturalQueryRadius,
          )) continue;
          const key = `${chunkX},${chunkZ}`;
          if (activeKeys.has(key)) {
            excludedActiveNaturalOwnerCount += 1;
            continue;
          }
          const owner = addOwnerCoordinate(chunkX, chunkZ);
          if (chunkAabbIntersectsCircle(
            chunkX,
            chunkZ,
            naturalCenterWorldX,
            naturalCenterWorldZ,
            renderDistancePolicy.naturalInnerWarmMeters,
          )) owner.includeNaturalInner = true;
          else owner.includeNaturalUltra = true;
        }
      }
    }
    const owners = [...ownerQueries.values()]
      .filter(owner => !activeKeys.has(owner.key))
      .sort((left, right) => (
      Number(left.includeNaturalUltra && !left.includeNaturalInner
        && !left.settlementIds.size && !left.remoteHorizonSettlementIds.size)
        - Number(right.includeNaturalUltra && !right.includeNaturalInner
          && !right.settlementIds.size && !right.remoteHorizonSettlementIds.size)
        || left.chunkZ - right.chunkZ || left.chunkX - right.chunkX
      ));
    const cacheBefore = {
      hits: farOwnerChunkCacheHits,
      misses: farOwnerChunkCacheMisses,
      evictions: farOwnerChunkCacheEvictions,
      ultraHits: ultraOwnerChunkCacheHits,
      ultraMisses: ultraOwnerChunkCacheMisses,
      ultraEvictions: ultraOwnerChunkCacheEvictions,
    };
    const ultraOnlyOwner = owner => owner.includeNaturalUltra
      && !owner.includeNaturalInner
      && owner.settlementIds.size === 0
      && owner.remoteHorizonSettlementIds.size === 0;
    const loadOwners = async ownerList => mapWithQueryConcurrency(ownerList, async owner => {
      const ultraOnly = ultraOnlyOwner(owner);
      const cache = ultraOnly ? ultraOwnerChunkCache : farOwnerChunkCache;
      const capacity = ultraOnly ? ULTRA_OWNER_CHUNK_CACHE_CAPACITY : FAR_OWNER_CHUNK_CACHE_CAPACITY;
      return {
        ...owner,
        chunk: await readThroughLru(
          cache,
          owner.key,
          capacity,
          () => getCanonicalChunkData(owner.chunkX, owner.chunkZ, {
            priority: ultraOnly ? 5 : 4,
            consumerId: 'distant-owner-query',
            epoch: consumerEpoch,
          }),
          event => {
            if (ultraOnly) {
              if (event === 'hit') ultraOwnerChunkCacheHits += 1;
              else if (event === 'miss') ultraOwnerChunkCacheMisses += 1;
              else if (event === 'eviction') ultraOwnerChunkCacheEvictions += 1;
            } else if (event === 'hit') farOwnerChunkCacheHits += 1;
            else if (event === 'miss') farOwnerChunkCacheMisses += 1;
            else if (event === 'eviction') farOwnerChunkCacheEvictions += 1;
          },
        ),
      };
    }, assertCurrent);
    const innerOwners = owners.filter(owner => !ultraOnlyOwner(owner));
    const ultraOwners = owners.filter(ultraOnlyOwner);
    const innerWarmStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const innerChunks = await loadOwners(innerOwners);
    assertCurrent?.();
    const innerWarmDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - innerWarmStartedAt;
    const ultraWarmStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const ultraChunks = await loadOwners(ultraOwners);
    assertCurrent?.();
    const ultraWarmDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - ultraWarmStartedAt;
    const chunks = [...innerChunks, ...ultraChunks].sort((left, right) => (
      left.chunkZ - right.chunkZ || left.chunkX - right.chunkX
    ));
    const remoteHorizons = horizonSelections.map(remote => {
      const ownerChunk = chunks.find(value => (
        value.remoteHorizonSettlementIds.has(remote.candidate.settlementId)
      ))?.chunk;
      const landmarks = [
        ...(ownerChunk?.presentationLayers?.landmarks ?? ownerChunk?.settlementLandmarks ?? []),
      ].filter(record => (
        (record.parentSettlementId ?? record.settlementId) === remote.candidate.settlementId
          && W8_SETTLEMENT_ROLE_LANDMARKS[remote.candidate.townType]?.landmarkType
            === record.landmarkType
      )).slice(0, 1);
      return Object.freeze({
        ...remote,
        landmarks: Object.freeze(landmarks),
      });
    });
    const minimumRiverChunkX = Math.floor(
      (naturalCenterWorldX - renderDistancePolicy.terrainRiverExtentMeters)
        / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumRiverChunkX = Math.floor(
      (naturalCenterWorldX + renderDistancePolicy.terrainRiverExtentMeters)
        / LOGICAL_CHUNK_SIZE_METERS,
    );
    const minimumRiverChunkZ = Math.floor(
      (naturalCenterWorldZ - renderDistancePolicy.terrainRiverExtentMeters)
        / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumRiverChunkZ = Math.floor(
      (naturalCenterWorldZ + renderDistancePolicy.terrainRiverExtentMeters)
        / LOGICAL_CHUNK_SIZE_METERS,
    );
    const riverOwnerCoordinates = [];
    for (let chunkZ = minimumRiverChunkZ; chunkZ <= maximumRiverChunkZ; chunkZ += 1) {
      for (let chunkX = minimumRiverChunkX; chunkX <= maximumRiverChunkX; chunkX += 1) {
        const key = `${chunkX},${chunkZ}`;
        if (!canonicalRiverMayAffectChunk({
          chunkX,
          chunkZ,
          settlementReferences: candidates,
        })) continue;
        riverOwnerCoordinates.push({ chunkX, chunkZ });
      }
    }
    const riverProjections = (await mapWithQueryConcurrency(
      riverOwnerCoordinates,
      coordinate => createCanonicalRiverProjection({
        worldSeedHash,
        chunkX: coordinate.chunkX,
        chunkZ: coordinate.chunkZ,
        settlementReferences: candidates,
      }),
      assertCurrent,
    )).filter(projection => projection.surfaceCorridor || projection.waterSurface);
    assertCurrent?.();
    return {
      queryCenter: { x: centerWorldX, z: centerWorldZ },
      naturalQueryCenter: { x: naturalCenterWorldX, z: naturalCenterWorldZ },
      queryRadius,
      visibilityMeters,
      naturalVisibilityMeters,
      naturalQueryRadius,
      candidateCount: candidates.length,
      currentSettlementId: currentSelection?.candidate.settlementId ?? null,
      templateSuccessCount: selected.length,
      remoteCandidateCount: selection.remote.length,
      remoteSelectedCount: remoteSelections.length,
      remoteHorizonMaterializedCount: remoteHorizons.length,
      remoteSettlementLimit: settlementPolicy.remote.settlementLimit,
      remoteBuildingLimitPerSettlement: settlementPolicy.remote.buildingLimitPerSettlement,
      remotePartLimit: settlementPolicy.remote.partLimit,
      remoteHorizonStartMeters: settlementPolicy.remote.horizonStartMeters,
      remoteFadeStartMeters: settlementPolicy.remote.fadeStartMeters,
      remoteHiddenDistanceMeters: settlementPolicy.remote.hiddenDistanceMeters,
      remoteFogEnabled: settlementPolicy.remote.fog,
      ownerChunkCount: owners.length,
      ownerChunkKeys: owners.map(owner => owner.key),
      naturalOwnerChunkCount: owners.filter(owner => (
        owner.includeNaturalInner || owner.includeNaturalUltra
      )).length,
      naturalOwnerChunkKeys: owners.filter(owner => (
        owner.includeNaturalInner || owner.includeNaturalUltra
      )).map(owner => owner.key),
      innerNaturalOwnerChunkCount: owners.filter(owner => owner.includeNaturalInner).length,
      ultraOwnerChunkCount: owners.filter(owner => owner.includeNaturalUltra).length,
      ultraOwnerChunkKeys: owners.filter(owner => owner.includeNaturalUltra).map(owner => owner.key),
      buildingOwnerChunkCount: owners.filter(owner => owner.settlementIds.size > 0).length,
      buildingOwnerChunkKeys: owners.filter(owner => owner.settlementIds.size > 0).map(owner => owner.key),
      remoteHorizonOwnerChunkCount: owners.filter(owner => (
        owner.remoteHorizonSettlementIds.size > 0
      )).length,
      excludedActiveNaturalOwnerCount,
      farOwnerChunkCacheHits: farOwnerChunkCacheHits - cacheBefore.hits,
      farOwnerChunkCacheMisses: farOwnerChunkCacheMisses - cacheBefore.misses,
      farOwnerChunkCacheEvictions: farOwnerChunkCacheEvictions - cacheBefore.evictions,
      ultraOwnerChunkCacheHits: ultraOwnerChunkCacheHits - cacheBefore.ultraHits,
      ultraOwnerChunkCacheMisses: ultraOwnerChunkCacheMisses - cacheBefore.ultraMisses,
      ultraOwnerChunkCacheEvictions: ultraOwnerChunkCacheEvictions - cacheBefore.ultraEvictions,
      innerWarmDurationMs,
      ultraWarmDurationMs,
      queryPreparationDurationMs: (globalThis.performance?.now?.() ?? Date.now()) - queryStartedAt,
      templateResolutionDurationMs,
      canonicalChunkSuccessCount: chunks.filter(value => value.chunk).length,
      naturalCandidateCount: chunks.reduce((sum, value) => {
        if ((!value.includeNaturalInner && !value.includeNaturalUltra) || !value.chunk) return sum;
        const vegetation = value.chunk.presentationLayers?.natural?.vegetation
          ?? value.chunk.vegetationCandidates ?? [];
        return sum + vegetation.filter(candidate => isW8NaturalCandidateVisible(candidate)
          && Math.hypot(
            candidate.worldPosition.x - naturalCenterWorldX,
            candidate.worldPosition.z - naturalCenterWorldZ,
          ) <= naturalQueryRadius).length;
      }, 0),
      settlementFeatureCount: chunks.reduce(
        (sum, value) => sum + (value.chunk?.settlementFeatures?.length ?? 0),
        0,
      ),
      majorRoadFeatureCount: chunks.reduce(
        (sum, value) => sum + (value.chunk?.settlementFeatures ?? [])
          .filter(feature => feature.canonicalMajorRoad === true).length,
        0,
      ),
      landmarkCount: chunks.reduce(
        (sum, value) => sum + (value.chunk?.settlementLandmarks?.length ?? 0),
        0,
      ),
      settlementIds: new Set(currentSelection ? [currentSelection.candidate.settlementId] : []),
      remoteHorizons: Object.freeze(remoteHorizons),
      riverProjections: Object.freeze(riverProjections),
      chunks: chunks.filter(value => value.chunk),
    };
  };

  const syncLocalTerrainIncrementally = async ({
    coverageEpoch,
    transitionContract = null,
    activeDataKeys,
    renderedKeys,
    getChunkData,
    renderOrigin,
    centerChunkX,
    centerChunkZ,
    renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
  } = {}) => {
    const startedAt = monotonicNow();
    localTerrainLastRootSwapDurationMs = 0;
    localTerrainLastMaximumSliceMs = 0;
    localTerrainLastSliceCount = 0;
    const requestedEpoch = Number(coverageEpoch);
    if (!Number.isSafeInteger(requestedEpoch) || requestedEpoch < 1) {
      throw new TypeError('coverageEpoch must be a positive safe integer');
    }
    if (!Array.isArray(activeDataKeys) || !Array.isArray(renderedKeys)
      || typeof getChunkData !== 'function') {
      throw new TypeError('Incremental Local terrain sync requires active/rendered keys and ChunkData');
    }
    const acceptedTransition = validateTransitionCoverage(transitionContract, {
      activeDataKeys,
      renderedKeys,
      centerChunkX,
      centerChunkZ,
    });
    localTerrainLastRequestedEpoch = requestedEpoch;
    localTerrainLastActiveKeyCount = activeDataKeys.length;
    localTerrainLastRenderedKeyCount = renderedKeys.length;
    localTerrainLastResolvedChunkCount = 0;
    localTerrainLastMidgroundOwnerCount = 0;
    localTerrainLastMissingOwnerKeys = Object.freeze([]);
    localTerrainLastRejectionReason = null;
    const reject = (reason, missingOwnerKeys = []) => {
      localTerrainRejectionCount += 1;
      localTerrainLastRejectionReason = reason;
      localTerrainLastMissingOwnerKeys = Object.freeze(sortedKeyList(missingOwnerKeys));
      localTerrainLastSyncDurationMs = monotonicNow() - startedAt;
      return Object.freeze({
        committed: false,
        reused: false,
        coverageEpoch: requestedEpoch,
        reason,
        missingOwnerKeys: localTerrainLastMissingOwnerKeys,
        activeRootId: activeLocalTerrainGeneration?.root?.name ?? null,
      });
    };
    if (disposed) return reject('disposed');
    if (!acceptCommittedRenderOrigin(renderOrigin)) {
      localTerrainStaleDiscardCount += 1;
      return reject('stale-render-origin');
    }
    if (requestedEpoch < localTerrainSyncEpoch) {
      localTerrainStaleDiscardCount += 1;
      return reject('stale-epoch');
    }
    const assertCurrent = () => {
      if (disposed || requestedEpoch !== localTerrainSyncEpoch
        || !transitionIsCurrent(acceptedTransition)) throw LOCAL_SYNC_CANCELLED;
    };
    const scheduler = createSliceScheduler({ assertCurrent });
    const renderDistancePolicy = resolveW8RenderDistancePolicy(renderDistancePreset);
    const activeKeys = new Set(activeDataKeys);
    const rendered = new Set(renderedKeys);
    if (activeDataKeys.length !== 25 || activeKeys.size !== 25) {
      return reject('active-key-count');
    }
    if (renderedKeys.length !== 9 || rendered.size !== 9) {
      return reject('rendered-key-count');
    }
    const renderedOutsideActive = [...rendered].filter(key => !activeKeys.has(key));
    if (renderedOutsideActive.length) {
      return reject('rendered-owner-outside-active', renderedOutsideActive);
    }
    if (!acceptRuntimeTransitionContract(acceptedTransition)) {
      localTerrainStaleDiscardCount += 1;
      return reject('stale-transition');
    }
    localTerrainSyncEpoch = requestedEpoch;
    const activeChunks = new Map();
    const missingOwnerKeys = [];
    for (const key of activeDataKeys) {
      const [chunkX, chunkZ] = key.split(',').map(Number);
      const chunk = getChunkData(chunkX, chunkZ);
      if (!chunk || chunk.chunkX !== chunkX || chunk.chunkZ !== chunkZ) {
        missingOwnerKeys.push(key);
      } else {
        activeChunks.set(key, chunk);
      }
    }
    localTerrainLastResolvedChunkCount = activeChunks.size;
    if (missingOwnerKeys.length) return reject('missing-chunk-data', missingOwnerKeys);
    const midgroundOwnerKeys = new Set([...activeKeys].filter(key => !rendered.has(key)));
    localTerrainLastMidgroundOwnerCount = midgroundOwnerKeys.size;
    if (midgroundOwnerKeys.size !== 16) return reject('midground-owner-count');

    let surfacePolicy = surfacePolicyForChunks(activeChunks.values());
    try {
      const corridors = await riverSurfaceCorridorsForClipmapIncrementally(
        centerChunkX,
        centerChunkZ,
        surfacePolicy,
        renderDistancePolicy.terrainRiverExtentMeters,
        scheduler,
      );
      assertCurrent();
      surfacePolicy = Object.freeze({
        ...surfacePolicy,
        riverCorridors: Object.freeze(corridors),
      });
    } catch (error) {
      const sliceSnapshot = scheduler.snapshot();
      localTerrainLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
      localTerrainLastSliceCount = sliceSnapshot.sliceCount;
      if (error === LOCAL_SYNC_CANCELLED) {
        localTerrainStaleDiscardCount += 1;
        return reject(disposed ? 'disposed-during-build' : 'stale-after-build');
      }
      throw error;
    }

    const reusableMidgroundMesh = activeLocalTerrainGeneration
      && activeLocalTerrainGeneration.centerChunkX === centerChunkX
      && activeLocalTerrainGeneration.centerChunkZ === centerChunkZ
      && equalKeySets(activeLocalTerrainGeneration.activeKeys, activeKeys)
      && equalKeySets(activeLocalTerrainGeneration.renderedKeys, rendered)
      ? activeLocalTerrainGeneration.root.children?.find(child => (
        child.name === 'w8-midground-outer-sixteen-terrain'
      )) ?? null
      : null;
    if (activeLocalTerrainGeneration
      && activeLocalTerrainGeneration.centerChunkX === centerChunkX
      && activeLocalTerrainGeneration.centerChunkZ === centerChunkZ
      && activeLocalTerrainGeneration.renderDistancePreset === renderDistancePolicy.id
      && equalKeySets(activeLocalTerrainGeneration.activeKeys, activeKeys)
      && equalKeySets(activeLocalTerrainGeneration.renderedKeys, rendered)) {
      positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
      applyLocalTerrainOwnerHandoff(
        activeLocalTerrainGeneration,
        activeDataKeys,
        renderedKeys,
      );
      assignTransitionContract(activeLocalTerrainGeneration, acceptedTransition);
      committedLocalTerrainEpoch = requestedEpoch;
      currentCanonicalSurfacePolicy = surfacePolicy;
      const sliceSnapshot = scheduler.finish();
      localTerrainLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
      localTerrainLastSliceCount = sliceSnapshot.sliceCount;
      localTerrainLastSyncDurationMs = monotonicNow() - startedAt;
      return Object.freeze({
        committed: true,
        reused: true,
        coverageEpoch: requestedEpoch,
        reason: null,
        missingOwnerKeys: Object.freeze([]),
        activeRootId: activeLocalTerrainGeneration.root.name,
      });
    }

    const localRoot = new Group();
    localRoot.name = `w8-local-terrain-coverage-epoch-${requestedEpoch}`;
    localRoot.userData = {
      presentationOnly: true,
      localTerrainCoverage: true,
      coverageEpoch: requestedEpoch,
      renderDistancePreset: renderDistancePolicy.id,
    };
    stagingLocalTerrainRootId = localRoot.name;
    const generation = {
      epoch: requestedEpoch,
      root: localRoot,
      ownedGeometries: new Set(),
      ownedMaterials: new Set(),
      stats: createStats(),
      activeKeys,
      renderedKeys: rendered,
      midgroundOwnerKeys,
      centerChunkX,
      centerChunkZ,
      renderDistancePreset: renderDistancePolicy.id,
      renderDistancePolicy,
      buildOriginChunkX: renderOrigin.renderOriginChunkX,
      buildOriginChunkZ: renderOrigin.renderOriginChunkZ,
      currentOriginChunkX: renderOrigin.renderOriginChunkX,
      currentOriginChunkZ: renderOrigin.renderOriginChunkZ,
      surfacePolicy,
    };
    assignTransitionContract(generation, acceptedTransition);
    const context = {
      target: localRoot,
      ownedGeometries: generation.ownedGeometries,
      stats: generation.stats,
      generation,
      surfacePolicy,
    };
    const midground = [...midgroundOwnerKeys]
      .map(key => activeChunks.get(key))
      .sort((left, right) => left.chunkZ - right.chunkZ || left.chunkX - right.chunkX);
    const terrainOwners = [...activeKeys]
      .map(key => activeChunks.get(key))
      .sort((left, right) => left.chunkZ - right.chunkZ || left.chunkX - right.chunkX);
    try {
      generation.stats.midgroundChunkCount = midground.length;
      if (reusableMidgroundMesh) {
        const midgroundMesh = new Mesh(
          reusableMidgroundMesh.geometry,
          reusableMidgroundMesh.material,
        );
        midgroundMesh.name = reusableMidgroundMesh.name;
        midgroundMesh.castShadow = reusableMidgroundMesh.castShadow;
        midgroundMesh.receiveShadow = reusableMidgroundMesh.receiveShadow;
        midgroundMesh.userData = { ...(reusableMidgroundMesh.userData ?? {}) };
        localRoot.add(midgroundMesh);
        generation.localTerrainMesh = midgroundMesh;
        generation.currentVisibleMidgroundOwnerKeys = new Set(
          midgroundMesh.userData.visibleOwnerKeys ?? [],
        );
        generation.reusedMidgroundGeometry = reusableMidgroundMesh.geometry;
        const pendingYield = scheduler.checkpoint({ force: true });
        if (pendingYield) await pendingYield;
      } else {
        await createMidgroundTerrainIncrementally(
          terrainOwners,
          renderOrigin,
          context,
          scheduler,
        );
      }
      await createClipmapIncrementally({
        centerChunkX,
        centerChunkZ,
        activeChunks,
        origin: renderOrigin,
        renderDistancePreset: renderDistancePolicy.id,
        surfacePolicy,
        stats: generation.stats,
        target: localRoot,
        ownedGeometries: generation.ownedGeometries,
      }, assertCurrent, scheduler);
      assertCurrent();
      applyLocalTerrainOwnerHandoff(generation, activeDataKeys, renderedKeys);
      positionGenerationForOrigin(generation, renderOrigin);
      const sliceSnapshot = scheduler.finish();
      localTerrainLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
      localTerrainLastSliceCount = sliceSnapshot.sliceCount;
    } catch (error) {
      disposeGeneration(generation);
      if (stagingLocalTerrainRootId === localRoot.name) stagingLocalTerrainRootId = null;
      const sliceSnapshot = scheduler.snapshot();
      localTerrainLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
      localTerrainLastSliceCount = sliceSnapshot.sliceCount;
      if (error === LOCAL_SYNC_CANCELLED) {
        localTerrainStaleDiscardCount += 1;
        return reject(disposed ? 'disposed-during-build' : 'stale-after-build');
      }
      localTerrainLastRejectionReason = 'build-error';
      localTerrainLastSyncDurationMs = monotonicNow() - startedAt;
      throw error;
    }
    if (stagingLocalTerrainRootId === localRoot.name) stagingLocalTerrainRootId = null;
    assertCurrent();
    const previous = activeLocalTerrainGeneration;
    if (generation.reusedMidgroundGeometry) {
      previous?.ownedGeometries.delete(generation.reusedMidgroundGeometry);
      generation.ownedGeometries.add(generation.reusedMidgroundGeometry);
    }
    const swapStartedAt = monotonicNow();
    root.add(generation.root);
    activeLocalTerrainGeneration = generation;
    committedLocalTerrainEpoch = requestedEpoch;
    localTerrainCommitCount += 1;
    currentCanonicalSurfacePolicy = surfacePolicy;
    disposeGeneration(previous);
    localTerrainLastRootSwapDurationMs = monotonicNow() - swapStartedAt;
    localTerrainLastSyncDurationMs = monotonicNow() - startedAt;
    return Object.freeze({
      committed: true,
      reused: false,
      coverageEpoch: requestedEpoch,
      reason: null,
      missingOwnerKeys: Object.freeze([]),
      activeRootId: generation.root.name,
    });
  };

  return Object.freeze({
    syncLocalTerrainIncrementally,
    syncLocalTerrain({
      coverageEpoch,
      transitionContract = null,
      activeDataKeys,
      renderedKeys,
      getChunkData,
      renderOrigin,
      centerChunkX,
      centerChunkZ,
      renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
    } = {}) {
      const localSyncStartedAt = globalThis.performance?.now?.() ?? Date.now();
      localTerrainLastRootSwapDurationMs = 0;
      localTerrainLastMaximumSliceMs = 0;
      localTerrainLastSliceCount = 0;
      const requestedEpoch = Number(coverageEpoch);
      if (!Number.isSafeInteger(requestedEpoch) || requestedEpoch < 1) {
        throw new TypeError('coverageEpoch must be a positive safe integer');
      }
      if (!Array.isArray(activeDataKeys) || !Array.isArray(renderedKeys)
        || typeof getChunkData !== 'function') {
        throw new TypeError('Local terrain sync requires active/rendered keys and a ChunkData provider');
      }
      const acceptedTransition = validateTransitionCoverage(transitionContract, {
        activeDataKeys,
        renderedKeys,
        centerChunkX,
        centerChunkZ,
      });
      localTerrainLastRequestedEpoch = requestedEpoch;
      localTerrainLastActiveKeyCount = activeDataKeys.length;
      localTerrainLastRenderedKeyCount = renderedKeys.length;
      localTerrainLastResolvedChunkCount = 0;
      localTerrainLastMidgroundOwnerCount = 0;
      localTerrainLastMissingOwnerKeys = Object.freeze([]);
      localTerrainLastRejectionReason = null;

      const reject = (reason, missingOwnerKeys = []) => {
        localTerrainRejectionCount += 1;
        localTerrainLastRejectionReason = reason;
        localTerrainLastMissingOwnerKeys = Object.freeze(sortedKeyList(missingOwnerKeys));
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now())
          - localSyncStartedAt;
        return Object.freeze({
          committed: false,
          reused: false,
          coverageEpoch: requestedEpoch,
          reason,
          missingOwnerKeys: localTerrainLastMissingOwnerKeys,
          activeRootId: activeLocalTerrainGeneration?.root?.name ?? null,
        });
      };

      if (disposed) return reject('disposed');
      if (!acceptCommittedRenderOrigin(renderOrigin)) {
        localTerrainStaleDiscardCount += 1;
        return reject('stale-render-origin');
      }
      if (requestedEpoch < localTerrainSyncEpoch) {
        localTerrainStaleDiscardCount += 1;
        return reject('stale-epoch');
      }
      const renderDistancePolicy = resolveW8RenderDistancePolicy(renderDistancePreset);

      const activeKeys = new Set(activeDataKeys);
      const rendered = new Set(renderedKeys);
      if (activeDataKeys.length !== 25 || activeKeys.size !== 25) {
        return reject('active-key-count');
      }
      if (renderedKeys.length !== 9 || rendered.size !== 9) {
        return reject('rendered-key-count');
      }
      const renderedOutsideActive = [...rendered].filter(key => !activeKeys.has(key));
      if (renderedOutsideActive.length) return reject('rendered-owner-outside-active', renderedOutsideActive);
      if (!acceptRuntimeTransitionContract(acceptedTransition)) {
        localTerrainStaleDiscardCount += 1;
        return reject('stale-transition');
      }
      localTerrainSyncEpoch = requestedEpoch;

      const activeChunks = new Map();
      const missingOwnerKeys = [];
      for (const key of activeDataKeys) {
        const [chunkX, chunkZ] = key.split(',').map(Number);
        const chunk = getChunkData(chunkX, chunkZ);
        if (!chunk || chunk.chunkX !== chunkX || chunk.chunkZ !== chunkZ) {
          missingOwnerKeys.push(key);
          continue;
        }
        activeChunks.set(key, chunk);
      }
      currentCanonicalSurfacePolicy = surfacePolicyForChunks(activeChunks.values());
      currentCanonicalSurfacePolicy = Object.freeze({
        ...currentCanonicalSurfacePolicy,
        riverCorridors: Object.freeze(riverSurfaceCorridorsForClipmap(
          centerChunkX,
          centerChunkZ,
          currentCanonicalSurfacePolicy,
          renderDistancePolicy.terrainRiverExtentMeters,
        )),
      });
      clipmapSampleCache.clear();
      localTerrainLastResolvedChunkCount = activeChunks.size;
      if (missingOwnerKeys.length) return reject('missing-chunk-data', missingOwnerKeys);

      const midgroundOwnerKeys = new Set([...activeKeys].filter(key => !rendered.has(key)));
      localTerrainLastMidgroundOwnerCount = midgroundOwnerKeys.size;
      if (midgroundOwnerKeys.size !== 16) return reject('midground-owner-count');

      const reusableMidgroundMesh = activeLocalTerrainGeneration
        && activeLocalTerrainGeneration.centerChunkX === centerChunkX
        && activeLocalTerrainGeneration.centerChunkZ === centerChunkZ
        && equalKeySets(activeLocalTerrainGeneration.activeKeys, activeKeys)
        && equalKeySets(activeLocalTerrainGeneration.renderedKeys, rendered)
        ? activeLocalTerrainGeneration.root.children?.find(child => (
          child.name === 'w8-midground-outer-sixteen-terrain'
        )) ?? null
        : null;

      if (activeLocalTerrainGeneration
        && activeLocalTerrainGeneration.centerChunkX === centerChunkX
        && activeLocalTerrainGeneration.centerChunkZ === centerChunkZ
        && activeLocalTerrainGeneration.renderDistancePreset === renderDistancePolicy.id
        && equalKeySets(activeLocalTerrainGeneration.activeKeys, activeKeys)
        && equalKeySets(activeLocalTerrainGeneration.renderedKeys, rendered)) {
        positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
        applyLocalTerrainOwnerHandoff(
          activeLocalTerrainGeneration,
          activeDataKeys,
          renderedKeys,
        );
        assignTransitionContract(activeLocalTerrainGeneration, acceptedTransition);
        committedLocalTerrainEpoch = requestedEpoch;
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now())
          - localSyncStartedAt;
        return Object.freeze({
          committed: true,
          reused: true,
          coverageEpoch: requestedEpoch,
          reason: null,
          missingOwnerKeys: Object.freeze([]),
          activeRootId: activeLocalTerrainGeneration.root.name,
        });
      }

      const localRoot = new Group();
      localRoot.name = `w8-local-terrain-coverage-epoch-${requestedEpoch}`;
      localRoot.userData = {
        presentationOnly: true,
        localTerrainCoverage: true,
        coverageEpoch: requestedEpoch,
        renderDistancePreset: renderDistancePolicy.id,
      };
      stagingLocalTerrainRootId = localRoot.name;
      const generation = {
        epoch: requestedEpoch,
        root: localRoot,
        ownedGeometries: new Set(),
        ownedMaterials: new Set(),
        stats: createStats(),
        activeKeys,
        renderedKeys: rendered,
        midgroundOwnerKeys,
        centerChunkX,
        centerChunkZ,
        renderDistancePreset: renderDistancePolicy.id,
        renderDistancePolicy,
        buildOriginChunkX: renderOrigin.renderOriginChunkX,
        buildOriginChunkZ: renderOrigin.renderOriginChunkZ,
        currentOriginChunkX: renderOrigin.renderOriginChunkX,
        currentOriginChunkZ: renderOrigin.renderOriginChunkZ,
        surfacePolicy: currentCanonicalSurfacePolicy,
      };
      assignTransitionContract(generation, acceptedTransition);
      const midground = [...midgroundOwnerKeys]
        .map(key => activeChunks.get(key))
        .sort((left, right) => left.chunkZ - right.chunkZ || left.chunkX - right.chunkX);
      const terrainOwners = [...activeKeys]
        .map(key => activeChunks.get(key))
        .sort((left, right) => left.chunkZ - right.chunkZ || left.chunkX - right.chunkX);
      const context = {
        target: localRoot,
        ownedGeometries: generation.ownedGeometries,
        stats: generation.stats,
        generation,
        surfacePolicy: generation.surfacePolicy,
      };
      try {
        context.stats.midgroundChunkCount = midground.length;
        if (reusableMidgroundMesh) {
          const midgroundMesh = new Mesh(
            reusableMidgroundMesh.geometry,
            reusableMidgroundMesh.material,
          );
          midgroundMesh.name = reusableMidgroundMesh.name;
          midgroundMesh.castShadow = reusableMidgroundMesh.castShadow;
          midgroundMesh.receiveShadow = reusableMidgroundMesh.receiveShadow;
          midgroundMesh.userData = { ...(reusableMidgroundMesh.userData ?? {}) };
          localRoot.add(midgroundMesh);
          generation.localTerrainMesh = midgroundMesh;
          generation.currentVisibleMidgroundOwnerKeys = new Set(
            midgroundMesh.userData.visibleOwnerKeys ?? [],
          );
          generation.reusedMidgroundGeometry = reusableMidgroundMesh.geometry;
        } else {
          measure(
            'distant-midground-terrain',
            () => createMidgroundTerrain(terrainOwners, renderOrigin, context),
          );
        }
        measure('distant-clipmap', () => createClipmap({
          centerChunkX,
          centerChunkZ,
          activeChunks,
          origin: renderOrigin,
          renderDistancePreset: renderDistancePolicy.id,
          surfacePolicy: generation.surfacePolicy,
          stats: generation.stats,
          target: localRoot,
          ownedGeometries: generation.ownedGeometries,
        }));
        applyLocalTerrainOwnerHandoff(generation, activeDataKeys, renderedKeys);
        positionGenerationForOrigin(generation, renderOrigin);
      } catch (error) {
        disposeGeneration(generation);
        localTerrainRejectionCount += 1;
        localTerrainLastRejectionReason = 'build-error';
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now())
          - localSyncStartedAt;
        throw error;
      } finally {
        stagingLocalTerrainRootId = null;
      }
      if (disposed || requestedEpoch !== localTerrainSyncEpoch
        || !transitionIsCurrent(acceptedTransition)) {
        disposeGeneration(generation);
        localTerrainStaleDiscardCount += 1;
        return reject(disposed ? 'disposed-during-build' : 'stale-after-build');
      }
      const previous = activeLocalTerrainGeneration;
      if (generation.reusedMidgroundGeometry) {
        previous?.ownedGeometries.delete(generation.reusedMidgroundGeometry);
        generation.ownedGeometries.add(generation.reusedMidgroundGeometry);
      }
      const localRootSwapStartedAt = globalThis.performance?.now?.() ?? Date.now();
      root.add(generation.root);
      activeLocalTerrainGeneration = generation;
      committedLocalTerrainEpoch = requestedEpoch;
      localTerrainCommitCount += 1;
      disposeGeneration(previous);
      localTerrainLastRootSwapDurationMs = (globalThis.performance?.now?.() ?? Date.now())
        - localRootSwapStartedAt;
      localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now())
        - localSyncStartedAt;
      return Object.freeze({
        committed: true,
        reused: false,
        coverageEpoch: requestedEpoch,
        reason: null,
        missingOwnerKeys: Object.freeze([]),
        activeRootId: generation.root.name,
      });
    },
    async syncLocalTerrainPreset({
      coverageEpoch,
      transitionContract = null,
      activeDataKeys,
      renderedKeys,
      getChunkData,
      renderOrigin,
      centerChunkX,
      centerChunkZ,
      renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
    } = {}) {
      const startedAt = globalThis.performance?.now?.() ?? Date.now();
      localTerrainLastRootSwapDurationMs = 0;
      localTerrainLastMaximumSliceMs = 0;
      localTerrainLastSliceCount = 0;
      const requestedEpoch = Number(coverageEpoch);
      const reject = (reason, missingOwnerKeys = []) => {
        localTerrainRejectionCount += 1;
        localTerrainLastRejectionReason = reason;
        localTerrainLastMissingOwnerKeys = Object.freeze(sortedKeyList(missingOwnerKeys));
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
        return Object.freeze({
          committed: false,
          reused: false,
          coverageEpoch: requestedEpoch,
          reason,
          missingOwnerKeys: localTerrainLastMissingOwnerKeys,
          activeRootId: activeLocalTerrainGeneration?.root?.name ?? null,
        });
      };
      if (!Number.isSafeInteger(requestedEpoch) || requestedEpoch < 1) {
        throw new TypeError('coverageEpoch must be a positive safe integer');
      }
      if (!Array.isArray(activeDataKeys) || !Array.isArray(renderedKeys)
        || typeof getChunkData !== 'function') {
        throw new TypeError('Local terrain preset sync requires active/rendered keys and ChunkData');
      }
      const acceptedTransition = validateTransitionCoverage(transitionContract, {
        activeDataKeys,
        renderedKeys,
        centerChunkX,
        centerChunkZ,
      });
      localTerrainLastRequestedEpoch = requestedEpoch;
      localTerrainLastActiveKeyCount = activeDataKeys.length;
      localTerrainLastRenderedKeyCount = renderedKeys.length;
      localTerrainLastResolvedChunkCount = 0;
      localTerrainLastMidgroundOwnerCount = 0;
      localTerrainLastMissingOwnerKeys = Object.freeze([]);
      localTerrainLastRejectionReason = null;
      if (disposed) return reject('disposed');
      if (!acceptCommittedRenderOrigin(renderOrigin)) return reject('stale-render-origin');
      if (requestedEpoch < localTerrainSyncEpoch) return reject('stale-epoch');
      const renderDistancePolicy = resolveW8RenderDistancePolicy(renderDistancePreset);
      const activeKeys = new Set(activeDataKeys);
      const rendered = new Set(renderedKeys);
      if (activeDataKeys.length !== 25 || activeKeys.size !== 25) {
        return reject('active-key-count');
      }
      if (renderedKeys.length !== 9 || rendered.size !== 9) {
        return reject('rendered-key-count');
      }
      if ([...rendered].some(key => !activeKeys.has(key))) {
        return reject('rendered-owner-outside-active');
      }
      if (!acceptRuntimeTransitionContract(acceptedTransition)) {
        localTerrainStaleDiscardCount += 1;
        return reject('stale-transition');
      }
      localTerrainSyncEpoch = requestedEpoch;
      const activeChunks = new Map();
      const missingOwnerKeys = [];
      for (const key of activeDataKeys) {
        const [chunkX, chunkZ] = key.split(',').map(Number);
        const chunk = getChunkData(chunkX, chunkZ);
        if (!chunk || chunk.chunkX !== chunkX || chunk.chunkZ !== chunkZ) {
          missingOwnerKeys.push(key);
        } else activeChunks.set(key, chunk);
      }
      localTerrainLastResolvedChunkCount = activeChunks.size;
      if (missingOwnerKeys.length) return reject('missing-chunk-data', missingOwnerKeys);
      const midgroundOwnerKeys = new Set([...activeKeys].filter(key => !rendered.has(key)));
      localTerrainLastMidgroundOwnerCount = midgroundOwnerKeys.size;
      if (midgroundOwnerKeys.size !== 16) return reject('midground-owner-count');
      const previous = activeLocalTerrainGeneration;
      if (!previous
        || previous.centerChunkX !== centerChunkX
        || previous.centerChunkZ !== centerChunkZ
        || !equalKeySets(previous.activeKeys, activeKeys)
        || !equalKeySets(previous.renderedKeys, rendered)) {
        return reject('coverage-changed-during-preset-sync');
      }
      if (previous.renderDistancePreset === renderDistancePolicy.id) {
        positionGenerationForOrigin(previous, renderOrigin);
        applyLocalTerrainOwnerHandoff(previous, activeDataKeys, renderedKeys);
        assignTransitionContract(previous, acceptedTransition);
        committedLocalTerrainEpoch = requestedEpoch;
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
        return Object.freeze({
          committed: true,
          reused: true,
          coverageEpoch: requestedEpoch,
          reason: null,
          missingOwnerKeys: Object.freeze([]),
          activeRootId: previous.root.name,
        });
      }
      const reusableMidgroundMesh = previous.root.children?.find(child => (
        child.name === 'w8-midground-outer-sixteen-terrain'
      ));
      if (!reusableMidgroundMesh) return reject('midground-source-missing');

      currentCanonicalSurfacePolicy = surfacePolicyForChunks(activeChunks.values());
      currentCanonicalSurfacePolicy = Object.freeze({
        ...currentCanonicalSurfacePolicy,
        riverCorridors: Object.freeze(riverSurfaceCorridorsForClipmap(
          centerChunkX,
          centerChunkZ,
          currentCanonicalSurfacePolicy,
          renderDistancePolicy.terrainRiverExtentMeters,
        )),
      });
      clipmapSampleCache.clear();
      const localRoot = new Group();
      localRoot.name = `w8-local-terrain-coverage-epoch-${requestedEpoch}`;
      localRoot.userData = {
        presentationOnly: true,
        localTerrainCoverage: true,
        coverageEpoch: requestedEpoch,
        renderDistancePreset: renderDistancePolicy.id,
      };
      stagingLocalTerrainRootId = localRoot.name;
      const generation = {
        epoch: requestedEpoch,
        root: localRoot,
        ownedGeometries: new Set(),
        ownedMaterials: new Set(),
        stats: createStats(),
        activeKeys,
        renderedKeys: rendered,
        midgroundOwnerKeys,
        centerChunkX,
        centerChunkZ,
        renderDistancePreset: renderDistancePolicy.id,
        renderDistancePolicy,
        buildOriginChunkX: renderOrigin.renderOriginChunkX,
        buildOriginChunkZ: renderOrigin.renderOriginChunkZ,
        currentOriginChunkX: renderOrigin.renderOriginChunkX,
        currentOriginChunkZ: renderOrigin.renderOriginChunkZ,
        surfacePolicy: currentCanonicalSurfacePolicy,
      };
      assignTransitionContract(generation, acceptedTransition);
      generation.stats.midgroundChunkCount = 16;
      const midgroundMesh = new Mesh(
        reusableMidgroundMesh.geometry,
        reusableMidgroundMesh.material,
      );
      midgroundMesh.name = reusableMidgroundMesh.name;
      midgroundMesh.castShadow = reusableMidgroundMesh.castShadow;
      midgroundMesh.receiveShadow = reusableMidgroundMesh.receiveShadow;
      midgroundMesh.userData = { ...(reusableMidgroundMesh.userData ?? {}) };
      localRoot.add(midgroundMesh);
      generation.localTerrainMesh = midgroundMesh;
      generation.currentVisibleMidgroundOwnerKeys = new Set(
        midgroundMesh.userData.visibleOwnerKeys ?? [],
      );
      applyLocalTerrainOwnerHandoff(generation, activeDataKeys, renderedKeys);
      const assertCurrent = () => {
        if (disposed || requestedEpoch !== localTerrainSyncEpoch
          || !transitionIsCurrent(acceptedTransition)) throw LOCAL_SYNC_CANCELLED;
      };
      try {
        localTerrainLastMaximumSliceMs = await createClipmapIncrementally({
          centerChunkX,
          centerChunkZ,
          activeChunks,
          origin: renderOrigin,
          renderDistancePreset: renderDistancePolicy.id,
          surfacePolicy: generation.surfacePolicy,
          stats: generation.stats,
          target: localRoot,
          ownedGeometries: generation.ownedGeometries,
        }, assertCurrent);
        assertCurrent();
        positionGenerationForOrigin(generation, renderOrigin);
      } catch (error) {
        disposeGeneration(generation);
        if (stagingLocalTerrainRootId === localRoot.name) stagingLocalTerrainRootId = null;
        if (error === LOCAL_SYNC_CANCELLED) {
          localTerrainStaleDiscardCount += 1;
          return reject(disposed ? 'disposed-during-build' : 'stale-after-build');
        }
        localTerrainLastRejectionReason = 'build-error';
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
        throw error;
      }
      if (stagingLocalTerrainRootId === localRoot.name) stagingLocalTerrainRootId = null;
      previous.ownedGeometries.delete(reusableMidgroundMesh.geometry);
      generation.ownedGeometries.add(reusableMidgroundMesh.geometry);
      const swapStartedAt = globalThis.performance?.now?.() ?? Date.now();
      root.add(generation.root);
      activeLocalTerrainGeneration = generation;
      committedLocalTerrainEpoch = requestedEpoch;
      localTerrainCommitCount += 1;
      disposeGeneration(previous);
      localTerrainLastRootSwapDurationMs = (globalThis.performance?.now?.() ?? Date.now())
        - swapStartedAt;
      localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
      return Object.freeze({
        committed: true,
        reused: false,
        coverageEpoch: requestedEpoch,
        reason: null,
        missingOwnerKeys: Object.freeze([]),
        activeRootId: generation.root.name,
      });
    },
    async sync({
      transitionContract = null,
      activeDataKeys,
      renderedKeys,
      getChunkData,
      renderOrigin,
      centerChunkX,
      centerChunkZ,
      quality = 'high',
      renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
      playerLogicalX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
      playerLogicalZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
      includeFarNatural = true,
      includeUltraNatural = true,
    }) {
      if (disposed) throw new Error('distant presentation is disposed');
      const syncStartedAt = globalThis.performance?.now?.() ?? Date.now();
      const requestedRenderDistancePreset = normalizeW8RenderDistancePreset(
        renderDistancePreset,
      );
      const acceptedTransition = validateTransitionCoverage(transitionContract, {
        activeDataKeys,
        renderedKeys,
        centerChunkX,
        centerChunkZ,
      });
      if (!commitRuntimePresentationState({
        transitionContract: acceptedTransition,
        activeDataKeys,
        renderedKeys,
        renderOrigin,
        quality,
        playerLogicalX,
        playerLogicalZ,
      })) return false;
      const epoch = ++syncEpoch;
      pendingFarSyncEpochs.add(epoch);
      cancelCanonicalChunkRequests?.({
        consumerId: 'distant-owner-query',
        beforeEpoch: epoch,
      });
      const assertCurrent = () => {
        if (disposed || epoch !== syncEpoch
          || !transitionIsCurrent(acceptedTransition)) throw SYNC_CANCELLED;
      };
      const rendered = new Set(renderedKeys);
      const activeKeys = new Set(activeDataKeys);
      const activeChunks = new Map();
      measure('distant-collect', () => {
        for (const key of activeDataKeys) {
          const [chunkX, chunkZ] = key.split(',').map(Number);
          const chunk = getChunkData(chunkX, chunkZ);
          if (chunk) activeChunks.set(key, chunk);
        }
      });
      currentCanonicalSurfacePolicy = surfacePolicyForChunks(activeChunks.values());
      const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
      const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
      let far;
      try {
        far = await prepareCanonicalFarChunks({
          centerWorldX: playerLogicalX,
          centerWorldZ: playerLogicalZ,
          naturalCenterWorldX: playerLogicalX,
          naturalCenterWorldZ: playerLogicalZ,
          quality,
          renderDistancePreset: requestedRenderDistancePreset,
          activeKeys,
          includeFarNatural,
          includeUltraNatural,
          consumerEpoch: epoch,
          assertCurrent,
        });
      } catch (error) {
        if (error !== SYNC_CANCELLED) {
          pendingFarSyncEpochs.delete(epoch);
          throw error;
        }
        staleEpochDiscardCount += 1;
        activeGeneration && (activeGeneration.stats.syncCancelledDuringQueryCount += 1);
        pendingFarSyncEpochs.delete(epoch);
        return false;
      }
      if (disposed || epoch !== syncEpoch || !transitionIsCurrent(acceptedTransition)) {
        staleEpochDiscardCount += 1;
        pendingFarSyncEpochs.delete(epoch);
        return false;
      }
      currentCanonicalSurfacePolicy = surfacePolicyForChunks([
        ...activeChunks.values(),
        ...far.chunks.map(value => value.chunk),
      ], far.riverProjections.map(projection => projection.surfaceCorridor));
      rememberRiverCorridorWindow({
        centerChunkX,
        centerChunkZ,
        terrainRiverExtentMeters:
          resolveW8RenderDistancePolicy(requestedRenderDistancePreset).terrainRiverExtentMeters,
        corridors: far.riverProjections
          .map(projection => projection.surfaceCorridor)
          .filter(Boolean),
      });
      clipmapSampleCache.clear();

      const stagingRoot = new Group();
      stagingRoot.name = `w8-distant-presentation-epoch-${epoch}`;
      stagingRoot.userData = {
        presentationOnly: true,
        epoch,
        renderDistancePreset: requestedRenderDistancePreset,
      };
      const generation = {
        epoch,
        root: stagingRoot,
        ownedGeometries: new Set(),
        ownedMaterials: new Set(),
        stats: createStats(),
        canonicalBuckets: new Map(),
        canonicalObjects: new Map(),
        activeKeys,
        renderedKeys: rendered,
        quality,
        renderDistancePreset: requestedRenderDistancePreset,
        renderDistancePolicy: resolveW8RenderDistancePolicy(requestedRenderDistancePreset),
        buildOriginChunkX: renderOrigin.renderOriginChunkX,
        buildOriginChunkZ: renderOrigin.renderOriginChunkZ,
        currentOriginChunkX: renderOrigin.renderOriginChunkX,
        currentOriginChunkZ: renderOrigin.renderOriginChunkZ,
        playerX: playerLogicalX,
        playerZ: playerLogicalZ,
        queryCandidateCount: far.candidateCount,
        queryTemplateSuccessCount: far.templateSuccessCount,
        queryRemoteCandidateCount: far.remoteCandidateCount,
        queryRemoteSelectedCount: far.remoteSelectedCount,
        queryRemoteHorizonMaterializedCount: far.remoteHorizonMaterializedCount,
        queryRemoteSettlementLimit: far.remoteSettlementLimit,
        queryRemoteBuildingLimitPerSettlement: far.remoteBuildingLimitPerSettlement,
        queryRemotePartLimit: far.remotePartLimit,
        remoteHorizonStartMeters: far.remoteHorizonStartMeters,
        remoteHorizonFadeStartMeters: far.remoteFadeStartMeters,
        remoteHorizonHiddenDistanceMeters: far.remoteHiddenDistanceMeters,
        remoteHorizonFogEnabled: far.remoteFogEnabled,
        queryOwnerChunkCount: far.ownerChunkCount,
        queryOwnerChunkKeys: far.ownerChunkKeys,
        queryNaturalOwnerChunkCount: far.naturalOwnerChunkCount,
        queryNaturalOwnerChunkKeys: far.naturalOwnerChunkKeys,
        queryInnerNaturalOwnerChunkCount: far.innerNaturalOwnerChunkCount,
        queryUltraOwnerChunkCount: far.ultraOwnerChunkCount,
        queryUltraOwnerChunkKeys: far.ultraOwnerChunkKeys,
        queryBuildingOwnerChunkCount: far.buildingOwnerChunkCount,
        queryBuildingOwnerChunkKeys: far.buildingOwnerChunkKeys,
        queryRemoteHorizonOwnerChunkCount: far.remoteHorizonOwnerChunkCount,
        queryExcludedActiveNaturalOwnerCount: far.excludedActiveNaturalOwnerCount,
        queryNaturalCandidateCount: far.naturalCandidateCount,
        queryFarOwnerChunkCacheHits: far.farOwnerChunkCacheHits,
        queryFarOwnerChunkCacheMisses: far.farOwnerChunkCacheMisses,
        queryFarOwnerChunkCacheEvictions: far.farOwnerChunkCacheEvictions,
        queryUltraOwnerChunkCacheHits: far.ultraOwnerChunkCacheHits,
        queryUltraOwnerChunkCacheMisses: far.ultraOwnerChunkCacheMisses,
        queryUltraOwnerChunkCacheEvictions: far.ultraOwnerChunkCacheEvictions,
        innerWarmDurationMs: far.innerWarmDurationMs,
        ultraWarmDurationMs: far.ultraWarmDurationMs,
        queryPreparationDurationMs: far.queryPreparationDurationMs,
        templateResolutionDurationMs: far.templateResolutionDurationMs,
        queryCanonicalChunkSuccessCount: far.canonicalChunkSuccessCount,
        querySettlementFeatureCount: far.settlementFeatureCount,
        queryMajorRoadFeatureCount: far.majorRoadFeatureCount,
        queryLandmarkCount: far.landmarkCount,
        queryRadius: far.queryRadius,
        visibilityMeters: far.visibilityMeters,
        naturalVisibilityMeters: far.naturalVisibilityMeters,
        naturalQueryRadius: far.naturalQueryRadius,
        currentSettlementId: far.currentSettlementId,
        remotePartBudgetRemaining: far.remotePartLimit,
        nearVisibleStableIds: new Set(),
        nearVisibleStableSignature: '',
        nearVisibleSettlementIds: new Set(),
        nearVisibleSettlementSignature: '',
        surfacePolicy: currentCanonicalSurfacePolicy,
      };
      assignTransitionContract(generation, acceptedTransition);
      const context = {
        target: stagingRoot,
        ownedGeometries: generation.ownedGeometries,
        stats: generation.stats,
        generation,
        surfacePolicy: generation.surfacePolicy,
      };
      const scheduler = createSliceScheduler({ assertCurrent });
      try {
        const chunks = [...activeChunks.values()].sort((left, right) => (
          left.chunkZ - right.chunkZ || left.chunkX - right.chunkX
        ));
        for (const chunk of chunks) {
          await addCanonicalChunk({
            chunk,
            origin: renderOrigin,
            coveredSettlementIds: far.settlementIds,
            includeNatural: true,
            farNaturalEligible: true,
            includeNearDetails: true,
            context,
            scheduler,
          });
        }
        await scheduler.checkpoint({ force: true });
        for (const source of far.chunks) {
          await addCanonicalChunk({
            chunk: source.chunk,
            origin: renderOrigin,
            farEligibleSettlementIds: source.settlementIds,
            includeNatural: source.includeNaturalInner || source.includeNaturalUltra,
            farNaturalEligible: source.includeNaturalInner || source.includeNaturalUltra,
            queryCenter: far.queryCenter,
            naturalQueryCenter: far.naturalQueryCenter,
            queryRadius: far.queryRadius,
            naturalQueryRadius: far.naturalQueryRadius,
            naturalDetailQueryRadius: resolveW8RockVisibilityMeters(
              null,
              requestedRenderDistancePreset,
            ),
            context,
            scheduler,
          });
        }
        for (const remote of far.remoteHorizons) {
          await addRemoteSettlementHorizon({
            remote, origin: renderOrigin, context, scheduler,
          });
        }
        generation.stats.remoteSettlementCandidateCount = far.remoteCandidateCount;
        generation.stats.remoteSettlementSelectedCount = far.remoteSelectedCount;
        await scheduler.checkpoint({ force: true });
        await finalizeCanonicalMeshesIncrementally(context, scheduler);
        await scheduler.checkpoint({ force: true });
        await createFarRiverPresentation({
          projections: far.riverProjections, origin: renderOrigin, context, scheduler,
        });
        await createDistantWaterProxies({
          centerChunkX,
          centerChunkZ,
          origin: renderOrigin,
          terrainRiverExtentMeters:
            generation.renderDistancePolicy.terrainRiverExtentMeters,
          context,
          scheduler,
        });
        await scheduler.checkpoint({ force: true });
        positionGenerationForOrigin(generation, renderOrigin);
        const dirtyBuckets = updateCanonicalVisibility(
          generation,
          playerLogicalX,
          playerLogicalZ,
          { compose: false },
        );
        await scheduler.checkpoint({ force: true });
        if (dirtyBuckets.size) {
          await composeCanonicalMeshesIncrementally(generation, dirtyBuckets, scheduler);
        }
        const sliceSnapshot = scheduler.finish();
        generation.maximumSliceMs = sliceSnapshot.maximumSliceMs;
        generation.sliceCount = sliceSnapshot.sliceCount;
        farLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
        farLastSliceCount = sliceSnapshot.sliceCount;
      } catch (error) {
        const sliceSnapshot = scheduler.snapshot();
        farLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
        farLastSliceCount = sliceSnapshot.sliceCount;
        disposeGeneration(generation);
        if (error === SYNC_CANCELLED) {
          staleEpochDiscardCount += 1;
          pendingFarSyncEpochs.delete(epoch);
          return false;
        }
        pendingFarSyncEpochs.delete(epoch);
        throw error;
      }
      if (disposed || epoch !== syncEpoch || !transitionIsCurrent(acceptedTransition)) {
        disposeGeneration(generation);
        staleEpochDiscardCount += 1;
        pendingFarSyncEpochs.delete(epoch);
        return false;
      }
      const previous = activeGeneration;
      const rootSwapStartedAt = globalThis.performance?.now?.() ?? Date.now();
      root.add(generation.root);
      activeGeneration = generation;
      committedEpoch = epoch;
      disposeGeneration(previous);
      generation.rootSwapDurationMs = (globalThis.performance?.now?.() ?? Date.now())
        - rootSwapStartedAt;
      generation.syncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - syncStartedAt;
      pendingFarSyncEpochs.delete(epoch);
      return true;
    },
    setTreeLodDiagnosticsEnabled(enabled) {
      treeLodDiagnosticsEnabled = enabled === true;
      if (!activeGeneration) return treeLodDiagnosticsEnabled;
      if (treeLodDiagnosticsEnabled && !activeGeneration.treeLodDiagnostics) {
        createTreeLodDiagnostics(activeGeneration);
      } else if (activeGeneration.treeLodDiagnostics) {
        if (treeLodDiagnosticsEnabled) updateTreeLodDiagnostics(activeGeneration);
        else disposeTreeLodDiagnostics(activeGeneration);
      }
      return treeLodDiagnosticsEnabled;
    },
    invalidatePendingLocalTerrainSync() {
      localTerrainSyncEpoch += 1;
      return localTerrainSyncEpoch;
    },
    invalidatePendingFarSync() {
      syncEpoch += 1;
      cancelCanonicalChunkRequests?.({
        consumerId: 'distant-owner-query',
        beforeEpoch: syncEpoch + 1,
      });
      return syncEpoch;
    },
    commitRuntimeState(state) {
      if (disposed) return false;
      return commitRuntimePresentationState(state);
    },
    update(playerLogicalX, playerLogicalZ, renderOrigin) {
      if (disposed) return;
      if (!acceptCommittedRenderOrigin(renderOrigin)) return false;
      positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
      if (activeGeneration) {
        positionGenerationForOrigin(activeGeneration, renderOrigin);
        updateCanonicalVisibility(activeGeneration, playerLogicalX, playerLogicalZ);
      }
      return true;
    },
    rebase(renderOrigin) {
      if (disposed || !acceptCommittedRenderOrigin(renderOrigin)) return false;
      positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
      positionGenerationForOrigin(activeGeneration, renderOrigin);
      return true;
    },
    snapshot() {
      const stats = activeGeneration?.stats ?? emptyStats;
      const localTerrainStats = activeLocalTerrainGeneration?.stats ?? emptyStats;
      return Object.freeze({
        schemaVersion: 'w8-distant-presentation-snapshot-1',
        ...stats,
        midgroundChunkCount: localTerrainStats.midgroundChunkCount,
        clipmapMeshCount: localTerrainStats.clipmapMeshCount,
        maximumInnerBoundaryErrorMeters: localTerrainStats.maximumInnerBoundaryErrorMeters,
        maximumInnerBoundaryColorDifference: localTerrainStats.maximumInnerBoundaryColorDifference,
        clipmapDeterministicChecksum: localTerrainStats.clipmapDeterministicChecksum,
        clipmapExtentMeters: activeLocalTerrainGeneration?.renderDistancePolicy
          ?.terrainRiverExtentMeters
          ?? resolveW8RenderDistancePolicy().terrainRiverExtentMeters,
        renderDistancePreset: activeGeneration?.renderDistancePreset
          ?? activeLocalTerrainGeneration?.renderDistancePreset
          ?? W8_DEFAULT_RENDER_DISTANCE_PRESET,
        quality: activeGeneration?.quality ?? null,
        distantTownProxyCount: 0,
        distantNaturalProxyLimit: DISTANT_ROCK_PROXY_LIMIT,
        distantRockProxyLimit: DISTANT_ROCK_PROXY_LIMIT,
        distantTownProxyLimit: 0,
        visibilityMeters: activeGeneration?.visibilityMeters ?? null,
        naturalVisibilityMeters: activeGeneration?.naturalVisibilityMeters ?? null,
        naturalQueryRadius: activeGeneration?.naturalQueryRadius ?? null,
        queryRadius: activeGeneration?.queryRadius ?? null,
        queryCandidateCount: activeGeneration?.queryCandidateCount ?? 0,
        queryTemplateSuccessCount: activeGeneration?.queryTemplateSuccessCount ?? 0,
        queryRemoteCandidateCount: activeGeneration?.queryRemoteCandidateCount ?? 0,
        queryRemoteSelectedCount: activeGeneration?.queryRemoteSelectedCount ?? 0,
        queryRemoteHorizonMaterializedCount:
          activeGeneration?.queryRemoteHorizonMaterializedCount ?? 0,
        queryRemoteSettlementLimit: activeGeneration?.queryRemoteSettlementLimit ?? 0,
        queryRemoteBuildingLimitPerSettlement:
          activeGeneration?.queryRemoteBuildingLimitPerSettlement ?? 0,
        queryRemotePartLimit: activeGeneration?.queryRemotePartLimit ?? 0,
        queryRemoteHorizonOwnerChunkCount:
          activeGeneration?.queryRemoteHorizonOwnerChunkCount ?? 0,
        remoteHorizonStartMeters: activeGeneration?.remoteHorizonStartMeters ?? null,
        remoteHorizonFadeStartMeters: activeGeneration?.remoteHorizonFadeStartMeters ?? null,
        remoteHorizonHiddenDistanceMeters:
          activeGeneration?.remoteHorizonHiddenDistanceMeters ?? null,
        remoteHorizonFogEnabled: activeGeneration?.remoteHorizonFogEnabled ?? null,
        queryOwnerChunkCount: activeGeneration?.queryOwnerChunkCount ?? 0,
        queryOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryOwnerChunkKeys ?? []),
        ]),
        queryNaturalOwnerChunkCount: activeGeneration?.queryNaturalOwnerChunkCount ?? 0,
        queryNaturalOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryNaturalOwnerChunkKeys ?? []),
        ]),
        queryInnerNaturalOwnerChunkCount:
          activeGeneration?.queryInnerNaturalOwnerChunkCount ?? 0,
        queryUltraOwnerChunkCount: activeGeneration?.queryUltraOwnerChunkCount ?? 0,
        queryUltraOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryUltraOwnerChunkKeys ?? []),
        ]),
        queryBuildingOwnerChunkCount: activeGeneration?.queryBuildingOwnerChunkCount ?? 0,
        queryBuildingOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryBuildingOwnerChunkKeys ?? []),
        ]),
        queryExcludedActiveNaturalOwnerCount:
          activeGeneration?.queryExcludedActiveNaturalOwnerCount ?? 0,
        queryNaturalCandidateCount: activeGeneration?.queryNaturalCandidateCount ?? 0,
        queryFarOwnerChunkCacheHits: activeGeneration?.queryFarOwnerChunkCacheHits ?? 0,
        queryFarOwnerChunkCacheMisses: activeGeneration?.queryFarOwnerChunkCacheMisses ?? 0,
        queryFarOwnerChunkCacheEvictions: activeGeneration?.queryFarOwnerChunkCacheEvictions ?? 0,
        queryUltraOwnerChunkCacheHits: activeGeneration?.queryUltraOwnerChunkCacheHits ?? 0,
        queryUltraOwnerChunkCacheMisses: activeGeneration?.queryUltraOwnerChunkCacheMisses ?? 0,
        queryUltraOwnerChunkCacheEvictions: activeGeneration?.queryUltraOwnerChunkCacheEvictions ?? 0,
        innerWarmDurationMs: activeGeneration?.innerWarmDurationMs ?? 0,
        ultraWarmDurationMs: activeGeneration?.ultraWarmDurationMs ?? 0,
        queryPreparationDurationMs: activeGeneration?.queryPreparationDurationMs ?? 0,
        templateResolutionDurationMs: activeGeneration?.templateResolutionDurationMs ?? 0,
        syncDurationMs: activeGeneration?.syncDurationMs ?? 0,
        rootSwapDurationMs: activeGeneration?.rootSwapDurationMs ?? 0,
        presentationSliceBudgetMs: PRESENTATION_SLICE_BUDGET_MS,
        farLastMaximumSliceMs,
        farLastSliceCount,
        queryCanonicalChunkSuccessCount:
          activeGeneration?.queryCanonicalChunkSuccessCount ?? 0,
        querySettlementFeatureCount: activeGeneration?.querySettlementFeatureCount ?? 0,
        queryMajorRoadFeatureCount: activeGeneration?.queryMajorRoadFeatureCount ?? 0,
        queryLandmarkCount: activeGeneration?.queryLandmarkCount ?? 0,
        currentSettlementId: activeGeneration?.currentSettlementId ?? null,
        currentSettlementNearVisible: activeGeneration?.currentSettlementId
          ? activeGeneration.nearVisibleSettlementIds.has(activeGeneration.currentSettlementId)
          : false,
        distantVisibleStableIdCount: activeGeneration?.distantVisibleStableIds?.size ?? 0,
        templateCacheSize: templateCache.size,
        templateCacheCapacity: TEMPLATE_CACHE_CAPACITY,
        farOwnerChunkCacheSize: farOwnerChunkCache.size,
        farOwnerChunkCacheCapacity: FAR_OWNER_CHUNK_CACHE_CAPACITY,
        farOwnerChunkCacheHits,
        farOwnerChunkCacheMisses,
        farOwnerChunkCacheEvictions,
        ultraOwnerChunkCacheSize: ultraOwnerChunkCache.size,
        ultraOwnerChunkCacheCapacity: ULTRA_OWNER_CHUNK_CACHE_CAPACITY,
        ultraOwnerChunkCacheHits,
        ultraOwnerChunkCacheMisses,
        ultraOwnerChunkCacheEvictions,
        treeLodDiagnosticsEnabled,
        queryConcurrencyLimit: CANONICAL_QUERY_CONCURRENCY,
        maximumObservedQueryConcurrency,
        runtimeTransitionGeneration:
          committedRuntimeTransitionContract?.generation ?? null,
        runtimeCoverageSignature:
          committedRuntimeTransitionContract?.coverageSignature ?? null,
        localTerrainTransitionGeneration:
          activeLocalTerrainGeneration?.transitionContract?.generation ?? null,
        localTerrainCoverageSignature:
          activeLocalTerrainGeneration?.transitionContract?.coverageSignature ?? null,
        farTransitionGeneration:
          activeGeneration?.transitionContract?.generation ?? null,
        farCoverageSignature:
          activeGeneration?.transitionContract?.coverageSignature ?? null,
        presentationCoverageAligned: Boolean(
          committedRuntimeTransitionContract
          && activeLocalTerrainGeneration?.transitionContract
          && activeGeneration?.transitionContract
          && committedRuntimeTransitionContract.coverageSignature
            === activeLocalTerrainGeneration.transitionContract.coverageSignature
          && committedRuntimeTransitionContract.coverageSignature
            === activeGeneration.transitionContract.coverageSignature
          && committedRuntimeTransitionContract.generation
            === activeLocalTerrainGeneration.transitionContract.generation
          && committedRuntimeTransitionContract.generation
            === activeGeneration.transitionContract.generation
        ),
        syncEpoch,
        committedEpoch,
        staleEpochDiscardCount,
        committedRenderOrigin,
        staleRenderOriginRejectCount,
        farSyncPending: pendingFarSyncEpochs.size > 0,
        farSyncPendingCount: pendingFarSyncEpochs.size,
        localTerrainSyncEpoch,
        committedLocalTerrainEpoch,
        localTerrainLastRequestedEpoch,
        localTerrainCommitCount,
        localTerrainRejectionCount,
        localTerrainStaleDiscardCount,
        localTerrainCoverageCenter: activeLocalTerrainGeneration ? Object.freeze({
          chunkX: activeLocalTerrainGeneration.centerChunkX,
          chunkZ: activeLocalTerrainGeneration.centerChunkZ,
        }) : null,
        localTerrainActiveKeyCount: localTerrainLastActiveKeyCount,
        localTerrainResolvedChunkCount: localTerrainLastResolvedChunkCount,
        localTerrainRenderedKeyCount: localTerrainLastRenderedKeyCount,
        localTerrainMidgroundOwnerCount: localTerrainLastMidgroundOwnerCount,
        localTerrainMidgroundOwnerKeys: Object.freeze(sortedKeyList(
          activeLocalTerrainGeneration?.midgroundOwnerKeys ?? [],
        )),
        localTerrainHandoffOwnerCount:
          activeLocalTerrainGeneration?.currentVisibleMidgroundOwnerKeys?.size ?? 0,
        localTerrainHandoffOwnerKeys: Object.freeze(sortedKeyList(
          activeLocalTerrainGeneration?.currentVisibleMidgroundOwnerKeys ?? [],
        )),
        localTerrainStoredOwnerCount:
          activeLocalTerrainGeneration?.localTerrainMesh?.userData?.ownerKeys?.length ?? 0,
        localTerrainMissingOwnerKeys: localTerrainLastMissingOwnerKeys,
        localTerrainLastRejectionReason,
        localTerrainLastSyncDurationMs,
        localTerrainLastRootSwapDurationMs,
        localTerrainLastMaximumSliceMs,
        localTerrainLastSliceCount,
        activeLocalTerrainRootId: activeLocalTerrainGeneration?.root?.name ?? null,
        stagingLocalTerrainRootId,
        buildOrigin: activeGeneration ? Object.freeze({
          renderOriginChunkX: activeGeneration.buildOriginChunkX,
          renderOriginChunkZ: activeGeneration.buildOriginChunkZ,
        }) : null,
        currentOrigin: activeGeneration ? Object.freeze({
          renderOriginChunkX: activeGeneration.currentOriginChunkX,
          renderOriginChunkZ: activeGeneration.currentOriginChunkZ,
        }) : null,
        playerLogical: activeGeneration ? Object.freeze({
          x: activeGeneration.playerX,
          z: activeGeneration.playerZ,
        }) : null,
        rootAttached: Boolean(
          root.parent === scene && activeGeneration?.root?.parent === root,
        ),
        localTerrainRootAttached: Boolean(
          root.parent === scene && activeLocalTerrainGeneration?.root?.parent === root,
        ),
        clipmapSampleCacheSize: clipmapSampleCache.size,
        clipmapSampleCacheCapacity: CLIPMAP_SAMPLE_CACHE_CAPACITY,
        clipmapSampleCacheHits,
        clipmapSampleCacheMisses,
        clipmapSampleCacheEvictions,
        rootObjectCount: (activeGeneration?.root.children?.length ?? 0)
          + (activeLocalTerrainGeneration?.root.children?.length ?? 0),
        disposed,
      });
    },
    canonicalAuditSnapshot() {
      const objects = activeGeneration ? [...activeGeneration.canonicalObjects.values()] : [];
      objects.sort((left, right) => left.stableId.localeCompare(right.stableId));
      return Object.freeze(objects.map(object => Object.freeze({
        identity: Object.freeze(structuredClone(object.identity)),
        visibleLod: object.visibleLod,
        presentationTier: object.presentationTier,
        farEligible: object.farEligible,
        instanceCount: object.instances.length,
        composedInstanceCount: object.instances.reduce((count, instance) => (
          count + (instance.bucket.mesh?.userData?.canonicalStableIds ?? [])
            .filter(stableId => stableId === object.stableId).length
        ), 0),
        remoteHorizon: object.remoteHorizon === true,
        ownerKey: object.ownerKey,
        ownerActive: activeGeneration.activeKeys.has(object.ownerKey),
        ownerRendered: activeGeneration.renderedKeys.has(object.ownerKey),
        distanceMeters: Math.hypot(
          object.worldX - activeGeneration.playerX,
          object.worldZ - activeGeneration.playerZ,
        ),
        meshVisible: object.instances.every(instance => instance.bucket.mesh?.visible !== false),
      })));
    },
    dispose() {
      if (disposed) return;
      syncEpoch += 1;
      localTerrainSyncEpoch += 1;
      cancelCanonicalChunkRequests?.({ consumerId: 'distant-owner-query' });
      disposeGeneration(activeGeneration);
      activeGeneration = null;
      disposeGeneration(activeLocalTerrainGeneration);
      activeLocalTerrainGeneration = null;
      committedRuntimeTransitionContract = null;
      pendingFarSyncEpochs.clear();
      scene.remove(root);
      roadGeometry.dispose?.();
      terrainMaterial.dispose?.();
      clipmapSampleCache.clear();
      riverCorridorWindowCache.clear();
      templateCache.clear();
      farOwnerChunkCache.clear();
      ultraOwnerChunkCache.clear();
      disposed = true;
    },
  });
}
