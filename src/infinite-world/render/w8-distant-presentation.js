import {
  LOGICAL_CHUNK_SIZE_METERS,
  UNITS_PER_METER,
} from '../chunk-coordinates.js';
import { CHUNK_DATA_PRIORITY } from '../chunk-data-service-protocol.js';
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
  W8_RENDER_FOG_COLOR_HEX,
  W8_RENDER_DISTANCE_PRESETS,
  normalizeW8RenderDistancePreset,
  resolveW8RenderDistancePolicy,
  resolveW8SettlementHandoffProgress,
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
  W8_SETTLEMENT_SILHOUETTE_COLOR_HEX,
  W8_SETTLEMENT_ROLE_LANDMARKS,
  resolveW8RemoteSettlementOpacityAtDistance,
  resolveW8RemoteSettlementAtmosphere,
  resolveW8SettlementPresentationPolicy,
  selectRemoteHorizonBuildings,
  selectW8SettlementPresentationCandidates,
  settlementCandidateDistance,
} from '../settlement-presentation-policy.js';
import {
  W8_ATMOSPHERIC_VEGETATION_COLOR_HEX,
  W8_FOREST_SILHOUETTE_COLOR_HEX,
  W8_VEGETATION_LOD_KINDS,
  evaluateW8VegetationLodBlend,
  isW8ForestHorizonOwner,
  naturalPresentationKind,
  resolveW8VegetationLodPolicy,
} from '../vegetation-lod-policy.js';
import { createW8ForestHorizonManifest } from '../forest-horizon-manifest.js';
import {
  createSettlementStreamingSnapshotCache,
  isSettlementStreamingSnapshotCurrent,
} from '../settlement-streaming-snapshot-cache.js';
import {
  WORLD_STREAMING_EVENT,
  WORLD_STREAMING_STREAM,
  WORLD_STREAMING_TARGET,
  worldStreamingTargetForCanonicalObject,
} from '../world-streaming-telemetry.js';

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
// Compact horizon summaries are tiny, and the bounded 1/4 owner lattice can
// touch more than 192 owners in a Current-distance window. Retain the whole
// one-step working set so a rebase does not turn continuity into re-generation.
const FOREST_HORIZON_OWNER_CHUNK_CACHE_CAPACITY = 320;
const SHARED_NATURAL_SILHOUETTE_MATERIAL = '__natural-silhouette__';
const CANONICAL_QUERY_CONCURRENCY = 4;
const CANONICAL_QUERY_MARGIN_METERS = Math.SQRT2 * LOGICAL_CHUNK_SIZE_METERS;
const PRESENTATION_SLICE_BUDGET_MS = 8;
const PRESENTATION_SLICE_UNIT_LIMIT = 256;
const NATURAL_STREAM_REVEAL_MS = 900;
const STATIC_TREE_PAGE_FRAME_BUDGET_MS = 3;
const STATIC_TREE_PAGE_UNIT_LIMIT = 512;
const PERSISTENT_DISTANT_BUCKET_CAPACITY = 4_096;
const PERSISTENT_NATURAL_MAXIMUM_BUCKET_SLOTS_PER_OWNER = Object.freeze({
  // Formal Vegetation is bounded to 64 records per owner. Broadleaf and
  // wetland crowns can contribute two parts to one full-detail bucket.
  tree: Object.freeze({ full: 128, derived: 64 }),
  // Bush combines at most 64 formal shrubs and 48 ambient shrubs.
  bush: Object.freeze({ full: 112, derived: 112 }),
  // Ambient details are bounded to 48 records per owner.
  grass: Object.freeze({ full: 48, derived: 48 }),
  // Formal Rocks are bounded to 64 records per owner.
  rock: Object.freeze({ full: 64, derived: 64 }),
});
const STATIC_TREE_DISPOSE_BUDGET_MS = 2;
const STATIC_TREE_OWNER_ADMISSION_LIMIT = 1;
const STATIC_TREE_OWNER_DISPOSE_LIMIT = 1;
const STATIC_TREE_OWNER_PUBLICATION_LIMIT = 1;
const RUNTIME_PRESENTATION_FRAME_BUDGET_MS = PRESENTATION_SLICE_BUDGET_MS;
const DISTANT_PERSISTENT_MESH_ADMISSION_LIMIT = 1;
const DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES = 512 * 1024;
const TREE_RENDER_PATH = Object.freeze({
  LEGACY: 'distant-legacy-tree',
  STATIC: 'distant-static-tree',
  HORIZON: 'forest-horizon-tree',
  ULTRA: 'ultra-tree',
});

function appendSettlementSnapshotHash(hash, value) {
  const text = String(value ?? '');
  let next = hash >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    next ^= text.charCodeAt(index);
    next = Math.imul(next, 0x01000193) >>> 0;
  }
  next ^= 0xff;
  return Math.imul(next, 0x01000193) >>> 0;
}

export function resolveW8PersistentNaturalBucketCapacity({
  kind,
  mode,
  maximumCanonicalOwnerCount,
  maximumManifestOwnerCount,
  requiredSlots = 0,
} = {}) {
  if (!Object.values(W8_VEGETATION_LOD_KINDS).includes(kind)
    || !['full', 'forest', 'atmospheric', 'horizon'].includes(mode)) {
    throw new TypeError('persistent Natural capacity requires a valid kind and LOD mode');
  }
  if (!Number.isSafeInteger(maximumCanonicalOwnerCount)
    || maximumCanonicalOwnerCount < 1
    || !Number.isSafeInteger(maximumManifestOwnerCount)
    || maximumManifestOwnerCount < 0
    || !Number.isSafeInteger(requiredSlots)
    || requiredSlots < 0) {
    throw new RangeError('persistent Natural capacity requires bounded owner and slot counts');
  }
  const ownerCount = mode === 'horizon'
    ? maximumManifestOwnerCount : maximumCanonicalOwnerCount;
  const slotContract = PERSISTENT_NATURAL_MAXIMUM_BUCKET_SLOTS_PER_OWNER[kind];
  const slotsPerOwner = mode === 'full' ? slotContract.full : slotContract.derived;
  const capacity = ownerCount * slotsPerOwner;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || requiredSlots > capacity) {
    throw new RangeError([
      'persistent Natural bucket capacity exceeded',
      `kind=${kind}`,
      `mode=${mode}`,
      `required=${requiredSlots}`,
      `capacity=${capacity}`,
      `owners=${ownerCount}`,
    ].join(' '));
  }
  return capacity;
}

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
  getForestHorizonManifest = null,
  cancelCanonicalChunkRequests = null,
  publishStaticOwnerTickets = null,
  incrementalStaticTreePages = false,
  isFeatureDestroyed = () => false,
  getNearVisibleStableIds = () => [],
  getNearVisibleSettlementIds = () => [],
  measure = (_stage, operation) => operation(),
  yieldToMainThread = () => new Promise(resolve => globalThis.setTimeout(resolve, 0)),
  telemetry = null,
  resolveStaticNaturalCapacity = null,
  diagnosticsEnabled = false,
  recordDiagnosticWork = () => null,
  recordDiagnosticEvent = () => null,
  getDiagnosticFrameSequence = () => null,
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
  if (getForestHorizonManifest !== null && typeof getForestHorizonManifest !== 'function') {
    throw new TypeError('getForestHorizonManifest must be a function when provided');
  }
  if (publishStaticOwnerTickets !== null && typeof publishStaticOwnerTickets !== 'function') {
    throw new TypeError('publishStaticOwnerTickets must be a function when provided');
  }
  if (resolveStaticNaturalCapacity !== null
    && typeof resolveStaticNaturalCapacity !== 'function') {
    throw new TypeError('resolveStaticNaturalCapacity must be a function when provided');
  }
  if (typeof incrementalStaticTreePages !== 'boolean') {
    throw new TypeError('incrementalStaticTreePages must be boolean');
  }
  if (typeof diagnosticsEnabled !== 'boolean') {
    throw new TypeError('diagnosticsEnabled must be boolean');
  }
  if (typeof recordDiagnosticWork !== 'function'
    || typeof recordDiagnosticEvent !== 'function'
    || typeof getDiagnosticFrameSequence !== 'function') {
    throw new TypeError('Distant diagnostic hooks must be functions');
  }
  if (typeof getNearVisibleStableIds !== 'function'
    || typeof getNearVisibleSettlementIds !== 'function') {
    throw new TypeError('Near presentation identity providers must be functions');
  }
  const streamingTelemetry = telemetry?.enabled === true ? telemetry : null;
  const Group = requireConstructor(THREE, 'Group');
  const Mesh = requireConstructor(THREE, 'Mesh');
  const InstancedMesh = requireConstructor(THREE, 'InstancedMesh');
  const Object3D = requireConstructor(THREE, 'Object3D');
  const PlaneGeometry = requireConstructor(THREE, 'PlaneGeometry');
  const Color = requireConstructor(THREE, 'Color');
  const Material = typeof THREE.MeshPhongMaterial === 'function'
    ? THREE.MeshPhongMaterial : requireConstructor(THREE, 'MeshLambertMaterial');
  const macroEvaluator = await createMacroTerrainEvaluator(worldSeedHash);
  const biomeEvaluator = await createNaturalBiomeEvaluator({ worldSeedHash });
  const canonicalRiverSourceStableId = await createCanonicalRiverSourceId(worldSeedHash);
  const root = new Group();
  root.name = 'w8-scene-owned-distant-world';
  root.userData = { presentationOnly: true, treePathRole: 'distant-root-container' };
  root.visible = true;
  scene.add(root);
  const treePathAuditState = new Map(Object.values(TREE_RENDER_PATH).map(pathId => [pathId, {
    firstDrawAtMs: null,
    lastUpdateAtMs: null,
    matrixUpdateCount: 0,
    bufferUpdateCount: 0,
    visibilityChangeCount: 0,
    disposeCount: 0,
  }]));
  const recordTreePathAudit = (pathId, values = {}) => {
    const state = treePathAuditState.get(pathId);
    if (!state) return;
    for (const [key, value] of Object.entries(values)) {
      if (key === 'firstDrawAtMs' || key === 'lastUpdateAtMs') state[key] = value;
      else state[key] += value;
    }
  };
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
    canonicalGrassRecordCount: 0,
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
    visibleCanonicalGrassCount: 0,
    visibleCanonicalRockCount: 0,
    visibleCanonicalFullTreeCount: 0,
    visibleCanonicalSilhouetteTreeCount: 0,
    visibleCanonicalUltraTreeCount: 0,
    visibleCanonicalTreePartInstanceCount: 0,
    visibleCanonicalTreeMidBandCount: 0,
    visibleCanonicalTreeOuterBandCount: 0,
    visibleCanonicalTreeUltraInnerBandCount: 0,
    visibleCanonicalTreeUltraOuterBandCount: 0,
    visibleCanonicalNaturalCrossFadeCount: 0,
    visibleCanonicalForestInstanceCount: 0,
    visibleCanonicalAtmosphericInstanceCount: 0,
    visibleCanonicalForestHorizonInstanceCount: 0,
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
  let buildingPublicationSource = 'legacy-distant-root';
  let settlementRoadPublicationSource = 'legacy-distant-root';
  let settlementMetadataPublicationSource = 'legacy-distant-root';
  let settlementPublicationPlanId = null;
  let settlementPublicationRevision = 0;
  const settlementStreamingSnapshotCache = createSettlementStreamingSnapshotCache();
  let settlementShadowSnapshotRequestCount = 0;
  let settlementShadowSnapshotReuseCount = 0;
  let settlementShadowSnapshotCount = 0;
  let settlementShadowCanonicalObjectScanCount = 0;
  let settlementShadowStableIdMaterializationCount = 0;
  let persistentDistantRoot = null;
  let persistentDistantPublishedGeneration = null;
  const liveDistantEntries = new Map();
  let pendingDistantPublication = null;
  let preparedRenderDistanceDistant = null;
  const retiredDistantGenerations = new Set();
  let distantPersistentPublicationCount = 0;
  let distantPersistentReusedMeshCount = 0;
  let distantPersistentCreatedMeshCount = 0;
  let distantPersistentNewCanonicalMeshCount = 0;
  let distantPersistentNewAuxiliaryMeshCount = 0;
  let distantPersistentRemovedMeshCount = 0;
  let distantPersistentUploadByteCount = 0;
  let distantPersistentMaximumUploadBytesPerFrame = 0;
  let distantPersistentBoundsRecalculationCount = 0;
  let distantPersistentMatrixUpdateCount = 0;
  let distantPersistentMaximumMatrixUpdatesPerFrame = 0;
  let distantPersistentBufferUpdateCount = 0;
  let distantPersistentMaximumBufferUpdatesPerFrame = 0;
  let distantPersistentMaximumMeshAdmissionsPerFrame = 0;
  let distantPersistentAdmissionLimitViolationCount = 0;
  let distantPersistentOverBudgetUploadCount = 0;
  let distantPersistentMaximumSliceMs = 0;
  let pendingDistantFirstDraw = null;
  const pendingStaticTreeFirstDraw = [];
  let activeLocalTerrainGeneration = null;
  let preparedRenderDistanceLocalTerrain = null;
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

  const recordDistantPublication = generation => {
    if (!streamingTelemetry) return;
    const planId = generation.transitionContract?.generation ?? null;
    const centerOwnerKey = generation.transitionContract?.centerChunkKey ?? null;
    const summaries = new Map();
    if (centerOwnerKey) {
      summaries.set(`${centerOwnerKey}\n${WORLD_STREAMING_TARGET.DISTANT}`, {
        target: WORLD_STREAMING_TARGET.DISTANT,
        ownerKey: centerOwnerKey,
        resourceKey: centerOwnerKey,
        stableId: null,
        count: 1,
      });
    }
    for (const object of generation.canonicalObjects.values()) {
      if (object.visibleLod === 'hidden' || object.visibleLod === 'destroyed'
        || object.presentationTier === null) continue;
      const target = worldStreamingTargetForCanonicalObject(object.record);
      if (target) {
        const key = `${object.ownerKey}\n${target}`;
        const current = summaries.get(key) ?? {
          target,
          ownerKey: object.ownerKey,
          resourceKey: object.ownerKey,
          stableId: object.stableId,
          count: 0,
        };
        current.count += 1;
        summaries.set(key, current);
      }
      if (typeof object.settlementId === 'string' && object.settlementId) {
        const key = `${object.ownerKey}\n${WORLD_STREAMING_TARGET.SETTLEMENT}`;
        const current = summaries.get(key) ?? {
          target: WORLD_STREAMING_TARGET.SETTLEMENT,
          ownerKey: object.ownerKey,
          resourceKey: object.ownerKey,
          stableId: object.settlementId,
          count: 0,
        };
        current.count += 1;
        summaries.set(key, current);
      }
    }
    const pending = [];
    for (const summary of summaries.values()) {
      const details = {
        target: summary.target,
        stream: WORLD_STREAMING_STREAM.DISTANT,
        resourceKey: summary.resourceKey,
        ownerKey: summary.ownerKey,
        stableId: summary.stableId,
        planId,
        metadata: { instanceCount: summary.count, epoch: generation.epoch },
      };
      const published = streamingTelemetry.record(WORLD_STREAMING_EVENT.PUBLISH, details);
      pending.push({ ...details, correlationId: published?.correlationId ?? null });
    }
    pendingDistantFirstDraw = { epoch: generation.epoch, events: pending };
  };
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
  const forestHorizonOwnerChunkCache = new Map();
  let nearVisibleSnapshotIdentity = null;
  let nearVisibleSnapshotState = Object.freeze({
    stableIds: new Set(),
    signature: '',
  });
  const readNearVisibleSnapshotState = () => {
    const snapshot = getNearVisibleStableIds() ?? [];
    if (snapshot === nearVisibleSnapshotIdentity) return nearVisibleSnapshotState;
    const stableIds = new Set(snapshot);
    nearVisibleSnapshotIdentity = snapshot;
    nearVisibleSnapshotState = Object.freeze({
      stableIds,
      signature: [...stableIds].sort((left, right) => left.localeCompare(right)).join('\n'),
    });
    return nearVisibleSnapshotState;
  };
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
  let forestHorizonOwnerChunkCacheHits = 0;
  let forestHorizonOwnerChunkCacheMisses = 0;
  let forestHorizonOwnerChunkCacheEvictions = 0;
  let treeLodDiagnosticsEnabled = false;
  let disposed = false;
  const SYNC_CANCELLED = Symbol('w8-distant-sync-cancelled');
  const LOCAL_SYNC_CANCELLED = Symbol('w8-local-terrain-sync-cancelled');

  const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
  const materialColorHex = material => {
    const color = material?.color;
    if (typeof color?.getHex === 'function') return color.getHex();
    if (Number.isFinite(color?.value)) return color.value;
    if (Number.isFinite(color)) return color;
    return null;
  };
  const snapshotMaterial = (path, material) => Object.freeze({
    path,
    materialName: material?.name ?? null,
    materialType: material?.type ?? material?.constructor?.name ?? null,
    lightingModel: material?.isMeshPhongMaterial === true
      || material?.type === 'MeshPhongMaterial'
      || material?.constructor?.name === 'MeshPhongMaterial'
      ? 'phong' : material?.isMeshLambertMaterial === true
        || material?.type === 'MeshLambertMaterial'
        || material?.constructor?.name === 'MeshLambertMaterial'
        ? 'lambert' : 'unknown',
    baseColorHex: materialColorHex(material),
    vertexColors: material?.vertexColors === true,
    flatShading: material?.flatShading === true,
    shininess: Number.isFinite(material?.shininess) ? material.shininess : null,
    fog: material?.fog !== false,
    opacity: Number.isFinite(material?.opacity) ? material.opacity : null,
    transparent: material?.transparent === true,
    alphaTest: Number.isFinite(material?.alphaTest) ? material.alphaTest : null,
    alphaHash: material?.alphaHash === true,
    toneMapped: material?.toneMapped !== false,
    depthWrite: material?.depthWrite !== false,
    mapColorSpace: material?.map?.colorSpace ?? null,
    naturalLodMode: material?.userData?.naturalLodMode ?? null,
    naturalLodKind: material?.userData?.naturalLodKind ?? null,
    sourceTinted: material?.userData?.naturalLodSourceTinted ?? null,
    customProgramCacheKey: typeof material?.customProgramCacheKey === 'function'
      ? material.customProgramCacheKey() : null,
    customAtmosphericFogBlend: ['atmospheric', 'horizon'].includes(
      material?.userData?.naturalLodMode,
    ),
  });
  const createSliceScheduler = ({
    assertCurrent,
    budgetMs = PRESENTATION_SLICE_BUDGET_MS,
    unitLimit = PRESENTATION_SLICE_UNIT_LIMIT,
  } = {}) => {
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
        if (!force && elapsed < budgetMs && units < unitLimit) return null;
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
    for (const pathId of treePathIdsForGeneration(generation)) {
      recordTreePathAudit(pathId, { disposeCount: 1 });
    }
    root.remove(generation.root);
    scene.remove?.(generation.root);
    for (const child of generation.root.children ?? []) child.dispose?.();
    generation.root.clear?.();
    for (const geometry of generation.ownedGeometries) geometry.dispose?.();
    generation.ownedGeometries.clear();
    for (const material of generation.ownedMaterials ?? []) material.dispose?.();
    generation.ownedMaterials?.clear?.();
  };
  const deferredGenerationDisposals = [];
  const deferGenerationDispose = generation => {
    if (!generation) return;
    root.remove(generation.root);
    scene.remove?.(generation.root);
    deferredGenerationDisposals.push({
      generation,
      rootToClear: generation.root,
      children: [...(generation.root.children ?? [])],
      geometries: [...(generation.ownedGeometries ?? [])],
      materials: [...(generation.ownedMaterials ?? [])],
      stage: 'children',
    });
  };
  const retireGeneration = generation => {
    if (incrementalStaticTreePages) deferGenerationDispose(generation);
    else disposeGeneration(generation);
  };

  const matrixValues = matrix => matrix?.elements ?? null;
  const matricesEqual = (left, right) => {
    const leftValues = matrixValues(left);
    const rightValues = matrixValues(right);
    if (leftValues && rightValues) {
      if (leftValues.length !== rightValues.length) return false;
      for (let index = 0; index < leftValues.length; index += 1) {
        if (leftValues[index] !== rightValues[index]) return false;
      }
      return true;
    }
    return JSON.stringify(left) === JSON.stringify(right);
  };
  const attributeBytes = attribute => {
    const values = attribute?.array ?? attribute?.values ?? null;
    if (!values) return 0;
    return Number.isFinite(values.byteLength) ? values.byteLength : values.length * 4;
  };
  const estimateMeshUploadBytes = mesh => {
    if (!mesh) return 0;
    let bytes = attributeBytes(mesh.instanceMatrix) + attributeBytes(mesh.instanceColor);
    if (bytes === 0 && Number.isFinite(mesh.count)) bytes += mesh.count * 16 * 4;
    for (const attribute of Object.values(mesh.geometry?.attributes ?? {})) {
      if (attribute === mesh.instanceMatrix || attribute === mesh.instanceColor) continue;
      if (attribute?.isInstancedBufferAttribute || attribute?.itemSize && (
        attribute?.count === mesh.capacity || attribute?.count === mesh.count
      )) bytes += attributeBytes(attribute);
    }
    return bytes;
  };
  const directCanonicalMeshEntries = generation => new Map(
    [...(generation?.canonicalBuckets?.entries?.() ?? [])]
      .filter(([, bucket]) => bucket.mesh || bucket.persistentReuseEntryKey)
      .map(([key, bucket]) => [`bucket:${key}`, { key, bucket, mesh: bucket.mesh, generation }]),
  );
  const directAuxiliaryMeshEntries = generation => {
    const canonicalMeshes = new Set(
      [...(generation?.canonicalBuckets?.values?.() ?? [])].map(bucket => bucket.mesh),
    );
    const counts = new Map();
    const entries = new Map();
    for (const child of generation?.stagingRoot?.children ?? generation?.root?.children ?? []) {
      if (canonicalMeshes.has(child)) continue;
      const name = child.name || child.type || 'auxiliary';
      const ordinal = counts.get(name) ?? 0;
      counts.set(name, ordinal + 1);
      const key = `aux:${name}:${ordinal}`;
      entries.set(key, { key, bucket: null, mesh: child, generation });
    }
    return entries;
  };
  const itemVisibilitySignature = (generation, item) => {
    const opacity = canonicalInstanceOpacity(item.object, item);
    const visible = ['mid', 'far'].includes(item.object.visibleLod)
      && !(item.object.remoteHorizon
        && (generation.nearVisibleStableIds ?? new Set()).has(item.object.stableId))
      && opacity > 0;
    return `${visible ? 1 : 0}:${opacity}`;
  };
  const assignPersistentItemKeys = bucket => {
    const ordinals = new Map();
    for (const item of bucket.items) {
      if (!item) continue;
      const stableId = item.object.stableId;
      const ordinal = ordinals.get(stableId) ?? 0;
      ordinals.set(stableId, ordinal + 1);
      item.persistentKey = `${stableId}\n${ordinal}`;
    }
  };
  const initializePersistentBucketSlots = bucket => {
    if (bucket.persistentSlotByKey) return;
    assignPersistentItemKeys(bucket);
    bucket.persistentSlotByKey = new Map();
    for (let slot = 0; slot < bucket.items.length; slot += 1) {
      const item = bucket.items[slot];
      if (!item) continue;
      item.slot = slot;
      bucket.persistentSlotByKey.set(item.persistentKey, slot);
    }
  };
  const createPersistentBucketWork = (generation, desired, live) => {
    initializePersistentBucketSlots(live);
    assignPersistentItemKeys(desired);
    const desiredByKey = new Map(desired.items.map(item => [item.persistentKey, item]));
    const removedSlots = [];
    for (const [key, slot] of live.persistentSlotByKey) {
      if (!desiredByKey.has(key)) removedSlots.push(slot);
    }
    removedSlots.sort((left, right) => right - left);
    const nextItems = [...live.items];
    const nextSlotByKey = new Map();
    const operations = [];
    let nextUnusedSlot = nextItems.length;
    let reusedSlotCount = 0;
    for (const item of desired.items) {
      const currentSlot = live.persistentSlotByKey.get(item.persistentKey);
      const slot = currentSlot ?? removedSlots.pop() ?? nextUnusedSlot++;
      if (slot >= (live.capacity ?? live.mesh.capacity)) {
        throw new RangeError(`persistent Distant bucket capacity exceeded: ${desired.key}`);
      }
      const previousItem = currentSlot === undefined ? null : live.items[currentSlot];
      item.slot = slot;
      nextItems[slot] = item;
      nextSlotByKey.set(item.persistentKey, slot);
      const changed = !previousItem
        || !matricesEqual(previousItem.matrix, item.matrix)
        || itemVisibilitySignature(activeGeneration ?? generation, previousItem)
          !== itemVisibilitySignature(generation, item);
      if (changed) operations.push({ slot, previousItem, desiredItem: item });
      else reusedSlotCount += 1;
    }
    for (const [key, slot] of live.persistentSlotByKey) {
      if (nextSlotByKey.has(key)) continue;
      if (nextItems[slot]?.persistentKey === key) nextItems[slot] = null;
      if (!operations.some(operation => operation.slot === slot)) {
        operations.push({ slot, previousItem: live.items[slot], desiredItem: null });
      }
    }
    while (nextItems.length && !nextItems.at(-1)) nextItems.pop();
    operations.sort((left, right) => {
      const leftRequired = generation.activeKeys.has(left.desiredItem?.object?.ownerKey) ? 0 : 1;
      const rightRequired = generation.activeKeys.has(right.desiredItem?.object?.ownerKey) ? 0 : 1;
      return leftRequired - rightRequired || left.slot - right.slot;
    });
    return {
      type: 'bucket',
      key: `bucket:${desired.key}`,
      generation,
      desired,
      live,
      operations,
      cursor: 0,
      preparedSlots: [],
      nextItems,
      nextSlotByKey,
      reusedSlotCount,
      required: desired.items.some(item => generation.activeKeys.has(item.object.ownerKey)),
    };
  };
  const cleanupRetiredDistantGenerations = () => {
    const liveGenerations = new Set([...liveDistantEntries.values()].map(entry => entry.generation));
    for (const generation of [...retiredDistantGenerations]) {
      if (liveGenerations.has(generation) || generation === activeGeneration) continue;
      const detachedRoot = generation.stagingRoot;
      deferredGenerationDisposals.push({
        generation,
        rootToClear: detachedRoot ?? null,
        children: [...(detachedRoot?.children ?? [])],
        geometries: [...(generation.ownedGeometries ?? [])],
        materials: [...(generation.ownedMaterials ?? [])],
        stage: 'children',
      });
      retiredDistantGenerations.delete(generation);
    }
  };
  const rollbackUnpublishedPersistentBucketWrites = publication => {
    const work = publication?.queue?.[0];
    if (work?.type !== 'bucket' || work.cursor <= 0) return;
    const hidden = hiddenCanonicalMatrix();
    for (let index = 0; index < work.cursor; index += 1) {
      const operation = work.operations[index];
      const item = operation.previousItem;
      const opacity = item ? canonicalInstanceOpacity(item.object, item) : 0;
      const visible = item && ['mid', 'far'].includes(item.object.visibleLod)
        && !(item.object.remoteHorizon
          && (publication.previous.nearVisibleStableIds ?? new Set()).has(item.object.stableId))
        && opacity > 0;
      work.live.mesh.setMatrixAt(operation.slot, visible ? item.matrix : hidden);
      if (item) {
        writeRemoteBuildingAnchor(work.live, operation.slot, item.object, publication.previous);
        writeNaturalAnchor(work.live, operation.slot, item.object, publication.previous);
        writeNaturalInitialReveal(work.live, operation.slot, item.object, publication.previous);
        writeLocalHandoffOpacity(work.live, operation.slot, visible ? opacity : 0);
      }
    }
  };
  const completePersistentDistantPublication = publication => {
    if (pendingDistantPublication !== publication) return false;
    const generation = publication.generation;
    pendingDistantPublication = null;
    generation.root = persistentDistantRoot;
    generation.stagingRoot = publication.stagingRoot;
    persistentDistantPublishedGeneration = generation;
    positionGenerationForOrigin(generation, committedRenderOrigin);
    if (generation.naturalReveal < 1) generation.naturalRevealStartedAt = monotonicNow();
    recordDistantPublication(generation);
    distantPersistentPublicationCount += 1;
    cleanupRetiredDistantGenerations();
    return true;
  };
  const processPersistentDistantPublication = budgetMs => {
    const publication = pendingDistantPublication;
    if (!publication || !(budgetMs > 0)) return Object.freeze({ admissions: 0, bytes: 0 });
    const startedAt = monotonicNow();
    let admissions = 0;
    let uploadBytes = 0;
    let matrixUpdates = 0;
    let bufferUpdates = 0;
    const work = publication.queue[0] ?? null;
    if (work?.type === 'bucket') {
      const hidden = hiddenCanonicalMatrix();
      while (work.cursor < work.operations.length
        && work.preparedSlots.length < STATIC_TREE_PAGE_UNIT_LIMIT
        && monotonicNow() - startedAt < budgetMs) {
        const operation = work.operations[work.cursor];
        const item = operation.desiredItem;
        const opacity = item ? canonicalInstanceOpacity(item.object, item) : 0;
        const visible = item && ['mid', 'far'].includes(item.object.visibleLod)
          && !(item.object.remoteHorizon
            && (work.generation.nearVisibleStableIds ?? new Set()).has(item.object.stableId))
          && opacity > 0;
        work.live.mesh.setMatrixAt(operation.slot, visible ? item.matrix : hidden);
        if (item) {
          writeRemoteBuildingAnchor(work.live, operation.slot, item.object, work.generation);
          writeNaturalAnchor(work.live, operation.slot, item.object, work.generation);
          writeNaturalInitialReveal(work.live, operation.slot, item.object, work.generation);
          writeLocalHandoffOpacity(work.live, operation.slot, visible ? opacity : 0);
        }
        work.preparedSlots.push(operation.slot);
        work.cursor += 1;
        matrixUpdates += 1;
      }
      if (work.cursor >= work.operations.length) {
        const slotBytes = 16 * 4
          + Number(Boolean(work.live.remoteAnchorAttribute)) * 2 * 4
          + Number(Boolean(work.live.naturalAnchorAttribute)) * 2 * 4
          + Number(Boolean(work.live.naturalInitialRevealAttribute)) * 4
          + Number(Boolean(work.live.localHandoffOpacityAttribute)) * 4;
        const bytes = new Set(work.preparedSlots).size * slotBytes;
        if (bytes <= DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES) {
          const slots = [...new Set(work.preparedSlots)].sort((left, right) => left - right);
          const matrixUpload = markAttributeRanges(work.live.mesh.instanceMatrix, slots, 16);
          const remoteUpload = markAttributeRanges(work.live.remoteAnchorAttribute, slots, 2);
          const anchorUpload = markAttributeRanges(work.live.naturalAnchorAttribute, slots, 2);
          const revealUpload = markAttributeRanges(
            work.live.naturalInitialRevealAttribute,
            slots,
            1,
          );
          const handoffUpload = markAttributeRanges(
            work.live.localHandoffOpacityAttribute,
            slots,
            1,
          );
          uploadBytes += (matrixUpload?.byteCount ?? 0)
            + (remoteUpload?.byteCount ?? 0)
            + (anchorUpload?.byteCount ?? 0)
            + (revealUpload?.byteCount ?? 0)
            + (handoffUpload?.byteCount ?? 0);
          bufferUpdates += [
            matrixUpload,
            remoteUpload,
            anchorUpload,
            revealUpload,
            handoffUpload,
          ].filter(Boolean).length;
          work.live.items = work.nextItems;
          work.live.persistentSlotByKey = work.nextSlotByKey;
          work.live.mesh.count = work.nextItems.length;
          work.live.mesh.userData.canonicalStableIds = work.nextItems.map(item => {
            if (!item) return null;
            const opacity = canonicalInstanceOpacity(item.object, item);
            return ['mid', 'far'].includes(item.object.visibleLod) && opacity > 0
              ? item.object.stableId : null;
          });
          work.live.mesh.userData.canonicalObjects = work.nextItems.map(item => item?.object.record ?? null);
          work.live.mesh.userData.canonicalOpacities = work.nextItems.map(item => (
            item ? canonicalInstanceOpacity(item.object, item) : 0
          ));
          work.live.mesh.boundingBox = null;
          work.live.mesh.boundingSphere = null;
          distantPersistentBoundsRecalculationCount += 1;
          if (typeof work.live.mesh.computeBoundingSphere === 'function') {
            work.live.mesh.computeBoundingSphere();
          }
          work.generation.canonicalBuckets.set(work.desired.key, work.live);
          for (const item of work.nextItems) {
            if (!item) continue;
            item.object.instances = item.object.instances.map(instance => (
              instance.bucket === work.desired ? { bucket: work.live, item } : instance
            ));
          }
          liveDistantEntries.set(work.key, {
            key: work.key,
            bucket: work.live,
            mesh: work.live.mesh,
            generation: liveDistantEntries.get(work.key)?.generation ?? publication.previous,
          });
          distantPersistentReusedMeshCount += 1;
          publication.queue.shift();
          admissions = 1;
        } else {
          distantPersistentOverBudgetUploadCount += 1;
          throw new RangeError(`persistent Distant bucket upload exceeds frame budget: ${work.key}`);
        }
      }
    } else if (work) {
      const bytes = work.type === 'remove' ? 0 : estimateMeshUploadBytes(work.desired.mesh);
      if (bytes <= DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES) {
        publication.queue.shift();
        const previous = liveDistantEntries.get(work.key) ?? null;
        if (previous) {
          persistentDistantRoot.remove(previous.mesh);
          previous.mesh.dispose?.();
          liveDistantEntries.delete(work.key);
          distantPersistentRemovedMeshCount += 1;
        }
        if (work.type !== 'remove') {
          const next = work.desired;
          next.mesh.parent?.remove?.(next.mesh);
          persistentDistantRoot.add(next.mesh);
          distantPersistentBoundsRecalculationCount += 1;
          if (typeof next.mesh.computeBoundingSphere === 'function') {
            next.mesh.computeBoundingSphere();
          }
          liveDistantEntries.set(work.key, next);
          distantPersistentCreatedMeshCount += 1;
          if (work.key.startsWith('bucket:')) distantPersistentNewCanonicalMeshCount += 1;
          else distantPersistentNewAuxiliaryMeshCount += 1;
          uploadBytes += bytes;
        }
        admissions = 1;
      }
    }
    if (uploadBytes > DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES) {
      distantPersistentOverBudgetUploadCount += 1;
    }
    distantPersistentUploadByteCount += uploadBytes;
    distantPersistentMatrixUpdateCount += matrixUpdates;
    distantPersistentBufferUpdateCount += bufferUpdates;
    distantPersistentMaximumMatrixUpdatesPerFrame = Math.max(
      distantPersistentMaximumMatrixUpdatesPerFrame,
      matrixUpdates,
    );
    distantPersistentMaximumBufferUpdatesPerFrame = Math.max(
      distantPersistentMaximumBufferUpdatesPerFrame,
      bufferUpdates,
    );
    distantPersistentMaximumUploadBytesPerFrame = Math.max(
      distantPersistentMaximumUploadBytesPerFrame,
      uploadBytes,
    );
    distantPersistentMaximumMeshAdmissionsPerFrame = Math.max(
      distantPersistentMaximumMeshAdmissionsPerFrame,
      admissions,
    );
    if (admissions > DISTANT_PERSISTENT_MESH_ADMISSION_LIMIT) {
      distantPersistentAdmissionLimitViolationCount += 1;
    }
    distantPersistentMaximumSliceMs = Math.max(
      distantPersistentMaximumSliceMs,
      monotonicNow() - startedAt,
    );
    if (publication.queue.length === 0) completePersistentDistantPublication(publication);
    return Object.freeze({ admissions, bytes: uploadBytes });
  };
  const beginPersistentDistantPublication = (generation, previous) => {
    if (!persistentDistantRoot || !previous) return false;
    const displayPrevious = persistentDistantPublishedGeneration ?? previous;
    if (pendingDistantPublication) {
      rollbackUnpublishedPersistentBucketWrites(pendingDistantPublication);
      retiredDistantGenerations.add(pendingDistantPublication.generation);
    }
    const desiredEntries = new Map([
      ...directCanonicalMeshEntries(generation),
      ...directAuxiliaryMeshEntries(generation),
    ]);
    const queue = [];
    for (const [key, desired] of desiredEntries) {
      const live = liveDistantEntries.get(key) ?? null;
      const reusableBucket = key.startsWith('bucket:') && live
        && desired.bucket.persistentReuseEntryKey === key;
      if (reusableBucket) queue.push(createPersistentBucketWork(
        generation,
        desired.bucket,
        live.bucket,
      ));
      else queue.push({ type: live ? 'replace' : 'add', key, desired });
    }
    for (const key of liveDistantEntries.keys()) {
      if (!desiredEntries.has(key)) queue.push({ type: 'remove', key, desired: null });
    }
    queue.sort((left, right) => {
      const rank = work => {
        if (work.type === 'bucket') return work.required ? 0 : 1;
        if (work.type === 'remove') return 4;
        return work.key.startsWith('bucket:') ? 2 : 3;
      };
      return rank(left) - rank(right) || left.key.localeCompare(right.key);
    });
    const stagingRoot = generation.root;
    generation.buildOriginChunkX = displayPrevious.buildOriginChunkX;
    generation.buildOriginChunkZ = displayPrevious.buildOriginChunkZ;
    positionGenerationForOrigin(generation, committedRenderOrigin);
    generation.root = persistentDistantRoot;
    generation.naturalLodMaterials = new Map([
      ...(displayPrevious.naturalLodMaterials ?? new Map()),
      ...(generation.naturalLodMaterials ?? new Map()),
    ]);
    generation.localFullHandoffMaterials = new Map([
      ...(displayPrevious.localFullHandoffMaterials ?? new Map()),
      ...(generation.localFullHandoffMaterials ?? new Map()),
    ]);
    generation.remoteHorizonSilhouetteMaterial ??=
      displayPrevious.remoteHorizonSilhouetteMaterial;
    generation.horizonBuildingSilhouetteMaterial ??=
      displayPrevious.horizonBuildingSilhouetteMaterial;
    retiredDistantGenerations.add(displayPrevious);
    activeGeneration = generation;
    pendingDistantPublication = {
      generation,
      previous: displayPrevious,
      stagingRoot,
      queue,
    };
    if (queue.length === 0) completePersistentDistantPublication(pendingDistantPublication);
    return true;
  };
  const processDeferredGenerationDisposals = (
    budgetMs = STATIC_TREE_DISPOSE_BUDGET_MS,
    resourceLimit = Number.POSITIVE_INFINITY,
  ) => {
    const startedAt = monotonicNow();
    let disposedResources = 0;
    while (deferredGenerationDisposals.length
      && disposedResources < resourceLimit
      && monotonicNow() - startedAt < budgetMs) {
      const entry = deferredGenerationDisposals[0];
      if (entry.children.length) entry.children.pop().dispose?.();
      else if (entry.geometries.length) entry.geometries.pop().dispose?.();
      else if (entry.materials.length) entry.materials.pop().dispose?.();
      else {
        entry.rootToClear?.clear?.();
        entry.generation.ownedGeometries?.clear?.();
        entry.generation.ownedMaterials?.clear?.();
        deferredGenerationDisposals.shift();
        continue;
      }
      disposedResources += 1;
    }
    return disposedResources;
  };

  const readThroughLru = async (
    cache,
    key,
    capacity,
    load,
    onCacheEvent = null,
    pendingIdentity = null,
  ) => {
    if (cache.has(key)) {
      const entry = cache.get(key);
      if (!entry.pending || pendingIdentity === null
        || entry.pendingIdentity === pendingIdentity) {
        onCacheEvent?.('hit');
        cache.delete(key);
        cache.set(key, entry);
        return entry.promise;
      }
      // A superseded ChunkData subscriber resolves to null when its epoch is
      // cancelled. Never let a newer sync inherit that pending result.
      cache.delete(key);
    }
    onCacheEvent?.('miss');
    const entry = { pending: true, pendingIdentity, promise: null };
    entry.promise = Promise.resolve().then(load).then(
      value => {
        entry.pending = false;
        if (value == null && cache.get(key) === entry) cache.delete(key);
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
    const diagnosticStartedAt = diagnosticsEnabled ? monotonicNow() : 0;
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
    if (diagnosticsEnabled) recordDiagnosticWork('local-terrain-build', {
      calls: 1,
      owners: ownerIndexRanges.size,
      vertices: positions.length / 3,
      indices: initialIndices.length,
      allocatedBytes: (positions.length + colors.length + initialIndices.length) * 4,
      maximumSynchronousSliceMs: monotonicNow() - diagnosticStartedAt,
    });
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
      const diagnosticStartedAt = diagnosticsEnabled ? monotonicNow() : 0;
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
      if (diagnosticsEnabled) recordDiagnosticWork('local-terrain-index-handoff', {
        calls: 1,
        owners: visibleOwnerKeys.length,
        rebuiltIndices: visibleIndices.length,
        uploadBytes: visibleIndices.length * 4,
        maximumSynchronousSliceMs: monotonicNow() - diagnosticStartedAt,
      });
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
    canonicalSourceRevision: `${worldSeedHash}:${chunk.generatorVersion?.major ?? 'remote'}`,
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
    const persistentDistant = context.generation.persistentDistant === true
      && isPersistentDistantBucketName(name);
    if (!context.generation.canonicalBuckets.has(key)) {
      const persistentNatural = context.generation.persistentNatural === true
        || context.generation.persistentTree === true;
      context.generation.canonicalBuckets.set(key, {
        key,
        geometry,
        material,
        name,
        items: [],
        ...(persistentNatural || persistentDistant ? {
          capacity: persistentNatural
            ? resolvePersistentNaturalBucketCapacity({
              generation: context.generation,
              bucket: { geometry, material, name },
              requiredSlots: 1,
            })
            : PERSISTENT_DISTANT_BUCKET_CAPACITY,
          persistent: true,
        } : {}),
      });
    }
    const bucket = context.generation.canonicalBuckets.get(key);
    const item = {
      object,
      matrix: matrix.clone?.() ?? structuredClone(matrix),
      visibilityTiers,
    };
    bucket.items.push(item);
    if (context.generation.persistentNatural === true
      || context.generation.persistentTree === true || persistentDistant) {
      item.slot = bucket.items.length - 1;
      object.instances.push({ bucket, item });
      bucket.dirtySlots ??= new Set();
      bucket.dirtySlots.add(item.slot);
      context.generation.currentPageBuckets?.add?.(bucket);
    }
  };

  const registerCanonicalRecord = ({
    record,
    chunk,
    parts,
    farEligible,
    forestHorizonEligible = false,
    naturalHorizonOnly = false,
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
      existing.forestHorizonEligible ||= forestHorizonEligible;
      existing.naturalHorizonOnly &&= naturalHorizonOnly;
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
      naturalKind: naturalPresentationKind(record),
      naturalBlend: null,
      forestHorizonEligible,
      naturalHorizonOnly,
      farEligible,
      visibleLod: null,
      presentationTier: null,
      localBuildingHandoff: false,
      fullPresentationOpacity: 0,
      horizonPresentationOpacity: 0,
      remotePresentationOpacity: 0,
      instances: [],
    };
    context.generation.canonicalObjects.set(record.stableId, object);
    context.generation.currentPageStableIds?.push?.(record.stableId);
    context.stats.canonicalRecordCount += 1;
    if (record.remotePresentationOnly === true) {
      // Remote silhouettes have dedicated counters below and must not inflate
      // the canonical full-detail category counts.
    } else if (record.featureType === 'settlement-building') {
      context.stats.canonicalBuildingRecordCount += 1;
    } else if (object.naturalKind === W8_VEGETATION_LOD_KINDS.TREE) {
      context.stats.canonicalVegetationRecordCount += 1;
      context.stats.canonicalTreeRecordCount += 1;
    } else if (object.naturalKind === W8_VEGETATION_LOD_KINDS.BUSH) {
      context.stats.canonicalVegetationRecordCount += 1;
      context.stats.canonicalShrubRecordCount += 1;
    } else if (object.naturalKind === W8_VEGETATION_LOD_KINDS.GRASS) {
      context.stats.canonicalVegetationRecordCount += 1;
      context.stats.canonicalGrassRecordCount += 1;
    } else if (object.naturalKind === W8_VEGETATION_LOD_KINDS.ROCK) {
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

  const canonicalNaturalSilhouettePart = (record, parts, kind) => {
    if (kind === W8_VEGETATION_LOD_KINDS.TREE) {
      const geometry = record.subtype === 'conifer-tree' ? 'cone' : 'sphere';
      return parts.find(part => part.geometry === geometry)
        ?? parts.find(part => part.material !== 'treeTrunk')
        ?? parts[0]
        ?? null;
    }
    return parts[0] ?? null;
  };

  const scaledNaturalPart = (part, scale) => Object.freeze({
    ...part,
    position: part.position,
    rotation: part.rotation,
    scale: Object.freeze([
      part.scale[0] * scale,
      part.scale[1] * (0.94 + (scale - 1) * 0.35),
      part.scale[2] * scale,
    ]),
  });

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

  const addCanonicalRecord = ({
    record,
    chunk,
    origin,
    farEligible,
    forestHorizonEligible = false,
    naturalHorizonOnly = false,
    context,
  }) => {
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
    const registration = registerCanonicalRecord({
      record,
      chunk,
      parts,
      farEligible,
      forestHorizonEligible,
      naturalHorizonOnly,
      context,
    });
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
    const naturalKind = registration.object.naturalKind;
    if (naturalKind) {
      if (naturalHorizonOnly && (
        naturalKind !== W8_VEGETATION_LOD_KINDS.TREE || !forestHorizonEligible
      )) {
        throw new Error(`Forest horizon-only record is not an eligible Tree: ${record.stableId}`);
      }
      const naturalPolicy = resolveW8VegetationLodPolicy(
        naturalKind,
        context.generation.renderDistancePreset,
      );
      if (!naturalHorizonOnly) {
        for (const part of parts) {
          addCanonicalMatrix(
            registration.object,
            part.geometry,
            part.material,
            `natural-full-${naturalKind}`,
            canonicalPartMatrix(record, part, dimensions, origin),
            Object.freeze(['natural-lod']),
            context,
          );
        }
      }
      const silhouettePart = canonicalNaturalSilhouettePart(record, parts, naturalKind);
      if (!naturalHorizonOnly && silhouettePart && naturalPolicy.forestToAtmospheric) {
        addCanonicalMatrix(
          registration.object,
          silhouettePart.geometry,
          naturalKind === W8_VEGETATION_LOD_KINDS.ROCK
            ? silhouettePart.material : SHARED_NATURAL_SILHOUETTE_MATERIAL,
          `natural-forest-${naturalKind}`,
          canonicalPartMatrix(
            record,
            scaledNaturalPart(silhouettePart, naturalPolicy.forestScale),
            dimensions,
            origin,
          ),
          Object.freeze(['natural-lod']),
          context,
        );
      }
      if (!naturalHorizonOnly && silhouettePart) {
        addCanonicalMatrix(
          registration.object,
          silhouettePart.geometry,
          naturalKind === W8_VEGETATION_LOD_KINDS.ROCK
            ? silhouettePart.material : SHARED_NATURAL_SILHOUETTE_MATERIAL,
          `natural-atmospheric-${naturalKind}`,
          canonicalPartMatrix(
            record,
            scaledNaturalPart(silhouettePart, naturalPolicy.atmosphericScale),
            dimensions,
            origin,
          ),
          Object.freeze(['natural-lod']),
          context,
        );
      }
      if (silhouettePart && forestHorizonEligible && naturalPolicy.horizonEntry) {
        addCanonicalMatrix(
          registration.object,
          silhouettePart.geometry,
          SHARED_NATURAL_SILHOUETTE_MATERIAL,
          `natural-horizon-${naturalKind}`,
          canonicalPartMatrix(
            record,
            scaledNaturalPart(silhouettePart, naturalPolicy.horizonScale),
            dimensions,
            origin,
          ),
          Object.freeze(['natural-lod']),
          context,
        );
      }
      return;
    }
    for (const part of parts) {
      addCanonicalMatrix(
        registration.object,
        part.geometry,
        part.material,
        record.landmarkType ? 'landmark' : 'building',
        canonicalPartMatrix(record, part, dimensions, origin),
        undefined,
        context,
      );
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
    includeForestHorizon = false,
    naturalHorizonOnly = false,
    includeNearDetails = false,
    queryCenter = null,
    naturalQueryCenter = null,
    queryRadius = Infinity,
    naturalQueryRadius = Infinity,
    naturalDetailQueryRadius = Infinity,
    naturalKindFilter = null,
    context,
    scheduler,
  }) => {
    const layers = chunk.presentationLayers;
    if (includeNatural && context.generation.excludeNatural !== true) {
      const candidates = resolveW8CanonicalCandidateSet(chunk);
      for (const candidate of candidates.vegetation) {
        try {
          if (naturalHorizonOnly && candidate.subtype === 'shrub') continue;
          if (naturalQueryCenter && Math.hypot(
            candidate.worldPosition.x - naturalQueryCenter.x,
            candidate.worldPosition.z - naturalQueryCenter.z,
          ) > naturalQueryRadius) continue;
          const canonical = resolveW8CanonicalWorldObject(candidate);
          const candidateKind = naturalPresentationKind(canonical);
          if (naturalKindFilter && !naturalKindFilter.has(candidateKind)) continue;
          if (context.generation.excludeTreeNatural === true
            && candidateKind === W8_VEGETATION_LOD_KINDS.TREE) continue;
          if (context.generation.treeOnly === true
            && context.generation.naturalOnly !== true
            && candidateKind !== W8_VEGETATION_LOD_KINDS.TREE) continue;
          if (naturalHorizonOnly
            && naturalPresentationKind(canonical) !== W8_VEGETATION_LOD_KINDS.TREE) continue;
          if (includeForestHorizon && (
            canonical.owningChunkCoordinate.x !== chunk.chunkX
            || canonical.owningChunkCoordinate.z !== chunk.chunkZ
          )) {
            throw new Error(`Forest horizon Tree owner mismatch: ${canonical.stableId}`);
          }
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
            forestHorizonEligible: includeForestHorizon,
            naturalHorizonOnly,
            context,
          });
        } finally {
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
      for (const candidate of naturalHorizonOnly || (context.generation.treeOnly === true
        && context.generation.naturalOnly !== true)
        ? [] : candidates.rocks) {
        try {
          if (naturalKindFilter
            && !naturalKindFilter.has(W8_VEGETATION_LOD_KINDS.ROCK)) continue;
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
      for (const detail of naturalHorizonOnly || (context.generation.treeOnly === true
        && context.generation.naturalOnly !== true)
        ? [] : (layers?.ambientDetails ?? chunk.ambientDetails ?? [])) {
        try {
          if (!['grass', 'shrub'].includes(detail.detailType)) continue;
          const record = resolveW8CanonicalWorldObject(detail);
          const naturalKind = naturalPresentationKind(record);
          if (naturalKindFilter && !naturalKindFilter.has(naturalKind)) continue;
          const visibilityMeters = resolveW8VegetationLodPolicy(
            naturalKind,
            context.generation.renderDistancePreset,
          ).visibilityMeters;
          if (naturalQueryCenter && Math.hypot(
            record.worldPosition.x - naturalQueryCenter.x,
            record.worldPosition.z - naturalQueryCenter.z,
          ) > Math.min(naturalQueryRadius, visibilityMeters)) continue;
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
    if (context.generation.treeOnly === true || context.generation.naturalOnly === true) return;
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

  const configureLocalHandoffMaterial = (material, mode) => {
    const sourceTransparent = material.transparent === true;
    const sourceOpacity = Number.isFinite(material.opacity) ? material.opacity : 1;
    if (sourceTransparent) {
      material.transparent = true;
      material.alphaHash = false;
    } else {
      material.transparent = false;
      material.alphaHash = true;
      material.depthWrite = true;
    }
    material.opacity = sourceOpacity;
    material.userData = {
      ...(material.userData ?? {}),
      localBuildingHandoff: true,
      localBuildingHandoffMode: 'instance-opacity-shader',
      localBuildingHandoffTier: mode,
    };
    const previousOnBeforeCompile = material.onBeforeCompile;
    const previousProgramCacheKey = material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile = shader => {
      previousOnBeforeCompile?.call(material, shader);
      const vertexAnchor = '#include <begin_vertex>';
      const fragmentColor = '#include <color_fragment>';
      if (!shader.vertexShader.includes(vertexAnchor)
        || !shader.fragmentShader.includes(fragmentColor)) {
        throw new Error('local Building handoff shader chunks are unavailable');
      }
      shader.vertexShader = [
        'attribute float w8LocalHandoffOpacity;',
        'varying float vW8LocalHandoffOpacity;',
        shader.vertexShader,
      ].join('\n').replace(
        vertexAnchor,
        `${vertexAnchor}\nvW8LocalHandoffOpacity = w8LocalHandoffOpacity;`,
      );
      shader.fragmentShader = [
        'varying float vW8LocalHandoffOpacity;',
        shader.fragmentShader,
      ].join('\n').replace(
        fragmentColor,
        `${fragmentColor}\ndiffuseColor.a *= vW8LocalHandoffOpacity;`,
      );
    };
    material.customProgramCacheKey = () => [
      previousProgramCacheKey?.() ?? '',
      `w8-local-building-handoff-${mode}-v1`,
    ].join(':');
    return material;
  };

  const parseNaturalLodBucket = bucket => {
    const match = /^natural-(full|forest|atmospheric|horizon)-(tree|bush|grass|rock)$/
      .exec(bucket?.name ?? '');
    if (!match) return null;
    return Object.freeze({ mode: match[1], kind: match[2] });
  };

  const resolvePersistentNaturalBucketCapacity = ({
    generation,
    bucket,
    requiredSlots = 0,
  }) => {
    const naturalLod = parseNaturalLodBucket(bucket);
    if (!naturalLod) {
      throw new Error(`persistent Natural bucket is not a Natural LOD bucket: ${bucket?.name}`);
    }
    const coverage = generation?.naturalCapacityByKind?.get?.(naturalLod.kind) ?? null;
    if (!coverage) {
      // Compatibility for isolated presentation tests and the legacy Tree
      // adapter. Production Static Natural plans always supply policy coverage.
      return Math.max(PERSISTENT_DISTANT_BUCKET_CAPACITY, requiredSlots);
    }
    try {
      return resolveW8PersistentNaturalBucketCapacity({
        kind: naturalLod.kind,
        mode: naturalLod.mode,
        maximumCanonicalOwnerCount: coverage.maximumCanonicalOwnerCount,
        maximumManifestOwnerCount: coverage.maximumManifestOwnerCount,
        requiredSlots,
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new RangeError([
        `persistent Natural bucket capacity exceeded: ${bucket.geometry}:${bucket.material}:${bucket.name}`,
        error.message,
      ].join(' '), { cause: error });
    }
  };

  const isPersistentDistantBucketName = name => (
    /^natural-(full|forest|atmospheric|horizon)-(tree|bush|grass|rock)$/.test(name ?? '')
    || [
      'building',
      'horizon-building',
      'horizon-landmark',
      'remote-horizon-building',
      'remote-horizon-landmark',
    ].includes(name)
  );

  const treePathIdForBucket = (bucket, generation) => {
    const naturalLod = parseNaturalLodBucket(bucket);
    if (naturalLod?.kind !== W8_VEGETATION_LOD_KINDS.TREE) return null;
    if (naturalLod.mode === 'horizon') return TREE_RENDER_PATH.HORIZON;
    if (naturalLod.mode === 'atmospheric') return TREE_RENDER_PATH.ULTRA;
    return generation?.persistentTree === true
      ? TREE_RENDER_PATH.STATIC : TREE_RENDER_PATH.LEGACY;
  };

  const treePathIdsForGeneration = (generation, { visibleOnly = false } = {}) => {
    const result = new Set();
    for (const bucket of generation?.canonicalBuckets?.values?.() ?? []) {
      const pathId = bucket.mesh?.userData?.treePathId
        ?? treePathIdForBucket(bucket, generation);
      if (!pathId) continue;
      if (visibleOnly && (generation.root?.visible === false
        || bucket.mesh?.visible === false || !(bucket.mesh?.count > 0))) continue;
      result.add(pathId);
    }
    return result;
  };

  const createNaturalLodMaterial = ({
    mode, kind, sourceMaterial, materialKey, context,
  }) => {
    const sourceTinted = mode === 'full' || kind === W8_VEGETATION_LOD_KINDS.ROCK;
    const cacheKey = sourceTinted
      ? `${mode}:${kind}:${materialKey}` : `${mode}:${kind}`;
    const cached = context.generation.naturalLodMaterials.get(cacheKey);
    if (cached) return cached;
    let material;
    if (sourceTinted) {
      material = sourceMaterial?.clone?.();
      if (!material || material === sourceMaterial) {
        throw new Error('Natural LOD source-tinted tier requires a cloned shared material');
      }
    } else {
      material = new Material({
        color: mode === 'forest'
          ? W8_FOREST_SILHOUETTE_COLOR_HEX
          : W8_ATMOSPHERIC_VEGETATION_COLOR_HEX,
        flatShading: true,
        shininess: 0,
        fog: mode !== 'atmospheric' && mode !== 'horizon',
      });
    }
    const policy = resolveW8VegetationLodPolicy(
      kind,
      context.generation.renderDistancePreset,
    );
    const enter = mode === 'horizon'
      ? policy.horizonEntry
      : mode === 'forest'
      ? policy.fullToForest
      : mode === 'atmospheric'
        ? (policy.forestToAtmospheric ?? policy.fullToForest)
        : null;
    const exit = mode === 'horizon'
      ? policy.horizonFade
      : mode === 'full'
      ? policy.fullToForest
      : mode === 'forest' ? policy.forestToAtmospheric : policy.atmosphericFade;
    if (!exit) throw new Error(`Natural LOD ${kind}/${mode} has no exit policy`);
    const visibilityMeters = mode === 'horizon'
      ? policy.horizonVisibilityMeters : policy.visibilityMeters;
    const uniforms = {
      w8NaturalPlayerLocalXZ: { value: { x: 0, y: 0 } },
      w8NaturalUnitsPerMeter: { value: UNITS_PER_METER },
      w8NaturalEnterStart: { value: enter?.minimum ?? -1 },
      w8NaturalEnterEnd: { value: enter?.maximum ?? 0 },
      w8NaturalExitStart: { value: exit.minimum },
      w8NaturalExitEnd: { value: exit.maximum },
      w8NaturalFogColor: { value: new Color(W8_RENDER_FOG_COLOR_HEX) },
      w8NaturalFogBlendStart: {
        value: mode === 'horizon'
          ? policy.horizonEntry.minimum
          : policy.forestToAtmospheric?.minimum ?? policy.fullToForest.minimum,
      },
      w8NaturalVisibility: { value: visibilityMeters },
      w8NaturalReveal: { value: context.generation.naturalReveal },
    };
    material.transparent = false;
    material.alphaHash = true;
    material.depthWrite = true;
    material.fog = mode !== 'atmospheric' && mode !== 'horizon';
    material.opacity = Number.isFinite(material.opacity) ? material.opacity : 1;
    material.userData = {
      ...(material.userData ?? {}),
      naturalLod: true,
      naturalLodMode: mode,
      naturalLodKind: kind,
      naturalLodSourceTinted: sourceTinted,
      naturalLodDistanceSource: 'instance-anchor',
      naturalLodUniforms: uniforms,
    };
    const previousOnBeforeCompile = material.onBeforeCompile;
    const previousProgramCacheKey = material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile = shader => {
      previousOnBeforeCompile?.call(material, shader);
      Object.assign(shader.uniforms, uniforms);
      const vertexAnchor = '#include <begin_vertex>';
      const fragmentColor = '#include <color_fragment>';
      if (!shader.vertexShader.includes(vertexAnchor)
        || !shader.fragmentShader.includes(fragmentColor)) {
        throw new Error('Vegetation LOD shader chunks are unavailable');
      }
      shader.vertexShader = [
        'uniform vec2 w8NaturalPlayerLocalXZ;',
        'uniform float w8NaturalUnitsPerMeter;',
        'attribute vec2 w8NaturalAnchorXZ;',
        'attribute float w8NaturalInitialReveal;',
        'varying float vW8NaturalDistanceMeters;',
        'varying float vW8NaturalInitialReveal;',
        shader.vertexShader,
      ].join('\n').replace(
        vertexAnchor,
        `${vertexAnchor}\nvW8NaturalDistanceMeters = length(w8NaturalAnchorXZ - w8NaturalPlayerLocalXZ) / w8NaturalUnitsPerMeter;\nvW8NaturalInitialReveal = w8NaturalInitialReveal;`,
      );
      const entryExpression = mode === 'full'
        ? '1.0'
        : 'smoothstep(w8NaturalEnterStart, w8NaturalEnterEnd, vW8NaturalDistanceMeters)';
      shader.fragmentShader = [
        'uniform float w8NaturalEnterStart;',
        'uniform float w8NaturalEnterEnd;',
        'uniform float w8NaturalExitStart;',
        'uniform float w8NaturalExitEnd;',
        'uniform vec3 w8NaturalFogColor;',
        'uniform float w8NaturalFogBlendStart;',
        'uniform float w8NaturalVisibility;',
        'uniform float w8NaturalReveal;',
        'varying float vW8NaturalDistanceMeters;',
        'varying float vW8NaturalInitialReveal;',
        shader.fragmentShader,
      ].join('\n').replace(fragmentColor, [
        fragmentColor,
        `float w8NaturalEntry = ${entryExpression};`,
        'float w8NaturalExit = 1.0 - smoothstep(w8NaturalExitStart, w8NaturalExitEnd, vW8NaturalDistanceMeters);',
        'float w8NaturalStreamReveal = max(vW8NaturalInitialReveal, w8NaturalReveal);',
        'diffuseColor.a *= w8NaturalEntry * w8NaturalExit * w8NaturalStreamReveal;',
        ...(['atmospheric', 'horizon'].includes(mode) ? [
          'float w8NaturalFogBlend = 0.88 * smoothstep(w8NaturalFogBlendStart, w8NaturalVisibility, vW8NaturalDistanceMeters);',
          'diffuseColor.rgb = mix(diffuseColor.rgb, w8NaturalFogColor, w8NaturalFogBlend);',
        ] : []),
      ].join('\n'));
    };
    material.customProgramCacheKey = () => [
      previousProgramCacheKey?.() ?? '',
      `w8-natural-lod-${kind}-${mode}-v2`,
    ].join(':');
    context.generation.naturalLodMaterials.set(cacheKey, material);
    context.generation.ownedMaterials.add(material);
    return material;
  };

  const createHorizonSilhouetteMaterial = ({ handoff = false } = {}) => {
    const material = new Material({
      color: W8_SETTLEMENT_SILHOUETTE_COLOR_HEX,
      flatShading: true,
      shininess: 0,
    });
    return handoff ? configureLocalHandoffMaterial(material, 'horizon') : material;
  };

  const createRemoteHorizonSilhouetteMaterial = policy => {
    const uniforms = {
      w8RemotePlayerLocalXZ: { value: { x: 0, y: 0 } },
      w8RemoteFadeStart: { value: policy.fadeStartMeters },
      w8RemoteFogEnd: { value: policy.atmosphere.fogIntegrationEndMeters },
      w8RemoteFadeEnd: { value: policy.fadeEndMeters },
      w8RemoteHidden: { value: policy.hiddenDistanceMeters },
      w8RemoteFogEdgeBlend: { value: policy.atmosphere.fogEdgeBlend },
      w8RemoteFogEdgeOpacity: { value: policy.atmosphere.fogEdgeOpacity },
      w8RemoteMaximumFogBlend: { value: policy.atmosphere.maximumFogBlend },
      w8RemoteSilhouetteColor: {
        value: new Color(policy.atmosphere.silhouetteColorHex),
      },
      w8RemoteFogColor: {
        value: new Color(policy.atmosphere.fogColorHex),
      },
      w8RemoteUnitsPerMeter: { value: UNITS_PER_METER },
    };
    const material = new Material({
      color: 0xffffff,
      flatShading: true,
      shininess: 0,
      fog: false,
      transparent: false,
      alphaHash: true,
      opacity: 1,
      depthWrite: true,
    });
    material.userData = {
      ...(material.userData ?? {}),
      remoteBuildingAtmosphere: true,
      remoteBuildingAtmosphereMode: 'instance-anchor-shader',
      remoteAtmosphereUniforms: uniforms,
    };
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      const vertexAnchor = '#include <begin_vertex>';
      const fragmentColor = '#include <color_fragment>';
      if (!shader.vertexShader.includes(vertexAnchor)
        || !shader.fragmentShader.includes(fragmentColor)) {
        throw new Error('remote Settlement atmosphere shader chunks are unavailable');
      }
      shader.vertexShader = [
        'uniform vec2 w8RemotePlayerLocalXZ;',
        'uniform float w8RemoteUnitsPerMeter;',
        'attribute vec2 w8RemoteAnchorXZ;',
        'varying float vW8RemoteDistanceMeters;',
        shader.vertexShader,
      ].join('\n').replace(
        vertexAnchor,
        `${vertexAnchor}\nvW8RemoteDistanceMeters = length(w8RemoteAnchorXZ - w8RemotePlayerLocalXZ) / w8RemoteUnitsPerMeter;`,
      );
      shader.fragmentShader = [
        'uniform float w8RemoteFadeStart;',
        'uniform float w8RemoteFogEnd;',
        'uniform float w8RemoteFadeEnd;',
        'uniform float w8RemoteHidden;',
        'uniform float w8RemoteFogEdgeBlend;',
        'uniform float w8RemoteFogEdgeOpacity;',
        'uniform float w8RemoteMaximumFogBlend;',
        'uniform vec3 w8RemoteSilhouetteColor;',
        'uniform vec3 w8RemoteFogColor;',
        'varying float vW8RemoteDistanceMeters;',
        shader.fragmentShader,
      ].join('\n').replace(fragmentColor, [
        fragmentColor,
        'float w8RemoteFogProgress = smoothstep(w8RemoteFadeStart, w8RemoteFogEnd, vW8RemoteDistanceMeters);',
        'float w8RemoteHorizonProgress = smoothstep(w8RemoteFogEnd, w8RemoteFadeEnd, vW8RemoteDistanceMeters);',
        'float w8RemoteFogBlend = w8RemoteFogEdgeBlend * w8RemoteFogProgress;',
        'float w8RemoteOpacity = 1.0 - (1.0 - w8RemoteFogEdgeOpacity) * w8RemoteFogProgress;',
        'if (vW8RemoteDistanceMeters > w8RemoteFogEnd) {',
        '  w8RemoteFogBlend = mix(w8RemoteFogEdgeBlend, w8RemoteMaximumFogBlend, w8RemoteHorizonProgress);',
        '  w8RemoteOpacity = w8RemoteFogEdgeOpacity * (1.0 - w8RemoteHorizonProgress);',
        '}',
        'if (vW8RemoteDistanceMeters >= w8RemoteHidden) w8RemoteOpacity = 0.0;',
        'diffuseColor.rgb = mix(w8RemoteSilhouetteColor, w8RemoteFogColor, w8RemoteFogBlend);',
        'diffuseColor.a *= w8RemoteOpacity;',
      ].join('\n'));
    };
    material.customProgramCacheKey = () => 'w8-remote-building-atmosphere-v1';
    return material;
  };

  const createRemoteHorizonGeometry = (sourceGeometry, bucket, context) => {
    const InstancedBufferAttribute = THREE.InstancedBufferAttribute;
    const geometry = sourceGeometry?.clone?.();
    if (!geometry || geometry === sourceGeometry
      || typeof geometry.setAttribute !== 'function'
      || typeof InstancedBufferAttribute !== 'function') {
      throw new Error('remote Settlement atmosphere requires cloned instanced geometry');
    }
    const anchorAttribute = new InstancedBufferAttribute(
      new Float32Array((bucket.capacity ?? bucket.items.length) * 2),
      2,
    );
    geometry.setAttribute('w8RemoteAnchorXZ', anchorAttribute);
    bucket.remoteAnchorAttribute = anchorAttribute;
    context.generation.ownedGeometries.add(geometry);
    return geometry;
  };

  const createLocalHandoffGeometry = (sourceGeometry, bucket, context) => {
    const InstancedBufferAttribute = THREE.InstancedBufferAttribute;
    const geometry = sourceGeometry?.clone?.();
    if (!geometry || geometry === sourceGeometry
      || typeof geometry.setAttribute !== 'function'
      || typeof InstancedBufferAttribute !== 'function') {
      throw new Error('local Building handoff requires cloned instanced geometry');
    }
    const opacityAttribute = new InstancedBufferAttribute(
      new Float32Array(bucket.capacity ?? bucket.items.length),
      1,
    );
    geometry.setAttribute('w8LocalHandoffOpacity', opacityAttribute);
    bucket.localHandoffOpacityAttribute = opacityAttribute;
    context.generation.ownedGeometries.add(geometry);
    return geometry;
  };

  const createNaturalLodGeometry = (sourceGeometry, bucket, context) => {
    const InstancedBufferAttribute = THREE.InstancedBufferAttribute;
    const geometry = sourceGeometry?.clone?.();
    if (!geometry || geometry === sourceGeometry
      || typeof geometry.setAttribute !== 'function'
      || typeof InstancedBufferAttribute !== 'function') {
      throw new Error('Vegetation LOD requires cloned instanced geometry');
    }
    const anchorAttribute = new InstancedBufferAttribute(
      new Float32Array((bucket.capacity ?? bucket.items.length) * 2),
      2,
    );
    const initialRevealAttribute = new InstancedBufferAttribute(
      new Float32Array(bucket.capacity ?? bucket.items.length),
      1,
    );
    geometry.setAttribute('w8NaturalAnchorXZ', anchorAttribute);
    geometry.setAttribute('w8NaturalInitialReveal', initialRevealAttribute);
    bucket.naturalAnchorAttribute = anchorAttribute;
    bucket.naturalInitialRevealAttribute = initialRevealAttribute;
    context.generation.ownedGeometries.add(geometry);
    return geometry;
  };

  const localFullHandoffMaterial = (sourceMaterial, context) => {
    const cached = context.generation.localFullHandoffMaterials.get(sourceMaterial);
    if (cached) return cached;
    const material = sourceMaterial?.clone?.();
    if (!material || material === sourceMaterial) {
      throw new Error('local Building handoff requires a cloned source material');
    }
    configureLocalHandoffMaterial(material, 'full');
    context.generation.localFullHandoffMaterials.set(sourceMaterial, material);
    context.generation.ownedMaterials.add(material);
    return material;
  };

  const prepareCanonicalBucketMesh = (bucket, context) => {
    if (!bucket.items.length) return null;
    const persistentEntryKey = `bucket:${bucket.key
      ?? `${bucket.geometry}:${bucket.material}:${bucket.name}`}`;
    const reusableEntry = context.generation.persistentDistant === true
      && persistentDistantRoot
      && isPersistentDistantBucketName(bucket.name)
      ? liveDistantEntries.get(persistentEntryKey) ?? null
      : null;
    if (reusableEntry?.bucket?.mesh
      && bucket.items.length <= (reusableEntry.bucket.capacity ?? reusableEntry.mesh.capacity)) {
      bucket.capacity = reusableEntry.bucket.capacity ?? reusableEntry.mesh.capacity;
      bucket.persistent = true;
      bucket.persistentReuseEntryKey = persistentEntryKey;
      bucket.naturalLod = reusableEntry.bucket.naturalLod ?? parseNaturalLodBucket(bucket);
      return { mesh: null, roadBucketStartedAt: null, persistentReuse: true };
    }
    const roadBucketStartedAt = bucket.geometry === '__road__' ? monotonicNow() : null;
    let geometry = bucket.geometry === '__road__'
      ? roadGeometry : visualAssets.geometries[bucket.geometry];
    const sourceMaterial = visualAssets.materials[bucket.material];
    const localHorizon = bucket.name === 'horizon-building'
      || bucket.name === 'horizon-landmark';
    const localBuildingHandoff = bucket.name === 'building'
      || bucket.name === 'horizon-building';
    const remoteHorizon = bucket.name === 'remote-horizon-building'
      || bucket.name === 'remote-horizon-landmark';
    const naturalLod = parseNaturalLodBucket(bucket);
    const generatedMaterial = localHorizon || remoteHorizon || (
      naturalLod && naturalLod.mode !== 'full'
        && naturalLod.kind !== W8_VEGETATION_LOD_KINDS.ROCK
    );
    if (!geometry || (!sourceMaterial && !generatedMaterial)) {
      throw new Error(`canonical finite visual resource is missing: ${bucket.geometry}/${bucket.material}`);
    }
    let material = sourceMaterial;
    if (localHorizon) {
      if (bucket.name === 'horizon-building') {
        material = context.generation.horizonBuildingSilhouetteMaterial
          ?? createHorizonSilhouetteMaterial({ handoff: true });
        context.generation.horizonBuildingSilhouetteMaterial = material;
      } else {
        material = context.generation.horizonSilhouetteMaterial
          ?? createHorizonSilhouetteMaterial();
        context.generation.horizonSilhouetteMaterial = material;
      }
      context.generation.ownedMaterials.add(material);
    } else if (remoteHorizon) {
      material = context.generation.remoteHorizonSilhouetteMaterial;
      if (!material) {
        material = createRemoteHorizonSilhouetteMaterial(
          context.generation.settlementPresentationPolicy.remote,
        );
        context.generation.remoteHorizonSilhouetteMaterial = material;
        context.generation.ownedMaterials.add(material);
      }
      geometry = createRemoteHorizonGeometry(geometry, bucket, context);
    }
    if (naturalLod) {
      material = createNaturalLodMaterial({
        ...naturalLod,
        sourceMaterial,
        materialKey: bucket.material,
        context,
      });
      geometry = createNaturalLodGeometry(geometry, bucket, context);
      bucket.naturalLod = naturalLod;
    }
    if (localBuildingHandoff) {
      if (bucket.name === 'building') {
        material = localFullHandoffMaterial(sourceMaterial, context);
      }
      geometry = createLocalHandoffGeometry(geometry, bucket, context);
    }
    const mesh = new InstancedMesh(geometry, material, bucket.capacity ?? bucket.items.length);
    mesh.name = `w8-canonical-lod-${bucket.name}-${bucket.geometry}-${bucket.material}`;
    mesh.count = 0;
    mesh.visible = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData = {
      presentationOnly: true,
      treePathId: treePathIdForBucket(bucket, context.generation),
      treePathMode: naturalLod?.mode ?? null,
      canonicalStableIds: [],
      canonicalObjects: [],
      canonicalOpacities: [],
      remoteSettlementIds: [],
    };
    return { mesh, roadBucketStartedAt };
  };

  const completeCanonicalBucketMesh = (bucket, context, prepared) => {
    if (prepared.persistentReuse === true) return;
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
        if (!item.object.instances.some(instance => instance.item === item)) {
          item.object.instances.push({ bucket, item });
        }
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

  const remoteAnchorValues = bucket => (
    bucket.remoteAnchorAttribute?.array ?? bucket.remoteAnchorAttribute?.values ?? null
  );

  const writeRemoteBuildingAnchor = (bucket, index, object, generation) => {
    const values = remoteAnchorValues(bucket);
    if (!values) return;
    values[index * 2] = (
      object.worldX - generation.buildOriginChunkX * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
    values[index * 2 + 1] = (
      object.worldZ - generation.buildOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
  };

  const finishRemoteBuildingAnchorWrite = (bucket, mesh, canonicalObjects) => {
    if (!remoteAnchorValues(bucket)) return;
    bucket.remoteAnchorAttribute.needsUpdate = true;
    // setMatrixAt() does not invalidate InstancedMesh bounds in Three r160.
    // Force the renderer to derive bounds from the newly compacted instances.
    mesh.boundingBox = null;
    mesh.boundingSphere = null;
    mesh.userData.remoteSettlementIds = Object.freeze([...new Set(canonicalObjects
      .map(record => record.settlementId ?? record.parentSettlementId)
      .filter(Boolean))].sort((left, right) => left.localeCompare(right)));
  };

  const naturalAnchorValues = bucket => (
    bucket.naturalAnchorAttribute?.array ?? bucket.naturalAnchorAttribute?.values ?? null
  );

  const writeNaturalAnchor = (bucket, index, object, generation) => {
    const values = naturalAnchorValues(bucket);
    if (!values) return;
    values[index * 2] = (
      object.worldX - generation.buildOriginChunkX * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
    values[index * 2 + 1] = (
      object.worldZ - generation.buildOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
  };

  const finishNaturalAnchorWrite = (bucket, mesh) => {
    if (!naturalAnchorValues(bucket)) return;
    bucket.naturalAnchorAttribute.needsUpdate = true;
    mesh.boundingBox = null;
    mesh.boundingSphere = null;
  };

  const naturalInitialRevealValues = bucket => (
    bucket.naturalInitialRevealAttribute?.array
      ?? bucket.naturalInitialRevealAttribute?.values
      ?? null
  );

  const writeNaturalInitialReveal = (bucket, index, object, generation) => {
    const values = naturalInitialRevealValues(bucket);
    if (!values) return;
    values[index] = generation.naturalRevealInitialByStableId?.get(object.stableId) ?? 0;
  };

  const finishNaturalInitialRevealWrite = bucket => {
    if (!naturalInitialRevealValues(bucket)) return;
    bucket.naturalInitialRevealAttribute.needsUpdate = true;
  };

  const localHandoffOpacityValues = bucket => (
    bucket.localHandoffOpacityAttribute?.array
      ?? bucket.localHandoffOpacityAttribute?.values
      ?? null
  );

  const canonicalInstanceOpacity = (object, item) => {
    if (item.visibilityTiers.includes('remote-horizon')) {
      return object.presentationTier === 'remote-horizon'
        ? object.remotePresentationOpacity : 0;
    }
    if (object.localBuildingHandoff) {
      if (item.visibilityTiers.includes('horizon')) {
        return object.horizonPresentationOpacity;
      }
      if (item.visibilityTiers.includes('full')) return object.fullPresentationOpacity;
    }
    if (object.naturalKind && item.visibilityTiers.includes('natural-lod')) {
      return object.presentationTier === 'natural-lod' ? 1 : 0;
    }
    return object.presentationTier && item.visibilityTiers.includes(object.presentationTier)
      ? 1 : 0;
  };

  const hiddenCanonicalMatrix = () => {
    transform.position.set(0, 0, 0);
    transform.rotation.set(0, 0, 0);
    transform.scale.set(0, 0, 0);
    transform.updateMatrix();
    return transform.matrix.clone?.() ?? structuredClone(transform.matrix);
  };

  const writeLocalHandoffOpacity = (bucket, index, opacity) => {
    const values = localHandoffOpacityValues(bucket);
    if (values) values[index] = opacity;
  };

  const finishLocalHandoffOpacityWrite = bucket => {
    if (!localHandoffOpacityValues(bucket)) return;
    bucket.localHandoffOpacityAttribute.needsUpdate = true;
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
    const nearVisibleStableIds = generation.nearVisibleStableIds ?? new Set();
    const duplicates = [...distantVisibleStableIds]
      .filter(stableId => nearVisibleStableIds.has(stableId))
      .sort((left, right) => left.localeCompare(right));
    generation.stats.duplicateVisibleStableIds = Object.freeze(duplicates);
    generation.stats.duplicateVisibleStableIdCount = duplicates.length;
    generation.distantVisibleStableIds = distantVisibleStableIds;
    return Object.freeze({ buckets: composed, matrices: matrixUpdates });
  };

  const composeCanonicalBucket = (generation, bucket) => {
    const nearStableIds = generation.nearVisibleStableIds ?? new Set();
    const mesh = bucket.mesh;
    if (!mesh) return Object.freeze({ composed: 0, matrices: 0, attributes: 0 });
    if (generation.persistentDistant === true && bucket.persistent === true) {
      const hidden = hiddenCanonicalMatrix();
      const stableIds = [];
      const canonicalObjects = [];
      const canonicalOpacities = [];
      let visibleCount = 0;
      for (let slot = 0; slot < bucket.items.length; slot += 1) {
        const item = bucket.items[slot];
        if (!item) continue;
        item.slot = slot;
        const opacity = canonicalInstanceOpacity(item.object, item);
        const visible = ['mid', 'far'].includes(item.object.visibleLod)
          && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
          && opacity > 0;
        mesh.setMatrixAt(slot, visible ? item.matrix : hidden);
        writeRemoteBuildingAnchor(bucket, slot, item.object, generation);
        writeNaturalAnchor(bucket, slot, item.object, generation);
        writeNaturalInitialReveal(bucket, slot, item.object, generation);
        writeLocalHandoffOpacity(bucket, slot, visible ? opacity : 0);
        stableIds[slot] = visible ? item.object.stableId : null;
        canonicalObjects[slot] = visible ? item.object.record : null;
        canonicalOpacities[slot] = visible ? opacity : 0;
        visibleCount += Number(visible);
      }
      mesh.count = bucket.items.length;
      mesh.userData.canonicalStableIds = stableIds;
      mesh.userData.canonicalObjects = canonicalObjects;
      mesh.userData.canonicalOpacities = canonicalOpacities;
      mesh.userData.visibleInstanceCount = visibleCount;
      bucket.dirtySlots?.clear?.();
      finishRemoteBuildingAnchorWrite(bucket, mesh, canonicalObjects.filter(Boolean));
      finishNaturalAnchorWrite(bucket, mesh);
      finishNaturalInitialRevealWrite(bucket);
      finishLocalHandoffOpacityWrite(bucket);
      mesh.instanceMatrix.needsUpdate = true;
      return Object.freeze({
        composed: 1,
        matrices: bucket.items.length,
        attributes: Number(Boolean(mesh.instanceMatrix))
          + Number(Boolean(bucket.remoteAnchorAttribute))
          + Number(Boolean(bucket.naturalAnchorAttribute))
          + Number(Boolean(bucket.naturalInitialRevealAttribute))
          + Number(Boolean(bucket.localHandoffOpacityAttribute)),
      });
    }
    const roadBucketStartedAt = bucket.geometry === '__road__' ? monotonicNow() : null;
    let count = 0;
    const stableIds = [];
    const canonicalObjects = [];
    const canonicalOpacities = [];
    for (const item of bucket.items) {
      const opacity = canonicalInstanceOpacity(item.object, item);
      if (!['mid', 'far'].includes(item.object.visibleLod)
        || (item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
        || !(opacity > 0)) continue;
      mesh.setMatrixAt(count, item.matrix);
      writeRemoteBuildingAnchor(bucket, count, item.object, generation);
      writeNaturalAnchor(bucket, count, item.object, generation);
      writeNaturalInitialReveal(bucket, count, item.object, generation);
      writeLocalHandoffOpacity(bucket, count, opacity);
      stableIds.push(item.object.stableId);
      canonicalObjects.push(item.object.record);
      canonicalOpacities.push(opacity);
      count += 1;
    }
    mesh.count = count;
    mesh.userData.canonicalStableIds = stableIds;
    mesh.userData.canonicalObjects = canonicalObjects;
    mesh.userData.canonicalOpacities = canonicalOpacities;
    finishRemoteBuildingAnchorWrite(bucket, mesh, canonicalObjects);
    finishNaturalAnchorWrite(bucket, mesh);
    finishNaturalInitialRevealWrite(bucket);
    finishLocalHandoffOpacityWrite(bucket);
    mesh.instanceMatrix.needsUpdate = true;
    if (roadBucketStartedAt !== null) {
      generation.stats.canonicalRoadMatrixComposeMs += monotonicNow() - roadBucketStartedAt;
    }
    return Object.freeze({
      composed: 1,
      matrices: count,
      attributes: Number(Boolean(mesh.instanceMatrix))
        + Number(Boolean(bucket.remoteAnchorAttribute))
        + Number(Boolean(bucket.naturalAnchorAttribute))
        + Number(Boolean(bucket.naturalInitialRevealAttribute))
        + Number(Boolean(bucket.localHandoffOpacityAttribute)),
    });
  };

  const createCanonicalBucketComposeWork = (generation, bucket) => ({
    generation,
    bucket,
    slots: generation.persistentDistant === true && bucket.persistent === true
      ? [...(bucket.dirtySlots ?? [])].sort((left, right) => left - right)
      : null,
    index: 0,
    count: 0,
    stableIds: [],
    canonicalObjects: [],
    canonicalOpacities: [],
    matrices: 0,
    startedAtMs: monotonicNow(),
  });

  const advanceCanonicalBucketComposeWork = (
    work,
    {
      budgetStartedAtMs,
      budgetMs = RUNTIME_PRESENTATION_FRAME_BUDGET_MS,
      unitLimit = PRESENTATION_SLICE_UNIT_LIMIT,
    } = {},
  ) => {
    const { generation, bucket } = work;
    const mesh = bucket.mesh;
    if (!mesh) return Object.freeze({ done: true, matrices: 0, attributes: 0 });
    const nearStableIds = generation.nearVisibleStableIds ?? new Set();
    let frameMatrices = 0;
    let units = 0;
    if (work.slots) {
      const hidden = hiddenCanonicalMatrix();
      const processedSlots = [];
      while (work.index < work.slots.length
        && units < unitLimit
        && (units === 0 || monotonicNow() - budgetStartedAtMs < budgetMs)) {
        const slot = work.slots[work.index];
        const item = bucket.items[slot] ?? null;
        const opacity = item ? canonicalInstanceOpacity(item.object, item) : 0;
        const visible = item && ['mid', 'far'].includes(item.object.visibleLod)
          && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
          && opacity > 0;
        mesh.setMatrixAt(slot, visible ? item.matrix : hidden);
        if (item) {
          writeRemoteBuildingAnchor(bucket, slot, item.object, generation);
          writeNaturalAnchor(bucket, slot, item.object, generation);
          writeNaturalInitialReveal(bucket, slot, item.object, generation);
          writeLocalHandoffOpacity(bucket, slot, visible ? opacity : 0);
        }
        mesh.userData.canonicalStableIds[slot] = visible ? item.object.stableId : null;
        mesh.userData.canonicalObjects[slot] = visible ? item.object.record : null;
        mesh.userData.canonicalOpacities[slot] = visible ? opacity : 0;
        bucket.dirtySlots.delete(slot);
        processedSlots.push(slot);
        work.index += 1;
        work.matrices += 1;
        frameMatrices += 1;
        units += 1;
      }
      mesh.count = bucket.items.length;
      const matrixUpload = markAttributeRanges(mesh.instanceMatrix, processedSlots, 16);
      const remoteUpload = markAttributeRanges(bucket.remoteAnchorAttribute, processedSlots, 2);
      const anchorUpload = markAttributeRanges(bucket.naturalAnchorAttribute, processedSlots, 2);
      const revealUpload = markAttributeRanges(
        bucket.naturalInitialRevealAttribute,
        processedSlots,
        1,
      );
      const handoffUpload = markAttributeRanges(
        bucket.localHandoffOpacityAttribute,
        processedSlots,
        1,
      );
      const bufferUploads = [matrixUpload, remoteUpload, anchorUpload, revealUpload, handoffUpload]
        .filter(Boolean);
      const bytes = bufferUploads.reduce((sum, upload) => sum + upload.byteCount, 0);
      if (bytes > DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES) {
        distantPersistentOverBudgetUploadCount += 1;
        throw new RangeError('persistent Distant visibility upload exceeds frame budget');
      }
      if (processedSlots.length) {
        mesh.boundingBox = null;
        mesh.boundingSphere = null;
        distantPersistentBoundsRecalculationCount += 1;
        if (typeof mesh.computeBoundingSphere === 'function') {
          mesh.computeBoundingSphere();
        }
        distantPersistentUploadByteCount += bytes;
        distantPersistentMaximumUploadBytesPerFrame = Math.max(
          distantPersistentMaximumUploadBytesPerFrame,
          bytes,
        );
      }
      return Object.freeze({
        done: work.index >= work.slots.length,
        matrices: frameMatrices,
        attributes: bufferUploads.length,
        bytes,
      });
    }
    while (work.index < bucket.items.length
      && units < unitLimit
      && (units === 0 || monotonicNow() - budgetStartedAtMs < budgetMs)) {
      const item = bucket.items[work.index];
      const opacity = canonicalInstanceOpacity(item.object, item);
      if (['mid', 'far'].includes(item.object.visibleLod)
        && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
        && opacity > 0) {
        mesh.setMatrixAt(work.count, item.matrix);
        writeRemoteBuildingAnchor(bucket, work.count, item.object, generation);
        writeNaturalAnchor(bucket, work.count, item.object, generation);
        writeNaturalInitialReveal(bucket, work.count, item.object, generation);
        writeLocalHandoffOpacity(bucket, work.count, opacity);
        work.stableIds.push(item.object.stableId);
        work.canonicalObjects.push(item.object.record);
        work.canonicalOpacities.push(opacity);
        work.count += 1;
        work.matrices += 1;
        frameMatrices += 1;
      }
      work.index += 1;
      units += 1;
    }
    if (work.index < bucket.items.length) {
      return Object.freeze({ done: false, matrices: frameMatrices, attributes: 0 });
    }
    mesh.count = work.count;
    mesh.userData.canonicalStableIds = work.stableIds;
    mesh.userData.canonicalObjects = work.canonicalObjects;
    mesh.userData.canonicalOpacities = work.canonicalOpacities;
    finishRemoteBuildingAnchorWrite(bucket, mesh, work.canonicalObjects);
    finishNaturalAnchorWrite(bucket, mesh);
    finishNaturalInitialRevealWrite(bucket);
    finishLocalHandoffOpacityWrite(bucket);
    mesh.instanceMatrix.needsUpdate = true;
    if (bucket.geometry === '__road__') {
      generation.stats.canonicalRoadMatrixComposeMs += monotonicNow() - work.startedAtMs;
    }
    return Object.freeze({
      done: true,
      matrices: frameMatrices,
      attributes: Number(Boolean(mesh.instanceMatrix))
        + Number(Boolean(bucket.remoteAnchorAttribute))
        + Number(Boolean(bucket.naturalAnchorAttribute))
        + Number(Boolean(bucket.naturalInitialRevealAttribute))
        + Number(Boolean(bucket.localHandoffOpacityAttribute)),
    });
  };

  const composeCanonicalMeshes = (generation, dirtyBuckets = generation.canonicalBuckets) => {
    let composed = 0;
    let matrixUpdates = 0;
    for (const bucket of dirtyBuckets.values()) {
      const result = composeCanonicalBucket(generation, bucket);
      composed += result.composed;
      matrixUpdates += result.matrices;
    }
    return finishCanonicalCompose(generation, composed, matrixUpdates);
  };

  const processPersistentDistantVisibility = (generation, budgetMs) => {
    if (!generation?.persistentDistant || !(budgetMs > 0)) return null;
    const bucket = [...generation.canonicalBuckets.values()].find(candidate => (
      candidate.persistent === true && candidate.mesh && candidate.dirtySlots?.size > 0
    ));
    if (!bucket) return null;
    const startedAt = monotonicNow();
    const work = createCanonicalBucketComposeWork(generation, bucket);
    const result = advanceCanonicalBucketComposeWork(work, {
      budgetStartedAtMs: startedAt,
      budgetMs,
      unitLimit: PRESENTATION_SLICE_UNIT_LIMIT,
    });
    finishCanonicalCompose(generation, Number(result.matrices > 0), result.matrices);
    distantPersistentMaximumSliceMs = Math.max(
      distantPersistentMaximumSliceMs,
      monotonicNow() - startedAt,
    );
    return result;
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
      if (generation.persistentDistant === true && bucket.persistent === true) {
        const hidden = hiddenCanonicalMatrix();
        const stableIds = [];
        const canonicalObjects = [];
        const canonicalOpacities = [];
        let visibleCount = 0;
        for (let slot = 0; slot < bucket.items.length; slot += 1) {
          const item = bucket.items[slot];
          if (!item) continue;
          item.slot = slot;
          const opacity = canonicalInstanceOpacity(item.object, item);
          const visible = ['mid', 'far'].includes(item.object.visibleLod)
            && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
            && opacity > 0;
          mesh.setMatrixAt(slot, visible ? item.matrix : hidden);
          writeRemoteBuildingAnchor(bucket, slot, item.object, generation);
          writeNaturalAnchor(bucket, slot, item.object, generation);
          writeNaturalInitialReveal(bucket, slot, item.object, generation);
          writeLocalHandoffOpacity(bucket, slot, visible ? opacity : 0);
          stableIds[slot] = visible ? item.object.stableId : null;
          canonicalObjects[slot] = visible ? item.object.record : null;
          canonicalOpacities[slot] = visible ? opacity : 0;
          visibleCount += Number(visible);
          matrixUpdates += 1;
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
        mesh.count = bucket.items.length;
        mesh.userData.canonicalStableIds = stableIds;
        mesh.userData.canonicalObjects = canonicalObjects;
        mesh.userData.canonicalOpacities = canonicalOpacities;
        mesh.userData.visibleInstanceCount = visibleCount;
        bucket.dirtySlots?.clear?.();
        finishRemoteBuildingAnchorWrite(bucket, mesh, canonicalObjects.filter(Boolean));
        finishNaturalAnchorWrite(bucket, mesh);
        finishNaturalInitialRevealWrite(bucket);
        finishLocalHandoffOpacityWrite(bucket);
        mesh.instanceMatrix.needsUpdate = true;
        composed += 1;
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
        continue;
      }
      const roadBucketStartedAt = bucket.geometry === '__road__' ? monotonicNow() : null;
      let count = 0;
      const stableIds = [];
      const canonicalObjects = [];
      const canonicalOpacities = [];
      for (const item of bucket.items) {
        const opacity = canonicalInstanceOpacity(item.object, item);
        if (['mid', 'far'].includes(item.object.visibleLod)
          && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
          && opacity > 0) {
          mesh.setMatrixAt(count, item.matrix);
          writeRemoteBuildingAnchor(bucket, count, item.object, generation);
          writeNaturalAnchor(bucket, count, item.object, generation);
          writeNaturalInitialReveal(bucket, count, item.object, generation);
          writeLocalHandoffOpacity(bucket, count, opacity);
          matrixUpdates += 1;
          stableIds.push(item.object.stableId);
          canonicalObjects.push(item.object.record);
          canonicalOpacities.push(opacity);
          count += 1;
        }
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
      mesh.count = count;
      mesh.userData.canonicalStableIds = stableIds;
      mesh.userData.canonicalObjects = canonicalObjects;
      mesh.userData.canonicalOpacities = canonicalOpacities;
      finishRemoteBuildingAnchorWrite(bucket, mesh, canonicalObjects);
      finishNaturalAnchorWrite(bucket, mesh);
      finishNaturalInitialRevealWrite(bucket);
      finishLocalHandoffOpacityWrite(bucket);
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
        const ringMeters = resolveW8VegetationLodPolicy(
          W8_VEGETATION_LOD_KINDS.TREE,
          generation.renderDistancePreset,
        ).atmosphericFade.maximum;
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
      const counts = new Map(entry.overlays.map(overlay => [overlay.tier, 0]));
      for (const item of entry.bucket.items) {
        if (!['mid', 'far'].includes(item.object.visibleLod)
          || item.object.presentationTier !== 'natural-lod') continue;
        const tier = item.object.naturalBlend?.dominantTier;
        const overlay = entry.overlays.find(value => value.tier === tier);
        if (!overlay) continue;
        const count = counts.get(tier);
        overlay.mesh.setMatrixAt(count, item.matrix);
        counts.set(tier, count + 1);
      }
      for (const overlay of entry.overlays) {
        overlay.mesh.count = counts.get(overlay.tier);
        overlay.mesh.instanceMatrix.needsUpdate = true;
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
      if (bucket.name !== 'natural-forest-tree' || !bucket.mesh) continue;
      const overlays = [
        Object.freeze({ tier: 'full', color: 0xffe600, renderOrder: 10_000 }),
        Object.freeze({ tier: 'forest', color: 0x168bff, renderOrder: 10_001 }),
        Object.freeze({ tier: 'atmospheric', color: 0xb269ff, renderOrder: 10_002 }),
      ].map(({ tier, color, renderOrder }) => {
        const material = new DiagnosticMaterial({
          color, transparent: true, opacity: 0.94, depthTest: false, depthWrite: false,
        });
        const mesh = new InstancedMesh(bucket.mesh.geometry, material, bucket.items.length);
        mesh.name = `w8-tree-lod-debug-${tier}-${bucket.geometry}`;
        mesh.userData = { presentationOnly: true, debugOnly: true, treeLodTier: tier };
        mesh.renderOrder = renderOrder;
        mesh.frustumCulled = false;
        rootDiagnostic.add(mesh);
        generation.ownedMaterials.add(material);
        return { tier, mesh };
      });
      entries.push({ bucket, overlays });
    }
    const ringGeometry = new BufferGeometry();
    const ringMaterial = new THREE.LineBasicMaterial({
      color: 0x28d7ff, transparent: true, opacity: 1, depthTest: false, depthWrite: false,
    });
    const ring = new LineSegments(ringGeometry, ringMaterial);
    const ringMeters = resolveW8VegetationLodPolicy(
      W8_VEGETATION_LOD_KINDS.TREE,
      generation.renderDistancePreset,
    ).atmosphericFade.maximum;
    ring.name = 'w8-tree-lod-debug-atmospheric-fade-ring';
    ring.userData = {
      presentationOnly: true,
      debugOnly: true,
      radiusMeters: ringMeters,
    };
    ring.renderOrder = 10_003;
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
      for (const overlay of entry.overlays) {
        overlay.mesh.material?.dispose?.();
        generation.ownedMaterials.delete(overlay.mesh.material);
      }
    }
    const ring = diagnostic.root.children?.find?.(child => (
      child.name === 'w8-tree-lod-debug-atmospheric-fade-ring'
    ));
    ring?.material?.dispose?.();
    generation.ownedMaterials.delete(ring?.material);
    diagnostic.ringGeometry.dispose?.();
    generation.ownedGeometries.delete(diagnostic.ringGeometry);
    diagnostic.root.clear?.();
    generation.treeLodDiagnostics = null;
  };

  const canonicalSettlementPresentationTier = (
    object,
    distanceMeters,
    quality,
    visible,
    localSettlementIds,
    settlementLod,
  ) => {
    if (!visible) return null;
    if (!isHorizonRecord(object.record)) return 'full';
    if (!localSettlementIds?.has(object.settlementId)) return 'full';
    if (distanceMeters >= settlementLod.visibilityMeters) return null;
    if (distanceMeters >= settlementLod.fadeStartMeters) {
      const fade = 1 - smoothstep((distanceMeters - settlementLod.fadeStartMeters)
        / (settlementLod.visibilityMeters - settlementLod.fadeStartMeters));
      const ditherRank = textHash(`${object.stableId}:w8-high-building-horizon-fade`) / 0x1_0000_0000;
      if (!(ditherRank < fade)) return null;
    }
    const horizonOpacity = resolveW8SettlementHandoffProgress(distanceMeters, settlementLod);
    object.localBuildingHandoff = object.record.featureType === 'settlement-building';
    object.fullPresentationOpacity = Math.round((1 - horizonOpacity) * 1e6) / 1e6;
    object.horizonPresentationOpacity = horizonOpacity;
    if (horizonOpacity <= 0) return 'full';
    if (object.fullPresentationOpacity <= 0) return 'horizon';
    return 'full-horizon-handoff';
  };

  const remoteSettlementPresentationTier = (
    object,
    buildingDistanceMeters,
    policy,
    visible,
  ) => {
    if (!visible || !object.remoteHorizon) {
      object.remotePresentationOpacity = 0;
      return null;
    }
    object.remotePresentationOpacity = resolveW8RemoteSettlementOpacityAtDistance(
      buildingDistanceMeters,
      policy,
    );
    if (object.remotePresentationOpacity <= 0) {
      return null;
    }
    return 'remote-horizon';
  };

  const canonicalBucketVisibilityKey = bucket => (
    `${bucket.name}:${bucket.geometry}:${bucket.material}`
  );

  const updateRemoteHorizonPlayerUniform = (generation, playerX, playerZ) => {
    const playerUniform = generation.remoteHorizonSilhouetteMaterial
      ?.userData?.remoteAtmosphereUniforms?.w8RemotePlayerLocalXZ?.value;
    if (!playerUniform) return;
    playerUniform.x = (
      playerX - generation.buildOriginChunkX * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
    playerUniform.y = (
      playerZ - generation.buildOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
  };

  const updateNaturalLodPlayerUniforms = (generation, playerX, playerZ) => {
    const localX = (
      playerX - generation.buildOriginChunkX * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
    const localZ = (
      playerZ - generation.buildOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
    if (generation.naturalReveal < 1 && generation.naturalRevealStartedAt !== null) {
      generation.naturalReveal = smoothstep(
        (monotonicNow() - generation.naturalRevealStartedAt) / NATURAL_STREAM_REVEAL_MS,
      );
    }
    for (const material of new Set(generation.naturalLodMaterials?.values?.() ?? [])) {
      const playerUniform = material.userData?.naturalLodUniforms
        ?.w8NaturalPlayerLocalXZ?.value;
      if (!playerUniform) continue;
      playerUniform.x = localX;
      playerUniform.y = localZ;
      material.userData.naturalLodUniforms.w8NaturalReveal.value = generation.naturalReveal;
    }
  };

  const naturalLodPolicyFor = (generation, kind) => {
    const cached = generation.naturalLodPolicies.get(kind);
    if (cached) return cached;
    const policy = resolveW8VegetationLodPolicy(kind, generation.renderDistancePreset);
    generation.naturalLodPolicies.set(kind, policy);
    return policy;
  };

  const updateCanonicalVisibility = (
    generation,
    playerX,
    playerZ,
    { compose = true, objectStableIds = null, updateStats = objectStableIds === null } = {},
  ) => {
    if (!generation) return;
    const diagnosticStartedAt = diagnosticsEnabled ? monotonicNow() : 0;
    const renderDistancePolicy = generation.renderDistancePolicy
      ?? resolveW8RenderDistancePolicy(generation.renderDistancePreset);
    const settlementPresentationPolicy = generation.settlementPresentationPolicy
      ?? resolveW8SettlementPresentationPolicy(
        generation.quality,
        generation.renderDistancePreset,
      );
    const remoteSettlementPolicy = settlementPresentationPolicy.remote;
    updateRemoteHorizonPlayerUniform(generation, playerX, playerZ);
    updateNaturalLodPlayerUniforms(generation, playerX, playerZ);
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
    let visibleGrassCount = 0;
    let visibleRockCount = 0;
    let visibleFullTreeCount = 0;
    let visibleSilhouetteTreeCount = 0;
    let visibleUltraTreeCount = 0;
    let visibleTreePartInstanceCount = 0;
    let visibleTreeMidBandCount = 0;
    let visibleTreeOuterBandCount = 0;
    let visibleTreeUltraInnerBandCount = 0;
    let visibleTreeUltraOuterBandCount = 0;
    let visibleNaturalCrossFadeCount = 0;
    let visibleForestInstanceCount = 0;
    let visibleAtmosphericInstanceCount = 0;
    let visibleForestHorizonInstanceCount = 0;
    let visibleHorizonBuildingCount = 0;
    let visibleHorizonLandmarkCount = 0;
    let visibleBuildingPartInstanceCount = 0;
    let visibleHorizonPartInstanceCount = 0;
    let destroyedHorizonBuildingCount = 0;
    const visibleRemoteSettlementIds = new Set();
    const activeOwners = new Set();
    const renderedOwners = new Set();
    const dirtyBuckets = new Map();
    const markObjectDirty = object => {
      for (const instance of object.instances) {
        dirtyBuckets.set(canonicalBucketVisibilityKey(instance.bucket), instance.bucket);
        if (instance.bucket.persistent === true && Number.isSafeInteger(instance.item.slot)) {
          instance.bucket.dirtySlots ??= new Set();
          instance.bucket.dirtySlots.add(instance.item.slot);
        }
      }
    };
    const nearVisibleState = readNearVisibleSnapshotState();
    const nearVisibleStableIds = nearVisibleState.stableIds;
    const selectedObjects = objectStableIds === null
      ? [...generation.canonicalObjects.values()]
      : objectStableIds.map(stableId => generation.canonicalObjects.get(stableId)).filter(Boolean);
    const nearVisibleSettlementIds = generation.persistentTree === true
      ? new Set()
      : new Set([...generation.canonicalObjects.values()]
        .filter(object => nearVisibleStableIds.has(object.stableId))
        .map(object => object.settlementId)
        .filter(Boolean));
    const nearStableSignature = nearVisibleState.signature;
    if (nearStableSignature !== generation.nearVisibleStableSignature) {
      if (generation.persistentTree === true) {
        const previousNear = generation.nearVisibleStableIds ?? new Set();
        for (const stableId of new Set([...previousNear, ...nearVisibleStableIds])) {
          if (previousNear.has(stableId) === nearVisibleStableIds.has(stableId)) continue;
          const object = generation.canonicalObjects.get(stableId);
          if (object) markObjectDirty(object);
        }
      } else {
        for (const object of generation.canonicalObjects.values()) {
          if (!object.remoteHorizon && !object.naturalKind) continue;
          markObjectDirty(object);
        }
      }
      generation.nearVisibleStableSignature = nearStableSignature;
    }
    generation.nearVisibleStableIds = nearVisibleStableIds;
    generation.nearVisibleSettlementIds = nearVisibleSettlementIds;
    for (const object of selectedObjects) {
      const previousFullOpacity = object.fullPresentationOpacity;
      const previousHorizonOpacity = object.horizonPresentationOpacity;
      const previousRemoteOpacity = object.remotePresentationOpacity;
      object.localBuildingHandoff = false;
      object.fullPresentationOpacity = 0;
      object.horizonPresentationOpacity = 0;
      object.remotePresentationOpacity = 0;
      let nextLod = 'hidden';
      const distanceMeters = Math.hypot(object.worldX - playerX, object.worldZ - playerZ);
      const naturalKind = object.naturalKind;
      const tree = naturalKind === W8_VEGETATION_LOD_KINDS.TREE;
      const bush = naturalKind === W8_VEGETATION_LOD_KINDS.BUSH;
      const grass = naturalKind === W8_VEGETATION_LOD_KINDS.GRASS;
      const rock = naturalKind === W8_VEGETATION_LOD_KINDS.ROCK;
      const natural = naturalKind !== null;
      const naturalLodPolicy = natural
        ? naturalLodPolicyFor(generation, naturalKind)
        : null;
      const policyVisibility = object.record.lodPolicy
        ? resolveW8ObjectVisibilityMeters(object.record, generation.renderDistancePreset)
        : null;
      const exactNaturalVisibility = natural
        ? Math.min(policyVisibility ?? naturalVisibility, naturalLodPolicy.visibilityMeters)
        : naturalVisibility;
      const objectNaturalVisibility = tree && object.forestHorizonEligible
        ? Math.max(exactNaturalVisibility, naturalLodPolicy.horizonVisibilityMeters ?? 0)
        : exactNaturalVisibility;
      const objectVisibility = policyVisibility ?? visibility;
      const insideNaturalVisibility = distanceMeters < objectNaturalVisibility;
      const remoteTier = remoteSettlementPresentationTier(
        object,
        distanceMeters,
        remoteSettlementPolicy,
        !nearVisibleStableIds.has(object.stableId),
      );
      const hasLocalPresentation = object.instances.some(instance => (
        instance.item.visibilityTiers.includes('full')
          || instance.item.visibilityTiers.includes('horizon')
          || instance.item.visibilityTiers.includes('natural-lod')
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
      object.naturalBlend = natural
        ? evaluateW8VegetationLodBlend(
          naturalLodPolicy,
          distanceMeters,
          object.naturalBlend ?? {},
        )
        : null;
      if (tree && object.naturalHorizonOnly) {
        object.naturalBlend.full = 0;
        object.naturalBlend.forest = 0;
        object.naturalBlend.atmospheric = 0;
        object.naturalBlend.totalOpacity = object.naturalBlend.horizon;
        object.naturalBlend.crossFade = false;
        object.naturalBlend.dominantTier = object.naturalBlend.horizon > 0
          ? 'horizon' : null;
        object.naturalBlend.visible = object.naturalBlend.horizon > 0
          && distanceMeters < naturalLodPolicy.horizonVisibilityMeters;
      } else if (tree && !object.forestHorizonEligible && object.naturalBlend.horizon > 0) {
        object.naturalBlend.horizon = 0;
        object.naturalBlend.totalOpacity = Math.round((
          object.naturalBlend.full
          + object.naturalBlend.forest
          + object.naturalBlend.atmospheric
        ) * 1e6) / 1e6;
        object.naturalBlend.crossFade = Number(object.naturalBlend.full > 0)
          + Number(object.naturalBlend.forest > 0)
          + Number(object.naturalBlend.atmospheric > 0) > 1;
        object.naturalBlend.visible = object.naturalBlend.totalOpacity > 0
          && distanceMeters < exactNaturalVisibility;
        if (object.naturalBlend.dominantTier === 'horizon') {
          object.naturalBlend.dominantTier = object.naturalBlend.atmospheric > 0
            ? 'atmospheric' : object.naturalBlend.forest > 0 ? 'forest'
              : object.naturalBlend.full > 0 ? 'full' : null;
        }
      }
      let presentationTier = natural
        ? (distantVisible && object.naturalBlend.visible ? 'natural-lod' : null)
        : canonicalSettlementPresentationTier(
          object,
          distanceMeters,
          generation.quality,
          distantVisible,
          generation.localSettlementIds,
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
        object.fullPresentationOpacity = presentationTier ? 1 : 0;
        object.horizonPresentationOpacity = 0;
        object.remotePresentationOpacity = 0;
      } else if (presentationTier !== 'remote-horizon') {
        object.remotePresentationOpacity = 0;
      }
      if ((natural || isHorizonRecord(object.record) || object.remoteHorizon)
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
      if ((nextLod === 'far' || nextLod === 'mid' || nextLod === 'near') && natural) {
        if (!rock) visibleVegetationCount += 1;
        if (tree) visibleTreeCount += 1;
        else if (bush) visibleShrubCount += 1;
        else if (grass) visibleGrassCount += 1;
        else if (rock) visibleRockCount += 1;
        if (distantVisible && object.naturalBlend.crossFade) {
          visibleNaturalCrossFadeCount += 1;
        }
        if (distantVisible && object.naturalBlend.forest > 0) {
          visibleForestInstanceCount += 1;
        }
        if (distantVisible && object.naturalBlend.atmospheric > 0) {
          visibleAtmosphericInstanceCount += 1;
        }
        if (distantVisible && object.naturalBlend.horizon > 0) {
          visibleForestHorizonInstanceCount += 1;
        }
        if (tree) {
          if (distantVisible
            && distanceMeters >= naturalLodPolicy.fullToForest.maximum
            && distanceMeters < naturalLodPolicy.forestToAtmospheric.minimum) {
            visibleTreeMidBandCount += 1;
          } else if (distantVisible
            && distanceMeters >= naturalLodPolicy.forestToAtmospheric.minimum
            && distanceMeters < naturalLodPolicy.forestToAtmospheric.maximum) {
            visibleTreeOuterBandCount += 1;
          } else if (distantVisible
            && distanceMeters >= naturalLodPolicy.forestToAtmospheric.maximum
            && distanceMeters < naturalLodPolicy.atmosphericFade.minimum) {
            visibleTreeUltraInnerBandCount += 1;
          } else if (distantVisible
            && distanceMeters >= naturalLodPolicy.atmosphericFade.minimum
            && distanceMeters < naturalLodPolicy.visibilityMeters) {
            visibleTreeUltraOuterBandCount += 1;
          }
          const dominantTier = nextLod === 'near'
            ? 'full' : object.naturalBlend.dominantTier;
          if (dominantTier === 'forest') visibleSilhouetteTreeCount += 1;
          else if (dominantTier === 'atmospheric' || dominantTier === 'horizon') {
            visibleUltraTreeCount += 1;
          }
          else visibleFullTreeCount += 1;
          visibleTreePartInstanceCount += nextLod === 'near'
            ? object.instances.filter(instance => instance.bucket.name === 'natural-full-tree').length
            : object.instances.length;
        }
      } else if ((isHorizonRecord(object.record) || object.remoteHorizon)
        && (nextLod === 'far' || nextLod === 'mid' || nextLod === 'near')) {
        if (presentationTier === 'full-horizon-handoff') {
          if (object.record.featureType === 'settlement-building') {
            visibleHorizonBuildingCount += 1;
          }
          visibleBuildingPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes('full')
          )).length;
          visibleHorizonPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes('horizon')
          )).length;
        } else if (presentationTier === 'horizon' || presentationTier === 'remote-horizon') {
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
      const opacityChanged = previousFullOpacity !== object.fullPresentationOpacity
        || previousHorizonOpacity !== object.horizonPresentationOpacity
        || previousRemoteOpacity !== object.remotePresentationOpacity;
      if (object.visibleLod === nextLod && object.presentationTier === presentationTier
        && !opacityChanged) continue;
      markObjectDirty(object);
      if (tree) {
        generation.treeVisibilityChangeCount =
          (generation.treeVisibilityChangeCount ?? 0) + 1;
      }
      object.visibleLod = nextLod;
      object.presentationTier = presentationTier;
    }
    generation.playerX = playerX;
    generation.playerZ = playerZ;
    if (updateStats) {
      generation.stats.remoteHorizonPartInstanceCount = 0;
      for (const object of generation.canonicalObjects.values()) {
        if (object.remoteHorizon && object.visibleLod === 'far'
          && object.presentationTier === 'remote-horizon') {
          generation.stats.remoteHorizonPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes('remote-horizon')
          )).length;
        }
      }
    }
    if (compose && dirtyBuckets.size && generation.persistentTree !== true
      && generation.persistentDistant !== true) {
      composeCanonicalMeshes(generation, dirtyBuckets);
    }
    if (updateStats) {
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
    generation.stats.visibleCanonicalGrassCount = visibleGrassCount;
    generation.stats.visibleCanonicalRockCount = visibleRockCount;
    generation.stats.visibleCanonicalFullTreeCount = visibleFullTreeCount;
    generation.stats.visibleCanonicalSilhouetteTreeCount = visibleSilhouetteTreeCount;
    generation.stats.visibleCanonicalUltraTreeCount = visibleUltraTreeCount;
    generation.stats.visibleCanonicalTreePartInstanceCount = visibleTreePartInstanceCount;
    generation.stats.visibleCanonicalTreeMidBandCount = visibleTreeMidBandCount;
    generation.stats.visibleCanonicalTreeOuterBandCount = visibleTreeOuterBandCount;
    generation.stats.visibleCanonicalTreeUltraInnerBandCount = visibleTreeUltraInnerBandCount;
    generation.stats.visibleCanonicalTreeUltraOuterBandCount = visibleTreeUltraOuterBandCount;
    generation.stats.visibleCanonicalNaturalCrossFadeCount = visibleNaturalCrossFadeCount;
    generation.stats.visibleCanonicalForestInstanceCount = visibleForestInstanceCount;
    generation.stats.visibleCanonicalAtmosphericInstanceCount = visibleAtmosphericInstanceCount;
    generation.stats.visibleCanonicalForestHorizonInstanceCount =
      visibleForestHorizonInstanceCount;
    generation.stats.visibleCanonicalHorizonBuildingCount = visibleHorizonBuildingCount;
    generation.stats.visibleCanonicalHorizonLandmarkCount = visibleHorizonLandmarkCount;
    generation.stats.visibleCanonicalBuildingPartInstanceCount = visibleBuildingPartInstanceCount;
    generation.stats.visibleCanonicalHorizonPartInstanceCount = visibleHorizonPartInstanceCount;
    generation.stats.destroyedHorizonBuildingCount = destroyedHorizonBuildingCount;
    generation.stats.visibleRemoteHorizonSettlementCount = visibleRemoteSettlementIds.size;
    }
    generation.treeLastUpdateAtMs = monotonicNow();
    if (treeLodDiagnosticsEnabled && !generation.treeLodDiagnostics) {
      createTreeLodDiagnostics(generation);
    } else if (generation.treeLodDiagnostics) {
      updateTreeLodDiagnostics(generation);
    }
    if (diagnosticsEnabled) recordDiagnosticWork(
      generation.persistentNatural === true
        ? 'persistent-natural-visibility'
        : 'legacy-distant-visibility',
      {
        calls: 1,
        canonicalObjectsScanned: selectedObjects.length,
        nearIdentityObjectsScanned: objectStableIds === null
          && generation.persistentTree !== true ? generation.canonicalObjects.size : 0,
        dirtyBuckets: dirtyBuckets.size,
        visibleObjects: visibleCount,
        maximumSynchronousSliceMs: monotonicNow() - diagnosticStartedAt,
      },
    );
    return dirtyBuckets;
  };

  let persistentTreeGeneration = null;
  let stagedPersistentNaturalRenderDistancePreset = null;
  const persistentTreePages = new Map();
  const pendingPersistentTreePages = new Map();
  const pendingPersistentTreePublications = new Map();
  const persistentTreePublishedOwners = new Set();
  const persistentTreeDisposeOwners = [];
  const persistentTreeDesiredResourceKinds = new Map();
  let persistentTreeBuildActive = false;
  let persistentTreeBuildQueuedCount = 0;
  let persistentTreeBuildTail = Promise.resolve();
  let persistentTreeCoverageGeneration = 0;
  let persistentTreePlanRevision = 0;
  let persistentTreePlanId = null;
  let persistentTreeStateRevision = null;
  let persistentTreeVisibilityDirty = true;
  let persistentTreePublishedOwnerCount = 0;
  let persistentTreeMatrixUpdateCount = 0;
  let persistentTreeAttributeUpdateCount = 0;
  let persistentTreeMaximumSliceMs = 0;
  let persistentTreeLastPublicationWaitMs = 0;
  let persistentTreeMaximumPublicationWaitMs = 0;
  const persistentTreeFrameSampleCapacity = 512;
  const persistentTreeFrameSamples = [];
  let persistentTreeFrameSequence = 0;
  let persistentTreeOwnerBuildCount = 0;
  let persistentTreeOwnerReuseCount = 0;
  let persistentTreeOwnerRebuildCount = 0;
  let persistentTreeOwnerDisposeCount = 0;
  let persistentTreeDuplicatePageQueueCount = 0;
  let persistentTreeStalePageDiscardCount = 0;
  let persistentTreeOlderCoveragePageCount = 0;
  let persistentTreeRootResetCount = 0;
  let persistentTreeMaximumVisibilitySliceMs = 0;
  let persistentTreeMaximumDisposeSliceMs = 0;
  let persistentTreeAllocatedObjectCount = 0;
  let persistentTreeAllocatedInstanceCount = 0;
  let persistentTreeAllocatedBucketCount = 0;
  let persistentTreeBufferRangeUpdateCount = 0;
  let persistentTreeBufferUploadByteCount = 0;
  let persistentTreeAdmissionsSinceFrame = 0;
  let persistentTreeMaximumAdmissionsPerFrame = 0;
  let persistentTreeAdmissionLimitViolationCount = 0;
  let persistentTreeCompactionMoveCount = 0;
  let persistentTreeVisibilityMatrixInvalidationCount = 0;
  let pendingRuntimePresentationHandoff = null;
  let runtimePresentationHandoffSequence = 0;
  let runtimePresentationHandoffRequestedCount = 0;
  let runtimePresentationHandoffCompletedCount = 0;
  let runtimePresentationHandoffSupersededCount = 0;
  let runtimePresentationHandoffLocalTerrainCount = 0;
  let runtimePresentationHandoffMatrixUpdateCount = 0;
  let runtimePresentationHandoffBufferUpdateCount = 0;
  let runtimePresentationHandoffDisposeCount = 0;
  let runtimePresentationHandoffMaximumSliceMs = 0;
  let runtimePresentationHandoffMaximumMatrixUpdatesPerFrame = 0;
  let runtimePresentationHandoffMaximumBufferUpdatesPerFrame = 0;
  let runtimePresentationHandoffMaximumDisposePerFrame = 0;

  const recordPersistentTreeFrameSample = sample => {
    if (!streamingTelemetry) return;
    persistentTreeFrameSamples.push(sample);
    while (persistentTreeFrameSamples.length > persistentTreeFrameSampleCapacity) {
      persistentTreeFrameSamples.shift();
    }
  };

  const createPersistentNaturalGeneration = ({ quality, renderDistancePreset, renderOrigin }) => {
    const naturalRoot = new Group();
    naturalRoot.name = 'w8-persistent-static-natural-pages';
    naturalRoot.userData = {
      presentationOnly: true,
      persistentStaticPages: true,
      treePathId: TREE_RENDER_PATH.STATIC,
    };
    scene.add(naturalRoot);
    return {
      epoch: 0,
      root: naturalRoot,
      persistentNatural: true,
      // Compatibility flag used by existing visibility and path-audit code.
      persistentTree: true,
      treeOnly: true,
      naturalOnly: true,
      excludeNatural: false,
      excludeTreeNatural: false,
      ownedGeometries: new Set(),
      ownedMaterials: new Set(),
      stats: createStats(),
      canonicalBuckets: new Map(),
      canonicalObjects: new Map(),
      activeKeys: new Set(),
      renderedKeys: new Set(),
      quality,
      renderDistancePreset,
      renderDistancePolicy: resolveW8RenderDistancePolicy(renderDistancePreset),
      settlementPresentationPolicy: resolveW8SettlementPresentationPolicy(
        quality,
        renderDistancePreset,
      ),
      localFullHandoffMaterials: new Map(),
      naturalLodMaterials: new Map(),
      naturalLodPolicies: new Map(),
      naturalReveal: 1,
      naturalRevealInnerMeters: 0,
      naturalRevealInitialByStableId: new Map(),
      naturalRevealStartedAt: null,
      horizonBuildingSilhouetteMaterial: null,
      remoteHorizonSilhouetteMaterial: null,
      buildOriginChunkX: renderOrigin.renderOriginChunkX,
      buildOriginChunkZ: renderOrigin.renderOriginChunkZ,
      currentOriginChunkX: renderOrigin.renderOriginChunkX,
      currentOriginChunkZ: renderOrigin.renderOriginChunkZ,
      playerX: 0,
      playerZ: 0,
      localSettlementIds: new Set(),
      nearVisibleStableIds: new Set(),
      nearVisibleStableSignature: '',
      nearVisibleSettlementIds: new Set(),
      nearVisibleSettlementSignature: '',
      naturalKindsByOwner: new Map(),
      naturalCapacityByKind: new Map((resolveStaticNaturalCapacity?.(
        renderDistancePreset,
      ) ?? []).map(entry => [entry.naturalKind, Object.freeze({
        maximumCanonicalOwnerCount: entry.maximumCanonicalOwnerCount,
        maximumManifestOwnerCount: entry.maximumManifestOwnerCount,
      })])),
      naturalPolicyCoverageProvided: false,
      surfacePolicy: currentCanonicalSurfacePolicy,
    };
  };

  const applyPersistentNaturalRenderDistancePreset = renderDistancePreset => {
    if (!persistentTreeGeneration) return false;
    const preset = normalizeW8RenderDistancePreset(renderDistancePreset);
    persistentTreeGeneration.renderDistancePreset = preset;
    persistentTreeGeneration.renderDistancePolicy = resolveW8RenderDistancePolicy(preset);
    persistentTreeGeneration.settlementPresentationPolicy =
      resolveW8SettlementPresentationPolicy(persistentTreeGeneration.quality, preset);
    persistentTreeGeneration.naturalLodPolicies.clear();
    for (const material of new Set(persistentTreeGeneration.naturalLodMaterials.values())) {
      const mode = material.userData?.naturalLodMode;
      const kind = material.userData?.naturalLodKind;
      const uniforms = material.userData?.naturalLodUniforms;
      if (!mode || !kind || !uniforms) continue;
      const policy = resolveW8VegetationLodPolicy(kind, preset);
      const enter = mode === 'horizon'
        ? policy.horizonEntry
        : mode === 'forest'
          ? policy.fullToForest
          : mode === 'atmospheric'
            ? (policy.forestToAtmospheric ?? policy.fullToForest)
            : null;
      const exit = mode === 'horizon'
        ? policy.horizonFade
        : mode === 'full'
          ? policy.fullToForest
          : mode === 'forest' ? policy.forestToAtmospheric : policy.atmosphericFade;
      if (!exit) continue;
      uniforms.w8NaturalEnterStart.value = enter?.minimum ?? -1;
      uniforms.w8NaturalEnterEnd.value = enter?.maximum ?? 0;
      uniforms.w8NaturalExitStart.value = exit.minimum;
      uniforms.w8NaturalExitEnd.value = exit.maximum;
      uniforms.w8NaturalFogBlendStart.value = mode === 'horizon'
        ? policy.horizonEntry.minimum
        : policy.forestToAtmospheric?.minimum ?? policy.fullToForest.minimum;
      uniforms.w8NaturalVisibility.value = mode === 'horizon'
        ? policy.horizonVisibilityMeters : policy.visibilityMeters;
    }
    persistentTreeVisibilityDirty = true;
    stagedPersistentNaturalRenderDistancePreset = null;
    return true;
  };

  const applyPersistentNaturalPolicyCoverage = (generation, coverageEntries) => {
    generation.naturalKindsByOwner.clear();
    generation.naturalPolicyCoverageProvided = Array.isArray(coverageEntries)
      && coverageEntries.length > 0;
    if (!generation.naturalPolicyCoverageProvided) return;
    generation.naturalCapacityByKind.clear();
    for (const entry of coverageEntries) {
      if (entry?.schemaVersion !== 'static-natural-policy-coverage-1'
        || !Object.values(W8_VEGETATION_LOD_KINDS).includes(entry.naturalKind)
        || !Number.isSafeInteger(entry.maximumCanonicalOwnerCount)
        || entry.maximumCanonicalOwnerCount < 1
        || !Number.isSafeInteger(entry.maximumManifestOwnerCount)
        || entry.maximumManifestOwnerCount < 0
        || !Array.isArray(entry.resourceKindEntries)) {
        throw new TypeError('invalid Static Natural policy coverage');
      }
      generation.naturalCapacityByKind.set(entry.naturalKind, Object.freeze({
        maximumCanonicalOwnerCount: entry.maximumCanonicalOwnerCount,
        maximumManifestOwnerCount: entry.maximumManifestOwnerCount,
      }));
      for (const resourceEntry of entry.resourceKindEntries) {
        if (!Array.isArray(resourceEntry) || resourceEntry.length !== 2) {
          throw new TypeError('invalid Static Natural owner resource coverage');
        }
        const [ownerKey, resourceKind] = resourceEntry;
        if (resourceKind !== 'canonical') continue;
        if (!generation.naturalKindsByOwner.has(ownerKey)) {
          generation.naturalKindsByOwner.set(ownerKey, new Set());
        }
        generation.naturalKindsByOwner.get(ownerKey).add(entry.naturalKind);
      }
    }
  };

  const naturalKindFilterForPage = (generation, page) => {
    if (page.resourceKind === 'manifest') {
      return new Set([W8_VEGETATION_LOD_KINDS.TREE]);
    }
    if (!generation.naturalPolicyCoverageProvided) return null;
    return new Set(generation.naturalKindsByOwner.get(page.ownerKey) ?? []);
  };

  const markAttributeRanges = (attribute, slots, itemSize) => {
    if (!attribute || slots.length === 0) {
      return null;
    }
    const ordered = [...new Set(slots)].sort((left, right) => left - right);
    let rangeCount = 0;
    if (typeof attribute.clearUpdateRanges === 'function'
      && typeof attribute.addUpdateRange === 'function') {
      attribute.clearUpdateRanges();
      let start = ordered[0];
      let end = start;
      for (let index = 1; index <= ordered.length; index += 1) {
        const slot = ordered[index];
        if (slot === end + 1) {
          end = slot;
          continue;
        }
        attribute.addUpdateRange(start * itemSize, (end - start + 1) * itemSize);
        rangeCount += 1;
        start = slot;
        end = slot;
      }
    } else if (attribute.updateRange) {
      attribute.updateRange.offset = ordered[0] * itemSize;
      attribute.updateRange.count = (ordered.at(-1) - ordered[0] + 1) * itemSize;
      rangeCount = 1;
    } else {
      rangeCount = 1;
    }
    attribute.needsUpdate = true;
    const componentCount = ordered.length * itemSize;
    return Object.freeze({
      rangeCount,
      componentCount,
      byteCount: componentCount * Float32Array.BYTES_PER_ELEMENT,
    });
  };

  const composePersistentTreeDirtyRanges = (
    generation,
    budgetMs = STATIC_TREE_PAGE_FRAME_BUDGET_MS,
    unitLimit = STATIC_TREE_PAGE_UNIT_LIMIT,
  ) => {
    if (!generation) return Object.freeze({ matrices: 0, attributes: 0, buckets: 0 });
    const startedAt = monotonicNow();
    let matrixUpdates = 0;
    let attributeUpdates = 0;
    let bufferRangeUpdates = 0;
    let bufferUploadBytes = 0;
    let bucketUpdates = 0;
    transform.scale.set(0, 0, 0);
    transform.updateMatrix();
    const hidden = transform.matrix.clone?.() ?? structuredClone(transform.matrix);
    for (const bucket of generation.canonicalBuckets.values()) {
      for (const slot of bucket.dirtySlots ?? []) {
        if (slot < 0 || slot >= bucket.items.length) bucket.dirtySlots.delete(slot);
      }
      const slots = [...(bucket.dirtySlots ?? [])]
        .filter(slot => slot >= 0 && slot < bucket.items.length)
        .sort((left, right) => left - right);
      if (!bucket.mesh || slots.length === 0) continue;
      const processedSlots = [];
      for (const slot of slots) {
        if (matrixUpdates >= unitLimit
          || monotonicNow() - startedAt >= budgetMs) break;
        const item = bucket.items[slot];
        const opacity = canonicalInstanceOpacity(item.object, item);
        bucket.mesh.setMatrixAt(slot, opacity > 0 ? item.matrix : hidden);
        writeNaturalAnchor(bucket, slot, item.object, generation);
        writeNaturalInitialReveal(bucket, slot, item.object, generation);
        bucket.mesh.userData.canonicalStableIds[slot] = item.object.stableId;
        bucket.mesh.userData.canonicalObjects[slot] = item.object.record;
        bucket.mesh.userData.canonicalOpacities[slot] = opacity;
        bucket.dirtySlots.delete(slot);
        processedSlots.push(slot);
        matrixUpdates += 1;
      }
      if (processedSlots.length === 0) break;
      bucket.mesh.count = bucket.items.length;
      const matrixUpload = markAttributeRanges(bucket.mesh.instanceMatrix, processedSlots, 16);
      const anchorUpload = markAttributeRanges(
        bucket.naturalAnchorAttribute,
        processedSlots,
        2,
      );
      const revealUpload = markAttributeRanges(
        bucket.naturalInitialRevealAttribute,
        processedSlots,
        1,
      );
      bucket.mesh.boundingBox = null;
      bucket.mesh.boundingSphere = null;
      attributeUpdates += Number(Boolean(bucket.mesh.instanceMatrix))
        + Number(Boolean(bucket.naturalAnchorAttribute))
        + Number(Boolean(bucket.naturalInitialRevealAttribute));
      bufferRangeUpdates += (matrixUpload?.rangeCount ?? 0)
        + (anchorUpload?.rangeCount ?? 0)
        + (revealUpload?.rangeCount ?? 0);
      bufferUploadBytes += (matrixUpload?.byteCount ?? 0)
        + (anchorUpload?.byteCount ?? 0)
        + (revealUpload?.byteCount ?? 0);
      bucketUpdates += 1;
      if (matrixUpdates >= unitLimit || monotonicNow() - startedAt >= budgetMs) break;
    }
    transform.scale.set(1, 1, 1);
    transform.updateMatrix();
    generation.stats.canonicalComposeCount += Number(bucketUpdates > 0);
    generation.stats.canonicalDirtyBucketCount += bucketUpdates;
    generation.stats.canonicalMatrixUpdateCount += matrixUpdates;
    generation.stats.canonicalNeedsUpdateCount += bucketUpdates;
    persistentTreeMatrixUpdateCount += matrixUpdates;
    persistentTreeAttributeUpdateCount += attributeUpdates;
    persistentTreeBufferRangeUpdateCount += bufferRangeUpdates;
    persistentTreeBufferUploadByteCount += bufferUploadBytes;
    persistentTreeMaximumSliceMs = Math.max(
      persistentTreeMaximumSliceMs,
      monotonicNow() - startedAt,
    );
    return Object.freeze({
      matrices: matrixUpdates,
      attributes: attributeUpdates,
      buckets: bucketUpdates,
      bufferRangeUpdates,
      bufferUploadBytes,
      durationMs: monotonicNow() - startedAt,
    });
  };

  const removePersistentNaturalOwner = ownerKey => {
    const page = persistentTreePages.get(ownerKey);
    if (!page || !persistentTreeGeneration) return false;
    for (const stableId of page.stableIds) {
      const object = persistentTreeGeneration.canonicalObjects.get(stableId);
      if (!object) continue;
      for (const instance of object.instances) {
        const { bucket, item } = instance;
        const slot = item.slot;
        const last = bucket.items.pop();
        if (last && last !== item) {
          bucket.items[slot] = last;
          last.slot = slot;
          bucket.dirtySlots ??= new Set();
          bucket.dirtySlots.add(slot);
          persistentTreeCompactionMoveCount += 1;
        }
        if (bucket.mesh) bucket.mesh.count = bucket.items.length;
      }
      persistentTreeGeneration.canonicalObjects.delete(stableId);
    }
    persistentTreePages.delete(ownerKey);
    pendingPersistentTreePublications.delete(ownerKey);
    persistentTreePublishedOwners.delete(ownerKey);
    persistentTreeOwnerDisposeCount += 1;
    return true;
  };

  const publishPersistentNaturalOwner = (page, stableIds, composeResult) => {
    const tickets = publishStaticOwnerTickets?.({
      ownerKeys: Object.freeze([page.ownerKey]),
      publicationGroup: 'natural-static',
      coverageGeneration: page.coverageGeneration,
      planRevision: page.planRevision,
    }) ?? Object.freeze([]);
    persistentTreePublishedOwnerCount += 1;
    persistentTreePublishedOwners.add(page.ownerKey);
    const waitMs = Math.max(0, monotonicNow() - page.readyAtMs);
    persistentTreeLastPublicationWaitMs = waitMs;
    persistentTreeMaximumPublicationWaitMs = Math.max(
      persistentTreeMaximumPublicationWaitMs,
      waitMs,
    );
    if (!streamingTelemetry) return;
    const stableIdsByTarget = new Map();
    for (const stableId of stableIds) {
      const object = persistentTreeGeneration?.canonicalObjects.get(stableId);
      const target = worldStreamingTargetForCanonicalObject(object?.record ?? object);
      if (!target) continue;
      if (!stableIdsByTarget.has(target)) stableIdsByTarget.set(target, []);
      stableIdsByTarget.get(target).push(stableId);
    }
    for (const [target, targetStableIds] of stableIdsByTarget) {
      const details = {
        target,
        stream: WORLD_STREAMING_STREAM.DISTANT,
        resourceKey: page.ownerKey,
        ownerKey: page.ownerKey,
        stableId: targetStableIds[0] ?? null,
        planId: page.planId,
        metadata: {
          instanceOwnerCount: targetStableIds.length,
          ticketCount: tickets.length,
          coverageGeneration: page.coverageGeneration,
          planRevision: page.planRevision,
          matrixUpdates: composeResult.matrices,
          attributeUpdates: composeResult.attributes,
        },
      };
      const event = streamingTelemetry.record(WORLD_STREAMING_EVENT.PUBLISH, details);
      pendingStaticTreeFirstDraw.push({
        ...details,
        correlationId: event?.correlationId ?? null,
      });
    }
  };

  const mergeNumericStats = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (Number.isFinite(value) && Number.isFinite(target[key])) target[key] += value;
    }
  };

  const buildPersistentNaturalOwner = async (
    page,
    budgetMs = STATIC_TREE_PAGE_FRAME_BUDGET_MS,
  ) => {
    const generation = persistentTreeGeneration;
    if (!generation || !page.value) return;
    const buildStartedAt = monotonicNow();
    const cooperativeBuildBudgetMs = Math.max(0.25, budgetMs * 0.75);
    const objectCountBefore = streamingTelemetry ? generation.canonicalObjects.size : 0;
    const bucketCountBefore = streamingTelemetry ? generation.canonicalBuckets.size : 0;
    const instanceCountBefore = streamingTelemetry
      ? [...generation.canonicalBuckets.values()]
        .reduce((sum, bucket) => sum + bucket.items.length, 0)
      : 0;
    const stagedGeneration = {
      ...generation,
      persistentNatural: false,
      persistentTree: false,
      persistentDistant: false,
      canonicalBuckets: new Map(),
      canonicalObjects: new Map(),
      currentPageStableIds: [],
      currentPageBuckets: new Set(),
      ownedGeometries: new Set(),
      ownedMaterials: new Set(),
      naturalLodMaterials: new Map(),
      naturalLodPolicies: new Map(generation.naturalLodPolicies),
      stats: createStats(),
    };
    const scheduler = createSliceScheduler({
      budgetMs: cooperativeBuildBudgetMs,
      unitLimit: STATIC_TREE_PAGE_UNIT_LIMIT,
      assertCurrent: () => {
        if (disposed || generation !== persistentTreeGeneration) throw SYNC_CANCELLED;
      },
    });
    const context = {
      target: generation.root,
      ownedGeometries: stagedGeneration.ownedGeometries,
      stats: stagedGeneration.stats,
      generation: stagedGeneration,
      surfacePolicy: generation.surfacePolicy,
    };
    await addCanonicalChunk({
      chunk: page.value,
      origin: {
        renderOriginChunkX: generation.buildOriginChunkX,
        renderOriginChunkZ: generation.buildOriginChunkZ,
      },
      includeNatural: true,
      farNaturalEligible: true,
      includeForestHorizon: page.resourceKind === 'manifest',
      naturalHorizonOnly: page.resourceKind === 'manifest',
      naturalKindFilter: naturalKindFilterForPage(generation, page),
      context,
      scheduler,
    });
    const stableIds = stagedGeneration.currentPageStableIds;
    for (const bucket of stagedGeneration.canonicalBuckets.values()) {
      for (const item of bucket.items) item.object.instances.push({ bucket, item });
    }
    updateCanonicalVisibility(
      stagedGeneration,
      generation.playerX,
      generation.playerZ,
      { compose: false, objectStableIds: stableIds, updateStats: false },
    );

    const previousPage = persistentTreePages.get(page.ownerKey) ?? null;
    const previousStableIds = new Set(previousPage?.stableIds ?? []);
    const previousCountByBucket = new Map();
    for (const stableId of previousStableIds) {
      const object = generation.canonicalObjects.get(stableId);
      for (const instance of object?.instances ?? []) {
        previousCountByBucket.set(
          instance.bucket.key,
          (previousCountByBucket.get(instance.bucket.key) ?? 0) + 1,
        );
      }
    }
    for (const object of stagedGeneration.canonicalObjects.values()) {
      const existing = generation.canonicalObjects.get(object.stableId);
      if (!existing) continue;
      if (!previousStableIds.has(object.stableId)
        || existing.ownerKey !== page.ownerKey
        || existing.identityKey !== object.identityKey) {
        throw new Error(`persistent Natural owner identity collision: ${object.stableId}`);
      }
    }

    const preparedBuckets = new Map();
    const previousOwnedGeometries = new Set(generation.ownedGeometries);
    const previousOwnedMaterials = new Set(generation.ownedMaterials);
    const previousNaturalMaterialKeys = new Set(generation.naturalLodMaterials.keys());
    const preparationContext = {
      target: generation.root,
      ownedGeometries: generation.ownedGeometries,
      stats: generation.stats,
      generation,
      surfacePolicy: generation.surfacePolicy,
    };
    try {
      for (const stagedBucket of stagedGeneration.canonicalBuckets.values()) {
        const existingBucket = generation.canonicalBuckets.get(stagedBucket.key) ?? null;
        const requiredSlots = (existingBucket?.items.length ?? 0)
          - (previousCountByBucket.get(stagedBucket.key) ?? 0)
          + stagedBucket.items.length;
        const capacity = resolvePersistentNaturalBucketCapacity({
          generation,
          bucket: stagedBucket,
          requiredSlots,
        });
        if (existingBucket) {
          if (requiredSlots > existingBucket.capacity) {
            throw new RangeError([
              `persistent Natural bucket capacity exceeded: ${stagedBucket.key}`,
              `required=${requiredSlots}`,
              `capacity=${existingBucket.capacity}`,
            ].join(' '));
          }
          preparedBuckets.set(stagedBucket.key, { bucket: existingBucket, prepared: null });
          continue;
        }
        const bucket = {
          ...stagedBucket,
          items: [...stagedBucket.items],
          capacity,
          persistent: true,
          dirtySlots: new Set(),
        };
        const prepared = prepareCanonicalBucketMesh(bucket, preparationContext);
        bucket.items = [];
        preparedBuckets.set(stagedBucket.key, { bucket, prepared });
      }
    } catch (error) {
      for (const geometry of generation.ownedGeometries) {
        if (!previousOwnedGeometries.has(geometry)) {
          geometry.dispose?.();
          generation.ownedGeometries.delete(geometry);
        }
      }
      for (const material of generation.ownedMaterials) {
        if (!previousOwnedMaterials.has(material)) {
          material.dispose?.();
          generation.ownedMaterials.delete(material);
        }
      }
      for (const key of generation.naturalLodMaterials.keys()) {
        if (!previousNaturalMaterialKeys.has(key)) generation.naturalLodMaterials.delete(key);
      }
      throw error;
    }

    removePersistentNaturalOwner(page.ownerKey);
    for (const { bucket, prepared } of preparedBuckets.values()) {
      if (!generation.canonicalBuckets.has(bucket.key)) {
        generation.canonicalBuckets.set(bucket.key, bucket);
        if (prepared) completeCanonicalBucketMesh(bucket, preparationContext, prepared);
      }
    }
    for (const stagedObject of stagedGeneration.canonicalObjects.values()) {
      stagedObject.instances = [];
      generation.canonicalObjects.set(stagedObject.stableId, stagedObject);
    }
    for (const stagedBucket of stagedGeneration.canonicalBuckets.values()) {
      const bucket = generation.canonicalBuckets.get(stagedBucket.key);
      for (const stagedItem of stagedBucket.items) {
        const object = generation.canonicalObjects.get(stagedItem.object.stableId);
        const item = { ...stagedItem, object, slot: bucket.items.length };
        bucket.items.push(item);
        object.instances.push({ bucket, item });
        bucket.dirtySlots.add(item.slot);
      }
    }
    mergeNumericStats(generation.stats, stagedGeneration.stats);
    const slice = scheduler.finish();
    persistentTreeMaximumSliceMs = Math.max(persistentTreeMaximumSliceMs, slice.maximumSliceMs);
    persistentTreePages.set(page.ownerKey, Object.freeze({
      ownerKey: page.ownerKey,
      resourceKind: page.resourceKind,
      contentHash: page.value.contentHash ?? null,
      stableIds: Object.freeze(stableIds),
    }));
    pendingPersistentTreePublications.set(page.ownerKey, { page, stableIds });
    if (!streamingTelemetry) {
      persistentTreeOwnerBuildCount += 1;
      return null;
    }
    const instanceCountAfter = [...generation.canonicalBuckets.values()]
      .reduce((sum, bucket) => sum + bucket.items.length, 0);
    const allocation = Object.freeze({
      objectCount: Math.max(0, generation.canonicalObjects.size - objectCountBefore),
      instanceCount: Math.max(0, instanceCountAfter - instanceCountBefore),
      bucketCount: Math.max(0, generation.canonicalBuckets.size - bucketCountBefore),
      durationMs: monotonicNow() - buildStartedAt,
      maximumSliceMs: slice.maximumSliceMs,
    });
    persistentTreeOwnerBuildCount += 1;
    persistentTreeAllocatedObjectCount += allocation.objectCount;
    persistentTreeAllocatedInstanceCount += allocation.instanceCount;
    persistentTreeAllocatedBucketCount += allocation.bucketCount;
    return allocation;
  };

  const enqueuePersistentNaturalOwnerBuild = (
    page,
    budgetMs = STATIC_TREE_PAGE_FRAME_BUDGET_MS,
  ) => {
    const requestedGeneration = persistentTreeGeneration;
    persistentTreeBuildQueuedCount += 1;
    const execute = async () => {
      if (!requestedGeneration || requestedGeneration !== persistentTreeGeneration) return null;
      const desiredResourceKind = persistentTreeDesiredResourceKinds.get(page.ownerKey);
      if (desiredResourceKind && desiredResourceKind !== page.resourceKind) {
        persistentTreeStalePageDiscardCount += 1;
        return null;
      }
      const resident = persistentTreePages.get(page.ownerKey);
      if (resident?.resourceKind === page.resourceKind
        && resident.contentHash === (page.value?.contentHash ?? null)) {
        persistentTreeOwnerReuseCount += 1;
        return null;
      }
      persistentTreeBuildActive = true;
      try {
        return await buildPersistentNaturalOwner(page, budgetMs);
      } finally {
        persistentTreeBuildActive = false;
      }
    };
    const scheduled = persistentTreeBuildTail.then(execute);
    // Keep the serialization tail usable after an observed build failure. The
    // returned promise retains the original rejection for the owning caller.
    persistentTreeBuildTail = scheduled.then(() => undefined, () => undefined);
    return scheduled.finally(() => {
      persistentTreeBuildQueuedCount -= 1;
    });
  };

  const flushPersistentNaturalPublications = (
    composeResult,
    {
      limit = STATIC_TREE_OWNER_PUBLICATION_LIMIT,
      canContinue = () => true,
    } = {},
  ) => {
    if (!persistentTreeGeneration) return 0;
    let published = 0;
    for (const [ownerKey, pending] of pendingPersistentTreePublications) {
      if (published >= limit || !canContinue()) break;
      const stillDirty = pending.stableIds.some(stableId => {
        const object = persistentTreeGeneration.canonicalObjects.get(stableId);
        return object?.instances.some(instance => (
          instance.bucket.dirtySlots?.has(instance.item.slot)
        )) === true;
      });
      if (stillDirty) continue;
      pendingPersistentTreePublications.delete(ownerKey);
      publishPersistentNaturalOwner(pending.page, pending.stableIds, composeResult);
      published += 1;
    }
    return published;
  };

  const processPersistentNaturalWork = (
    frameBudgetMs = STATIC_TREE_PAGE_FRAME_BUDGET_MS,
  ) => {
    if (!incrementalStaticTreePages || !persistentTreeGeneration) return null;
    if (!(frameBudgetMs > 0)) return Object.freeze({ remainingMs: 0, buildStarted: false });
    const frameStartedAt = monotonicNow();
    const withinBudget = () => (
      monotonicNow() - frameStartedAt < frameBudgetMs
    );
    const remainingBudgetMs = () => Math.max(
      0,
      frameBudgetMs - (monotonicNow() - frameStartedAt),
    );
    const admittedOwners = persistentTreeAdmissionsSinceFrame;
    persistentTreeAdmissionsSinceFrame = 0;
    persistentTreeMaximumAdmissionsPerFrame = Math.max(
      persistentTreeMaximumAdmissionsPerFrame,
      admittedOwners,
    );
    if (admittedOwners > STATIC_TREE_OWNER_ADMISSION_LIMIT) {
      persistentTreeAdmissionLimitViolationCount += 1;
    }
    const frameSample = streamingTelemetry || diagnosticsEnabled ? {
      frameSequence: ++persistentTreeFrameSequence,
      startedAtMs: frameStartedAt,
      budgetMs: frameBudgetMs,
      admittedOwners,
      coverageGeneration: persistentTreeCoverageGeneration,
      planRevision: persistentTreePlanRevision,
      residentBefore: persistentTreePages.size,
      pendingPagesBefore: pendingPersistentTreePages.size,
      pendingPublicationsBefore: pendingPersistentTreePublications.size,
      disposeBacklogBefore: persistentTreeDisposeOwners.length,
      publishedOwners: 0,
      builtOwners: 0,
      disposedOwners: 0,
      compactionMoves: 0,
      visibilityMatrixInvalidations: 0,
      matrixUpdates: 0,
      attributeUpdates: 0,
      bufferRangeUpdates: 0,
      bufferUploadBytes: 0,
      visibilityMs: 0,
      composeMs: 0,
      disposeMs: 0,
      buildMs: 0,
      buildMaximumSliceMs: 0,
      allocatedObjects: 0,
      allocatedInstances: 0,
      allocatedBuckets: 0,
    } : null;
    let frameSampleFinished = false;
    const finishFrameSample = () => {
      if (!frameSample || frameSampleFinished) return;
      frameSampleFinished = true;
      frameSample.residentAfter = persistentTreePages.size;
      frameSample.pendingPagesAfter = pendingPersistentTreePages.size;
      frameSample.pendingPublicationsAfter = pendingPersistentTreePublications.size;
      frameSample.disposeBacklogAfter = persistentTreeDisposeOwners.length;
      frameSample.totalMs = monotonicNow() - frameSample.startedAtMs;
      recordPersistentTreeFrameSample(frameSample);
      if (diagnosticsEnabled) recordDiagnosticWork('persistent-natural-frame', {
        calls: 1,
        admittedOwners: frameSample.admittedOwners,
        publishedOwners: frameSample.publishedOwners,
        builtOwners: frameSample.builtOwners,
        disposedOwners: frameSample.disposedOwners,
        residentOwners: frameSample.residentAfter,
        pendingPages: frameSample.pendingPagesAfter,
        pendingPublications: frameSample.pendingPublicationsAfter,
        disposeBacklog: frameSample.disposeBacklogAfter,
        compactionMoves: frameSample.compactionMoves,
        visibilityMatrixInvalidations: frameSample.visibilityMatrixInvalidations,
        matrixUpdates: frameSample.matrixUpdates,
        attributeUpdates: frameSample.attributeUpdates,
        bufferRangeUpdates: frameSample.bufferRangeUpdates,
        bufferUploadBytes: frameSample.bufferUploadBytes,
        allocatedObjects: frameSample.allocatedObjects,
        allocatedInstances: frameSample.allocatedInstances,
        allocatedBuckets: frameSample.allocatedBuckets,
        visibilityMs: frameSample.visibilityMs,
        composeMs: frameSample.composeMs,
        disposeMs: frameSample.disposeMs,
        buildMs: frameSample.buildMs,
        buildMaximumSliceMs: frameSample.buildMaximumSliceMs,
        totalMs: frameSample.totalMs,
      });
    };

    const compactionBefore = persistentTreeCompactionMoveCount;
    const disposedBefore = persistentTreeOwnerDisposeCount;
    const disposeStartedAt = monotonicNow();
    if (persistentTreeDisposeOwners.length && withinBudget()) {
      removePersistentNaturalOwner(persistentTreeDisposeOwners.shift());
    }
    const disposeMs = monotonicNow() - disposeStartedAt;
    persistentTreeMaximumDisposeSliceMs = Math.max(persistentTreeMaximumDisposeSliceMs, disposeMs);
    if (frameSample) {
      frameSample.disposedOwners = Math.min(
        STATIC_TREE_OWNER_DISPOSE_LIMIT,
        persistentTreeOwnerDisposeCount - disposedBefore,
      );
      frameSample.compactionMoves = persistentTreeCompactionMoveCount - compactionBefore;
      frameSample.disposeMs = disposeMs;
    }

    const nearSignature = readNearVisibleSnapshotState().signature;
    if (nearSignature !== persistentTreeGeneration.nearVisibleStableSignature) {
      persistentTreeVisibilityDirty = true;
    }
    const dirtySlotCount = () => [...persistentTreeGeneration.canonicalBuckets.values()]
      .reduce((sum, bucket) => sum + (bucket.dirtySlots?.size ?? 0), 0);
    const dirtyBeforeVisibility = streamingTelemetry || diagnosticsEnabled
      ? dirtySlotCount() : 0;
    const visibilityStartedAt = monotonicNow();
    if (withinBudget()) {
      if (persistentTreeVisibilityDirty) {
        updateCanonicalVisibility(
          persistentTreeGeneration,
          persistentTreeGeneration.playerX,
          persistentTreeGeneration.playerZ,
          { compose: false },
        );
        persistentTreeVisibilityDirty = false;
      } else {
        updateNaturalLodPlayerUniforms(
          persistentTreeGeneration,
          persistentTreeGeneration.playerX,
          persistentTreeGeneration.playerZ,
        );
      }
    }
    const visibilityMs = monotonicNow() - visibilityStartedAt;
    const visibilityInvalidations = streamingTelemetry || diagnosticsEnabled
      ? Math.max(0, dirtySlotCount() - dirtyBeforeVisibility)
      : 0;
    persistentTreeVisibilityMatrixInvalidationCount += visibilityInvalidations;
    persistentTreeMaximumVisibilitySliceMs = Math.max(
      persistentTreeMaximumVisibilitySliceMs,
      visibilityMs,
    );

    const composeResult = remainingBudgetMs() > 0
      ? composePersistentTreeDirtyRanges(
        persistentTreeGeneration,
        remainingBudgetMs(),
        STATIC_TREE_PAGE_UNIT_LIMIT,
      )
      : Object.freeze({
        matrices: 0,
        attributes: 0,
        buckets: 0,
        bufferRangeUpdates: 0,
        bufferUploadBytes: 0,
        durationMs: 0,
      });
    const publishedOwners = flushPersistentNaturalPublications(composeResult, {
      limit: STATIC_TREE_OWNER_PUBLICATION_LIMIT,
      canContinue: withinBudget,
    });
    if (frameSample) {
      frameSample.visibilityMs = visibilityMs;
      frameSample.visibilityMatrixInvalidations = visibilityInvalidations;
      frameSample.composeMs = composeResult.durationMs;
      frameSample.matrixUpdates = composeResult.matrices;
      frameSample.attributeUpdates = composeResult.attributes;
      frameSample.bufferRangeUpdates = composeResult.bufferRangeUpdates;
      frameSample.bufferUploadBytes = composeResult.bufferUploadBytes;
      frameSample.publishedOwners = publishedOwners;
    }

    if (persistentTreeBuildActive || persistentTreeBuildQueuedCount > 0
      || pendingPersistentTreePages.size === 0
      || remainingBudgetMs() < 0.25) {
      finishFrameSample();
      return Object.freeze({ remainingMs: remainingBudgetMs(), buildStarted: false });
    }
    const prioritizedPages = [...pendingPersistentTreePages.values()].sort((left, right) => (
      Number(right.required) - Number(left.required)
        || (left.deadlineAtMs ?? Number.POSITIVE_INFINITY)
          - (right.deadlineAtMs ?? Number.POSITIVE_INFINITY)
        || left.readyAtMs - right.readyAtMs
        || left.ownerKey.localeCompare(right.ownerKey)
    ));
    const page = prioritizedPages[0];
    pendingPersistentTreePages.delete(page.ownerKey);
    const pageBudgetMs = Math.max(0.25, remainingBudgetMs());
    void enqueuePersistentNaturalOwnerBuild(page, pageBudgetMs).then(allocation => {
      if (frameSample && allocation) {
        frameSample.builtOwners = 1;
        frameSample.buildMs = allocation.durationMs;
        frameSample.buildMaximumSliceMs = allocation.maximumSliceMs;
        frameSample.allocatedObjects = allocation.objectCount;
        frameSample.allocatedInstances = allocation.instanceCount;
        frameSample.allocatedBuckets = allocation.bucketCount;
      }
    }).catch(error => {
      if (error !== SYNC_CANCELLED) throw error;
    }).finally(finishFrameSample);
    return Object.freeze({ remainingMs: 0, buildStarted: true });
  };

  const queueRuntimePresentationHandoff = ({
    transitionContract,
    activeDataKeys,
    renderedKeys,
    renderOrigin,
    quality,
    playerLogicalX,
    playerLogicalZ,
  }) => {
    if (pendingRuntimePresentationHandoff) {
      runtimePresentationHandoffSupersededCount += 1;
    }
    pendingRuntimePresentationHandoff = {
      sequence: ++runtimePresentationHandoffSequence,
      stage: 'local-terrain',
      transitionContract,
      activeDataKeys: Object.freeze([...activeDataKeys]),
      renderedKeys: Object.freeze([...renderedKeys]),
      renderOrigin: Object.freeze({ ...renderOrigin }),
      quality,
      playerLogicalX,
      playerLogicalZ,
      targetLocalTerrainGeneration: activeLocalTerrainGeneration,
      targetGeneration: activeGeneration,
      dirtyBuckets: [],
      dirtyBucketIndex: 0,
      bucketWork: null,
      composedBuckets: 0,
      matrixUpdates: 0,
      bufferUpdates: 0,
    };
    runtimePresentationHandoffRequestedCount += 1;
    return pendingRuntimePresentationHandoff;
  };

  const processRuntimePresentationHandoff = () => {
    const handoff = pendingRuntimePresentationHandoff;
    if (!handoff) return Object.freeze({
      processed: false,
      durationMs: 0,
      meshUpdates: 0,
      matrixUpdates: 0,
      bufferUpdates: 0,
      uploadBytes: 0,
      localTerrainHandoffs: 0,
    });
    if (pendingDistantPublication?.generation === handoff.targetGeneration) {
      return Object.freeze({
        processed: false,
        durationMs: 0,
        meshUpdates: 0,
        matrixUpdates: 0,
        bufferUpdates: 0,
        uploadBytes: 0,
        localTerrainHandoffs: 0,
      });
    }
    const startedAt = monotonicNow();
    const localTerrainHandoffsBefore = runtimePresentationHandoffLocalTerrainCount;
    let frameMatrixUpdates = 0;
    let frameBufferUpdates = 0;
    let frameUploadBytes = 0;
    const complete = ({ superseded = false } = {}) => {
      if (pendingRuntimePresentationHandoff !== handoff) return;
      pendingRuntimePresentationHandoff = null;
      runtimePresentationHandoffCompletedCount += 1;
      if (superseded) runtimePresentationHandoffSupersededCount += 1;
    };

    if (handoff.targetGeneration && handoff.targetGeneration !== activeGeneration) {
      complete({ superseded: true });
    } else if (handoff.stage === 'local-terrain') {
      if (handoff.targetLocalTerrainGeneration === activeLocalTerrainGeneration) {
        if (applyLocalTerrainOwnerHandoff(
          handoff.targetLocalTerrainGeneration,
          handoff.activeDataKeys,
          handoff.renderedKeys,
        )) runtimePresentationHandoffLocalTerrainCount += 1;
      }
      handoff.stage = 'ownership';
    } else if (handoff.stage === 'ownership') {
      if (!handoff.targetGeneration) {
        complete();
      } else {
        handoff.targetGeneration.activeKeys = new Set(handoff.activeDataKeys);
        handoff.targetGeneration.renderedKeys = new Set(handoff.renderedKeys);
        positionGenerationForOrigin(handoff.targetGeneration, handoff.renderOrigin);
        updateFarRiverVisibility(handoff.targetGeneration);
        updateDistantWaterProxyVisibility(handoff.targetGeneration);
        handoff.stage = 'visibility';
      }
    } else if (handoff.stage === 'visibility') {
      const dirtyBuckets = updateCanonicalVisibility(
        handoff.targetGeneration,
        handoff.playerLogicalX,
        handoff.playerLogicalZ,
        { compose: false },
      );
      handoff.dirtyBuckets = [...dirtyBuckets.values()];
      handoff.dirtyBucketIndex = 0;
      handoff.stage = handoff.dirtyBuckets.length ? 'compose' : 'finalize';
    } else if (handoff.stage === 'compose') {
      const bucket = handoff.dirtyBuckets[handoff.dirtyBucketIndex];
      if (bucket) {
        handoff.bucketWork ??= createCanonicalBucketComposeWork(
          handoff.targetGeneration,
          bucket,
        );
        const composed = advanceCanonicalBucketComposeWork(handoff.bucketWork, {
          budgetStartedAtMs: startedAt,
        });
        handoff.matrixUpdates += composed.matrices;
        handoff.bufferUpdates += composed.attributes;
        frameMatrixUpdates += composed.matrices;
        frameBufferUpdates += composed.attributes;
        frameUploadBytes += composed.bytes ?? 0;
        if (composed.done) {
          handoff.composedBuckets += 1;
          handoff.dirtyBucketIndex += 1;
          handoff.bucketWork = null;
        }
      }
      if (handoff.dirtyBucketIndex >= handoff.dirtyBuckets.length) {
        handoff.stage = 'finalize';
      }
    } else if (handoff.stage === 'finalize') {
      finishCanonicalCompose(
        handoff.targetGeneration,
        handoff.composedBuckets,
        handoff.matrixUpdates,
      );
      complete();
    }

    const durationMs = monotonicNow() - startedAt;
    runtimePresentationHandoffMatrixUpdateCount += frameMatrixUpdates;
    runtimePresentationHandoffBufferUpdateCount += frameBufferUpdates;
    runtimePresentationHandoffMaximumSliceMs = Math.max(
      runtimePresentationHandoffMaximumSliceMs,
      durationMs,
    );
    runtimePresentationHandoffMaximumMatrixUpdatesPerFrame = Math.max(
      runtimePresentationHandoffMaximumMatrixUpdatesPerFrame,
      frameMatrixUpdates,
    );
    runtimePresentationHandoffMaximumBufferUpdatesPerFrame = Math.max(
      runtimePresentationHandoffMaximumBufferUpdatesPerFrame,
      frameBufferUpdates,
    );
    return Object.freeze({
      processed: true,
      durationMs,
      meshUpdates: Number(frameBufferUpdates > 0),
      matrixUpdates: frameMatrixUpdates,
      bufferUpdates: frameBufferUpdates,
      uploadBytes: frameUploadBytes,
      localTerrainHandoffs:
        runtimePresentationHandoffLocalTerrainCount - localTerrainHandoffsBefore,
    });
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
    positionGenerationForOrigin(activeGeneration, renderOrigin);
    if (incrementalStaticTreePages) {
      queueRuntimePresentationHandoff({
        transitionContract: acceptedTransition,
        activeDataKeys,
        renderedKeys,
        renderOrigin,
        quality,
        playerLogicalX,
        playerLogicalZ,
      });
      return true;
    }
    applyLocalTerrainOwnerHandoff(
      activeLocalTerrainGeneration,
      activeDataKeys,
      renderedKeys,
    );
    if (!activeGeneration) return true;
    activeGeneration.activeKeys = new Set(activeDataKeys);
    activeGeneration.renderedKeys = new Set(renderedKeys);
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
    const diagnosticStartedAt = diagnosticsEnabled ? monotonicNow() : 0;
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
    if (diagnosticsEnabled) recordDiagnosticWork('terrain-clipmap-build', {
      calls: 1,
      vertices: positions.length / 3,
      indices: topology.indices.length,
      allocatedBytes: (positions.length + colors.length + topology.indices.length) * 4,
      maximumSynchronousSliceMs: monotonicNow() - diagnosticStartedAt,
    });
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
    const forestHorizonPolicy = resolveW8VegetationLodPolicy(
      W8_VEGETATION_LOD_KINDS.TREE,
      renderDistancePolicy.id,
    );
    const forestHorizonVisibilityMeters = forestHorizonPolicy.horizonVisibilityMeters
      ?? naturalVisibilityMeters;
    // Chunk AABB coverage is conservative at the circle boundary; no owner-range
    // expansion is needed beyond the selected preset.
    const naturalQueryRadius = includeUltraNatural
      ? forestHorizonVisibilityMeters
      : renderDistancePolicy.naturalInnerWarmMeters;
    const settlementPolicy = resolveW8SettlementPresentationPolicy(
      quality,
      renderDistancePolicy.id,
    );
    const localQueryRadius = visibilityMeters + CANONICAL_QUERY_MARGIN_METERS;
    const queryRadius = Math.max(
      localQueryRadius,
      settlementPolicy.metadata.queryDistanceMeters,
    );
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
    const selectedEntries = [...selection.local, ...selection.remote];
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
    const selectedById = new Map(selected.map(value => [value.candidate.settlementId, value]));
    const localSelections = selection.local.map(value => (
      selectedById.get(value.candidate.settlementId)
    )).filter(Boolean);
    const activeLocalSelection = selection.activeLocal
      ? selectedById.get(selection.activeLocal.candidate.settlementId) ?? null
      : null;
    const additionalLocalSelections = localSelections.filter(value => (
      value.candidate.settlementId !== activeLocalSelection?.candidate.settlementId
    ));
    const remoteSelections = selection.remote.map(value => (
      selectedById.get(value.candidate.settlementId)
    )).filter(Boolean);
    const horizonSelections = [
      ...(activeLocalSelection ? [{ ...activeLocalSelection, standby: true }] : []),
      ...remoteSelections.map(value => ({ ...value, standby: false })),
    ];
    const selectionDiagnostics = selection.ranked.map(value => {
      const resolved = selectedById.get(value.candidate.settlementId);
      return Object.freeze({
        settlementId: value.candidate.settlementId,
        centerDistanceMeters: value.centerDistanceMeters,
        boundaryDistanceMeters: value.boundaryDistanceMeters,
        tier: value.tier,
        selected: value.selected,
        selectedReason: value.selectedReason,
        buildingCount: resolved?.template?.buildings?.length ?? null,
      });
    });
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
          includeForestHorizon: false,
        });
      }
      return ownerQueries.get(key);
    };
    const addSettlementOwner = (point, settlementId) => {
      const owner = determineDetailCandidateOwner(point);
      addOwnerCoordinate(owner.x, owner.z).settlementIds.add(settlementId);
    };
    for (const { template } of localSelections) {
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
          const insideExactNatural = chunkAabbIntersectsCircle(
            chunkX,
            chunkZ,
            naturalCenterWorldX,
            naturalCenterWorldZ,
            includeUltraNatural
              ? naturalVisibilityMeters : renderDistancePolicy.naturalInnerWarmMeters,
          );
          const insideForestHorizon = includeUltraNatural
            && isW8ForestHorizonOwner({ worldSeedHash, chunkX, chunkZ })
            && chunkAabbIntersectsCircle(
              chunkX,
              chunkZ,
              naturalCenterWorldX,
              naturalCenterWorldZ,
              forestHorizonVisibilityMeters,
            );
          if (!insideExactNatural && !insideForestHorizon) continue;
          const key = `${chunkX},${chunkZ}`;
          if (activeKeys.has(key)) {
            excludedActiveNaturalOwnerCount += 1;
            continue;
          }
          const owner = addOwnerCoordinate(chunkX, chunkZ);
          if (insideExactNatural && chunkAabbIntersectsCircle(
            chunkX,
            chunkZ,
            naturalCenterWorldX,
            naturalCenterWorldZ,
            renderDistancePolicy.naturalInnerWarmMeters,
          )) owner.includeNaturalInner = true;
          else if (insideExactNatural) owner.includeNaturalUltra = true;
          if (insideForestHorizon) owner.includeForestHorizon = true;
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
      forestHorizonHits: forestHorizonOwnerChunkCacheHits,
      forestHorizonMisses: forestHorizonOwnerChunkCacheMisses,
      forestHorizonEvictions: forestHorizonOwnerChunkCacheEvictions,
    };
    const ownerHasOnlyNatural = owner => owner.settlementIds.size === 0
      && owner.remoteHorizonSettlementIds.size === 0;
    const ultraOnlyOwner = owner => owner.includeNaturalUltra
      && !owner.includeNaturalInner
      && ownerHasOnlyNatural(owner);
    const forestHorizonOnlyOwner = owner => owner.includeForestHorizon
      && !owner.includeNaturalInner
      && !owner.includeNaturalUltra
      && ownerHasOnlyNatural(owner);
    const loadOwners = async ownerList => mapWithQueryConcurrency(ownerList, async owner => {
      const ultraOnly = ultraOnlyOwner(owner);
      const forestHorizonOnly = forestHorizonOnlyOwner(owner);
      const cache = forestHorizonOnly
        ? forestHorizonOwnerChunkCache
        : ultraOnly ? ultraOwnerChunkCache : farOwnerChunkCache;
      const capacity = forestHorizonOnly
        ? FOREST_HORIZON_OWNER_CHUNK_CACHE_CAPACITY
        : ultraOnly ? ULTRA_OWNER_CHUNK_CACHE_CAPACITY : FAR_OWNER_CHUNK_CACHE_CAPACITY;
      return {
        ...owner,
        chunk: await readThroughLru(
          cache,
          owner.key,
          capacity,
          async () => {
            const provider = forestHorizonOnly && getForestHorizonManifest
              ? getForestHorizonManifest : getCanonicalChunkData;
            const chunk = await provider(owner.chunkX, owner.chunkZ, {
              priority: forestHorizonOnly || ultraOnly
                ? CHUNK_DATA_PRIORITY.ULTRA_WARM
                : CHUNK_DATA_PRIORITY.DISTANT_OWNER,
              consumerId: 'distant-owner-query',
              epoch: consumerEpoch,
            });
            return forestHorizonOnly ? createW8ForestHorizonManifest(chunk) : chunk;
          },
          event => {
            if (forestHorizonOnly) {
              if (event === 'hit') forestHorizonOwnerChunkCacheHits += 1;
              else if (event === 'miss') forestHorizonOwnerChunkCacheMisses += 1;
              else if (event === 'eviction') forestHorizonOwnerChunkCacheEvictions += 1;
            } else if (ultraOnly) {
              if (event === 'hit') ultraOwnerChunkCacheHits += 1;
              else if (event === 'miss') ultraOwnerChunkCacheMisses += 1;
              else if (event === 'eviction') ultraOwnerChunkCacheEvictions += 1;
            } else if (event === 'hit') farOwnerChunkCacheHits += 1;
            else if (event === 'miss') farOwnerChunkCacheMisses += 1;
            else if (event === 'eviction') farOwnerChunkCacheEvictions += 1;
          },
          consumerEpoch,
        ),
      };
    }, assertCurrent);
    const innerOwners = owners.filter(owner => (
      !ultraOnlyOwner(owner) && !forestHorizonOnlyOwner(owner)
    ));
    const ultraOwners = owners.filter(ultraOnlyOwner);
    const forestHorizonOwners = owners.filter(forestHorizonOnlyOwner);
    const innerWarmStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const innerChunks = await loadOwners(innerOwners);
    assertCurrent?.();
    const innerWarmDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - innerWarmStartedAt;
    const ultraWarmStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const ultraChunks = await loadOwners(ultraOwners);
    assertCurrent?.();
    const ultraWarmDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - ultraWarmStartedAt;
    const forestHorizonWarmStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const forestHorizonChunks = await loadOwners(forestHorizonOwners);
    assertCurrent?.();
    const forestHorizonWarmDurationMs = (globalThis.performance?.now?.() ?? Date.now())
      - forestHorizonWarmStartedAt;
    const chunks = [...innerChunks, ...ultraChunks, ...forestHorizonChunks].sort((left, right) => (
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
      forestHorizonVisibilityMeters,
      naturalQueryRadius,
      candidateCount: candidates.length,
      activeLocalSettlementId: activeLocalSelection?.candidate.settlementId ?? null,
      additionalLocalSettlementIds: additionalLocalSelections.map(value => (
        value.candidate.settlementId
      )),
      localSettlementIds: localSelections.map(value => value.candidate.settlementId),
      localSettlementLimit: settlementPolicy.local.settlementLimit,
      settlementSelections: Object.freeze(selectionDiagnostics),
      templateSuccessCount: selected.length,
      remoteCandidateCount: selection.remote.length,
      remoteSelectedCount: remoteSelections.length,
      remoteHorizonMaterializedCount: remoteHorizons.length,
      remoteSettlementLimit: settlementPolicy.remote.settlementLimit,
      remoteBuildingLimitPerSettlement: settlementPolicy.remote.buildingLimitPerSettlement,
      remotePartLimit: settlementPolicy.remote.partLimit,
      remoteHorizonStartMeters: settlementPolicy.remote.horizonStartMeters,
      remoteFadeStartMeters: settlementPolicy.remote.fadeStartMeters,
      remoteFadeEndMeters: settlementPolicy.remote.fadeEndMeters,
      remoteHiddenDistanceMeters: settlementPolicy.remote.hiddenDistanceMeters,
      remoteFogEnabled: settlementPolicy.remote.fog,
      remoteAtmosphereMode: settlementPolicy.remote.atmosphere.mode,
      remoteFogIntegrationEndMeters:
        settlementPolicy.remote.atmosphere.fogIntegrationEndMeters,
      settlementMetadataQueryDistanceMeters: settlementPolicy.metadata.queryDistanceMeters,
      ownerChunkCount: owners.length,
      ownerChunkKeys: owners.map(owner => owner.key),
      naturalOwnerChunkCount: owners.filter(owner => (
        owner.includeNaturalInner || owner.includeNaturalUltra || owner.includeForestHorizon
      )).length,
      naturalOwnerChunkKeys: owners.filter(owner => (
        owner.includeNaturalInner || owner.includeNaturalUltra || owner.includeForestHorizon
      )).map(owner => owner.key),
      innerNaturalOwnerChunkCount: owners.filter(owner => owner.includeNaturalInner).length,
      ultraOwnerChunkCount: owners.filter(owner => owner.includeNaturalUltra).length,
      ultraOnlyOwnerChunkCount: owners.filter(ultraOnlyOwner).length,
      ultraOwnerChunkKeys: owners.filter(owner => owner.includeNaturalUltra).map(owner => owner.key),
      forestHorizonOwnerChunkCount: owners.filter(owner => owner.includeForestHorizon).length,
      forestHorizonOnlyOwnerChunkCount: owners.filter(forestHorizonOnlyOwner).length,
      forestHorizonOwnerChunkKeys: owners.filter(owner => (
        owner.includeForestHorizon
      )).map(owner => owner.key),
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
      forestHorizonOwnerChunkCacheHits:
        forestHorizonOwnerChunkCacheHits - cacheBefore.forestHorizonHits,
      forestHorizonOwnerChunkCacheMisses:
        forestHorizonOwnerChunkCacheMisses - cacheBefore.forestHorizonMisses,
      forestHorizonOwnerChunkCacheEvictions:
        forestHorizonOwnerChunkCacheEvictions - cacheBefore.forestHorizonEvictions,
      innerWarmDurationMs,
      ultraWarmDurationMs,
      forestHorizonWarmDurationMs,
      queryPreparationDurationMs: (globalThis.performance?.now?.() ?? Date.now()) - queryStartedAt,
      templateResolutionDurationMs,
      canonicalChunkSuccessCount: chunks.filter(value => value.chunk).length,
      naturalCandidateCount: chunks.reduce((sum, value) => {
        if ((!value.includeNaturalInner && !value.includeNaturalUltra
          && !value.includeForestHorizon) || !value.chunk) return sum;
        const vegetation = value.chunk.presentationLayers?.natural?.vegetation
          ?? value.chunk.vegetationCandidates ?? [];
        return sum + vegetation.filter(candidate => isW8NaturalCandidateVisible(candidate)
          && (!forestHorizonOnlyOwner(value) || candidate.subtype !== 'shrub')
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
      settlementIds: new Set(localSelections.map(value => value.candidate.settlementId)),
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
    recordDiagnosticEvent('terrain-replacement-requested', {
      coverageEpoch: requestedEpoch,
      transitionGeneration: acceptedTransition?.generation ?? null,
      centerChunkX,
      centerChunkZ,
      renderDistancePreset: normalizeW8RenderDistancePreset(renderDistancePreset),
      oldRootId: activeLocalTerrainGeneration?.root?.name ?? null,
      oldRootAttached: activeLocalTerrainGeneration?.root?.parent === root,
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
      recordDiagnosticEvent('terrain-replacement-reused', {
        coverageEpoch: requestedEpoch,
        transitionGeneration: acceptedTransition?.generation ?? null,
        rootId: activeLocalTerrainGeneration.root.name,
        rootAttached: activeLocalTerrainGeneration.root.parent === root,
      });
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
    recordDiagnosticEvent('terrain-replacement-ready', {
      coverageEpoch: requestedEpoch,
      transitionGeneration: acceptedTransition?.generation ?? null,
      rootId: generation.root.name,
      rootAttached: generation.root.parent === root,
      geometryCount: generation.ownedGeometries.size,
      oldRootId: previous?.root?.name ?? null,
      oldRootAttached: previous?.root?.parent === root,
    });
    if (generation.reusedMidgroundGeometry) {
      previous?.ownedGeometries.delete(generation.reusedMidgroundGeometry);
      generation.ownedGeometries.add(generation.reusedMidgroundGeometry);
    }
    const swapStartedAt = monotonicNow();
    root.add(generation.root);
    activeLocalTerrainGeneration = generation;
    recordDiagnosticEvent('terrain-replacement-attached', {
      coverageEpoch: requestedEpoch,
      transitionGeneration: acceptedTransition?.generation ?? null,
      rootId: generation.root.name,
      rootAttached: generation.root.parent === root,
      oldRootId: previous?.root?.name ?? null,
      oldRootAttached: previous?.root?.parent === root,
    });
    committedLocalTerrainEpoch = requestedEpoch;
    localTerrainCommitCount += 1;
    currentCanonicalSurfacePolicy = surfacePolicy;
    retireGeneration(previous);
    recordDiagnosticEvent('terrain-old-released', {
      coverageEpoch: requestedEpoch,
      transitionGeneration: acceptedTransition?.generation ?? null,
      newRootId: generation.root.name,
      newRootAttached: generation.root.parent === root,
      oldRootId: previous?.root?.name ?? null,
      oldRootAttached: previous?.root?.parent === root,
    });
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

  const snapshotRemoteHorizonAtmospheres = generation => {
    if (!generation) return Object.freeze({
      settlements: Object.freeze({}),
      buildings: Object.freeze({}),
    });
    const settlements = new Map();
    const buildings = new Map();
    for (const object of generation.canonicalObjects.values()) {
      if (!object.remoteHorizon) continue;
      const buildingDistanceMeters = Math.hypot(
        object.worldX - generation.playerX,
        object.worldZ - generation.playerZ,
      );
      const atmosphere = resolveW8RemoteSettlementAtmosphere({
        boundaryDistanceMeters: buildingDistanceMeters,
        quality: generation.quality,
        renderDistancePreset: generation.renderDistancePreset,
      });
      buildings.set(object.stableId, Object.freeze({
        settlementId: object.settlementId,
        distanceMeters: buildingDistanceMeters,
        worldX: object.worldX,
        worldZ: object.worldZ,
        visibleLod: object.visibleLod,
        presentationTier: object.presentationTier,
        ...atmosphere,
      }));
      if (!settlements.has(object.settlementId)) {
        const centerDistanceMeters = Math.hypot(
          object.settlementCenterX - generation.playerX,
          object.settlementCenterZ - generation.playerZ,
        );
        const boundaryDistanceMeters = Math.max(
          0,
          centerDistanceMeters - object.settlementRadiusMeters,
        );
        settlements.set(object.settlementId, Object.freeze({
          boundaryDistanceMeters,
          ...resolveW8RemoteSettlementAtmosphere({
            boundaryDistanceMeters,
            quality: generation.quality,
            renderDistancePreset: generation.renderDistancePreset,
          }),
        }));
      }
    }
    const sortedObject = values => Object.freeze(Object.fromEntries(
      [...values.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ));
    return Object.freeze({
      settlements: sortedObject(settlements),
      buildings: sortedObject(buildings),
    });
  };
  const emptyRemoteHorizonAtmospheres = Object.freeze({
    settlements: Object.freeze({}),
    buildings: Object.freeze({}),
  });

  const snapshotSettlementSelections = generation => {
    if (!generation) return Object.freeze([]);
    const objectsBySettlement = new Map();
    for (const object of generation.canonicalObjects.values()) {
      if (!object.settlementId) continue;
      if (!objectsBySettlement.has(object.settlementId)) {
        objectsBySettlement.set(object.settlementId, []);
      }
      objectsBySettlement.get(object.settlementId).push(object);
    }
    return Object.freeze((generation.settlementSelections ?? []).map(selection => {
      const objects = objectsBySettlement.get(selection.settlementId) ?? [];
      const stableIdSuppressionCount = objects.filter(object => (
        generation.nearVisibleStableIds.has(object.stableId)
      )).length;
      const visibleInstanceCount = objects.reduce((sum, object) => {
        if (!['mid', 'far'].includes(object.visibleLod) || !object.presentationTier) return sum;
        return sum + object.instances.filter(instance => (
          canonicalInstanceOpacity(object, instance.item) > 0
        )).length;
      }, 0);
      return Object.freeze({
        ...selection,
        presentationStableIdCount: objects.length,
        stableIdSuppressionCount,
        registeredInstanceCount: objects.reduce((sum, object) => (
          sum + object.instances.length
        ), 0),
        visibleInstanceCount,
      });
    }));
  };

  const snapshotTreeRenderPaths = () => {
    const entries = new Map(Object.values(TREE_RENDER_PATH).map(pathId => [pathId, {
      pathId,
      rootNames: new Set(),
      meshes: [],
      ownerKeys: new Set(),
      stableIds: new Set(),
      instanceCount: 0,
      active: false,
      publicationSources: new Set(),
      planIds: new Set(),
      coverageGenerations: new Set(),
      matrixUpdateCount: 0,
      bufferUpdateCount: 0,
      visibilityChangeCount: 0,
      lastUpdateAtMs: null,
    }]));
    const collect = generation => {
      if (!generation) return;
      const persistent = generation.persistentTree === true;
      const publicationSource = persistent
        ? 'static-owner-page-ticket' : 'distant-atomic-root';
      for (const bucket of generation.canonicalBuckets?.values?.() ?? []) {
        const pathId = bucket.mesh?.userData?.treePathId
          ?? treePathIdForBucket(bucket, generation);
        if (!pathId) continue;
        const entry = entries.get(pathId);
        const stableIds = (bucket.mesh?.userData?.canonicalStableIds ?? [])
          .slice(0, bucket.mesh?.count ?? 0)
          .filter(stableId => typeof stableId === 'string');
        entry.rootNames.add(generation.root?.name ?? 'unknown');
        entry.instanceCount += bucket.mesh?.count ?? 0;
        entry.active ||= generation.root?.visible !== false
          && bucket.mesh?.visible !== false && (bucket.mesh?.count ?? 0) > 0;
        entry.publicationSources.add(publicationSource);
        if (persistentTreePlanId) entry.planIds.add(persistentTreePlanId);
        if (persistent) entry.coverageGenerations.add(persistentTreeCoverageGeneration);
        for (const stableId of stableIds) entry.stableIds.add(stableId);
        for (const object of bucket.items?.map?.(item => item.object) ?? []) {
          if (stableIds.includes(object.stableId)) entry.ownerKeys.add(object.ownerKey);
        }
        entry.meshes.push(Object.freeze({
          name: bucket.mesh?.name ?? null,
          materialName: bucket.mesh?.material?.name
            || bucket.mesh?.material?.type
            || bucket.mesh?.material?.constructor?.name
            || null,
          count: bucket.mesh?.count ?? 0,
          visible: generation.root?.visible !== false && bucket.mesh?.visible !== false,
          mode: bucket.mesh?.userData?.treePathMode ?? parseNaturalLodBucket(bucket)?.mode ?? null,
        }));
        entry.lastUpdateAtMs = Math.max(
          entry.lastUpdateAtMs ?? 0,
          generation.treeLastUpdateAtMs ?? 0,
        ) || null;
      }
      const primaryPathId = persistent ? TREE_RENDER_PATH.STATIC : TREE_RENDER_PATH.LEGACY;
      const primary = entries.get(primaryPathId);
      primary.matrixUpdateCount += persistent
        ? persistentTreeMatrixUpdateCount
        : generation.stats?.canonicalMatrixUpdateCount ?? 0;
      primary.bufferUpdateCount += persistent
        ? persistentTreeAttributeUpdateCount
        : generation.stats?.canonicalNeedsUpdateCount ?? 0;
      primary.visibilityChangeCount += generation.treeVisibilityChangeCount ?? 0;
    };
    collect(activeGeneration);
    collect(persistentTreeGeneration);
    return Object.freeze([...entries.values()].map(entry => {
      const state = treePathAuditState.get(entry.pathId);
      return Object.freeze({
        pathId: entry.pathId,
        rootNames: Object.freeze([...entry.rootNames]),
        rootCount: entry.rootNames.size,
        meshes: Object.freeze(entry.meshes),
        meshCount: entry.meshes.length,
        materialNames: Object.freeze([...new Set(entry.meshes
          .map(mesh => mesh.materialName).filter(Boolean))]),
        instanceCount: entry.instanceCount,
        ownerCount: entry.ownerKeys.size,
        stableIdCount: entry.stableIds.size,
        firstDrawAtMs: state?.firstDrawAtMs ?? null,
        lastUpdateAtMs: entry.lastUpdateAtMs,
        matrixUpdateCount: entry.matrixUpdateCount,
        bufferUpdateCount: entry.bufferUpdateCount,
        visibilityChangeCount: entry.visibilityChangeCount,
        disposeCount: state?.disposeCount ?? 0,
        active: entry.active,
        hidden: !entry.active,
        publicationSources: Object.freeze([...entry.publicationSources]),
        planIds: Object.freeze([...entry.planIds]),
        coverageGenerations: Object.freeze([...entry.coverageGenerations]),
      });
    }));
  };

  const snapshotTreeMaterials = () => {
    const source = ['treeLeaves', 'treeLeavesForest', 'treeLeavesMeadow']
      .filter(key => visualAssets.materials?.[key])
      .map(key => snapshotMaterial(`exact:${key}`, visualAssets.materials[key]));
    const generated = [];
    const seen = new Set();
    for (const [generationPath, generation] of [
      ['legacy-distant', activeGeneration],
      ['persistent-natural', persistentTreeGeneration],
    ]) {
      for (const material of generation?.naturalLodMaterials?.values?.() ?? []) {
        if (material?.userData?.naturalLodKind !== W8_VEGETATION_LOD_KINDS.TREE
          || seen.has(material)) continue;
        seen.add(material);
        generated.push(snapshotMaterial(
          `${generationPath}:${material.userData?.naturalLodMode ?? 'unknown'}`,
          material,
        ));
      }
    }
    return Object.freeze({
      schemaVersion: 'w8-tree-material-audit-1',
      source: Object.freeze(source),
      generated: Object.freeze(generated.sort((left, right) => (
        left.path.localeCompare(right.path)
      ))),
    });
  };

  const snapshotVisibleRootRevisions = () => Object.freeze([
    Object.freeze({
      role: 'distant',
      rootName: activeGeneration?.root?.name ?? null,
      attached: activeGeneration?.root?.parent === root,
      visible: activeGeneration?.root?.visible !== false,
      renderDistancePreset: activeGeneration?.renderDistancePreset ?? null,
      transitionGeneration: activeGeneration?.transitionContract?.generation ?? null,
      coverageSignature: activeGeneration?.transitionContract?.coverageSignature ?? null,
      publicationPlanId: settlementPublicationPlanId,
      publicationRevision: settlementPublicationRevision,
    }),
    Object.freeze({
      role: 'local-terrain',
      rootName: activeLocalTerrainGeneration?.root?.name ?? null,
      attached: activeLocalTerrainGeneration?.root?.parent === root,
      visible: activeLocalTerrainGeneration?.root?.visible !== false,
      renderDistancePreset: activeLocalTerrainGeneration?.renderDistancePreset ?? null,
      transitionGeneration:
        activeLocalTerrainGeneration?.transitionContract?.generation ?? null,
      coverageSignature:
        activeLocalTerrainGeneration?.transitionContract?.coverageSignature ?? null,
      coverageEpoch: committedLocalTerrainEpoch,
    }),
    Object.freeze({
      role: 'persistent-natural',
      rootName: persistentTreeGeneration?.root?.name ?? null,
      attached: persistentTreeGeneration?.root?.parent === scene,
      visible: persistentTreeGeneration?.root?.visible !== false,
      renderDistancePreset: persistentTreeGeneration?.renderDistancePreset ?? null,
      planId: persistentTreePlanId,
      coverageGeneration: persistentTreeCoverageGeneration,
      planRevision: persistentTreePlanRevision,
    }),
    Object.freeze({
      role: 'prepared-distant',
      rootName: preparedRenderDistanceDistant?.generation?.root?.name ?? null,
      attached: preparedRenderDistanceDistant?.generation?.root?.parent === root,
      visible: preparedRenderDistanceDistant?.generation?.root?.visible !== false,
      renderDistancePreset:
        preparedRenderDistanceDistant?.generation?.renderDistancePreset ?? null,
      transitionGeneration:
        preparedRenderDistanceDistant?.generation?.transitionContract?.generation ?? null,
    }),
    Object.freeze({
      role: 'prepared-local-terrain',
      rootName: preparedRenderDistanceLocalTerrain?.generation?.root?.name ?? null,
      attached: preparedRenderDistanceLocalTerrain?.generation?.root?.parent === root,
      visible: preparedRenderDistanceLocalTerrain?.generation?.root?.visible !== false,
      renderDistancePreset:
        preparedRenderDistanceLocalTerrain?.generation?.renderDistancePreset ?? null,
      transitionGeneration:
        preparedRenderDistanceLocalTerrain?.generation?.transitionContract?.generation ?? null,
    }),
  ]);

  const snapshotPresenterAudit = () => {
    const visibleStableIds = generation => new Set([
      ...(generation?.canonicalObjects?.values?.() ?? []),
    ].filter(object => (
      !['hidden', 'destroyed'].includes(object.visibleLod)
      && object.presentationTier !== null
      && object.instances.some(instance => (
        instance.bucket?.mesh?.visible !== false
        && canonicalInstanceOpacity(object, instance.item) > 0
      ))
    )).map(object => object.stableId));
    const legacy = visibleStableIds(activeGeneration);
    const persistent = visibleStableIds(persistentTreeGeneration);
    const overlaps = [...persistent].filter(stableId => legacy.has(stableId)).sort();
    return Object.freeze({
      schemaVersion: 'w8-presenter-audit-1',
      legacyDistantVisibleStableIdCount: legacy.size,
      persistentNaturalVisibleStableIdCount: persistent.size,
      legacyDistantVisibleStableIds: Object.freeze([...legacy].sort()),
      persistentNaturalVisibleStableIds: Object.freeze([...persistent].sort()),
      duplicatePresenterCount: overlaps.length,
      duplicateStableIds: Object.freeze(overlaps),
      buildingPublicationSource,
      settlementRoadPublicationSource,
      settlementMetadataPublicationSource,
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
      retireGeneration(previous);
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
      deferPublication = false,
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
      if (deferPublication) {
        if (preparedRenderDistanceLocalTerrain) {
          disposeGeneration(preparedRenderDistanceLocalTerrain.generation);
        }
        preparedRenderDistanceLocalTerrain = {
          generation,
          previous,
          reusableMidgroundMesh,
          requestedEpoch,
        };
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
        return Object.freeze({
          committed: false,
          prepared: true,
          reused: false,
          coverageEpoch: requestedEpoch,
          reason: null,
          missingOwnerKeys: Object.freeze([]),
          activeRootId: previous.root.name,
        });
      }
      previous.ownedGeometries.delete(reusableMidgroundMesh.geometry);
      generation.ownedGeometries.add(reusableMidgroundMesh.geometry);
      const swapStartedAt = globalThis.performance?.now?.() ?? Date.now();
      root.add(generation.root);
      activeLocalTerrainGeneration = generation;
      committedLocalTerrainEpoch = requestedEpoch;
      localTerrainCommitCount += 1;
      retireGeneration(previous);
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
      revealNatural = false,
      naturalRevealInnerMeters = 0,
      deferPublication = false,
      preserveStaticNatural = false,
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
      recordDiagnosticEvent('distant-sync-requested', {
        syncEpoch: syncEpoch + 1,
        transitionGeneration: acceptedTransition?.generation ?? null,
        renderDistancePreset: requestedRenderDistancePreset,
        includeFarNatural,
        includeUltraNatural,
        preserveStaticNatural,
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
        recordDiagnosticEvent('distant-query-ready', {
          syncEpoch: epoch,
          transitionGeneration: acceptedTransition?.generation ?? null,
          renderDistancePreset: requestedRenderDistancePreset,
          naturalOwnerCount: far.naturalOwnerChunkCount,
          naturalCandidateCount: far.naturalCandidateCount,
          buildingOwnerCount: far.buildingOwnerChunkCount,
          settlementCandidateCount: far.candidateCount,
          naturalWillBeExcludedFromDistantRoot: incrementalStaticTreePages,
        });
        if (diagnosticsEnabled) recordDiagnosticWork('legacy-distant-query', {
          calls: 1,
          naturalOwnersQueried: far.naturalOwnerChunkCount,
          naturalCandidatesEnumerated: far.naturalCandidateCount,
          buildingOwnersQueried: far.buildingOwnerChunkCount,
          settlementCandidatesEnumerated: far.candidateCount,
          naturalCandidatesDiscardedByPersistentPath: incrementalStaticTreePages
            ? far.naturalCandidateCount : 0,
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
        ...far.chunks.filter(value => !(
          value.includeForestHorizon
            && !value.includeNaturalInner
            && !value.includeNaturalUltra
        )).map(value => value.chunk),
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

      if (incrementalStaticTreePages && !preserveStaticNatural) {
        if (!persistentTreeGeneration
          || persistentTreeGeneration.quality !== quality
          || persistentTreeGeneration.renderDistancePreset !== requestedRenderDistancePreset) {
          if (persistentTreeGeneration) deferGenerationDispose(persistentTreeGeneration);
          persistentTreeGeneration = createPersistentNaturalGeneration({
            quality,
            renderDistancePreset: requestedRenderDistancePreset,
            renderOrigin,
          });
          persistentTreePages.clear();
          pendingPersistentTreePages.clear();
          pendingPersistentTreePublications.clear();
          persistentTreePublishedOwners.clear();
          persistentTreeDisposeOwners.length = 0;
          persistentTreeDesiredResourceKinds.clear();
          persistentTreeVisibilityDirty = true;
        }
        persistentTreeGeneration.playerX = playerLogicalX;
        persistentTreeGeneration.playerZ = playerLogicalZ;
        persistentTreeGeneration.activeKeys = new Set(activeDataKeys);
        persistentTreeGeneration.renderedKeys = new Set(renderedKeys);
        positionGenerationForOrigin(persistentTreeGeneration, renderOrigin);
        // Seed only the already-resident gameplay coverage before the first
        // frame. The wider ready-set is published incrementally afterwards.
        for (const chunk of [...activeChunks.values()].sort((left, right) => (
          left.chunkZ - right.chunkZ || left.chunkX - right.chunkX
        ))) {
          const ownerKey = `${chunk.chunkX},${chunk.chunkZ}`;
          persistentTreeDesiredResourceKinds.set(ownerKey, 'canonical');
          const resident = persistentTreePages.get(ownerKey);
          if (resident?.resourceKind === 'canonical'
            && resident.contentHash === (chunk.contentHash ?? null)) continue;
          await enqueuePersistentNaturalOwnerBuild({
            ownerKey,
            resourceKind: 'canonical',
            value: chunk,
            readyAtMs: monotonicNow(),
            planId: null,
            coverageGeneration: persistentTreeCoverageGeneration,
            planRevision: persistentTreePlanRevision,
          });
        }
        updateCanonicalVisibility(
          persistentTreeGeneration,
          playerLogicalX,
          playerLogicalZ,
          { compose: false },
        );
        persistentTreeVisibilityDirty = false;
      }

      const stagingRoot = new Group();
      stagingRoot.name = `w8-distant-presentation-epoch-${epoch}`;
      stagingRoot.userData = {
        presentationOnly: true,
        epoch,
        renderDistancePreset: requestedRenderDistancePreset,
        treePathId: incrementalStaticTreePages ? null : TREE_RENDER_PATH.LEGACY,
        treeNaturalExcluded: incrementalStaticTreePages,
        staticNaturalExcluded: incrementalStaticTreePages,
        buildingPublicationSource,
        settlementRoadPublicationSource,
        settlementMetadataPublicationSource,
      };
      const naturalRevealInitialByStableId = new Map();
      const presentationBuildOrigin = activeGeneration && persistentDistantRoot
        ? Object.freeze({
          renderOriginChunkX: activeGeneration.buildOriginChunkX,
          renderOriginChunkZ: activeGeneration.buildOriginChunkZ,
          rebaseCount: renderOrigin.rebaseCount,
        })
        : renderOrigin;
      if (revealNatural && activeGeneration) {
        for (const stableId of activeGeneration.distantVisibleStableIds ?? []) {
          const previousObject = activeGeneration.canonicalObjects.get(stableId);
          if (!previousObject?.naturalKind) continue;
          naturalRevealInitialByStableId.set(stableId, Math.max(
            activeGeneration.naturalRevealInitialByStableId?.get(stableId) ?? 0,
            activeGeneration.naturalReveal,
          ));
        }
        for (const stableId of readNearVisibleSnapshotState().stableIds) {
          naturalRevealInitialByStableId.set(stableId, 1);
        }
      }
      const generation = {
        epoch,
        root: stagingRoot,
        excludeTreeNatural: incrementalStaticTreePages,
        excludeNatural: incrementalStaticTreePages,
        persistentDistant: incrementalStaticTreePages,
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
        settlementPresentationPolicy: resolveW8SettlementPresentationPolicy(
          quality,
          requestedRenderDistancePreset,
        ),
        localFullHandoffMaterials: new Map(),
        naturalLodMaterials: new Map(),
        naturalLodPolicies: new Map(),
        naturalReveal: revealNatural ? 0 : 1,
        naturalRevealInnerMeters: Math.max(0, Number(naturalRevealInnerMeters) || 0),
        naturalRevealInitialByStableId,
        naturalRevealStartedAt: null,
        horizonBuildingSilhouetteMaterial: null,
        remoteHorizonSilhouetteMaterial: null,
        buildOriginChunkX: presentationBuildOrigin.renderOriginChunkX,
        buildOriginChunkZ: presentationBuildOrigin.renderOriginChunkZ,
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
        remoteHorizonFadeEndMeters: far.remoteFadeEndMeters,
        remoteHorizonHiddenDistanceMeters: far.remoteHiddenDistanceMeters,
        remoteHorizonFogEnabled: far.remoteFogEnabled,
        remoteHorizonAtmosphereMode: far.remoteAtmosphereMode,
        remoteHorizonFogIntegrationEndMeters: far.remoteFogIntegrationEndMeters,
        settlementMetadataQueryDistanceMeters: far.settlementMetadataQueryDistanceMeters,
        queryOwnerChunkCount: far.ownerChunkCount,
        queryOwnerChunkKeys: far.ownerChunkKeys,
        queryNaturalOwnerChunkCount: far.naturalOwnerChunkCount,
        queryNaturalOwnerChunkKeys: far.naturalOwnerChunkKeys,
        queryInnerNaturalOwnerChunkCount: far.innerNaturalOwnerChunkCount,
        queryUltraOwnerChunkCount: far.ultraOwnerChunkCount,
        queryUltraOnlyOwnerChunkCount: far.ultraOnlyOwnerChunkCount,
        queryUltraOwnerChunkKeys: far.ultraOwnerChunkKeys,
        queryForestHorizonOwnerChunkCount: far.forestHorizonOwnerChunkCount,
        queryForestHorizonOnlyOwnerChunkCount: far.forestHorizonOnlyOwnerChunkCount,
        queryForestHorizonOwnerChunkKeys: far.forestHorizonOwnerChunkKeys,
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
        queryForestHorizonOwnerChunkCacheHits: far.forestHorizonOwnerChunkCacheHits,
        queryForestHorizonOwnerChunkCacheMisses: far.forestHorizonOwnerChunkCacheMisses,
        queryForestHorizonOwnerChunkCacheEvictions: far.forestHorizonOwnerChunkCacheEvictions,
        innerWarmDurationMs: far.innerWarmDurationMs,
        ultraWarmDurationMs: far.ultraWarmDurationMs,
        forestHorizonWarmDurationMs: far.forestHorizonWarmDurationMs,
        queryPreparationDurationMs: far.queryPreparationDurationMs,
        templateResolutionDurationMs: far.templateResolutionDurationMs,
        queryCanonicalChunkSuccessCount: far.canonicalChunkSuccessCount,
        querySettlementFeatureCount: far.settlementFeatureCount,
        queryMajorRoadFeatureCount: far.majorRoadFeatureCount,
        queryLandmarkCount: far.landmarkCount,
        queryRadius: far.queryRadius,
        visibilityMeters: far.visibilityMeters,
        naturalVisibilityMeters: far.naturalVisibilityMeters,
        forestHorizonVisibilityMeters: far.forestHorizonVisibilityMeters,
        naturalQueryRadius: far.naturalQueryRadius,
        activeLocalSettlementId: far.activeLocalSettlementId,
        additionalLocalSettlementIds: Object.freeze([...far.additionalLocalSettlementIds]),
        localSettlementIds: new Set(far.localSettlementIds),
        localSettlementLimit: far.localSettlementLimit,
        settlementSelections: far.settlementSelections,
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
            origin: presentationBuildOrigin,
            coveredSettlementIds: far.settlementIds,
            includeNatural: true,
            farNaturalEligible: true,
            includeForestHorizon: isW8ForestHorizonOwner({
              worldSeedHash,
              chunkX: chunk.chunkX,
              chunkZ: chunk.chunkZ,
            }),
            includeNearDetails: true,
            context,
            scheduler,
          });
        }
        await scheduler.checkpoint({ force: true });
        for (const source of far.chunks) {
          await addCanonicalChunk({
            chunk: source.chunk,
            origin: presentationBuildOrigin,
            farEligibleSettlementIds: source.settlementIds,
            includeNatural: source.includeNaturalInner || source.includeNaturalUltra
              || source.includeForestHorizon,
            farNaturalEligible: source.includeNaturalInner || source.includeNaturalUltra
              || source.includeForestHorizon,
            includeForestHorizon: source.includeForestHorizon,
            naturalHorizonOnly: source.includeForestHorizon
              && !source.includeNaturalInner && !source.includeNaturalUltra,
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
            remote, origin: presentationBuildOrigin, context, scheduler,
          });
        }
        generation.stats.remoteSettlementCandidateCount = far.remoteCandidateCount;
        generation.stats.remoteSettlementSelectedCount = far.remoteSelectedCount;
        await scheduler.checkpoint({ force: true });
        await finalizeCanonicalMeshesIncrementally(context, scheduler);
        await scheduler.checkpoint({ force: true });
        await createFarRiverPresentation({
          projections: far.riverProjections, origin: presentationBuildOrigin, context, scheduler,
        });
        await createDistantWaterProxies({
          centerChunkX,
          centerChunkZ,
          origin: presentationBuildOrigin,
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
      // Re-read Near ownership and feature damage after the last asynchronous
      // slice. A Tree destroyed while this staging generation was composing
      // must never publish a stale Full/Forest/Atmospheric/Horizon instance.
      const commitDirtyBuckets = updateCanonicalVisibility(
        generation,
        playerLogicalX,
        playerLogicalZ,
        { compose: false },
      );
      if (commitDirtyBuckets.size) composeCanonicalMeshes(generation, commitDirtyBuckets);
      const previous = activeGeneration;
      generation.staticPublicationTickets = (!incrementalStaticTreePages
        ? publishStaticOwnerTickets?.({
        ownerKeys: Object.freeze([...new Set([
          ...generation.queryNaturalOwnerChunkKeys,
          ...generation.queryForestHorizonOwnerChunkKeys,
        ])]),
        publicationGroup: 'natural-static',
        epoch,
      }) : null) ?? Object.freeze([]);
      const rootSwapStartedAt = globalThis.performance?.now?.() ?? Date.now();
      committedEpoch = epoch;
      if (deferPublication) {
        if (preparedRenderDistanceDistant) disposeGeneration(
          preparedRenderDistanceDistant.generation,
        );
        preparedRenderDistanceDistant = { generation, previous };
        generation.syncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - syncStartedAt;
        pendingFarSyncEpochs.delete(epoch);
        return true;
      }
      if (incrementalStaticTreePages && previous && persistentDistantRoot) {
        beginPersistentDistantPublication(generation, previous);
      } else {
        root.add(generation.root);
        activeGeneration = generation;
        if (generation.naturalReveal < 1) generation.naturalRevealStartedAt = monotonicNow();
        recordDistantPublication(generation);
        retireGeneration(previous);
        if (incrementalStaticTreePages) {
          persistentDistantRoot = generation.root;
          persistentDistantPublishedGeneration = generation;
          liveDistantEntries.clear();
          for (const [key, entry] of directCanonicalMeshEntries(generation)) {
            liveDistantEntries.set(key, entry);
          }
          for (const [key, entry] of directAuxiliaryMeshEntries(generation)) {
            liveDistantEntries.set(key, entry);
          }
        }
      }
      generation.rootSwapDurationMs = (globalThis.performance?.now?.() ?? Date.now())
        - rootSwapStartedAt;
      recordDiagnosticEvent('distant-publication-queued', {
        syncEpoch: epoch,
        transitionGeneration: acceptedTransition?.generation ?? null,
        renderDistancePreset: requestedRenderDistancePreset,
        persistentPublication: incrementalStaticTreePages && previous && persistentDistantRoot
          ? true : false,
        rootAttached: generation.root.parent === root,
        naturalExcluded: generation.excludeNatural === true,
      });
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
    stageStaticNaturalRenderDistancePreset(renderDistancePreset) {
      stagedPersistentNaturalRenderDistancePreset = normalizeW8RenderDistancePreset(
        renderDistancePreset,
      );
      return stagedPersistentNaturalRenderDistancePreset;
    },
    isStaticNaturalCoverageReady(ownerKeys = []) {
      return Array.isArray(ownerKeys) && ownerKeys.every(ownerKey => (
        persistentTreePublishedOwners.has(ownerKey)
          && !pendingPersistentTreePages.has(ownerKey)
          && !pendingPersistentTreePublications.has(ownerKey)
      ));
    },
    commitPreparedRenderDistancePreset(renderDistancePreset) {
      const preset = normalizeW8RenderDistancePreset(renderDistancePreset);
      const distant = preparedRenderDistanceDistant;
      const localTerrain = preparedRenderDistanceLocalTerrain;
      if (!distant || !localTerrain
        || distant.generation.renderDistancePreset !== preset
        || localTerrain.generation.renderDistancePreset !== preset
        || stagedPersistentNaturalRenderDistancePreset !== preset
        || distant.previous !== activeGeneration
        || localTerrain.previous !== activeLocalTerrainGeneration) return false;
      const distantGeneration = distant.generation;
      root.add(distantGeneration.root);
      activeGeneration = distantGeneration;
      recordDistantPublication(distantGeneration);
      retireGeneration(distant.previous);
      persistentDistantRoot = distantGeneration.root;
      persistentDistantPublishedGeneration = distantGeneration;
      liveDistantEntries.clear();
      for (const [key, entry] of directCanonicalMeshEntries(distantGeneration)) {
        liveDistantEntries.set(key, entry);
      }
      for (const [key, entry] of directAuxiliaryMeshEntries(distantGeneration)) {
        liveDistantEntries.set(key, entry);
      }
      const localGeneration = localTerrain.generation;
      localTerrain.previous.ownedGeometries.delete(
        localTerrain.reusableMidgroundMesh.geometry,
      );
      localGeneration.ownedGeometries.add(localTerrain.reusableMidgroundMesh.geometry);
      root.add(localGeneration.root);
      activeLocalTerrainGeneration = localGeneration;
      committedLocalTerrainEpoch = localTerrain.requestedEpoch;
      localTerrainCommitCount += 1;
      retireGeneration(localTerrain.previous);
      applyPersistentNaturalRenderDistancePreset(preset);
      localTerrainLastRootSwapDurationMs = 0;
      preparedRenderDistanceDistant = null;
      preparedRenderDistanceLocalTerrain = null;
      return true;
    },
    discardPreparedRenderDistancePreset() {
      if (preparedRenderDistanceDistant) disposeGeneration(
        preparedRenderDistanceDistant.generation,
      );
      if (preparedRenderDistanceLocalTerrain) disposeGeneration(
        preparedRenderDistanceLocalTerrain.generation,
      );
      preparedRenderDistanceDistant = null;
      preparedRenderDistanceLocalTerrain = null;
      stagedPersistentNaturalRenderDistancePreset = null;
    },
    applyStaticTreePlan({
      coverageGeneration,
      planRevision,
      planId,
      destructionRevision = null,
      quality = 'high',
      renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
      renderOrigin,
      playerLogicalX,
      playerLogicalZ,
      activeDataKeys = [],
      renderedKeys = [],
      retainedOwnerKeys = [],
      resourceKindEntries = [],
      policyResourceCoverage = [],
      readyPages = [],
    } = {}) {
      if (!incrementalStaticTreePages || disposed) return false;
      const requestedPreset = normalizeW8RenderDistancePreset(renderDistancePreset);
      const reset = !persistentTreeGeneration
        || persistentTreeGeneration.quality !== quality
        || persistentTreeGeneration.renderDistancePreset !== requestedPreset;
      if (reset) {
        if (persistentTreeGeneration) deferGenerationDispose(persistentTreeGeneration);
        persistentTreeGeneration = createPersistentNaturalGeneration({
          quality,
          renderDistancePreset: requestedPreset,
          renderOrigin,
        });
        persistentTreePages.clear();
        pendingPersistentTreePages.clear();
        pendingPersistentTreePublications.clear();
        persistentTreePublishedOwners.clear();
        persistentTreeDisposeOwners.length = 0;
        persistentTreeDesiredResourceKinds.clear();
        persistentTreeVisibilityDirty = true;
        persistentTreeRootResetCount += 1;
      }
      if (persistentTreeStateRevision !== destructionRevision) {
        persistentTreeVisibilityDirty = true;
      }
      persistentTreeCoverageGeneration = coverageGeneration;
      persistentTreePlanRevision = planRevision;
      persistentTreePlanId = planId;
      persistentTreeStateRevision = destructionRevision;
      persistentTreeGeneration.playerX = playerLogicalX;
      persistentTreeGeneration.playerZ = playerLogicalZ;
      persistentTreeGeneration.activeKeys = new Set(activeDataKeys);
      persistentTreeGeneration.renderedKeys = new Set(renderedKeys);
      applyPersistentNaturalPolicyCoverage(
        persistentTreeGeneration,
        policyResourceCoverage,
      );
      const retained = new Set(retainedOwnerKeys);
      persistentTreeDesiredResourceKinds.clear();
      for (const entry of resourceKindEntries) {
        if (!Array.isArray(entry) || entry.length !== 2 || !retained.has(entry[0])) continue;
        if (!['canonical', 'manifest'].includes(entry[1])) continue;
        persistentTreeDesiredResourceKinds.set(entry[0], entry[1]);
      }
      for (let index = persistentTreeDisposeOwners.length - 1; index >= 0; index -= 1) {
        if (retained.has(persistentTreeDisposeOwners[index])) {
          persistentTreeDisposeOwners.splice(index, 1);
        }
      }
      for (const ownerKey of persistentTreePages.keys()) {
        if (!retained.has(ownerKey) && !persistentTreeDisposeOwners.includes(ownerKey)) {
          persistentTreeDisposeOwners.push(ownerKey);
        }
      }
      for (const ownerKey of pendingPersistentTreePages.keys()) {
        const pending = pendingPersistentTreePages.get(ownerKey);
        if (!retained.has(ownerKey)
          || (persistentTreeDesiredResourceKinds.has(ownerKey)
            && persistentTreeDesiredResourceKinds.get(ownerKey) !== pending.resourceKind)) {
          pendingPersistentTreePages.delete(ownerKey);
          persistentTreeStalePageDiscardCount += 1;
        }
      }
      for (const page of readyPages) {
        if (!retained.has(page.ownerKey)) continue;
        const desiredResourceKind = persistentTreeDesiredResourceKinds.get(page.ownerKey);
        if (desiredResourceKind && desiredResourceKind !== page.resourceKind) {
          persistentTreeStalePageDiscardCount += 1;
          continue;
        }
        persistentTreeAdmissionsSinceFrame += 1;
        if (Number.isSafeInteger(page.coverageGeneration)
          && page.coverageGeneration < coverageGeneration) {
          persistentTreeOlderCoveragePageCount += 1;
        }
        const existing = persistentTreePages.get(page.ownerKey);
        if (existing?.resourceKind === page.resourceKind
          && existing.contentHash === (page.value?.contentHash ?? null)) {
          persistentTreeOwnerReuseCount += 1;
          if (persistentTreePublishedOwners.has(page.ownerKey)) {
            publishStaticOwnerTickets?.({
              ownerKeys: Object.freeze([page.ownerKey]),
              publicationGroup: 'natural-static',
              coverageGeneration,
              planRevision,
            });
          } else {
            pendingPersistentTreePublications.set(page.ownerKey, {
              page: Object.freeze({ ...page, planId, coverageGeneration, planRevision }),
              stableIds: existing.stableIds,
            });
          }
          continue;
        }
        if (existing) persistentTreeOwnerRebuildCount += 1;
        if (pendingPersistentTreePages.has(page.ownerKey)) {
          persistentTreeDuplicatePageQueueCount += 1;
        }
        pendingPersistentTreePages.set(page.ownerKey, Object.freeze({
          ...page,
          planId,
          coverageGeneration,
          planRevision,
        }));
      }
      return true;
    },
    applyStaticNaturalPlan(options) {
      return this.applyStaticTreePlan(options);
    },
    commitRuntimeState(state) {
      if (disposed) return false;
      const committed = commitRuntimePresentationState(state);
      if (committed && persistentTreeGeneration) {
        persistentTreeGeneration.activeKeys = new Set(state.activeDataKeys ?? []);
        persistentTreeGeneration.renderedKeys = new Set(state.renderedKeys ?? []);
        persistentTreeVisibilityDirty = true;
      }
      return committed;
    },
    update(playerLogicalX, playerLogicalZ, renderOrigin) {
      if (disposed) return;
      if (!acceptCommittedRenderOrigin(renderOrigin)) return false;
      const frameStartedAt = monotonicNow();
      const handoffFrame = processRuntimePresentationHandoff();
      const remainingFrameBudgetMs = () => Math.max(
        0,
        RUNTIME_PRESENTATION_FRAME_BUDGET_MS - (monotonicNow() - frameStartedAt),
      );
      const publicationFrame = handoffFrame.meshUpdates > 0
        ? Object.freeze({ admissions: 0, bytes: 0 })
        : processPersistentDistantPublication(remainingFrameBudgetMs());
      if (diagnosticsEnabled) recordDiagnosticWork('runtime-presentation-handoff', {
        calls: 1,
        meshUpdates: handoffFrame.meshUpdates,
        bufferUpdates: handoffFrame.bufferUpdates,
        localTerrainHandoffs: handoffFrame.localTerrainHandoffs,
        distantAdmissions: publicationFrame.admissions,
        distantUploadBytes: publicationFrame.bytes,
      });
      positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
      if (activeGeneration) {
        positionGenerationForOrigin(activeGeneration, renderOrigin);
        if (pendingDistantPublication?.generation === activeGeneration
          || pendingRuntimePresentationHandoff?.targetGeneration === activeGeneration) {
          updateNaturalLodPlayerUniforms(activeGeneration, playerLogicalX, playerLogicalZ);
        } else {
          updateCanonicalVisibility(
            activeGeneration,
            playerLogicalX,
            playerLogicalZ,
            { compose: activeGeneration.persistentDistant !== true },
          );
          if (handoffFrame.meshUpdates === 0 && publicationFrame.admissions === 0) {
            processPersistentDistantVisibility(activeGeneration, remainingFrameBudgetMs());
          }
        }
      }
      if (persistentTreeGeneration) {
        positionGenerationForOrigin(persistentTreeGeneration, renderOrigin);
        persistentTreeGeneration.playerX = playerLogicalX;
        persistentTreeGeneration.playerZ = playerLogicalZ;
        processPersistentNaturalWork(Math.min(
          STATIC_TREE_PAGE_FRAME_BUDGET_MS,
          remainingFrameBudgetMs(),
        ));
      }
      const disposedResources = processDeferredGenerationDisposals(Math.min(
        STATIC_TREE_DISPOSE_BUDGET_MS,
        remainingFrameBudgetMs(),
      ), 1);
      runtimePresentationHandoffDisposeCount += disposedResources;
      runtimePresentationHandoffMaximumDisposePerFrame = Math.max(
        runtimePresentationHandoffMaximumDisposePerFrame,
        disposedResources,
      );
      if (diagnosticsEnabled) recordDiagnosticWork('deferred-resource-dispose', {
        calls: 1,
        disposedResources,
        backlog: deferredGenerationDisposals.length,
      });
      return true;
    },
    rebase(renderOrigin) {
      if (disposed || !acceptCommittedRenderOrigin(renderOrigin)) return false;
      positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
      positionGenerationForOrigin(activeGeneration, renderOrigin);
      positionGenerationForOrigin(persistentTreeGeneration, renderOrigin);
      return true;
    },
    settlementStreamingShadowSnapshot({
      renderDistancePreset = null,
      includePrepared = false,
      frameSequence = null,
      renderDistanceRevision = 0,
      stateRevision = 0,
    } = {}) {
      const requestedPreset = renderDistancePreset === null
        ? null : normalizeW8RenderDistancePreset(renderDistancePreset);
      const preparedGeneration = preparedRenderDistanceDistant?.generation ?? null;
      const generation = includePrepared && preparedGeneration
        && (requestedPreset === null
          || preparedGeneration.renderDistancePreset === requestedPreset)
        ? preparedGeneration : activeGeneration;
      if (!generation) return null;
      settlementShadowSnapshotRequestCount += 1;
      const materialize = () => {
        const diagnosticStartedAt = diagnosticsEnabled ? monotonicNow() : 0;
        settlementShadowSnapshotCount += 1;
        settlementShadowCanonicalObjectScanCount += generation.canonicalObjects.size;
        const stableIds = [];
        const stableIdSet = new Set();
        const settlementIdSet = new Set();
        const settlementOwnerSet = new Set(generation.queryBuildingOwnerChunkKeys ?? []);
        const roadLinkages = [];
        const damageStates = [];
        let duplicateStableIdCount = 0;
        let settlementRecordCount = 0;
        for (const object of generation.canonicalObjects.values()) {
          if (object.settlementId === null || object.settlementId === undefined) continue;
          settlementRecordCount += 1;
          stableIds.push(object.stableId);
          if (stableIdSet.has(object.stableId)) duplicateStableIdCount += 1;
          else stableIdSet.add(object.stableId);
          settlementIdSet.add(object.settlementId);
          settlementOwnerSet.add(object.ownerKey);
          if (object.record?.featureType === 'settlement-road') {
            roadLinkages.push(Object.freeze({
              stableId: object.stableId,
              settlementId: object.settlementId,
              ownerKey: object.ownerKey,
            }));
          }
          if (object.destructible) {
            damageStates.push(Object.freeze({
              stableId: object.stableId,
              destroyed: isFeatureDestroyed(object.stableId) === true,
            }));
          }
        }
        stableIds.sort();
        roadLinkages.sort((left, right) => left.stableId.localeCompare(right.stableId));
        damageStates.sort((left, right) => left.stableId.localeCompare(right.stableId));
        const settlementIds = [...settlementIdSet].sort();
        const buildingOwnerKeys = Object.freeze([
          ...new Set(generation.queryBuildingOwnerChunkKeys ?? []),
        ].sort());
        const settlementOwnerKeys = Object.freeze([...settlementOwnerSet].sort());
        const invalidRoadLinkageCount = roadLinkages.reduce(
          (count, linkage) => count + Number(!settlementIdSet.has(linkage.settlementId)),
          0,
        );
        let snapshotHash = appendSettlementSnapshotHash(0x811c9dc5, generation.epoch);
        snapshotHash = appendSettlementSnapshotHash(snapshotHash, generation.renderDistancePreset);
        for (const ownerKey of buildingOwnerKeys) {
          snapshotHash = appendSettlementSnapshotHash(snapshotHash, ownerKey);
        }
        for (const ownerKey of settlementOwnerKeys) {
          snapshotHash = appendSettlementSnapshotHash(snapshotHash, ownerKey);
        }
        for (const stableId of stableIds) {
          snapshotHash = appendSettlementSnapshotHash(snapshotHash, stableId);
        }
        for (const settlementId of settlementIds) {
          snapshotHash = appendSettlementSnapshotHash(snapshotHash, settlementId);
        }
        for (const linkage of roadLinkages) {
          snapshotHash = appendSettlementSnapshotHash(snapshotHash, linkage.stableId);
          snapshotHash = appendSettlementSnapshotHash(snapshotHash, linkage.settlementId);
          snapshotHash = appendSettlementSnapshotHash(snapshotHash, linkage.ownerKey);
        }
        for (const damageState of damageStates) {
          snapshotHash = appendSettlementSnapshotHash(snapshotHash, damageState.stableId);
          snapshotHash = appendSettlementSnapshotHash(snapshotHash, damageState.destroyed ? 1 : 0);
        }
        settlementShadowStableIdMaterializationCount += stableIds.length;
        if (diagnosticsEnabled) recordDiagnosticWork('settlement-shadow-observation', {
          calls: 1,
          requests: 1,
          cacheMisses: 1,
          canonicalObjectsScanned: generation.canonicalObjects.size,
          settlementRecordsMaterialized: settlementRecordCount,
          stableIdsMaterialized: stableIds.length,
          ownerKeysMaterialized: buildingOwnerKeys.length + settlementOwnerKeys.length,
          roadLinkagesMaterialized: roadLinkages.length,
          damageStatesMaterialized: damageStates.length,
          maximumSynchronousSliceMs: monotonicNow() - diagnosticStartedAt,
        });
        return Object.freeze({
          schemaVersion: 'legacy-building-settlement-observation-1',
          contentHash: `settlement-stream:${snapshotHash.toString(16).padStart(8, '0')}`,
          frameSequence,
          presentationRevision: generation.epoch,
          renderDistanceRevision,
          stateRevision,
          publicationSource: buildingPublicationSource === settlementRoadPublicationSource
            && buildingPublicationSource === settlementMetadataPublicationSource
            ? buildingPublicationSource : 'mixed-exclusive-handoff',
          buildingPublicationSource,
          settlementRoadPublicationSource,
          settlementMetadataPublicationSource,
          publicationPlanId: settlementPublicationPlanId,
          publicationRevision: settlementPublicationRevision,
          renderDistancePreset: generation.renderDistancePreset,
          quality: generation.quality,
          generalVisibilityMeters: generation.visibilityMeters,
          metadataQueryDistanceMeters: generation.settlementMetadataQueryDistanceMeters,
          buildingOwnerKeys,
          settlementOwnerKeys,
          stableIds: Object.freeze(stableIds),
          settlementIds: Object.freeze(settlementIds),
          roadLinkages: Object.freeze(roadLinkages),
          damageStates: Object.freeze(damageStates),
          duplicateStableIdCount,
          duplicateSettlementIdCount: 0,
          invalidRoadLinkageCount,
          canonicalObjectScanCount: generation.canonicalObjects.size,
          settlementRecordCount,
        });
      };
      if (!Number.isSafeInteger(frameSequence) || frameSequence < 0) return materialize();
      const snapshot = settlementStreamingSnapshotCache.read({
        frameSequence,
        presentationRevision: generation.epoch,
        renderDistanceRevision,
        stateRevision,
        materialize,
      });
      if (settlementStreamingSnapshotCache.lastReadReused) {
        settlementShadowSnapshotReuseCount += 1;
        if (diagnosticsEnabled) recordDiagnosticWork('settlement-shadow-observation', {
          requests: 1,
          cacheHits: 1,
        });
      }
      return snapshot;
    },
    canClaimBuildingSettlementPublication(stage, {
      publicationKinds = Object.freeze(['building']),
      observation = stage?.observation ?? null,
      currentObservation = observation,
      stateRevision = null,
      renderDistanceRevision = null,
    } = {}) {
      const preparedGeneration = preparedRenderDistanceDistant?.generation ?? null;
      const generation = preparedGeneration?.renderDistancePreset === stage?.renderDistancePreset
        ? preparedGeneration : activeGeneration;
      if (!generation || !stage || !observation || !currentObservation
        || !Array.isArray(publicationKinds)) {
        return false;
      }
      if (stage.observation !== observation
        || stage.contentHash !== observation.contentHash
        || stage.contentHash !== currentObservation.contentHash
        || stage.renderDistancePreset !== generation.renderDistancePreset
        || observation.presentationRevision !== generation.epoch
        || observation.renderDistanceRevision !== (
          renderDistanceRevision ?? observation.renderDistanceRevision
        )
        || !isSettlementStreamingSnapshotCurrent(currentObservation, {
          presentationRevision: generation.epoch,
          renderDistanceRevision: renderDistanceRevision ?? currentObservation.renderDistanceRevision,
          stateRevision: stateRevision ?? currentObservation.stateRevision,
        })) return false;
      return true;
    },
    claimBuildingSettlementPublication(stage, options = {}) {
      if (!this.canClaimBuildingSettlementPublication(stage, options)) return false;
      const { publicationKinds = Object.freeze(['building']) } = options;
      if (publicationKinds.includes('building')) {
        buildingPublicationSource = 'shared-streaming-plan';
      }
      if (publicationKinds.includes('settlement-road')) {
        settlementRoadPublicationSource = 'shared-streaming-plan';
      }
      if (publicationKinds.includes('metadata-remote')) {
        settlementMetadataPublicationSource = 'shared-streaming-plan';
      }
      settlementPublicationPlanId = stage.planId;
      settlementPublicationRevision = stage.renderDistanceRevision;
      activeGeneration.root.userData.buildingPublicationSource = buildingPublicationSource;
      activeGeneration.root.userData.settlementRoadPublicationSource =
        settlementRoadPublicationSource;
      activeGeneration.root.userData.settlementMetadataPublicationSource =
        settlementMetadataPublicationSource;
      return true;
    },
    useLegacyBuildingSettlementPublication() {
      buildingPublicationSource = 'legacy-distant-root';
      settlementRoadPublicationSource = 'legacy-distant-root';
      settlementMetadataPublicationSource = 'legacy-distant-root';
      settlementPublicationPlanId = null;
      settlementPublicationRevision = 0;
      if (activeGeneration?.root?.userData) {
        activeGeneration.root.userData.buildingPublicationSource = buildingPublicationSource;
        activeGeneration.root.userData.settlementRoadPublicationSource =
          settlementRoadPublicationSource;
        activeGeneration.root.userData.settlementMetadataPublicationSource =
          settlementMetadataPublicationSource;
      }
      return true;
    },
    snapshot({
      includeRemoteHorizonAtmospheres = false,
      includeSettlementSelectionDetails = false,
    } = {}) {
      const stats = activeGeneration?.stats ?? emptyStats;
      const localTerrainStats = activeLocalTerrainGeneration?.stats ?? emptyStats;
      const persistentTreeStats = persistentTreeGeneration?.stats ?? emptyStats;
      const activeStaticNaturalIds = new Set(activeGeneration
        ? [...activeGeneration.canonicalObjects.values()]
          .filter(object => object.naturalKind !== null)
          .map(object => object.stableId)
        : []);
      const persistentStaticNaturalIds = new Set(persistentTreeGeneration
        ? [...persistentTreeGeneration.canonicalObjects.values()]
          .filter(object => object.naturalKind !== null)
          .map(object => object.stableId)
        : []);
      const persistentNaturalSummary = {
        recordCount: 0,
        vegetationCount: 0,
        treeCount: 0,
        shrubCount: 0,
        grassCount: 0,
        rockCount: 0,
        farCount: 0,
        midCount: 0,
        nearCount: 0,
        hiddenCount: 0,
        destroyedCount: 0,
        visibleVegetationCount: 0,
        visibleTreeCount: 0,
        visibleShrubCount: 0,
        visibleGrassCount: 0,
        visibleRockCount: 0,
        visibleFullTreeCount: 0,
        visibleSilhouetteTreeCount: 0,
        visibleUltraTreeCount: 0,
        visibleTreePartInstanceCount: 0,
      };
      for (const object of persistentTreeGeneration?.canonicalObjects.values?.() ?? []) {
        const kind = object.naturalKind;
        if (kind === null) continue;
        persistentNaturalSummary.recordCount += 1;
        if (kind === W8_VEGETATION_LOD_KINDS.ROCK) persistentNaturalSummary.rockCount += 1;
        else persistentNaturalSummary.vegetationCount += 1;
        if (kind === W8_VEGETATION_LOD_KINDS.TREE) persistentNaturalSummary.treeCount += 1;
        else if (kind === W8_VEGETATION_LOD_KINDS.BUSH) persistentNaturalSummary.shrubCount += 1;
        else if (kind === W8_VEGETATION_LOD_KINDS.GRASS) persistentNaturalSummary.grassCount += 1;
        const statusKey = `${object.visibleLod}Count`;
        if (statusKey in persistentNaturalSummary) persistentNaturalSummary[statusKey] += 1;
        if (!['far', 'mid', 'near'].includes(object.visibleLod)) continue;
        if (kind === W8_VEGETATION_LOD_KINDS.ROCK) {
          persistentNaturalSummary.visibleRockCount += 1;
        } else {
          persistentNaturalSummary.visibleVegetationCount += 1;
        }
        if (kind === W8_VEGETATION_LOD_KINDS.BUSH) {
          persistentNaturalSummary.visibleShrubCount += 1;
        } else if (kind === W8_VEGETATION_LOD_KINDS.GRASS) {
          persistentNaturalSummary.visibleGrassCount += 1;
        } else if (kind === W8_VEGETATION_LOD_KINDS.TREE) {
          persistentNaturalSummary.visibleTreeCount += 1;
          const tier = object.visibleLod === 'near'
            ? 'full' : object.naturalBlend?.dominantTier;
          if (tier === 'forest') persistentNaturalSummary.visibleSilhouetteTreeCount += 1;
          else if (tier === 'atmospheric' || tier === 'horizon') {
            persistentNaturalSummary.visibleUltraTreeCount += 1;
          } else persistentNaturalSummary.visibleFullTreeCount += 1;
          persistentNaturalSummary.visibleTreePartInstanceCount += object.instances.length;
        }
      }
      const overlappingStaticNaturalIds = [...persistentStaticNaturalIds]
        .filter(stableId => activeStaticNaturalIds.has(stableId));
      const residentNaturalStableIds = new Set([...persistentTreePages.values()]
        .flatMap(page => page.stableIds));
      const persistentNaturalBucketUsage = Object.freeze([
        ...(persistentTreeGeneration?.canonicalBuckets.values?.() ?? []),
      ].map(bucket => Object.freeze({
        key: bucket.key,
        kind: parseNaturalLodBucket(bucket)?.kind ?? null,
        mode: parseNaturalLodBucket(bucket)?.mode ?? null,
        usedSlots: bucket.items.length,
        capacity: bucket.capacity ?? bucket.items.length,
      })).sort((left, right) => left.key.localeCompare(right.key)));
      const persistentNaturalOrphanStableIds = [
        ...(persistentTreeGeneration?.canonicalObjects.keys?.() ?? []),
      ].filter(stableId => !residentNaturalStableIds.has(stableId));
      const persistentNaturalOrphanSlotCount = [
        ...(persistentTreeGeneration?.canonicalBuckets.values?.() ?? []),
      ].reduce((sum, bucket) => sum + bucket.items.filter(item => (
        !residentNaturalStableIds.has(item.object.stableId)
      )).length, 0);
      const remoteAtmospheres = includeRemoteHorizonAtmospheres
        ? snapshotRemoteHorizonAtmospheres(activeGeneration)
        : emptyRemoteHorizonAtmospheres;
      return Object.freeze({
        schemaVersion: 'w8-distant-presentation-snapshot-1',
        ...stats,
        ...(incrementalStaticTreePages ? {
          canonicalRecordCount:
            stats.canonicalBuildingRecordCount
            + persistentNaturalSummary.recordCount
            + stats.canonicalLandmarkRecordCount
            + stats.canonicalRoadRecordCount
            + stats.canonicalWorldDetailRecordCount
            + stats.remoteHorizonSyntheticBuildingCount
            + stats.remoteHorizonSyntheticLandmarkCount,
          canonicalFarObjectCount:
            stats.canonicalFarObjectCount + persistentNaturalSummary.farCount,
          canonicalMidObjectCount:
            stats.canonicalMidObjectCount + persistentNaturalSummary.midCount,
          canonicalNearObjectCount:
            stats.canonicalNearObjectCount + persistentNaturalSummary.nearCount,
          canonicalHiddenObjectCount:
            stats.canonicalHiddenObjectCount + persistentNaturalSummary.hiddenCount,
          canonicalDestroyedObjectCount:
            stats.canonicalDestroyedObjectCount
            + persistentNaturalSummary.destroyedCount,
          canonicalVegetationRecordCount:
            persistentNaturalSummary.vegetationCount,
          canonicalTreeRecordCount: persistentNaturalSummary.treeCount,
          canonicalShrubRecordCount: persistentNaturalSummary.shrubCount,
          canonicalGrassRecordCount: persistentNaturalSummary.grassCount,
          canonicalRockRecordCount: persistentNaturalSummary.rockCount,
          visibleCanonicalVegetationCount:
            persistentNaturalSummary.visibleVegetationCount,
          visibleCanonicalTreeCount: persistentNaturalSummary.visibleTreeCount,
          visibleCanonicalShrubCount: persistentNaturalSummary.visibleShrubCount,
          visibleCanonicalGrassCount: persistentNaturalSummary.visibleGrassCount,
          visibleCanonicalRockCount: persistentNaturalSummary.visibleRockCount,
          visibleCanonicalFullTreeCount: persistentNaturalSummary.visibleFullTreeCount,
          visibleCanonicalSilhouetteTreeCount:
            persistentNaturalSummary.visibleSilhouetteTreeCount,
          visibleCanonicalUltraTreeCount: persistentNaturalSummary.visibleUltraTreeCount,
          visibleCanonicalTreePartInstanceCount:
            persistentNaturalSummary.visibleTreePartInstanceCount,
          visibleCanonicalForestInstanceCount:
            persistentTreeStats.visibleCanonicalForestInstanceCount,
          visibleCanonicalAtmosphericInstanceCount:
            persistentTreeStats.visibleCanonicalAtmosphericInstanceCount,
          visibleCanonicalForestHorizonInstanceCount:
            persistentTreeStats.visibleCanonicalForestHorizonInstanceCount,
        } : {}),
        incrementalStaticTreePages,
        incrementalStaticNaturalPages: incrementalStaticTreePages,
        staticNaturalCoverageGeneration: persistentTreeCoverageGeneration,
        staticNaturalPlanRevision: persistentTreePlanRevision,
        staticNaturalCurrentPublishedOwnerCount: persistentTreePublishedOwners.size,
        staticNaturalResidentOwnerCount: persistentTreePages.size,
        staticNaturalPendingOwnerCount: pendingPersistentTreePages.size
          + pendingPersistentTreePublications.size
          + persistentTreeBuildQueuedCount,
        staticNaturalDisposeOwnerCount: persistentTreeDisposeOwners.length,
        staticNaturalDuplicatePageQueueCount: persistentTreeDuplicatePageQueueCount,
        staticNaturalStalePageDiscardCount: persistentTreeStalePageDiscardCount,
        staticNaturalMaximumAdmissionsPerFrame: persistentTreeMaximumAdmissionsPerFrame,
        staticNaturalFrameBudgetMs: STATIC_TREE_PAGE_FRAME_BUDGET_MS,
        staticTreeCoverageGeneration: persistentTreeCoverageGeneration,
        staticTreePlanRevision: persistentTreePlanRevision,
        staticTreePublishedOwnerCount: persistentTreePublishedOwnerCount,
        staticTreeCurrentPublishedOwnerCount: persistentTreePublishedOwners.size,
        staticTreeResidentOwnerCount: persistentTreePages.size,
        staticTreePendingOwnerCount: pendingPersistentTreePages.size
          + pendingPersistentTreePublications.size
          + persistentTreeBuildQueuedCount,
        staticTreeDisposeOwnerCount: persistentTreeDisposeOwners.length,
        staticTreeMatrixUpdateCount: persistentTreeMatrixUpdateCount,
        staticTreeAttributeUpdateCount: persistentTreeAttributeUpdateCount,
        staticTreeMaximumSliceMs: persistentTreeMaximumSliceMs,
        staticTreeLastPublicationWaitMs: persistentTreeLastPublicationWaitMs,
        staticTreeMaximumPublicationWaitMs: persistentTreeMaximumPublicationWaitMs,
        staticTreeOwnerBuildCount: persistentTreeOwnerBuildCount,
        staticTreeOwnerReuseCount: persistentTreeOwnerReuseCount,
        staticTreeOwnerRebuildCount: persistentTreeOwnerRebuildCount,
        staticTreeOwnerDisposeCount: persistentTreeOwnerDisposeCount,
        staticTreeDuplicatePageQueueCount: persistentTreeDuplicatePageQueueCount,
        staticTreeStalePageDiscardCount: persistentTreeStalePageDiscardCount,
        staticTreeOlderCoveragePageCount: persistentTreeOlderCoveragePageCount,
        staticTreeRootResetCount: persistentTreeRootResetCount,
        staticTreeMaximumVisibilitySliceMs: persistentTreeMaximumVisibilitySliceMs,
        staticTreeMaximumDisposeSliceMs: persistentTreeMaximumDisposeSliceMs,
        staticTreeAllocatedObjectCount: persistentTreeAllocatedObjectCount,
        staticTreeAllocatedInstanceCount: persistentTreeAllocatedInstanceCount,
        staticTreeAllocatedBucketCount: persistentTreeAllocatedBucketCount,
        staticTreeBufferRangeUpdateCount: persistentTreeBufferRangeUpdateCount,
        staticTreeBufferUploadByteCount: persistentTreeBufferUploadByteCount,
        staticTreeOwnerAdmissionLimit: STATIC_TREE_OWNER_ADMISSION_LIMIT,
        staticTreeOwnerDisposeLimit: STATIC_TREE_OWNER_DISPOSE_LIMIT,
        staticTreeOwnerPublicationLimit: STATIC_TREE_OWNER_PUBLICATION_LIMIT,
        staticTreeFrameBudgetMs: STATIC_TREE_PAGE_FRAME_BUDGET_MS,
        staticTreeMaximumAdmissionsPerFrame: persistentTreeMaximumAdmissionsPerFrame,
        staticTreeAdmissionLimitViolationCount: persistentTreeAdmissionLimitViolationCount,
        staticTreeCompactionMoveCount: persistentTreeCompactionMoveCount,
        staticTreeVisibilityMatrixInvalidationCount:
          persistentTreeVisibilityMatrixInvalidationCount,
        staticTreeFrameSampleCapacity: persistentTreeFrameSampleCapacity,
        staticTreeFrameSamples: Object.freeze(persistentTreeFrameSamples.map(sample => (
          Object.freeze({ ...sample })
        ))),
        staticNaturalActiveLegacyRecordCount: activeStaticNaturalIds.size,
        staticNaturalPersistentRecordCount: persistentStaticNaturalIds.size,
        staticNaturalOverlappingStableIdCount: overlappingStaticNaturalIds.length,
        staticNaturalBucketUsage: persistentNaturalBucketUsage,
        staticNaturalOrphanObjectCount: persistentNaturalOrphanStableIds.length,
        staticNaturalOrphanSlotCount: persistentNaturalOrphanSlotCount,
        runtimePresentationFrameBudgetMs: RUNTIME_PRESENTATION_FRAME_BUDGET_MS,
        runtimePresentationHandoffPending: pendingRuntimePresentationHandoff !== null,
        runtimePresentationHandoffStage: pendingRuntimePresentationHandoff?.stage ?? null,
        runtimePresentationHandoffSequence,
        runtimePresentationHandoffRequestedCount,
        runtimePresentationHandoffCompletedCount,
        runtimePresentationHandoffSupersededCount,
        runtimePresentationHandoffLocalTerrainCount,
        runtimePresentationHandoffMatrixUpdateCount,
        runtimePresentationHandoffBufferUpdateCount,
        runtimePresentationHandoffDisposeCount,
        runtimePresentationHandoffMaximumSliceMs,
        runtimePresentationHandoffMaximumMatrixUpdatesPerFrame,
        runtimePresentationHandoffMaximumBufferUpdatesPerFrame,
        runtimePresentationHandoffMaximumDisposePerFrame,
        runtimePresentationHandoffDirtyBucketCount:
          pendingRuntimePresentationHandoff?.dirtyBuckets.length ?? 0,
        runtimePresentationHandoffDirtyBucketIndex:
          pendingRuntimePresentationHandoff?.dirtyBucketIndex ?? 0,
        deferredGenerationDisposeCount: deferredGenerationDisposals.length,
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
        distantRenderDistancePreset: activeGeneration?.renderDistancePreset ?? null,
        localTerrainRenderDistancePreset:
          activeLocalTerrainGeneration?.renderDistancePreset ?? null,
        staticNaturalRenderDistancePreset:
          persistentTreeGeneration?.renderDistancePreset ?? null,
        preparedDistantRenderDistancePreset:
          preparedRenderDistanceDistant?.generation?.renderDistancePreset ?? null,
        preparedLocalTerrainRenderDistancePreset:
          preparedRenderDistanceLocalTerrain?.generation?.renderDistancePreset ?? null,
        stagedStaticNaturalRenderDistancePreset:
          stagedPersistentNaturalRenderDistancePreset,
        buildingPublicationSource,
        settlementRoadPublicationSource,
        settlementMetadataPublicationSource,
        settlementPublicationPlanId,
        settlementPublicationRevision,
        settlementShadowSnapshotRequestCount,
        settlementShadowSnapshotReuseCount,
        settlementShadowSnapshotCount,
        settlementShadowCanonicalObjectScanCount,
        settlementShadowStableIdMaterializationCount,
        settlementStreamingSnapshotCache: settlementStreamingSnapshotCache.snapshot(),
        quality: activeGeneration?.quality ?? null,
        distantTownProxyCount: 0,
        distantNaturalProxyLimit: DISTANT_ROCK_PROXY_LIMIT,
        distantRockProxyLimit: DISTANT_ROCK_PROXY_LIMIT,
        distantTownProxyLimit: 0,
        visibilityMeters: activeGeneration?.visibilityMeters ?? null,
        naturalVisibilityMeters: activeGeneration?.naturalVisibilityMeters ?? null,
        forestHorizonVisibilityMeters:
          activeGeneration?.forestHorizonVisibilityMeters ?? null,
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
        remoteHorizonFadeEndMeters: activeGeneration?.remoteHorizonFadeEndMeters ?? null,
        remoteHorizonHiddenDistanceMeters:
          activeGeneration?.remoteHorizonHiddenDistanceMeters ?? null,
        remoteHorizonFogEnabled: activeGeneration?.remoteHorizonFogEnabled ?? null,
        remoteHorizonAtmosphereMode:
          activeGeneration?.remoteHorizonAtmosphereMode ?? null,
        remoteHorizonFogIntegrationEndMeters:
          activeGeneration?.remoteHorizonFogIntegrationEndMeters ?? null,
        remoteHorizonSettlementAtmospheres: remoteAtmospheres.settlements,
        remoteHorizonBuildingAtmospheres: remoteAtmospheres.buildings,
        remoteHorizonAtmosphereShaderEnabled: Boolean(
          activeGeneration?.remoteHorizonSilhouetteMaterial
            ?.userData?.remoteBuildingAtmosphere,
        ),
        remoteHorizonPlayerLocalXZ: activeGeneration?.remoteHorizonSilhouetteMaterial
          ? Object.freeze({
            ...activeGeneration.remoteHorizonSilhouetteMaterial
              .userData.remoteAtmosphereUniforms.w8RemotePlayerLocalXZ.value,
          })
          : null,
        remoteHorizonMaterialCount:
          activeGeneration?.remoteHorizonSilhouetteMaterial ? 1 : 0,
        remoteHorizonMeshCount: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.name.startsWith('remote-horizon')).length,
        remoteHorizonVisibleMeshCount: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.name.startsWith('remote-horizon') && bucket.mesh?.count > 0)
          .length,
        localBuildingHandoffMaterialCount: [...(activeGeneration?.ownedMaterials ?? [])]
          .filter(material => material.userData?.localBuildingHandoff === true).length,
        localBuildingHandoffMeshCount: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.localHandoffOpacityAttribute).length,
        localBuildingHandoffVisibleMeshCount:
          [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
            .filter(bucket => bucket.localHandoffOpacityAttribute && bucket.mesh?.count > 0)
            .length,
        naturalLodShaderEnabled: Boolean(activeGeneration?.naturalLodMaterials?.size)
          && [...activeGeneration.naturalLodMaterials.values()]
            .every(material => material.userData?.naturalLod === true),
        naturalLodMaterialCount: activeGeneration?.naturalLodMaterials?.size ?? 0,
        naturalLodMeshCount: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod).length,
        naturalLodVisibleMeshCount: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod && bucket.mesh?.count > 0).length,
        naturalLodGeometryCount: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod && bucket.mesh?.geometry).length,
        naturalLodInstanceCapacity: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod)
          .reduce((sum, bucket) => sum + bucket.items.length, 0),
        naturalLodVisibleInstanceCount: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod)
          .reduce((sum, bucket) => sum + (bucket.mesh?.count ?? 0), 0),
        naturalLodDrawCallEquivalent: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod && bucket.mesh?.count > 0).length,
        forestHorizonMaterialCount: [...(activeGeneration?.naturalLodMaterials?.values() ?? [])]
          .filter(material => material.userData?.naturalLodMode === 'horizon').length,
        forestHorizonMeshCount: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod?.mode === 'horizon').length,
        forestHorizonVisibleMeshCount:
          [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
            .filter(bucket => bucket.naturalLod?.mode === 'horizon'
              && bucket.mesh?.count > 0).length,
        forestHorizonInstanceCapacity:
          [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
            .filter(bucket => bucket.naturalLod?.mode === 'horizon')
            .reduce((sum, bucket) => sum + bucket.items.length, 0),
        forestHorizonVisibleInstanceCount:
          [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
            .filter(bucket => bucket.naturalLod?.mode === 'horizon')
            .reduce((sum, bucket) => sum + (bucket.mesh?.count ?? 0), 0),
        naturalLodReveal: activeGeneration?.naturalReveal ?? 1,
        naturalLodRevealInnerMeters: activeGeneration?.naturalRevealInnerMeters ?? 0,
        naturalLodRevealPreservedStableIdCount:
          activeGeneration?.naturalRevealInitialByStableId?.size ?? 0,
        naturalLodRevealDurationMs: NATURAL_STREAM_REVEAL_MS,
        naturalLodPlayerLocalXZ: (() => {
          const material = activeGeneration?.naturalLodMaterials?.values?.().next?.().value;
          const value = material?.userData?.naturalLodUniforms
            ?.w8NaturalPlayerLocalXZ?.value;
          return value ? Object.freeze({ ...value }) : null;
        })(),
        settlementMetadataQueryDistanceMeters:
          activeGeneration?.settlementMetadataQueryDistanceMeters ?? null,
        queryOwnerChunkCount: activeGeneration?.queryOwnerChunkCount ?? 0,
        queryOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryOwnerChunkKeys ?? []),
        ]),
        queryNaturalOwnerChunkCount: activeGeneration?.queryNaturalOwnerChunkCount ?? 0,
        queryNaturalOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryNaturalOwnerChunkKeys ?? []),
        ]),
        staticPublicationTicketCount:
          activeGeneration?.staticPublicationTickets?.length ?? 0,
        queryInnerNaturalOwnerChunkCount:
          activeGeneration?.queryInnerNaturalOwnerChunkCount ?? 0,
        queryUltraOwnerChunkCount: activeGeneration?.queryUltraOwnerChunkCount ?? 0,
        queryUltraOnlyOwnerChunkCount:
          activeGeneration?.queryUltraOnlyOwnerChunkCount ?? 0,
        queryUltraOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryUltraOwnerChunkKeys ?? []),
        ]),
        queryForestHorizonOwnerChunkCount:
          activeGeneration?.queryForestHorizonOwnerChunkCount ?? 0,
        queryForestHorizonOnlyOwnerChunkCount:
          activeGeneration?.queryForestHorizonOnlyOwnerChunkCount ?? 0,
        queryForestHorizonOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryForestHorizonOwnerChunkKeys ?? []),
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
        queryForestHorizonOwnerChunkCacheHits:
          activeGeneration?.queryForestHorizonOwnerChunkCacheHits ?? 0,
        queryForestHorizonOwnerChunkCacheMisses:
          activeGeneration?.queryForestHorizonOwnerChunkCacheMisses ?? 0,
        queryForestHorizonOwnerChunkCacheEvictions:
          activeGeneration?.queryForestHorizonOwnerChunkCacheEvictions ?? 0,
        innerWarmDurationMs: activeGeneration?.innerWarmDurationMs ?? 0,
        ultraWarmDurationMs: activeGeneration?.ultraWarmDurationMs ?? 0,
        forestHorizonWarmDurationMs: activeGeneration?.forestHorizonWarmDurationMs ?? 0,
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
        activeLocalSettlementId: activeGeneration?.activeLocalSettlementId ?? null,
        additionalLocalSettlementIds: Object.freeze([
          ...(activeGeneration?.additionalLocalSettlementIds ?? []),
        ]),
        localSettlementIds: Object.freeze(sortedKeyList(
          activeGeneration?.localSettlementIds ?? [],
        )),
        localSettlementLimit: activeGeneration?.localSettlementLimit ?? null,
        settlementSelections: includeSettlementSelectionDetails
          ? snapshotSettlementSelections(activeGeneration)
          : Object.freeze([]),
        activeLocalSettlementNearVisible: activeGeneration?.activeLocalSettlementId
          ? activeGeneration.nearVisibleSettlementIds.has(
            activeGeneration.activeLocalSettlementId,
          )
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
        forestHorizonOwnerChunkCacheSize: forestHorizonOwnerChunkCache.size,
        forestHorizonOwnerChunkCacheCapacity: FOREST_HORIZON_OWNER_CHUNK_CACHE_CAPACITY,
        forestHorizonOwnerChunkCacheHits,
        forestHorizonOwnerChunkCacheMisses,
        forestHorizonOwnerChunkCacheEvictions,
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
        distantPersistentPublicationPending: pendingDistantPublication !== null,
        distantPersistentPublicationBacklog:
          pendingDistantPublication?.queue.length ?? 0,
        distantPersistentLiveMeshCount: liveDistantEntries.size,
        distantPersistentPublicationCount,
        distantPersistentReusedMeshCount,
        distantPersistentCreatedMeshCount,
        distantPersistentNewCanonicalMeshCount,
        distantPersistentNewAuxiliaryMeshCount,
        distantPersistentRemovedMeshCount,
        distantPersistentUploadByteCount,
        distantPersistentMaximumUploadBytesPerFrame,
        distantPersistentUploadBudgetBytes: DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES,
        distantPersistentBoundsRecalculationCount,
        distantPersistentMatrixUpdateCount,
        distantPersistentMaximumMatrixUpdatesPerFrame,
        distantPersistentBufferUpdateCount,
        distantPersistentMaximumBufferUpdatesPerFrame,
        distantPersistentMaximumMeshAdmissionsPerFrame,
        distantPersistentMeshAdmissionLimit: DISTANT_PERSISTENT_MESH_ADMISSION_LIMIT,
        distantPersistentAdmissionLimitViolationCount,
        distantPersistentOverBudgetUploadCount,
        distantPersistentMaximumSliceMs,
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
    treePathAuditSnapshot: snapshotTreeRenderPaths,
    treeMaterialAuditSnapshot: snapshotTreeMaterials,
    visibleRootRevisionSnapshot: snapshotVisibleRootRevisions,
    presenterAuditSnapshot: snapshotPresenterAudit,
    canonicalAuditSnapshot() {
      const objects = [
        ...(activeGeneration ? [...activeGeneration.canonicalObjects.values()] : []),
        ...(persistentTreeGeneration
          ? [...persistentTreeGeneration.canonicalObjects.values()] : []),
      ];
      objects.sort((left, right) => left.stableId.localeCompare(right.stableId));
      const composedCountFor = (object, tier) => [...new Set(object.instances
        .filter(instance => instance.item.visibilityTiers.includes(tier))
        .map(instance => instance.bucket))].reduce((count, bucket) => (
          count + (bucket.mesh?.userData?.canonicalStableIds ?? [])
            .filter(stableId => stableId === object.stableId).length
      ), 0);
      const composedNaturalCountFor = (object, tier) => [...new Set(object.instances
        .filter(instance => instance.bucket.name === `natural-${tier}-${object.naturalKind}`)
        .map(instance => instance.bucket))].reduce((count, bucket) => (
          count + (bucket.mesh?.userData?.canonicalStableIds ?? [])
            .filter(stableId => stableId === object.stableId).length
      ), 0);
      return Object.freeze(objects.map(object => {
        const objectGeneration = persistentTreeGeneration?.canonicalObjects.has(object.stableId)
          ? persistentTreeGeneration : activeGeneration;
        const distanceMeters = Math.hypot(
          object.worldX - objectGeneration.playerX,
          object.worldZ - objectGeneration.playerZ,
        );
        return Object.freeze({
          identity: Object.freeze(structuredClone(object.identity)),
          visibleLod: object.visibleLod,
          presentationTier: object.presentationTier,
          farEligible: object.farEligible,
          instanceCount: object.instances.length,
          composedInstanceCount: object.instances.reduce((count, instance) => (
            count + (instance.bucket.mesh?.userData?.canonicalStableIds ?? [])
              .filter(stableId => stableId === object.stableId).length
          ), 0),
          stableIdHandoff: (
            object.localBuildingHandoff
              || object.remoteHorizon
              || (
                isHorizonRecord(object.record)
                  && object.record.featureType === 'settlement-building'
                  && objectGeneration.localSettlementIds.has(object.record.settlementId)
              )
          )
            ? Object.freeze({
              stableId: object.stableId,
              distanceMeters,
              fullOpacity: object.fullPresentationOpacity,
              horizonOpacity: object.horizonPresentationOpacity,
              remoteOpacity: object.remotePresentationOpacity,
              selectedTier: object.presentationTier,
              fullInstanceCount: composedCountFor(object, 'full'),
              horizonInstanceCount: composedCountFor(object, 'horizon'),
              remoteInstanceCount: composedCountFor(object, 'remote-horizon'),
              owner: object.ownerKey,
              presentationOnly: true,
              gameplayRecord: object.record.remotePresentationOnly !== true,
            })
            : null,
          naturalLod: object.naturalKind ? Object.freeze({
            stableId: object.stableId,
            kind: object.naturalKind,
            distanceMeters,
            fullOpacity: object.naturalBlend?.full ?? 0,
            forestOpacity: object.naturalBlend?.forest ?? 0,
            atmosphericOpacity: object.naturalBlend?.atmospheric ?? 0,
            horizonOpacity: object.naturalBlend?.horizon ?? 0,
            totalOpacity: object.naturalBlend?.totalOpacity ?? 0,
            dominantTier: object.naturalBlend?.dominantTier ?? null,
            crossFade: object.naturalBlend?.crossFade ?? false,
            fullInstanceCount: composedNaturalCountFor(object, 'full'),
            forestInstanceCount: composedNaturalCountFor(object, 'forest'),
            atmosphericInstanceCount: composedNaturalCountFor(object, 'atmospheric'),
            horizonInstanceCount: composedNaturalCountFor(object, 'horizon'),
            forestHorizonEligible: object.forestHorizonEligible === true,
            naturalHorizonOnly: object.naturalHorizonOnly === true,
            owner: object.ownerKey,
            presentationOnly: true,
            gameplayRecord: true,
            distanceSource: 'logical-object-position',
          }) : null,
          remoteHorizon: object.remoteHorizon === true,
          ownerKey: object.ownerKey,
          ownerActive: objectGeneration.activeKeys.has(object.ownerKey),
          ownerRendered: objectGeneration.renderedKeys.has(object.ownerKey),
          distanceMeters,
          meshVisible: object.instances.every(instance => instance.bucket.mesh?.visible !== false),
        });
      }));
    },
    markFirstDraw() {
      const firstDrawAtMs = monotonicNow();
      for (const generation of [activeGeneration, persistentTreeGeneration]) {
        for (const pathId of treePathIdsForGeneration(generation, { visibleOnly: true })) {
          const state = treePathAuditState.get(pathId);
          if (state?.firstDrawAtMs === null) {
            recordTreePathAudit(pathId, { firstDrawAtMs });
          }
        }
      }
      if (!streamingTelemetry) return 0;
      let recorded = 0;
      if (pendingDistantFirstDraw
        && pendingDistantFirstDraw.epoch === activeGeneration?.epoch) {
        for (const details of pendingDistantFirstDraw.events) {
          streamingTelemetry.record(WORLD_STREAMING_EVENT.FIRST_DRAW, details);
        }
        recorded += pendingDistantFirstDraw.events.length;
        pendingDistantFirstDraw = null;
      }
      while (pendingStaticTreeFirstDraw.length) {
        streamingTelemetry.record(
          WORLD_STREAMING_EVENT.FIRST_DRAW,
          pendingStaticTreeFirstDraw.shift(),
        );
        recorded += 1;
      }
      return recorded;
    },
    dispose() {
      if (disposed) return;
      syncEpoch += 1;
      localTerrainSyncEpoch += 1;
      cancelCanonicalChunkRequests?.({ consumerId: 'distant-owner-query' });
      if (preparedRenderDistanceDistant) {
        disposeGeneration(preparedRenderDistanceDistant.generation);
        preparedRenderDistanceDistant = null;
      }
      if (preparedRenderDistanceLocalTerrain) {
        disposeGeneration(preparedRenderDistanceLocalTerrain.generation);
        preparedRenderDistanceLocalTerrain = null;
      }
      stagedPersistentNaturalRenderDistancePreset = null;
      disposeGeneration(activeGeneration);
      activeGeneration = null;
      pendingDistantPublication = null;
      liveDistantEntries.clear();
      for (const generation of [...retiredDistantGenerations]) {
        const detachedRoot = generation.stagingRoot;
        for (const child of detachedRoot?.children ?? []) child.dispose?.();
        detachedRoot?.clear?.();
        for (const geometry of generation.ownedGeometries ?? []) geometry.dispose?.();
        generation.ownedGeometries?.clear?.();
        for (const material of generation.ownedMaterials ?? []) material.dispose?.();
        generation.ownedMaterials?.clear?.();
      }
      retiredDistantGenerations.clear();
      persistentDistantRoot = null;
      persistentDistantPublishedGeneration = null;
      pendingDistantFirstDraw = null;
      disposeGeneration(activeLocalTerrainGeneration);
      activeLocalTerrainGeneration = null;
      disposeGeneration(persistentTreeGeneration);
      persistentTreeGeneration = null;
      pendingPersistentTreePages.clear();
      pendingPersistentTreePublications.clear();
      persistentTreePublishedOwners.clear();
      persistentTreePages.clear();
      pendingStaticTreeFirstDraw.length = 0;
      pendingRuntimePresentationHandoff = null;
      while (deferredGenerationDisposals.length) {
        disposeGeneration(deferredGenerationDisposals.shift().generation);
      }
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
      forestHorizonOwnerChunkCache.clear();
      disposed = true;
    },
  });
}
