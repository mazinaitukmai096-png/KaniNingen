import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { W6_ENTITY_CONTRACTS } from '../src/infinite-world/gameplay-contract.js';
import {
  decodeInfiniteWorldSave,
  InfiniteWorldSaveStore,
  InfiniteWorldState,
} from '../src/infinite-world/world-state-store.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worldSeedHash = `sha256:${'9'.repeat(64)}`;

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

class DeferredWriteStorage {
  constructor() {
    this.values = new Map();
    this.calls = [];
    this.active = 0;
    this.maximumActive = 0;
  }

  getItem(key) { return this.values.get(key) ?? null; }

  async setItem(key, value) {
    const gate = deferred();
    const call = { key, value, gate, settled: false };
    this.calls.push(call);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await gate.promise;
      this.values.set(key, value);
    } finally {
      this.active -= 1;
      call.settled = true;
    }
  }

  release(index) {
    const call = this.calls[index];
    assert.ok(call, `storage call ${index} has not started`);
    call.gate.resolve();
  }

  fail(index, error) {
    const call = this.calls[index];
    assert.ok(call, `storage call ${index} has not started`);
    call.gate.reject(error);
  }
}

async function waitForStorageCalls(storage, count) {
  for (let attempt = 0; attempt < 200 && storage.calls.length < count; attempt += 1) {
    await new Promise(resolveValue => setImmediate(resolveValue));
  }
  assert.equal(storage.calls.length, count, `expected ${count} storage calls`);
}

function createFixture({ measure } = {}) {
  const storage = new DeferredWriteStorage();
  const state = new InfiniteWorldState({
    worldSeed: 'GP-SAVE-01 queue test',
    worldSeedHash,
    playerSpawn: { x: 0, z: 0 },
  });
  const store = new InfiniteWorldSaveStore({ storage, worldSeedHash, ...(measure ? { measure } : {}) });
  return { state, storage, store };
}

async function completeTwoGenerationScenario({ firstPatch, latestPatch }) {
  const { state, storage, store } = createFixture();
  state.updatePlayer(firstPatch);
  const firstRevision = state.revision;
  const firstSave = store.saveWithMetadata(state);
  await waitForStorageCalls(storage, 1);

  state.updatePlayer(latestPatch);
  const latestRevision = state.revision;
  const expected = state.createSaveSnapshot();
  const latestSave = store.saveWithMetadata(state);
  await new Promise(resolveValue => setImmediate(resolveValue));

  assert.equal(storage.calls.length, 1, 'a newer Save must not start a parallel storage write');
  assert.equal(storage.maximumActive, 1);
  storage.release(0);
  await waitForStorageCalls(storage, 2);
  storage.release(1);

  const [firstResult, latestResult] = await Promise.all([firstSave, latestSave]);
  const stored = await decodeInfiniteWorldSave(storage.getItem(store.key), { worldSeedHash });
  assert.equal(firstResult.generation, 1);
  assert.equal(firstResult.revision, firstRevision);
  assert.equal(latestResult.generation, 2);
  assert.equal(latestResult.revision, latestRevision);
  assert.deepEqual(stored, expected);
  assert.equal(storage.maximumActive, 1);
}

test('GP-SAVE-01 serializes autosave then manual Save and persists the manual snapshot last', async () => {
  await completeTwoGenerationScenario({
    firstPatch: { score: 100, x: 10 },
    latestPatch: { score: 200, x: 20 },
  });
});

test('GP-SAVE-01 serializes manual Save then autosave and persists the autosave snapshot last', async () => {
  await completeTwoGenerationScenario({
    firstPatch: { score: 300, z: 30 },
    latestPatch: { score: 400, z: 40 },
  });
});

test('GP-SAVE-01 makes reverse Save completion impossible with one active storage writer', async () => {
  const { state, storage, store } = createFixture();
  state.updatePlayer({ score: 500 });
  const firstSave = store.saveWithMetadata(state);
  await waitForStorageCalls(storage, 1);

  state.updatePlayer({ score: 600 });
  const latestSave = store.saveWithMetadata(state);
  await new Promise(resolveValue => setImmediate(resolveValue));
  assert.throws(() => storage.release(1), /has not started/,
    'the newer write cannot complete before the active older write');

  storage.release(0);
  await waitForStorageCalls(storage, 2);
  storage.release(1);
  await Promise.all([firstSave, latestSave]);

  const stored = await decodeInfiniteWorldSave(storage.getItem(store.key), { worldSeedHash });
  assert.equal(stored.player.score, 600);
  assert.equal(storage.maximumActive, 1);
  assert.deepEqual(store.snapshot().queue, {
    requestedGeneration: 2,
    committedGeneration: 2,
    activeGeneration: null,
    pendingGeneration: null,
    waiterCount: 0,
  });
});

test('GP-SAVE-01 skips an active snapshot superseded before its storage write', async () => {
  const firstSerializationStarted = deferred();
  const releaseFirstSerialization = deferred();
  let serializationCount = 0;
  const measure = async (stage, operation) => {
    if (stage === 'save-serialization') {
      serializationCount += 1;
      if (serializationCount === 1) {
        firstSerializationStarted.resolve();
        await releaseFirstSerialization.promise;
      }
    }
    return operation();
  };
  const { state, storage, store } = createFixture({ measure });

  state.updatePlayer({ score: 700 });
  const firstSave = store.saveWithMetadata(state);
  await firstSerializationStarted.promise;
  state.updatePlayer({ score: 800 });
  const intermediateSave = store.saveWithMetadata(state);
  state.updatePlayer({ score: 900 });
  const latestSave = store.saveWithMetadata(state);

  releaseFirstSerialization.resolve();
  await waitForStorageCalls(storage, 1);
  const onlyPayload = await decodeInfiniteWorldSave(storage.calls[0].value, { worldSeedHash });
  assert.equal(onlyPayload.player.score, 900);
  storage.release(0);

  const results = await Promise.all([firstSave, intermediateSave, latestSave]);
  assert.deepEqual(results.map(result => result.generation), [3, 3, 3]);
  assert.equal(storage.calls.length, 1, 'no superseded snapshot may reach storage');
  assert.equal(storage.maximumActive, 1);
});

test('GP-SAVE-01 continues with the latest generation after an older storage write fails', async () => {
  const { state, storage, store } = createFixture();
  state.updatePlayer({ score: 1_000 });
  const firstSave = store.saveWithMetadata(state);
  await waitForStorageCalls(storage, 1);

  state.updatePlayer({ score: 1_100 });
  const latestSave = store.saveWithMetadata(state);
  storage.fail(0, new Error('older generation failed'));
  await assert.rejects(firstSave, /older generation failed/);

  await waitForStorageCalls(storage, 2);
  storage.release(1);
  const latestResult = await latestSave;
  const stored = await decodeInfiniteWorldSave(storage.getItem(store.key), { worldSeedHash });
  assert.equal(latestResult.generation, 2);
  assert.equal(stored.player.score, 1_100);
  assert.equal(store.snapshot().queue.committedGeneration, 2);
  assert.deepEqual(store.snapshot().counts, { saved: 1, loaded: 0, missing: 0, failed: 1 });
});

test('GP-SAVE-01 coalesces pagehide, Boss, and Atomic requests to the latest pending snapshot', async () => {
  const { state, storage, store } = createFixture();
  state.updatePlayer({ score: 10 });
  const autosave = store.saveWithMetadata(state);
  await waitForStorageCalls(storage, 1);

  state.updatePlayer({ x: 48, z: -16 });
  const pagehide = store.saveWithMetadata(state);

  const boss = state.ensureEntity({
    stableId: 'wf1:boss:save-queue',
    ownerChunkKey: '3,-1',
    type: 'boss',
    maxHp: W6_ENTITY_CONTRACTS.boss.maxHp,
    x: 49,
    z: -15,
    rotationY: 0,
    aiState: 'slither',
  });
  state.setManualBoss(boss.stableId, 1);
  const bossSave = store.saveWithMetadata(state);

  state.setNuclearCooldown(12_000);
  state.damageFeature({ stableId: 'wf1:house:atomic-save', maxHp: 300 }, 300);
  const expected = state.createSaveSnapshot();
  const atomicSave = store.saveWithMetadata(state);

  let supersededSettled = false;
  void pagehide.then(() => { supersededSettled = true; }, () => { supersededSettled = true; });
  await new Promise(resolveValue => setImmediate(resolveValue));
  assert.equal(storage.calls.length, 1);
  assert.equal(supersededSettled, false, 'superseded Save must wait for the replacing generation');

  storage.release(0);
  await waitForStorageCalls(storage, 2);
  const pendingPayload = await decodeInfiniteWorldSave(storage.calls[1].value, { worldSeedHash });
  assert.deepEqual(pendingPayload, expected, 'only the latest Atomic snapshot may enter storage');
  assert.equal(supersededSettled, false);
  storage.release(1);

  const [autosaveResult, pagehideResult, bossResult, atomicResult] = await Promise.all([
    autosave, pagehide, bossSave, atomicSave,
  ]);
  assert.equal(autosaveResult.generation, 1);
  assert.equal(pagehideResult.generation, 4);
  assert.equal(bossResult.generation, 4);
  assert.equal(atomicResult.generation, 4);
  assert.equal(storage.calls.length, 2, 'intermediate pending generations must not be written');
  assert.equal(storage.maximumActive, 1, 'reverse Save completion must be structurally impossible');
  const stored = await decodeInfiniteWorldSave(storage.getItem(store.key), { worldSeedHash });
  assert.deepEqual(stored, expected);
});

test('GP-SAVE-01 captures a deep snapshot and its revision before waiting in the Save queue', async () => {
  const { state, storage, store } = createFixture();
  state.updatePlayer({ score: 1 });
  const activeSave = store.saveWithMetadata(state);
  await waitForStorageCalls(storage, 1);

  const boss = state.ensureEntity({
    stableId: 'wf1:boss:captured-save',
    ownerChunkKey: '0,0',
    type: 'boss',
    maxHp: W6_ENTITY_CONTRACTS.boss.maxHp,
    x: 1,
    z: 1,
    rotationY: 0,
    aiState: 'charge',
  });
  state.setManualBoss(boss.stableId, 1);
  boss.bossBehavior.phase = 'charge';
  boss.bossBehavior.segmentHp[0] = 1234;
  const capturedRevision = state.revision;
  const pendingSave = store.saveWithMetadata(state);

  boss.bossBehavior.phase = 'recover';
  boss.bossBehavior.segmentHp[0] = 1;
  storage.release(0);
  await waitForStorageCalls(storage, 2);
  const capturedPayload = await decodeInfiniteWorldSave(storage.calls[1].value, { worldSeedHash });
  const capturedBoss = capturedPayload.entityStates.find(entity => entity.stableId === boss.stableId);
  assert.equal(capturedBoss.bossBehavior.phase, 'charge');
  assert.equal(capturedBoss.bossBehavior.segmentHp[0], 1234);
  storage.release(1);

  const [, pendingResult] = await Promise.all([activeSave, pendingSave]);
  assert.equal(pendingResult.generation, 2);
  assert.equal(pendingResult.revision, capturedRevision);
});

test('GP-SAVE-01 routes autosave, manual, pagehide, Boss, Atomic, Retry, and shutdown through one queue', () => {
  const source = readFileSync(resolve(repoRoot, 'src/infinite-world/sandbox-boot.js'), 'utf8');
  assert.equal((source.match(/saveStore\.saveWithMetadata\(worldState\)/g) ?? []).length, 1);
  assert.match(source, /onSave:\s*\(\)\s*=>\s*\{\s*void saveWorld\(\{ force: true \}\)/);
  assert.match(source, /onNuclearRelease:[\s\S]*scheduleSave\(\{ immediate: true \}\)/);
  assert.match(source, /onSpawnManualBoss:[\s\S]*scheduleSave\(\{ immediate: true \}\)/);
  assert.match(source, /handlePageHide\s*=\s*\(\)\s*=>\s*scheduleSave\(\{ immediate: true, force: true \}\)/);
  assert.match(source, /worldState\.revision\s*!==\s*lastSavedRevision\) scheduleSave\(\)/);
  assert.match(source, /onRestart:[\s\S]*await saveWorld\(\{ force: true \}\)/);
  assert.match(source, /if \(runStarted\) await saveWorld\(\{ force: true \}\)/);
  assert.match(source, /lastSavedGeneration = saved\.generation/);
  assert.match(source, /lastSavedRevision = saved\.revision/);
});
