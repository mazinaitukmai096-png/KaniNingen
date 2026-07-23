import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOMB_COOLDOWN,
  BOMB_DAMAGE_AMOUNT,
  BOMB_DAMAGE_RADIUS,
  BOMB_PUSH_RADIUS,
  BOSS_BODY_CONTACT_DAMAGE,
  BOSS_BODY_CONTACT_RANGE,
  BOSS_CHARGE_DAMAGE,
  BOSS_CHARGE_DAMAGE_RAGE,
  BOSS_CHARGE_DURATION_FROM_SLITHER,
  BOSS_CHARGE_HIT_RADIUS,
  BOSS_CHARGE_PUSH_FORCE,
  BOSS_CHARGE_SPEED,
  BOSS_CHARGE_SPEED_RAGE,
  BOSS_PLAYER_KNOCKBACK_DECAY,
  BOSS_SLITHER_DURATION,
  CHARGE_THRESHOLD,
  DEBUG_BOSS_SPAWN_DIST,
} from '../src/constants.js';
import {
  W6_ENTITY_CONTRACTS,
  W7_MANUAL_BOSS_CONTRACT,
  W7_NUCLEAR_CONTRACT,
  W8_COMBAT_COMMAND_TYPES,
  createCombatCommand,
  finiteWorldUnitsToMeters,
} from '../src/infinite-world/gameplay-contract.js';
import {
  InfiniteGameplayRuntime,
  chunksIntersectingLogicalCircle,
} from '../src/infinite-world/gameplay-runtime.js';
import {
  InfiniteWorldSaveStore,
  InfiniteWorldState,
} from '../src/infinite-world/world-state-store.js';

const worldSeedHash = `sha256:${'d'.repeat(64)}`;

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

class FakeRenderer {
  constructor() {
    this.loaded = new Map(); this.entities = new Map(); this.manualBoss = null;
    this.reinforcements = new Map(); this.projectiles = []; this.effects = [];
  }
  async rebase(origin) { this.origin = { ...origin }; }
  async loadChunk(key, states) {
    this.loaded.set(key, states.map(value => value.stableId));
    for (const state of states) this.entities.set(state.stableId, { ...state });
  }
  syncEntity(state) { if (this.entities.has(state.stableId)) this.entities.set(state.stableId, { ...state }); }
  syncReinforcement(state) {
    if (!state?.alive || state.spawned !== true) return this.removeReinforcement(state?.stableId);
    this.reinforcements.set(state.stableId, { ...state });
    return true;
  }
  removeReinforcement(stableId) { return this.reinforcements.delete(stableId); }
  clearReinforcements() { this.reinforcements.clear(); }
  syncManualBoss(state) { this.manualBoss = state?.alive ? { ...state } : null; }
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
      liveChunkGroups: this.loaded.size, liveEntityMeshes: this.entities.size,
      liveReinforcementMeshes: this.reinforcements.size,
      liveManualBossMeshes: this.manualBoss ? 1 : 0,
    };
  }
  async shutdown() {
    this.loaded.clear(); this.entities.clear(); this.manualBoss = null;
    this.reinforcements.clear();
    this.projectiles = []; this.effects = [];
  }
}

function syntheticChunk(chunkX, chunkZ) {
  const x = chunkX * 16 + 8;
  const z = chunkZ * 16 + 8;
  return {
    chunkX, chunkZ,
    vegetationCandidates: [],
    rockCandidates: [],
    settlementFeatures: [{
      stableId: `settlement-building-v1:nuclear:${chunkX},${chunkZ}`,
      featureType: 'settlement-building', buildingType: 'house', radiusMeters: 2,
      worldPosition: { x, y: 0, z }, owningChunkCoordinate: { x: chunkX, z: chunkZ },
    }],
    settlementReferences: [],
  };
}

function emptyChunk(chunkX, chunkZ) {
  return {
    chunkX, chunkZ,
    vegetationCandidates: [], rockCandidates: [], settlementFeatures: [],
    settlementReferences: [], settlementLandmarks: [], ambientDetails: [],
    streetDetails: [], waterSurfaces: [],
  };
}

function canonicalMilitaryChunk(chunkX, chunkZ) {
  if (chunkX !== 0 || chunkZ !== 0) return emptyChunk(chunkX, chunkZ);
  const settlementId = 'settlement-v1:atomic-tank-owner';
  return {
    ...emptyChunk(chunkX, chunkZ),
    settlementReferences: [{
      settlementId,
      townType: 'military',
      settlementType: 'RURAL',
      center: { x: 8, z: 8 },
    }],
    settlementLandmarks: [{
      schemaVersion: 'w8-settlement-landmark-1',
      stableId: 'wf1:settlement-landmark:atomic-tank-base',
      parentSettlementId: settlementId,
      settlementType: 'RURAL',
      townType: 'military',
      landmarkType: 'militaryBase',
      worldPosition: { x: 8, y: 0, z: 8 },
      rotationY: 0,
      widthMeters: 11,
      heightMeters: 6,
      depthMeters: 11,
      destructible: true,
      owningChunkCoordinate: { x: 0, z: 0 },
      logicalLocal: { x: 8, z: 8 },
    }],
  };
}

function createRuntime({ active = false, query = syntheticChunk } = {}) {
  const state = new InfiniteWorldState({ worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  const renderer = new FakeRenderer();
  const featureRenderer = { refreshes: 0, refreshFeatureStates() { this.refreshes += 1; } };
  const runtime = new InfiniteGameplayRuntime({
    worldSeedHash,
    generatorMajor: 1,
    state,
    renderAdapter: renderer,
    featureRenderAdapter: featureRenderer,
    getChunkDataForQuery: async (chunkX, chunkZ) => query(chunkX, chunkZ),
    clock: () => 0,
  });
  const initialize = active ? runtime.syncActiveChunks({
    renderedKeys: ['0,0'],
    getChunkData: () => syntheticChunk(0, 0),
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  }) : Promise.resolve();
  return { state, renderer, featureRenderer, runtime, initialize };
}

test('W7D Nuclear and manual Boss contracts import every protected finite value', () => {
  assert.deepEqual(W7_NUCLEAR_CONTRACT, {
    allowedScaleStageId: 'MAX',
    chargeThresholdMs: CHARGE_THRESHOLD,
    cooldownMs: BOMB_COOLDOWN,
    damageRadius: BOMB_DAMAGE_RADIUS,
    pushRadius: BOMB_PUSH_RADIUS,
    damageAmount: BOMB_DAMAGE_AMOUNT,
    cameraShake: 450,
  });
  assert.deepEqual(W7_MANUAL_BOSS_CONTRACT, {
    spawnDistance: DEBUG_BOSS_SPAWN_DIST,
    simultaneousLimit: 1,
    slitherDurationSeconds: BOSS_SLITHER_DURATION,
    chargeDurationSeconds: BOSS_CHARGE_DURATION_FROM_SLITHER,
    chargeSpeed: BOSS_CHARGE_SPEED,
    chargeSpeedRage: BOSS_CHARGE_SPEED_RAGE,
    chargeHitRadius: BOSS_CHARGE_HIT_RADIUS,
    chargeDamage: BOSS_CHARGE_DAMAGE,
    chargeDamageRage: BOSS_CHARGE_DAMAGE_RAGE,
    chargePushForce: BOSS_CHARGE_PUSH_FORCE,
    bodyContactRange: BOSS_BODY_CONTACT_RANGE,
    bodyContactDamage: BOSS_BODY_CONTACT_DAMAGE,
    playerKnockbackDecay: BOSS_PLAYER_KNOCKBACK_DECAY,
  });
});

test('circle query enumerates every intersecting logical Chunk in stable order', () => {
  const radius = finiteWorldUnitsToMeters(BOMB_DAMAGE_RADIUS);
  const first = chunksIntersectingLogicalCircle(0, 0, radius);
  const second = chunksIntersectingLogicalCircle(0, 0, radius);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map(value => value.key)).size, first.length);
  assert.ok(first.some(value => value.key === '2,0'));
  assert.ok(first.some(value => value.key === '-3,0'));
  assert.equal(first.every((value, index) => index === 0
    || value.chunkZ > first[index - 1].chunkZ
    || (value.chunkZ === first[index - 1].chunkZ && value.chunkX > first[index - 1].chunkX)), true);
});

test('Nuclear destruction is independent of active rendered and Simulation Chunk sets', async () => {
  const inactive = createRuntime({ active: false });
  const active = createRuntime({ active: true });
  await Promise.all([inactive.initialize, active.initialize]);
  const first = await inactive.runtime.nuclearAttack({ x: 0, z: 0, airborne: true });
  const second = await active.runtime.nuclearAttack({ x: 0, z: 0, airborne: true });
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.deepEqual(first.queriedChunkKeys, second.queriedChunkKeys);
  assert.deepEqual(first.hitStableIds, second.hitStableIds);
  assert.ok(first.hitStableIds.includes('settlement-building-v1:nuclear:2,0'));
  assert.equal(inactive.runtime.snapshot().activeSimulationChunkCount, 0);
  assert.equal(inactive.renderer.loaded.size, 0);
  assert.equal(inactive.state.isFeatureDestroyed('settlement-building-v1:nuclear:2,0'), true);
  assert.equal(inactive.state.nuclearCooldownMs, BOMB_COOLDOWN);
  assert.equal(inactive.runtime.snapshot().counts.nuclearChunksQueried, first.queriedChunkKeys.length);
  assert.equal(inactive.featureRenderer.refreshes, 1);
  await inactive.runtime.shutdown();
  await active.runtime.shutdown();
});

test('Atomic destroys moved base-slot and fallback Tanks through active occurrences without Tank score', async () => {
  const fixture = createRuntime({ query: canonicalMilitaryChunk });
  await fixture.runtime.syncActiveChunks({
    renderedKeys: ['0,0'],
    getChunkData: canonicalMilitaryChunk,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });

  const baseTank = [...fixture.state.entityStates.values()].find(entity =>
    entity.type === 'tank' && entity.reinforcementSequence === 0);
  assert.ok(baseTank);
  assert.deepEqual({ x: baseTank.x, z: baseTank.z, owner: baseTank.ownerChunkKey }, {
    x: 8, z: 8, owner: '0,0',
  });
  Object.assign(baseTank, {
    alive: true,
    hp: baseTank.maxHp,
    spawned: true,
    aiState: 'acquire',
    lastShotAtMs: 0,
  });
  fixture.runtime.update({ deltaSeconds: 0, player: fixture.state.player });

  Object.assign(baseTank, { x: 80, z: 8, lastX: 80, lastZ: 8 });
  const reinforcementSequence = fixture.state.nextTankReinforcementSequence();
  const fallbackTank = fixture.state.ensureEntity({
    stableId: `wf1:tank:w8-atomic-fallback:${reinforcementSequence}`,
    ownerChunkKey: '5,0',
    type: 'tank',
    maxHp: W6_ENTITY_CONTRACTS.tank.maxHp,
    x: 81,
    z: 8,
    rotationY: 0,
    aiState: 'engage',
    spawned: true,
    reinforcementSequence,
    baseX: 81,
    baseZ: 8,
  });
  fixture.runtime.clearTransientCombat();
  await fixture.runtime.syncActiveChunks({
    renderedKeys: ['5,0'],
    getChunkData: canonicalMilitaryChunk,
    renderOrigin: { renderOriginChunkX: 5, renderOriginChunkZ: 0 },
  });
  fixture.state.updatePlayer({ x: 80, z: 8, score: 777 });

  assert.equal(baseTank.ownerChunkKey, '0,0');
  assert.equal(fixture.renderer.loaded.has('0,0'), false);
  assert.equal(fixture.runtime.snapshot().activeTankCount, 2);
  assert.deepEqual([...fixture.renderer.reinforcements.keys()].sort(),
    [baseTank.stableId, fallbackTank.stableId].sort());

  const result = await fixture.runtime.executeCombatCommand(createCombatCommand(
    W8_COMBAT_COMMAND_TYPES.CHARGE_RELEASE,
    { airborne: true, chargeMs: W7_NUCLEAR_CONTRACT.chargeThresholdMs },
  ));
  assert.equal(result.accepted, true);
  assert.equal(result.queriedChunkKeys.includes('0,0'), false);
  assert.deepEqual(result.hitStableIds, [baseTank.stableId, fallbackTank.stableId].sort());
  assert.deepEqual({ hp: baseTank.hp, alive: baseTank.alive, spawned: baseTank.spawned }, {
    hp: 0, alive: false, spawned: false,
  });
  assert.equal(fixture.state.entityStates.has(baseTank.stableId), true);
  assert.equal(fixture.state.entityStates.has(fallbackTank.stableId), false);
  assert.equal(fixture.state.player.score, 777);
  assert.equal(fixture.renderer.reinforcements.size, 0);
  assert.equal(fixture.renderer.effects.filter(effect => effect.type === 'tank-destruction').length, 2);
  assert.equal(fixture.renderer.effects.filter(effect => effect.type === 'nuclear-destruction').length, 1);
  assert.deepEqual({
    active: fixture.runtime.snapshot().activeTankCount,
    fallback: fixture.runtime.snapshot().fallbackTankCount,
    slots: fixture.runtime.snapshot().tankSlotCount,
    owners: fixture.runtime.snapshot().tankOwnerRegistryCount,
    destroyed: fixture.runtime.snapshot().counts.destroyedEntities,
  }, { active: 0, fallback: 0, slots: 1, owners: 1, destroyed: 2 });
  await fixture.runtime.shutdown();
});

test('Nuclear rejects Scale, air-release and cooldown violations without partial state mutation', async () => {
  const fixture = createRuntime();
  const before = fixture.state.createSaveSnapshot();
  fixture.state.setScaleStage('MID');
  assert.equal((await fixture.runtime.nuclearAttack({ airborne: true })).reason, 'scale-not-allowed');
  fixture.state.setScaleStage('MAX');
  assert.equal((await fixture.runtime.nuclearAttack({ airborne: false })).reason, 'air-release-required');
  assert.equal(fixture.state.featureDamage.size, 0);
  const accepted = await fixture.runtime.nuclearAttack({ airborne: true });
  assert.equal(accepted.accepted, true);
  assert.equal((await fixture.runtime.nuclearAttack({ airborne: true })).reason, 'cooldown');
  assert.equal(before.worldSeedHash, fixture.state.worldSeedHash);
  await fixture.runtime.shutdown();

  const failing = createRuntime({ query(chunkX, chunkZ) {
    if (chunkX === 0 && chunkZ === 0) throw new Error('query failure');
    return syntheticChunk(chunkX, chunkZ);
  } });
  const beforeFailure = failing.state.createSaveSnapshot();
  await assert.rejects(() => failing.runtime.nuclearAttack({ airborne: true }), /query failure/);
  assert.deepEqual(failing.state.createSaveSnapshot(), beforeFailure);
  await failing.runtime.shutdown();
});

test('manual Boss is unique, Stable-ID backed, moves across Chunk ownership and respawns only after defeat', async () => {
  const fixture = createRuntime();
  const spawned = await fixture.runtime.spawnManualBoss();
  assert.equal(spawned.accepted, true);
  assert.equal(spawned.spawnDistanceMeters, finiteWorldUnitsToMeters(DEBUG_BOSS_SPAWN_DIST));
  assert.match(spawned.stableId, /^wf1:boss:/);
  assert.equal(fixture.renderer.manualBoss.stableId, spawned.stableId);
  assert.equal((await fixture.runtime.spawnManualBoss()).reason, 'manual-boss-already-active');
  const originalOwner = fixture.state.entityStates.get(spawned.stableId).ownerChunkKey;
  for (let index = 0; index < 30; index += 1) {
    fixture.runtime.update({ deltaSeconds: 0.05, player: fixture.state.player });
  }
  const movedBoss = fixture.state.entityStates.get(spawned.stableId);
  assert.notEqual(movedBoss.ownerChunkKey, originalOwner);
  assert.equal(fixture.state.manualBossStableId, spawned.stableId);
  fixture.state.damageEntity(spawned.stableId, movedBoss.maxHp);
  fixture.runtime.update({ deltaSeconds: 0, player: fixture.state.player });
  assert.equal(fixture.renderer.manualBoss, null);
  const respawned = await fixture.runtime.spawnManualBoss();
  assert.equal(respawned.accepted, true);
  assert.equal(respawned.sequence, 2);
  assert.notEqual(respawned.stableId, spawned.stableId);
  await fixture.runtime.shutdown();
});

test('manual Boss and Nuclear cooldown round-trip through the existing save system', async () => {
  const fixture = createRuntime();
  const boss = await fixture.runtime.spawnManualBoss();
  fixture.state.damageEntity(boss.stableId, 8000);
  fixture.state.setNuclearCooldown(4321);
  const storage = new MemoryStorage();
  const store = new InfiniteWorldSaveStore({ storage, worldSeedHash });
  await store.save(fixture.state);
  const restored = new InfiniteWorldState({ worldSeedHash, playerSpawn: { x: 99, z: 99 } });
  await store.loadInto(restored);
  assert.equal(restored.manualBossStableId, boss.stableId);
  assert.equal(restored.manualBossSequence, 1);
  assert.equal(restored.entityStates.get(boss.stableId).hp, 52000);
  assert.equal(restored.nuclearCooldownMs, 4321);
  assert.deepEqual(restored.createSaveSnapshot(), fixture.state.createSaveSnapshot());
  await fixture.runtime.shutdown();
});

test('manual Boss reaches its protected charge phase and damages the existing player record', async () => {
  const fixture = createRuntime();
  await fixture.runtime.spawnManualBoss();
  const initialHp = fixture.state.player.hp;
  for (let index = 0; index < 150; index += 1) {
    fixture.runtime.update({ deltaSeconds: 0.05, player: fixture.state.player });
  }
  assert.ok(fixture.state.player.hp < initialHp);
  assert.ok(['slither', 'charge'].includes(
    fixture.state.entityStates.get(fixture.state.manualBossStableId).aiState,
  ));
  assert.ok(fixture.runtime.snapshot().counts.playerHits > 0);
  await fixture.runtime.shutdown();
});
