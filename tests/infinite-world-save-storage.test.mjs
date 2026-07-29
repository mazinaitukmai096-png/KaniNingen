import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createBrowserSaveStorage,
  InfiniteWorldSaveStore,
  InfiniteWorldState,
} from '../src/infinite-world/world-state-store.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worldSeedHash = `sha256:${'7'.repeat(64)}`;

class MemoryLegacyStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
    this.writes = [];
  }

  getItem(key) { return this.values.get(key) ?? null; }

  setItem(key, value) {
    this.writes.push({ key, value });
    this.values.set(key, value);
  }
}

function createIndexedDbHarness({ legacyStorage = null } = {}) {
  const values = new Map();
  const transactions = [];
  const openRequest = {
    error: null,
    result: null,
    onerror: null,
    onsuccess: null,
    onupgradeneeded: null,
  };
  const database = {
    transaction(storeName, mode) {
      assert.equal(storeName, 'saves');
      const request = {
        error: null,
        result: undefined,
        onerror: null,
        onsuccess: null,
      };
      const operation = { type: null, key: null, value: null };
      const transaction = {
        error: null,
        mode,
        onabort: null,
        oncomplete: null,
        onerror: null,
        objectStore(requestedStoreName) {
          assert.equal(requestedStoreName, 'saves');
          return {
            get(key) {
              operation.type = 'get';
              operation.key = key;
              request.result = values.get(key);
              return request;
            },
            put(value, key) {
              operation.type = 'put';
              operation.key = key;
              operation.value = value;
              request.result = key;
              return request;
            },
          };
        },
      };
      const entry = { operation, request, transaction };
      transactions.push(entry);
      return transaction;
    },
  };
  const indexedDB = {
    open(name, version) {
      assert.equal(name, 'KaniNingenInfiniteWorld');
      assert.equal(version, 1);
      return openRequest;
    },
  };
  const storage = createBrowserSaveStorage({ indexedDB, legacyStorage });
  openRequest.result = database;
  openRequest.onsuccess();
  return { storage, transactions, values, indexedDB, legacyStorage, openRequest };
}

function createOpenFailureHarness({ legacyStorage = null } = {}) {
  const openRequest = {
    error: null,
    result: null,
    onerror: null,
    onsuccess: null,
    onupgradeneeded: null,
  };
  let openCount = 0;
  const indexedDB = {
    open() { openCount += 1; return openRequest; },
  };
  const storage = createBrowserSaveStorage({ indexedDB, legacyStorage });
  return { storage, openRequest, get openCount() { return openCount; } };
}

async function waitForTransaction(harness, index) {
  for (let attempt = 0; attempt < 200 && !harness.transactions[index]; attempt += 1) {
    await new Promise(resolveValue => setImmediate(resolveValue));
  }
  const entry = harness.transactions[index];
  assert.ok(entry, `IndexedDB transaction ${index} did not start`);
  return entry;
}

function observe(promise) {
  const observation = { status: 'pending', value: undefined };
  void promise.then(
    value => { observation.status = 'fulfilled'; observation.value = value; },
    error => { observation.status = 'rejected'; observation.value = error; },
  );
  return observation;
}

function createState() {
  return new InfiniteWorldState({
    worldSeed: 'GP-SAVE-02 storage test',
    worldSeedHash,
    playerSpawn: { x: 0, z: 0 },
  });
}

test('GP-SAVE-02 confirms a write only when its transaction completes', async () => {
  const harness = createIndexedDbHarness();
  const saving = harness.storage.setItem('world', 'snapshot');
  const observation = observe(saving);
  const entry = await waitForTransaction(harness, 0);

  entry.request.onsuccess();
  await new Promise(resolveValue => setImmediate(resolveValue));
  assert.equal(observation.status, 'pending', 'request success is not durable completion');
  assert.equal(typeof entry.transaction.oncomplete, 'function');

  harness.values.set(entry.operation.key, entry.operation.value);
  entry.transaction.oncomplete();
  await saving;
  assert.equal(observation.status, 'fulfilled');
});

test('GP-SAVE-02 rejects when a transaction aborts after request success', async () => {
  const harness = createIndexedDbHarness();
  const saving = harness.storage.setItem('world', 'snapshot');
  const entry = await waitForTransaction(harness, 0);
  entry.request.onsuccess();
  entry.transaction.error = new Error('commit aborted');
  entry.transaction.onabort();

  await assert.rejects(saving, /commit aborted/);
  assert.equal(harness.values.has('world'), false);
});

test('GP-SAVE-02 rejects an IndexedDB transaction error', async () => {
  const harness = createIndexedDbHarness();
  const saving = harness.storage.setItem('world', 'snapshot');
  const observation = observe(saving);
  const entry = await waitForTransaction(harness, 0);
  const error = new Error('transaction failed');
  entry.transaction.error = error;
  if (typeof entry.transaction.onerror === 'function') entry.transaction.onerror();
  else {
    entry.request.error = error;
    entry.request.onerror();
  }

  assert.equal(typeof entry.transaction.onerror, 'function');
  await assert.rejects(saving, /transaction failed/);
  assert.equal(observation.status, 'rejected');
});

test('GP-SAVE-02 rejects an IndexedDB request error', async () => {
  const harness = createIndexedDbHarness();
  const saving = harness.storage.setItem('world', 'snapshot');
  const entry = await waitForTransaction(harness, 0);
  entry.request.error = new Error('put failed');
  entry.request.onerror();

  await assert.rejects(saving, /put failed/);
});

test('GP-SAVE-02 settles once when one transaction emits multiple terminal events', async () => {
  const harness = createIndexedDbHarness();
  const saving = harness.storage.setItem('world', 'snapshot');
  const observation = observe(saving);
  const entry = await waitForTransaction(harness, 0);
  entry.request.onsuccess();
  assert.equal(typeof entry.transaction.oncomplete, 'function');
  entry.transaction.oncomplete();
  await saving;

  entry.transaction.error = new Error('late transaction error');
  entry.transaction.onerror();
  entry.transaction.onabort();
  entry.request.error = new Error('late request error');
  entry.request.onerror();
  await new Promise(resolveValue => setImmediate(resolveValue));
  assert.equal(observation.status, 'fulfilled');
});

test('GP-SAVE-02 rejects Save when storage is unavailable', async () => {
  const state = createState();
  const store = new InfiniteWorldSaveStore({ storage: null, worldSeedHash });

  await assert.rejects(store.saveWithMetadata(state), /storage is unavailable/i);
  assert.deepEqual(store.snapshot().counts, { saved: 0, loaded: 0, missing: 0, failed: 1 });
  assert.deepEqual(store.snapshot().queue, {
    requestedGeneration: 1,
    committedGeneration: 0,
    activeGeneration: null,
    pendingGeneration: null,
    waiterCount: 0,
  });
});

test('GP-SAVE-02 Save queue continues after transaction abort without committing the failed generation', async () => {
  const harness = createIndexedDbHarness();
  const state = createState();
  const store = new InfiniteWorldSaveStore({ storage: harness.storage, worldSeedHash });

  state.updatePlayer({ score: 100 });
  const failedRevision = state.revision;
  const failedSave = store.saveWithMetadata(state);
  const failedEntry = await waitForTransaction(harness, 0);
  failedEntry.request.onsuccess();
  failedEntry.transaction.error = new Error('durability failure');
  failedEntry.transaction.onabort();
  await assert.rejects(failedSave, /durability failure/);

  assert.equal(store.snapshot().queue.committedGeneration, 0);
  assert.equal(store.snapshot().counts.saved, 0);
  state.updatePlayer({ score: 200 });
  const savedRevision = state.revision;
  assert.ok(savedRevision > failedRevision);
  const successfulSave = store.saveWithMetadata(state);
  const successfulEntry = await waitForTransaction(harness, 1);
  successfulEntry.request.onsuccess();
  successfulEntry.transaction.oncomplete();
  const result = await successfulSave;

  assert.equal(result.generation, 2);
  assert.equal(result.revision, savedRevision);
  assert.equal(store.snapshot().queue.committedGeneration, 2);
  assert.deepEqual(store.snapshot().counts, { saved: 1, loaded: 0, missing: 0, failed: 1 });
});

test('GP-SAVE-02 persistence rejection cannot advance the boot saved revision', () => {
  const source = readFileSync(resolve(repoRoot, 'src/infinite-world/sandbox-boot.js'), 'utf8');
  assert.match(source, /const saved = await diagnostics\.measureAsync\([\s\S]*?saveStore\.saveWithMetadata\(worldState\)[\s\S]*?lastSavedRevision = saved\.revision;[\s\S]*?} catch \(error\)/);
  assert.doesNotMatch(source, /catch \(error\)[\s\S]{0,200}lastSavedRevision\s*=/);
});

test('GP-SAVE-04 falls back to legacy storage when IndexedDB open fails', async () => {
  const legacyStorage = new MemoryLegacyStorage();
  const harness = createOpenFailureHarness({ legacyStorage });
  const saving = harness.storage.setItem('world', 'fallback snapshot');
  harness.openRequest.error = new Error('IndexedDB blocked');
  harness.openRequest.onerror();

  await saving;
  assert.equal(legacyStorage.getItem('world'), 'fallback snapshot');
  assert.equal(harness.storage.snapshot().mode, 'legacy-fallback');
  assert.equal(harness.storage.snapshot().fallbackCount, 1);
});

test('GP-SAVE-04 reports storage unavailable when IndexedDB open fails without fallback', async () => {
  const harness = createOpenFailureHarness();
  const saving = harness.storage.setItem('world', 'lost snapshot');
  harness.openRequest.error = new Error('IndexedDB denied');
  harness.openRequest.onerror();

  await assert.rejects(saving, error => (
    error?.code === 'SAVE_STORAGE_UNAVAILABLE' && /IndexedDB denied/.test(error.message)
  ));
  assert.equal(harness.storage.snapshot().mode, 'unavailable');
});

test('GP-SAVE-04 keeps IndexedDB after one transient transaction failure', async () => {
  const legacyStorage = new MemoryLegacyStorage();
  const harness = createIndexedDbHarness({ legacyStorage });
  const failed = harness.storage.setItem('world', 'transient');
  const failedEntry = await waitForTransaction(harness, 0);
  failedEntry.transaction.error = new Error('temporary transaction failure');
  failedEntry.transaction.onerror();
  await assert.rejects(failed, /temporary transaction failure/);

  const recovered = harness.storage.setItem('world', 'indexeddb recovered');
  const recoveredEntry = await waitForTransaction(harness, 1);
  recoveredEntry.request.onsuccess();
  harness.values.set('world', 'indexeddb recovered');
  recoveredEntry.transaction.oncomplete();
  await recovered;

  assert.equal(harness.storage.snapshot().mode, 'indexeddb');
  assert.equal(harness.storage.snapshot().consecutiveFailureCount, 0);
  assert.equal(legacyStorage.getItem('world'), null);
});

test('GP-SAVE-04 preserves legacy import while preferring an existing IndexedDB save', async () => {
  const legacyStorage = new MemoryLegacyStorage([['world', 'legacy snapshot']]);
  const migrating = createIndexedDbHarness({ legacyStorage });
  const loadingLegacy = migrating.storage.getItem('world');
  const emptyRead = await waitForTransaction(migrating, 0);
  emptyRead.request.result = null;
  emptyRead.request.onsuccess();
  emptyRead.transaction.oncomplete();
  const migrationWrite = await waitForTransaction(migrating, 1);
  migrationWrite.request.onsuccess();
  migrating.values.set('world', 'legacy snapshot');
  migrationWrite.transaction.oncomplete();
  assert.equal(await loadingLegacy, 'legacy snapshot');
  assert.equal(migrating.values.get('world'), 'legacy snapshot');

  const preferringIndexedDb = createIndexedDbHarness({ legacyStorage });
  const loadingIndexedDb = preferringIndexedDb.storage.getItem('world');
  const populatedRead = await waitForTransaction(preferringIndexedDb, 0);
  populatedRead.request.result = 'newer IndexedDB snapshot';
  populatedRead.request.onsuccess();
  populatedRead.transaction.oncomplete();
  assert.equal(await loadingIndexedDb, 'newer IndexedDB snapshot');
  assert.equal(preferringIndexedDb.transactions.length, 1);
});

test('GP-SAVE-04 switches once after persistent transaction failure and preserves Save queue latest-wins', async () => {
  const legacyStorage = new MemoryLegacyStorage();
  const harness = createIndexedDbHarness({ legacyStorage });
  const state = createState();
  const store = new InfiniteWorldSaveStore({ storage: harness.storage, worldSeedHash });

  state.updatePlayer({ score: 100 });
  const failedSave = store.saveWithMetadata(state);
  const firstFailure = await waitForTransaction(harness, 0);
  firstFailure.transaction.error = new Error('persistent failure one');
  firstFailure.transaction.onerror();
  await assert.rejects(failedSave, /persistent failure one/);

  state.updatePlayer({ score: 200 });
  const queuedSave = store.saveWithMetadata(state);
  state.updatePlayer({ score: 300 });
  const pagehideSave = store.saveWithMetadata(state);
  const secondFailure = await waitForTransaction(harness, 1);
  secondFailure.transaction.error = new Error('persistent failure two');
  secondFailure.transaction.onerror();

  const [queuedResult, pagehideResult] = await Promise.all([queuedSave, pagehideSave]);
  assert.equal(queuedResult.generation, 3);
  assert.equal(pagehideResult.generation, 3);
  assert.equal(harness.storage.snapshot().mode, 'legacy-fallback');
  assert.equal(harness.storage.snapshot().fallbackCount, 1);
  const loaded = await store.loadSnapshot();
  assert.equal(loaded.player.score, 300);
  assert.equal(store.snapshot().queue.committedGeneration, 3);

  const bootSource = readFileSync(resolve(repoRoot, 'src/infinite-world/sandbox-boot.js'), 'utf8');
  assert.match(bootSource, /handlePageHide\s*=\s*\(\)\s*=>\s*\{\s*void saveForExit\(\);\s*\}/);
  assert.match(bootSource, /state\.saveAvailable = availableSaveSnapshot !== null/);
  assert.match(bootSource, /continueAvailable: state\.saveAvailable/);
  assert.match(bootSource, /setContinueAvailable\?\.\(true\)/);
});

test('GP-SAVE-04 ignores stale IndexedDB completion after fallback and pins legacy authority', async () => {
  const legacyStorage = new MemoryLegacyStorage();
  const harness = createIndexedDbHarness({ legacyStorage });
  const staleWrite = harness.storage.setItem('world', 'stale IndexedDB snapshot');
  const staleEntry = await waitForTransaction(harness, 0);

  const firstFailure = harness.storage.setItem('world', 'failed snapshot');
  const firstFailureEntry = await waitForTransaction(harness, 1);
  firstFailureEntry.transaction.error = new Error('failure one');
  firstFailureEntry.transaction.onerror();
  await assert.rejects(firstFailure, /failure one/);

  const fallbackWrite = harness.storage.setItem('world', 'authoritative fallback snapshot');
  const fallbackEntry = await waitForTransaction(harness, 2);
  fallbackEntry.transaction.error = new Error('failure two');
  fallbackEntry.transaction.onerror();
  const fallbackOutcome = fallbackWrite.then(
    value => ({ status: 'fulfilled', value }),
    error => ({ status: 'rejected', error }),
  );

  staleEntry.request.onsuccess();
  harness.values.set('world', 'stale IndexedDB snapshot');
  staleEntry.transaction.oncomplete();
  const [staleResult, fallbackResult] = await Promise.allSettled([staleWrite, fallbackWrite]);
  assert.equal(staleResult.status, 'fulfilled');
  assert.equal(fallbackResult.status, 'fulfilled', JSON.stringify(await fallbackOutcome));
  assert.equal(legacyStorage.getItem('world'), 'authoritative fallback snapshot');
  assert.ok(harness.storage.snapshot().staleIndexedDbResultCount >= 1);

  let reopenedIndexedDbCount = 0;
  const reopened = createBrowserSaveStorage({
    indexedDB: { open() { reopenedIndexedDbCount += 1; return {}; } },
    legacyStorage,
  });
  assert.equal(reopenedIndexedDbCount, 0, 'fallback marker must prevent stale IndexedDB reopening');
  assert.equal(await reopened.getItem('world'), 'authoritative fallback snapshot');
});

test('GP-SAVE-04 cannot revive storage with a stale IndexedDB completion after fallback fails', async () => {
  const harness = createIndexedDbHarness();
  const staleWrite = harness.storage.setItem('world', 'stale snapshot');
  const staleOutcome = staleWrite.then(
    value => ({ status: 'fulfilled', value }),
    error => ({ status: 'rejected', error }),
  );
  const staleEntry = await waitForTransaction(harness, 0);

  const firstFailure = harness.storage.setItem('world', 'failure one');
  const firstFailureEntry = await waitForTransaction(harness, 1);
  firstFailureEntry.transaction.error = new Error('failure one');
  firstFailureEntry.transaction.onerror();
  await assert.rejects(firstFailure, /failure one/);

  const fallbackWrite = harness.storage.setItem('world', 'failure two');
  const fallbackEntry = await waitForTransaction(harness, 2);
  fallbackEntry.transaction.error = new Error('failure two');
  fallbackEntry.transaction.onerror();
  await assert.rejects(fallbackWrite, error => error?.code === 'SAVE_STORAGE_UNAVAILABLE');

  staleEntry.request.onsuccess();
  staleEntry.transaction.oncomplete();
  const result = await staleOutcome;
  assert.equal(result.status, 'rejected');
  assert.equal(result.error?.code, 'SAVE_STORAGE_UNAVAILABLE');
  assert.equal(harness.storage.snapshot().mode, 'unavailable');
});
