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

function createIndexedDbHarness() {
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
  const storage = createBrowserSaveStorage({ indexedDB });
  openRequest.result = database;
  openRequest.onsuccess();
  return { storage, transactions, values };
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
