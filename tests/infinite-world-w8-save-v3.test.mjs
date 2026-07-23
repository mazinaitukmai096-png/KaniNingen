import test from 'node:test';
import assert from 'node:assert/strict';

import {
  W6_ENTITY_CONTRACTS,
  W8_GAMEPLAY_SCHEMA,
  W8_LEGACY_GAMEPLAY_SCHEMA,
  W8_LEGACY_SAVE_SCHEMA,
  W8_LEGACY_SAVE_SCHEMA_VERSION,
  W8_SAVE_ENVELOPE_SCHEMA,
  W8_SAVE_SCHEMA,
  W8_SAVE_SCHEMA_VERSION,
} from '../src/infinite-world/gameplay-contract.js';
import {
  InfiniteWorldState,
  decodeInfiniteWorldSave,
  encodeInfiniteWorldSave,
} from '../src/infinite-world/world-state-store.js';

const worldSeed = 'W8 save seed';
const worldSeedHash = `sha256:${'8'.repeat(64)}`;

function bossRecord() {
  return {
    stableId: 'wf1:boss:w8-save', ownerChunkKey: '0,0', type: 'boss',
    maxHp: W6_ENTITY_CONTRACTS.boss.maxHp, x: 4, z: 5, rotationY: 0, aiState: 'slither',
  };
}

test('schema v4 persists combat progression, gameplay clock, Tank lifecycle, full Boss behavior and Developer Tools', async () => {
  const state = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 1, z: 2 } });
  state.setDeveloperTools(true);
  state.updateCombatProgress({ nextBossScore: 91_000, bossesDefeated: 2, attacksIssued: 11, damageDealt: 7200 });
  state.nextTankReinforcementSequence();
  state.tickGameplayTime(4_250);
  const tank = state.ensureEntity({
    stableId: 'wf1:tank:w8-save', ownerChunkKey: '0,0', type: 'tank',
    maxHp: W6_ENTITY_CONTRACTS.tank.maxHp, x: 7, z: 8, rotationY: 0.2,
    aiState: 'acquire', spawned: true, lastShotAtMs: 4_000,
  });
  tank.gunPitch = 0.15;
  const boss = state.ensureEntity(bossRecord());
  boss.bossBehavior.phase = 'dig';
  boss.bossBehavior.phaseClock = 2.25;
  boss.bossBehavior.segmentHp[13] = 0;
  state.setManualBoss(boss.stableId, 1);

  const serialized = await encodeInfiniteWorldSave(state.createSaveSnapshot());
  const envelope = JSON.parse(serialized);
  assert.equal(envelope.schemaVersion, W8_SAVE_ENVELOPE_SCHEMA);
  assert.equal(envelope.payload.schemaVersion, W8_SAVE_SCHEMA);
  assert.equal(envelope.payload.schemaVersionNumber, W8_SAVE_SCHEMA_VERSION);
  assert.equal(envelope.payload.gameplaySchemaVersion, W8_GAMEPLAY_SCHEMA);

  const restored = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  restored.restoreSaveSnapshot(await decodeInfiniteWorldSave(serialized, { worldSeedHash }));
  assert.deepEqual(restored.createSaveSnapshot(), state.createSaveSnapshot());
  assert.equal(restored.developerTools, true);
  assert.equal(restored.entityStates.get(boss.stableId).bossBehavior.phase, 'dig');
  assert.equal(restored.entityStates.get(boss.stableId).bossBehavior.segmentHp[13], 0);
  assert.equal(restored.gameplayTimeMs, 4_250);
  assert.equal(restored.entityStates.get(tank.stableId).spawned, true);
  assert.equal(restored.entityStates.get(tank.stableId).lastShotAtMs, 4_000);
});

test('schema v3 migrates once to v4, reacquires persisted Tanks, and supplies lifecycle defaults', async () => {
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

test('invalid v4 data validates in a temporary candidate and never mutates live state', () => {
  const state = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 7, z: 9 } });
  state.updatePlayer({ score: 321 });
  const before = state.createSaveSnapshot();
  const invalid = structuredClone(before);
  invalid.combatProgress.nextBossScore = -1;
  assert.throws(() => state.restoreSaveSnapshot(invalid), /combatProgress.nextBossScore/);
  assert.deepEqual(state.createSaveSnapshot(), before);
});
