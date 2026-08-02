import test from 'node:test';
import assert from 'node:assert/strict';

import { ChunkRuntimeManager } from '../src/infinite-world/chunk-runtime-manager.js';
import { ChunkDataService } from '../src/infinite-world/chunk-data-service.js';
import { createInlineChunkGeneratorTransport } from '../src/infinite-world/inline-chunk-generator-transport.js';
import {
  P1_CHUNK_STREAMING_REPRODUCTION,
  planNextChunkBoundaryPrefetch,
} from '../src/infinite-world/chunk-streaming-plan.js';
import { createSandboxChunkGenerator } from '../src/infinite-world/sandbox-chunk-generator.js';
import { getW6ScaleProfile } from '../src/infinite-world/gameplay-contract.js';
import { shouldDeferAutosaveForStreaming } from '../src/infinite-world/sandbox-boot.js';

class PreparedAdapter {
  constructor() {
    this.loaded = new Map();
    this.projected = [];
    this.discarded = [];
    this.rebases = [];
  }

  async rebase(origin) { this.rebases.push(origin); }
  async projectChunk(data, origin) {
    const projected = {
      key: `${data.chunkX},${data.chunkZ}`,
      chunkId: data.chunkId,
      contentHash: data.contentHash,
      targetOrigin: origin,
      lifecycle: 'staged',
    };
    this.projected.push(projected);
    return projected;
  }
  async loadProjected(projected) {
    assert.equal(projected.lifecycle, 'staged');
    projected.lifecycle = 'loaded';
    this.loaded.set(projected.key, projected);
  }
  async unloadChunk(key) {
    this.loaded.get(key).lifecycle = 'unloaded';
    this.loaded.delete(key);
  }
  async discardProjected(projected) {
    assert.equal(projected.lifecycle, 'staged');
    projected.lifecycle = 'discarded';
    this.discarded.push(projected.key);
  }
  async shutdown() { this.loaded.clear(); }
}

function straightPlan({ sprint = false, localX = 1 } = {}) {
  const profile = getW6ScaleProfile('MAX');
  const speed = profile.movementMetersPerSecond * (sprint ? 1.45 : 1);
  return planNextChunkBoundaryPrefetch({
    centerChunkX: 0,
    centerChunkZ: 0,
    logicalX: localX,
    logicalZ: 8,
    velocityX: speed,
    velocityZ: 0,
    speedMetersPerSecond: speed,
    scaleStageId: 'MAX',
    sprint,
  });
}

async function createRuntime(seed, { onPipelineEvent = null } = {}) {
  const source = await createSandboxChunkGenerator({ worldSeed: seed });
  const calls = [];
  const generator = {
    async generateChunk(chunkX, chunkZ) {
      calls.push(`${chunkX},${chunkZ}`);
      return source.generateChunk(chunkX, chunkZ);
    },
  };
  const adapter = new PreparedAdapter();
  const chunkDataService = new ChunkDataService({
    transport: createInlineChunkGeneratorTransport({ generator }),
    cacheCapacity: 81,
    onPipelineEvent,
  });
  const runtime = new ChunkRuntimeManager({
    chunkDataService,
    renderAdapter: adapter,
    cacheCapacity: 81,
    yieldToHost: () => Promise.resolve(),
    onPipelineEvent,
  });
  await runtime.initialize(0, 0);
  return { runtime, adapter, calls, chunkDataService };
}

test('P0 reproduction contract fixes the reported seed, movement variants, crossings, and save variants', () => {
  assert.equal(P1_CHUNK_STREAMING_REPRODUCTION.worldSeed, 'KaniNingen Infinite Natural World');
  assert.deepEqual(P1_CHUNK_STREAMING_REPRODUCTION.scaleStages, ['TINY', 'MID', 'MAX']);
  assert.deepEqual(P1_CHUNK_STREAMING_REPRODUCTION.paths, ['straight', 'diagonal']);
  assert.deepEqual(P1_CHUNK_STREAMING_REPRODUCTION.saveDuringRun, [false, true]);
  assert.equal(P1_CHUNK_STREAMING_REPRODUCTION.crossingCount, 12);
});

test('next-boundary prefetch prepares exactly the entering straight and diagonal data/render perimeters', () => {
  const straight = straightPlan({ localX: 0.5 });
  assert.equal(straight.targetKey, '1,0');
  assert.equal(straight.enteringDataCoordinates.length, 5);
  assert.equal(straight.enteringRenderCoordinates.length, 3);

  const profile = getW6ScaleProfile('MAX');
  const diagonalSpeed = profile.movementMetersPerSecond * 1.45 / Math.SQRT2;
  const diagonal = planNextChunkBoundaryPrefetch({
    centerChunkX: 0,
    centerChunkZ: 0,
    logicalX: 1,
    logicalZ: 1,
    velocityX: diagonalSpeed,
    velocityZ: diagonalSpeed,
    speedMetersPerSecond: profile.movementMetersPerSecond * 1.45,
    scaleStageId: 'MAX',
    sprint: true,
  });
  assert.equal(diagonal.targetKey, '1,1');
  assert.equal(diagonal.enteringDataCoordinates.length, 9);
  assert.equal(diagonal.enteringRenderCoordinates.length, 5);
});

test('MAX Sprint starts preparation before the boundary, deduplicates it, and commits without new generation', async () => {
  const { runtime, adapter, calls, chunkDataService } = await createRuntime('p1-max-sprint');
  const plan = straightPlan({ sprint: true, localX: 0.25 });
  assert.ok(plan.firstBoundarySeconds < plan.leadSeconds);
  const beforePreparationCalls = calls.length;
  const first = runtime.prepareTransition(plan.targetChunkX, plan.targetChunkZ);
  const second = runtime.prepareTransition(plan.targetChunkX, plan.targetChunkZ);
  assert.equal(first, second, 'same target must share one in-flight preparation');
  await first;
  assert.equal(calls.length - beforePreparationCalls, 5, 'only the entering data column is generated');
  assert.equal(adapter.projected.length, 12, 'initial 9 plus the entering render column');
  const beforeCommitCalls = calls.length;
  const transition = await runtime.transitionToChunk(plan.targetChunkX, plan.targetChunkZ);
  assert.equal(calls.length, beforeCommitCalls, 'boundary commit uses prepared ChunkData');
  assert.equal(transition.generatedDelta, 0);
  assert.equal(transition.renderLoadedDelta, 3);
  assert.equal(transition.prepared, true);
  assert.equal(runtime.getStreamingState().preparationPending, false);
  assert.ok(runtime.snapshot().chunkDataService.counts.transportCalls >= calls.length);
  await runtime.shutdown();
  await chunkDataService.shutdown();
});

test('new-territory diagnostics preserve request, ready, Terrain prepare, attach, verification, and release order', async () => {
  const events = [];
  const onPipelineEvent = (type, details) => events.push({ type, ...details });
  const { runtime, chunkDataService } = await createRuntime('p1-pipeline-timeline', {
    onPipelineEvent,
  });
  events.length = 0;
  const prepared = await runtime.prepareTransition(1, 0);
  assert.ok(prepared);
  assert.equal(events.filter(event => event.type === 'chunk-request-queued').length, 5);
  assert.equal(events.filter(event => event.type === 'chunk-worker-dispatch').length, 5);
  assert.equal(events.filter(event => event.type === 'chunk-request-deduped').length, 0);
  assert.equal(events.filter(event => event.type === 'chunk-owner-ready').length, 5);
  assert.equal(events.filter(event => event.type === 'runtime-terrain-prepared').length, 3);
  const firstRequest = events.findIndex(event => event.type === 'chunk-request-queued');
  const firstReady = events.findIndex(event => event.type === 'chunk-owner-ready');
  const preparationReady = events.findIndex(event => event.type === 'runtime-prefetch-ready');
  assert.ok(firstRequest >= 0 && firstRequest < firstReady && firstReady < preparationReady);

  events.length = 0;
  await runtime.transitionToChunk(1, 0);
  const attached = events.map(event => event.type).lastIndexOf('runtime-terrain-attached');
  const verified = events.findIndex(event => event.type === 'runtime-terrain-coverage-verified');
  const released = events.findIndex(event => event.type === 'runtime-terrain-old-owner-released');
  assert.ok(attached >= 0 && attached < verified && verified < released);
  assert.equal(new Set(runtime.snapshot().renderedKeys).size, 9);
  await runtime.shutdown();
  await chunkDataService.shutdown();
});

test('a superseded movement direction cannot commit stale prepared render results', async () => {
  const { runtime, adapter } = await createRuntime('p1-stale-direction');
  const east = runtime.prepareTransition(1, 0);
  const north = runtime.prepareTransition(0, -1);
  await north;
  await east;
  const transition = await runtime.transitionToChunk(0, -1);
  assert.equal(transition.centerChunkX, 0);
  assert.equal(transition.centerChunkZ, -1);
  assert.deepEqual([...adapter.loaded.keys()].sort(), [
    '-1,-2', '-1,-1', '-1,0',
    '0,-2', '0,-1', '0,0',
    '1,-2', '1,-1', '1,0',
  ].sort());
  assert.ok(adapter.discarded.every(key => !adapter.loaded.has(key)));
  await runtime.shutdown();
});

test('prepared transition order and Chunk identity remain deterministic', async () => {
  const left = await createRuntime('p1-determinism');
  const right = await createRuntime('p1-determinism');
  await Promise.all([
    left.runtime.prepareTransition(1, 1),
    right.runtime.prepareTransition(1, 1),
  ]);
  const [leftTransition, rightTransition] = await Promise.all([
    left.runtime.transitionToChunk(1, 1),
    right.runtime.transitionToChunk(1, 1),
  ]);
  assert.deepEqual(left.calls, right.calls);
  assert.deepEqual(
    {
      centerChunkX: leftTransition.centerChunkX,
      centerChunkZ: leftTransition.centerChunkZ,
      generatedDelta: leftTransition.generatedDelta,
      dataActivatedDelta: leftTransition.dataActivatedDelta,
      dataDeactivatedDelta: leftTransition.dataDeactivatedDelta,
      renderLoadedDelta: leftTransition.renderLoadedDelta,
      renderUnloadedDelta: leftTransition.renderUnloadedDelta,
      prepared: leftTransition.prepared,
    },
    {
      centerChunkX: rightTransition.centerChunkX,
      centerChunkZ: rightTransition.centerChunkZ,
      generatedDelta: rightTransition.generatedDelta,
      dataActivatedDelta: rightTransition.dataActivatedDelta,
      dataDeactivatedDelta: rightTransition.dataDeactivatedDelta,
      renderLoadedDelta: rightTransition.renderLoadedDelta,
      renderUnloadedDelta: rightTransition.renderUnloadedDelta,
      prepared: rightTransition.prepared,
    },
  );
  assert.deepEqual(left.runtime.getCommittedChunkState(), right.runtime.getCommittedChunkState());
  await Promise.all([left.runtime.shutdown(), right.runtime.shutdown()]);
});

test('autosave defers during a transition/preparation but terminal saves remain allowed', () => {
  assert.equal(shouldDeferAutosaveForStreaming({ transitionPending: true }), true);
  assert.equal(shouldDeferAutosaveForStreaming({ preparationPending: true }), true);
  assert.equal(shouldDeferAutosaveForStreaming({ pendingPrefetchCount: 1 }), true);
  assert.equal(shouldDeferAutosaveForStreaming({ transitionPending: true }, { force: true }), false);
  assert.equal(shouldDeferAutosaveForStreaming({ transitionPending: false, preparationPending: false }), false);
});
