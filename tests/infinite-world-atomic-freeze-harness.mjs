import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { squareChunkCoordinates } from '../src/infinite-world/chunk-coordinates.js';
import {
  InfiniteGameplayRuntime,
} from '../src/infinite-world/gameplay-runtime.js';
import {
  InfiniteWorldSaveStore,
  InfiniteWorldState,
} from '../src/infinite-world/world-state-store.js';
import { ChunkRenderAdapter } from '../src/infinite-world/render/chunk-render-adapter.js';
import { GameplayRenderAdapter } from '../src/infinite-world/render/gameplay-render-adapter.js';
import { createW8ParityVisualAssetLibrary } from '../src/infinite-world/render/w8-parity-visual-assets.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';

const counters = {
  meshes: 0,
  instancedMeshes: 0,
  matrixWrites: 0,
  groupAdds: 0,
};

class Triple {
  constructor() { this.set(0, 0, 0); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(value) { return this.set(value, value, value); }
}

class NodeObject {
  constructor() {
    this.children = [];
    this.position = new Triple();
    this.rotation = new Triple();
    this.scale = new Triple().set(1, 1, 1);
    this.userData = {};
    this.matrix = {};
  }
  add(child) { this.children.push(child); child.parent = this; counters.groupAdds += 1; }
  remove(child) { this.children = this.children.filter(value => value !== child); child.parent = null; }
  clear() { for (const child of this.children) child.parent = null; this.children = []; }
  updateMatrix() {
    this.matrix = {
      position: { ...this.position }, rotation: { ...this.rotation }, scale: { ...this.scale },
    };
  }
}

class Group extends NodeObject {}
class Geometry {
  constructor() { this.attributes = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  setIndex(value) { this.index = value; }
  computeVertexNormals() {}
  dispose() { this.disposed = true; }
}
class PlaneGeometry extends Geometry {}
class BoxGeometry extends Geometry {}
class ConeGeometry extends Geometry {}
class CylinderGeometry extends Geometry {}
class SphereGeometry extends Geometry {}
class DodecahedronGeometry extends Geometry {}
class TorusGeometry extends Geometry {}
class BufferGeometry extends Geometry {}
class Float32BufferAttribute { constructor(values, size) { this.values = values; this.size = size; } }
class Material {
  constructor(options = {}) { this.options = options; Object.assign(this, options); }
  clone() { return new this.constructor({ ...this.options }); }
  dispose() { this.disposed = true; }
}
class MeshLambertMaterial extends Material {}
class MeshPhongMaterial extends Material {}
class LineBasicMaterial extends Material {}
class Mesh extends NodeObject {
  constructor(geometry, material) {
    super(); this.geometry = geometry; this.material = material; counters.meshes += 1;
  }
}
class InstancedMesh extends Mesh {
  constructor(geometry, material, capacity) {
    super(geometry, material); this.capacity = capacity; this.count = 0;
    this.matrices = []; this.instanceMatrix = {}; counters.instancedMeshes += 1;
  }
  setMatrixAt(index, matrix) {
    this.matrices[index] = structuredClone(matrix); counters.matrixWrites += 1;
  }
}
class LineSegments extends Mesh {}
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const value = this.length() || 1; this.x /= value; this.y /= value; this.z /= value; return this; }
}
class Raycaster { intersectObjects() { return []; } }

const FakeThree = {
  Group, Object3D: NodeObject, Mesh, InstancedMesh, LineSegments, Vector3, Raycaster,
  PlaneGeometry, BoxGeometry, ConeGeometry, CylinderGeometry, SphereGeometry,
  DodecahedronGeometry, TorusGeometry, BufferGeometry, Float32BufferAttribute,
  MeshLambertMaterial, MeshPhongMaterial, LineBasicMaterial,
};

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const duration = async operation => {
  const startedAt = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - startedAt };
};

const unhandled = [];
const onUnhandled = reason => unhandled.push(reason instanceof Error ? reason.stack : String(reason));
process.on('unhandledRejection', onUnhandled);

try {
  const generatorTimed = await duration(() => createW8ParityChunkGenerator());
  const generator = generatorTimed.value;
  const spawn = generator.experienceSpawn;
  const centerChunkX = Math.floor(spawn.x / 16);
  const centerChunkZ = Math.floor(spawn.z / 16);
  const activeCoordinates = squareChunkCoordinates(centerChunkX, centerChunkZ, 2);
  const renderedCoordinates = squareChunkCoordinates(centerChunkX, centerChunkZ, 1);
  const chunks = new Map();
  const preparation = await duration(async () => {
    for (const coordinate of activeCoordinates) {
      chunks.set(coordinate.key, await generator.generateChunk(coordinate.chunkX, coordinate.chunkZ));
    }
  });

  const state = new InfiniteWorldState({ worldSeedHash: generator.worldSeedHash, playerSpawn: spawn });
  state.activeScaleStageId = 'MAX';
  const scene = new Group();
  const visualAssets = createW8ParityVisualAssetLibrary({ THREE: FakeThree });
  const featureRenderer = new ChunkRenderAdapter({
    THREE: FakeThree,
    scene,
    visualAssets,
    isFeatureDestroyed: stableId => state.isFeatureDestroyed(stableId),
  });
  const featureLoad = await duration(async () => {
    for (const coordinate of renderedCoordinates) {
      const projected = await featureRenderer.projectChunk(chunks.get(coordinate.key));
      await featureRenderer.loadProjected(projected);
    }
  });
  const gameplayRenderer = new GameplayRenderAdapter({ THREE: FakeThree, scene, visualAssets });
  const queryMetrics = {
    calls: 0, summedMs: 0, maximumMs: 0,
    firstStartedAt: Number.POSITIVE_INFINITY, lastEndedAt: Number.NEGATIVE_INFINITY,
  };
  const runtime = new InfiniteGameplayRuntime({
    worldSeedHash: generator.worldSeedHash,
    generatorMajor: generator.generatorVersion.major,
    state,
    renderAdapter: gameplayRenderer,
    featureRenderAdapter: featureRenderer,
    getChunkDataForQuery: async (chunkX, chunkZ) => {
      const startedAt = performance.now();
      queryMetrics.firstStartedAt = Math.min(queryMetrics.firstStartedAt, startedAt);
      try { return await generator.generateChunk(chunkX, chunkZ); }
      finally {
        const endedAt = performance.now();
        const elapsed = endedAt - startedAt;
        queryMetrics.calls += 1;
        queryMetrics.summedMs += elapsed;
        queryMetrics.maximumMs = Math.max(queryMetrics.maximumMs, elapsed);
        queryMetrics.lastEndedAt = Math.max(queryMetrics.lastEndedAt, endedAt);
      }
    },
    sampleTerrainHeight: () => 0,
    clock: () => performance.now(),
  });
  const gameplayLoad = await duration(() => runtime.syncActiveChunks({
    activeDataKeys: activeCoordinates.map(value => value.key),
    renderedKeys: renderedCoordinates.map(value => value.key),
    getChunkData: (chunkX, chunkZ) => chunks.get(`${chunkX},${chunkZ}`),
    renderOrigin: { renderOriginChunkX: centerChunkX, renderOriginChunkZ: centerChunkZ },
  }));

  const damageMetrics = { featureCalls: 0, featureMs: 0, entityCalls: 0, entityMs: 0 };
  const originalDamageFeature = state.damageFeature.bind(state);
  state.damageFeature = (...args) => {
    const startedAt = performance.now();
    try { return originalDamageFeature(...args); }
    finally { damageMetrics.featureCalls += 1; damageMetrics.featureMs += performance.now() - startedAt; }
  };
  const originalDamageEntity = state.damageEntity.bind(state);
  state.damageEntity = (...args) => {
    const startedAt = performance.now();
    try { return originalDamageEntity(...args); }
    finally { damageMetrics.entityCalls += 1; damageMetrics.entityMs += performance.now() - startedAt; }
  };

  const rendererMetrics = {
    directSetCalls: 0, directSetMs: 0, refreshSetCalls: 0, refreshSetMs: 0,
    refreshCalls: 0, refreshMs: 0, rubbleCreates: 0, rubbleCreatePathMs: 0,
  };
  let insideRefresh = false;
  const originalSetDestroyed = featureRenderer.setFeatureDestroyed.bind(featureRenderer);
  featureRenderer.setFeatureDestroyed = (...args) => {
    const startedAt = performance.now();
    const entry = featureRenderer.featureInstances.get(args[0]);
    const hadRubble = entry?.rubbleMesh != null;
    try { return originalSetDestroyed(...args); }
    finally {
      const elapsed = performance.now() - startedAt;
      if (insideRefresh) {
        rendererMetrics.refreshSetCalls += 1; rendererMetrics.refreshSetMs += elapsed;
      } else {
        rendererMetrics.directSetCalls += 1; rendererMetrics.directSetMs += elapsed;
      }
      if (!hadRubble && entry?.rubbleMesh != null) {
        rendererMetrics.rubbleCreates += 1;
        rendererMetrics.rubbleCreatePathMs += elapsed;
      }
    }
  };
  const originalRefresh = featureRenderer.refreshFeatureStates.bind(featureRenderer);
  featureRenderer.refreshFeatureStates = (...args) => {
    const startedAt = performance.now();
    insideRefresh = true;
    try { return originalRefresh(...args); }
    finally {
      insideRefresh = false;
      rendererMetrics.refreshCalls += 1; rendererMetrics.refreshMs += performance.now() - startedAt;
    }
  };

  const beforeAtomic = {
    meshes: counters.meshes,
    matrixWrites: counters.matrixWrites,
    rubble: [...featureRenderer.featureInstances.values()].filter(value => value.rubbleMesh).length,
  };
  const atomic = await duration(() => runtime.nuclearAttack({ x: spawn.x, z: spawn.z, airborne: true }));
  const afterAtomic = {
    meshes: counters.meshes,
    matrixWrites: counters.matrixWrites,
    rubble: [...featureRenderer.featureInstances.values()].filter(value => value.rubbleMesh).length,
  };

  const consumed = runtime.consumePresentationEffects();
  const eventTypes = {};
  for (const event of consumed.events) eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
  const presentationExpand = await duration(() => Promise.resolve(
    gameplayRenderer.consumePresentationEvents(consumed.events),
  ));
  const presentationFirstTick = await duration(() => Promise.resolve(
    gameplayRenderer.updatePresentation(1 / 60),
  ));

  const storage = new MemoryStorage();
  const saveStore = new InfiniteWorldSaveStore({ storage, worldSeedHash: generator.worldSeedHash });
  const save = await duration(() => saveStore.save(state));

  const runtimeTicks = await duration(async () => {
    for (let index = 0; index < 120; index += 1) {
      runtime.update({
        deltaSeconds: 1 / 60,
        player: { x: spawn.x, z: spawn.z },
        playerY: 0,
        renderOrigin: { renderOriginChunkX: centerChunkX, renderOriginChunkZ: centerChunkZ },
        simulationEnabled: true,
      });
      gameplayRenderer.updatePresentation(1 / 60);
    }
  });
  const afterTwoSeconds = gameplayRenderer.snapshot();
  const presentationDrain = await duration(async () => {
    for (let index = 0; index < 900; index += 1) gameplayRenderer.updatePresentation(1 / 60);
  });
  const longContinuation = await duration(async () => {
    for (let index = 0; index < 1_800; index += 1) {
      runtime.update({
        deltaSeconds: 1 / 60,
        player: { x: spawn.x, z: spawn.z },
        playerY: 0,
        renderOrigin: { renderOriginChunkX: centerChunkX, renderOriginChunkZ: centerChunkZ },
        simulationEnabled: true,
      });
      if (index % 60 === 59) await new Promise(resolve => setImmediate(resolve));
    }
  });
  await new Promise(resolve => setTimeout(resolve, 250));

  const report = {
    environment: 'Node + FakeThree control-flow harness (not GPU timing)',
    setupMs: {
      generator: generatorTimed.ms,
      prepare25FinalChunks: preparation.ms,
      featureRender9Chunks: featureLoad.ms,
      gameplayLoad: gameplayLoad.ms,
    },
    atomicMs: atomic.ms,
    atomic: {
      queriedChunks: atomic.value.queriedChunkKeys.length,
      hitTargets: atomic.value.hitStableIds.length,
      queryCalls: queryMetrics.calls,
      queryWallMs: queryMetrics.calls > 0
        ? queryMetrics.lastEndedAt - queryMetrics.firstStartedAt : 0,
      querySummedMs: queryMetrics.summedMs,
      queryMaximumMs: queryMetrics.maximumMs,
      damage: damageMetrics,
      renderer: rendererMetrics,
      meshesCreated: afterAtomic.meshes - beforeAtomic.meshes,
      rubbleCreated: afterAtomic.rubble - beforeAtomic.rubble,
      matrixWrites: afterAtomic.matrixWrites - beforeAtomic.matrixWrites,
    },
    presentation: {
      queuedEvents: consumed.events.length,
      eventTypes,
      expandMs: presentationExpand.ms,
      firstTickMs: presentationFirstTick.ms,
      afterTwoSeconds: {
        activeEffects: afterTwoSeconds.activePresentationEffectCount,
        scars: afterTwoSeconds.persistentTankScarCount,
      },
      drain15SecondsMs: presentationDrain.ms,
      afterDrain: {
        activeEffects: gameplayRenderer.snapshot().activePresentationEffectCount,
        scars: gameplayRenderer.snapshot().persistentTankScarCount,
      },
    },
    save: { ms: save.ms, bytes: save.value.length },
    continuation: {
      ticks: 120,
      totalMs: runtimeTicks.ms,
      additionalThirtySecondTicks: 1_800,
      additionalThirtySecondMs: longContinuation.ms,
      featureDamageCount: state.featureDamage.size,
      entityStateCount: state.entityStates.size,
      stableIdOwnerCount: runtime.stableIdOwners.size,
      activeTankCount: runtime.snapshot().activeTankCount,
      pendingTankSpawnCount: runtime.snapshot().pendingTankSpawnCount,
      nuclearCooldownMs: state.nuclearCooldownMs,
      presentationQueueCount: runtime.consumePresentationEffects().events.length,
      unhandledRejections: unhandled,
    },
  };
  assert.equal(queryMetrics.calls, 0, 'Atomic must not request final ChunkData generation');
  assert.equal(atomic.value.queriedChunkKeys.length, activeCoordinates.length,
    'Atomic must reuse every intersecting active Gameplay Data Chunk');
  assert.ok(atomic.value.hitStableIds.length > 0, 'active Gameplay targets must still receive Atomic damage');
  assert.ok(atomic.ms * 4 < preparation.ms,
    'Atomic must remain substantially cheaper than synchronous final ChunkData generation');
  assert.deepEqual(unhandled, [], 'post-Atomic runtime continuation must not reject asynchronously');
  console.log(JSON.stringify(report, null, 2));
  await runtime.shutdown();
  await featureRenderer.shutdown();
  visualAssets.dispose();
} finally {
  process.off('unhandledRejection', onUnhandled);
}
