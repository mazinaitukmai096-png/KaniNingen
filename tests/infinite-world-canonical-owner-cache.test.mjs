import assert from 'node:assert/strict';
import test from 'node:test';

import { createCanonicalOwnerCache } from '../src/infinite-world/canonical-owner-cache.js';
import { createPresentationManifestCache } from '../src/infinite-world/presentation-manifest-cache.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function canonical(ownerKey, revision = 'a') {
  return Object.freeze({
    ownerKey,
    chunkId: `chunk:${ownerKey}`,
    contentHash: `sha256:${revision.repeat(64)}`,
    records: Object.freeze([
      Object.freeze({ stableId: `${ownerKey}:tree`, kind: 'tree' }),
      Object.freeze({ stableId: `${ownerKey}:rock`, kind: 'rock' }),
    ]),
  });
}

test('canonical owner cache deduplicates completed Runtime/Far/Ultra reads', async () => {
  const cache = createCanonicalOwnerCache({ capacity: 4 });
  let loads = 0;
  const request = () => cache.getOrCreate({
    ownerKey: '4,-2',
    sourceRevision: 'world:800',
    load: async () => { loads += 1; return canonical('4,-2'); },
  });

  const first = await request();
  const second = await request();
  assert.equal(first, second);
  assert.equal(loads, 1);
  assert.deepEqual(cache.snapshot().counts, {
    requests: 2,
    hits: 1,
    misses: 1,
    pendingDedupeHits: 0,
    loads: 1,
    completed: 1,
    failures: 0,
    evictions: 0,
    identityAuditEvictions: 0,
    identityMismatches: 0,
  });
});

test('canonical owner cache shares one pending generation', async () => {
  const cache = createCanonicalOwnerCache({ capacity: 2 });
  const gate = deferred();
  let loads = 0;
  const request = () => cache.getOrCreate({
    ownerKey: '0,0',
    sourceRevision: 'world:800',
    load: () => { loads += 1; return gate.promise; },
  });
  const first = request();
  const second = request();
  assert.equal(first, second);
  assert.equal(loads, 1);
  assert.equal(cache.snapshot().pendingCount, 1);
  gate.resolve(canonical('0,0'));
  assert.equal(await second, await first);
  assert.equal(cache.snapshot().counts.pendingDedupeHits, 1);
});

test('canonical owner cache applies settled LRU and bounded eviction', async () => {
  const cache = createCanonicalOwnerCache({ capacity: 2 });
  const load = ownerKey => cache.getOrCreate({
    ownerKey,
    sourceRevision: 'world:800',
    load: async () => canonical(ownerKey),
  });
  await load('0,0');
  await load('1,0');
  await load('0,0');
  await load('2,0');

  assert.equal(cache.has({ ownerKey: '0,0', sourceRevision: 'world:800' }), true);
  assert.equal(cache.has({ ownerKey: '1,0', sourceRevision: 'world:800' }), false);
  assert.equal(cache.has({ ownerKey: '2,0', sourceRevision: 'world:800' }), true);
  assert.equal(cache.snapshot().size, 2);
  assert.equal(cache.snapshot().counts.evictions, 1);
});

test('canonical owner cache rejects a changed content hash after eviction', async () => {
  const cache = createCanonicalOwnerCache({ capacity: 1 });
  await cache.getOrCreate({
    ownerKey: '0,0', sourceRevision: 'world:800', load: async () => canonical('0,0', 'a'),
  });
  cache.delete({ ownerKey: '0,0', sourceRevision: 'world:800' });
  await assert.rejects(cache.getOrCreate({
    ownerKey: '0,0', sourceRevision: 'world:800', load: async () => canonical('0,0', 'b'),
  }), /identity changed/);
  assert.equal(cache.snapshot().counts.identityMismatches, 1);
  assert.equal(cache.snapshot().size, 0);
});

test('presentation manifest cache deduplicates a pending derived build', async () => {
  const cache = createPresentationManifestCache({ capacity: 2 });
  const source = canonical('0,0');
  const gate = deferred();
  let builds = 0;
  const request = () => cache.getOrCreate({
    manifestKind: 'forest-horizon',
    ownerKey: '0,0',
    sourceRevision: 'world:800',
    loadCanonical: async () => source,
    build: () => { builds += 1; return gate.promise; },
  });
  const first = request();
  const second = request();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(builds, 1);
  gate.resolve(Object.freeze({ trees: Object.freeze(['0,0:tree']) }));
  assert.deepEqual(await first, await second);
  assert.equal(cache.snapshot().counts.pendingDedupeHits, 1);
});

test('cache settlePending owns canonical loads and the full presentation request lifetime', async () => {
  const owners = createCanonicalOwnerCache({ capacity: 2 });
  const manifests = createPresentationManifestCache({ capacity: 2 });
  const sourceGate = deferred();
  const manifestGate = deferred();
  let manifestBuilds = 0;
  const request = manifests.getOrCreate({
    manifestKind: 'forest-horizon',
    ownerKey: '0,0',
    sourceRevision: 'world:800',
    loadCanonical: () => owners.getOrCreate({
      ownerKey: '0,0',
      sourceRevision: 'world:800',
      load: () => sourceGate.promise,
    }),
    build: source => {
      manifestBuilds += 1;
      return manifestGate.promise.then(() => source.records);
    },
  });
  let ownersSettled = false;
  let manifestsSettled = false;
  const ownersDrain = owners.settlePending().then(() => { ownersSettled = true; });
  const manifestsDrain = manifests.settlePending().then(() => { manifestsSettled = true; });

  await Promise.resolve();
  assert.equal(ownersSettled, false);
  assert.equal(manifestsSettled, false);
  assert.equal(manifests.snapshot().inFlightRequestCount, 1);
  sourceGate.resolve(canonical('0,0'));
  await ownersDrain;
  await Promise.resolve();
  assert.equal(ownersSettled, true);
  assert.equal(manifestBuilds, 1);
  assert.equal(manifestsSettled, false);
  manifestGate.resolve();
  await manifestsDrain;

  assert.deepEqual(await request, canonical('0,0').records);
  assert.equal(manifests.snapshot().inFlightRequestCount, 0);
  assert.equal(manifests.snapshot().pendingCount, 0);
});

test('presentation manifest eviction rebuilds from the retained canonical owner', async () => {
  const owners = createCanonicalOwnerCache({ capacity: 2 });
  const manifests = createPresentationManifestCache({ capacity: 1 });
  let sourceLoads = 0;
  let builds = 0;
  const request = ownerKey => manifests.getOrCreate({
    manifestKind: 'forest-horizon',
    ownerKey,
    sourceRevision: 'world:800',
    loadCanonical: () => owners.getOrCreate({
      ownerKey,
      sourceRevision: 'world:800',
      load: async () => { sourceLoads += 1; return canonical(ownerKey); },
    }),
    build: source => {
      builds += 1;
      return Object.freeze({
        contentHash: source.contentHash,
        stableIds: Object.freeze(source.records.map(record => record.stableId)),
      });
    },
  });
  const first = await request('0,0');
  await request('1,0');
  const rebuilt = await request('0,0');

  assert.deepEqual(rebuilt, first);
  assert.equal(sourceLoads, 2);
  assert.equal(builds, 3);
  assert.equal(owners.snapshot().counts.hits, 1);
  assert.equal(manifests.snapshot().counts.evictions, 2);
});

test('destruction is reapplied after every immutable manifest cache lookup', async () => {
  const cache = createPresentationManifestCache({ capacity: 2 });
  const source = canonical('0,0');
  const destroyed = new Set();
  let builds = 0;
  const request = () => cache.getOrCreate({
    manifestKind: 'natural',
    ownerKey: '0,0',
    sourceRevision: 'world:800',
    loadCanonical: async () => source,
    build: canonicalSource => {
      builds += 1;
      return canonicalSource.records;
    },
    applyState: records => Object.freeze(
      records.filter(record => !destroyed.has(record.stableId)),
    ),
  });
  assert.deepEqual((await request()).map(record => record.kind), ['tree', 'rock']);
  destroyed.add('0,0:tree');
  assert.deepEqual((await request()).map(record => record.kind), ['rock']);
  assert.equal(builds, 1);
  assert.equal(cache.snapshot().counts.stateApplications, 2);
});

test('W8 full Chunk and Forest manifest share one canonical owner and preserve hashes', {
  timeout: 30_000,
}, async () => {
  const generator = await createW8ParityChunkGenerator({
    worldSeed: 'Phase 3 canonical owner cache',
  });
  try {
    const [firstChunk, firstForest] = await Promise.all([
      generator.generateChunk(2, -1),
      generator.generateForestHorizonManifest(2, -1),
    ]);
    const [secondChunk, secondForest] = await Promise.all([
      generator.generateChunk(2, -1),
      generator.generateForestHorizonManifest(2, -1),
    ]);
    assert.equal(secondChunk, firstChunk);
    assert.equal(secondForest, firstForest);
    assert.equal(secondChunk.contentHash, firstChunk.contentHash);
    assert.equal(secondForest.contentHash, firstForest.contentHash);
    assert.equal(secondChunk.chunkId, secondForest.chunkId);
    assert.deepEqual(
      secondForest.presentationLayers.natural.vegetation.map(tree => tree.candidateId),
      firstForest.presentationLayers.natural.vegetation.map(tree => tree.candidateId),
    );

    const snapshot = generator.snapshot();
    assert.equal(snapshot.canonicalOwnerCache.counts.loads, 1);
    assert.equal(snapshot.canonicalOwnerCache.counts.completed, 1);
    assert.ok(snapshot.canonicalOwnerCache.counts.pendingDedupeHits >= 1);
    assert.equal(snapshot.presentationManifestCache.counts.builds, 2);
    assert.equal(snapshot.presentationManifestCache.counts.hits, 2);
  } finally {
    await generator.shutdown();
  }
});

test('cache state is runtime-only and close releases retained owners and manifests', async () => {
  const owners = createCanonicalOwnerCache({ capacity: 2 });
  const manifests = createPresentationManifestCache({ capacity: 2 });
  const lateGate = deferred();
  const lateOwner = owners.getOrCreate({
    ownerKey: '1,0', sourceRevision: 'world:800', load: () => lateGate.promise,
  });
  await owners.getOrCreate({
    ownerKey: '0,0', sourceRevision: 'world:800', load: async () => canonical('0,0'),
  });
  await manifests.getOrCreate({
    manifestKind: 'forest-horizon',
    ownerKey: '0,0',
    sourceRevision: 'world:800',
    loadCanonical: async () => canonical('0,0'),
    build: source => source.records,
  });
  assert.equal(JSON.stringify({ schemaVersion: 'infinite-world-save-v5' }).includes('cache'), false);
  owners.close();
  manifests.close();
  lateGate.resolve(canonical('1,0'));
  await lateOwner;
  assert.equal(owners.snapshot().size, 0);
  assert.equal(owners.snapshot().identityAuditSize, 0);
  assert.equal(manifests.snapshot().size, 0);
  assert.equal(owners.snapshot().closed, true);
  assert.equal(manifests.snapshot().closed, true);
});
