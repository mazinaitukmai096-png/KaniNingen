import test from 'node:test';
import assert from 'node:assert/strict';

import {
  W6_ENTITY_CONTRACTS,
  W6_STATIC_TARGET_CONTRACTS,
  W8_GAMEPLAY_SCHEMA,
  W8_LEGACY_GAMEPLAY_SCHEMA,
  W8_LEGACY_SAVE_SCHEMA,
  W8_LEGACY_SAVE_SCHEMA_VERSION,
  W8_SAVE_ENVELOPE_SCHEMA,
  W8_SAVE_SCHEMA,
  W8_SAVE_SCHEMA_VERSION,
  W8_V4_GAMEPLAY_SCHEMA,
  W8_V4_SAVE_ENVELOPE_SCHEMA,
  W8_V4_SAVE_SCHEMA,
  W8_V4_SAVE_SCHEMA_VERSION,
} from '../src/infinite-world/gameplay-contract.js';
import {
  InfiniteWorldState,
  decodeInfiniteWorldSave,
  encodeInfiniteWorldSave,
} from '../src/infinite-world/world-state-store.js';

const worldSeed = 'W8 save seed';
const worldSeedHash = `sha256:${'8'.repeat(64)}`;
const SAVE_V5_FIELDS = [
  'activeScaleStageId', 'combatProgress', 'developerTools', 'entityStates', 'experience',
  'featureDamage', 'gameplaySchemaVersion', 'gameplayTimeMs', 'legacySaveVersion',
  'manualBossSequence', 'manualBossStableId', 'nuclearCooldownMs', 'player', 'schemaVersion',
  'schemaVersionNumber', 'tankReinforcementSequence', 'worldSeed', 'worldSeedHash',
].sort();
const TANK_SAVE_FIELDS = [
  'aiClock', 'aiState', 'alive', 'avoidAngle', 'baseX', 'baseZ', 'fireSequence', 'gunPitch',
  'hp', 'lastShotAtMs', 'lastX', 'lastZ', 'maxHp', 'ownerChunkKey',
  'reinforcementSequence', 'rotationY', 'spawned', 'stableId', 'stuckCheckClock',
  'stuckRemainingSeconds', 'turretRotationY', 'type', 'x', 'z',
].sort();

function bossRecord() {
  return {
    stableId: 'wf1:boss:w8-save', ownerChunkKey: '0,0', type: 'boss',
    maxHp: W6_ENTITY_CONTRACTS.boss.maxHp, x: 4, z: 5, rotationY: 0, aiState: 'slither',
  };
}

test('schema v5 persists Player debuff, Human behavior, Boss sequence, Tank lifecycle and experience', async () => {
  const state = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 1, z: 2 } });
  state.setDeveloperTools(true);
  state.updateCombatProgress({ nextBossScore: 91_000, bossesDefeated: 2, attacksIssued: 11, damageDealt: 7200 });
  state.nextTankReinforcementSequence();
  state.tickGameplayTime(4_250);
  state.updatePlayer({ acidDebuffSeconds: 0.75 });
  const human = state.ensureEntity({
    stableId: 'wf1:human:w8-save', ownerChunkKey: '0,0', type: 'human',
    maxHp: W6_ENTITY_CONTRACTS.human.maxHp, x: 2, z: 3, rotationY: 0.1,
    aiState: 'flee',
  });
  Object.assign(human, {
    knockdownSeconds: 0.4, humanTimer: 1.5, wiggleTime: 0.2, tripTimer: 0.7,
    idleWaitTimer: 0.3, fleeAngleOffset: -0.25, waterAvoidTimer: 0.6,
    waterAvoidX: 1, waterAvoidZ: -1, targetBuildingStableId: 'wf1:house:target',
    humanRandomSequence: 8,
  });
  const tank = state.ensureEntity({
    stableId: 'wf1:tank:w8-save', ownerChunkKey: '0,0', type: 'tank',
    maxHp: W6_ENTITY_CONTRACTS.tank.maxHp, x: 7, z: 8, rotationY: 0.2,
    aiState: 'acquire', spawned: true, baseX: 6.5, baseZ: 8.5, lastShotAtMs: 4_000,
  });
  state.damageEntity(tank.stableId, 37);
  Object.assign(tank, {
    x: 7.25,
    z: 8.75,
    rotationY: -0.45,
    turretRotationY: 0.85,
    gunPitch: 0.15,
    aiState: 'avoid',
    aiClock: 1.75,
    fireSequence: 9,
    stuckCheckClock: 0.65,
    stuckRemainingSeconds: 0.4,
    avoidAngle: -1.2,
    lastX: 7.1,
    lastZ: 8.6,
  });
  const boss = state.ensureEntity(bossRecord());
  boss.bossBehavior.phase = 'dig';
  boss.bossBehavior.phaseClock = 2.25;
  boss.bossBehavior.segmentHp[13] = 0;
  Object.assign(boss.bossBehavior, {
    tailCooldownSeconds: 0.8, tailX: 9, tailZ: 10, phaseSequence: 4,
    lastPick: 'charge', phaseDurationSeconds: 1.2, landingApplied: true,
    recoverSpitWindow: 2, recoverStarAccumulator: 0.5,
    slitherAcidDecisionSequence: 6,
  });
  state.setManualBoss(boss.stableId, 1);

  const serialized = await encodeInfiniteWorldSave(state.createSaveSnapshot());
  const envelope = JSON.parse(serialized);
  assert.equal(envelope.schemaVersion, W8_SAVE_ENVELOPE_SCHEMA);
  assert.equal(envelope.payload.schemaVersion, W8_SAVE_SCHEMA);
  assert.equal(envelope.payload.schemaVersionNumber, W8_SAVE_SCHEMA_VERSION);
  assert.equal(envelope.payload.gameplaySchemaVersion, W8_GAMEPLAY_SCHEMA);
  assert.deepEqual(Object.keys(envelope.payload).sort(), SAVE_V5_FIELDS);
  const savedTank = envelope.payload.entityStates.find(entity => entity.stableId === tank.stableId);
  assert.deepEqual(Object.keys(savedTank).sort(), TANK_SAVE_FIELDS);
  assert.equal(Object.keys(savedTank).length, 24);

  const restored = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  restored.restoreSaveSnapshot(await decodeInfiniteWorldSave(serialized, { worldSeedHash }));
  assert.deepEqual(restored.createSaveSnapshot(), state.createSaveSnapshot());
  assert.equal(restored.developerTools, true);
  assert.equal(restored.entityStates.get(boss.stableId).bossBehavior.phase, 'dig');
  assert.equal(restored.entityStates.get(boss.stableId).bossBehavior.segmentHp[13], 0);
  assert.equal(restored.entityStates.get(boss.stableId).bossBehavior.landingApplied, true);
  assert.equal(restored.entityStates.get(human.stableId).targetBuildingStableId, 'wf1:house:target');
  assert.equal(restored.player.acidDebuffSeconds, 0.75);
  assert.equal(restored.gameplayTimeMs, 4_250);
  assert.equal(restored.entityStates.get(tank.stableId).spawned, true);
  assert.equal(restored.entityStates.get(tank.stableId).lastShotAtMs, 4_000);
  assert.deepEqual(restored.entityStates.get(tank.stableId), savedTank);
});

test('empty base Tank slots round-trip and legacy spawned dead slots hydrate as rearmable empties', () => {
  const source = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  const slot = source.ensureEntity({
    stableId: 'wf1:tank:w8-empty-slot', ownerChunkKey: '2,-1', type: 'tank',
    maxHp: W6_ENTITY_CONTRACTS.tank.maxHp, x: 12, z: -4, rotationY: 0.3,
    aiState: 'destroyed', spawned: true, reinforcementSequence: 0,
  });
  source.damageEntity(slot.stableId, slot.maxHp);
  const legacySpawnedDead = source.createSaveSnapshot();
  assert.equal(legacySpawnedDead.entityStates[0].spawned, true);

  const restored = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  restored.restoreSaveSnapshot(legacySpawnedDead);
  const emptySlot = restored.entityStates.get(slot.stableId);
  assert.equal(emptySlot.hp, 0);
  assert.equal(emptySlot.alive, false);
  assert.equal(emptySlot.spawned, false);
  assert.equal(restored.snapshot().entityStateCount, 1);
  assert.equal(restored.snapshot().destroyedEntityCount, 0);

  const continued = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  continued.restoreSaveSnapshot(restored.createSaveSnapshot());
  assert.deepEqual(continued.entityStates.get(slot.stableId), emptySlot);
  assert.equal(continued.snapshot().destroyedEntityCount, 0);
});

test('fallback hydration prunes tombstones, preserves the sequence, rejects ID reuse, and supports removal', () => {
  const source = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  for (let sequence = 1; sequence <= 5; sequence += 1) source.nextTankReinforcementSequence();
  const active = source.ensureEntity({
    stableId: 'wf1:tank:w8-tank-reinforcement:3', ownerChunkKey: '0,0', type: 'tank',
    maxHp: W6_ENTITY_CONTRACTS.tank.maxHp, x: 3, z: 3, rotationY: 0,
    aiState: 'engage', spawned: true, reinforcementSequence: 3,
  });
  const dead = source.ensureEntity({
    stableId: 'wf1:tank:w8-tank-reinforcement:4', ownerChunkKey: '0,0', type: 'tank',
    maxHp: W6_ENTITY_CONTRACTS.tank.maxHp, x: 4, z: 4, rotationY: 0,
    aiState: 'destroyed', spawned: true, reinforcementSequence: 4,
  });
  source.damageEntity(dead.stableId, dead.maxHp);
  const inactive = source.ensureEntity({
    stableId: 'wf1:tank:w8-tank-reinforcement:5', ownerChunkKey: '0,0', type: 'tank',
    maxHp: W6_ENTITY_CONTRACTS.tank.maxHp, x: 5, z: 5, rotationY: 0,
    aiState: 'reserve', spawned: false, reinforcementSequence: 5,
  });
  const saved = source.createSaveSnapshot();

  const invalid = structuredClone(saved);
  invalid.tankReinforcementSequence = dead.reinforcementSequence;
  assert.ok(invalid.tankReinforcementSequence >= active.reinforcementSequence);
  assert.ok(invalid.tankReinforcementSequence < inactive.reinforcementSequence);
  const untouched = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 9, z: 9 } });
  const before = untouched.createSaveSnapshot();
  assert.throws(
    () => untouched.restoreSaveSnapshot(invalid),
    /lower than a fallback Tank sequence/,
  );
  assert.deepEqual(untouched.createSaveSnapshot(), before);

  const restored = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  restored.restoreSaveSnapshot(saved);
  assert.equal(restored.entityStates.has(active.stableId), true);
  assert.equal(restored.entityStates.has(dead.stableId), false);
  assert.equal(restored.entityStates.has(inactive.stableId), false);
  assert.equal(restored.tankReinforcementSequence, 5);
  assert.equal(restored.removeEntity(active.stableId), true);
  assert.equal(restored.entityStates.has(active.stableId), false);
  assert.equal(restored.nextTankReinforcementSequence(), 6);
});

test('legacy Military Base damage reconciliation keeps destroyed state and partial absolute damage', () => {
  const destroyedStableId = 'wf1:settlement-landmark:w8-destroyed-base';
  const partialStableId = 'wf1:settlement-landmark:w8-partial-base';
  const state = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  const saved = state.createSaveSnapshot();
  saved.featureDamage = [{
    stableId: destroyedStableId,
    maxHp: W6_STATIC_TARGET_CONTRACTS.house.maxHp,
    damage: W6_STATIC_TARGET_CONTRACTS.house.maxHp,
    destroyed: true,
  }, {
    stableId: partialStableId,
    maxHp: W6_STATIC_TARGET_CONTRACTS.house.maxHp,
    damage: 120,
    destroyed: false,
  }];
  state.restoreSaveSnapshot(saved);

  const destroyed = state.reconcileFeatureDamage({
    stableId: destroyedStableId,
    type: 'militaryBase',
    maxHp: W6_STATIC_TARGET_CONTRACTS.militaryBase.maxHp,
  });
  assert.deepEqual(destroyed, {
    stableId: destroyedStableId,
    maxHp: W6_STATIC_TARGET_CONTRACTS.militaryBase.maxHp,
    damage: W6_STATIC_TARGET_CONTRACTS.militaryBase.maxHp,
    destroyed: true,
  });

  const partial = state.reconcileFeatureDamage({
    stableId: partialStableId,
    type: 'militaryBase',
    maxHp: W6_STATIC_TARGET_CONTRACTS.militaryBase.maxHp,
  });
  assert.equal(partial.maxHp, W6_STATIC_TARGET_CONTRACTS.militaryBase.maxHp);
  assert.equal(partial.damage, 120);
  assert.equal(partial.destroyed, false);
  assert.equal(state.featureHp(partialStableId, partial.maxHp), partial.maxHp - 120);
});

test('schema v3 migrates once to v5, reacquires persisted Tanks, and supplies lifecycle defaults', async () => {
  const source = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 1, z: 2 } });
  source.ensureEntity({
    stableId: 'wf1:tank:w8-v3', ownerChunkKey: '0,0', type: 'tank',
    maxHp: W6_ENTITY_CONTRACTS.tank.maxHp, x: 3, z: 4, rotationY: 0.5, aiState: 'hold',
  });
  const legacy = source.createSaveSnapshot();
  legacy.schemaVersion = W8_LEGACY_SAVE_SCHEMA;
  legacy.schemaVersionNumber = W8_LEGACY_SAVE_SCHEMA_VERSION;
  legacy.gameplaySchemaVersion = W8_LEGACY_GAMEPLAY_SCHEMA;
  delete legacy.gameplayTimeMs;
  for (const entity of legacy.entityStates) {
    if (entity.type !== 'tank') continue;
    for (const field of ['spawned', 'baseX', 'baseZ', 'lastShotAtMs', 'gunPitch',
      'stuckCheckClock', 'stuckRemainingSeconds', 'avoidAngle', 'lastX', 'lastZ']) delete entity[field];
  }
  const restored = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  restored.restoreSaveSnapshot(await decodeInfiniteWorldSave(
    await encodeInfiniteWorldSave(legacy),
    { worldSeedHash },
  ));
  const tank = restored.entityStates.get('wf1:tank:w8-v3');
  assert.equal(restored.createSaveSnapshot().schemaVersion, W8_SAVE_SCHEMA);
  assert.equal(restored.gameplayTimeMs, 0);
  assert.equal(tank.spawned, true);
  assert.equal(tank.aiState, 'hold');
  assert.equal(tank.baseX, 3);
  assert.equal(tank.lastShotAtMs, 0);
});

test('v4 migrates once to v5 with neutral Player, Human, and Boss parity state', async () => {
  const source = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 1, z: 2 } });
  source.ensureEntity({
    stableId: 'wf1:human:w8-v4', ownerChunkKey: '0,0', type: 'human',
    maxHp: W6_ENTITY_CONTRACTS.human.maxHp, x: 2, z: 3, rotationY: 0, aiState: 'idle',
  });
  source.ensureEntity(bossRecord());
  const legacy = source.createSaveSnapshot();
  legacy.schemaVersion = W8_V4_SAVE_SCHEMA;
  legacy.schemaVersionNumber = W8_V4_SAVE_SCHEMA_VERSION;
  legacy.gameplaySchemaVersion = W8_V4_GAMEPLAY_SCHEMA;
  delete legacy.player.acidDebuffSeconds;
  for (const entity of legacy.entityStates) {
    if (entity.type === 'human') {
      for (const field of ['knockdownSeconds', 'humanTimer', 'wiggleTime', 'tripTimer',
        'idleWaitTimer', 'fleeAngleOffset', 'waterAvoidTimer', 'waterAvoidX', 'waterAvoidZ',
        'targetBuildingStableId', 'humanRandomSequence']) delete entity[field];
    }
    if (entity.type === 'boss') {
      for (const field of ['tailCooldownSeconds', 'tailX', 'tailZ', 'phaseSequence', 'lastPick',
        'phaseDurationSeconds', 'landingApplied', 'recoverSpitWindow', 'recoverStarAccumulator',
        'slitherAcidDecisionSequence']) delete entity.bossBehavior[field];
    }
  }
  const serialized = await encodeInfiniteWorldSave(legacy);
  assert.equal(JSON.parse(serialized).schemaVersion, W8_V4_SAVE_ENVELOPE_SCHEMA);
  const restored = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  restored.restoreSaveSnapshot(await decodeInfiniteWorldSave(serialized, { worldSeedHash }));
  assert.equal(restored.createSaveSnapshot().schemaVersion, W8_SAVE_SCHEMA);
  assert.equal(restored.player.acidDebuffSeconds, 0);
  assert.equal(restored.entityStates.get('wf1:human:w8-v4').humanRandomSequence, 0);
  assert.equal(restored.entityStates.get('wf1:boss:w8-save').bossBehavior.recoverSpitWindow, -1);
});

test('incomplete v5 data validates in a temporary candidate and never mutates live state', () => {
  const state = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 7, z: 9 } });
  state.updatePlayer({ score: 321 });
  const before = state.createSaveSnapshot();
  const invalid = structuredClone(before);
  invalid.combatProgress.nextBossScore = -1;
  assert.throws(() => state.restoreSaveSnapshot(invalid), /combatProgress.nextBossScore/);
  assert.deepEqual(state.createSaveSnapshot(), before);

  const incomplete = structuredClone(before);
  delete incomplete.player.acidDebuffSeconds;
  assert.throws(() => state.restoreSaveSnapshot(incomplete), /player.acidDebuffSeconds is required/);
  assert.deepEqual(state.createSaveSnapshot(), before);
});
