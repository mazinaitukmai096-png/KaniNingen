import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ChunkRuntimeManager } from '../src/infinite-world/chunk-runtime-manager.js';
import { FloatingOrigin } from '../src/infinite-world/floating-origin.js';
import { createSandboxChunkGenerator } from '../src/infinite-world/sandbox-chunk-generator.js';

class RecordingAdapter {
  constructor() {
    this.loaded = new Map();
    this.staged = new Set();
    this.unloadHistory = [];
    this.publicationHistory = [];
    this.coverageSamples = [];
    this.projectAttempts = 0;
    this.loadAttempts = 0;
    this.failProjectAt = null;
    this.failLoadAt = null;
    this.failUnloadKeys = new Set();
    this.projectGate = null;
    this.origin = null;
    this.shutdownCalled = false;
  }

  #recordCoverage(stage) {
    this.coverageSamples.push({ stage, count: this.loaded.size });
  }

  async rebase(origin) { this.origin = origin; this.#recordCoverage('rebase'); }
  async projectChunk(data) {
    if (!data) throw new TypeError('undefined ChunkData');
    this.projectAttempts += 1;
    if (this.projectGate?.attempt === this.projectAttempts) {
      this.projectGate.startedResolve();
      await this.projectGate.release;
      this.projectGate = null;
    }
    if (this.failProjectAt === this.projectAttempts) throw new Error('injected Terrain prepare failure');
    const projected = {
      key: `${data.chunkX},${data.chunkZ}`,
      chunkId: data.chunkId,
      contentHash: data.contentHash,
      lifecycle: 'staged',
    };
    this.staged.add(projected);
    this.publicationHistory.push({ type: 'replacement-prepared', ownerKey: projected.key });
    this.#recordCoverage('prepare');
    return projected;
  }
  async loadProjected(projected) {
    this.loadAttempts += 1;
    if (this.failLoadAt === this.loadAttempts) throw new Error('injected Terrain attach failure');
    if (this.loaded.has(projected.key)) throw new Error(`duplicate render load ${projected.key}`);
    projected.lifecycle = 'loaded';
    this.staged.delete(projected);
    this.loaded.set(projected.key, projected);
    this.publicationHistory.push({ type: 'replacement-attached', ownerKey: projected.key });
    this.#recordCoverage('attach');
  }
  async unloadChunk(key) {
    if (this.failUnloadKeys.has(key)) throw new Error(`injected Terrain release failure ${key}`);
    if (!this.loaded.delete(key)) throw new Error(`missing render unload ${key}`);
    this.unloadHistory.push(key);
    this.publicationHistory.push({ type: 'old-owner-released', ownerKey: key });
    this.#recordCoverage('release');
  }
  async discardProjected(projected) {
    if (projected.lifecycle !== 'staged') throw new Error(`cannot discard ${projected.key}:${projected.lifecycle}`);
    projected.lifecycle = 'discarded';
    this.staged.delete(projected);
    this.#recordCoverage('discard');
  }
  renderCoverageSnapshot() {
    const keys = [...this.loaded.keys()].sort();
    return {
      loadedKeys: keys,
      terrainKeys: keys,
      missingTerrainKeys: [],
      disposedTerrainKeys: [],
      lifecycleMismatchKeys: [],
    };
  }
  gateNextProject() {
    let startedResolve;
    let releaseResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const release = new Promise(resolve => { releaseResolve = resolve; });
    this.projectGate = {
      attempt: this.projectAttempts + 1,
      startedResolve,
      release,
    };
    return { started, release: releaseResolve };
  }
  async shutdown() {
    this.shutdownCalled = true;
    this.loaded.clear();
    this.staged.clear();
  }
}

test('runtime maintains 3x3 render and 5x5 data sets and generates only an entering column', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'runtime-lifecycle' });
  const adapter = new RecordingAdapter();
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 81 });
  const initial = await runtime.initialize(0, 0);
  assert.deepEqual({
    generated: initial.generatedDelta,
    activated: initial.dataActivatedDelta,
    loaded: initial.renderLoadedDelta,
    unloaded: initial.renderUnloadedDelta,
  }, { generated: 25, activated: 25, loaded: 9, unloaded: 0 });
  assert.equal(runtime.snapshot().activeDataCount, 25);
  assert.equal(runtime.snapshot().renderedCount, 9);
  assert.equal(adapter.loaded.size, 9);

  adapter.publicationHistory.length = 0;
  adapter.coverageSamples.length = 0;
  const east = await runtime.transitionToChunk(1, 0);
  assert.deepEqual({
    generated: east.generatedDelta,
    activated: east.dataActivatedDelta,
    deactivated: east.dataDeactivatedDelta,
    loaded: east.renderLoadedDelta,
    unloaded: east.renderUnloadedDelta,
    rebase: east.rebaseDelta,
  }, { generated: 5, activated: 5, deactivated: 5, loaded: 3, unloaded: 3, rebase: 1 });
  assert.equal(runtime.snapshot().activeDataCount, 25);
  assert.equal(runtime.snapshot().renderedCount, 9);
  assert.deepEqual(adapter.publicationHistory.map(event => event.type), [
    'replacement-prepared',
    'replacement-prepared',
    'replacement-prepared',
    'replacement-attached',
    'replacement-attached',
    'replacement-attached',
    'old-owner-released',
    'old-owner-released',
    'old-owner-released',
  ], 'Near Terrain attaches every replacement before releasing the outgoing column');
  assert.deepEqual(east.terrainPublicationSequence.map(event => event.type), [
    'replacement-prepared',
    'replacement-prepared',
    'replacement-prepared',
    'replacement-attached',
    'replacement-attached',
    'replacement-attached',
    'new-coverage-verified',
    'old-owner-released',
    'old-owner-released',
    'old-owner-released',
  ]);
  assert.equal(Math.min(...adapter.coverageSamples.map(sample => sample.count)), 9,
    'every async prepare/attach/release boundary retains renderable Terrain coverage');

  const revisit = await runtime.transitionToChunk(0, 0);
  assert.equal(revisit.generatedDelta, 0);
  assert.equal(revisit.renderLoadedDelta, 3);
  assert.equal(revisit.renderUnloadedDelta, 3);
  assert.equal(runtime.snapshot().cacheSize, 30);
  await runtime.shutdown();
  assert.equal(adapter.loaded.size, 0);
  assert.equal(adapter.shutdownCalled, true);
});

test('Terrain prepare failure discards staging and preserves the complete old coverage', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'terrain-prepare-rollback' });
  const adapter = new RecordingAdapter();
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 81 });
  await runtime.initialize(0, 0);
  const oldKeys = [...adapter.loaded.keys()].sort();
  adapter.failProjectAt = adapter.projectAttempts + 2;
  adapter.coverageSamples.length = 0;

  await assert.rejects(runtime.transitionToChunk(1, 0), /injected Terrain prepare failure/);
  assert.deepEqual([...adapter.loaded.keys()].sort(), oldKeys);
  assert.equal(adapter.staged.size, 0);
  assert.equal(runtime.snapshot().centerChunkX, 0);
  assert.equal(runtime.snapshot().renderedCount, 9);
  assert.ok(adapter.coverageSamples.every(sample => sample.count === 9));
  await runtime.shutdown();
});

test('Terrain attach failure rolls back newly attached owners without releasing old coverage', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'terrain-attach-rollback' });
  const adapter = new RecordingAdapter();
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 81 });
  await runtime.initialize(0, 0);
  const oldKeys = [...adapter.loaded.keys()].sort();
  adapter.failLoadAt = adapter.loadAttempts + 2;
  adapter.publicationHistory.length = 0;
  adapter.coverageSamples.length = 0;

  await assert.rejects(runtime.transitionToChunk(1, 0), /injected Terrain attach failure/);
  assert.deepEqual([...adapter.loaded.keys()].sort(), oldKeys);
  assert.equal(adapter.staged.size, 0);
  assert.equal(runtime.snapshot().centerChunkX, 0);
  assert.equal(runtime.snapshot().deferredRenderReleaseKeys.length, 0);
  assert.ok(adapter.coverageSamples.every(sample => sample.count >= 9));
  assert.equal(adapter.publicationHistory.some(event => (
    event.type === 'old-owner-released' && oldKeys.includes(event.ownerKey)
  )), false);
  await runtime.shutdown();
});

test('superseded Terrain preparation cannot attach stale replacement owners', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'terrain-stale-rollback' });
  const adapter = new RecordingAdapter();
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 81 });
  await runtime.initialize(0, 0);
  const oldKeys = [...adapter.loaded.keys()].sort();
  const gate = adapter.gateNextProject();
  adapter.publicationHistory.length = 0;
  const eastTransition = runtime.transitionToChunk(1, 0);
  await gate.started;
  const northPreparation = runtime.prepareTransition(0, -1);
  gate.release();

  await assert.rejects(eastTransition, /transition preparation was superseded/);
  await northPreparation;
  assert.deepEqual([...adapter.loaded.keys()].sort(), oldKeys);
  assert.equal(adapter.publicationHistory.some(event => event.type === 'replacement-attached'), false);
  assert.equal(runtime.snapshot().centerChunkX, 0);
  assert.equal(runtime.snapshot().renderedCount, 9);
  await runtime.shutdown();
});

test('Terrain release failure retains both safe roots and retries without orphaning replacement coverage', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'terrain-release-retry' });
  const adapter = new RecordingAdapter();
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 81 });
  await runtime.initialize(0, 0);
  adapter.failUnloadKeys.add('-1,-1');

  const transition = await runtime.transitionToChunk(1, 0);
  assert.equal(transition.terrainPublicationSequence.some(event => (
    event.type === 'old-owner-release-deferred' && event.ownerKey === '-1,-1'
  )), true);
  assert.equal(runtime.snapshot().renderedCount, 9);
  assert.deepEqual(runtime.snapshot().deferredRenderReleaseKeys, ['-1,-1']);
  assert.equal(adapter.loaded.size, 10, 'failed release keeps old Terrain alongside complete replacement coverage');

  adapter.failUnloadKeys.clear();
  await runtime.transitionToChunk(1, 0);
  assert.equal(runtime.snapshot().deferredRenderReleaseKeys.length, 0);
  assert.equal(adapter.loaded.size, 9);
  assert.equal(runtime.snapshot().counts.renderReleaseFailures, 1);
  await runtime.shutdown();
});

test('round-trip Terrain transitions leave no duplicate, orphan, or double-released owner', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'terrain-round-trip' });
  const adapter = new RecordingAdapter();
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 81 });
  await runtime.initialize(0, 0);
  await runtime.transitionToChunk(1, 0);
  await runtime.transitionToChunk(0, 0);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.renderedCount, 9);
  assert.equal(snapshot.deferredRenderReleaseKeys.length, 0);
  assert.equal(adapter.loaded.size, 9);
  assert.equal(adapter.staged.size, 0);
  assert.equal(new Set(adapter.loaded.keys()).size, adapter.loaded.size);
  await runtime.shutdown();
});

test('bounded revisit cache evicts only inactive data and never exceeds its explicit cap', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'runtime-cache' });
  const adapter = new RecordingAdapter();
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 30 });
  await runtime.initialize(0, 0);
  for (let x = 1; x <= 12; x += 1) {
    const transition = await runtime.transitionToChunk(x, 0);
    assert.equal(transition.generatedDelta, 5);
    assert.equal(runtime.snapshot().cacheSize, 30);
    assert.equal(runtime.snapshot().activeDataCount, 25);
    assert.equal(runtime.snapshot().renderedCount, 9);
  }
  assert.ok(runtime.snapshot().counts.dataEvicted > 0);
  await runtime.shutdown();
});

test('Floating Origin keeps local render coordinates bounded without altering logical identity', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'floating-origin' });
  const farX = 1_000_000_000;
  const farZ = -1_000_000_000;
  const before = await generator.generateChunk(farX, farZ);
  const origin = new FloatingOrigin();
  origin.setCenterChunk(0, 0);
  const change = origin.setCenterChunk(farX, farZ);
  assert.equal(change.changed, true);
  assert.deepEqual(origin.projectChunk(farX, farZ), { x: 0, z: 0 });
  assert.deepEqual(origin.projectChunk(farX + 1, farZ - 1), { x: 4096, z: -4096 });
  const after = await generator.generateChunk(farX, farZ);
  assert.equal(after.chunkId, before.chunkId);
  assert.equal(after.contentHash, before.contentHash);
  assert.deepEqual(after.vegetationProxies.map(proxy => proxy.stableId), before.vegetationProxies.map(proxy => proxy.stableId));
});

function walkJavaScript(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return walkJavaScript(fullPath);
    return extname(entry.name) === '.js' ? [fullPath] : [];
  });
}

test('static runtime smoke resolves imports and keeps generator free of Three.js/DOM/formal systems', async () => {
  const sourceRoot = resolve(import.meta.dirname, '../src/infinite-world');
  const files = walkJavaScript(sourceRoot);
  assert.ok(files.length >= 15);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), match[1]);
      assert.equal(existsSync(target), true, `${file} has unresolved import ${match[1]}`);
    }
    if (![
      'sandbox-main.js',
      'chunk-generator-worker.js',
      'chunk-generator-node-worker.js',
    ].some(entry => file.endsWith(entry))) await import(pathToFileURL(file));
  }
  const generatorSource = readFileSync(resolve(sourceRoot, 'sandbox-chunk-generator.js'), 'utf8');
  assert.doesNotMatch(generatorSource, /\b(?:THREE|document|window|HTMLElement|WebGL)\b/);
  assert.doesNotMatch(generatorSource, /(?:g6|fixed-biome|vegetation-redistribution|rock-redistribution|proximity-query)/i);
  const migratedNames = readdirSync(resolve(sourceRoot, 'legacy-core/g0'))
    .concat(readdirSync(resolve(sourceRoot, 'legacy-core/g2')));
  for (const forbidden of [
    'fixed-biome-sector', 'g6d-sector', 'verification-host', 'viewer', 'rock-sector',
    'vegetation-redistribution', 'rock-redistribution', 'proximity-query', 'perf-diagnostics',
  ]) {
    assert.equal(migratedNames.some(name => name.includes(forbidden)), false, forbidden);
  }
});

test('runtime records generation/projection/load/unload/rebase/crossing/frame distributions', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'performance-ledger' });
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: new RecordingAdapter() });
  await runtime.initialize(0, 0);
  runtime.recordFrame(16.7);
  runtime.recordFrame(17.1);
  await runtime.transitionToChunk(1, 0);
  const metrics = runtime.snapshot().performance;
  assert.equal(metrics.generation.count, 30);
  assert.equal(metrics.projection.count, 12);
  assert.equal(metrics.load.count, 12);
  assert.equal(metrics.unload.count, 3);
  assert.equal(metrics.rebase.count, 1);
  assert.equal(metrics.crossing.count, 1);
  assert.equal(metrics.frame.count, 2);
  for (const metric of Object.values(metrics)) {
    assert.ok(metric.latest >= 0 && metric.p50 >= 0 && metric.p95 >= 0 && metric.max >= 0);
  }
  await runtime.shutdown();
});
