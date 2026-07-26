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
  W6_ENTITY_CONTRACTS,
  W7_CORE_COMBAT_CONTRACT,
  W8_TANK_LIFECYCLE_CONTRACT,
} from '../src/infinite-world/gameplay-contract.js';
import {
  InfiniteGameplayRuntime,
} from '../src/infinite-world/gameplay-runtime.js';
import {
  InfiniteWorldState,
} from '../src/infinite-world/world-state-store.js';
import {
  createChunkKey,
  logicalWorldToOwnedChunk,
} from '../src/infinite-world/chunk-coordinates.js';

const repoRoot = resolve(import.meta.dirname, '..');
const worldSeedHash = `sha256:${'7'.repeat(64)}`;

class FakeGameplayRenderer {
  constructor() {
    this.loaded = new Map();
    this.entities = new Map();
    this.occurrences = new Map();
    this.occurrenceSyncs = [];
    this.occurrenceRemovals = [];
    this.occurrenceClearCount = 0;
    this.projectiles = [];
    this.effects = [];
  }
  async rebase(origin) { this.origin = { ...origin }; }
  async loadChunk(key, states) {
    this.loaded.set(key, new Set(states.map(state => state.stableId)));
    for (const state of states) this.entities.set(state.stableId, { ...state });
  }
  syncEntity(state) { this.entities.set(state.stableId, { ...state }); return true; }
  syncReinforcement(state) {
    this.occurrences.set(state.stableId, { ...state });
    this.occurrenceSyncs.push(state.stableId);
    return true;
  }
  removeReinforcement(stableId) {
    if (typeof stableId !== 'string') return false;
    const removed = this.occurrences.delete(stableId);
    this.occurrenceRemovals.push(stableId);
    return removed;
  }
  clearReinforcements() {
    this.occurrences.clear();
    this.occurrenceClearCount += 1;
  }
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
      liveReinforcementMeshes: this.occurrences.size,
      liveProjectileMeshes: this.projectiles.length,
      liveCombatEffectMeshes: this.effects.length,
    };
  }
  async shutdown() {
    this.loaded.clear(); this.entities.clear(); this.occurrences.clear();
    this.projectiles = []; this.effects = [];
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
    settlementLandmarks: [{
      stableId: 'wf1:settlement-landmark:w7c-military-base',
      parentSettlementId: 'settlement-v1:w7c-military',
      landmarkType: 'militaryBase',
      worldPosition: { x: 1, y: 0, z: 14 },
      rotationY: 0,
      widthMeters: 11,
      depthMeters: 11,
      owningChunkCoordinate: { x: 0, z: 0 },
    }],
  };
}

function tankOnlyChunk({
  base = { x: 14, y: 0, z: 14 },
  rocks = [],
} = {}) {
  return {
    chunkX: 0,
    chunkZ: 0,
    vegetationCandidates: [],
    rockCandidates: rocks,
    settlementFeatures: [],
    settlementReferences: [{
      settlementId: 'settlement-v1:w7c-quiet-military',
      townType: 'military',
      settlementType: 'RURAL',
      center: { x: base.x, z: base.z },
    }],
    settlementLandmarks: [{
      stableId: 'wf1:settlement-landmark:w7c-quiet-military-base',
      parentSettlementId: 'settlement-v1:w7c-quiet-military',
      landmarkType: 'militaryBase',
      worldPosition: { ...base },
      rotationY: 0,
      widthMeters: 11,
      depthMeters: 11,
      owningChunkCoordinate: { x: 0, z: 0 },
    }],
  };
}

function emptyChunk(chunkX, chunkZ, { terrainHeight = chunkX * 10 + chunkZ } = {}) {
  return {
    chunkX,
    chunkZ,
    vegetationCandidates: [],
    rockCandidates: [],
    settlementFeatures: [],
    settlementReferences: [],
    settlementLandmarks: [],
    testTerrainHeight: terrainHeight,
  };
}

function squareChunkKeys(radius) {
  const keys = [];
  for (let chunkZ = -radius; chunkZ <= radius; chunkZ += 1) {
    for (let chunkX = -radius; chunkX <= radius; chunkX += 1) {
      keys.push(createChunkKey(chunkX, chunkZ));
    }
  }
  return keys;
}

function multiSlotChunk(count) {
  const chunk = tankOnlyChunk();
  chunk.settlementReferences = [];
  chunk.settlementLandmarks = [];
  for (let index = 0; index < count; index += 1) {
    const settlementId = `settlement-v1:w7c-slot-${index}`;
    const x = 1 + index * 2.5;
    const z = 14;
    chunk.settlementReferences.push({
      settlementId,
      townType: 'military',
      settlementType: 'RURAL',
      center: { x, z },
    });
    chunk.settlementLandmarks.push({
      stableId: `wf1:settlement-landmark:w7c-slot-base-${index}`,
      parentSettlementId: settlementId,
      landmarkType: 'militaryBase',
      worldPosition: { x, y: 0, z },
      rotationY: 0,
      widthMeters: 11,
      depthMeters: 11,
      owningChunkCoordinate: { x: 0, z: 0 },
    });
  }
  return chunk;
}

function tankSpawnBurstChunk({ slotCount = 12, worldObjectCount = 10 } = {}) {
  const chunk = multiSlotChunk(slotCount);
  for (let index = 0; index < slotCount; index += 1) {
    const x = 1 + (index % 4) * 3.5;
    const z = 2 + Math.floor(index / 4) * 5.5;
    chunk.settlementReferences[index].center = { x, z };
    chunk.settlementLandmarks[index].worldPosition = { x, y: 0, z };
  }
  chunk.rockCandidates = Array.from({ length: worldObjectCount }, (_, index) => ({
    candidateId: `wf1:rock:w8-tank-burst-target-${index}`,
    worldPosition: { x: -12 + index * 1.5, y: 0, z: 4 },
    metadata: { candidateRadiusMeters: 0.8 },
    owningChunkCoordinate: { x: 0, z: 0 },
  }));
  return chunk;
}

function findBaseTank(state) {
  return [...state.entityStates.values()].find(entity =>
    entity.type === 'tank' && entity.reinforcementSequence === 0);
}

function armTank(runtime, state, tank, {
  x = 0,
  z = 0,
  heading = Math.atan2(state.player.x - x, state.player.z - z),
} = {}) {
  Object.assign(tank, {
    x,
    z,
    hp: tank.maxHp,
    alive: true,
    spawned: true,
    aiState: 'hold',
    rotationY: heading,
    turretRotationY: heading,
    gunPitch: 0,
    lastShotAtMs: state.gameplayTimeMs,
    lastX: x,
    lastZ: z,
    stuckCheckClock: 0.5,
    stuckRemainingSeconds: 0,
  });
  runtime.update({ deltaSeconds: 0, player: state.player });
  return tank;
}

function addFallbackTank(state, {
  sequence,
  x,
  z,
  stableId = `wf1:tank:w7c-fallback-${sequence}`,
} = {}) {
  while (state.tankReinforcementSequence < sequence) state.nextTankReinforcementSequence();
  return state.ensureEntity({
    stableId,
    ownerChunkKey: '0,0',
    type: 'tank',
    maxHp: W6_ENTITY_CONTRACTS.tank.maxHp,
    x,
    z,
    rotationY: 0,
    aiState: 'hold',
    reinforcementSequence: sequence,
    spawned: true,
    lastShotAtMs: 0,
  });
}

function rotateByThreeXyzMatrix({ x, y, z }, rotationX, rotationY, rotationZ) {
  const cx = Math.cos(rotationX);
  const sx = Math.sin(rotationX);
  const cy = Math.cos(rotationY);
  const sy = Math.sin(rotationY);
  const cz = Math.cos(rotationZ);
  const sz = Math.sin(rotationZ);
  return {
    x: cy * cz * x - cy * sz * y + sy * z,
    y: (cx * sz + sx * sy * cz) * x
      + (cx * cz - sx * sy * sz) * y
      - sx * cy * z,
    z: (sx * sz - cx * sy * cz) * x
      + (sx * cz + cx * sy * sz) * y
      + cx * cy * z,
  };
}

async function advanceUntil(runtime, state, predicate, maximumTicks = 600) {
  for (let tick = 0; tick < maximumTicks; tick += 1) {
    runtime.update({ deltaSeconds: 0.05, player: state.player });
    if (predicate()) return tick + 1;
    await Promise.resolve();
  }
  assert.fail(`condition was not reached after ${maximumTicks} gameplay ticks`);
}

function advanceUntilSequence(runtime, state, expectedSequence, maximumTicks = 600) {
  for (let tick = 0; tick < maximumTicks; tick += 1) {
    runtime.update({ deltaSeconds: 0.05, player: state.player });
    if (state.tankReinforcementSequence === expectedSequence) return tick + 1;
  }
  assert.fail(`Tank reinforcement sequence ${expectedSequence} was not reached after ${maximumTicks} ticks`);
}

async function waitForAsync(predicate, maximumTurns = 100) {
  for (let turn = 0; turn < maximumTurns; turn += 1) {
    if (predicate()) return turn;
    await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  }
  assert.fail(`async condition was not reached after ${maximumTurns} turns`);
}

async function drainAsyncWork(turns = 4) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  }
}

async function createRuntime({
  playerSpawn = { x: 4, z: 4 }, clock = () => 0, chunk = combatChunk(),
  configureState = null, sampleTerrainHeight = null, getChunkDataForQuery = null,
  renderedKeys = ['0,0'], activeDataKeys = renderedKeys, getChunkData = null,
} = {}) {
  const state = new InfiniteWorldState({ worldSeedHash, playerSpawn });
  configureState?.(state);
  const renderer = new FakeGameplayRenderer();
  const features = featureRenderer();
  const runtime = new InfiniteGameplayRuntime({
    worldSeedHash,
    generatorMajor: 1,
    state,
    renderAdapter: renderer,
    featureRenderAdapter: features,
    clock,
    sampleTerrainHeight,
    getChunkDataForQuery,
  });
  await runtime.syncActiveChunks({
    renderedKeys,
    activeDataKeys,
    getChunkData: getChunkData ?? (() => chunk),
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
    worldCollisionDamage: 150,
    worldCollisionPaddingMeters: 0.375,
    difficultySpeedScoreFactor: 0.000005,
    difficultySpeedMaximum: 1.5,
  });
  assert.deepEqual(W7_CORE_COMBAT_CONTRACT.building, {
    damagedHitStopMs: 32,
    destroyedHitStopMs: 65,
    destroyedShakeMinimum: 50,
    destroyedShakeRadiusFactor: 0.21,
    destroyedShakeMaximum: 88,
  });
});

test('Tank requires spawn, LOS, bounded rotation, and cooldown before firing', async () => {
  const chunk = combatChunk();
  chunk.settlementFeatures[0].worldPosition = { x: 8, y: 0, z: 6 };
  const { runtime, state } = await createRuntime({ playerSpawn: { x: 8, z: 4 }, chunk });
  const tank = [...state.entityStates.values()].find(entity => entity.type === 'tank');
  assert.equal(tank.spawned, false);
  tank.spawned = true;
  tank.aiState = 'acquire';
  tank.x = 8;
  tank.z = 8;
  tank.rotationY = Math.PI;
  tank.turretRotationY = Math.PI;
  tank.lastShotAtMs = state.gameplayTimeMs;
  runtime.update({ deltaSeconds: 0.05, player: state.player });
  assert.ok(Math.abs(Math.atan2(
    Math.sin(tank.rotationY - Math.PI),
    Math.cos(tank.rotationY - Math.PI),
  )) <= 0.04 * 3 + 1e-9);
  assert.equal(runtime.snapshot().counts.tankShots, 0);
  for (let index = 0; index < 80; index += 1) {
    runtime.update({ deltaSeconds: 0.05, player: state.player });
    tank.x = 8;
    tank.z = 8;
  }
  assert.equal(runtime.snapshot().counts.tankShots, 0, 'the building must block LOS');
  state.damageFeature({
    stableId: 'settlement-building-v1:w7c-house', maxHp: 300,
  }, 300);
  for (let index = 0; index < 80 && runtime.snapshot().counts.tankShots === 0; index += 1) {
    runtime.update({ deltaSeconds: 0.05, player: state.player });
  }
  assert.equal(runtime.snapshot().counts.tankShots, 1);
  await runtime.shutdown();
});

test('active Tank occurrence survives owner unload and hands rendering off without duplication', async () => {
  const chunk = tankOnlyChunk();
  const { runtime, state, renderer } = await createRuntime({
    playerSpawn: { x: 0, z: 20 }, chunk,
  });
  const tank = armTank(runtime, state, findBaseTank(state), { x: 0, z: 0, heading: 0 });
  state.gameplayTimeMs = 3_000;
  tank.lastShotAtMs = 0;
  runtime.update({ deltaSeconds: 0, player: state.player });
  assert.equal(runtime.snapshot().counts.tankShots, 1);
  assert.equal(runtime.snapshot().activeProjectileCount, 1);
  assert.equal(renderer.entities.has(tank.stableId), true);
  assert.equal(renderer.occurrences.has(tank.stableId), false);

  await runtime.syncActiveChunks({
    renderedKeys: [],
    activeDataKeys: ['0,0'],
    getChunkData: () => chunk,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  assert.equal(runtime.snapshot().activeSimulationChunkCount, 0);
  assert.equal(runtime.snapshot().activeDataChunkCount, 1);
  assert.equal(runtime.snapshot().activeTankCount, 1);
  assert.equal(runtime.snapshot().activeProjectileCount, 1, 'the fired shell belongs to the occurrence, not the owner Chunk');
  assert.equal(renderer.projectiles.length, 1);
  assert.equal(renderer.entities.has(tank.stableId), false);
  assert.equal(renderer.occurrences.has(tank.stableId), true);

  const beforeClock = tank.aiClock;
  await advanceUntil(runtime, state, () => runtime.snapshot().counts.tankShots >= 2, 80);
  assert.ok(tank.aiClock > beforeClock, 'AI remains live after the canonical owner is unloaded');

  await runtime.syncActiveChunks({
    renderedKeys: ['0,0'],
    activeDataKeys: ['0,0'],
    getChunkData: () => chunk,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  assert.equal(renderer.entities.has(tank.stableId), true);
  assert.equal(renderer.occurrences.has(tank.stableId), false);
  assert.equal(
    Number(renderer.entities.has(tank.stableId)) + Number(renderer.occurrences.has(tank.stableId)),
    1,
    'reload returns the occurrence to the canonical Chunk mesh without duplication',
  );

  const frozenTankState = {
    x: tank.x,
    z: tank.z,
    rotationY: tank.rotationY,
    turretRotationY: tank.turretRotationY,
    gunPitch: tank.gunPitch,
    aiState: tank.aiState,
    aiClock: tank.aiClock,
    fireSequence: tank.fireSequence,
    lastShotAtMs: tank.lastShotAtMs,
    stuckCheckClock: tank.stuckCheckClock,
    stuckRemainingSeconds: tank.stuckRemainingSeconds,
  };
  const frozenCooldownAgeMs = state.gameplayTimeMs - tank.lastShotAtMs;
  assert.ok(runtime.snapshot().activeProjectileCount > 0);

  state.setScaleStage('TINY');
  runtime.update({ deltaSeconds: 0.05, player: state.player });
  assert.equal(tank.alive, true);
  assert.equal(tank.spawned, true);
  assert.equal(runtime.snapshot().activeTankCount, 1);
  assert.equal(runtime.snapshot().activeProjectileCount, 0);
  assert.equal(renderer.projectiles.length, 0, 'Tiny suppression removes every Tank-owned shell');
  assert.deepEqual({
    x: tank.x,
    z: tank.z,
    rotationY: tank.rotationY,
    turretRotationY: tank.turretRotationY,
    gunPitch: tank.gunPitch,
    aiState: tank.aiState,
    aiClock: tank.aiClock,
    fireSequence: tank.fireSequence,
    lastShotAtMs: tank.lastShotAtMs,
    stuckCheckClock: tank.stuckCheckClock,
    stuckRemainingSeconds: tank.stuckRemainingSeconds,
  }, frozenTankState, 'Tiny suppression freezes Tank pose and AI state');
  assert.equal(state.gameplayTimeMs - tank.lastShotAtMs, frozenCooldownAgeMs + 50,
    'Tank timing state is frozen while the shared finite-style wall clock continues');
  assert.equal(renderer.entities.get(tank.stableId).sandboxSuppressed, true,
    'the canonical Tank remains registered but is hidden by presentation state');

  state.setScaleStage('MAX');
  runtime.update({ deltaSeconds: 0, player: state.player });
  assert.equal(renderer.entities.get(tank.stableId).sandboxSuppressed, false);
  const resumedAiClock = tank.aiClock;
  runtime.update({ deltaSeconds: 0.05, player: state.player });
  assert.ok(tank.aiClock > resumedAiClock, 'MAX resumes the same Tank occurrence');

  tank.x = state.player.x + 200;
  tank.z = state.player.z;
  runtime.update({ deltaSeconds: 0.05, player: state.player });
  assert.equal(tank.spawned, false, 'distance despawn resumes after returning to MAX');
  assert.equal(runtime.snapshot().activeTankCount, 0);
  assert.equal(renderer.occurrences.has(tank.stableId), false);
  await runtime.shutdown();
});

test('Tank one-frame trace keeps finite collision range, pre-AI push, and local turret rotation', async t => {
  const pebble = {
    candidateId: 'wf1:pebble:w7c-tank-collision-trace',
    worldPosition: { x: 0, y: 0, z: 1 },
    metadata: { candidateRadiusMeters: 0.6 },
    owningChunkCoordinate: { x: 0, z: 0 },
  };
  const resetForTrace = (tank, state) => Object.assign(tank, {
    x: 0,
    z: 0,
    rotationY: 0,
    turretRotationY: 0,
    gunPitch: 0,
    lastShotAtMs: state.gameplayTimeMs,
    lastX: 0,
    lastZ: 0,
    stuckCheckClock: 0.5,
    stuckRemainingSeconds: 0,
  });

  await t.test('exactly 75m activates collision before heading, movement, and aim', async () => {
    const { runtime, state } = await createRuntime({
      playerSpawn: { x: 75, z: 0 },
      chunk: tankOnlyChunk({ rocks: [pebble] }),
    });
    const tank = armTank(runtime, state, findBaseTank(state));
    resetForTrace(tank, state);

    runtime.update({ deltaSeconds: 1 / 60, player: state.player });

    const tankRadiusMeters = W6_ENTITY_CONTRACTS.tank.radius / 40;
    const preAiPushZ = -(tankRadiusMeters + pebble.metadata.candidateRadiusMeters - 1);
    const movementMeters = 12 / 40;
    const expectedX = Math.sin(0.04) * movementMeters;
    const expectedZ = preAiPushZ + Math.cos(0.04) * movementMeters;
    assert.ok(Math.abs(tank.x - expectedX) < 1e-12);
    assert.ok(Math.abs(tank.z - expectedZ) < 1e-12,
      'the obstacle push happens before the finite heading and movement step');
    assert.ok(Math.abs(tank.rotationY - 0.04) < 1e-12);
    assert.ok(Math.abs(tank.turretRotationY - 0.10) < 1e-12,
      'the local 0.06 turret step composes with the 0.04 body step');

    const postMoveDistance = Math.hypot(state.player.x - expectedX, state.player.z - expectedZ);
    const expectedGunPitch = -Math.atan2(
      W8_TANK_LIFECYCLE_CONTRACT.playerAimHeightMeters
        - W8_TANK_LIFECYCLE_CONTRACT.turretPivotHeightMeters,
      postMoveDistance,
    );
    assert.ok(Math.abs(tank.gunPitch - expectedGunPitch) < 1e-12,
      'gun aim is derived from the post-move target vector');
    await runtime.shutdown();
  });

  await t.test('100m remains in engage range but skips the 75m collision pass', async () => {
    const { runtime, state } = await createRuntime({
      playerSpawn: { x: 100, z: 0 },
      chunk: tankOnlyChunk({ rocks: [pebble] }),
    });
    const tank = armTank(runtime, state, findBaseTank(state));
    resetForTrace(tank, state);

    runtime.update({ deltaSeconds: 1 / 60, player: state.player });

    const movementMeters = 12 / 40;
    assert.ok(Math.abs(tank.x - Math.sin(0.04) * movementMeters) < 1e-12);
    assert.ok(Math.abs(tank.z - Math.cos(0.04) * movementMeters) < 1e-12,
      'an obstacle is not pushed against outside the finite 75m collision range');
    assert.ok(Math.abs(tank.rotationY - 0.04) < 1e-12);
    assert.ok(Math.abs(tank.turretRotationY - 0.10) < 1e-12);
    await runtime.shutdown();
  });
});

test('Tank finite gates and LOS use airborne player Y while retaining x/z broadphase', async t => {
  await t.test('vertical distance gates collision, approach, engage, and despawn', async () => {
    const pebble = {
      candidateId: 'wf1:pebble:w7c-airborne-distance-trace',
      worldPosition: { x: 0, y: 0, z: 1 },
      metadata: { candidateRadiusMeters: 0.6 },
      owningChunkCoordinate: { x: 0, z: 0 },
    };
    const { runtime, state } = await createRuntime({
      playerSpawn: { x: 0, z: 0 },
      chunk: tankOnlyChunk({ rocks: [pebble] }),
    });
    const tank = armTank(runtime, state, findBaseTank(state), { x: 0, z: 0, heading: 0 });
    const resetPose = () => Object.assign(tank, {
      x: 0,
      z: 0,
      rotationY: 0,
      turretRotationY: 0,
      gunPitch: 0,
      aiState: 'hold',
      lastX: 0,
      lastZ: 0,
      stuckCheckClock: 0.5,
      stuckRemainingSeconds: 0,
    });

    resetPose();
    runtime.update({ deltaSeconds: 1 / 60, player: state.player, playerY: 80 });
    assert.ok(Math.abs(tank.x) < 1e-12);
    assert.ok(Math.abs(tank.z - 12 / 40) < 1e-12,
      '80m vertical separation skips the 75m collision pass but exceeds the 30m approach gate');
    assert.equal(tank.aiState, 'engage');

    resetPose();
    runtime.update({ deltaSeconds: 1 / 60, player: state.player, playerY: 125 });
    assert.equal(tank.aiState, 'search', '125m vertical separation reaches the finite engage boundary');
    assert.equal(tank.x, 0);
    assert.equal(tank.z, 0);

    resetPose();
    const despawnDistanceMeters = W6_ENTITY_CONTRACTS.tank.despawnDistance / 40;
    runtime.update({
      deltaSeconds: 0,
      player: state.player,
      playerY: despawnDistanceMeters + 0.001,
    });
    assert.equal(tank.spawned, false, 'vertical separation participates in finite Tank despawn');
    assert.equal(runtime.snapshot().activeTankCount, 0);
    await runtime.shutdown();
  });

  await t.test('an x/z-overlapping obstacle blocks a ground ray but clears an airborne 3D ray', async () => {
    const rock = {
      candidateId: 'wf1:rock:w7c-airborne-los-trace',
      worldPosition: { x: 0, y: 0, z: 10 },
      metadata: { candidateRadiusMeters: 2 },
      owningChunkCoordinate: { x: 0, z: 0 },
    };
    const { runtime, state } = await createRuntime({
      playerSpawn: { x: 0, z: 20 },
      chunk: tankOnlyChunk({ rocks: [rock] }),
    });
    const tank = armTank(runtime, state, findBaseTank(state), { x: 0, z: 0, heading: 0 });
    state.gameplayTimeMs = 3_000;
    tank.lastShotAtMs = 0;

    runtime.update({ deltaSeconds: 0, player: state.player, playerY: 0 });
    assert.equal(tank.aiState, 'flank');
    assert.equal(runtime.snapshot().counts.tankShots, 0,
      'the obstacle selected by x/z broadphase blocks the ground-level segment');

    tank.aiState = 'hold';
    runtime.update({ deltaSeconds: 0, player: state.player, playerY: 10 });
    assert.equal(tank.aiState, 'hold');
    assert.equal(runtime.snapshot().counts.tankShots, 1,
      'the same broadphase obstacle vertically clears the airborne 3D segment');
    await runtime.shutdown();
  });
});

test('Tank stuck recovery suppresses fire for the whole final avoid tick', async () => {
  const { runtime, state } = await createRuntime({
    playerSpawn: { x: 0, z: 20 }, chunk: tankOnlyChunk(),
  });
  const tank = armTank(runtime, state, findBaseTank(state), { x: 0, z: 0, heading: 0 });
  Object.assign(tank, {
    avoidAngle: Math.PI / 2,
    stuckCheckClock: 0.5,
    stuckRemainingSeconds: 0.05,
    lastShotAtMs: 0,
  });
  state.gameplayTimeMs = 3_000;

  runtime.update({ deltaSeconds: 0.05, player: state.player });

  assert.equal(tank.stuckRemainingSeconds, 0);
  assert.equal(tank.aiState, 'avoid', 'the tick remains an avoid tick after its timer decrements to zero');
  assert.equal(runtime.snapshot().counts.tankShots, 0);
  assert.equal(runtime.snapshot().activeProjectileCount, 0);

  runtime.update({ deltaSeconds: 0, player: state.player });
  assert.equal(runtime.snapshot().counts.tankShots, 1,
    'firing resumes on the following tick once recovery was already zero at tick start');
  await runtime.shutdown();
});

test('Tank fire cooldown remains strict at equality and opens only beyond the boundary', async () => {
  const { runtime, state } = await createRuntime({
    playerSpawn: { x: 0, z: 20 }, chunk: tankOnlyChunk(),
  });
  const tank = armTank(runtime, state, findBaseTank(state), { x: 0, z: 0, heading: 0 });
  tank.lastShotAtMs = 0;
  state.gameplayTimeMs = TANK_FIRE_INTERVAL_BASE;

  runtime.update({ deltaSeconds: 0, player: state.player });
  assert.equal(runtime.snapshot().counts.tankShots, 0,
    'elapsed time equal to the cooldown does not fire');

  state.gameplayTimeMs = TANK_FIRE_INTERVAL_BASE + 0.001;
  runtime.update({ deltaSeconds: 0, player: state.player });
  assert.equal(runtime.snapshot().counts.tankShots, 1,
    'elapsed time strictly greater than the cooldown fires');
  await runtime.shutdown();
});

test('single and double attacks resolve active base and fallback Tanks through one combat target path', async t => {
  await t.test('single attack resolves the active canonical base slot', async () => {
    const { runtime, state } = await createRuntime({
      playerSpawn: { x: 0, z: 0 }, chunk: tankOnlyChunk(),
    });
    const tank = armTank(runtime, state, findBaseTank(state), { x: 4.5, z: 4.5 });
    const resolved = runtime.resolveCombatTarget(tank.stableId);
    assert.equal(resolved.kind, 'entity');
    assert.equal(resolved.type, 'tank');
    assert.equal(resolved.entity, tank);
    assert.equal(resolved.occurrence.slotStableId, tank.stableId);

    const result = runtime.attack('single', 0);
    assert.equal(result.accepted, true);
    assert.deepEqual(result.hits, [{
      stableId: tank.stableId,
      type: 'tank',
      destroyed: true,
    }]);
    assert.equal(state.entityStates.get(tank.stableId), tank, 'the canonical slot persists after its occurrence dies');
    assert.equal(tank.spawned, false);
    await runtime.shutdown();
  });

  await t.test('double attack resolves an active fallback occurrence', async () => {
    let fallback;
    const { runtime, state } = await createRuntime({
      playerSpawn: { x: 0, z: 0 },
      chunk: tankOnlyChunk(),
      configureState(candidate) {
        fallback = addFallbackTank(candidate, { sequence: 1, x: 4.5, z: 4.5 });
      },
    });
    const resolved = runtime.resolveCombatTarget(fallback.stableId);
    assert.equal(resolved.kind, 'entity');
    assert.equal(resolved.type, 'tank');
    assert.equal(resolved.entity, fallback);
    assert.equal(resolved.occurrence.kind, 'fallback');

    const result = runtime.attack('double', 0);
    assert.equal(result.accepted, true);
    assert.deepEqual(result.hits, [{
      stableId: fallback.stableId,
      type: 'tank',
      destroyed: true,
    }]);
    assert.equal(state.entityStates.has(fallback.stableId), false);
    await runtime.shutdown();
  });
});

test('Tank HP zero finalizes exactly once with no score, healing, blood, or stale occurrence resources', async () => {
  const { runtime, state, renderer } = await createRuntime({
    playerSpawn: { x: 0, z: 30 }, chunk: tankOnlyChunk(),
  });
  const tank = armTank(runtime, state, findBaseTank(state), { x: 0, z: 0, heading: 0 });
  state.damagePlayer(50);
  state.gameplayTimeMs = 3_000;
  tank.lastShotAtMs = 0;
  runtime.update({ deltaSeconds: 0, player: state.player });
  assert.equal(runtime.snapshot().activeProjectileCount, 1);
  assert.equal(renderer.projectiles.length, 1);

  const resolved = runtime.resolveCombatTarget(tank.stableId);
  const first = runtime.applyCombatDamage(resolved, tank.maxHp, {
    awardPlayerCredit: true,
    cameraShake: 35,
  });
  const second = runtime.applyCombatDamage(resolved, tank.maxHp, {
    awardPlayerCredit: true,
    cameraShake: 35,
  });
  assert.equal(first.justDestroyed, true);
  assert.equal(second.justDestroyed, false);
  assert.equal(tank.hp, 0);
  assert.equal(tank.alive, false);
  assert.equal(tank.spawned, false);
  assert.equal(state.player.score, 0, 'the finite Tank kill does not award TANK_SCORE_VALUE');
  assert.equal(state.player.hp, 50, 'the finite Tank kill has no healing reward');
  assert.equal(runtime.snapshot().counts.destroyedEntities, 1);
  assert.equal(runtime.snapshot().activeTankCount, 0);
  assert.equal(runtime.snapshot().activeProjectileCount, 0);
  assert.equal(renderer.projectiles.length, 0, 'projectile meshes are cleaned synchronously with their occurrence');
  assert.equal(renderer.occurrences.has(tank.stableId), false);
  assert.equal(renderer.entities.get(tank.stableId).spawned, false);

  const events = runtime.consumePresentationEffects().events;
  assert.equal(events.filter(event => event.type === 'tank-destruction').length, 1);
  assert.equal(events.some(event => event.type === 'entity-destruction'), false);
  await runtime.shutdown();
});

test('canonical base slot persists and rearms only while its Military Base survives', async () => {
  const chunk = tankOnlyChunk();
  const { runtime, state } = await createRuntime({
    playerSpawn: { x: 14, z: 8 }, chunk,
  });
  const tank = findBaseTank(state);
  assert.equal(tank.spawned, false);
  assert.equal(runtime.snapshot().tankSlotCount, 1);

  await advanceUntil(runtime, state, () => runtime.snapshot().activeTankCount === 1);
  assert.equal(tank.spawned, true);
  runtime.damageStableId(tank.stableId, tank.maxHp);
  assert.equal(state.entityStates.get(tank.stableId), tank);
  assert.equal(tank.spawned, false);
  assert.equal(runtime.snapshot().tankSlotCount, 1);

  await advanceUntil(runtime, state, () => runtime.snapshot().activeTankCount === 1);
  assert.equal(state.entityStates.get(tank.stableId), tank);
  assert.equal(tank.spawned, true);
  assert.equal(tank.alive, true);
  assert.equal(tank.hp, tank.maxHp);

  runtime.damageStableId(chunk.settlementLandmarks[0].stableId, 3_200);
  assert.equal(state.isFeatureDestroyed(chunk.settlementLandmarks[0].stableId), true);
  const beforeClock = tank.aiClock;
  runtime.update({ deltaSeconds: 0.05, player: state.player });
  assert.ok(tank.aiClock > beforeClock, 'destroying the Base does not kill its already-active Tank');
  assert.equal(runtime.snapshot().activeTankCount, 1);

  tank.x = state.player.x + 200;
  tank.z = state.player.z;
  runtime.update({ deltaSeconds: 0.05, player: state.player });
  assert.equal(tank.spawned, false);
  assert.equal(tank.alive, true);
  assert.equal(runtime.snapshot().activeTankCount, 0);
  for (let tick = 0; tick < 600; tick += 1) {
    runtime.update({ deltaSeconds: 0.05, player: state.player });
  }
  assert.equal(tank.spawned, false, 'a destroyed Military Base can never rearm its empty slot');
  assert.equal(runtime.snapshot().activeTankCount, 0);
  await runtime.shutdown();
});

test('fallback Tank kill and despawn prune all transient ownership while reinforcement sequence stays monotonic', async () => {
  let killedFallback;
  let despawnedFallback;
  const { runtime, state, renderer } = await createRuntime({
    playerSpawn: { x: 0, z: 0 },
    chunk: tankOnlyChunk(),
    configureState(candidate) {
      killedFallback = addFallbackTank(candidate, { sequence: 7, x: 20, z: 0 });
      despawnedFallback = addFallbackTank(candidate, { sequence: 8, x: 160, z: 0 });
    },
  });
  assert.equal(runtime.snapshot().fallbackTankCount, 2);
  assert.equal(runtime.snapshot().activeTankCount, 2);
  assert.equal(runtime.snapshot().tankOwnerRegistryCount, 3, 'one base slot plus two fallback occurrences');
  assert.equal(renderer.occurrences.has(killedFallback.stableId), true);
  assert.equal(renderer.occurrences.has(despawnedFallback.stableId), true);

  runtime.damageStableId(killedFallback.stableId, killedFallback.maxHp);
  assert.equal(state.entityStates.has(killedFallback.stableId), false);
  assert.equal(renderer.occurrences.has(killedFallback.stableId), false);
  assert.equal(runtime.snapshot().fallbackTankCount, 1);
  assert.equal(runtime.snapshot().activeTankCount, 1);

  despawnedFallback.x = 200;
  runtime.update({ deltaSeconds: 0.05, player: state.player });
  assert.equal(state.entityStates.has(despawnedFallback.stableId), false);
  assert.equal(renderer.occurrences.has(despawnedFallback.stableId), false);
  assert.equal(runtime.snapshot().fallbackTankCount, 0);
  assert.equal(runtime.snapshot().activeTankCount, 0);
  assert.equal(runtime.snapshot().tankOwnerRegistryCount, 1, 'only the persistent base slot remains registered');
  assert.equal(state.tankReinforcementSequence, 8);
  assert.equal(state.nextTankReinforcementSequence(), 9, 'fallback IDs never reuse a retired sequence');
  await runtime.shutdown();
});

test('repeated fallback cleanup does not grow owner or occurrence-generation registries', async () => {
  const { runtime, state } = await createRuntime({
    playerSpawn: { x: 0, z: 0 }, chunk: tankOnlyChunk(),
  });
  const baseline = runtime.snapshot();
  assert.equal(baseline.tankOwnerRegistryCount, 1);
  assert.equal(baseline.tankOccurrenceGenerationCount, 0);

  for (let sequence = 1; sequence <= 24; sequence += 1) {
    const fallback = addFallbackTank(state, { sequence, x: 20, z: 0 });
    runtime.clearTransientCombat();
    let snapshot = runtime.snapshot();
    assert.equal(snapshot.activeTankCount, 1);
    assert.equal(snapshot.fallbackTankCount, 1);
    assert.equal(snapshot.tankOwnerRegistryCount, baseline.tankOwnerRegistryCount + 1);
    assert.equal(snapshot.tankOccurrenceGenerationCount, 1);

    runtime.damageStableId(fallback.stableId, fallback.maxHp);
    snapshot = runtime.snapshot();
    assert.equal(snapshot.activeTankCount, 0);
    assert.equal(snapshot.fallbackTankCount, 0);
    assert.equal(snapshot.tankOwnerRegistryCount, baseline.tankOwnerRegistryCount);
    assert.equal(snapshot.tankOccurrenceGenerationCount, baseline.tankOccurrenceGenerationCount);
  }
  await runtime.shutdown();
});

test('reserve Tank slots do not inflate the bounded active occurrence count', async () => {
  const { runtime, state } = await createRuntime({
    playerSpawn: { x: 0, z: 20 }, chunk: multiSlotChunk(6),
  });
  assert.equal(runtime.snapshot().tankSlotCount, 6);
  assert.equal(runtime.snapshot().fallbackTankCount, 0);
  assert.equal(runtime.snapshot().activeTankCount, 0);
  const tanks = [...state.entityStates.values()].filter(entity => entity.type === 'tank');
  armTank(runtime, state, tanks[0], { x: 0, z: 0, heading: 0 });
  assert.equal(runtime.snapshot().tankSlotCount, 6);
  assert.equal(runtime.snapshot().activeTankCount, 1);
  assert.equal(tanks.filter(tank => tank.spawned).length, 1);
  await runtime.shutdown();
});

test('World Object destruction cannot burst duplicate Tank spawn reservations or commits', async () => {
  const chunk = tankSpawnBurstChunk();
  const terrainRequests = [];
  const sampleTerrainHeight = (x, z, queriedChunkData) =>
    (x === 8 && z === 8) || queriedChunkData ? 0 : null;
  const { runtime, state, renderer } = await createRuntime({
    playerSpawn: { x: 8, z: 8 },
    chunk,
    sampleTerrainHeight,
    getChunkDataForQuery(chunkX, chunkZ) {
      return new Promise(resolveTerrain => {
        terrainRequests.push({ chunkX, chunkZ, resolveTerrain });
      });
    },
    configureState(candidate) {
      candidate.player.score = 36_000;
    },
  });
  const worldObjectStableIds = chunk.rockCandidates.map(candidate => candidate.candidateId);
  let snapshot = runtime.snapshot();
  assert.equal(snapshot.activeTankCount, 0);
  assert.equal(snapshot.pendingTankSpawnCount, 0);
  assert.equal(snapshot.allowedTankCount, W8_TANK_LIFECYCLE_CONTRACT.tankLimitMaximum);

  for (const [index, stableId] of worldObjectStableIds.entries()) {
    const resolved = runtime.resolveCombatTarget(stableId);
    const result = runtime.applyCombatDamage(resolved, 600, { awardPlayerCredit: true });
    assert.equal(result.justDestroyed, true);
    snapshot = runtime.snapshot();
    assert.equal(snapshot.activeTankCount, 0,
      `World Object destroy event ${index + 1} does not directly spawn a Tank`);
    assert.equal(snapshot.pendingTankSpawnCount, 0,
      `World Object destroy event ${index + 1} does not directly reserve a Tank`);
  }

  assert.doesNotThrow(() => runtime.update({ deltaSeconds: 0.05, player: state.player }));
  snapshot = runtime.snapshot();
  assert.ok(snapshot.pendingTankSpawnCount <= 1,
    'one gameplay frame performs at most one spawn evaluation after same-frame destroy events');

  for (let tick = 0;
    tick < 1_200 && runtime.snapshot().reservedTankCapacityCount < W8_TANK_LIFECYCLE_CONTRACT.tankLimitMaximum;
    tick += 1) {
    assert.doesNotThrow(() => runtime.update({ deltaSeconds: 0.05, player: state.player }));
    snapshot = runtime.snapshot();
    assert.equal(
      new Set(snapshot.pendingTankSlotStableIds).size,
      snapshot.pendingTankSlotStableIds.length,
      'one slotStableId owns at most one pending spawn',
    );
    assert.ok(snapshot.reservedTankCapacityCount <= snapshot.allowedTankCount);
    assert.ok(snapshot.reservedTankCapacityCount <= W8_TANK_LIFECYCLE_CONTRACT.tankLimitMaximum);
  }
  snapshot = runtime.snapshot();
  assert.equal(snapshot.activeTankCount, 0);
  assert.equal(snapshot.pendingTankSpawnCount, W8_TANK_LIFECYCLE_CONTRACT.tankLimitMaximum);
  assert.equal(snapshot.reservedTankCapacityCount, W8_TANK_LIFECYCLE_CONTRACT.tankLimitMaximum);

  await waitForAsync(() => terrainRequests.length > 0);
  for (const request of terrainRequests) {
    request.resolveTerrain(emptyChunk(request.chunkX, request.chunkZ, { terrainHeight: 0 }));
  }
  await waitForAsync(() => runtime.snapshot().pendingTankSpawnCount === 0);
  await drainAsyncWork(4);

  snapshot = runtime.snapshot();
  assert.equal(snapshot.activeTankCount, W8_TANK_LIFECYCLE_CONTRACT.tankLimitMaximum);
  assert.equal(snapshot.reservedTankCapacityCount, W8_TANK_LIFECYCLE_CONTRACT.tankLimitMaximum);
  assert.ok(snapshot.activeTankCount <= snapshot.allowedTankCount);
  const activeTanks = [...state.entityStates.values()]
    .filter(entity => entity.type === 'tank' && entity.spawned === true);
  assert.equal(activeTanks.length, W8_TANK_LIFECYCLE_CONTRACT.tankLimitMaximum);
  for (const tank of activeTanks) {
    const resolved = runtime.resolveCombatTarget(tank.stableId);
    assert.equal(resolved.occurrence.runtimeGeneration, 1,
      'one reservation commits its slotStableId/runtimeGeneration exactly once');
    assert.equal(
      Number(renderer.entities.has(tank.stableId)) + Number(renderer.occurrences.has(tank.stableId)),
      1,
      'one Stable ID owns at most one renderer entry',
    );
  }
  assert.equal(renderer.occurrences.size, 0,
    'active canonical owner Chunk Tanks stay on their one canonical renderer entry');
  assert.ok(snapshot.activeProjectileCount <= W8_TANK_LIFECYCLE_CONTRACT.tankLimitMaximum);
  assert.ok(snapshot.activeCombatEffectCount <= 256);
  assert.ok(snapshot.tankOwnerRegistryCount <= chunk.settlementReferences.length);
  assert.doesNotThrow(() => runtime.update({ deltaSeconds: 0, player: state.player }),
    'update completes after consecutive World Object destruction and simultaneous terrain resolution');
  await runtime.shutdown();
});

test('fallback Tank replenishment keeps the finite one-evaluation cadence after score bursts', async () => {
  const chunk = emptyChunk(0, 0);
  chunk.rockCandidates = Array.from({ length: 10 }, (_, index) => ({
    candidateId: `wf1:rock:w8-fallback-cadence-${index}`,
    worldPosition: { x: 2 + index, y: 0, z: 4 },
    metadata: { candidateRadiusMeters: 0.8 },
    owningChunkCoordinate: { x: 0, z: 0 },
  }));
  const { runtime, state, renderer } = await createRuntime({
    playerSpawn: { x: 8, z: 8 },
    chunk,
    configureState(candidate) {
      candidate.player.score = 2_400;
    },
  });

  for (const rock of chunk.rockCandidates) {
    const result = runtime.applyCombatDamage(runtime.resolveCombatTarget(rock.candidateId), 600, {
      awardPlayerCredit: true,
    });
    assert.equal(result.justDestroyed, true);
  }
  assert.equal(state.player.score, 3_400);
  assert.equal(runtime.snapshot().reservedTankCapacityCount, 0,
    'ten same-frame World Object destructions do not directly reserve fallback Tanks');

  for (let update = 0; update < 47; update += 1) {
    runtime.update({ deltaSeconds: 1 / 240, player: state.player });
  }
  await drainAsyncWork();
  assert.equal(runtime.snapshot().reservedTankCapacityCount, 0,
    'sub-reference-frame updates cannot advance the finite spawn evaluation sequence early');

  runtime.update({ deltaSeconds: 1 / 240, player: state.player });
  await waitForAsync(() => runtime.snapshot().activeTankCount === 1);
  let snapshot = runtime.snapshot();
  assert.equal(snapshot.activeTankCount, 1);
  assert.equal(snapshot.pendingTankSpawnCount, 0);
  assert.equal(snapshot.fallbackTankCount, 1);
  assert.equal(state.tankReinforcementSequence, 1,
    'one eligible update can commit at most one fallback Tank');

  for (let update = 0; update < 40; update += 1) {
    runtime.update({ deltaSeconds: 0, player: state.player });
  }
  await drainAsyncWork();
  assert.equal(state.tankReinforcementSequence, 1,
    'Promise completion and zero-time updates cannot create the next reservation');

  for (let update = 0; update < 37; update += 1) {
    runtime.update({ deltaSeconds: 1 / 60, player: state.player });
  }
  await drainAsyncWork();
  assert.equal(state.tankReinforcementSequence, 1,
    'the next fallback candidate is not evaluated before its finite reference-frame chance');
  runtime.update({ deltaSeconds: 1 / 60, player: state.player });
  await waitForAsync(() => runtime.snapshot().activeTankCount === 2);
  snapshot = runtime.snapshot();
  assert.equal(state.tankReinforcementSequence, 2);
  assert.equal(snapshot.activeTankCount, 2);
  assert.equal(snapshot.pendingTankSpawnCount, 0);
  assert.ok(snapshot.reservedTankCapacityCount <= snapshot.allowedTankCount);
  assert.equal(renderer.occurrences.size, snapshot.activeTankCount,
    'each fallback Stable ID owns exactly one renderer entry');
  await runtime.shutdown();
});

test('an occupied living Military Base never opens the finite fallback branch', async () => {
  const { runtime, state, renderer } = await createRuntime({
    playerSpawn: { x: 14, z: 25 },
    chunk: tankOnlyChunk(),
    configureState(candidate) {
      candidate.player.score = 36_000;
    },
  });
  const baseTank = armTank(runtime, state, findBaseTank(state), { x: 14, z: 14, heading: 0 });
  for (let update = 0; update < 240; update += 1) {
    runtime.update({ deltaSeconds: 1 / 60, player: state.player });
    await Promise.resolve();
  }
  const snapshot = runtime.snapshot();
  assert.equal(baseTank.spawned, true);
  assert.equal(snapshot.activeTankCount, 1);
  assert.equal(snapshot.fallbackTankCount, 0,
    'finite fallback requires no living Military Base inside the spawn range');
  assert.equal(snapshot.pendingTankSpawnCount, 0);
  assert.equal(renderer.occurrences.size, 0);
  assert.ok(snapshot.reservedTankCapacityCount <= W8_TANK_LIFECYCLE_CONTRACT.tankLimitMaximum);
  await runtime.shutdown();
});

test('fallback cadence state resets across Restart, Continue refresh, and Scale changes', async t => {
  const createCadenceRuntime = () => createRuntime({
    playerSpawn: { x: 8, z: 8 },
    chunk: emptyChunk(0, 0),
    configureState(candidate) {
      candidate.player.score = 3_400;
    },
  });
  const advanceQuarterFrames = (runtime, state, count) => {
    for (let update = 0; update < count; update += 1) {
      runtime.update({ deltaSeconds: 1 / 240, player: state.player });
    }
  };

  await t.test('Scale change clears fractional spawn time', async () => {
    const { runtime, state } = await createCadenceRuntime();
    advanceQuarterFrames(runtime, state, 47);
    state.setScaleStage('TINY');
    runtime.update({ deltaSeconds: 0, player: state.player });
    state.setScaleStage('MAX');
    runtime.update({ deltaSeconds: 0, player: state.player });
    advanceQuarterFrames(runtime, state, 3);
    await drainAsyncWork();
    assert.equal(runtime.snapshot().reservedTankCapacityCount, 0);
    advanceQuarterFrames(runtime, state, 1);
    await waitForAsync(() => runtime.snapshot().activeTankCount === 1);
    assert.equal(runtime.snapshot().activeTankCount, 1);
    await runtime.shutdown();
  });

  await t.test('Continue refresh clears fractional spawn time', async () => {
    const { runtime, state } = await createCadenceRuntime();
    advanceQuarterFrames(runtime, state, 47);
    await runtime.refreshFromState();
    advanceQuarterFrames(runtime, state, 3);
    await drainAsyncWork();
    assert.equal(runtime.snapshot().reservedTankCapacityCount, 0);
    advanceQuarterFrames(runtime, state, 1);
    await waitForAsync(() => runtime.snapshot().activeTankCount === 1);
    assert.equal(runtime.snapshot().activeTankCount, 1);
    await runtime.shutdown();
  });

  await t.test('Restart clears the evaluation sequence and fractional spawn time', async () => {
    const { runtime, state } = await createCadenceRuntime();
    advanceQuarterFrames(runtime, state, 47);
    await runtime.restart({ playerSpawn: { x: 8, z: 8 } });
    state.player.score = 3_400;
    advanceQuarterFrames(runtime, state, 47);
    await drainAsyncWork();
    assert.equal(runtime.snapshot().reservedTankCapacityCount, 0);
    advanceQuarterFrames(runtime, state, 1);
    await waitForAsync(() => runtime.snapshot().activeTankCount === 1);
    assert.equal(runtime.snapshot().activeTankCount, 1);
    await runtime.shutdown();
  });
});

test('destroying a Military Base cancels its pending slot and later destroy events cannot rearm it', async () => {
  const chunk = tankOnlyChunk({
    rocks: Array.from({ length: 3 }, (_, index) => ({
      candidateId: `wf1:rock:w8-destroyed-base-followup-${index}`,
      worldPosition: { x: 8 + index, y: 0, z: 8 },
      metadata: { candidateRadiusMeters: 0.8 },
      owningChunkCoordinate: { x: 0, z: 0 },
    })),
  });
  const terrainRequests = [];
  const { runtime, state, renderer } = await createRuntime({
    playerSpawn: { x: 14, z: 8 },
    chunk,
    sampleTerrainHeight: (x, z, queriedChunkData) =>
      (x === 14 && z === 8) || queriedChunkData ? 0 : null,
    getChunkDataForQuery(chunkX, chunkZ) {
      return new Promise(resolveTerrain => {
        terrainRequests.push({ chunkX, chunkZ, resolveTerrain });
      });
    },
  });
  await advanceUntil(runtime, state, () => runtime.snapshot().pendingTankSpawnCount === 1);
  const tank = findBaseTank(state);
  const reservedGenerationCount = runtime.snapshot().tankOccurrenceGenerationCount;
  assert.equal(tank.spawned, false);

  const baseResult = runtime.applyCombatDamage(
    runtime.resolveCombatTarget(chunk.settlementLandmarks[0].stableId),
    3_200,
    { awardPlayerCredit: true },
  );
  assert.equal(baseResult.justDestroyed, true);
  assert.equal(runtime.snapshot().pendingTankSpawnCount, 0);
  for (const rock of chunk.rockCandidates) {
    runtime.applyCombatDamage(runtime.resolveCombatTarget(rock.candidateId), 600, {
      awardPlayerCredit: true,
    });
  }
  for (let tick = 0; tick < 600; tick += 1) {
    assert.doesNotThrow(() => runtime.update({ deltaSeconds: 0.05, player: state.player }));
  }

  await waitForAsync(() => terrainRequests.length > 0);
  for (const request of terrainRequests) {
    request.resolveTerrain(emptyChunk(request.chunkX, request.chunkZ, { terrainHeight: 0 }));
  }
  await drainAsyncWork(8);
  const snapshot = runtime.snapshot();
  assert.equal(tank.spawned, false);
  assert.equal(snapshot.activeTankCount, 0);
  assert.equal(snapshot.pendingTankSpawnCount, 0);
  assert.equal(snapshot.tankOccurrenceGenerationCount, reservedGenerationCount);
  assert.equal(renderer.occurrences.has(tank.stableId), false);
  assert.equal(renderer.entities.get(tank.stableId).spawned, false);
  await runtime.shutdown();
});

test('Tank grounding follows flat, uphill, and downhill terrain and fires from the logical 3D muzzle', async () => {
  let slope = 0;
  let crossSlope = 0;
  const terrainOffset = 5;
  const sampleTerrainHeight = (x, z) => terrainOffset + crossSlope * x + slope * z;
  const { runtime, state, renderer } = await createRuntime({
    playerSpawn: { x: 0, z: 20 },
    chunk: tankOnlyChunk(),
    sampleTerrainHeight,
  });
  const tank = armTank(runtime, state, findBaseTank(state), { x: 0, z: 0, heading: 0 });

  let rendered = renderer.entities.get(tank.stableId);
  assert.equal(rendered.groundY, terrainOffset);
  assert.ok(Math.abs(rendered.groundPitch) < 1e-12);
  assert.ok(Math.abs(rendered.groundRoll) < 1e-12);

  slope = 0.1;
  runtime.update({ deltaSeconds: 0, player: state.player });
  rendered = renderer.entities.get(tank.stableId);
  assert.ok(rendered.groundPitch < 0, 'forward-rising terrain pitches the Tank uphill');
  assert.ok(Math.abs(rendered.groundPitch + Math.atan(0.1)) < 1e-12);
  assert.ok(Math.abs(rendered.groundRoll) < 1e-12);

  slope = -0.1;
  runtime.update({ deltaSeconds: 0, player: state.player });
  rendered = renderer.entities.get(tank.stableId);
  assert.ok(rendered.groundPitch > 0, 'forward-falling terrain pitches the Tank downhill');
  assert.ok(Math.abs(rendered.groundPitch - Math.atan(0.1)) < 1e-12);

  slope = 0;
  state.gameplayTimeMs = 3_000;
  tank.lastShotAtMs = 0;
  tank.gunPitch = 0;
  runtime.update({ deltaSeconds: 0, player: state.player });
  assert.equal(renderer.projectiles.length, 1);
  const shell = renderer.projectiles[0];
  const expectedMuzzleZ = W8_TANK_LIFECYCLE_CONTRACT.turretPivotForwardMeters
    + W8_TANK_LIFECYCLE_CONTRACT.gunPivotForwardMeters
    + W8_TANK_LIFECYCLE_CONTRACT.muzzleForwardFromGunMeters;
  assert.ok(Math.abs(shell.x - tank.x) < 1e-12);
  assert.ok(Math.abs(shell.y - (terrainOffset + W8_TANK_LIFECYCLE_CONTRACT.turretPivotHeightMeters)) < 1e-12);
  assert.ok(Math.abs(shell.z - (tank.z + expectedMuzzleZ)) < 1e-12);
  assert.ok(shell.directionY < 0, 'the logical shell is aimed in three dimensions');
  assert.ok(Math.abs(Math.hypot(shell.directionX, shell.directionY, shell.directionZ) - 1) < 1e-12);

  crossSlope = 0.07;
  slope = 0.11;
  tank.rotationY = 0.7;
  tank.turretRotationY = -0.35;
  tank.gunPitch = 0.22;
  tank.lastShotAtMs = 0;
  state.gameplayTimeMs = 6_000;
  runtime.update({ deltaSeconds: 0, player: state.player });
  rendered = renderer.entities.get(tank.stableId);
  assert.notEqual(rendered.groundPitch, 0);
  assert.notEqual(rendered.groundRoll, 0);

  const visualGunMuzzle = rotateByThreeXyzMatrix(
    { x: 0, y: 0, z: W8_TANK_LIFECYCLE_CONTRACT.muzzleForwardFromGunMeters },
    rendered.gunPitch,
    0,
    0,
  );
  visualGunMuzzle.z += W8_TANK_LIFECYCLE_CONTRACT.gunPivotForwardMeters;
  const visualTurretMuzzle = rotateByThreeXyzMatrix(
    visualGunMuzzle,
    0,
    rendered.turretRotationY - rendered.rotationY,
    0,
  );
  visualTurretMuzzle.y += W8_TANK_LIFECYCLE_CONTRACT.turretPivotHeightMeters;
  visualTurretMuzzle.z += W8_TANK_LIFECYCLE_CONTRACT.turretPivotForwardMeters;
  const visualRootMuzzle = rotateByThreeXyzMatrix(
    visualTurretMuzzle,
    rendered.groundPitch,
    rendered.rotationY,
    rendered.groundRoll,
  );
  const obliqueShell = renderer.projectiles.at(-1);
  assert.ok(Math.abs(obliqueShell.x - (rendered.x + visualRootMuzzle.x)) < 1e-12);
  assert.ok(Math.abs(obliqueShell.y - (rendered.groundY + visualRootMuzzle.y)) < 1e-12);
  assert.ok(Math.abs(obliqueShell.z - (rendered.z + visualRootMuzzle.z)) < 1e-12);
  await runtime.shutdown();
});

test('production terrain sampler grounds and advances a 50-70m fallback outside Active Data without expanding 3x/5x bounds', async () => {
  const renderedKeys = squareChunkKeys(1);
  const activeDataKeys = squareChunkKeys(2);
  const activeDataSet = new Set(activeDataKeys);
  const terrainQueries = [];
  let externalMisses = 0;
  let externalHits = 0;
  let fallback;
  const sampleTerrainHeight = (x, z, queriedChunkData) => {
    const ownerKey = logicalWorldToOwnedChunk(x, z).key;
    if (activeDataSet.has(ownerKey)) return x * 0.001 + z * 0.002;
    if (!queriedChunkData) {
      externalMisses += 1;
      return null;
    }
    externalHits += 1;
    return queriedChunkData.testTerrainHeight + x * 0.001 + z * 0.002;
  };
  const getChunkDataForQuery = async (chunkX, chunkZ) => {
    await Promise.resolve();
    terrainQueries.push(createChunkKey(chunkX, chunkZ));
    return emptyChunk(chunkX, chunkZ, { terrainHeight: 0 });
  };
  const { runtime, state, renderer } = await createRuntime({
    playerSpawn: { x: 8, z: 8 },
    chunk: emptyChunk(0, 0, { terrainHeight: 0 }),
    renderedKeys,
    activeDataKeys,
    getChunkData: async (chunkX, chunkZ) => emptyChunk(chunkX, chunkZ, { terrainHeight: 0 }),
    getChunkDataForQuery,
    sampleTerrainHeight,
    configureState(candidate) {
      fallback = addFallbackTank(candidate, { sequence: 1, x: 60, z: 8 });
    },
  });

  let snapshot = runtime.snapshot();
  assert.equal(snapshot.activeSimulationChunkCount, 9);
  assert.equal(snapshot.activeDataChunkCount, 25);
  assert.equal(snapshot.activeTankCount, 1);
  assert.equal(snapshot.fallbackTankCount, 1);
  assert.equal(snapshot.tankTerrainCacheCapacity, 128);
  assert.ok(snapshot.tankTerrainCacheCount > 0 && snapshot.tankTerrainCacheCount <= 128);
  assert.equal(snapshot.tankTerrainPendingQueryCount, 0);
  assert.ok(externalMisses > 0, 'outside Active Data the production sampler requests canonical ChunkData');
  assert.ok(externalHits > 0);
  assert.ok(terrainQueries.includes('3,0'));
  assert.equal(activeDataSet.has(logicalWorldToOwnedChunk(fallback.x, fallback.z).key), false);
  const occurrenceRender = renderer.occurrences.get(fallback.stableId);
  assert.ok(Number.isFinite(occurrenceRender.groundY));
  assert.ok(Math.abs(occurrenceRender.groundY - (fallback.x * 0.001 + fallback.z * 0.002)) < 1e-12);

  fallback.rotationY = -Math.PI / 2;
  fallback.turretRotationY = -Math.PI / 2;
  fallback.gunPitch = 0;
  fallback.stuckCheckClock = 0.5;
  fallback.lastShotAtMs = 0;
  state.gameplayTimeMs = 3_000;
  runtime.update({ deltaSeconds: 0, player: state.player });
  assert.equal(runtime.snapshot().activeProjectileCount, 1);
  const shellStart = { ...renderer.projectiles[0] };
  assert.equal(activeDataSet.has(logicalWorldToOwnedChunk(shellStart.x, shellStart.z).key), false);
  assert.doesNotThrow(() => runtime.update({ deltaSeconds: 0.05, player: state.player }));
  const shellAfterExternalStep = renderer.projectiles[0];
  assert.ok(shellAfterExternalStep.x < shellStart.x, 'the shell advances through queried terrain outside Active Data');

  let maximumProjectiles = runtime.snapshot().activeProjectileCount;
  for (let tick = 0; tick < 240; tick += 1) {
    assert.doesNotThrow(() => runtime.update({ deltaSeconds: 0.05, player: state.player }));
    maximumProjectiles = Math.max(maximumProjectiles, runtime.snapshot().activeProjectileCount);
    if (tick % 8 === 0) await drainAsyncWork(1);
  }
  await drainAsyncWork();
  snapshot = runtime.snapshot();
  assert.equal(snapshot.activeSimulationChunkCount, 9);
  assert.equal(snapshot.activeDataChunkCount, 25);
  assert.equal(snapshot.tankTerrainCacheCapacity, 128);
  assert.ok(snapshot.tankTerrainCacheCount <= snapshot.tankTerrainCacheCapacity);
  assert.ok(snapshot.tankTerrainPendingQueryCount <= snapshot.tankTerrainCacheCapacity);
  assert.ok(maximumProjectiles <= 3, `finite cooldown/lifetime bounds projectiles, observed ${maximumProjectiles}`);
  assert.ok(snapshot.activeProjectileCount <= 3);
  assert.ok(renderer.projectiles.length <= 3);
  await runtime.shutdown();
});

test('malformed or wrong off-grid Tank terrain queries surface once without retrying forever', async t => {
  const cases = [
    {
      name: 'wrong Chunk coordinate',
      result(chunkX, chunkZ) {
        return emptyChunk(chunkX + 1, chunkZ, { terrainHeight: 0 });
      },
    },
    {
      name: 'malformed Chunk coordinate',
      result(chunkX, chunkZ) {
        return { ...emptyChunk(chunkX, chunkZ, { terrainHeight: 0 }), chunkX: String(chunkX) };
      },
    },
  ];

  for (const malformedCase of cases) {
    await t.test(malformedCase.name, async () => {
      let queryCount = 0;
      const activeDataSet = new Set(['0,0']);
      const sampleTerrainHeight = (x, z, queriedChunkData) => {
        if (activeDataSet.has(logicalWorldToOwnedChunk(x, z).key)) return 0;
        return queriedChunkData ? 0 : null;
      };
      const { runtime, state } = await createRuntime({
        playerSpawn: { x: 8, z: 8 },
        chunk: emptyChunk(0, 0, { terrainHeight: 0 }),
        sampleTerrainHeight,
        getChunkDataForQuery(chunkX, chunkZ) {
          queryCount += 1;
          return malformedCase.result(chunkX, chunkZ);
        },
      });
      addFallbackTank(state, { sequence: 1, x: 60, z: 8 });
      runtime.clearTransientCombat();

      assert.doesNotThrow(() => runtime.update({ deltaSeconds: 0, player: state.player }));
      await waitForAsync(() => runtime.snapshot().tankTerrainPendingQueryCount === 0);
      assert.equal(queryCount, 1);

      const assertIntegrityFailure = () => assert.throws(
        () => runtime.update({ deltaSeconds: 0, player: state.player }),
        error => {
          assert.equal(error?.code, 'ERR_TANK_TERRAIN_INTEGRITY');
          assert.match(error.message, /malformed or wrong ChunkData for 3,0/);
          return true;
        },
      );
      for (let repeat = 0; repeat < 4; repeat += 1) assertIntegrityFailure();
      assert.equal(queryCount, 1, 'the cached integrity failure prevents an unbounded query loop');
      assert.equal(runtime.snapshot().tankTerrainPendingQueryCount, 0);
      await runtime.shutdown();
    });
  }

  await t.test('natural fallback spawn queues one surfaced integrity error without an unhandled rejection', async () => {
    const unhandledRejections = [];
    const observeUnhandledRejection = reason => unhandledRejections.push(reason);
    process.on('unhandledRejection', observeUnhandledRejection);
    let runtime = null;
    try {
      let queryCount = 0;
      const activeDataSet = new Set(['0,0']);
      const sampleTerrainHeight = (x, z, queriedChunkData) => {
        if (activeDataSet.has(logicalWorldToOwnedChunk(x, z).key)) return 0;
        return queriedChunkData ? 0 : null;
      };
      let state;
      ({ runtime, state } = await createRuntime({
        playerSpawn: { x: 8, z: 8 },
        chunk: emptyChunk(0, 0, { terrainHeight: 0 }),
        sampleTerrainHeight,
        getChunkDataForQuery(chunkX, chunkZ) {
          queryCount += 1;
          return { ...emptyChunk(chunkX, chunkZ), chunkX: String(chunkX) };
        },
        configureState(candidate) {
          candidate.player.score = 3_000;
        },
      }));

      advanceUntilSequence(runtime, state, 1);
      await waitForAsync(() => queryCount > 0);
      await waitForAsync(() => runtime.snapshot().tankTerrainPendingQueryCount === 0);
      await drainAsyncWork(8);

      assert.throws(
        () => runtime.update({ deltaSeconds: 0, player: state.player }),
        error => {
          assert.equal(error?.code, 'ERR_TANK_TERRAIN_INTEGRITY');
          assert.match(error.message, /malformed or wrong ChunkData for/);
          return true;
        },
        'the update after the asynchronous spawn attempt surfaces its queued integrity error',
      );
      assert.equal(state.tankReinforcementSequence, 1);
      assert.equal(runtime.snapshot().activeTankCount, 0);
      assert.equal(runtime.snapshot().fallbackTankCount, 0);
      assert.ok(queryCount > 0);
      await drainAsyncWork(4);
      assert.deepEqual(unhandledRejections, []);

      await runtime.shutdown();
      runtime = null;
      await drainAsyncWork(2);
      assert.deepEqual(unhandledRejections, []);
    } finally {
      if (runtime) await runtime.shutdown();
      process.off('unhandledRejection', observeUnhandledRejection);
    }
  });
});

test('stale in-flight fallback work cannot cross restart or restored-state refresh epochs', async t => {
  const activeDataSet = new Set(['0,0']);
  const sampleTerrainHeight = (x, z, queriedChunkData) => {
    if (activeDataSet.has(logicalWorldToOwnedChunk(x, z).key)) return 0;
    return queriedChunkData ? 0 : null;
  };

  await t.test('restart rejects Stable ID work that began in the previous run', async () => {
    const deferredTerrain = [];
    const { runtime, state, renderer } = await createRuntime({
      playerSpawn: { x: 8, z: 8 },
      chunk: emptyChunk(0, 0),
      getChunkDataForQuery(chunkX, chunkZ) {
        return new Promise(resolveTerrain => deferredTerrain.push({ chunkX, chunkZ, resolveTerrain }));
      },
      sampleTerrainHeight,
      configureState(candidate) {
        candidate.player.score = 3_000;
      },
    });
    advanceUntilSequence(runtime, state, 1);
    assert.equal(state.tankReinforcementSequence, 1);
    await runtime.restart({
      playerSpawn: { x: 2, z: 3 },
      renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
    });
    for (const request of deferredTerrain) {
      request.resolveTerrain(emptyChunk(request.chunkX, request.chunkZ, { terrainHeight: 0 }));
    }
    await drainAsyncWork(8);
    assert.equal(state.tankReinforcementSequence, 0);
    assert.equal([...state.entityStates.values()].some(entity => entity.type === 'tank'), false);
    assert.equal(runtime.snapshot().activeTankCount, 0);
    assert.equal(runtime.snapshot().fallbackTankCount, 0);
    assert.equal(renderer.occurrences.size, 0);
    await runtime.shutdown();
  });

  await t.test('clear and refresh reject a pending terrain spawn after save restoration', async () => {
    const deferredTerrain = [];
    const { runtime, state, renderer } = await createRuntime({
      playerSpawn: { x: 8, z: 8 },
      chunk: emptyChunk(0, 0),
      getChunkDataForQuery(chunkX, chunkZ) {
        return new Promise(resolveTerrain => deferredTerrain.push({ chunkX, chunkZ, resolveTerrain }));
      },
      sampleTerrainHeight,
      configureState(candidate) {
        for (let sequence = 0; sequence < 5; sequence += 1) candidate.nextTankReinforcementSequence();
        candidate.player.score = 3_000;
      },
    });
    const restoredSnapshot = state.createSaveSnapshot();
    advanceUntilSequence(runtime, state, 6);
    await waitForAsync(() => deferredTerrain.length > 0);
    assert.equal(state.tankReinforcementSequence, 6);
    assert.ok(runtime.snapshot().tankTerrainPendingQueryCount > 0);

    state.restoreSaveSnapshot(restoredSnapshot);
    runtime.clearTransientCombat();
    await runtime.refreshFromState({
      renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
    });
    for (const request of deferredTerrain) {
      request.resolveTerrain(emptyChunk(request.chunkX, request.chunkZ, { terrainHeight: 0 }));
    }
    await drainAsyncWork(8);
    assert.equal(state.tankReinforcementSequence, 5);
    assert.equal([...state.entityStates.values()].some(entity => entity.type === 'tank'), false);
    assert.equal(runtime.snapshot().activeTankCount, 0);
    assert.equal(runtime.snapshot().fallbackTankCount, 0);
    assert.equal(runtime.snapshot().tankTerrainPendingQueryCount, 0);
    assert.equal(renderer.occurrences.size, 0);
    assert.equal(state.nextTankReinforcementSequence(), 6, 'restored sequence remains the next fresh fallback identity');
    await runtime.shutdown();
  });

  await t.test('scale reduction rejects a pending terrain spawn before occurrence mutation', async () => {
    const deferredTerrain = [];
    const { runtime, state, renderer } = await createRuntime({
      playerSpawn: { x: 8, z: 8 },
      chunk: emptyChunk(0, 0),
      getChunkDataForQuery(chunkX, chunkZ) {
        return new Promise(resolveTerrain => deferredTerrain.push({ chunkX, chunkZ, resolveTerrain }));
      },
      sampleTerrainHeight,
      configureState(candidate) {
        candidate.player.score = 3_000;
      },
    });
    advanceUntilSequence(runtime, state, 1);
    await waitForAsync(() => deferredTerrain.length > 0);

    state.setScaleStage('TINY');
    runtime.update({ deltaSeconds: 0, player: state.player });
    for (const request of deferredTerrain) {
      request.resolveTerrain(emptyChunk(request.chunkX, request.chunkZ, { terrainHeight: 0 }));
    }
    await drainAsyncWork(8);

    assert.equal(state.tankReinforcementSequence, 1, 'cancelled work still consumes its monotonic identity');
    assert.equal([...state.entityStates.values()].some(entity => entity.type === 'tank'), false);
    assert.equal(runtime.snapshot().activeTankCount, 0);
    assert.equal(runtime.snapshot().fallbackTankCount, 0);
    assert.equal(runtime.snapshot().tankOwnerRegistryCount, 0);
    assert.equal(runtime.snapshot().tankTerrainPendingQueryCount, 0);
    assert.equal(renderer.occurrences.size, 0);
    await runtime.shutdown();
  });
});

test('Tank shell keeps finite player, world, terrain, and difficulty-speed collision semantics', async t => {
  await t.test('world targets receive exactly 150 damage', async () => {
    const rockStableId = 'wf1:rock:w7c-shell-target';
    const chunk = tankOnlyChunk({
      rocks: [{
        candidateId: rockStableId,
        worldPosition: { x: 0, y: 0, z: 10 },
        metadata: { candidateRadiusMeters: 2 },
        owningChunkCoordinate: { x: 0, z: 0 },
      }],
    });
    const { runtime, state } = await createRuntime({
      playerSpawn: { x: 0, z: 30 }, chunk,
    });
    const tank = findBaseTank(state);
    state.damageFeature({ stableId: rockStableId, maxHp: 600 }, 600);
    armTank(runtime, state, tank, { x: 0, z: 0, heading: 0 });
    state.gameplayTimeMs = 3_000;
    tank.lastShotAtMs = 0;
    runtime.update({ deltaSeconds: 0, player: state.player });
    assert.equal(runtime.snapshot().activeProjectileCount, 1);
    state.featureDamage.delete(rockStableId);
    for (let tick = 0; tick < 12 && !state.featureDamage.has(rockStableId); tick += 1) {
      runtime.update({ deltaSeconds: 0.01, player: state.player });
    }
    assert.equal(state.featureDamage.get(rockStableId).damage, 150);
    assert.equal(state.player.hp, state.player.maxHp);
    assert.equal(runtime.snapshot().activeProjectileCount, 0);
    await runtime.shutdown();
  });

  await t.test('player collision applies the protected Tank damage once', async () => {
    const { runtime, state } = await createRuntime({
      playerSpawn: { x: 0, z: 20 }, chunk: tankOnlyChunk(),
    });
    const tank = armTank(runtime, state, findBaseTank(state), { x: 0, z: 0, heading: 0 });
    state.gameplayTimeMs = 3_000;
    tank.lastShotAtMs = 0;
    runtime.update({ deltaSeconds: 0, player: state.player });
    await advanceUntil(runtime, state, () => state.player.hp < state.player.maxHp, 10);
    assert.equal(state.player.hp, state.player.maxHp - TANK_BULLET_DAMAGE);
    assert.equal(runtime.snapshot().counts.playerHits, 1);
    assert.equal(runtime.snapshot().activeProjectileCount, 0);
    assert.equal(runtime.consumePresentationEffects().cameraShake, 35);
    await runtime.shutdown();
  });

  await t.test('canonical terrain stops the 3D shell before the player', async () => {
    let terrainHeight = 0;
    const { runtime, state } = await createRuntime({
      playerSpawn: { x: 0, z: 100 },
      chunk: tankOnlyChunk(),
      sampleTerrainHeight: () => terrainHeight,
    });
    const tank = armTank(runtime, state, findBaseTank(state), { x: 0, z: 0, heading: 0 });
    state.gameplayTimeMs = 3_000;
    tank.lastShotAtMs = 0;
    runtime.update({ deltaSeconds: 0, player: state.player });
    terrainHeight = 10;
    runtime.update({ deltaSeconds: 0.01, player: state.player });
    assert.equal(runtime.snapshot().activeProjectileCount, 0);
    assert.equal(state.player.hp, state.player.maxHp);
    assert.ok(runtime.consumePresentationEffects().events.some(event => event.type === 'tank-impact'));
    await runtime.shutdown();
  });

  await t.test('score difficulty scales shell speed to the finite 1.5 ceiling', async () => {
    const { runtime, state, renderer } = await createRuntime({
      playerSpawn: { x: 0, z: 100 }, chunk: tankOnlyChunk(),
    });
    const tank = armTank(runtime, state, findBaseTank(state), { x: 0, z: 0, heading: 0 });
    state.player.score = 100_000;
    state.gameplayTimeMs = 3_000;
    tank.lastShotAtMs = 0;
    runtime.update({ deltaSeconds: 0, player: state.player });
    const start = { ...renderer.projectiles[0] };
    runtime.update({ deltaSeconds: 0.01, player: state.player });
    const moved = renderer.projectiles[0];
    const expectedMeters = TANK_BULLET_SPEED / 40 * 60 * 1.5 * 0.01;
    assert.ok(Math.abs(moved.x - (start.x + start.directionX * expectedMeters)) < 1e-9);
    assert.ok(Math.abs(moved.y - (start.y + start.directionY * expectedMeters)) < 1e-9);
    assert.ok(Math.abs(moved.z - (start.z + start.directionZ * expectedMeters)) < 1e-9);
    await runtime.shutdown();
  });
});

test('building destruction, score, healing, hit stop and effects share the W6 World State', async () => {
  const { runtime, state, features } = await createRuntime();
  state.damagePlayer(50);
  const result = runtime.attack('single', 0);
  const houseHit = result.hits.find(value => value.type === 'house');
  assert.deepEqual(houseHit, {
    stableId: 'settlement-building-v1:w7c-house', type: 'house', destroyed: true,
  });
  assert.equal(state.player.score, 300, 'a reserve Tank is not an invisible attack target');
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
