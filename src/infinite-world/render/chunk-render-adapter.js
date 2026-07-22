import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_CHUNK_SIZE,
  SUPPORTED_RENDER_CHUNK_SIZES,
  chunkRenderPosition,
  createChunkKey,
} from '../chunk-coordinates.js';
import { createProductionVisualAssetLibrary } from './production-visual-assets.js';

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new TypeError(`THREE.${name} is required`);
  return THREE[name];
}

export class ChunkRenderAdapter {
  constructor({
    THREE,
    scene,
    renderChunkSize = RENDER_CHUNK_SIZE,
    isFeatureDestroyed = () => false,
    visualAssets = null,
  } = {}) {
    if (!scene || typeof scene.add !== 'function' || typeof scene.remove !== 'function') {
      throw new TypeError('a Three.js scene is required');
    }
    if (!SUPPORTED_RENDER_CHUNK_SIZES.includes(renderChunkSize)) {
      throw new RangeError(`renderChunkSize must be one of ${SUPPORTED_RENDER_CHUNK_SIZES.join(', ')}`);
    }
    this.THREE = THREE;
    this.scene = scene;
    this.renderChunkSize = renderChunkSize;
    this.unitsPerMeter = renderChunkSize / LOGICAL_CHUNK_SIZE_METERS;
    this.renderOriginChunkX = 0;
    this.renderOriginChunkZ = 0;
    this.loaded = new Map();
    if (typeof isFeatureDestroyed !== 'function') throw new TypeError('isFeatureDestroyed must be a function');
    this.isFeatureDestroyed = isFeatureDestroyed;
    this.featureInstances = new Map();
    this.chunkFeatureIds = new Map();
    this.disposed = false;
    this.visualAssets = visualAssets ?? createProductionVisualAssetLibrary({ THREE });
    this.ownsVisualAssets = visualAssets === null;
    this.settlementResources = null;
    this.counts = {
      projected: 0,
      loaded: 0,
      unloaded: 0,
      rebased: 0,
      chunkOwnedGeometriesCreated: 0,
      chunkOwnedGeometriesDisposed: 0,
    };

    const Group = requireConstructor(THREE, 'Group');
    const PlaneGeometry = requireConstructor(THREE, 'PlaneGeometry');
    const MeshLambertMaterial = requireConstructor(THREE, 'MeshLambertMaterial');
    const Object3D = requireConstructor(THREE, 'Object3D');
    this.worldRoot = new Group();
    this.worldRoot.name = 'w1a-render-root';
    this.scene.add(this.worldRoot);
    this.geometries = Object.freeze({
      terrain: new PlaneGeometry(renderChunkSize, renderChunkSize),
    });
    this.materials = Object.freeze({
      terrain: new MeshLambertMaterial({ color: 0x668c54, flatShading: true }),
      naturalTerrain: new MeshLambertMaterial({ vertexColors: true, flatShading: false }),
    });
    const hiddenTransform = new Object3D();
    hiddenTransform.scale.set(0, 0, 0);
    hiddenTransform.updateMatrix();
    this.hiddenFeatureMatrix = hiddenTransform.matrix.clone?.() ?? structuredClone(hiddenTransform.matrix);
  }

  #cloneMatrix(matrix) {
    return matrix.clone?.() ?? structuredClone(matrix);
  }

  #registerFeatureInstance({ stableId, chunkKey, mesh, index, matrix }) {
    if (typeof stableId !== 'string' || !stableId) throw new Error(`invalid render feature Stable ID: ${chunkKey}`);
    let existing = this.featureInstances.get(stableId);
    if (existing && existing.chunkKey !== chunkKey) {
      throw new Error(`Stable ID collision in render adapter: ${stableId}`);
    }
    const part = { mesh, index, originalMatrix: this.#cloneMatrix(matrix) };
    if (!existing) {
      existing = { stableId, chunkKey, mesh, index, originalMatrix: part.originalMatrix, parts: [] };
      this.featureInstances.set(stableId, existing);
    }
    existing.parts.push(part);
    if (!this.chunkFeatureIds.has(chunkKey)) this.chunkFeatureIds.set(chunkKey, new Set());
    this.chunkFeatureIds.get(chunkKey).add(stableId);
    mesh.setMatrixAt(index, this.isFeatureDestroyed(stableId)
      ? this.hiddenFeatureMatrix : part.originalMatrix);
  }

  setFeatureDestroyed(stableId, destroyed = true) {
    const entry = this.featureInstances.get(stableId);
    if (!entry) return false;
    for (const part of entry.parts) {
      part.mesh.setMatrixAt(part.index, destroyed ? this.hiddenFeatureMatrix : part.originalMatrix);
      part.mesh.instanceMatrix.needsUpdate = true;
    }
    return true;
  }

  refreshFeatureStates() {
    for (const [stableId, entry] of this.featureInstances) {
      for (const part of entry.parts) {
        part.mesh.setMatrixAt(part.index, this.isFeatureDestroyed(stableId)
          ? this.hiddenFeatureMatrix : part.originalMatrix);
        part.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  async rebase(origin) {
    if (this.disposed) throw new Error('render adapter is shut down');
    this.renderOriginChunkX = origin.renderOriginChunkX;
    this.renderOriginChunkZ = origin.renderOriginChunkZ;
    for (const projected of this.loaded.values()) this.#positionGroup(projected);
    if (origin.rebaseCount > this.counts.rebased) this.counts.rebased = origin.rebaseCount;
  }

  #positionGroup(projected) {
    const position = chunkRenderPosition(
      projected.chunkX,
      projected.chunkZ,
      this.renderOriginChunkX,
      this.renderOriginChunkZ,
      this.renderChunkSize,
    );
    projected.group.position.set(position.x, 0, position.z);
  }

  #createNaturalTerrainGeometry(terrain) {
    const BufferGeometry = requireConstructor(this.THREE, 'BufferGeometry');
    const Float32BufferAttribute = requireConstructor(this.THREE, 'Float32BufferAttribute');
    const width = terrain.resolution.x;
    const depth = terrain.resolution.z;
    const positions = [];
    const colors = [];
    const indices = [];
    const palette = [
      [0.34, 0.53, 0.22],
      [0.45, 0.35, 0.22],
      [0.24, 0.31, 0.2],
      [0.58, 0.52, 0.34],
      [0.43, 0.44, 0.42],
    ];
    for (let z = 0; z < depth; z += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = z * width + x;
        positions.push(
          x / (width - 1) * this.renderChunkSize,
          terrain.heights[index] * terrain.heightUnitMeters * this.unitsPerMeter,
          z / (depth - 1) * this.renderChunkSize,
        );
        const weights = terrain.materialWeights.slice(index * 5, index * 5 + 5);
        for (let channel = 0; channel < 3; channel += 1) {
          colors.push(weights.reduce((sum, weight, material) => sum + weight * palette[material][channel], 0));
        }
      }
    }
    for (let z = 0; z < depth - 1; z += 1) {
      for (let x = 0; x < width - 1; x += 1) {
        const northwest = z * width + x;
        const northeast = northwest + 1;
        const southwest = northwest + width;
        const southeast = southwest + 1;
        indices.push(northwest, southwest, northeast, northeast, southwest, southeast);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    this.counts.chunkOwnedGeometriesCreated += 1;
    return geometry;
  }

  #ensureSettlementResources() {
    if (this.settlementResources) return this.settlementResources;
    const PlaneGeometry = requireConstructor(this.THREE, 'PlaneGeometry');
    this.settlementResources = Object.freeze({
      geometries: Object.freeze({ road: new PlaneGeometry(1, 1) }),
      materials: Object.freeze({
        road: this.visualAssets.materials.road,
      }),
    });
    return this.settlementResources;
  }

  #createProductionPartMeshes({ group, chunkKey, name, items }) {
    if (!items.length) return [];
    const InstancedMesh = requireConstructor(this.THREE, 'InstancedMesh');
    const byResource = new Map();
    for (const item of items) {
      const resourceKey = `${item.part.geometry}:${item.part.material}`;
      if (!byResource.has(resourceKey)) byResource.set(resourceKey, []);
      byResource.get(resourceKey).push(item);
    }
    const meshes = [];
    for (const [resourceKey, resourceItems] of byResource) {
      const descriptor = resourceItems[0].part;
      const mesh = new InstancedMesh(
        this.visualAssets.geometries[descriptor.geometry],
        this.visualAssets.materials[descriptor.material],
        Math.max(1, resourceItems.length),
      );
      mesh.name = `${name}-${resourceKey.replace(':', '-')}`;
      mesh.count = resourceItems.length;
      resourceItems.forEach((item, index) => {
        mesh.setMatrixAt(index, item.matrix);
        this.#registerFeatureInstance({
          stableId: item.stableId,
          chunkKey,
          mesh,
          index,
          matrix: item.matrix,
        });
      });
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }

  async projectChunk(chunkData) {
    if (this.disposed) throw new Error('render adapter is shut down');
    if (!chunkData) throw new TypeError('ChunkData is required for rendering');
    const { Group, Mesh, InstancedMesh, Object3D } = this.THREE;
    for (const name of ['Group', 'Mesh', 'InstancedMesh', 'Object3D']) {
      requireConstructor(this.THREE, name);
    }
    const key = createChunkKey(chunkData.chunkX, chunkData.chunkZ);
    const vegetation = chunkData.vegetationCandidates ?? chunkData.vegetationProxies ?? [];
    const rocks = chunkData.rockCandidates ?? chunkData.rockProxies ?? [];
    const settlementFeatures = chunkData.settlementFeatures ?? [];
    const group = new Group();
    group.name = `w1a-chunk-${key}`;
    group.userData = { chunkKey: key, chunkId: chunkData.chunkId, contentHash: chunkData.contentHash };

    const naturalTerrain = chunkData.terrain.resolution.x > 2 || chunkData.terrain.resolution.z > 2;
    const terrainGeometry = naturalTerrain
      ? this.#createNaturalTerrainGeometry(chunkData.terrain)
      : this.geometries.terrain;
    const terrain = new Mesh(
      terrainGeometry,
      naturalTerrain ? this.materials.naturalTerrain : this.materials.terrain,
    );
    terrain.name = naturalTerrain ? 'w2-natural-terrain' : 'w1a-terrain';
    if (!naturalTerrain) {
      terrain.rotation.x = -Math.PI / 2;
      terrain.position.set(this.renderChunkSize / 2, 0, this.renderChunkSize / 2);
    }
    group.add(terrain);

    const transform = new Object3D();
    const createPartMatrix = ({ localX, localZ, groundY, rotationY, width, height, depth, part }) => {
      const offsetX = part.position[0] * width;
      const offsetZ = part.position[2] * depth;
      const cosine = Math.cos(rotationY);
      const sine = Math.sin(rotationY);
      transform.position.set(
        localX * this.unitsPerMeter + offsetX * cosine + offsetZ * sine,
        groundY + part.position[1] * height,
        localZ * this.unitsPerMeter - offsetX * sine + offsetZ * cosine,
      );
      transform.rotation.set(
        part.rotation[0],
        rotationY + part.rotation[1],
        part.rotation[2],
      );
      transform.scale.set(
        width * part.scale[0],
        height * part.scale[1],
        depth * part.scale[2],
      );
      transform.updateMatrix();
      return this.#cloneMatrix(transform.matrix);
    };

    const vegetationParts = [];
    vegetation.forEach(candidate => {
      const formal = candidate.candidateId !== undefined;
      const localX = formal
        ? candidate.worldPosition.x - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalX;
      const localZ = formal
        ? candidate.worldPosition.z - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalZ;
      const groundY = formal ? candidate.worldPosition.y * this.unitsPerMeter : 0;
      const variation = formal ? 0.84 + candidate.variationSeed * 0.32 : 1;
      const shrub = formal && candidate.subtype === 'shrub';
      const radiusMeters = formal ? candidate.metadata.candidateRadiusMeters : 0.32;
      const width = radiusMeters * 2.2 * variation * this.unitsPerMeter;
      const height = (shrub ? 0.85 : 3.5) * variation * this.unitsPerMeter;
      const rotationY = formal ? candidate.orientationSeed * Math.PI * 2 : candidate.yawRadians;
      const visualKind = shrub ? 'shrub'
        : formal && ['broadleaf-tree', 'wetland-tree'].includes(candidate.subtype)
          ? 'broadleafTree' : 'tree';
      for (const descriptor of this.visualAssets.featureParts[visualKind]) {
        vegetationParts.push({
          stableId: candidate.candidateId ?? candidate.stableId,
          part: descriptor,
          matrix: createPartMatrix({
            localX, localZ, groundY, rotationY, width, height, depth: width, part: descriptor,
          }),
        });
      }
    });
    this.#createProductionPartMeshes({
      group,
      chunkKey: key,
      name: 'production-vegetation',
      items: vegetationParts,
    });

    const rockParts = [];
    rocks.forEach(candidate => {
      const formal = candidate.candidateId !== undefined;
      const localX = formal
        ? candidate.worldPosition.x - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalX;
      const localZ = formal
        ? candidate.worldPosition.z - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalZ;
      const groundY = formal ? candidate.worldPosition.y * this.unitsPerMeter : 0;
      const radiusMeters = formal ? candidate.metadata.candidateRadiusMeters : 0.45;
      const variation = formal ? 0.9 + candidate.variationSeed * 0.2 : 1;
      const width = radiusMeters * 2 * variation * this.unitsPerMeter;
      const height = radiusMeters * 1.25 * variation * this.unitsPerMeter;
      const rotationY = formal ? candidate.orientationSeed * Math.PI * 2 : candidate.yawRadians;
      const descriptor = this.visualAssets.featureParts.rock[0];
      rockParts.push({
        stableId: candidate.candidateId ?? candidate.stableId,
        part: descriptor,
        matrix: createPartMatrix({
          localX, localZ, groundY, rotationY, width, height, depth: width, part: descriptor,
        }),
      });
    });
    this.#createProductionPartMeshes({
      group,
      chunkKey: key,
      name: 'production-rock',
      items: rockParts,
    });

    if (settlementFeatures.length) {
      const resources = this.#ensureSettlementResources();
      const roads = settlementFeatures.filter(feature => feature.featureType === 'settlement-road');
      const buildings = settlementFeatures.filter(feature => feature.featureType === 'settlement-building');
      const roadMesh = new InstancedMesh(
        resources.geometries.road,
        resources.materials.road,
        Math.max(1, roads.length),
      );
      roadMesh.name = chunkData.generatorVersion?.major >= 500
        ? 'infinite-settlement-roads' : 'w4-rural-roads';
      roadMesh.count = roads.length;
      roads.forEach((road, index) => {
        const dx = road.end.x - road.start.x;
        const dz = road.end.z - road.start.z;
        const localX = (road.start.x + road.end.x) / 2
          - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS;
        const localZ = (road.start.z + road.end.z) / 2
          - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
        transform.position.set(
          localX * this.unitsPerMeter,
          road.worldPosition.y * this.unitsPerMeter + 3,
          localZ * this.unitsPerMeter,
        );
        transform.rotation.set(-Math.PI / 2, 0, Math.atan2(dz, dx));
        transform.scale.set(
          Math.hypot(dx, dz) * this.unitsPerMeter,
          road.widthMeters * this.unitsPerMeter,
          1,
        );
        transform.updateMatrix();
        roadMesh.setMatrixAt(index, transform.matrix);
      });
      roadMesh.instanceMatrix.needsUpdate = true;
      group.add(roadMesh);

      const buildingParts = [];
      buildings.forEach(building => {
        const localX = building.worldPosition.x
          - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS;
        const localZ = building.worldPosition.z
          - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
        const descriptors = this.visualAssets.featureParts[building.buildingType];
        if (!descriptors) throw new Error(`unsupported production building visual: ${building.buildingType}`);
        for (const descriptor of descriptors) {
          buildingParts.push({
            stableId: building.stableId,
            part: descriptor,
            matrix: createPartMatrix({
              localX,
              localZ,
              groundY: building.worldPosition.y * this.unitsPerMeter,
              rotationY: building.rotationY,
              width: building.widthMeters * this.unitsPerMeter,
              height: building.heightMeters * this.unitsPerMeter,
              depth: building.depthMeters * this.unitsPerMeter,
              part: descriptor,
            }),
          });
        }
      });
      this.#createProductionPartMeshes({
        group,
        chunkKey: key,
        name: chunkData.generatorVersion?.major >= 500
          ? 'production-infinite-settlement-building' : 'production-rural-building',
        items: buildingParts,
      });
    }

    const projected = {
      key,
      chunkX: chunkData.chunkX,
      chunkZ: chunkData.chunkZ,
      group,
      ownedGeometries: naturalTerrain ? [terrainGeometry] : [],
    };
    this.#positionGroup(projected);
    this.counts.projected += 1;
    return projected;
  }

  async loadProjected(projected) {
    if (!projected?.key || !projected.group) throw new TypeError('invalid projected chunk');
    if (this.loaded.has(projected.key)) throw new Error(`render chunk already loaded: ${projected.key}`);
    this.worldRoot.add(projected.group);
    this.loaded.set(projected.key, projected);
    this.counts.loaded += 1;
  }

  async unloadChunk(key) {
    const projected = this.loaded.get(key);
    if (!projected) throw new Error(`render chunk is not loaded: ${key}`);
    this.worldRoot.remove(projected.group);
    for (const geometry of projected.ownedGeometries) {
      geometry.dispose();
      this.counts.chunkOwnedGeometriesDisposed += 1;
    }
    projected.group.clear();
    for (const stableId of this.chunkFeatureIds.get(key) ?? []) this.featureInstances.delete(stableId);
    this.chunkFeatureIds.delete(key);
    this.loaded.delete(key);
    this.counts.unloaded += 1;
  }

  resourceSnapshot() {
    const visualResources = this.visualAssets.snapshot();
    return Object.freeze({
      liveChunkGroups: this.loaded.size,
      sharedGeometryCount: Object.keys(this.geometries).length
        + (this.settlementResources ? Object.keys(this.settlementResources.geometries).length : 0)
        + visualResources.sharedGeometryCount,
      sharedMaterialCount: Object.keys(this.materials).length
        + visualResources.sharedMaterialCount,
      sharedDisposed: this.disposed && (!this.ownsVisualAssets || visualResources.disposed),
      productionVisuals: visualResources,
      projectedCount: this.counts.projected,
      loadedCount: this.counts.loaded,
      unloadedCount: this.counts.unloaded,
      rebaseCount: this.counts.rebased,
      liveChunkOwnedGeometryCount: this.counts.chunkOwnedGeometriesCreated
        - this.counts.chunkOwnedGeometriesDisposed,
      chunkOwnedGeometriesCreated: this.counts.chunkOwnedGeometriesCreated,
      chunkOwnedGeometriesDisposed: this.counts.chunkOwnedGeometriesDisposed,
      trackedFeatureInstanceCount: this.featureInstances.size,
      chunkRenderables: Object.freeze(Object.fromEntries(
        [...this.loaded].map(([key, projected]) => [key, projected.group.children.length]),
      )),
    });
  }

  async shutdown() {
    if (this.disposed) return;
    for (const key of [...this.loaded.keys()]) await this.unloadChunk(key);
    this.scene.remove(this.worldRoot);
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    if (this.settlementResources) {
      for (const geometry of Object.values(this.settlementResources.geometries)) geometry.dispose();
    }
    if (this.ownsVisualAssets) this.visualAssets.dispose();
    this.featureInstances.clear();
    this.chunkFeatureIds.clear();
    this.disposed = true;
  }
}
