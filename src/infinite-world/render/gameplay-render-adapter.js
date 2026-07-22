import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_CHUNK_SIZE,
  chunkRenderPosition,
  createChunkKey,
  parseChunkKey,
} from '../chunk-coordinates.js';
import { finiteWorldUnitsToMeters } from '../gameplay-contract.js';

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new TypeError(`THREE.${name} is required`);
  return THREE[name];
}

export class GameplayRenderAdapter {
  constructor({ THREE, scene, renderChunkSize = RENDER_CHUNK_SIZE } = {}) {
    if (!scene || typeof scene.add !== 'function' || typeof scene.remove !== 'function') {
      throw new TypeError('a Three.js scene is required');
    }
    const Group = requireConstructor(THREE, 'Group');
    const DodecahedronGeometry = requireConstructor(THREE, 'DodecahedronGeometry');
    const MeshLambertMaterial = requireConstructor(THREE, 'MeshLambertMaterial');
    this.THREE = THREE;
    this.scene = scene;
    this.renderChunkSize = renderChunkSize;
    this.unitsPerMeter = renderChunkSize / LOGICAL_CHUNK_SIZE_METERS;
    this.origin = { renderOriginChunkX: 0, renderOriginChunkZ: 0 };
    this.root = new Group();
    this.root.name = 'w6-gameplay-root';
    this.scene.add(this.root);
    this.geometries = Object.freeze({
      human: new DodecahedronGeometry(1, 0),
      tank: new DodecahedronGeometry(1, 0),
      boss: new DodecahedronGeometry(1, 1),
    });
    this.materials = Object.freeze({
      human: new MeshLambertMaterial({ color: 0x3366ff, flatShading: true }),
      tank: new MeshLambertMaterial({ color: 0x536b3b, flatShading: true }),
      boss: new MeshLambertMaterial({ color: 0x6b1628, flatShading: true }),
    });
    this.loaded = new Map();
    this.entityMeshes = new Map();
    this.disposed = false;
    this.counts = { loaded: 0, unloaded: 0, created: 0, removed: 0, rebased: 0 };
  }

  #scaleMesh(mesh, state) {
    const scale = this.unitsPerMeter;
    if (state.type === 'human') {
      mesh.scale.set(0.32 * scale, 0.875 * scale, 0.32 * scale);
    } else if (state.type === 'tank') {
      mesh.scale.set(1.82 * scale, 0.72 * scale, 2.7 * scale);
    } else {
      const radiusMeters = finiteWorldUnitsToMeters(320);
      mesh.scale.set(radiusMeters * scale, radiusMeters * 0.9 * scale, radiusMeters * scale);
    }
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
    const centerHeightMeters = state.type === 'human' ? 0.875
      : state.type === 'tank' ? 0.72 : finiteWorldUnitsToMeters(320);
    mesh.position.set(
      localX * this.unitsPerMeter,
      centerHeightMeters * this.unitsPerMeter,
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
    const Mesh = requireConstructor(this.THREE, 'Mesh');
    const group = new Group();
    group.name = `w6-gameplay-chunk-${key}`;
    group.userData = { chunkKey: key };
    const entry = { key, chunkX, chunkZ, group, entityIds: new Set() };
    this.#positionGroup(entry);
    for (const state of entityStates) {
      if (!this.geometries[state.type] || !this.materials[state.type]) {
        throw new Error(`unsupported gameplay entity type: ${state.type}`);
      }
      if (this.entityMeshes.has(state.stableId)) throw new Error(`duplicate live gameplay Stable ID: ${state.stableId}`);
      const mesh = new Mesh(this.geometries[state.type], this.materials[state.type]);
      mesh.name = `w6-${state.type}`;
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
      sharedGeometryCount: Object.keys(this.geometries).length,
      sharedMaterialCount: Object.keys(this.materials).length,
      sharedDisposed: this.disposed,
      counts: Object.freeze({ ...this.counts }),
    });
  }

  async shutdown() {
    if (this.disposed) return;
    for (const key of [...this.loaded.keys()]) await this.unloadChunk(key);
    this.scene.remove(this.root);
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    this.disposed = true;
  }
}
