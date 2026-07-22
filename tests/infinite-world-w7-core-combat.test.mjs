import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TANK_BULLET_DAMAGE,
  TANK_BULLET_HIT_RADIUS,
  TANK_BULLET_LIFE,
  TANK_BULLET_SPEED,
  TANK_FIRE_INTERVAL_BASE,
  TANK_FIRE_INTERVAL_MIN,
  TANK_FIRE_INTERVAL_SCORE_DIVISOR,
} from '../src/constants.js';
import {
  W7_CORE_COMBAT_CONTRACT,
} from '../src/infinite-world/gameplay-contract.js';
import {
  InfiniteGameplayRuntime,
} from '../src/infinite-world/gameplay-runtime.js';
import {
  InfiniteWorldState,
} from '../src/infinite-world/world-state-store.js';

const repoRoot = resolve(import.meta.dirname, '..');
const worldSeedHash = `sha256:${'7'.repeat(64)}`;

class FakeGameplayRenderer {
  constructor() {
    this.loaded = new Map();
    this.entities = new Map();
    this.projectiles = [];
    this.effects = [];
  }
  async rebase(origin) { this.origin = { ...origin }; }
  async loadChunk(key, states) {
    this.loaded.set(key, new Set(states.map(state => state.stableId)));
    for (const state of states) this.entities.set(state.stableId, { ...state });
  }
  syncEntity(state) { this.entities.set(state.stableId, { ...state }); return true; }
  syncTransientCombat(projectiles, effects) {
    this.projectiles = projectiles.map(value => ({ ...value }));
    this.effects = effects.map(value => ({ ...value }));
  }
  async unloadChunk(key) {
    for (const stableId of this.loaded.get(key) ?? []) this.entities.delete(stableId);
    this.loaded.delete(key);
  }
  snapshot() {
    return {
      liveChunkGroups: this.loaded.size,
      liveEntityMeshes: this.entities.size,
      liveProjectileMeshes: this.projectiles.length,
      liveCombatEffectMeshes: this.effects.length,
    };
  }
  async shutdown() {
    this.loaded.clear(); this.entities.clear(); this.projectiles = []; this.effects = [];
  }
}

function featureRenderer() {
  return {
    destroyed: new Set(),
    setFeatureDestroyed(stableId, destroyed) {
      if (destroyed) this.destroyed.add(stableId); else this.destroyed.delete(stableId);
    },
    refreshFeatureStates() {},
  };
}

function combatChunk() {
  return {
    chunkX: 0,
    chunkZ: 0,
    vegetationCandidates: [],
    rockCandidates: [],
    settlementFeatures: [{
      stableId: 'settlement-building-v1:w7c-house',
      featureType: 'settlement-building',
      buildingType: 'house',
      radiusMeters: 2,
      worldPosition: { x: 4, y: 0, z: 4 },
      owningChunkCoordinate: { x: 0, z: 0 },
    }],
    settlementReferences: [{
      settlementId: 'settlement-v1:w7c-military',
      townType: 'military',
      settlementType: 'RURAL',
      center: { x: 8, z: 8 },
    }],
  };
}

async function createRuntime({ playerSpawn = { x: 4, z: 4 }, clock = () => 0 } = {}) {
  const state = new InfiniteWorldState({ worldSeedHash, playerSpawn });
  const renderer = new FakeGameplayRenderer();
  const features = featureRenderer();
  const runtime = new InfiniteGameplayRuntime({
    worldSeedHash,
    generatorMajor: 1,
    state,
    renderAdapter: renderer,
    featureRenderAdapter: features,
    clock,
  });
  const chunk = combatChunk();
  await runtime.syncActiveChunks({
    renderedKeys: ['0,0'],
    getChunkData: () => chunk,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  return { state, renderer, features, runtime, chunk };
}

test('W7C Tank combat uses only the protected finite constants', () => {
  assert.deepEqual(W7_CORE_COMBAT_CONTRACT.tank, {
    fireIntervalMinimumMs: TANK_FIRE_INTERVAL_MIN,
    fireIntervalBaseMs: TANK_FIRE_INTERVAL_BASE,
    fireIntervalScoreDivisor: TANK_FIRE_INTERVAL_SCORE_DIVISOR,
    bulletSpeed: TANK_BULLET_SPEED,
    bulletLifeFrames: TANK_BULLET_LIFE,
    bulletHitRadius: TANK_BULLET_HIT_RADIUS,
    bulletDamage: TANK_BULLET_DAMAGE,
    bulletCameraShake: 35,
  });
  assert.deepEqual(W7_CORE_COMBAT_CONTRACT.building, {
    damagedHitStopMs: 32,
    destroyedHitStopMs: 65,
    destroyedShakeMinimum: 50,
    destroyedShakeRadiusFactor: 0.21,
    destroyedShakeMaximum: 88,
  });
});

test('Tank AI damages the existing player state only inside an active Simulation Chunk', async () => {
  const { runtime, state, renderer } = await createRuntime({ playerSpawn: { x: 8, z: 4 } });
  for (let index = 0; index < 60; index += 1) {
    runtime.update({ deltaSeconds: 0.05, player: state.player });
  }
  assert.equal(state.player.hp, state.player.maxHp - TANK_BULLET_DAMAGE);
  assert.equal(runtime.snapshot().counts.tankShots, 1);
  assert.equal(runtime.snapshot().counts.playerHits, 1);
  assert.equal(runtime.consumePresentationEffects().cameraShake, 35);
  assert.equal(runtime.consumePresentationEffects().cameraShake, 0);

  await runtime.syncActiveChunks({
    renderedKeys: [], getChunkData: () => null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  assert.equal(runtime.snapshot().activeSimulationChunkCount, 0);
  assert.equal(runtime.snapshot().activeProjectileCount, 0);
  assert.equal(renderer.projectiles.length, 0);
  const hp = state.player.hp;
  for (let index = 0; index < 80; index += 1) {
    runtime.update({ deltaSeconds: 0.05, player: state.player });
  }
  assert.equal(state.player.hp, hp);
  await runtime.shutdown();
});

test('building destruction, score, healing, hit stop and effects share the W6 World State', async () => {
  const { runtime, state, features } = await createRuntime();
  state.damagePlayer(50);
  const result = runtime.attack('single', 0);
  const houseHit = result.hits.find(value => value.type === 'house');
  assert.deepEqual(houseHit, {
    stableId: 'settlement-building-v1:w7c-house', type: 'house', destroyed: true,
  });
  assert.equal(state.player.score, 1800);
  assert.equal(state.player.hp, 54);
  assert.equal(state.isFeatureDestroyed(houseHit.stableId), true);
  assert.equal(features.destroyed.has(houseHit.stableId), true);
  assert.equal(runtime.isHitStopped(64), true);
  assert.equal(runtime.isHitStopped(65), false);
  assert.ok(runtime.consumePresentationEffects().cameraShake > 0);
  assert.ok(runtime.snapshot().activeCombatEffectCount > 0);
  await runtime.shutdown();
});

test('death and restart mutate the single World State atomically and restore active descriptors', async () => {
  const { runtime, state, renderer } = await createRuntime();
  const entityIds = [...state.entityStates.keys()];
  state.damagePlayer(state.player.maxHp);
  assert.equal(state.player.hp, 0);
  assert.equal(runtime.attack('single', 0).reason, 'player-dead');
  state.damageFeature({ stableId: 'wf1:tree:restart-test', maxHp: 80 }, 80);
  await runtime.restart({
    playerSpawn: { x: 2, z: 3 },
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  assert.deepEqual(state.player, {
    x: 2, z: 3, hp: 100, maxHp: 100, score: 0, facingY: 0,
  });
  assert.equal(state.featureDamage.size, 0);
  assert.deepEqual([...state.entityStates.keys()].sort(), entityIds.sort());
  assert.equal(renderer.entities.size, entityIds.length);
  assert.equal(runtime.snapshot().counts.restarts, 1);
  await runtime.shutdown();
  assert.equal(renderer.projectiles.length, 0);
  assert.equal(renderer.effects.length, 0);
});

test('knockback updates the existing player record without creating a parallel player store', async () => {
  const { runtime, state } = await createRuntime();
  runtime.applyPlayerKnockback({ directionX: 1, directionZ: 0, metersPerSecond: 10, decayPerFrame: 0.85 });
  const before = state.player.x;
  runtime.update({ deltaSeconds: 0.05, player: state.player });
  assert.ok(state.player.x > before);
  assert.equal(runtime.state.player, state.player);
  await runtime.shutdown();
});

test('W7C keeps one World State and one entity registry', () => {
  const runtimeSource = readFileSync(resolve(repoRoot, 'src/infinite-world/gameplay-runtime.js'), 'utf8');
  const stateSource = readFileSync(resolve(repoRoot, 'src/infinite-world/world-state-store.js'), 'utf8');
  assert.equal((stateSource.match(/this\.entityStates\s*=\s*new Map/g) ?? []).length, 1);
  assert.equal((stateSource.match(/this\.player\s*=/g) ?? []).length, 1);
  assert.doesNotMatch(runtimeSource, /new\s+InfiniteWorldState|new\s+InfiniteWorldSaveStore/);
  assert.match(runtimeSource, /this\.state\.damagePlayer/);
  assert.match(runtimeSource, /this\.state\.damageFeature/);
  assert.match(runtimeSource, /this\.state\.damageEntity/);
});
