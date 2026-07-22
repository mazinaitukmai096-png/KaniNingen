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
    this.unloadHistory = [];
    this.origin = null;
    this.shutdownCalled = false;
  }

  async rebase(origin) { this.origin = origin; }
  async projectChunk(data) {
    if (!data) throw new TypeError('undefined ChunkData');
    return { key: `${data.chunkX},${data.chunkZ}`, chunkId: data.chunkId, contentHash: data.contentHash };
  }
  async loadProjected(projected) {
    if (this.loaded.has(projected.key)) throw new Error(`duplicate render load ${projected.key}`);
    this.loaded.set(projected.key, projected);
  }
  async unloadChunk(key) {
    if (!this.loaded.delete(key)) throw new Error(`missing render unload ${key}`);
    this.unloadHistory.push(key);
  }
  async shutdown() { this.shutdownCalled = true; this.loaded.clear(); }
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

  const revisit = await runtime.transitionToChunk(0, 0);
  assert.equal(revisit.generatedDelta, 0);
  assert.equal(revisit.renderLoadedDelta, 3);
  assert.equal(revisit.renderUnloadedDelta, 3);
  assert.equal(runtime.snapshot().cacheSize, 30);
  await runtime.shutdown();
  assert.equal(adapter.loaded.size, 0);
  assert.equal(adapter.shutdownCalled, true);
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
    if (!file.endsWith('sandbox-main.js')) await import(pathToFileURL(file));
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
