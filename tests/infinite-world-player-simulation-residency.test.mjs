import test from 'node:test';
import assert from 'node:assert/strict';

import { InfiniteGameplayRuntime } from '../src/infinite-world/gameplay-runtime.js';
import { InfiniteWorldState } from '../src/infinite-world/world-state-store.js';
import { createChunkKey, squareChunkCoordinates } from '../src/infinite-world/chunk-coordinates.js';

const WORLD_SEED_HASH = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';

class FakeGameplayRenderer {
  constructor() {
    this.loaded = new Map();
    this.liveEntities = new Map();
  }
  async rebase(origin) { this.origin = { ...origin }; }
  async loadChunk(key, states) {
    if (this.loaded.has(key)) throw new Error(`duplicate presentation Chunk ${key}`);
    this.loaded.set(key, new Set(states.map(state => state.stableId)));
    for (const state of states) this.liveEntities.set(state.stableId, { ...state });
  }
  syncEntity(state) {
    if (!this.liveEntities.has(state.stableId)) return false;
    this.liveEntities.set(state.stableId, { ...state });
    return true;
  }
  async unloadChunk(key) {
    for (const stableId of this.loaded.get(key) ?? []) this.liveEntities.delete(stableId);
    this.loaded.delete(key);
  }
  snapshot() {
    return Object.freeze({
      liveChunkGroups: this.loaded.size,
      liveEntityMeshes: this.liveEntities.size,
    });
  }
  async shutdown() {
    this.loaded.clear();
    this.liveEntities.clear();
  }
}

function fakeFeatureRenderer() {
  return {
    destroyed: new Set(),
    setFeatureDestroyed(stableId, destroyed) {
      if (destroyed) this.destroyed.add(stableId);
      else this.destroyed.delete(stableId);
      return true;
    },
    refreshFeatureStates() {},
  };
}

function syntheticChunk(chunkX, chunkZ) {
  const key = createChunkKey(chunkX, chunkZ);
  const house = {
    stableId: `settlement-building-v1:player-simulation:${key}`,
    featureType: 'settlement-building',
    buildingType: 'house',
    radiusMeters: 2,
    worldPosition: {
      x: chunkX * 16 + 8,
      y: 0,
      z: chunkZ * 16 + 8,
    },
    owningChunkCoordinate: { x: chunkX, z: chunkZ },
  };
  return Object.freeze({
    chunkX,
    chunkZ,
    vegetationCandidates: Object.freeze([]),
    rockCandidates: Object.freeze([]),
    settlementFeatures: Object.freeze([Object.freeze(house)]),
    settlementReferences: Object.freeze([]),
    settlementLandmarks: Object.freeze([]),
    waterSurfaces: Object.freeze([]),
    ambientDetails: Object.freeze([]),
    streetDetails: Object.freeze([]),
  });
}

function initialRuntimeInput() {
  return {
    renderedKeys: ['0,0'],
    activeDataKeys: ['0,0'],
    getChunkData: (chunkX, chunkZ) => syntheticChunk(chunkX, chunkZ),
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  };
}

test('Player Simulation ticket follows the latest Player owner without moving presentation residency', async () => {
  const queries = [];
  const cancellations = [];
  const state = new InfiniteWorldState({
    worldSeedHash: WORLD_SEED_HASH,
    playerSpawn: { x: 8, z: 8 },
  });
  const renderer = new FakeGameplayRenderer();
  const featureRenderer = fakeFeatureRenderer();
  const runtime = new InfiniteGameplayRuntime({
    worldSeedHash: WORLD_SEED_HASH,
    generatorMajor: 500,
    state,
    renderAdapter: renderer,
    featureRenderAdapter: featureRenderer,
    getChunkDataForQuery: async (chunkX, chunkZ, context) => {
      queries.push({ key: createChunkKey(chunkX, chunkZ), ...context });
      await new Promise(resolve => setTimeout(resolve, 0));
      return syntheticChunk(chunkX, chunkZ);
    },
    cancelChunkDataQueries: options => {
      cancellations.push({ ...options });
      return 0;
    },
  });

  await runtime.syncActiveChunks(initialRuntimeInput());
  assert.deepEqual([...renderer.loaded.keys()], ['0,0']);

  // Request an intermediate owner and immediately move several Chunks farther.  The old work may
  // finish or cancel, but the authoritative Simulation residency must converge on the latest owner.
  runtime.requestPlayerSimulationResidency({ x: 24, z: 8 }); // 1,0
  runtime.update({
    deltaSeconds: 0,
    player: { x: 4 * 16 + 8, z: 8 },
    simulationEnabled: true,
  });
  await runtime.flushPlayerSimulationResidency();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.playerSimulationOwnerKey, '4,0');
  assert.equal(snapshot.playerSimulationRequestedOwnerKey, '4,0');
  assert.equal(snapshot.playerSimulationPending, false);
  assert.deepEqual(
    snapshot.activeSimulationChunkKeys,
    squareChunkCoordinates(4, 0, 1).map(value => value.key).sort(),
  );
  assert.deepEqual(
    snapshot.activeDataChunkKeys,
    squareChunkCoordinates(4, 0, 2).map(value => value.key).sort(),
  );
  assert.deepEqual(snapshot.presentationSimulationChunkKeys, ['0,0'],
    'render/presentation residency remains on the old Near owner until its own transition commits');
  assert.deepEqual([...renderer.loaded.keys()], ['0,0'],
    'Player Simulation residency must not publish offscreen renderer Chunks');
  assert.equal(snapshot.simulationTickets.tickets.some(ticket => (
    ticket.ticketId === 'player:primary'
      && ticket.kind === 'player'
      && ticket.persistent === true
  )), true);
  assert.ok(cancellations.some(value => value.consumerId === 'gameplay-simulation-ticket:player:primary'),
    'superseding Player movement cancels stale ticket queries');
  assert.ok(queries.some(value => value.key === '4,0'));

  const farHouseId = 'settlement-building-v1:player-simulation:4,0';
  const resolved = runtime.resolveCombatTarget(farHouseId);
  assert.equal(resolved?.kind, 'feature');
  assert.equal(resolved?.target?.ownerChunkKey, '4,0');
  const destroyed = runtime.damageStableId(farHouseId, resolved.target.maxHp);
  assert.equal(destroyed.destroyed, true);
  assert.equal(state.isFeatureDestroyed(farHouseId), true,
    'Gameplay damage follows Player Simulation residency even before render transition catches up');
  assert.equal(featureRenderer.destroyed.has(farHouseId), true);

  await runtime.shutdown();
});
