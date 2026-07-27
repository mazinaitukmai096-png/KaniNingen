import {
  LOGICAL_CHUNK_SIZE_METERS,
  UNITS_PER_METER,
} from '../chunk-coordinates.js';
import { determineDetailCandidateOwner } from '../legacy-core/g3/detail-candidates.js';
import { createMacroTerrainEvaluator, G5_MACRO_TERRAIN } from '../legacy-core/g5/macro-terrain.js';
import { createNaturalBiomeEvaluator, naturalMaterialWeights } from '../natural-biome-field.js';
import {
  W8_NATURAL_CANONICAL_VISIBILITY_METERS,
  isW8NaturalCandidateVisible,
} from '../w8-natural-presentation-policy.js';

export {
  W8_NATURAL_CANONICAL_VISIBILITY_METERS,
  isW8NaturalCandidateVisible,
} from '../w8-natural-presentation-policy.js';

const FIVE_BY_FIVE_HALF_EXTENT_METERS = LOGICAL_CHUNK_SIZE_METERS * 2.5;
const CLIPMAP_EXTENT_METERS = 352;
const CLIPMAP_BLEND_METERS = 16;
const CLIPMAP_SAMPLE_CACHE_CAPACITY = 65_536;
const DISTANT_ROCK_PROXY_LIMIT = 64;
const DISTANT_NATURAL_PROXY_SPACING_METERS = 18;
const DISTANT_WATER_PROXY_LIMIT = 24;
const TEMPLATE_CACHE_CAPACITY = 4;
const FAR_OWNER_CHUNK_CACHE_CAPACITY = 128;
const ULTRA_OWNER_CHUNK_CACHE_CAPACITY = 256;
const CANONICAL_QUERY_CONCURRENCY = 4;
const CANONICAL_QUERY_MARGIN_METERS = Math.SQRT2 * LOGICAL_CHUNK_SIZE_METERS;
const NATURAL_QUERY_MARGIN_METERS = LOGICAL_CHUNK_SIZE_METERS / Math.SQRT2;
const W8_HIGH_TREE_SILHOUETTE_VISIBILITY_METERS = 84;
const W8_HIGH_TREE_SILHOUETTE_HANDOFF_METERS = Object.freeze({ minimum: 54, maximum: 58 });
const W8_HIGH_TREE_ULTRA_HANDOFF_METERS = Object.freeze({ minimum: 76, maximum: 84 });
const W8_HIGH_TREE_ULTRA_VISIBILITY_METERS = 140;
const W8_HIGH_TREE_ULTRA_FADE_START_METERS = 124;
const W8_HIGH_BUILDING_HORIZON_START_METERS = 140;
const W8_HIGH_BUILDING_HORIZON_FADE_START_METERS = 171.5;
export const W8_CANONICAL_VISIBILITY_METERS = Object.freeze({
  high: 187.5,
  medium: 150,
  low: 112.5,
});

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

const chunkAabbIntersectsCircle = (chunkX, chunkZ, centerX, centerZ, radiusMeters) => {
  const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const maximumX = minimumX + LOGICAL_CHUNK_SIZE_METERS;
  const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const maximumZ = minimumZ + LOGICAL_CHUNK_SIZE_METERS;
  const nearestX = clamp(centerX, minimumX, maximumX);
  const nearestZ = clamp(centerZ, minimumZ, maximumZ);
  return Math.hypot(centerX - nearestX, centerZ - nearestZ) <= radiusMeters;
};

export function resolveW8NaturalCandidateVisual(candidate) {
  const formal = candidate?.candidateId !== undefined;
  const variation = formal ? 0.84 + candidate.variationSeed * 0.32 : 1;
  const shrub = formal && candidate.subtype === 'shrub';
  const radiusMeters = formal ? candidate.metadata.candidateRadiusMeters : 0.32;
  const widthMeters = (shrub ? radiusMeters * 2.2 : 2) * variation;
  return Object.freeze({
    visualKind: shrub ? 'shrub'
      : candidate.subtype === 'wetland-tree' ? 'wetlandTree'
        : candidate.subtype === 'broadleaf-tree' ? 'broadleafTree' : 'tree',
    widthMeters,
    heightMeters: (shrub ? 0.85 : 3.625) * variation,
    depthMeters: widthMeters,
    rotationY: formal ? candidate.orientationSeed * Math.PI * 2 : candidate.yawRadians,
  });
}

export function isW8DistantNaturalProxyInRange(distanceMeters) {
  return Number.isFinite(distanceMeters)
    && distanceMeters >= 0
    && distanceMeters < CLIPMAP_EXTENT_METERS - 12;
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

function clipmapAxis() {
  const values = [];
  const addRange = (from, to, step) => {
    for (let value = from; value < to - 1e-9; value += step) values.push(value);
  };
  addRange(-CLIPMAP_EXTENT_METERS, -192, 16);
  addRange(-192, -96, 8);
  addRange(-96, 96, 4);
  addRange(96, 192, 8);
  addRange(192, CLIPMAP_EXTENT_METERS, 16);
  values.push(CLIPMAP_EXTENT_METERS);
  return values;
}

export function createW8ClipmapTopology() {
  const axis = clipmapAxis();
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
    vertices: Object.freeze(vertices),
    indices: Object.freeze(indices),
  });
}

const CLIPMAP_TOPOLOGY = createW8ClipmapTopology();

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
  const height = ((terrain.heights[northwest] * westWeight
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
  return { height, color };
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
  isFeatureDestroyed = () => false,
  measure = (_stage, operation) => operation(),
} = {}) {
  if (!scene?.add || !scene?.remove) throw new TypeError('a Three.js scene is required');
  if (typeof findSettlementsNear !== 'function'
    || typeof resolveTemplate !== 'function'
    || typeof getCanonicalChunkData !== 'function') {
    throw new TypeError('canonical Settlement query, template, and ChunkData providers are required');
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
    canonicalLandmarkRecordCount: 0,
    canonicalRoadRecordCount: 0,
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
    identityAuditErrorCount: 0,
  });
  const emptyStats = createStats();
  let activeGeneration = null;
  let buildTarget = null;
  let buildOwnedGeometries = null;
  let buildStats = null;
  let buildGeneration = null;
  let syncEpoch = 0;
  let committedEpoch = 0;
  let staleEpochDiscardCount = 0;
  let activeQueryCount = 0;
  let maximumObservedQueryConcurrency = 0;
  const queryWaiters = [];
  const templateCache = new Map();
  const farOwnerChunkCache = new Map();
  const ultraOwnerChunkCache = new Map();
  const clipmapSampleCache = new Map();
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

  const baseClipmapSample = (worldX, worldZ) => {
    const key = `${worldX},${worldZ}`;
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
    const value = Object.freeze({
      height: 0.4 + macro.offsetMm * 0.001,
      color: Object.freeze(w8TerrainColorFromWeights(naturalMaterialWeights(
        biome.memberships, moisture, rockiness, slope,
      ))),
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

  const createMidgroundTerrain = (chunks, origin) => {
    const positions = []; const colors = []; const indices = [];
    for (const chunk of chunks) {
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
          positions.push(
            (worldX - origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS) * UNITS_PER_METER,
            terrain.heights[index] * terrain.heightUnitMeters * UNITS_PER_METER,
            (worldZ - origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS) * UNITS_PER_METER,
          );
          colors.push(...w8TerrainColorFromWeights(
            terrain.materialWeights.slice(index * 5, index * 5 + 5),
          ));
        }
      }
      for (let z = 0; z < depth - 1; z += 1) for (let x = 0; x < width - 1; x += 1) {
        const northwest = base + z * width + x;
        indices.push(northwest, northwest + width, northwest + 1,
          northwest + 1, northwest + width, northwest + width + 1);
      }
    }
    if (!positions.length) return;
    const geometry = makeGeometry(THREE, positions, colors, indices);
    buildOwnedGeometries.add(geometry);
    const mesh = new Mesh(geometry, terrainMaterial);
    mesh.name = 'w8-midground-outer-sixteen-terrain';
    mesh.castShadow = false; mesh.receiveShadow = false;
    buildTarget.add(mesh);
  };

  const createMidgroundNaturalFeatures = (chunks, origin, centerChunkX, centerChunkZ) => {
    const buckets = new Map();
    const push = (geometry, material, matrix, name) => {
      const key = `${geometry}:${material}:${name}`;
      if (!buckets.has(key)) buckets.set(key, { geometry, material, name, matrices: [] });
      buckets.get(key).matrices.push(matrix.clone?.() ?? structuredClone(matrix));
    };
    const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const matrixForPart = (feature, part, dimensions) => {
      const rotationY = Number.isFinite(feature.rotationY)
        ? feature.rotationY
        : Number.isFinite(feature.orientationSeed) ? feature.orientationSeed * Math.PI * 2 : 0;
      const offsetX = part.position[0] * dimensions.width;
      const offsetZ = part.position[2] * dimensions.depth;
      const cosine = Math.cos(rotationY); const sine = Math.sin(rotationY);
      transform.position.set(
        (feature.worldPosition.x - originMetersX) * UNITS_PER_METER + offsetX * cosine + offsetZ * sine,
        feature.worldPosition.y * UNITS_PER_METER + part.position[1] * dimensions.height,
        (feature.worldPosition.z - originMetersZ) * UNITS_PER_METER - offsetX * sine + offsetZ * cosine,
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
    const addParts = (feature, kind, dimensions, name) => {
      if (isFeatureDestroyed(feature.stableId ?? feature.candidateId)) return;
      const parts = feature.featureType === 'settlement-building'
        ? visualAssets.resolveBuildingParts?.(feature) ?? visualAssets.featureParts[kind]
        : visualAssets.featureParts[kind];
      for (const part of parts ?? []) {
        push(part.geometry, part.material, matrixForPart(feature, part, dimensions), name);
      }
    };
    for (const chunk of chunks) {
      const layers = chunk.presentationLayers;
      for (const candidate of layers?.natural?.rocks ?? chunk.rockCandidates ?? []) {
        const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
        const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
        const presentationDistanceChunks = Math.hypot(
          candidate.worldPosition.x - centerWorldX,
          candidate.worldPosition.z - centerWorldZ,
        ) / LOGICAL_CHUNK_SIZE_METERS;
        if (candidate.variationSeed < clamp(
          0.42 + Math.max(0, presentationDistanceChunks - 1.5) * 0.12,
          0.42,
          0.68,
        )) continue;
        const radius = candidate.metadata.candidateRadiusMeters * (0.9 + candidate.variationSeed * 0.2);
        addParts(candidate, 'rock', {
          width: radius * 2 * UNITS_PER_METER,
          height: radius * 1.25 * UNITS_PER_METER,
          depth: radius * 2 * UNITS_PER_METER,
        }, 'major-natural');
      }
    }
    for (const bucket of buckets.values()) {
      const geometry = bucket.geometry === '__road__'
        ? roadGeometry : visualAssets.geometries[bucket.geometry];
      const material = visualAssets.materials[bucket.material];
      const mesh = new InstancedMesh(geometry, material, Math.max(1, bucket.matrices.length));
      mesh.name = `w8-midground-${bucket.name}-${bucket.geometry}-${bucket.material}`;
      mesh.count = bucket.matrices.length;
      bucket.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false; mesh.receiveShadow = false;
      buildTarget.add(mesh);
    }
  };

  const canonicalNaturalRecord = candidate => {
    const stableId = candidate?.candidateId ?? candidate?.stableId;
    const visual = resolveW8NaturalCandidateVisual(candidate);
    return Object.freeze({
      stableId,
      candidateId: stableId,
      featureType: 'natural-vegetation',
      subtype: candidate.subtype ?? null,
      worldPosition: candidate.worldPosition,
      rotationY: visual.rotationY,
      widthMeters: visual.widthMeters,
      heightMeters: visual.heightMeters,
      depthMeters: visual.depthMeters,
      owningChunkCoordinate: candidate.owningChunkCoordinate,
      destructible: true,
      visual: Object.freeze({
        visualKind: visual.visualKind,
        subtype: candidate.subtype ?? null,
        variationSeed: candidate.variationSeed ?? null,
      }),
    });
  };

  const canonicalPartsFor = record => {
    if (record.featureType === 'settlement-building') {
      return visualAssets.resolveBuildingParts?.(record)
        ?? visualAssets.featureParts[record.buildingType] ?? null;
    }
    if (record.featureType === 'natural-vegetation') {
      return visualAssets.featureParts[record.visual?.visualKind] ?? null;
    }
    if (record.landmarkType) return visualAssets.featureParts[record.landmarkType] ?? null;
    return null;
  };

  const canonicalIdentity = (record, chunk, parts) => ({
    stableId: record.stableId,
    settlementId: record.settlementId ?? record.parentSettlementId ?? null,
    ...(record.featureType === 'natural-vegetation' ? {
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
  ) => {
    const key = `${geometry}:${material}:${name}`;
    if (!buildGeneration.canonicalBuckets.has(key)) {
      buildGeneration.canonicalBuckets.set(key, {
        geometry,
        material,
        name,
        items: [],
      });
    }
    buildGeneration.canonicalBuckets.get(key).items.push({
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
    const existing = buildGeneration.canonicalObjects.get(record.stableId);
    if (existing) {
      if (existing.identityKey !== identityKey) {
        buildStats.identityAuditErrorCount += 1;
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
    buildGeneration.canonicalObjects.set(record.stableId, object);
    buildStats.canonicalRecordCount += 1;
    if (record.featureType === 'settlement-building') {
      buildStats.canonicalBuildingRecordCount += 1;
    } else if (record.featureType === 'natural-vegetation') {
      buildStats.canonicalVegetationRecordCount += 1;
      if (record.subtype === 'shrub') buildStats.canonicalShrubRecordCount += 1;
      else buildStats.canonicalTreeRecordCount += 1;
    } else if (record.featureType === 'settlement-road') {
      buildStats.canonicalRoadRecordCount += 1;
    } else if (record.landmarkType) {
      buildStats.canonicalLandmarkRecordCount += 1;
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

  const isHorizonRecord = record => record?.featureType === 'settlement-building'
    || typeof record?.landmarkType === 'string';

  const canonicalHorizonParts = parts => {
    const body = parts.find(part => part.materialRole === 'wall') ?? parts[0] ?? null;
    const cap = parts.find(part => part !== body && part.materialRole === 'roof')
      ?? parts.find(part => part !== body && /tower|roof/i.test(part.geometry ?? ''))
      ?? parts.find(part => part !== body)
      ?? null;
    return [body, cap].filter(Boolean);
  };

  const addCanonicalRecord = ({ record, chunk, origin, farEligible }) => {
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
      addCanonicalMatrix(registration.object, '__road__', 'road', 'road', transform.matrix);
      return;
    }

    const parts = canonicalPartsFor(record);
    if (!parts?.length) {
      throw new Error(`canonical record has no finite visual parts: ${record.stableId}`);
    }
    const registration = registerCanonicalRecord({ record, chunk, parts, farEligible });
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
          : record.featureType === 'natural-vegetation' ? 'natural'
          : record.landmarkType ? 'landmark' : 'building',
        canonicalPartMatrix(record, part, dimensions, origin),
        silhouette ? Object.freeze(['full', 'silhouette']) : undefined,
      );
      if (silhouette && buildGeneration.quality === 'high') {
        addCanonicalMatrix(
          registration.object,
          part.geometry,
          part.material,
          'natural-ultra',
          canonicalPartMatrix(record, part, dimensions, origin),
          Object.freeze(['ultra']),
        );
      }
    }
    if (isHorizonRecord(record) && buildGeneration.quality === 'high') {
      const horizonBucket = record.featureType === 'settlement-building'
        ? 'horizon-building' : 'horizon-landmark';
      for (const part of canonicalHorizonParts(parts)) {
        addCanonicalMatrix(
          registration.object,
          part.geometry,
          '__horizon__',
          horizonBucket,
          canonicalPartMatrix(record, part, dimensions, origin),
          Object.freeze(['horizon']),
        );
      }
    }
  };

  const addCanonicalChunk = ({
    chunk,
    origin,
    farEligibleSettlementIds = null,
    coveredSettlementIds = null,
    includeNatural = false,
    farNaturalEligible = false,
    queryCenter = null,
    naturalQueryCenter = null,
    queryRadius = Infinity,
    naturalQueryRadius = Infinity,
  }) => {
    const layers = chunk.presentationLayers;
    if (includeNatural) {
      const vegetation = layers?.natural?.vegetation ?? chunk.vegetationCandidates ?? [];
      for (const candidate of vegetation) {
        if (!isW8NaturalCandidateVisible(candidate)) continue;
        if (naturalQueryCenter && Math.hypot(
          candidate.worldPosition.x - naturalQueryCenter.x,
          candidate.worldPosition.z - naturalQueryCenter.z,
        ) > naturalQueryRadius) continue;
        addCanonicalRecord({
          record: canonicalNaturalRecord(candidate),
          chunk,
          origin,
          farEligible: farNaturalEligible,
        });
      }
    }
    const records = [
      ...(layers?.formal?.roadsAndBuildings ?? chunk.settlementFeatures ?? []),
      ...(layers?.landmarks ?? chunk.settlementLandmarks ?? []),
    ];
    for (const record of records) {
      const settlementId = record.settlementId ?? record.parentSettlementId;
      const queriedOwner = farEligibleSettlementIds?.has(settlementId) === true;
      const farEligible = queriedOwner || coveredSettlementIds?.has(settlementId) === true;
      if (farEligibleSettlementIds && !queriedOwner) continue;
      if (queryCenter && Math.hypot(
        record.worldPosition.x - queryCenter.x,
        record.worldPosition.z - queryCenter.z,
      ) > queryRadius) continue;
      addCanonicalRecord({ record, chunk, origin, farEligible });
    }
  };

  const createHorizonSilhouetteMaterial = () => new Material({
    color: 0x3a3932,
    flatShading: true,
    shininess: 0,
  });

  const finalizeCanonicalMeshes = () => {
    for (const bucket of buildGeneration.canonicalBuckets.values()) {
      if (!bucket.items.length) continue;
      const geometry = bucket.geometry === '__road__'
        ? roadGeometry : visualAssets.geometries[bucket.geometry];
      const sourceMaterial = visualAssets.materials[bucket.material];
      const generatedMaterial = bucket.name === 'horizon-building'
        || bucket.name === 'horizon-landmark';
      if (!geometry || (!sourceMaterial && !generatedMaterial)) {
        throw new Error(`canonical finite visual resource is missing: ${bucket.geometry}/${bucket.material}`);
      }
      let material = sourceMaterial;
      if (bucket.name === 'horizon-building' || bucket.name === 'horizon-landmark') {
        material = buildGeneration.horizonSilhouetteMaterial
          ?? createHorizonSilhouetteMaterial();
        buildGeneration.horizonSilhouetteMaterial = material;
        buildGeneration.ownedMaterials.add(material);
      }
      const mesh = new InstancedMesh(geometry, material, bucket.items.length);
      mesh.name = `w8-canonical-lod-${bucket.name}-${bucket.geometry}-${bucket.material}`;
      mesh.count = 0;
      mesh.visible = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData = { presentationOnly: true, canonicalStableIds: [] };
      bucket.items.forEach(item => {
        item.object.instances.push({ bucket, item });
      });
      bucket.mesh = mesh;
      buildTarget.add(mesh);
      buildStats.canonicalMeshCount += 1;
      if (mesh.visible !== false) buildStats.canonicalVisibleMeshCount += 1;
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

  const composeCanonicalMeshes = generation => {
    for (const bucket of generation.canonicalBuckets.values()) {
      const mesh = bucket.mesh;
      if (!mesh) continue;
      let count = 0;
      const stableIds = [];
      for (const item of bucket.items) {
        if (!item.object.presentationTier
          || !item.visibilityTiers.includes(item.object.presentationTier)) continue;
        const matrix = item.matrix;
        mesh.setMatrixAt(count, matrix);
        stableIds.push(item.object.stableId);
        count += 1;
      }
      mesh.count = count;
      mesh.userData.canonicalStableIds = stableIds;
      mesh.instanceMatrix.needsUpdate = true;
    }
  };

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
        const worldX = generation.playerX + Math.cos(angle) * W8_HIGH_TREE_SILHOUETTE_VISIBILITY_METERS;
        const worldZ = generation.playerZ + Math.sin(angle) * W8_HIGH_TREE_SILHOUETTE_VISIBILITY_METERS;
        positions.push(
          (worldX - originX) * UNITS_PER_METER,
          (baseClipmapSample(worldX, worldZ).height + 0.18) * UNITS_PER_METER,
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
    ring.userData = { presentationOnly: true, debugOnly: true, radiusMeters: 84 };
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

  const canonicalTreePresentationTier = (object, distanceMeters, quality, visible) => {
    if (!visible) return null;
    if (object.record.featureType !== 'natural-vegetation'
      || object.record.subtype === 'shrub'
      || quality !== 'high') return 'full';
    if (distanceMeters >= W8_HIGH_TREE_ULTRA_VISIBILITY_METERS) return null;
    if (distanceMeters >= W8_HIGH_TREE_ULTRA_FADE_START_METERS) {
      const fade = 1 - smoothstep((distanceMeters - W8_HIGH_TREE_ULTRA_FADE_START_METERS)
        / (W8_HIGH_TREE_ULTRA_VISIBILITY_METERS - W8_HIGH_TREE_ULTRA_FADE_START_METERS));
      const ditherRank = textHash(`${object.stableId}:w8-high-tree-ultra-fade`) / 0x1_0000_0000;
      if (!(ditherRank < fade)) return null;
    }
    const rank = textHash(object.stableId) / 0x1_0000_0000;
    const fullHandoff = W8_HIGH_TREE_SILHOUETTE_HANDOFF_METERS.minimum
      + (W8_HIGH_TREE_SILHOUETTE_HANDOFF_METERS.maximum
        - W8_HIGH_TREE_SILHOUETTE_HANDOFF_METERS.minimum) * rank;
    if (distanceMeters < fullHandoff) return 'full';
    const ultraHandoff = W8_HIGH_TREE_ULTRA_HANDOFF_METERS.minimum
      + (W8_HIGH_TREE_ULTRA_HANDOFF_METERS.maximum
        - W8_HIGH_TREE_ULTRA_HANDOFF_METERS.minimum) * rank;
    return distanceMeters < ultraHandoff ? 'silhouette' : 'ultra';
  };

  const canonicalSettlementPresentationTier = (
    object,
    distanceMeters,
    quality,
    visible,
    currentSettlementId,
  ) => {
    if (!visible) return null;
    if (!isHorizonRecord(object.record) || quality !== 'high') return 'full';
    if (!currentSettlementId || object.settlementId !== currentSettlementId) return 'full';
    if (distanceMeters >= W8_CANONICAL_VISIBILITY_METERS.high) return null;
    if (distanceMeters >= W8_HIGH_BUILDING_HORIZON_FADE_START_METERS) {
      const fade = 1 - smoothstep((distanceMeters - W8_HIGH_BUILDING_HORIZON_FADE_START_METERS)
        / (W8_CANONICAL_VISIBILITY_METERS.high - W8_HIGH_BUILDING_HORIZON_FADE_START_METERS));
      const ditherRank = textHash(`${object.stableId}:w8-high-building-horizon-fade`) / 0x1_0000_0000;
      if (!(ditherRank < fade)) return null;
    }
    return distanceMeters < W8_HIGH_BUILDING_HORIZON_START_METERS ? 'full' : 'horizon';
  };

  const updateCanonicalVisibility = (generation, playerX, playerZ) => {
    if (!generation) return;
    const visibility = W8_CANONICAL_VISIBILITY_METERS[generation.quality]
      ?? W8_CANONICAL_VISIBILITY_METERS.high;
    const naturalVisibility = W8_NATURAL_CANONICAL_VISIBILITY_METERS[generation.quality]
      ?? W8_NATURAL_CANONICAL_VISIBILITY_METERS.high;
    let farCount = 0;
    let midCount = 0;
    let nearCount = 0;
    let hiddenCount = 0;
    let destroyedCount = 0;
    let visibleCount = 0;
    let visibleVegetationCount = 0;
    let visibleTreeCount = 0;
    let visibleShrubCount = 0;
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
    const activeOwners = new Set();
    const renderedOwners = new Set();
    let presentationChanged = false;
    for (const object of generation.canonicalObjects.values()) {
      let nextLod = 'hidden';
      const distanceMeters = Math.hypot(object.worldX - playerX, object.worldZ - playerZ);
      const tree = object.record.featureType === 'natural-vegetation'
        && object.record.subtype !== 'shrub';
      const highTreeVisibility = generation.quality === 'high' && tree
        ? W8_HIGH_TREE_ULTRA_VISIBILITY_METERS : naturalVisibility;
      if (object.destructible && isFeatureDestroyed(object.stableId)) {
        nextLod = 'destroyed';
        if (isHorizonRecord(object.record)
          && distanceMeters >= W8_HIGH_BUILDING_HORIZON_START_METERS
          && distanceMeters < W8_CANONICAL_VISIBILITY_METERS.high) {
          destroyedHorizonBuildingCount += 1;
        }
      } else if (generation.renderedKeys.has(object.ownerKey)) {
        nextLod = 'near';
      } else if (generation.activeKeys.has(object.ownerKey)
        && (!tree || distanceMeters < highTreeVisibility)) {
        nextLod = 'mid';
      } else if (object.farEligible) {
        const visibilityDistance = object.record.featureType === 'natural-vegetation'
          ? highTreeVisibility : visibility;
        const insideVisibility = generation.quality === 'high' && tree
          ? distanceMeters < visibilityDistance
          : distanceMeters <= visibilityDistance;
        if (insideVisibility) nextLod = 'far';
      }
      const distantVisible = nextLod === 'far' || nextLod === 'mid';
      let presentationTier = tree
        ? canonicalTreePresentationTier(
          object,
          distanceMeters,
          generation.quality,
          distantVisible,
        )
        : canonicalSettlementPresentationTier(
          object,
          distanceMeters,
          generation.quality,
          distantVisible,
          generation.currentSettlementId,
        );
      if (nextLod === 'near') presentationTier = 'full';
      if ((tree || isHorizonRecord(object.record)) && distantVisible && !presentationTier) {
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
      if ((nextLod === 'far' || nextLod === 'mid' || nextLod === 'near')
        && object.record.featureType === 'natural-vegetation') {
        visibleVegetationCount += 1;
        if (object.record.subtype === 'shrub') visibleShrubCount += 1;
        else {
          visibleTreeCount += 1;
          if ((nextLod === 'far' || nextLod === 'mid')
            && distanceMeters >= 56
            && distanceMeters < W8_HIGH_TREE_ULTRA_HANDOFF_METERS.minimum) {
            visibleTreeMidBandCount += 1;
          } else if ((nextLod === 'far' || nextLod === 'mid')
            && distanceMeters >= W8_HIGH_TREE_ULTRA_HANDOFF_METERS.minimum
            && distanceMeters < W8_HIGH_TREE_SILHOUETTE_VISIBILITY_METERS) {
            visibleTreeOuterBandCount += 1;
          } else if ((nextLod === 'far' || nextLod === 'mid')
            && distanceMeters >= W8_HIGH_TREE_SILHOUETTE_VISIBILITY_METERS
            && distanceMeters < W8_HIGH_TREE_ULTRA_FADE_START_METERS) {
            visibleTreeUltraInnerBandCount += 1;
          } else if ((nextLod === 'far' || nextLod === 'mid')
            && distanceMeters >= W8_HIGH_TREE_ULTRA_FADE_START_METERS
            && distanceMeters < W8_HIGH_TREE_ULTRA_VISIBILITY_METERS) {
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
      } else if (isHorizonRecord(object.record)
        && (nextLod === 'far' || nextLod === 'mid' || nextLod === 'near')) {
        if (presentationTier === 'horizon') {
          if (object.record.featureType === 'settlement-building') visibleHorizonBuildingCount += 1;
          else visibleHorizonLandmarkCount += 1;
          visibleHorizonPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes('horizon')
          )).length;
        } else {
          visibleBuildingPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes('full')
          )).length;
        }
      }
      if (object.visibleLod === nextLod && object.presentationTier === presentationTier) continue;
      presentationChanged = true;
      object.visibleLod = nextLod;
      object.presentationTier = presentationTier;
    }
    generation.playerX = playerX;
    generation.playerZ = playerZ;
    if (presentationChanged || visibleSilhouetteTreeCount > 0) composeCanonicalMeshes(generation);
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
    generation.stats.duplicateVisibleStableIdCount = 0;
    if (treeLodDiagnosticsEnabled && !generation.treeLodDiagnostics) {
      createTreeLodDiagnostics(generation);
    } else if (generation.treeLodDiagnostics) {
      updateTreeLodDiagnostics(generation);
    }
  };

  const createClipmap = ({ centerChunkX, centerChunkZ, activeChunks, origin }) => {
    const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const positions = []; const colors = [];
    for (const { x, z } of CLIPMAP_TOPOLOGY.vertices) {
      const worldX = centerWorldX + x; const worldZ = centerWorldZ + z;
      const base = baseClipmapSample(worldX, worldZ);
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
          const boundaryMacro = 0.4 + macroEvaluator.evaluate(boundaryX, boundaryZ).offsetMm * 0.001;
          const activeWeight = 1 - smoothstep(distanceOutside / CLIPMAP_BLEND_METERS);
          height += (actual.height - boundaryMacro) * activeWeight;
          for (let channel = 0; channel < 3; channel += 1) {
            color[channel] += (actual.color[channel] - color[channel]) * activeWeight;
          }
          if (Math.abs(distanceOutside) < 1e-9) {
            buildStats.maximumInnerBoundaryErrorMeters = Math.max(
              buildStats.maximumInnerBoundaryErrorMeters,
              Math.abs(height - actual.height),
            );
            buildStats.maximumInnerBoundaryColorDifference = Math.max(
              buildStats.maximumInnerBoundaryColorDifference,
              ...color.map((channel, index) => Math.abs(channel - actual.color[index])),
            );
          }
        }
      }
      positions.push((worldX - originMetersX) * UNITS_PER_METER, height * UNITS_PER_METER,
        (worldZ - originMetersZ) * UNITS_PER_METER);
      colors.push(...color);
    }
    const geometry = makeGeometry(THREE, positions, colors, CLIPMAP_TOPOLOGY.indices);
    let checksum = 0x811c9dc5;
    for (const value of [...positions, ...colors]) {
      checksum ^= Math.round(value * 1000);
      checksum = Math.imul(checksum, 0x01000193) >>> 0;
    }
    buildStats.clipmapDeterministicChecksum = checksum;
    buildOwnedGeometries.add(geometry);
    const mesh = new Mesh(geometry, terrainMaterial);
    mesh.name = 'w8-seeded-macro-terrain-clipmap';
    mesh.castShadow = false; mesh.receiveShadow = false;
    buildTarget.add(mesh); buildStats.clipmapMeshCount = 1;
  };

  const createDistantNaturalAndWaterProxies = ({
    centerChunkX, centerChunkZ, activeChunks, origin,
  }) => {
    const seed = textHash(worldSeedHash);
    const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const buckets = new Map();
    const push = (geometry, material, name) => {
      const key = `${geometry}:${material}:${name}`;
      if (!buckets.has(key)) buckets.set(key, { geometry, material, name, matrices: [] });
      buckets.get(key).matrices.push(transform.matrix.clone?.() ?? structuredClone(transform.matrix));
    };
    const placePart = ({ worldX, worldZ, height, rotationY, dimensions, part, fade }) => {
      const offsetX = part.position[0] * dimensions.width;
      const offsetZ = part.position[2] * dimensions.depth;
      const cosine = Math.cos(rotationY); const sine = Math.sin(rotationY);
      transform.position.set(
        (worldX - originMetersX) * UNITS_PER_METER + offsetX * cosine + offsetZ * sine,
        height * UNITS_PER_METER + part.position[1] * dimensions.height,
        (worldZ - originMetersZ) * UNITS_PER_METER - offsetX * sine + offsetZ * cosine,
      );
      transform.rotation.set(part.rotation[0], rotationY + part.rotation[1], part.rotation[2]);
      transform.scale.set(
        dimensions.width * part.scale[0] * fade,
        dimensions.height * part.scale[1] * fade,
        dimensions.depth * part.scale[2] * fade,
      );
      transform.updateMatrix();
      push(part.geometry, part.material, 'finite-language-proxy');
    };
    const fadeAt = (worldX, worldZ) => smoothstep((
      Math.max(Math.abs(worldX - centerWorldX), Math.abs(worldZ - centerWorldZ))
      - FIVE_BY_FIVE_HALF_EXTENT_METERS
    ) / CLIPMAP_BLEND_METERS);
    const forAnchoredGrid = (spacing, operation) => {
      const minimumX = Math.floor((centerWorldX - CLIPMAP_EXTENT_METERS) / spacing);
      const maximumX = Math.ceil((centerWorldX + CLIPMAP_EXTENT_METERS) / spacing);
      const minimumZ = Math.floor((centerWorldZ - CLIPMAP_EXTENT_METERS) / spacing);
      const maximumZ = Math.ceil((centerWorldZ + CLIPMAP_EXTENT_METERS) / spacing);
      for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ += 1) {
        for (let cellX = minimumX; cellX <= maximumX; cellX += 1) operation(cellX, cellZ);
      }
    };

    forAnchoredGrid(DISTANT_NATURAL_PROXY_SPACING_METERS, (cellX, cellZ) => {
      if (buildStats.distantRockProxyCount >= DISTANT_ROCK_PROXY_LIMIT
        || cellRoll(seed, cellX, cellZ, 1) > 0.25) return;
      const worldX = (cellX + 0.18 + cellRoll(seed, cellX, cellZ, 2) * 0.64)
        * DISTANT_NATURAL_PROXY_SPACING_METERS;
      const worldZ = (cellZ + 0.18 + cellRoll(seed, cellX, cellZ, 3) * 0.64)
        * DISTANT_NATURAL_PROXY_SPACING_METERS;
      const distance = Math.max(Math.abs(worldX - centerWorldX), Math.abs(worldZ - centerWorldZ));
      if (!isW8DistantNaturalProxyInRange(distance)) return;
      const fade = 1;
      const roll = cellRoll(seed, cellX, cellZ, 4);
      if (roll <= 0.9) return;
      const sample = baseClipmapSample(worldX, worldZ);
      const activeHeight = sampleActiveTerrain(activeChunks, worldX, worldZ);
      const size = 0.78 + cellRoll(seed, cellX, cellZ, 5) * 0.48;
      const dimensions = {
        width: 1.8 * size * UNITS_PER_METER,
        height: 1.1 * size * UNITS_PER_METER,
        depth: 1.8 * size * UNITS_PER_METER,
      };
      for (const part of visualAssets.featureParts.rock ?? []) placePart({
        worldX, worldZ, height: activeHeight ?? sample.height,
        rotationY: cellRoll(seed, cellX, cellZ, 6) * Math.PI * 2,
        dimensions, part, fade,
      });
      buildStats.distantNaturalProxyCount += 1;
      buildStats.distantRockProxyCount += 1;
    });

    forAnchoredGrid(64, (cellX, cellZ) => {
      if (buildStats.distantWaterProxyCount >= DISTANT_WATER_PROXY_LIMIT
        || cellRoll(seed, cellX, cellZ, 21) > 0.2) return;
      const worldX = (cellX + 0.5) * 64; const worldZ = (cellZ + 0.5) * 64;
      const distance = Math.max(Math.abs(worldX - centerWorldX), Math.abs(worldZ - centerWorldZ));
      if (distance <= FIVE_BY_FIVE_HALF_EXTENT_METERS + 12 || distance >= CLIPMAP_EXTENT_METERS - 28) return;
      const sample = baseClipmapSample(worldX, worldZ);
      if (sample.moisture < 0.61) return;
      const size = 18 + cellRoll(seed, cellX, cellZ, 22) * 26;
      transform.position.set((worldX - originMetersX) * UNITS_PER_METER,
        (sample.height + 0.02) * UNITS_PER_METER,
        (worldZ - originMetersZ) * UNITS_PER_METER);
      transform.rotation.set(-Math.PI / 2, 0, cellRoll(seed, cellX, cellZ, 23) * Math.PI);
      transform.scale.set(size * UNITS_PER_METER * fadeAt(worldX, worldZ),
        size * 0.58 * UNITS_PER_METER * fadeAt(worldX, worldZ), 1);
      transform.updateMatrix();
      push('__road__', 'water', 'water-proxy');
      buildStats.distantWaterProxyCount += 1;
    });

    for (const bucket of buckets.values()) {
      const geometry = bucket.geometry === '__road__'
        ? roadGeometry : visualAssets.geometries[bucket.geometry];
      const material = visualAssets.materials[bucket.material];
      const mesh = new InstancedMesh(geometry, material, Math.max(1, bucket.matrices.length));
      mesh.name = `w8-distant-${bucket.name}-${bucket.geometry}-${bucket.material}`;
      mesh.count = bucket.matrices.length;
      bucket.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.userData = { presentationOnly: true };
      buildTarget.add(mesh); buildStats.distantProxyInstancedMeshCount += 1;
    }
  };

  const mapWithQueryConcurrency = async (values, operation) => {
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
        const index = cursor;
        cursor += 1;
        await acquireQuerySlot();
        try {
          results[index] = await operation(values[index], index);
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
    activeKeys,
    includeFarNatural,
    includeUltraNatural = true,
  }) => {
    const queryStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const visibilityMeters = W8_CANONICAL_VISIBILITY_METERS[quality]
      ?? W8_CANONICAL_VISIBILITY_METERS.high;
    const naturalVisibilityMeters = quality === 'high'
      ? W8_HIGH_TREE_ULTRA_VISIBILITY_METERS
      : W8_NATURAL_CANONICAL_VISIBILITY_METERS[quality]
        ?? W8_NATURAL_CANONICAL_VISIBILITY_METERS.high;
    // The Chunk AABB test is already conservative at the circle boundary.  High therefore
    // needs no extra radial expansion to cover every owner containing a visible Tree.
    const naturalQueryRadius = quality === 'high'
      ? (includeUltraNatural
        ? naturalVisibilityMeters
        : W8_HIGH_TREE_SILHOUETTE_VISIBILITY_METERS)
      : naturalVisibilityMeters + NATURAL_QUERY_MARGIN_METERS;
    const queryRadius = visibilityMeters + CANONICAL_QUERY_MARGIN_METERS;
    const [candidateResult] = await mapWithQueryConcurrency(
      [{ centerWorldX, centerWorldZ, queryRadius }],
      query => findSettlementsNear(
        query.centerWorldX,
        query.centerWorldZ,
        query.queryRadius,
      ),
    );
    const candidates = [...candidateResult]
      .sort((left, right) => left.settlementId.localeCompare(right.settlementId));
    const candidateDistance = candidate => Math.hypot(
      (candidate.worldPosition?.x ?? candidate.center?.x ?? Infinity) - centerWorldX,
      (candidate.worldPosition?.z ?? candidate.center?.z ?? Infinity) - centerWorldZ,
    );
    const currentSettlementCandidate = quality === 'high' && candidates.length
      ? [...candidates].sort((left, right) => (
        candidateDistance(left) - candidateDistance(right)
          || left.settlementId.localeCompare(right.settlementId)
      ))[0]
      : null;
    const selectedCandidates = currentSettlementCandidate
      ? [currentSettlementCandidate] : candidates;
    const templates = await mapWithQueryConcurrency(selectedCandidates, candidate => readThroughLru(
      templateCache,
      candidate.settlementId,
      TEMPLATE_CACHE_CAPACITY,
      () => resolveTemplate({ candidate }),
    ));
    const ownerQueries = new Map();
    const addOwnerCoordinate = (chunkX, chunkZ) => {
      const key = `${chunkX},${chunkZ}`;
      if (!ownerQueries.has(key)) {
        ownerQueries.set(key, {
          key,
          chunkX,
          chunkZ,
          settlementIds: new Set(),
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
    for (const template of templates) {
      for (const building of template.buildings) {
        if (Math.hypot(
          building.x - centerWorldX,
          building.z - centerWorldZ,
        ) <= queryRadius) addSettlementOwner(building, template.settlementId);
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
          ) <= queryRadius) addSettlementOwner(point, template.settlementId);
        }
      }
      if (Math.hypot(
        template.center.x - centerWorldX,
        template.center.z - centerWorldZ,
      ) <= queryRadius + 32) addSettlementOwner(template.center, template.settlementId);
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
            W8_HIGH_TREE_SILHOUETTE_VISIBILITY_METERS,
          )) owner.includeNaturalInner = true;
          else owner.includeNaturalUltra = true;
        }
      }
    }
    const owners = [...ownerQueries.values()]
      .filter(owner => !activeKeys.has(owner.key))
      .sort((left, right) => (
      Number(left.includeNaturalUltra && !left.includeNaturalInner && !left.settlementIds.size)
        - Number(right.includeNaturalUltra && !right.includeNaturalInner && !right.settlementIds.size)
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
      && !owner.includeNaturalInner && owner.settlementIds.size === 0;
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
          () => getCanonicalChunkData(owner.chunkX, owner.chunkZ),
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
    });
    const innerOwners = owners.filter(owner => !ultraOnlyOwner(owner));
    const ultraOwners = owners.filter(ultraOnlyOwner);
    const innerWarmStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const innerChunks = await loadOwners(innerOwners);
    const innerWarmDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - innerWarmStartedAt;
    const ultraWarmStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const ultraChunks = await loadOwners(ultraOwners);
    const ultraWarmDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - ultraWarmStartedAt;
    const chunks = [...innerChunks, ...ultraChunks].sort((left, right) => (
      left.chunkZ - right.chunkZ || left.chunkX - right.chunkX
    ));
    return {
      queryCenter: { x: centerWorldX, z: centerWorldZ },
      naturalQueryCenter: { x: naturalCenterWorldX, z: naturalCenterWorldZ },
      queryRadius,
      visibilityMeters,
      naturalVisibilityMeters,
      naturalQueryRadius,
      candidateCount: candidates.length,
      currentSettlementId: currentSettlementCandidate?.settlementId ?? null,
      templateSuccessCount: templates.length,
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
      landmarkCount: chunks.reduce(
        (sum, value) => sum + (value.chunk?.settlementLandmarks?.length ?? 0),
        0,
      ),
      settlementIds: new Set(selectedCandidates.map(candidate => candidate.settlementId)),
      chunks: chunks.filter(value => value.chunk),
    };
  };

  return Object.freeze({
    async sync({
      activeDataKeys,
      renderedKeys,
      getChunkData,
      renderOrigin,
      centerChunkX,
      centerChunkZ,
      quality = 'high',
      playerLogicalX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
      playerLogicalZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
      includeFarNatural = true,
      includeUltraNatural = true,
    }) {
      if (disposed) throw new Error('distant presentation is disposed');
      const epoch = ++syncEpoch;
      const rendered = new Set(renderedKeys);
      const activeKeys = new Set(activeDataKeys);
      if (activeGeneration) {
        activeGeneration.renderedKeys = rendered;
        activeGeneration.activeKeys = activeKeys;
        activeGeneration.quality = quality;
        positionGenerationForOrigin(activeGeneration, renderOrigin);
        updateCanonicalVisibility(
          activeGeneration,
          playerLogicalX,
          playerLogicalZ,
        );
      }
      const activeChunks = new Map();
      measure('distant-collect', () => {
        for (const key of activeDataKeys) {
          const [chunkX, chunkZ] = key.split(',').map(Number);
          const chunk = getChunkData(chunkX, chunkZ);
          if (chunk) activeChunks.set(key, chunk);
        }
      });
      const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
      const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
      const far = await prepareCanonicalFarChunks({
        centerWorldX,
        centerWorldZ,
        naturalCenterWorldX: playerLogicalX,
        naturalCenterWorldZ: playerLogicalZ,
        quality,
        activeKeys,
        includeFarNatural,
        includeUltraNatural,
      });
      if (disposed || epoch !== syncEpoch) {
        staleEpochDiscardCount += 1;
        return false;
      }

      const midground = [...activeChunks].filter(([key]) => !rendered.has(key)).map(([, value]) => value);
      midground.sort((a, b) => a.chunkZ - b.chunkZ || a.chunkX - b.chunkX);
      const stagingRoot = new Group();
      stagingRoot.name = `w8-distant-presentation-epoch-${epoch}`;
      stagingRoot.userData = { presentationOnly: true, epoch };
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
        buildOriginChunkX: renderOrigin.renderOriginChunkX,
        buildOriginChunkZ: renderOrigin.renderOriginChunkZ,
        currentOriginChunkX: renderOrigin.renderOriginChunkX,
        currentOriginChunkZ: renderOrigin.renderOriginChunkZ,
        playerX: playerLogicalX,
        playerZ: playerLogicalZ,
        queryCandidateCount: far.candidateCount,
        queryTemplateSuccessCount: far.templateSuccessCount,
        queryOwnerChunkCount: far.ownerChunkCount,
        queryOwnerChunkKeys: far.ownerChunkKeys,
        queryNaturalOwnerChunkCount: far.naturalOwnerChunkCount,
        queryNaturalOwnerChunkKeys: far.naturalOwnerChunkKeys,
        queryInnerNaturalOwnerChunkCount: far.innerNaturalOwnerChunkCount,
        queryUltraOwnerChunkCount: far.ultraOwnerChunkCount,
        queryUltraOwnerChunkKeys: far.ultraOwnerChunkKeys,
        queryBuildingOwnerChunkCount: far.buildingOwnerChunkCount,
        queryBuildingOwnerChunkKeys: far.buildingOwnerChunkKeys,
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
        queryCanonicalChunkSuccessCount: far.canonicalChunkSuccessCount,
        querySettlementFeatureCount: far.settlementFeatureCount,
        queryLandmarkCount: far.landmarkCount,
        queryRadius: far.queryRadius,
        visibilityMeters: far.visibilityMeters,
        naturalVisibilityMeters: far.naturalVisibilityMeters,
        naturalQueryRadius: far.naturalQueryRadius,
        currentSettlementId: far.currentSettlementId,
      };
      buildTarget = stagingRoot;
      buildOwnedGeometries = generation.ownedGeometries;
      buildStats = generation.stats;
      buildGeneration = generation;
      try {
        buildStats.midgroundChunkCount = midground.length;
        measure('distant-midground-terrain', () => createMidgroundTerrain(midground, renderOrigin));
        measure('distant-midground-features', () => createMidgroundNaturalFeatures(
          midground,
          renderOrigin,
          centerChunkX,
          centerChunkZ,
        ));
        measure('distant-canonical-active', () => {
          const chunks = [...activeChunks.values()].sort((left, right) => (
            left.chunkZ - right.chunkZ || left.chunkX - right.chunkX
          ));
          for (const chunk of chunks) addCanonicalChunk({
            chunk,
            origin: renderOrigin,
            coveredSettlementIds: far.settlementIds,
            includeNatural: true,
            farNaturalEligible: true,
          });
        });
        measure('distant-canonical-far', () => {
          for (const source of far.chunks) {
            addCanonicalChunk({
              chunk: source.chunk,
              origin: renderOrigin,
              farEligibleSettlementIds: source.settlementIds,
              includeNatural: source.includeNaturalInner || source.includeNaturalUltra,
              farNaturalEligible: source.includeNaturalInner || source.includeNaturalUltra,
              queryCenter: far.queryCenter,
              naturalQueryCenter: far.naturalQueryCenter,
              queryRadius: far.queryRadius,
              naturalQueryRadius: far.naturalQueryRadius,
            });
          }
          finalizeCanonicalMeshes();
        });
        measure('distant-clipmap', () => createClipmap({
          centerChunkX,
          centerChunkZ,
          activeChunks,
          origin: renderOrigin,
        }));
        measure('distant-feature-proxies', () => createDistantNaturalAndWaterProxies({
          centerChunkX,
          centerChunkZ,
          activeChunks,
          origin: renderOrigin,
        }));
        positionGenerationForOrigin(generation, renderOrigin);
        updateCanonicalVisibility(generation, playerLogicalX, playerLogicalZ);
      } catch (error) {
        disposeGeneration(generation);
        throw error;
      } finally {
        buildTarget = null;
        buildOwnedGeometries = null;
        buildStats = null;
        buildGeneration = null;
      }
      if (disposed || epoch !== syncEpoch) {
        disposeGeneration(generation);
        staleEpochDiscardCount += 1;
        return false;
      }
      const previous = activeGeneration;
      root.add(generation.root);
      activeGeneration = generation;
      committedEpoch = epoch;
      disposeGeneration(previous);
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
    update(playerLogicalX, playerLogicalZ, renderOrigin) {
      if (disposed || !activeGeneration) return;
      positionGenerationForOrigin(activeGeneration, renderOrigin);
      updateCanonicalVisibility(activeGeneration, playerLogicalX, playerLogicalZ);
    },
    rebase(renderOrigin) {
      if (disposed || !activeGeneration) return;
      positionGenerationForOrigin(activeGeneration, renderOrigin);
    },
    snapshot() {
      const stats = activeGeneration?.stats ?? emptyStats;
      return Object.freeze({
        schemaVersion: 'w8-distant-presentation-snapshot-1',
        ...stats,
        clipmapExtentMeters: CLIPMAP_EXTENT_METERS,
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
        queryCanonicalChunkSuccessCount:
          activeGeneration?.queryCanonicalChunkSuccessCount ?? 0,
        querySettlementFeatureCount: activeGeneration?.querySettlementFeatureCount ?? 0,
        queryLandmarkCount: activeGeneration?.queryLandmarkCount ?? 0,
        currentSettlementId: activeGeneration?.currentSettlementId ?? null,
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
        syncEpoch,
        committedEpoch,
        staleEpochDiscardCount,
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
        clipmapSampleCacheSize: clipmapSampleCache.size,
        clipmapSampleCacheCapacity: CLIPMAP_SAMPLE_CACHE_CAPACITY,
        clipmapSampleCacheHits,
        clipmapSampleCacheMisses,
        clipmapSampleCacheEvictions,
        rootObjectCount: activeGeneration?.root.children?.length ?? 0,
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
      disposeGeneration(activeGeneration);
      activeGeneration = null;
      scene.remove(root);
      roadGeometry.dispose?.();
      terrainMaterial.dispose?.();
      clipmapSampleCache.clear();
      templateCache.clear();
      farOwnerChunkCache.clear();
      ultraOwnerChunkCache.clear();
      disposed = true;
    },
  });
}
