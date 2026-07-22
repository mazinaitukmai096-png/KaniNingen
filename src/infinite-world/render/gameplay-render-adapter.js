import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_CHUNK_SIZE,
  chunkRenderPosition,
  createChunkKey,
  parseChunkKey,
} from '../chunk-coordinates.js';
import {
  PRODUCTION_VISUAL_UNITS_PER_METER,
  createProductionVisualAssetLibrary,
} from './production-visual-assets.js';

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new TypeError(`THREE.${name} is required`);
  return THREE[name];
}

export class GameplayRenderAdapter {
  constructor({ THREE, scene, renderChunkSize = RENDER_CHUNK_SIZE, visualAssets = null } = {}) {
    if (!scene || typeof scene.add !== 'function' || typeof scene.remove !== 'function') {
      throw new TypeError('a Three.js scene is required');
    }
    const Group = requireConstructor(THREE, 'Group');
    this.THREE = THREE;
    this.scene = scene;
    this.renderChunkSize = renderChunkSize;
    this.unitsPerMeter = renderChunkSize / LOGICAL_CHUNK_SIZE_METERS;
    this.origin = { renderOriginChunkX: 0, renderOriginChunkZ: 0 };
    this.root = new Group();
    this.root.name = 'w6-gameplay-root';
    this.scene.add(this.root);
    this.visualAssets = visualAssets ?? createProductionVisualAssetLibrary({ THREE });
    this.ownsVisualAssets = visualAssets === null;
    this.loaded = new Map();
    this.entityMeshes = new Map();
    this.disposed = false;
    this.counts = { loaded: 0, unloaded: 0, created: 0, removed: 0, rebased: 0 };
  }

  #scaleMesh(mesh, state) {
    const finiteUnitScale = this.unitsPerMeter / PRODUCTION_VISUAL_UNITS_PER_METER;
    const visualScale = Number(mesh.userData.productionVisualScale ?? 1);
    mesh.scale.set(
      finiteUnitScale * visualScale,
      finiteUnitScale * visualScale,
      finiteUnitScale * visualScale,
    );
  }

  #positionGroup(entry) {
    const position = chunkRenderPosition(
      entry.chunkX,
      entry.chunkZ,
      this.origin.renderOriginChunkX,
      this.origin.renderOriginChunkZ,
      this.renderChunkSize,
    );
    entry.group.position.set(position.x, 0, position.z);
  }

  #positionMesh(mesh, state, entry) {
    const localX = state.x - entry.chunkX * LOGICAL_CHUNK_SIZE_METERS;
    const localZ = state.z - entry.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
    mesh.position.set(
      localX * this.unitsPerMeter,
      0,
      localZ * this.unitsPerMeter,
    );
    mesh.rotation.y = state.rotationY;
    mesh.visible = state.alive;
  }

  async rebase(origin) {
    if (this.disposed) throw new Error('gameplay render adapter is shut down');
    this.origin = {
      renderOriginChunkX: origin.renderOriginChunkX,
      renderOriginChunkZ: origin.renderOriginChunkZ,
    };
    for (const entry of this.loaded.values()) this.#positionGroup(entry);
    this.counts.rebased += 1;
  }

  async loadChunk(key, entityStates) {
    if (this.disposed) throw new Error('gameplay render adapter is shut down');
    if (this.loaded.has(key)) throw new Error(`gameplay chunk already loaded: ${key}`);
    const { chunkX, chunkZ } = parseChunkKey(key);
    const Group = requireConstructor(this.THREE, 'Group');
    const group = new Group();
    group.name = `w6-gameplay-chunk-${key}`;
    group.userData = { chunkKey: key };
    const entry = { key, chunkX, chunkZ, group, entityIds: new Set() };
    this.#positionGroup(entry);
    for (const state of entityStates) {
      if (this.entityMeshes.has(state.stableId)) throw new Error(`duplicate live gameplay Stable ID: ${state.stableId}`);
      const mesh = this.visualAssets.createEntityModel(state.type);
      mesh.name = `production-${state.type}`;
      mesh.userData = { stableId: state.stableId, ownerChunkKey: key, type: state.type };
      this.#scaleMesh(mesh, state);
      this.#positionMesh(mesh, state, entry);
      group.add(mesh);
      entry.entityIds.add(state.stableId);
      this.entityMeshes.set(state.stableId, { mesh, entry });
      this.counts.created += 1;
    }
    this.root.add(group);
    this.loaded.set(createChunkKey(chunkX, chunkZ), entry);
    this.counts.loaded += 1;
  }

  syncEntity(state) {
    const live = this.entityMeshes.get(state.stableId);
    if (!live) return false;
    this.#positionMesh(live.mesh, state, live.entry);
    return true;
  }

  async unloadChunk(key) {
    const entry = this.loaded.get(key);
    if (!entry) throw new Error(`gameplay chunk is not loaded: ${key}`);
    this.root.remove(entry.group);
    for (const stableId of entry.entityIds) {
      this.entityMeshes.delete(stableId);
      this.counts.removed += 1;
    }
    entry.group.clear();
    this.loaded.delete(key);
    this.counts.unloaded += 1;
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: 'w6-gameplay-render-adapter-1',
      liveChunkGroups: this.loaded.size,
      liveEntityMeshes: this.entityMeshes.size,
      sharedGeometryCount: this.visualAssets.snapshot().sharedGeometryCount,
      sharedMaterialCount: this.visualAssets.snapshot().sharedMaterialCount,
      sharedDisposed: this.disposed
        && (!this.ownsVisualAssets || this.visualAssets.snapshot().disposed),
      productionVisuals: this.visualAssets.snapshot(),
      counts: Object.freeze({ ...this.counts }),
    });
  }

  async shutdown() {
    if (this.disposed) return;
    for (const key of [...this.loaded.keys()]) await this.unloadChunk(key);
    this.scene.remove(this.root);
    if (this.ownsVisualAssets) this.visualAssets.dispose();
    this.disposed = true;
  }
}
