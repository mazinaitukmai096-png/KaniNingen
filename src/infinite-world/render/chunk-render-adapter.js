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
  constructor({ THREE, scene, renderChunkSize = RENDER_CHUNK_SIZE } = {}) {
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
    this.disposed = false;
    this.counts = { projected: 0, loaded: 0, unloaded: 0, rebased: 0 };

    const Group = requireConstructor(THREE, 'Group');
    const PlaneGeometry = requireConstructor(THREE, 'PlaneGeometry');
    const ConeGeometry = requireConstructor(THREE, 'ConeGeometry');
    const DodecahedronGeometry = requireConstructor(THREE, 'DodecahedronGeometry');
    const BufferGeometry = requireConstructor(THREE, 'BufferGeometry');
    const Float32BufferAttribute = requireConstructor(THREE, 'Float32BufferAttribute');
    const MeshLambertMaterial = requireConstructor(THREE, 'MeshLambertMaterial');
    const LineBasicMaterial = requireConstructor(THREE, 'LineBasicMaterial');
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
    });
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

  async projectChunk(chunkData) {
    if (this.disposed) throw new Error('render adapter is shut down');
    if (!chunkData) throw new TypeError('ChunkData is required for rendering');
    const { Group, Mesh, InstancedMesh, LineSegments, Object3D } = this.THREE;
    for (const name of ['Group', 'Mesh', 'InstancedMesh', 'LineSegments', 'Object3D']) {
      requireConstructor(this.THREE, name);
    }
    const key = createChunkKey(chunkData.chunkX, chunkData.chunkZ);
    const group = new Group();
    group.name = `w1a-chunk-${key}`;
    group.userData = { chunkKey: key, chunkId: chunkData.chunkId, contentHash: chunkData.contentHash };

    const terrain = new Mesh(this.geometries.terrain, this.materials.terrain);
    terrain.name = 'w1a-terrain';
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.set(this.renderChunkSize / 2, 0, this.renderChunkSize / 2);
    group.add(terrain);

    const treeMesh = new InstancedMesh(
      this.geometries.tree,
      this.materials.tree,
      Math.max(1, chunkData.vegetationProxies.length),
    );
    treeMesh.name = 'w1a-tree-proxies';
    treeMesh.count = chunkData.vegetationProxies.length;
    const transform = new Object3D();
    chunkData.vegetationProxies.forEach((proxy, index) => {
      transform.position.set(proxy.logicalLocalX * this.unitsPerMeter, 260 * proxy.scale, proxy.logicalLocalZ * this.unitsPerMeter);
      transform.rotation.set(0, proxy.yawRadians, 0);
      transform.scale.set(proxy.scale, proxy.scale, proxy.scale);
      transform.updateMatrix();
      treeMesh.setMatrixAt(index, transform.matrix);
    });
    treeMesh.instanceMatrix.needsUpdate = true;
    group.add(treeMesh);

    const rockMesh = new InstancedMesh(
      this.geometries.rock,
      this.materials.rock,
      Math.max(1, chunkData.rockProxies.length),
    );
    rockMesh.name = 'w1a-rock-proxies';
    rockMesh.count = chunkData.rockProxies.length;
    chunkData.rockProxies.forEach((proxy, index) => {
      transform.position.set(proxy.logicalLocalX * this.unitsPerMeter, 85 * proxy.scale, proxy.logicalLocalZ * this.unitsPerMeter);
      transform.rotation.set(0, proxy.yawRadians, 0);
      transform.scale.set(proxy.scale, proxy.scale * 0.65, proxy.scale);
      transform.updateMatrix();
      rockMesh.setMatrixAt(index, transform.matrix);
    });
    rockMesh.instanceMatrix.needsUpdate = true;
    group.add(rockMesh);

    const border = new LineSegments(this.geometries.border, this.materials.border);
    border.name = 'w1a-chunk-border';
    group.add(border);
    const projected = { key, chunkX: chunkData.chunkX, chunkZ: chunkData.chunkZ, group };
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
    projected.group.clear();
    this.loaded.delete(key);
    this.counts.unloaded += 1;
  }

  resourceSnapshot() {
    return Object.freeze({
      liveChunkGroups: this.loaded.size,
      sharedGeometryCount: Object.keys(this.geometries).length,
      sharedMaterialCount: Object.keys(this.materials).length,
      sharedDisposed: this.disposed,
      projectedCount: this.counts.projected,
      loadedCount: this.counts.loaded,
      unloadedCount: this.counts.unloaded,
      rebaseCount: this.counts.rebased,
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
    this.disposed = true;
  }
}
