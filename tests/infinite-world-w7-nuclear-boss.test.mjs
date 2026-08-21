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
  W6_STATIC_TARGET_CONTRACTS,
  W7_CORE_COMBAT_CONTRACT,
  W7_MANUAL_BOSS_CONTRACT,
  W7_NUCLEAR_CONTRACT,
  W8_COMBAT_COMMAND_TYPES,
  W8_BOSS_CONTRACT,
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
  const featureRenderer = {
    refreshes: 0,
    destroyedStableIds: [],
    refreshFeatureStates() { this.refreshes += 1; },
    setFeatureDestroyed(stableId, destroyed) {
      if (destroyed === true) this.destroyedStableIds.push(stableId);
      return true;
    },
  };
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

async function captureTailKnockback({ rotationY = 0, offsetX = 0, offsetZ = 0 } = {}) {
  const fixture = createRuntime();
  try {
    const spawned = await fixture.runtime.spawnManualBoss();
    const boss = fixture.state.entityStates.get(spawned.stableId);
    Object.assign(boss, { x: 0, z: 0, rotationY });
    Object.assign(boss.bossBehavior, {
      phase: 'sweep', phaseClock: 0, tailCooldownSeconds: 0,
    });
    const tailDistance = finiteWorldUnitsToMeters(
      W8_BOSS_CONTRACT.tail.segmentSpacing * (W8_BOSS_CONTRACT.segmentCount - 1),
    );
    fixture.state.updatePlayer({
      x: -Math.sin(rotationY) * tailDistance + offsetX,
      z: -Math.cos(rotationY) * tailDistance + offsetZ,
    });
    const hpBefore = fixture.state.player.hp;
    fixture.runtime.update({ deltaSeconds: Number.EPSILON, player: fixture.state.player });
    const impactPosition = { x: fixture.state.player.x, z: fixture.state.player.z };
    const impactHp = fixture.state.player.hp;
    const impactHitCount = fixture.runtime.snapshot().counts.playerHits;
    fixture.runtime.update({
      deltaSeconds: Number.EPSILON, player: fixture.state.player, simulationEnabled: true,
    });
    return {
      hpBefore,
      impactHp,
      continuationHp: fixture.state.player.hp,
      impactHitCount,
      tailCooldownSeconds: boss.bossBehavior.tailCooldownSeconds,
      displacement: {
        x: fixture.state.player.x - impactPosition.x,
        z: fixture.state.player.z - impactPosition.z,
      },
      player: { x: fixture.state.player.x, z: fixture.state.player.z },
    };
  } finally {
    await fixture.runtime.shutdown();
  }
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

test('Atomic reuses resident Gameplay Data and queries only off-resident simulation-ticket coverage', async () => {
  const queried = [];
  const fixture = createRuntime({ query(chunkX, chunkZ) {
    queried.push(`${chunkX},${chunkZ}`);
    return syntheticChunk(chunkX, chunkZ);
  } });
  await fixture.runtime.syncActiveChunks({
    activeDataKeys: ['0,0'],
    renderedKeys: ['0,0'],
    getChunkData: () => syntheticChunk(0, 0),
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  fixture.state.updatePlayer({ hp: 50, score: 100 });
  const refreshesBeforeAttack = fixture.featureRenderer.refreshes;

  const result = await fixture.runtime.nuclearAttack({ x: 0, z: 0, airborne: true });
  const houseId = 'settlement-building-v1:nuclear:0,0';
  const outsideId = 'settlement-building-v1:nuclear:4,0';
  assert.equal(result.accepted, true);
  assert.ok(result.queriedChunkKeys.includes('0,0'));
  assert.equal(result.simulationTicket.residentReuseCount, 1);
  assert.equal(result.simulationTicket.queriedCount, result.queriedChunkKeys.length - 1);
  assert.equal(queried.length, result.simulationTicket.queriedCount);
  assert.ok(result.hitStableIds.includes(houseId));
  assert.equal(result.hitStableIds.includes(outsideId), false);
  assert.equal(fixture.state.isFeatureDestroyed(houseId), true);
  assert.equal(fixture.state.player.score > 100, true);
  assert.equal(fixture.state.player.hp > 50, true);
  assert.equal(fixture.state.nuclearCooldownMs, BOMB_COOLDOWN);
  assert.equal(fixture.runtime.snapshot().counts.nuclearChunksQueried, result.queriedChunkKeys.length);
  assert.equal(fixture.runtime.snapshot().simulationTickets.ticketCount, 0,
    'transient explosion ticket must be released after the world query completes');
  assert.equal(fixture.featureRenderer.refreshes, refreshesBeforeAttack,
    'Atomic must publish destruction deltas without a resident-wide refresh');
  assert.ok(fixture.featureRenderer.destroyedStableIds.includes(houseId));
  const events = fixture.runtime.consumePresentationEffects().events;
  assert.equal(events.some(event => event.type === 'nuclear-destruction'), true);
  assert.equal(events.some(event => event.type === 'finite-target-destruction'), true);

  const storage = new MemoryStorage();
  const store = new InfiniteWorldSaveStore({ storage, worldSeedHash });
  await store.save(fixture.state);
  const restored = new InfiniteWorldState({ worldSeedHash, playerSpawn: { x: 99, z: 99 } });
  await store.loadInto(restored);
  assert.equal(restored.isFeatureDestroyed(houseId), true);
  assert.equal(restored.player.score, fixture.state.player.score);
  assert.equal(restored.player.hp, fixture.state.player.hp);
  assert.equal(restored.nuclearCooldownMs, BOMB_COOLDOWN);

  assert.doesNotThrow(() => fixture.runtime.update({
    deltaSeconds: 1 / 60,
    player: fixture.state.player,
    simulationEnabled: false,
  }));
  await fixture.runtime.shutdown();
});

test('Atomic can destroy canonical World Objects far outside Player Near residency', async () => {
  const queried = [];
  const fixture = createRuntime({ query(chunkX, chunkZ) {
    queried.push(`${chunkX},${chunkZ}`);
    return syntheticChunk(chunkX, chunkZ);
  } });
  const impactX = 20 * 16 + 8;
  const impactZ = 8;
  const farHouseId = 'settlement-building-v1:nuclear:20,0';
  assert.equal(fixture.state.isFeatureDestroyed(farHouseId), false);

  const result = await fixture.runtime.nuclearAttack({
    x: impactX,
    z: impactZ,
    airborne: true,
  });

  assert.equal(result.accepted, true);
  assert.ok(result.queriedChunkKeys.includes('20,0'));
  assert.ok(result.hitStableIds.includes(farHouseId));
  assert.equal(fixture.state.isFeatureDestroyed(farHouseId), true);
  assert.ok(queried.includes('20,0'));
  assert.equal(fixture.runtime.snapshot().activeDataChunkCount, 0,
    'remote explosion must not turn offscreen query chunks into Player Near residency');
  assert.equal(fixture.runtime.snapshot().activeSimulationChunkCount, 0,
    'remote explosion must not render/simulate query chunks after the transient ticket closes');
  assert.equal(fixture.runtime.snapshot().simulationTickets.ticketCount, 0);

  const storage = new MemoryStorage();
  const store = new InfiniteWorldSaveStore({ storage, worldSeedHash });
  await store.save(fixture.state);
  const restored = new InfiniteWorldState({ worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  await store.loadInto(restored);
  assert.equal(restored.isFeatureDestroyed(farHouseId), true,
    'offscreen destruction must persist until the Player later visits that World Object');
  await fixture.runtime.shutdown();
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

test('GP-INPUT-02 disabled simulation freezes gameplay clocks, Boss AI and combat effects', async () => {
  const fixture = createRuntime();
  const spawned = await fixture.runtime.spawnManualBoss();
  const boss = fixture.state.entityStates.get(spawned.stableId);
  Object.assign(boss.bossBehavior, {
    phase: 'charge',
    phaseClock: 0.75,
    tailCooldownSeconds: 0.5,
  });
  fixture.state.updatePlayer({ acidDebuffSeconds: 1.1 });
  fixture.state.tickGameplayTime(1_234);
  fixture.state.setNuclearCooldown(4_321);
  await fixture.runtime.nuclearAttack({ x: 0, z: 0, airborne: true });

  const stateBefore = fixture.state.createSaveSnapshot();
  const runtimeBefore = fixture.runtime.snapshot();
  assert.ok(runtimeBefore.activeCombatEffectCount > 0);
  fixture.runtime.update({
    deltaSeconds: 0.05,
    player: fixture.state.player,
    simulationEnabled: false,
  });
  const runtimeAfter = fixture.runtime.snapshot();

  assert.deepEqual(fixture.state.createSaveSnapshot(), stateBefore);
  assert.equal(runtimeAfter.activeProjectileCount, runtimeBefore.activeProjectileCount);
  assert.equal(runtimeAfter.activeCombatEffectCount, runtimeBefore.activeCombatEffectCount);
  assert.deepEqual(runtimeAfter.counts, runtimeBefore.counts);
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

test('Boss sweep Tail uses finite radius, damage, knockback and cooldown exactly once', async () => {
  const fixture = createRuntime();
  const spawned = await fixture.runtime.spawnManualBoss();
  const boss = fixture.state.entityStates.get(spawned.stableId);
  Object.assign(boss, { x: 0, z: 0, rotationY: 0 });
  Object.assign(boss.bossBehavior, {
    phase: 'sweep', phaseClock: 0, tailCooldownSeconds: 0,
  });
  const tailDistance = finiteWorldUnitsToMeters(
    W8_BOSS_CONTRACT.tail.segmentSpacing * (W8_BOSS_CONTRACT.segmentCount - 1),
  );
  fixture.state.updatePlayer({ x: 0, z: -tailDistance });
  fixture.runtime.update({ deltaSeconds: 0.01, player: fixture.state.player });
  assert.equal(fixture.state.player.hp, 100 - W8_BOSS_CONTRACT.tail.damage);
  assert.ok(boss.bossBehavior.tailCooldownSeconds > 1.18);
  assert.ok(fixture.runtime.consumePresentationEffects().events.some(
    event => event.type === 'boss-tail-hit' && event.presentation.particleCount === 8,
  ));
  fixture.runtime.update({ deltaSeconds: 0.01, player: fixture.state.player });
  assert.equal(fixture.state.player.hp, 100 - W8_BOSS_CONTRACT.tail.damage,
    'Tail cooldown prevents a second contact hit');
  await fixture.runtime.shutdown();
});

test('GP-BOSS-01 exact tail-center hit applies one finite deterministic knockback and keeps updating', async () => {
  const first = await captureTailKnockback({ rotationY: 0 });
  const repeated = await captureTailKnockback({ rotationY: 0 });
  assert.equal(first.impactHp, first.hpBefore - W8_BOSS_CONTRACT.tail.damage);
  assert.equal(first.continuationHp, first.impactHp, 'continuation cannot apply Tail damage twice');
  assert.equal(first.impactHitCount, 1);
  assert.ok(first.tailCooldownSeconds > 1.19);
  assert.ok(first.displacement.z < 0, 'rotation zero pushes outward through the tail');
  assert.ok(Math.abs(first.displacement.x) < 1e-9);
  assert.deepEqual(first.displacement, repeated.displacement);
  assert.ok(Number.isFinite(first.player.x) && Number.isFinite(first.player.z));
});

test('GP-BOSS-01 epsilon tail distance uses facing fallback while normal distance is unchanged', async () => {
  const finiteFallbackDistanceMeters = finiteWorldUnitsToMeters(Math.sqrt(0.001));
  const epsilon = await captureTailKnockback({
    rotationY: 0,
    offsetX: finiteFallbackDistanceMeters * 0.5,
  });
  assert.ok(epsilon.displacement.z < 0);
  assert.ok(Math.abs(epsilon.displacement.x) < 1e-9,
    'finite-compatible epsilon must use the deterministic tail direction');

  const turned = await captureTailKnockback({ rotationY: Math.PI / 2 });
  assert.ok(turned.displacement.x < 0, 'Boss facing rotates the deterministic fallback');
  assert.ok(Math.abs(turned.displacement.z) < 1e-9);

  const normal = await captureTailKnockback({ rotationY: 0, offsetX: 0.1 });
  assert.ok(normal.displacement.x > 0, 'normal separation keeps the contact-vector direction');
  assert.ok(Math.abs(normal.displacement.z) < 1e-6);
});

test('Boss Breach landing applies World AoE, Player push, Scar and 15 hyper-rage Acid shots once', async () => {
  const fixture = createRuntime({ active: true });
  await fixture.initialize;
  const spawned = await fixture.runtime.spawnManualBoss();
  const boss = fixture.state.entityStates.get(spawned.stableId);
  Object.assign(boss, { x: 8, z: 8, rotationY: 0, hp: boss.maxHp * 0.2 });
  Object.assign(boss.bossBehavior, {
    phase: 'breach', phaseClock: 1, verticalOffset: 0.01, verticalVelocity: -1,
    targetX: 8, targetZ: 8, hyperRage: true, landingApplied: false,
  });
  fixture.state.updatePlayer({ x: 50, z: 8 });
  fixture.runtime.update({ deltaSeconds: 0.05, player: fixture.state.player });
  assert.equal(boss.bossBehavior.phase, 'recover');
  assert.equal(boss.bossBehavior.landingApplied, true);
  assert.equal(fixture.state.isFeatureDestroyed('settlement-building-v1:nuclear:0,0'), true);
  const events = fixture.runtime.consumePresentationEffects().events;
  assert.equal(events.filter(event => event.type === 'boss-landing').length, 1);
  assert.equal(events.filter(event => event.type === 'boss-landing-scar').length, 1);
  assert.equal(events.filter(event => event.type === 'boss-landing-acid').length,
    W8_BOSS_CONTRACT.landing.acidSprayCount);
  const pushedX = fixture.state.player.x;
  fixture.runtime.update({ deltaSeconds: 0.05, player: fixture.state.player });
  assert.ok(fixture.state.player.x > pushedX);
  assert.equal(fixture.runtime.consumePresentationEffects().events
    .filter(event => event.type === 'boss-landing').length, 0,
  'landing resolves only once');
  await fixture.runtime.shutdown();
});

test('Boss Acid uses finite flight, Player damage, 1.1 second debuff and movement multiplier', async () => {
  const fixture = createRuntime();
  const spawned = await fixture.runtime.spawnManualBoss();
  const boss = fixture.state.entityStates.get(spawned.stableId);
  Object.assign(boss, { x: 0, z: 0, rotationY: 0, aiClock: 0 });
  Object.assign(boss.bossBehavior, {
    phase: 'recover', phaseClock: 0, recoverSpitWindow: -1,
  });
  fixture.state.updatePlayer({ x: 0, z: 10 });
  fixture.runtime.update({ deltaSeconds: 0.05, player: fixture.state.player });
  fixture.runtime.update({ deltaSeconds: 0.05, player: fixture.state.player });
  assert.equal(fixture.state.player.hp, 100 - W8_BOSS_CONTRACT.acid.damage);
  assert.ok(fixture.runtime.snapshot().playerAcidDebuffSeconds > 1);
  assert.equal(fixture.runtime.getPlayerMovementMultiplier(),
    W8_BOSS_CONTRACT.acid.movementMultiplier);
  assert.ok(fixture.runtime.consumePresentationEffects().events.some(
    event => event.type === 'acid-impact' && event.presentation.acidCount === 12,
  ));
  for (let index = 0; index < 23; index += 1) {
    fixture.runtime.update({ deltaSeconds: 0.05, player: fixture.state.player });
  }
  assert.equal(fixture.runtime.getPlayerMovementMultiplier(), 1);
  await fixture.runtime.shutdown();
});

test('Boss defeat emits the finite death cloud and advances the next score threshold', async () => {
  const fixture = createRuntime();
  const spawned = await fixture.runtime.spawnManualBoss();
  const result = fixture.runtime.applyCombatDamage(spawned.stableId,
    W6_ENTITY_CONTRACTS.boss.maxHp, { awardPlayerCredit: true });
  assert.equal(result.justDestroyed, true);
  assert.equal(fixture.state.combatProgress.bossesDefeated, 1);
  assert.equal(fixture.state.combatProgress.nextBossScore,
    fixture.state.player.score + W8_BOSS_CONTRACT.nextSpawnScoreDelta);
  const death = fixture.runtime.consumePresentationEffects().events.find(
    event => event.type === 'nuclear-boss-death');
  assert.ok(death);
  assert.equal(death.soundCue, 'atomic');
  assert.ok(death.presentation.segmentCount > 0);
  await fixture.runtime.shutdown();
});
