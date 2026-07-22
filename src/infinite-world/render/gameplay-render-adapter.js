import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_CHUNK_SIZE,
  chunkRenderPosition,
  createChunkKey,
  logicalWorldToRenderLocal,
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
    this.combatRoot = new Group();
    this.combatRoot.name = 'w7-core-combat-root';
    this.scene.add(this.combatRoot);
    this.visualAssets = visualAssets ?? createProductionVisualAssetLibrary({ THREE });
    this.ownsVisualAssets = visualAssets === null;
    this.loaded = new Map();
    this.entityMeshes = new Map();
    this.projectileMeshes = new Map();
    this.effectMeshes = new Map();
    this.manualBossEntry = null;
    this.disposed = false;
    this.counts = {
      loaded: 0, unloaded: 0, created: 0, removed: 0, rebased: 0,
      transientCreated: 0, transientRemoved: 0,
    };
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
    for (const entry of this.projectileMeshes.values()) this.#positionTransient(entry);
    for (const entry of this.effectMeshes.values()) this.#positionTransient(entry);
    if (this.manualBossEntry) this.#positionManualBoss();
    this.counts.rebased += 1;
  }

  #positionTransient(entry) {
    const local = logicalWorldToRenderLocal(
      entry.state.x,
      entry.state.z,
      this.origin.renderOriginChunkX,
      this.origin.renderOriginChunkZ,
      this.renderChunkSize,
    );
    entry.mesh.position.set(local.x, entry.height, local.z);
  }

  #syncTransientSet(map, states, createMesh) {
    const desired = new Set(states.map(state => state.id));
    for (const [id, entry] of map) {
      if (desired.has(id)) continue;
      this.combatRoot.remove(entry.mesh);
      map.delete(id);
      this.counts.transientRemoved += 1;
    }
    for (const state of states) {
      let entry = map.get(state.id);
      if (!entry) {
        entry = createMesh(state);
        map.set(state.id, entry);
        this.combatRoot.add(entry.mesh);
        this.counts.transientCreated += 1;
      }
      entry.state = state;
      this.#positionTransient(entry);
    }
  }

  syncTransientCombat(projectiles, effects) {
    if (this.disposed) return false;
    const Mesh = requireConstructor(this.THREE, 'Mesh');
    this.#syncTransientSet(this.projectileMeshes, projectiles, state => {
      const mesh = new Mesh(this.visualAssets.geometries.sphere, this.visualAssets.materials.gold);
      mesh.name = 'tank-projectile';
      mesh.scale.setScalar(0.5 * this.unitsPerMeter);
      return { mesh, state, height: 0.55 * this.unitsPerMeter };
    });
    this.#syncTransientSet(this.effectMeshes, effects, state => {
      const destructive = state.type.includes('destruction');
      const nuclear = state.type.startsWith('nuclear');
      const mesh = new Mesh(
        this.visualAssets.geometries.dodeca,
        this.visualAssets.materials[destructive ? 'gold' : 'charred'],
      );
      mesh.name = `combat-${state.type}`;
      mesh.scale.setScalar((nuclear ? 9 : destructive ? 1.35 : 0.45) * this.unitsPerMeter);
      return { mesh, state, height: (nuclear ? 5 : destructive ? 0.8 : 0.3) * this.unitsPerMeter };
    });
    return true;
  }

  #positionManualBoss() {
    if (!this.manualBossEntry) return;
    const { state, mesh } = this.manualBossEntry;
    const local = logicalWorldToRenderLocal(
      state.x,
      state.z,
      this.origin.renderOriginChunkX,
      this.origin.renderOriginChunkZ,
      this.renderChunkSize,
    );
    mesh.position.set(local.x, 0, local.z);
    mesh.rotation.y = state.rotationY;
  }

  syncManualBoss(state) {
    if (this.disposed) return false;
    if (!state?.alive) {
      if (this.manualBossEntry) {
        this.combatRoot.remove(this.manualBossEntry.mesh);
        this.manualBossEntry = null;
        this.counts.transientRemoved += 1;
      }
      return true;
    }
    if (this.manualBossEntry?.state.stableId !== state.stableId) {
      if (this.manualBossEntry) {
        this.combatRoot.remove(this.manualBossEntry.mesh);
        this.counts.transientRemoved += 1;
      }
      const mesh = this.visualAssets.createEntityModel('boss');
      mesh.name = 'manual-production-boss';
      mesh.userData = { stableId: state.stableId, type: 'boss', manual: true };
      this.#scaleMesh(mesh, state);
      this.manualBossEntry = { mesh, state };
      this.combatRoot.add(mesh);
      this.counts.transientCreated += 1;
    } else {
      this.manualBossEntry.state = state;
    }
    this.#positionManualBoss();
    return true;
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
      liveProjectileMeshes: this.projectileMeshes.size,
      liveCombatEffectMeshes: this.effectMeshes.size,
      liveManualBossMeshes: this.manualBossEntry ? 1 : 0,
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
    this.syncTransientCombat([], []);
    this.syncManualBoss(null);
    this.scene.remove(this.root);
    this.scene.remove(this.combatRoot);
    if (this.ownsVisualAssets) this.visualAssets.dispose();
    this.disposed = true;
  }
}
