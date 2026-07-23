import {
  LOGICAL_CHUNK_SIZE_METERS,
  UNITS_PER_METER,
} from '../chunk-coordinates.js';
import { createMacroTerrainEvaluator, G5_MACRO_TERRAIN } from '../legacy-core/g5/macro-terrain.js';
import { createNaturalBiomeEvaluator, naturalMaterialWeights } from '../natural-biome-field.js';

const FIVE_BY_FIVE_HALF_EXTENT_METERS = LOGICAL_CHUNK_SIZE_METERS * 2.5;
const CLIPMAP_EXTENT_METERS = 352;
const CLIPMAP_BLEND_METERS = 16;
const CLIPMAP_SAMPLE_CACHE_CAPACITY = 65_536;

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

function presentationClusterRoll(candidate) {
  const x = Math.floor((candidate?.worldPosition?.x ?? 0) / 12);
  const z = Math.floor((candidate?.worldPosition?.z ?? 0) / 12);
  let value = Math.imul(x ^ 0x51ed270b, 0x85ebca6b)
    ^ Math.imul(z ^ 0x68bc21eb, 0xc2b2ae35);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return (value >>> 0) / 0x1_0000_0000;
}

export function isW8NaturalCandidateVisible(candidate, distanceChunks = 0) {
  if (candidate?.candidateId === undefined) return true;
  const cluster = presentationClusterRoll(candidate);
  const clusteredThreshold = cluster < 0.28 ? 0.22 : cluster < 0.65 ? 0.48 : 0.68;
  const subtypeAdjustment = candidate.subtype === 'shrub' ? -0.08 : 0;
  const distanceAdjustment = Math.max(0, distanceChunks - 1.25) * 0.1;
  return candidate.variationSeed >= clamp(
    clusteredThreshold + subtypeAdjustment + distanceAdjustment,
    0.12,
    0.82,
  );
}

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new TypeError(`THREE.${name} is required`);
  return THREE[name];
}

function colorFromWeights(weights) {
  return [0, 1, 2].map(channel => weights.reduce(
    (sum, weight, index) => sum + weight * W8_PRESENTATION_TERRAIN_PALETTE[index][channel],
    0,
  ));
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

function terrainSampleAt(chunkData, worldX, worldZ) {
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
  const at = (x, z) => terrain.heights[z * terrain.resolution.x + x]
    * terrain.heightUnitMeters;
  return (at(x0, z0) * (1 - tx) + at(x1, z0) * tx) * (1 - tz)
    + (at(x0, z1) * (1 - tx) + at(x1, z1) * tx) * tz;
}

function sampleActiveTerrain(activeChunks, worldX, worldZ) {
  const epsilon = 1e-6;
  const chunkX = Math.floor((worldX - epsilon) / LOGICAL_CHUNK_SIZE_METERS);
  const chunkZ = Math.floor((worldZ - epsilon) / LOGICAL_CHUNK_SIZE_METERS);
  const direct = activeChunks.get(`${chunkX},${chunkZ}`);
  if (direct) return terrainSampleAt(direct, worldX, worldZ);
  for (const chunk of activeChunks.values()) {
    const minimumX = chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS - epsilon;
    const minimumZ = chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS - epsilon;
    if (worldX >= minimumX && worldX <= minimumX + LOGICAL_CHUNK_SIZE_METERS + epsilon
      && worldZ >= minimumZ && worldZ <= minimumZ + LOGICAL_CHUNK_SIZE_METERS + epsilon) {
      return terrainSampleAt(chunk, worldX, worldZ);
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
  const normals = new Float32Array(positions.length);
  for (let index = 1; index < normals.length; index += 3) normals[index] = 1;
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

export async function createW8DistantPresentation({
  THREE,
  scene,
  worldSeedHash,
  visualAssets,
  isFeatureDestroyed = () => false,
  measure = (_stage, operation) => operation(),
} = {}) {
  if (!scene?.add || !scene?.remove) throw new TypeError('a Three.js scene is required');
  const Group = requireConstructor(THREE, 'Group');
  const Mesh = requireConstructor(THREE, 'Mesh');
  const InstancedMesh = requireConstructor(THREE, 'InstancedMesh');
  const Object3D = requireConstructor(THREE, 'Object3D');
  const PlaneGeometry = requireConstructor(THREE, 'PlaneGeometry');
  const Material = requireConstructor(THREE, 'MeshLambertMaterial');
  const macroEvaluator = await createMacroTerrainEvaluator(worldSeedHash);
  const biomeEvaluator = await createNaturalBiomeEvaluator({ worldSeedHash });
  const root = new Group();
  root.name = 'w8-scene-owned-distant-world';
  root.userData = { presentationOnly: true };
  scene.add(root);
  const terrainMaterial = new Material({ vertexColors: true, flatShading: true });
  const roadGeometry = new PlaneGeometry(1, 1);
  const ownedGeometries = new Set([roadGeometry]);
  const transform = new Object3D();
  let midgroundChunkCount = 0;
  let clipmapMeshCount = 0;
  let maximumInnerBoundaryErrorMeters = 0;
  let clipmapDeterministicChecksum = 0;
  const clipmapSampleCache = new Map();
  let clipmapSampleCacheHits = 0;
  let clipmapSampleCacheMisses = 0;
  let clipmapSampleCacheEvictions = 0;
  let disposed = false;

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
      color: Object.freeze(colorFromWeights(naturalMaterialWeights(
        biome.memberships, moisture, rockiness, slope,
      ))),
    });
    clipmapSampleCache.set(key, value);
    clipmapSampleCacheMisses += 1;
    while (clipmapSampleCache.size > CLIPMAP_SAMPLE_CACHE_CAPACITY) {
      clipmapSampleCache.delete(clipmapSampleCache.keys().next().value);
      clipmapSampleCacheEvictions += 1;
    }
    return value;
  };

  const clear = () => {
    for (const child of root.children ?? []) child.dispose?.();
    root.clear?.();
    for (const geometry of ownedGeometries) {
      if (geometry !== roadGeometry) geometry.dispose?.();
    }
    for (const geometry of [...ownedGeometries]) if (geometry !== roadGeometry) ownedGeometries.delete(geometry);
    midgroundChunkCount = 0;
    clipmapMeshCount = 0;
    maximumInnerBoundaryErrorMeters = 0;
    clipmapDeterministicChecksum = 0;
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
          colors.push(...colorFromWeights(terrain.materialWeights.slice(index * 5, index * 5 + 5)));
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
    ownedGeometries.add(geometry);
    const mesh = new Mesh(geometry, terrainMaterial);
    mesh.name = 'w8-midground-outer-sixteen-terrain';
    mesh.castShadow = false; mesh.receiveShadow = false;
    root.add(mesh);
  };

  const createMidgroundFeatures = (chunks, origin, centerChunkX, centerChunkZ) => {
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
    const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const presentationDistanceChunks = candidate => Math.hypot(
        candidate.worldPosition.x - centerWorldX,
        candidate.worldPosition.z - centerWorldZ,
      ) / LOGICAL_CHUNK_SIZE_METERS;
    const junctions = new Map();
    for (const chunk of chunks) {
      const layers = chunk.presentationLayers;
      for (const feature of layers?.formal?.roadsAndBuildings ?? chunk.settlementFeatures ?? []) {
        if (feature.featureType === 'settlement-road') {
          const dx = feature.end.x - feature.start.x; const dz = feature.end.z - feature.start.z;
          transform.position.set(
            ((feature.start.x + feature.end.x) / 2 - originMetersX) * UNITS_PER_METER,
            (feature.worldPosition.y + 0.075) * UNITS_PER_METER,
            ((feature.start.z + feature.end.z) / 2 - originMetersZ) * UNITS_PER_METER,
          );
          transform.rotation.set(-Math.PI / 2, 0, Math.atan2(dz, dx));
          transform.scale.set(Math.hypot(dx, dz) * UNITS_PER_METER,
            feature.widthMeters * UNITS_PER_METER, 1);
          transform.updateMatrix();
          push('__road__', 'road', transform.matrix, 'roads');
          for (const point of [feature.start, feature.end]) {
            const key = `${Math.round(point.x * 100)},${Math.round(point.z * 100)}`;
            const junction = junctions.get(key) ?? {
              x: point.x, z: point.z, y: 0, count: 0, widthMeters: 0,
            };
            junction.y += feature.worldPosition.y;
            junction.count += 1;
            junction.widthMeters = Math.max(junction.widthMeters, feature.widthMeters);
            junctions.set(key, junction);
          }
        } else if (feature.featureType === 'settlement-building') {
          const civic = ['school', 'church'].includes(feature.buildingType);
          for (const surface of [feature.lot?.path, feature.lot?.forecourt]) {
            if (!surface || !(surface.width > 0) || !(surface.depth > 0)) continue;
            transform.position.set(
              (surface.centerX - originMetersX) * UNITS_PER_METER,
              (feature.worldPosition.y + 0.07575) * UNITS_PER_METER,
              (surface.centerZ - originMetersZ) * UNITS_PER_METER,
            );
            transform.rotation.set(-Math.PI / 2, 0, surface.rotationY);
            transform.scale.set(surface.width * UNITS_PER_METER,
              surface.depth * UNITS_PER_METER, 1);
            transform.updateMatrix();
            push('__road__', civic ? 'lotCivic' : 'lotResidential', transform.matrix, 'lots');
          }
          addParts(feature, feature.buildingType, {
            width: feature.widthMeters * UNITS_PER_METER,
            height: feature.heightMeters * UNITS_PER_METER,
            depth: feature.depthMeters * UNITS_PER_METER,
          }, 'settlement');
        }
      }
      for (const landmark of layers?.landmarks ?? chunk.settlementLandmarks ?? []) {
        addParts(landmark, landmark.landmarkType, {
          width: landmark.widthMeters * UNITS_PER_METER,
          height: landmark.heightMeters * UNITS_PER_METER,
          depth: landmark.depthMeters * UNITS_PER_METER,
        }, 'landmark');
      }
      for (const candidate of layers?.natural?.vegetation ?? chunk.vegetationCandidates ?? []) {
        if (!isW8NaturalCandidateVisible(candidate, presentationDistanceChunks(candidate))) continue;
        const kind = candidate.subtype === 'wetland-tree' ? 'wetlandTree'
          : candidate.subtype === 'broadleaf-tree' ? 'broadleafTree' : 'tree';
        const variation = 0.84 + candidate.variationSeed * 0.32;
        addParts(candidate, kind, {
          width: 2 * variation * UNITS_PER_METER,
          height: 3.625 * variation * UNITS_PER_METER,
          depth: 2 * variation * UNITS_PER_METER,
        }, 'major-natural');
      }
      for (const candidate of layers?.natural?.rocks ?? chunk.rockCandidates ?? []) {
        if (candidate.variationSeed < clamp(
          0.42 + Math.max(0, presentationDistanceChunks(candidate) - 1.5) * 0.12,
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
    for (const junction of junctions.values()) {
      if (junction.count < 2) continue;
      transform.position.set(
        (junction.x - originMetersX) * UNITS_PER_METER,
        (junction.y / junction.count + 0.0755) * UNITS_PER_METER,
        (junction.z - originMetersZ) * UNITS_PER_METER,
      );
      transform.rotation.set(-Math.PI / 2, 0, 0);
      transform.scale.set(junction.widthMeters * 1.08 * UNITS_PER_METER,
        junction.widthMeters * 1.08 * UNITS_PER_METER, 1);
      transform.updateMatrix();
      push('__road__', 'road', transform.matrix, 'junctions');
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
      root.add(mesh);
    }
  };

  const createClipmap = ({ centerChunkX, centerChunkZ, activeChunks, origin }) => {
    const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const axis = clipmapAxis(); const positions = []; const colors = []; const indices = [];
    const vertex = new Map();
    const sample = (x, z) => {
      const key = `${x},${z}`;
      if (vertex.has(key)) return vertex.get(key);
      const worldX = centerWorldX + x; const worldZ = centerWorldZ + z;
      const base = baseClipmapSample(worldX, worldZ);
      let height = base.height;
      const distanceOutside = Math.max(Math.abs(x), Math.abs(z)) - FIVE_BY_FIVE_HALF_EXTENT_METERS;
      if (distanceOutside <= CLIPMAP_BLEND_METERS) {
        const boundaryX = centerWorldX + clamp(x,
          -FIVE_BY_FIVE_HALF_EXTENT_METERS, FIVE_BY_FIVE_HALF_EXTENT_METERS);
        const boundaryZ = centerWorldZ + clamp(z,
          -FIVE_BY_FIVE_HALF_EXTENT_METERS, FIVE_BY_FIVE_HALF_EXTENT_METERS);
        const actual = sampleActiveTerrain(activeChunks, boundaryX, boundaryZ);
        if (actual !== null) {
          const boundaryMacro = 0.4 + macroEvaluator.evaluate(boundaryX, boundaryZ).offsetMm * 0.001;
          height += (actual - boundaryMacro) * (1 - smoothstep(distanceOutside / CLIPMAP_BLEND_METERS));
          if (Math.abs(distanceOutside) < 1e-9) {
            maximumInnerBoundaryErrorMeters = Math.max(
              maximumInnerBoundaryErrorMeters,
              Math.abs(height - actual),
            );
          }
        }
      }
      const index = positions.length / 3;
      positions.push((worldX - originMetersX) * UNITS_PER_METER, height * UNITS_PER_METER,
        (worldZ - originMetersZ) * UNITS_PER_METER);
      colors.push(...base.color);
      vertex.set(key, index);
      return index;
    };
    for (let z = 0; z < axis.length - 1; z += 1) for (let x = 0; x < axis.length - 1; x += 1) {
      const x0 = axis[x]; const x1 = axis[x + 1]; const z0 = axis[z]; const z1 = axis[z + 1];
      const centerX = (x0 + x1) / 2; const centerZ = (z0 + z1) / 2;
      if (Math.max(Math.abs(centerX), Math.abs(centerZ)) < FIVE_BY_FIVE_HALF_EXTENT_METERS) continue;
      const northwest = sample(x0, z0); const northeast = sample(x1, z0);
      const southwest = sample(x0, z1); const southeast = sample(x1, z1);
      indices.push(northwest, southwest, northeast, northeast, southwest, southeast);
    }
    const geometry = makeGeometry(THREE, positions, colors, indices);
    let checksum = 0x811c9dc5;
    for (const value of [...positions, ...colors]) {
      checksum ^= Math.round(value * 1000);
      checksum = Math.imul(checksum, 0x01000193) >>> 0;
    }
    clipmapDeterministicChecksum = checksum;
    ownedGeometries.add(geometry);
    const mesh = new Mesh(geometry, terrainMaterial);
    mesh.name = 'w8-seeded-macro-terrain-clipmap';
    mesh.castShadow = false; mesh.receiveShadow = false;
    root.add(mesh); clipmapMeshCount = 1;
  };

  return Object.freeze({
    async sync({ activeDataKeys, renderedKeys, getChunkData, renderOrigin, centerChunkX, centerChunkZ }) {
      if (disposed) throw new Error('distant presentation is disposed');
      measure('distant-clear', clear);
      const rendered = new Set(renderedKeys);
      const activeChunks = new Map();
      measure('distant-collect', () => {
        for (const key of activeDataKeys) {
          const [chunkX, chunkZ] = key.split(',').map(Number);
          const chunk = getChunkData(chunkX, chunkZ);
          if (chunk) activeChunks.set(key, chunk);
        }
      });
      const midground = [...activeChunks].filter(([key]) => !rendered.has(key)).map(([, value]) => value);
      midground.sort((a, b) => a.chunkZ - b.chunkZ || a.chunkX - b.chunkX);
      midgroundChunkCount = midground.length;
      measure('distant-midground-terrain', () => createMidgroundTerrain(midground, renderOrigin));
      measure('distant-midground-features', () => createMidgroundFeatures(
        midground, renderOrigin, centerChunkX, centerChunkZ,
      ));
      measure('distant-clipmap', () => createClipmap({
        centerChunkX, centerChunkZ, activeChunks, origin: renderOrigin,
      }));
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: 'w8-distant-presentation-snapshot-1',
        midgroundChunkCount,
        clipmapMeshCount,
        clipmapExtentMeters: CLIPMAP_EXTENT_METERS,
        maximumInnerBoundaryErrorMeters,
        clipmapDeterministicChecksum,
        clipmapSampleCacheSize: clipmapSampleCache.size,
        clipmapSampleCacheCapacity: CLIPMAP_SAMPLE_CACHE_CAPACITY,
        clipmapSampleCacheHits,
        clipmapSampleCacheMisses,
        clipmapSampleCacheEvictions,
        rootObjectCount: root.children?.length ?? 0,
        disposed,
      });
    },
    dispose() {
      if (disposed) return;
      clear();
      scene.remove(root);
      roadGeometry.dispose?.();
      terrainMaterial.dispose?.();
      ownedGeometries.clear();
      clipmapSampleCache.clear();
      disposed = true;
    },
  });
}
