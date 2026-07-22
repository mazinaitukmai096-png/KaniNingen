import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_CHUNK_SIZE,
  SUPPORTED_RENDER_CHUNK_SIZES,
  chunkRenderPosition,
  createChunkKey,
} from '../chunk-coordinates.js';

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
    const ConeGeometry = requireConstructor(THREE, 'ConeGeometry');
    const DodecahedronGeometry = requireConstructor(THREE, 'DodecahedronGeometry');
    const BufferGeometry = requireConstructor(THREE, 'BufferGeometry');
    const Float32BufferAttribute = requireConstructor(THREE, 'Float32BufferAttribute');
    const MeshLambertMaterial = requireConstructor(THREE, 'MeshLambertMaterial');
    const LineBasicMaterial = requireConstructor(THREE, 'LineBasicMaterial');
    const Object3D = requireConstructor(THREE, 'Object3D');
    this.worldRoot = new Group();
    this.worldRoot.name = 'w1a-render-root';
    this.scene.add(this.worldRoot);
    this.geometries = Object.freeze({
      terrain: new PlaneGeometry(renderChunkSize, renderChunkSize),
      tree: new ConeGeometry(105, 520, 5),
      rock: new DodecahedronGeometry(135, 0),
      border: new BufferGeometry(),
    });
    this.geometries.border.setAttribute('position', new Float32BufferAttribute([
      0, 8, 0, renderChunkSize, 8, 0,
      renderChunkSize, 8, 0, renderChunkSize, 8, renderChunkSize,
      renderChunkSize, 8, renderChunkSize, 0, 8, renderChunkSize,
      0, 8, renderChunkSize, 0, 8, 0,
    ], 3));
    this.materials = Object.freeze({
      terrain: new MeshLambertMaterial({ color: 0x668c54, flatShading: true }),
      tree: new MeshLambertMaterial({ color: 0x245c32, flatShading: true }),
      rock: new MeshLambertMaterial({ color: 0x787b80, flatShading: true }),
      border: new LineBasicMaterial({ color: 0xa9d17d, transparent: true, opacity: 0.75 }),
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
    const existing = this.featureInstances.get(stableId);
    if (existing && existing.chunkKey !== chunkKey) {
      throw new Error(`Stable ID collision in render adapter: ${stableId}`);
    }
    const entry = { stableId, chunkKey, mesh, index, originalMatrix: this.#cloneMatrix(matrix) };
    this.featureInstances.set(stableId, entry);
    if (!this.chunkFeatureIds.has(chunkKey)) this.chunkFeatureIds.set(chunkKey, new Set());
    this.chunkFeatureIds.get(chunkKey).add(stableId);
    mesh.setMatrixAt(index, this.isFeatureDestroyed(stableId)
      ? this.hiddenFeatureMatrix : entry.originalMatrix);
  }

  setFeatureDestroyed(stableId, destroyed = true) {
    const entry = this.featureInstances.get(stableId);
    if (!entry) return false;
    entry.mesh.setMatrixAt(entry.index, destroyed ? this.hiddenFeatureMatrix : entry.originalMatrix);
    entry.mesh.instanceMatrix.needsUpdate = true;
    return true;
  }

  refreshFeatureStates() {
    for (const [stableId, entry] of this.featureInstances) {
      entry.mesh.setMatrixAt(entry.index, this.isFeatureDestroyed(stableId)
        ? this.hiddenFeatureMatrix : entry.originalMatrix);
      entry.mesh.instanceMatrix.needsUpdate = true;
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
    const BufferGeometry = requireConstructor(this.THREE, 'BufferGeometry');
    const Float32BufferAttribute = requireConstructor(this.THREE, 'Float32BufferAttribute');
    const MeshLambertMaterial = requireConstructor(this.THREE, 'MeshLambertMaterial');
    const building = new BufferGeometry();
    building.setAttribute('position', new Float32BufferAttribute([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ], 3));
    building.setIndex([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
      1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
    ]);
    building.computeVertexNormals();
    this.settlementResources = Object.freeze({
      geometries: Object.freeze({ road: new PlaneGeometry(1, 1), building }),
      materials: Object.freeze({
        road: new MeshLambertMaterial({ color: 0x66615a, flatShading: true }),
        buildingRural: new MeshLambertMaterial({ color: 0x9a8569, flatShading: true }),
        buildingTown: new MeshLambertMaterial({ color: 0xb69f7e, flatShading: true }),
        buildingCity: new MeshLambertMaterial({ color: 0x667078, flatShading: true }),
      }),
    });
    return this.settlementResources;
  }

  async projectChunk(chunkData) {
    if (this.disposed) throw new Error('render adapter is shut down');
    if (!chunkData) throw new TypeError('ChunkData is required for rendering');
    const { Group, Mesh, InstancedMesh, LineSegments, Object3D } = this.THREE;
    for (const name of ['Group', 'Mesh', 'InstancedMesh', 'LineSegments', 'Object3D']) {
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

    const treeMesh = new InstancedMesh(
      this.geometries.tree,
      this.materials.tree,
      Math.max(1, vegetation.length),
    );
    treeMesh.name = chunkData.vegetationCandidates ? 'w3-formal-vegetation' : 'w1a-tree-proxies';
    treeMesh.count = vegetation.length;
    const transform = new Object3D();
    vegetation.forEach((candidate, index) => {
      const formal = candidate.candidateId !== undefined;
      const scale = formal
        ? (candidate.subtype === 'shrub' ? 0.38 : 0.72) * (0.82 + candidate.variationSeed * 0.36)
        : candidate.scale;
      const localX = formal
        ? candidate.worldPosition.x - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalX;
      const localZ = formal
        ? candidate.worldPosition.z - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalZ;
      const groundY = formal ? candidate.worldPosition.y * this.unitsPerMeter : 0;
      transform.position.set(localX * this.unitsPerMeter, groundY + 260 * scale, localZ * this.unitsPerMeter);
      transform.rotation.set(0, formal ? candidate.orientationSeed * Math.PI * 2 : candidate.yawRadians, 0);
      transform.scale.set(scale, scale, scale);
      transform.updateMatrix();
      this.#registerFeatureInstance({
        stableId: candidate.candidateId ?? candidate.stableId,
        chunkKey: key,
        mesh: treeMesh,
        index,
        matrix: transform.matrix,
      });
    });
    treeMesh.instanceMatrix.needsUpdate = true;
    group.add(treeMesh);

    const rockMesh = new InstancedMesh(
      this.geometries.rock,
      this.materials.rock,
      Math.max(1, rocks.length),
    );
    rockMesh.name = chunkData.rockCandidates ? 'w3-formal-rocks' : 'w1a-rock-proxies';
    rockMesh.count = rocks.length;
    rocks.forEach((candidate, index) => {
      const formal = candidate.candidateId !== undefined;
      const scale = formal
        ? candidate.metadata.candidateRadiusMeters * this.unitsPerMeter / 135 * (0.9 + candidate.variationSeed * 0.2)
        : candidate.scale;
      const localX = formal
        ? candidate.worldPosition.x - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalX;
      const localZ = formal
        ? candidate.worldPosition.z - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalZ;
      const groundY = formal ? candidate.worldPosition.y * this.unitsPerMeter : 0;
      transform.position.set(localX * this.unitsPerMeter, groundY + 85 * scale, localZ * this.unitsPerMeter);
      transform.rotation.set(0, formal ? candidate.orientationSeed * Math.PI * 2 : candidate.yawRadians, 0);
      transform.scale.set(scale, scale * 0.65, scale);
      transform.updateMatrix();
      this.#registerFeatureInstance({
        stableId: candidate.candidateId ?? candidate.stableId,
        chunkKey: key,
        mesh: rockMesh,
        index,
        matrix: transform.matrix,
      });
    });
    rockMesh.instanceMatrix.needsUpdate = true;
    group.add(rockMesh);

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

      const buildingMesh = new InstancedMesh(
        resources.geometries.building,
        resources.materials[{
          CITY: 'buildingCity',
          TOWN: 'buildingTown',
          RURAL: 'buildingRural',
        }[buildings[0]?.settlementType] ?? 'buildingRural'],
        Math.max(1, buildings.length),
      );
      buildingMesh.name = chunkData.generatorVersion?.major >= 500
        ? 'infinite-settlement-buildings' : 'w4-rural-buildings';
      buildingMesh.count = buildings.length;
      buildings.forEach((building, index) => {
        const localX = building.worldPosition.x
          - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS;
        const localZ = building.worldPosition.z
          - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
        transform.position.set(
          localX * this.unitsPerMeter,
          (building.worldPosition.y + building.heightMeters / 2) * this.unitsPerMeter,
          localZ * this.unitsPerMeter,
        );
        transform.rotation.set(0, building.rotationY, 0);
        transform.scale.set(
          building.widthMeters * this.unitsPerMeter,
          building.heightMeters * this.unitsPerMeter,
          building.depthMeters * this.unitsPerMeter,
        );
        transform.updateMatrix();
        this.#registerFeatureInstance({
          stableId: building.stableId,
          chunkKey: key,
          mesh: buildingMesh,
          index,
          matrix: transform.matrix,
        });
      });
      buildingMesh.instanceMatrix.needsUpdate = true;
      group.add(buildingMesh);
    }

    const border = new LineSegments(this.geometries.border, this.materials.border);
    border.name = 'w1a-chunk-border';
    group.add(border);
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
    return Object.freeze({
      liveChunkGroups: this.loaded.size,
      sharedGeometryCount: Object.keys(this.geometries).length
        + (this.settlementResources ? Object.keys(this.settlementResources.geometries).length : 0),
      sharedMaterialCount: Object.keys(this.materials).length
        + (this.settlementResources ? Object.keys(this.settlementResources.materials).length : 0),
      sharedDisposed: this.disposed,
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
      for (const material of Object.values(this.settlementResources.materials)) material.dispose();
    }
    this.featureInstances.clear();
    this.chunkFeatureIds.clear();
    this.disposed = true;
  }
}
