import test from 'node:test';
import assert from 'node:assert/strict';

import {
  W1B_SELECTED_RENDER_CHUNK_SIZE,
  describeRenderChunkCandidate,
  runW1BChunkSizeBenchmark,
  selectW1BRenderChunkSize,
} from '../src/infinite-world/chunk-size-benchmark.js';
import { ChunkRuntimeManager } from '../src/infinite-world/chunk-runtime-manager.js';
import { chunkRenderPosition, createRenderScale } from '../src/infinite-world/chunk-coordinates.js';
import { createSandboxChunkGenerator } from '../src/infinite-world/sandbox-chunk-generator.js';

class StabilityAdapter {
  constructor() { this.loaded = new Map(); this.maxLive = 0; }
  async rebase(origin) { this.origin = origin; }
  async projectChunk(data) { return { key: `${data.chunkX},${data.chunkZ}`, data }; }
  async loadProjected(projected) {
    if (this.loaded.has(projected.key)) throw new Error(`duplicate load ${projected.key}`);
    this.loaded.set(projected.key, projected);
    this.maxLive = Math.max(this.maxLive, this.loaded.size);
  }
  async unloadChunk(key) {
    if (!this.loaded.delete(key)) throw new Error(`missing unload ${key}`);
  }
  async shutdown() { this.loaded.clear(); }
}

test('W1B automatically compares 4096 and 2048 and selects the identity-preserving 4096 profile', () => {
  const benchmark = runW1BChunkSizeBenchmark({ iterations: 10_000, rounds: 3 });
  assert.equal(benchmark.schemaVersion, 'w1b-chunk-size-benchmark-1');
  assert.deepEqual(benchmark.candidates.map(candidate => candidate.renderChunkSize), [4096, 2048]);
  assert.equal(benchmark.decision.selectedRenderChunkSize, 4096);
  assert.equal(W1B_SELECTED_RENDER_CHUNK_SIZE, 4096);
  assert.equal(benchmark.decision.topologyEquivalent, true);
  for (const candidate of benchmark.candidates) {
    assert.ok(candidate.projectionBenchmark.p50Ms >= 0);
    assert.ok(candidate.projectionBenchmark.p95Ms >= candidate.projectionBenchmark.p50Ms);
  }
});

test('both render candidates have identical logical streaming and future settlement spans', () => {
  const candidates = [4096, 2048].map(renderChunkSize => describeRenderChunkCandidate(renderChunkSize, {
    playerSpeedMetersPerSecond: 32,
    futureSettlementDiameterMeters: 160,
  }));
  assert.deepEqual(candidates.map(candidate => ({
    crossing: candidate.chunkCrossingsPerSecondAtDebugSpeed,
    renderMeters: candidate.renderedDiameterMeters,
    prefetchMeters: candidate.prefetchedDiameterMeters,
    settlementChunks: candidate.futureSettlementSpanChunks,
  })), [
    { crossing: 2, renderMeters: 48, prefetchMeters: 80, settlementChunks: 10 },
    { crossing: 2, renderMeters: 48, prefetchMeters: 80, settlementChunks: 10 },
  ]);
  assert.deepEqual(createRenderScale(4096), { renderChunkSize: 4096, unitsPerMeter: 256 });
  assert.deepEqual(createRenderScale(2048), { renderChunkSize: 2048, unitsPerMeter: 128 });
  assert.deepEqual(chunkRenderPosition(20, -10, 19, -9, 2048), { x: 2048, z: -2048 });
  assert.equal(selectW1BRenderChunkSize(candidates).selectedRenderChunkSize, 4096);
});

test('W1B selection leaves W1A ChunkData identity and content hash unchanged', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'W1B identity guard' });
  const before = await generator.generateChunk(-7, 11);
  runW1BChunkSizeBenchmark({ iterations: 5000, rounds: 3 });
  const after = await generator.generateChunk(-7, 11);
  assert.equal(after.chunkId, before.chunkId);
  assert.equal(after.contentHash, before.contentHash);
  assert.deepEqual(after.vegetationProxies.map(proxy => proxy.stableId), before.vegetationProxies.map(proxy => proxy.stableId));
});

test('queued duplicate transitions coalesce without regeneration or render growth', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'W1B transition coalescing' });
  const adapter = new StabilityAdapter();
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter });
  await runtime.initialize(0, 0);
  await Promise.all(Array.from({ length: 5 }, () => runtime.transitionToChunk(1, 0)));
  const state = runtime.snapshot();
  assert.equal(state.counts.generated, 30);
  assert.equal(state.counts.transitionsRequested, 6);
  assert.equal(state.counts.transitionsPerformed, 2);
  assert.equal(state.counts.transitionsCoalesced, 4);
  assert.equal(state.counts.maxRenderedCount, 9);
  assert.equal(adapter.maxLive, 9);
  await runtime.shutdown();
});

test('long bidirectional streaming keeps cache, active data, and scene objects bounded', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'W1B long streaming' });
  const adapter = new StabilityAdapter();
  const runtime = new ChunkRuntimeManager({
    generator,
    renderAdapter: adapter,
    cacheCapacity: 81,
    identityAuditCapacity: 512,
  });
  await runtime.initialize(0, 0);
  for (let x = 1; x <= 64; x += 1) await runtime.transitionToChunk(x, x % 3);
  for (let x = 63; x >= 0; x -= 1) await runtime.transitionToChunk(x, x % 3);
  const state = runtime.snapshot();
  assert.equal(state.activeDataCount, 25);
  assert.equal(state.renderedCount, 9);
  assert.ok(state.cacheSize <= 81);
  assert.ok(state.identityAuditSize <= 512);
  assert.equal(state.counts.maxActiveDataCount, 25);
  assert.equal(state.counts.maxRenderedCount, 9);
  assert.equal(adapter.loaded.size, 9);
  assert.equal(adapter.maxLive, 9);
  await runtime.shutdown();
  assert.equal(adapter.loaded.size, 0);
});

test('identity audit rejects changed content after cache eviction', async () => {
  const base = await createSandboxChunkGenerator({ worldSeed: 'W1B identity audit' });
  const calls = new Map();
  const generator = {
    async generateChunk(x, z) {
      const key = `${x},${z}`;
      const count = (calls.get(key) ?? 0) + 1;
      calls.set(key, count);
      const data = await base.generateChunk(x, z);
      if (key === '0,0' && count > 1) return { ...data, contentHash: `sha256:${'0'.repeat(64)}` };
      return data;
    },
  };
  const runtime = new ChunkRuntimeManager({
    generator,
    renderAdapter: new StabilityAdapter(),
    cacheCapacity: 25,
    identityAuditCapacity: 128,
  });
  await runtime.initialize(0, 0);
  await runtime.transitionToChunk(8, 0);
  await assert.rejects(runtime.transitionToChunk(0, 0), /regenerated chunk changed identity\/content/);
  await runtime.shutdown();
});
