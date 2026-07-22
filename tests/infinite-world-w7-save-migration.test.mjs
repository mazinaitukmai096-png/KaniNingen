import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  W6_ENTITY_CONTRACTS,
  W6_GAMEPLAY_SCHEMA,
  W6_SAVE_ENVELOPE_SCHEMA,
  W6_SAVE_SCHEMA,
  W6_SAVE_VERSION,
  W7_GAMEPLAY_SCHEMA,
  W7_SAVE_ENVELOPE_SCHEMA,
  W7_SAVE_SCHEMA,
  W7_SAVE_SCHEMA_VERSION,
} from '../src/infinite-world/gameplay-contract.js';
import {
  InfiniteWorldSaveStore,
  InfiniteWorldState,
  decodeInfiniteWorldSave,
  encodeInfiniteWorldSave,
} from '../src/infinite-world/world-state-store.js';

const repoRoot = resolve(import.meta.dirname, '..');
const worldSeed = 'W7E migration seed';
const worldSeedHash = `sha256:${'7'.repeat(64)}`;

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

function entityRecord(type, suffix, overrides = {}) {
  const contract = W6_ENTITY_CONTRACTS[type];
  return {
    stableId: `wf1:${type}:${suffix}`,
    ownerChunkKey: '0,0',
    type,
    maxHp: contract.maxHp,
    hp: contract.maxHp,
    alive: true,
    x: 4,
    z: 5,
    rotationY: 0,
    aiState: 'idle',
    aiClock: 0,
    ...overrides,
  };
}

function legacyW6Payload(overrides = {}) {
  return {
    schemaVersion: W6_SAVE_SCHEMA,
    gameplaySchemaVersion: W6_GAMEPLAY_SCHEMA,
    saveVersion: W6_SAVE_VERSION,
    worldSeedHash,
    activeScaleStageId: 'MID',
    player: { x: 11, z: -12, hp: 73, maxHp: 100, score: 2400, facingY: 0.4 },
    featureDamage: [{ stableId: 'wf1:tree:legacy', maxHp: 80, damage: 80, destroyed: true }],
    entityStates: [entityRecord('human', 'legacy', { hp: 17 })],
    ...overrides,
  };
}

test('W7E schema v2 round-trips the complete experience through the existing save store', async () => {
  const storage = new MemoryStorage();
  const state = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 1, z: 2 } });
  state.setScaleStage('TINY');
  state.updatePlayer({ x: 33, z: -17, hp: 64, score: 9800, facingY: 1.25 });
  state.damageFeature({ stableId: 'wf1:house:w7e', maxHp: 300 }, 300);
  const boss = state.ensureEntity(entityRecord('boss', 'manual:1', { ownerChunkKey: '2,-2', x: 34, z: -18 }));
  state.damageEntity(boss.stableId, 8000);
  state.setManualBoss(boss.stableId, 1);
  state.setNuclearCooldown(4321);
  state.updateExperience({
    hudHidden: true,
    settings: {
      mouseSensitivity: 1.7, volume: 0.25, quality: 'medium', showFps: true,
      fpsCap: 60, cameraShake: 0.6,
    },
  });

  const store = new InfiniteWorldSaveStore({ storage, worldSeedHash });
  const serialized = await store.save(state);
  const envelope = JSON.parse(serialized);
  assert.equal(envelope.schemaVersion, W7_SAVE_ENVELOPE_SCHEMA);
  assert.equal(envelope.payload.schemaVersion, W7_SAVE_SCHEMA);
  assert.equal(envelope.payload.schemaVersionNumber, W7_SAVE_SCHEMA_VERSION);
  assert.equal(envelope.payload.gameplaySchemaVersion, W7_GAMEPLAY_SCHEMA);
  assert.equal(envelope.payload.worldSeed, worldSeed);

  const restored = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  await store.loadInto(restored);
  assert.deepEqual(restored.createSaveSnapshot(), state.createSaveSnapshot());
  assert.deepEqual(restored.experience, state.experience);
});

test('an original W6 save migrates atomically with defaults and discards legacy natural Boss state', async () => {
  const naturalBoss = entityRecord('boss', 'legacy-natural');
  const legacy = legacyW6Payload({
    entityStates: [entityRecord('human', 'legacy'), naturalBoss],
  });
  const serialized = await encodeInfiniteWorldSave(legacy);
  assert.equal(JSON.parse(serialized).schemaVersion, W6_SAVE_ENVELOPE_SCHEMA);
  const decoded = await decodeInfiniteWorldSave(serialized, { worldSeedHash });
  const state = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  state.restoreSaveSnapshot(decoded);

  const migrated = state.createSaveSnapshot();
  assert.equal(migrated.schemaVersion, W7_SAVE_SCHEMA);
  assert.equal(migrated.worldSeed, worldSeed);
  assert.equal(migrated.activeScaleStageId, 'MID');
  assert.equal(state.isFeatureDestroyed('wf1:tree:legacy'), true);
  assert.equal(state.entityStates.has(naturalBoss.stableId), false);
  assert.equal(state.entityStates.has('wf1:human:legacy'), true);
  assert.equal(state.manualBossStableId, null);
  assert.equal(state.nuclearCooldownMs, 0);
  assert.deepEqual(state.experience, {
    hudHidden: false,
    settings: {
      mouseSensitivity: 1, volume: 0.5, quality: 'high', showFps: false,
      fpsCap: 0, cameraShake: 1,
    },
  });
});

test('the W7D-era W6 payload preserves only its referenced manual Boss and Nuclear cooldown', () => {
  const boss = entityRecord('boss', 'manual:3', { hp: 51000 });
  const naturalBoss = entityRecord('boss', 'legacy-natural');
  const state = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  state.restoreSaveSnapshot(legacyW6Payload({
    entityStates: [boss, naturalBoss],
    manualBossStableId: boss.stableId,
    manualBossSequence: 3,
    nuclearCooldownMs: 1234,
  }));
  assert.equal(state.manualBossStableId, boss.stableId);
  assert.equal(state.manualBossSequence, 3);
  assert.equal(state.entityStates.get(boss.stableId).hp, 51000);
  assert.equal(state.entityStates.has(naturalBoss.stableId), false);
  assert.equal(state.nuclearCooldownMs, 1234);
});

test('checksum, Stable ID, numeric range and settings failures never partially mutate live state', async () => {
  const storage = new MemoryStorage();
  const store = new InfiniteWorldSaveStore({ storage, worldSeedHash });
  const live = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 8, z: 9 } });
  live.updatePlayer({ score: 321 });
  const before = live.createSaveSnapshot();

  const validSerialized = await encodeInfiniteWorldSave(before);
  const corrupt = JSON.parse(validSerialized);
  corrupt.payload.player.score += 1;
  storage.setItem(store.key, JSON.stringify(corrupt));
  await assert.rejects(() => store.loadInto(live), /checksum mismatch/);
  assert.deepEqual(live.createSaveSnapshot(), before);

  for (const [mutate, expected] of [
    [payload => { payload.player.hp = 101; }, /exceeds player.maxHp/],
    [payload => { payload.experience.settings.volume = 2; }, /outside its supported range/],
    [payload => { payload.entityStates = [entityRecord('human', 'bad')]; payload.entityStates[0].stableId = 'invalid'; }, /Gameplay contract mismatch/],
    [payload => {
      payload.entityStates = [entityRecord('human', 'collision')];
      payload.featureDamage = [{
        stableId: 'wf1:human:collision', maxHp: 80, damage: 1, destroyed: false,
      }];
    }, /collision between feature and entity state/],
  ]) {
    const invalid = structuredClone(before);
    mutate(invalid);
    storage.setItem(store.key, await encodeInfiniteWorldSave(invalid));
    await assert.rejects(() => store.loadInto(live), expected);
    assert.deepEqual(live.createSaveSnapshot(), before);
  }
});

test('schema, envelope and actual World Seed checks reject incompatible saves before apply', async () => {
  const state = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  const before = state.createSaveSnapshot();
  const wrongSeed = structuredClone(before);
  wrongSeed.worldSeed = 'different logical seed';
  assert.throws(() => state.restoreSaveSnapshot(wrongSeed), /seed does not match/);
  assert.deepEqual(state.createSaveSnapshot(), before);

  await assert.rejects(() => encodeInfiniteWorldSave({ schemaVersion: 'unknown' }), /unsupported/);
  const wrongEnvelope = JSON.parse(await encodeInfiniteWorldSave(before));
  wrongEnvelope.schemaVersion = W6_SAVE_ENVELOPE_SCHEMA;
  await assert.rejects(
    () => decodeInfiniteWorldSave(JSON.stringify(wrongEnvelope), { worldSeedHash }),
    /invalid Infinite World save envelope/,
  );
  assert.deepEqual(state.createSaveSnapshot(), before);
});

test('W7E extends one World State, one entity registry and one save system', () => {
  const stateSource = readFileSync(resolve(repoRoot, 'src/infinite-world/world-state-store.js'), 'utf8');
  const runtimeSource = readFileSync(resolve(repoRoot, 'src/infinite-world/gameplay-runtime.js'), 'utf8');
  const bootSource = readFileSync(resolve(repoRoot, 'src/infinite-world/sandbox-boot.js'), 'utf8');
  assert.equal((stateSource.match(/export class InfiniteWorldState/g) ?? []).length, 1);
  assert.equal((stateSource.match(/export class InfiniteWorldSaveStore/g) ?? []).length, 1);
  assert.equal((stateSource.match(/this\.entityStates = new Map\(\)/g) ?? []).length, 1);
  assert.match(runtimeSource, /this\.state = state/);
  assert.match(bootSource, /saveStoreFactory = options => new InfiniteWorldSaveStore\(options\)/);
  assert.doesNotMatch(bootSource, /src\/game\.js/);
});

test('official Infinite entry and protected finite regression entry remain distinct', () => {
  const infiniteEntry = readFileSync(resolve(repoRoot, 'infinite-world-sandbox.html'), 'utf8');
  const finiteEntry = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
  const runtimeDoc = readFileSync(resolve(repoRoot, 'docs/infinite-world/RUNTIME-ENTRY.md'), 'utf8');
  assert.match(infiniteEntry, /sandbox-entry\.js\?v=w7-full-experience/);
  assert.doesNotMatch(infiniteEntry, /src\/game\.js/);
  assert.match(finiteEntry, /src\/game\.js/);
  assert.match(runtimeDoc, /schema version 2/);
  assert.match(runtimeDoc, /read compatibility with W6 saves/);
});
