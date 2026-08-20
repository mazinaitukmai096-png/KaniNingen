import test from 'node:test';
import assert from 'node:assert/strict';

import { ChunkRuntimeManager } from '../src/infinite-world/chunk-runtime-manager.js';
import { ChunkDataService } from '../src/infinite-world/chunk-data-service.js';
import { createInlineChunkGeneratorTransport } from '../src/infinite-world/inline-chunk-generator-transport.js';
import {
  P1_CHUNK_STREAMING_REPRODUCTION,
  planNextChunkBoundaryPrefetch,
  planRuntimeTerrainReadySet,
} from '../src/infinite-world/chunk-streaming-plan.js';
import { squareChunkCoordinates } from '../src/infinite-world/chunk-coordinates.js';
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

class TerrainPresentationGenerationAdapter {
  constructor() {
    this.prepared = [];
    this.claimed = [];
    this.discarded = [];
    this.activeIdentity = 'initial';
  }

  revision() { return 'Current'; }

  async prepare(options) {
    const handle = Object.freeze({
      identity: options.identity,
      centerChunkX: options.centerChunkX,
      centerChunkZ: options.centerChunkZ,
      geometryCount: 2,
      uploadBytes: 256,
      maximumSliceMs: 0.5,
    });
    this.prepared.push({ options, handle });
    return Object.freeze({
      prepared: true,
      presentationGeneration: handle,
      geometryCount: 2,
      uploadBytes: 256,
      maximumSliceMs: 0.5,
    });
  }

  claim(options) {
    const oldIdentity = this.activeIdentity;
    this.activeIdentity = options.presentationGeneration.identity;
    this.claimed.push({ ...options, oldIdentity });
    return Object.freeze({
      claimed: true,
      identity: this.activeIdentity,
      oldIdentity,
    });
  }

  discard(handle) {
    this.discarded.push(handle.identity);
    return true;
  }
}

class ControlledTerrainPresentationGenerationAdapter
  extends TerrainPresentationGenerationAdapter {
  constructor({ reuseRatio = 0.94 } = {}) {
    super();
    this.starts = [];
    this.reuseRatio = reuseRatio;
  }

  async prepare(options) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    this.starts.push({ options, release });
    await gate;
    const result = await super.prepare(options);
    return Object.freeze({
      ...result,
      clipmapMetrics: Object.freeze({ reuseRatio: this.reuseRatio }),
    });
  }
}

class TimedTerrainPresentationGenerationAdapter
  extends TerrainPresentationGenerationAdapter {
  constructor({ generationDelayMs = 500, reuseRatio = 0.94 } = {}) {
    super();
    this.generationDelayMs = generationDelayMs;
    this.reuseRatio = reuseRatio;
    this.starts = [];
  }

  async prepare(options) {
    this.starts.push({ options, startedAtMs: performance.now() });
    await new Promise(resolve => setTimeout(resolve, this.generationDelayMs));
    const result = await super.prepare(options);
    return Object.freeze({
      ...result,
      clipmapMetrics: Object.freeze({ reuseRatio: this.reuseRatio }),
    });
  }
}

async function waitForTerrainPresentationReady(runtime, count, maximumTurns = 2_000) {
  for (let turn = 0; turn < maximumTurns; turn += 1) {
    const ready = runtime.snapshot().terrainReady.terrainPresentationGenerations
      .filter(entry => entry.state === 'ready');
    if (ready.length >= count) return ready;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Terrain presentation generation did not reach ready count ${count}`);
}

async function waitForTerrainPresentationStart(adapter, count, maximumTurns = 2_000) {
  for (let turn = 0; turn < maximumTurns; turn += 1) {
    if (adapter.starts.length >= count) return adapter.starts[count - 1];
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Terrain presentation generation did not start ${count}`);
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

function readyPlan({
  stageId = 'MAX', sprint = true, path = 'straight', centerChunkX = 0, centerChunkZ = 0,
  logicalX = centerChunkX * 16 + 8, logicalZ = centerChunkZ * 16 + 8,
} = {}) {
  const profile = getW6ScaleProfile(stageId);
  const speed = profile.movementMetersPerSecond * (sprint ? profile.sprintMultiplier : 1);
  const axisSpeed = path === 'diagonal' ? speed / Math.SQRT2 : speed;
  return planRuntimeTerrainReadySet({
    centerChunkX,
    centerChunkZ,
    logicalX,
    logicalZ,
    velocityX: axisSpeed,
    velocityZ: path === 'diagonal' ? axisSpeed : 0,
    speedMetersPerSecond: speed,
    scaleStageId: stageId,
    sprint,
  });
}

function movingReadyPlan({
  runtimeCenter,
  playerCenter,
  direction,
  stageId = 'MAX',
  sprint = true,
}) {
  const profile = getW6ScaleProfile(stageId);
  const speed = profile.movementMetersPerSecond * (sprint ? profile.sprintMultiplier : 1);
  const magnitude = Math.hypot(direction.x, direction.z) || 1;
  return planRuntimeTerrainReadySet({
    centerChunkX: runtimeCenter.chunkX,
    centerChunkZ: runtimeCenter.chunkZ,
    logicalX: playerCenter.chunkX * 16 + 8,
    logicalZ: playerCenter.chunkZ * 16 + 8,
    velocityX: speed * direction.x / magnitude,
    velocityZ: speed * direction.z / magnitude,
    speedMetersPerSecond: speed,
    scaleStageId: stageId,
    sprint,
  });
}

function maxSprintStressCenter(step) {
  return { chunkX: step, chunkZ: 0 };
}

function maxSprintStressDirection(step) {
  const current = maxSprintStressCenter(step);
  const next = maxSprintStressCenter(Math.min(180, step + 1));
  const x = next.chunkX - current.chunkX;
  const z = next.chunkZ - current.chunkZ;
  return x === 0 && z === 0 ? { x: 1, z: 0 } : { x, z };
}

async function createRuntime(seed, {
  onPipelineEvent = null,
  terrainPresentationAdapter = null,
  fastChunks = false,
} = {}) {
  const source = await createSandboxChunkGenerator({ worldSeed: seed });
  const fastTemplate = fastChunks ? await source.generateChunk(0, 0) : null;
  const calls = [];
  const generator = {
    async generateChunk(chunkX, chunkZ) {
      calls.push(`${chunkX},${chunkZ}`);
      if (fastTemplate) {
        const coordinateIdentity = `${chunkX < 0 ? '1' : '0'}${Math.abs(chunkX)
          .toString(16).padStart(15, '0')}${chunkZ < 0 ? '1' : '0'}${Math.abs(chunkZ)
          .toString(16).padStart(15, '0')}`.padEnd(64, '0');
        return Object.freeze({
          ...fastTemplate,
          chunkX,
          chunkZ,
          chunkId: `fast-test-chunk:${chunkX},${chunkZ}`,
          vegetationProxies: Object.freeze([]),
          rockProxies: Object.freeze([]),
          contentHash: `sha256:${coordinateIdentity}`,
        });
      }
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
  if (terrainPresentationAdapter) {
    runtime.configureTerrainPresentationAdapter(terrainPresentationAdapter);
  }
  return { runtime, adapter, calls, chunkDataService, terrainPresentationAdapter };
}

async function createControlledChunkDataRuntime(seed, {
  delayedOwnerKey = '3,-1',
  delayMs = null,
  heldOwnerKeys = [],
} = {}) {
  const source = await createSandboxChunkGenerator({ worldSeed: seed });
  const fastTemplate = await source.generateChunk(0, 0);
  const calls = [];
  const callCountByOwner = new Map();
  const workerCancelRequests = [];
  let delayEnabled = false;
  let delayedRequest = null;
  const heldRequests = new Map();
  let notifyDelayedStarted;
  const delayedStarted = new Promise(resolve => { notifyDelayedStarted = resolve; });
  const fastChunk = (chunkX, chunkZ) => {
    const coordinateIdentity = `${chunkX < 0 ? '1' : '0'}${Math.abs(chunkX)
      .toString(16).padStart(15, '0')}${chunkZ < 0 ? '1' : '0'}${Math.abs(chunkZ)
      .toString(16).padStart(15, '0')}`.padEnd(64, '0');
    return Object.freeze({
      ...fastTemplate,
      chunkX,
      chunkZ,
      chunkId: `controlled-test-chunk:${chunkX},${chunkZ}`,
      vegetationProxies: Object.freeze([]),
      rockProxies: Object.freeze([]),
      contentHash: `sha256:${coordinateIdentity}`,
    });
  };
  const transport = {
    async initialize() {
      return {
        worldSeed: source.worldSeed,
        worldSeedHash: source.worldSeedHash,
        generatorVersion: source.generatorVersion,
        experienceSpawn: source.experienceSpawn,
        reviewSpawn: source.reviewSpawn,
      };
    },
    generateChunk(request) {
      const key = `${request.chunkX},${request.chunkZ}`;
      calls.push(key);
      callCountByOwner.set(key, (callCountByOwner.get(key) ?? 0) + 1);
      const data = fastChunk(request.chunkX, request.chunkZ);
      if (delayEnabled && heldOwnerKeys.includes(key)) {
        return new Promise(resolve => {
          heldRequests.set(key, { requestId: request.requestId, resolve, data });
        });
      }
      if (!delayEnabled || key !== delayedOwnerKey) return Promise.resolve(data);
      return new Promise(resolve => {
        let timeoutId = null;
        delayedRequest = {
          requestId: request.requestId,
          resolve: value => {
            if (timeoutId !== null) clearTimeout(timeoutId);
            resolve(value);
          },
          data,
        };
        notifyDelayedStarted();
        if (Number.isFinite(delayMs)) {
          timeoutId = setTimeout(() => delayedRequest.resolve(data), delayMs);
        }
      });
    },
    cancelGenerationRequest({ requestId }) {
      const held = [...heldRequests.values()].find(value => value.requestId === requestId);
      if (held) {
        workerCancelRequests.push(requestId);
        held.resolve(null);
        return true;
      }
      if (requestId !== delayedRequest?.requestId) return false;
      workerCancelRequests.push(requestId);
      delayedRequest.resolve(null);
      return true;
    },
    snapshot: () => Object.freeze({ kind: 'controlled-ready-subscriber-test' }),
    async shutdown() {
      delayedRequest?.resolve(null);
      for (const held of heldRequests.values()) held.resolve(null);
      await source.shutdown?.();
    },
  };
  const chunkDataService = new ChunkDataService({ transport, cacheCapacity: 81 });
  const runtime = new ChunkRuntimeManager({
    chunkDataService,
    renderAdapter: new PreparedAdapter(),
    cacheCapacity: 81,
    yieldToHost: () => Promise.resolve(),
  });
  await runtime.initialize(0, 0);
  delayEnabled = true;
  return {
    runtime,
    chunkDataService,
    calls,
    callCountByOwner,
    workerCancelRequests,
    delayedStarted,
    releaseDelayed: () => delayedRequest?.resolve(delayedRequest.data),
    releaseHeld: key => {
      const held = heldRequests.get(key);
      held?.resolve(held.data);
      heldRequests.delete(key);
    },
  };
}

async function countPreparationYields(seed, transitionOptions = null) {
  const source = await createSandboxChunkGenerator({ worldSeed: seed });
  const adapter = new PreparedAdapter();
  let yieldCount = 0;
  const runtime = new ChunkRuntimeManager({
    generator: source,
    renderAdapter: adapter,
    cacheCapacity: 81,
    yieldToHost: () => {
      yieldCount += 1;
      return Promise.resolve();
    },
  });
  await runtime.initialize(0, 0);
  yieldCount = 0;
  if (transitionOptions === null) await runtime.prepareTransition(1, 0);
  else await runtime.transitionToChunk(1, 0, transitionOptions);
  await runtime.shutdown();
  return yieldCount;
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

test('Runtime Terrain READY planner unions an owner once and grows a bounded velocity corridor', () => {
  const rows = [];
  for (const stageId of ['TINY', 'MID', 'MAX']) {
    for (const sprint of [false, true]) {
      for (const path of ['straight', 'diagonal']) {
        const plan = readyPlan({ stageId, sprint, path });
        const dataKeys = plan.dataCoordinates.map(value => value.key);
        const renderKeys = plan.renderCoordinates.map(value => value.key);
        assert.equal(new Set(dataKeys).size, dataKeys.length);
        assert.equal(new Set(renderKeys).size, renderKeys.length);
        assert.ok(renderKeys.every(key => dataKeys.includes(key)));
        assert.ok(dataKeys.length <= 81, `${stageId}/${sprint}/${path} exceeds cache capacity`);
        assert.deepEqual(plan, readyPlan({ stageId, sprint, path }));
        rows.push({ stageId, sprint, path, plan });
      }
    }
  }
  const maxWalk = rows.find(row => row.stageId === 'MAX' && !row.sprint && row.path === 'straight').plan;
  const maxSprint = rows.find(row => row.stageId === 'MAX' && row.sprint && row.path === 'straight').plan;
  assert.ok(maxSprint.corridorCenters.length > maxWalk.corridorCenters.length);
  assert.ok(maxSprint.dataCoordinates.length > maxWalk.dataCoordinates.length);
  assert.equal(maxSprint.dataCoordinates.length, 60);
  assert.equal(maxSprint.renderCoordinates.length, 30);
});

test('MAX Sprint straight and diagonal consume the authoritative READY set with zero arrival projection', async () => {
  for (const path of ['straight', 'diagonal']) {
    const { runtime, adapter, calls, chunkDataService } = await createRuntime(`p1-ready-${path}`);
    const plan = readyPlan({ path });
    await runtime.updateTerrainReadySet(plan);
    const ready = runtime.snapshot().terrainReady;
    assert.equal(ready.queueDepth, 0);
    assert.equal(ready.readyRenderOwnerCount, plan.renderCoordinates.length);
    const generationCount = calls.length;
    const projectionCount = adapter.projected.length;
    for (const center of plan.corridorCenters.slice(1)) {
      const transition = await runtime.transitionToChunk(center.chunkX, center.chunkZ, { required: true });
      assert.equal(transition.generatedDelta, 0);
    }
    const snapshot = runtime.snapshot();
    assert.equal(calls.length, generationCount);
    assert.equal(adapter.projected.length, projectionCount);
    assert.equal(snapshot.counts.terrainReadyRequiredProjections, 0);
    assert.equal(snapshot.counts.terrainReadyCoverageMisses, 0);
    assert.equal(snapshot.counts.terrainReadyGateBlockedFrames, 0);
    assert.equal(new Set(calls).size, calls.length);
    const last = plan.corridorCenters.at(-1);
    assert.deepEqual(
      [...adapter.loaded.keys()].sort(),
      squareChunkCoordinates(last.chunkX, last.chunkZ, 1).map(value => value.key).sort(),
    );
    await runtime.shutdown();
    await chunkDataService.shutdown();
  }
});

test('MAX Sprint claims complete Terrain presentation generations without arrival compose or mixed release order', async () => {
  for (const path of ['straight', 'diagonal']) {
    const presentation = new TerrainPresentationGenerationAdapter();
    const events = [];
    const { runtime, adapter, calls, chunkDataService } = await createRuntime(
      `p1b-terrain-presentation-${path}`,
      {
        terrainPresentationAdapter: presentation,
        onPipelineEvent: (type, details) => events.push({ type, ...details }),
      },
    );
    let plan = readyPlan({ path });
    await runtime.updateTerrainReadySet(plan);
    let ready = await waitForTerrainPresentationReady(runtime, 1);
    assert.equal(ready.length, 1);
    for (let step = 1; step <= 3; step += 1) {
      const center = plan.corridorCenters[1];
      const eventStart = events.length;
      const generationCount = calls.length;
      const projectionCount = adapter.projected.length;
      const transition = await runtime.transitionToChunk(
        center.chunkX,
        center.chunkZ,
        { required: true },
      );
      assert.equal(transition.terrainPresentationClaimed, true);
      assert.equal(calls.length, generationCount);
      assert.equal(adapter.projected.length, projectionCount);
      const transitionEvents = events.slice(eventStart).map(event => event.type);
      const firstNearAttach = transitionEvents.indexOf('runtime-terrain-attached');
      const presentationClaim = transitionEvents.indexOf(
        'runtime-terrain-presentation-generation-claimed',
      );
      const firstOldRelease = transitionEvents.indexOf('runtime-terrain-old-owner-released');
      const handoffCompleted = transitionEvents.indexOf(
        'runtime-terrain-presentation-generation-handoff-completed',
      );
      assert.ok(firstNearAttach >= 0 && firstNearAttach < presentationClaim);
      assert.ok(presentationClaim >= 0 && presentationClaim < firstOldRelease);
      assert.ok(firstOldRelease >= 0 && firstOldRelease < handoffCompleted);
      assert.ok(transition.terrainPresentationTimeline.attachAtMs
        <= transition.terrainPresentationTimeline.oldReleaseAtMs);
      if (step < 3) {
        plan = readyPlan({
          path,
          centerChunkX: center.chunkX,
          centerChunkZ: center.chunkZ,
          logicalX: center.chunkX * 16 + 8,
          logicalZ: center.chunkZ * 16 + 8,
        });
        await runtime.updateTerrainReadySet(plan);
        ready = await waitForTerrainPresentationReady(runtime, 1);
        assert.equal(ready.length, 1);
      }
    }

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.counts.terrainReadyRequiredProjections, 0);
    assert.equal(snapshot.counts.terrainPresentationRequiredOuterComposes, 0);
    assert.equal(snapshot.counts.terrainPresentationRequiredClipmapBuilds, 0);
    assert.equal(snapshot.counts.terrainPresentationDuplicateGenerations, 0);
    assert.equal(snapshot.counts.terrainPresentationStalePublishes, 0);
    assert.equal(snapshot.counts.terrainPresentationGenerationsStarted, 3);
    assert.equal(snapshot.counts.terrainPresentationGenerationsCompleted, 3);
    assert.equal(snapshot.counts.terrainPresentationGenerationsCancelled, 0);
    assert.equal(snapshot.counts.terrainPresentationGenerationsClaimed, 3);
    assert.equal(snapshot.counts.terrainPresentationMaximumStagedCount, 1);
    assert.equal(snapshot.counts.terrainPresentationMaximumGeometryCount, 2);
    assert.equal(snapshot.counts.terrainPresentationMaximumUploadBytes, 256);
    assert.equal(snapshot.counts.terrainPresentationMaximumSliceMs, 0.5);
    assert.equal(presentation.claimed.length, 3);
    const claimEvents = events.filter(event => (
      event.type === 'runtime-terrain-presentation-generation-claimed'
    ));
    assert.equal(claimEvents.length, 3);
    const completedEvents = events.filter(event => (
      event.type === 'runtime-terrain-presentation-generation-handoff-completed'
    ));
    assert.equal(completedEvents.length, 3);
    for (const event of completedEvents) {
      assert.ok(event.requestAtMs <= event.nearReadyAtMs);
      assert.ok(event.nearReadyAtMs <= event.outerReadyAtMs);
      assert.ok(event.outerReadyAtMs <= event.clipmapReadyAtMs);
      assert.ok(event.clipmapReadyAtMs <= event.presentationReadyAtMs);
      assert.ok(event.presentationReadyAtMs <= event.requiredAtMs);
      assert.ok(event.requiredAtMs <= event.claimAtMs);
      assert.ok(event.claimAtMs <= event.attachAtMs);
      assert.ok(event.attachAtMs <= event.oldReleaseAtMs);
      assert.equal(event.arrivalAtMs, event.requiredAtMs);
    }
    await runtime.shutdown();
    await chunkDataService.shutdown();
  }
});

test('READY corridor supersede discards stale projection and prioritizes the new direction', async () => {
  const source = await createSandboxChunkGenerator({ worldSeed: 'p1-ready-supersede' });
  let releaseProjection;
  let notifyProjectionStarted;
  const projectionStarted = new Promise(resolve => { notifyProjectionStarted = resolve; });
  const adapter = new PreparedAdapter();
  const baseProject = adapter.projectChunk.bind(adapter);
  let blockKey = '2,-1';
  adapter.projectChunk = async (data, origin) => {
    const projected = await baseProject(data, origin);
    if (`${data.chunkX},${data.chunkZ}` === blockKey) {
      notifyProjectionStarted();
      await new Promise(resolve => { releaseProjection = resolve; });
      blockKey = null;
    }
    return projected;
  };
  const chunkDataService = new ChunkDataService({
    transport: createInlineChunkGeneratorTransport({ generator: source }),
    cacheCapacity: 81,
  });
  const runtime = new ChunkRuntimeManager({
    chunkDataService,
    renderAdapter: adapter,
    cacheCapacity: 81,
    yieldToHost: () => Promise.resolve(),
  });
  await runtime.initialize(0, 0);
  const east = runtime.updateTerrainReadySet(readyPlan({ path: 'straight' }));
  await projectionStarted;
  const northPlan = readyPlan({
    path: 'straight',
    logicalX: 8,
    logicalZ: 8,
  });
  const profile = getW6ScaleProfile('MAX');
  const speed = profile.sprintMetersPerSecond;
  const north = planRuntimeTerrainReadySet({
    centerChunkX: 0,
    centerChunkZ: 0,
    logicalX: 8,
    logicalZ: 8,
    velocityX: 0,
    velocityZ: -speed,
    speedMetersPerSecond: speed,
    scaleStageId: 'MAX',
    sprint: true,
  });
  assert.notEqual(northPlan.signature, north.signature);
  const northReady = runtime.updateTerrainReadySet(north);
  releaseProjection();
  assert.equal(await east, null);
  await northReady;
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.terrainReady.queueDepth, 0);
  assert.equal(snapshot.terrainReady.planSignature, north.signature);
  assert.ok(snapshot.counts.terrainReadyCancelledWork > 0);
  assert.ok(snapshot.counts.terrainReadyStaleCompletions > 0);
  assert.ok(adapter.discarded.includes('2,-1'));
  assert.equal(adapter.loaded.has('2,-1'), false);
  await runtime.shutdown();
  await chunkDataService.shutdown();
});

test('READY plan supersede preserves a shared queued ChunkData request and its queue identity', async t => {
  const controlled = await createControlledChunkDataRuntime('p2e-queued-transfer', {
    delayedOwnerKey: '999,999',
    heldOwnerKeys: ['100,0', '101,0'],
  });
  t.after(async () => {
    await controlled.runtime.shutdown();
    await controlled.chunkDataService.shutdown();
  });
  const blockerA = controlled.chunkDataService.requestChunk({
    chunkX: 100, chunkZ: 0, priority: 1, consumerId: 'queue-blocker-a', required: true,
  });
  const blockerB = controlled.chunkDataService.requestChunk({
    chunkX: 101, chunkZ: 0, priority: 1, consumerId: 'queue-blocker-b', required: true,
  });
  for (let turn = 0; turn < 100 && controlled.chunkDataService.snapshot().inFlightCount < 2; turn += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(controlled.chunkDataService.snapshot().inFlightCount, 2);

  const planA = movingReadyPlan({
    runtimeCenter: { chunkX: 0, chunkZ: 0 },
    playerCenter: { chunkX: 2, chunkZ: 0 },
    direction: { x: 1, z: 0 },
  });
  const planB = movingReadyPlan({
    runtimeCenter: { chunkX: 0, chunkZ: 0 },
    playerCenter: { chunkX: 3, chunkZ: 0 },
    direction: { x: 1, z: 0 },
  });
  const workA = controlled.runtime.updateTerrainReadySet(planA);
  let queuedBefore = null;
  for (let turn = 0; turn < 100 && queuedBefore === null; turn += 1) {
    queuedBefore = controlled.chunkDataService.snapshot().queued
      .find(value => value.key === '3,0') ?? null;
    if (queuedBefore === null) await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(queuedBefore);
  const workB = controlled.runtime.updateTerrainReadySet(planB);
  const queuedAfter = controlled.chunkDataService.snapshot().queued
    .find(value => value.key === '3,0');
  assert.ok(queuedAfter);
  assert.equal(queuedAfter.requestId, queuedBefore.requestId);
  assert.equal(controlled.workerCancelRequests.length, 0);
  const during = controlled.runtime.snapshot().terrainReady.chunkDataSubscriberDiagnostics;
  assert.equal(during.chunkDataSubscribersTransferred, 10);
  assert.equal(during.chunkDataWorkerCancelRequests, 0);
  const dependencyDuring = controlled.runtime.snapshot().terrainReady.terrainDependencyDiagnostics;
  assert.equal(dependencyDuring.terrainDependencyOwnerCount, 25);
  assert.equal(dependencyDuring.terrainDependencyCacheHits, 10);
  assert.equal(dependencyDuring.terrainDependencyReusedRequests, 10);
  assert.equal(dependencyDuring.terrainDependencyNewRequests, 5);

  controlled.releaseHeld('100,0');
  assert.equal((await blockerA.promise).chunkX, 100);
  controlled.releaseHeld('101,0');
  assert.equal((await blockerB.promise).chunkX, 101);
  assert.equal(await workA, null);
  assert.ok(await workB);
  const diagnostics = controlled.runtime.snapshot().terrainReady.chunkDataSubscriberDiagnostics;
  assert.equal(controlled.callCountByOwner.get('3,0'), 1);
  assert.equal(diagnostics.chunkDataSameOwnerRerequestCount, 0);
  assert.equal(diagnostics.chunkDataResponsesInsertedAfterPlanSupersede > 0, true);
  assert.equal(diagnostics.chunkDataWorkerCancelRequests, 0);
});

test('READY plan supersede preserves the shared in-flight ChunkData owner and requests only five entering owners', async t => {
  const controlled = await createControlledChunkDataRuntime('p2e-owner-transfer');
  const planA = movingReadyPlan({
    runtimeCenter: { chunkX: 0, chunkZ: 0 },
    playerCenter: { chunkX: 0, chunkZ: 0 },
    direction: { x: 1, z: 0 },
  });
  const planB = movingReadyPlan({
    runtimeCenter: { chunkX: 0, chunkZ: 0 },
    playerCenter: { chunkX: 1, chunkZ: 0 },
    direction: { x: 1, z: 0 },
  });
  const dataA = new Set(planA.dataCoordinates.map(value => value.key));
  const dataB = new Set(planB.dataCoordinates.map(value => value.key));
  const overlap = [...dataA].filter(key => dataB.has(key));
  const entering = [...dataB].filter(key => !dataA.has(key));
  assert.equal(dataA.size, 60);
  assert.equal(dataB.size, 60);
  assert.equal(overlap.length, 55);
  assert.equal(entering.length, 5);

  const workA = controlled.runtime.updateTerrainReadySet(planA);
  await controlled.delayedStarted;
  const requestBefore = controlled.chunkDataService.snapshot();
  assert.equal(requestBefore.inFlightKey, '3,-1');
  const workB = controlled.runtime.updateTerrainReadySet(planB);
  const during = controlled.runtime.snapshot().terrainReady.chunkDataSubscriberDiagnostics;
  assert.deepEqual(during.lastOwnerSetDiff, { unchanged: 55, entering: 5, leaving: 5 });
  assert.equal(during.chunkDataSubscribersTransferred, 1);
  assert.equal(during.chunkDataUnderlyingRequestsReused, 1);
  assert.equal(during.chunkDataWorkerCancelRequests, 0);
  assert.equal(during.chunkDataDuplicateRequests, 0);
  assert.equal(controlled.workerCancelRequests.length, 0);
  assert.equal(controlled.chunkDataService.snapshot().inFlightKey, '3,-1');

  controlled.releaseDelayed();
  assert.equal(await workA, null);
  assert.ok(await workB);
  const snapshot = controlled.runtime.snapshot();
  const diagnostics = snapshot.terrainReady.chunkDataSubscriberDiagnostics;
  const delayedOwner = diagnostics.ownerDiagnostics.find(value => value.ownerKey === '3,-1');
  assert.equal(controlled.callCountByOwner.get('3,-1'), 1);
  assert.ok(entering.every(key => controlled.callCountByOwner.get(key) === 1));
  assert.equal(diagnostics.chunkDataWorkerCancelRequests, 0);
  assert.equal(diagnostics.chunkDataSameOwnerRerequestCount, 0);
  assert.equal(diagnostics.chunkDataResponsesInsertedAfterPlanSupersede > 0, true);
  assert.deepEqual(delayedOwner, {
    ownerKey: '3,-1',
    requestCount: 1,
    cancelCount: 0,
    completionCount: 1,
    cacheInsertCount: 1,
  });
  assert.equal(snapshot.terrainReady.planReady, true);
  assert.equal(snapshot.terrainReady.queueDepth, 0);
  assert.equal(diagnostics.cachePressure.capacityOverflowRisk, false);
  t.diagnostic(JSON.stringify({
    planAOwners: dataA.size,
    planBOwners: dataB.size,
    overlapOwners: overlap.length,
    enteringOwners: entering.length,
    leavingOwners: diagnostics.lastOwnerSetDiff.leaving,
    subscribersTransferred: diagnostics.chunkDataSubscribersTransferred,
    underlyingRequestsReused: diagnostics.chunkDataUnderlyingRequestsReused,
    workerCancelRequests: diagnostics.chunkDataWorkerCancelRequests,
    sameOwnerRerequestCount: diagnostics.chunkDataSameOwnerRerequestCount,
    cachePressure: diagnostics.cachePressure,
  }));
  await controlled.runtime.shutdown();
  await controlled.chunkDataService.shutdown();
});

test('700ms ChunkData tail survives two 334ms READY plan updates and reaches dependency READY once', async t => {
  const controlled = await createControlledChunkDataRuntime('p2e-tail-latency', { delayMs: 750 });
  const planForCenter = chunkX => movingReadyPlan({
    runtimeCenter: { chunkX: 0, chunkZ: 0 },
    playerCenter: { chunkX, chunkZ: 0 },
    direction: { x: 1, z: 0 },
  });
  const startedAtMs = performance.now();
  const workA = controlled.runtime.updateTerrainReadySet(planForCenter(0));
  await controlled.delayedStarted;
  await new Promise(resolve => setTimeout(resolve, 334));
  const workB = controlled.runtime.updateTerrainReadySet(planForCenter(1));
  await new Promise(resolve => setTimeout(resolve, 334));
  const workC = controlled.runtime.updateTerrainReadySet(planForCenter(2));
  const [resultA, resultB, resultC] = await Promise.all([workA, workB, workC]);
  const elapsedMs = performance.now() - startedAtMs;
  assert.equal(resultA, null);
  assert.equal(resultB, null);
  assert.ok(resultC);
  assert.ok(elapsedMs >= 700 && elapsedMs < 1_500, `unexpected tail duration ${elapsedMs}`);

  const snapshot = controlled.runtime.snapshot();
  const diagnostics = snapshot.terrainReady.chunkDataSubscriberDiagnostics;
  const delayedOwner = diagnostics.ownerDiagnostics.find(value => value.ownerKey === '3,-1');
  assert.equal(diagnostics.chunkDataSubscribersTransferred >= 2, true);
  assert.equal(diagnostics.chunkDataUnderlyingRequestsReused,
    diagnostics.chunkDataSubscribersTransferred);
  assert.equal(diagnostics.chunkDataUnderlyingRequestsCancelled, 0);
  assert.equal(diagnostics.chunkDataWorkerCancelRequests, 0);
  assert.equal(diagnostics.chunkDataSameOwnerRerequestCount, 0);
  assert.equal(diagnostics.chunkDataResponsesInsertedAfterPlanSupersede > 0, true);
  assert.equal(controlled.workerCancelRequests.length, 0);
  assert.equal(controlled.callCountByOwner.get('3,-1'), 1);
  assert.equal(delayedOwner.requestCount, 1);
  assert.equal(delayedOwner.cancelCount, 0);
  assert.equal(delayedOwner.completionCount, 1);
  assert.equal(delayedOwner.cacheInsertCount, 1);
  assert.equal(snapshot.terrainReady.planReady, true);
  assert.equal(snapshot.terrainReady.queueDepth, 0);
  t.diagnostic(JSON.stringify({
    configuredTailMs: 750,
    arrivalIntervalMs: 334,
    elapsedMs,
    subscribersTransferred: diagnostics.chunkDataSubscribersTransferred,
    workerCancelRequests: diagnostics.chunkDataWorkerCancelRequests,
    sameOwnerRerequestCount: diagnostics.chunkDataSameOwnerRerequestCount,
    cachePressure: diagnostics.cachePressure,
  }));
  await controlled.runtime.shutdown();
  await controlled.chunkDataService.shutdown();
});

test('latest Terrain 5x5 registers as a bounded batch and a 750ms tail does not serialize 24 owners', async t => {
  const source = await createSandboxChunkGenerator({ worldSeed: 'p2g-latest-dependency-tail' });
  const template = await source.generateChunk(0, 0);
  const plan = movingReadyPlan({
    runtimeCenter: { chunkX: 0, chunkZ: 0 },
    playerCenter: { chunkX: 0, chunkZ: 0 },
    direction: { x: 1, z: 0 },
  });
  const dependencyCoordinates = plan.dataCoordinates.filter(value => value.visibleRequired === true);
  assert.equal(dependencyCoordinates.length, 25);
  const dependencyKeys = new Set(dependencyCoordinates.map(value => value.key));
  const shortDelayByKey = new Map(dependencyCoordinates.map((value, index) => (
    [value.key, 10 + index % 3 * 10]
  )));
  const tailKeys = ['0,0', dependencyCoordinates.at(-1).key];
  const serialDelayMs = [...shortDelayByKey.values()].reduce((sum, value) => sum + value, 0)
    - shortDelayByKey.get(tailKeys[0]) + 750;
  const serialStartedAtMs = performance.now();
  for (const [key, shortDelayMs] of shortDelayByKey) {
    const delayMs = key === tailKeys[0] ? 750 : shortDelayMs;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  const measuredSerialMs = performance.now() - serialStartedAtMs;
  assert.ok(measuredSerialMs >= serialDelayMs * 0.8);

  const rows = [];
  for (const tailKey of tailKeys) {
    const requestCountByOwner = new Map();
    const pipelineEvents = [];
    const fastChunk = (chunkX, chunkZ) => Object.freeze({
      ...template,
      chunkX,
      chunkZ,
      chunkId: `p2g-tail-chunk:${tailKey}:${chunkX},${chunkZ}`,
      vegetationProxies: Object.freeze([]),
      rockProxies: Object.freeze([]),
      contentHash: `sha256:${`${chunkX < 0 ? '1' : '0'}${Math.abs(chunkX)
        .toString(16).padStart(15, '0')}${chunkZ < 0 ? '1' : '0'}${Math.abs(chunkZ)
        .toString(16).padStart(15, '0')}`.padEnd(64, '0')}`,
    });
    const transport = {
      async initialize() {
        return {
          worldSeed: source.worldSeed,
          worldSeedHash: source.worldSeedHash,
          generatorVersion: source.generatorVersion,
          experienceSpawn: source.experienceSpawn,
          reviewSpawn: source.reviewSpawn,
        };
      },
      async generateChunk(request) {
        const key = `${request.chunkX},${request.chunkZ}`;
        requestCountByOwner.set(key, (requestCountByOwner.get(key) ?? 0) + 1);
        if (dependencyKeys.has(key)) {
          const delayMs = key === tailKey ? 750 : shortDelayByKey.get(key);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        return fastChunk(request.chunkX, request.chunkZ);
      },
      cancelGenerationRequest: () => false,
      snapshot: () => Object.freeze({ kind: 'p2g-tail-latency' }),
      shutdown: () => Promise.resolve(),
    };
    const chunkDataService = new ChunkDataService({ transport, cacheCapacity: 81 });
    await chunkDataService.initialize();
    const runtime = new ChunkRuntimeManager({
      chunkDataService,
      renderAdapter: new PreparedAdapter(),
      cacheCapacity: 81,
      yieldToHost: () => Promise.resolve(),
      onPipelineEvent: (type, details) => pipelineEvents.push({ type, ...details }),
    });
    const startedAtMs = performance.now();
    const work = runtime.updateTerrainReadySet(plan);
    const registered = runtime.snapshot().terrainReady.terrainDependencyDiagnostics;
    assert.equal(registered.terrainDependencyOwnerCount, 25);
    assert.equal(registered.terrainDependencyCacheHits, 0);
    assert.equal(registered.terrainDependencyBatchRegistered, 25);
    assert.equal(registered.terrainDependencyNewRequests, 25);
    assert.equal(registered.terrainDependencyReusedRequests, 0);
    assert.ok(registered.registrationDurationMs < 33,
      `dependency registration exceeded one frame: ${registered.registrationDurationMs}`);
    assert.ok(registered.targetToAllDependencyRequestsRegisteredMs < 33);
    assert.ok(registered.targetToFirstDependencyRequestRegisteredMs < 33);
    await work;
    const elapsedMs = performance.now() - startedAtMs;
    const snapshot = runtime.snapshot();
    const dependency = snapshot.terrainReady.terrainDependencyDiagnostics;
    const subscribers = snapshot.terrainReady.chunkDataSubscriberDiagnostics;
    const scheduler = chunkDataService.snapshot().scheduler;
    assert.equal(dependency.terrainDependencyCompleted, 25);
    assert.equal(dependency.terrainDependencyCancelled, 0);
    assert.ok(dependency.targetToAllDependenciesResolvedMs >= 700);
    assert.ok(dependency.targetToAllDependenciesResolvedMs < measuredSerialMs,
      `batch ${dependency.targetToAllDependenciesResolvedMs}ms was not faster than serial ${measuredSerialMs}ms`);
    assert.ok(dependency.terrainDependencyLastOwnerWaitMs >= 700);
    assert.ok(dependency.terrainDependencyP95Ms > 0);
    assert.ok(dependency.terrainDependencyMaxMs >= 700);
    assert.equal(subscribers.chunkDataDuplicateRequests, 0);
    assert.equal(subscribers.chunkDataSameOwnerRerequestCount, 0);
    assert.equal(subscribers.chunkDataWorkerCancelRequests, 0);
    assert.equal([...dependencyKeys].every(key => requestCountByOwner.get(key) === 1), true);
    const ownerRequests = pipelineEvents.filter(event => (
      event.type === 'runtime-terrain-ready-owner-requested'
    ));
    const priorityByOwner = new Map(ownerRequests.map(event => [event.ownerKey, event.priority]));
    assert.equal(priorityByOwner.get('0,0'), 1);
    assert.equal(priorityByOwner.get('-1,-1'), 2);
    assert.equal(priorityByOwner.get('-2,-2'), 3);
    assert.equal(ownerRequests.some(event => event.priorityClass === 2 && event.priority === 4), true);
    assert.equal(ownerRequests.some(event => event.priorityClass === 3 && event.priority === 5), true);
    assert.equal(scheduler.workerCount, 1);
    assert.ok(scheduler.queueWaitMs.count >= 25);
    assert.ok(elapsedMs >= dependency.targetToAllDependenciesResolvedMs);
    rows.push({
      tailKey,
      dependencyWaitMs: dependency.terrainDependencyWaitMs,
      allDependenciesResolvedMs: dependency.targetToAllDependenciesResolvedMs,
      registrationDurationMs: dependency.registrationDurationMs,
      runtimeRequestP50Ms: dependency.terrainDependencyP50Ms,
      runtimeRequestP95Ms: dependency.terrainDependencyP95Ms,
      runtimeRequestMaxMs: dependency.terrainDependencyMaxMs,
      workerQueueWaitMs: scheduler.queueWaitMs,
      cachePressure: subscribers.cachePressure,
    });
    await runtime.shutdown();
    await chunkDataService.shutdown();
  }
  await source.shutdown?.();
  t.diagnostic(JSON.stringify({
    serialDelayMs,
    measuredSerialMs,
    boundedBatchCases: rows,
  }));
});

test('334ms MAX Sprint batches preserve shared dependencies through straight, diagonal, turn, and reversal', async t => {
  const arrivalIntervalMs = 334;
  const controlled = await createControlledChunkDataRuntime('p2g-334ms-direction-stress', {
    delayedOwnerKey: '3,-1',
    delayMs: 750,
  });
  const movement = [
    { playerCenter: { chunkX: 0, chunkZ: 0 }, direction: { x: 1, z: 0 } },
    { playerCenter: { chunkX: 1, chunkZ: 0 }, direction: { x: 1, z: 0 } },
    { playerCenter: { chunkX: 1, chunkZ: 1 }, direction: { x: 1, z: 1 } },
    { playerCenter: { chunkX: 1, chunkZ: 1 }, direction: { x: 0, z: 1 } },
    { playerCenter: { chunkX: 1, chunkZ: 0 }, direction: { x: 0, z: -1 } },
  ];
  const work = [];
  for (let index = 0; index < movement.length; index += 1) {
    work.push(controlled.runtime.updateTerrainReadySet(movingReadyPlan({
      runtimeCenter: { chunkX: 0, chunkZ: 0 },
      ...movement[index],
    })));
    const dependency = controlled.runtime.snapshot().terrainReady.terrainDependencyDiagnostics;
    assert.equal(dependency.terrainDependencyOwnerCount, 25);
    assert.ok(dependency.registrationDurationMs < 33);
    if (index < movement.length - 1) {
      await new Promise(resolve => setTimeout(resolve, arrivalIntervalMs));
    }
  }
  const outcomes = await Promise.allSettled(work);
  assert.deepEqual(outcomes.filter(value => value.status === 'rejected'), []);
  assert.ok(outcomes.at(-1).value);
  const snapshot = controlled.runtime.snapshot();
  const dependency = snapshot.terrainReady.terrainDependencyDiagnostics;
  const subscribers = snapshot.terrainReady.chunkDataSubscriberDiagnostics;
  assert.equal(dependency.targetCenterKey, '1,0');
  assert.equal(dependency.terrainDependencyCompleted, 25);
  assert.equal(dependency.terrainDependencyCancelled, 0);
  assert.equal(dependency.maximumRegistrationDurationMs < 33, true);
  assert.equal(subscribers.chunkDataSubscribersTransferred > 0, true);
  assert.equal(subscribers.chunkDataUnderlyingRequestsReused > 0, true);
  assert.equal(subscribers.chunkDataDuplicateRequests, 0);
  assert.equal(subscribers.chunkDataSameOwnerRerequestCount <= 1, true,
    'the reversal may re-enter one already-cancelled corridor-only owner');
  assert.equal(subscribers.chunkDataWorkerCancelRequests, 0);
  assert.equal(controlled.callCountByOwner.get('3,-1'), 1);
  assert.equal(snapshot.counts.terrainReadyGateBlockedFrames, 0);
  t.diagnostic(JSON.stringify({
    arrivalIntervalMs,
    movement,
    terrainDependencyBatchCount: dependency.batchesRegistered,
    maximumRegistrationDurationMs: dependency.maximumRegistrationDurationMs,
    terrainDependencyWaitMs: dependency.terrainDependencyWaitMs,
    subscribersTransferred: subscribers.chunkDataSubscribersTransferred,
    underlyingRequestsReused: subscribers.chunkDataUnderlyingRequestsReused,
    duplicateRequests: subscribers.chunkDataDuplicateRequests,
    sameOwnerRerequestCount: subscribers.chunkDataSameOwnerRerequestCount,
    workerCancelRequests: subscribers.chunkDataWorkerCancelRequests,
    cachePressure: subscribers.cachePressure,
  }));
  await controlled.runtime.shutdown();
  await controlled.chunkDataService.shutdown();
});

test('Terrain presentation direction reversal completes in-flight staging and publishes only the latest center', async () => {
  const presentation = new TerrainPresentationGenerationAdapter();
  const basePrepare = presentation.prepare.bind(presentation);
  let releaseFirst;
  let notifyFirst;
  let first = true;
  const firstStarted = new Promise(resolve => { notifyFirst = resolve; });
  presentation.prepare = async options => {
    if (first) {
      first = false;
      notifyFirst();
      await new Promise(resolve => { releaseFirst = resolve; });
      if (!options.isCurrent()) return Object.freeze({ prepared: false });
    }
    return basePrepare(options);
  };
  const { runtime, chunkDataService } = await createRuntime('p1b-presentation-reversal', {
    terrainPresentationAdapter: presentation,
  });
  const eastPlan = readyPlan({ path: 'straight' });
  const eastWork = runtime.updateTerrainReadySet(eastPlan);
  await firstStarted;
  const profile = getW6ScaleProfile('MAX');
  const northPlan = planRuntimeTerrainReadySet({
    centerChunkX: 0,
    centerChunkZ: 0,
    logicalX: 8,
    logicalZ: 8,
    velocityX: 0,
    velocityZ: -profile.sprintMetersPerSecond,
    speedMetersPerSecond: profile.sprintMetersPerSecond,
    scaleStageId: 'MAX',
    sprint: true,
  });
  const northWork = runtime.updateTerrainReadySet(northPlan);
  releaseFirst();
  await eastWork;
  await northWork;
  const ready = await waitForTerrainPresentationReady(runtime, 1);
  assert.ok(ready.every(entry => entry.centerKey.endsWith(',-1')));
  const next = northPlan.corridorCenters[1];
  await runtime.transitionToChunk(next.chunkX, next.chunkZ, { required: true });
  const snapshot = runtime.snapshot();
  assert.equal(presentation.claimed.length, 1);
  assert.equal(presentation.claimed[0].presentationGeneration.identity.startsWith(
    `${next.key}|`,
  ), true);
  assert.equal(snapshot.counts.terrainPresentationGenerationsStarted, 2);
  assert.equal(snapshot.counts.terrainPresentationGenerationsCompleted, 2);
  assert.equal(snapshot.counts.terrainPresentationGenerationsCancelled, 0);
  assert.ok(snapshot.counts.terrainPresentationGenerationsDiscarded > 0);
  assert.ok(snapshot.counts.terrainPresentationCompletedUnclaimedDiscards > 0);
  assert.equal(snapshot.terrainReady.recentTerrainPresentationGenerations.some(entry => (
    entry.outcome === 'discarded'
      && entry.discardReason === 'completed-obsolete-before-claim'
  )), true);
  assert.equal(snapshot.counts.terrainPresentationStalePublishes, 0);
  assert.equal(snapshot.counts.terrainPresentationDuplicateGenerations, 0);
  await runtime.shutdown();
  await chunkDataService.shutdown();
});

test('MAX Sprint coalesces straight, diagonal, turn, reversal, and zigzag arrivals behind one non-cancellable generation', async () => {
  const presentation = new ControlledTerrainPresentationGenerationAdapter();
  const { runtime, chunkDataService } = await createRuntime('p2b-presentation-coalescing', {
    terrainPresentationAdapter: presentation,
  });
  const runtimeCenter = { chunkX: 0, chunkZ: 0 };
  await runtime.updateTerrainReadySet(movingReadyPlan({
    runtimeCenter,
    playerCenter: runtimeCenter,
    direction: { x: 1, z: 0 },
  }));
  const firstStart = await waitForTerrainPresentationStart(presentation, 1);
  const firstCenter = {
    chunkX: firstStart.options.centerChunkX,
    chunkZ: firstStart.options.centerChunkZ,
  };
  assert.equal(typeof firstStart.options.isUrgent, 'function');
  assert.equal(firstStart.options.isUrgent(), false,
    'corridor-only Terrain preparation remains normal priority before arrival');
  const firstTransition = runtime.transitionToChunk(
    firstCenter.chunkX,
    firstCenter.chunkZ,
    { required: true },
  );
  const movement = [
    { playerCenter: { chunkX: 1, chunkZ: 0 }, direction: { x: 1, z: 0 } },
    { playerCenter: { chunkX: 2, chunkZ: 0 }, direction: { x: 1, z: 0 } },
    { playerCenter: { chunkX: 3, chunkZ: 1 }, direction: { x: 1, z: 1 } },
    { playerCenter: { chunkX: 3, chunkZ: 2 }, direction: { x: 0, z: 1 } },
    { playerCenter: { chunkX: 2, chunkZ: 2 }, direction: { x: -1, z: 0 } },
    { playerCenter: { chunkX: 3, chunkZ: 1 }, direction: { x: 1, z: -1 } },
  ];
  const readyWork = movement.map(value => runtime.updateTerrainReadySet(movingReadyPlan({
    runtimeCenter,
    ...value,
  })));
  assert.equal(firstStart.options.isUrgent(), true,
    'visible-center lag promotes the in-flight Terrain continuation to urgent');
  let scheduling = runtime.snapshot().terrainReady.terrainPresentationScheduling;
  assert.deepEqual(scheduling.inFlightCenter && {
    chunkX: scheduling.inFlightCenter.chunkX,
    chunkZ: scheduling.inFlightCenter.chunkZ,
  }, firstCenter);
  assert.deepEqual(scheduling.pendingCenter && {
    chunkX: scheduling.pendingCenter.chunkX,
    chunkZ: scheduling.pendingCenter.chunkZ,
  }, movement.at(-1).playerCenter);
  firstStart.release();
  await firstTransition;
  const readyOutcomes = await Promise.allSettled(readyWork);
  assert.deepEqual(readyOutcomes.filter(value => value.status === 'rejected'), []);
  const secondStart = await waitForTerrainPresentationStart(presentation, 2);
  assert.equal(secondStart.options.centerChunkX, movement.at(-1).playerCenter.chunkX);
  assert.equal(secondStart.options.centerChunkZ, movement.at(-1).playerCenter.chunkZ);
  const secondTransition = runtime.transitionToChunk(
    secondStart.options.centerChunkX,
    secondStart.options.centerChunkZ,
    { required: true },
  );
  secondStart.release();
  await secondTransition;

  const snapshot = runtime.snapshot();
  scheduling = snapshot.terrainReady.terrainPresentationScheduling;
  const chunkDataSubscribers = snapshot.terrainReady.chunkDataSubscriberDiagnostics;
  assert.equal(snapshot.counts.terrainPresentationGenerationsStarted, 2);
  assert.equal(snapshot.counts.terrainPresentationGenerationsCompleted, 2);
  assert.equal(snapshot.counts.terrainPresentationGenerationsClaimed, 2);
  assert.equal(snapshot.counts.terrainPresentationGenerationsCancelled, 0);
  assert.equal(snapshot.counts.terrainPresentationGenerationsCoalesced >= 4, true);
  assert.equal(snapshot.counts.terrainPresentationCatchupSteps, 0,
    'latest-target direct catch-up avoids serial intermediate generations');
  assert.equal(snapshot.counts.terrainPresentationReuseRatio, 0.94);
  assert.equal(snapshot.counts.terrainPresentationDuplicateGenerations, 0);
  assert.equal(snapshot.counts.terrainPresentationStalePublishes, 0);
  assert.equal(snapshot.counts.terrainReadyGateBlockedFrames, 0);
  assert.equal(chunkDataSubscribers.chunkDataWorkerCancelRequests, 0);
  assert.equal(chunkDataSubscribers.chunkDataSameOwnerRerequestCount <= 1, true,
    'a same-turn zigzag may legitimately leave and re-enter one owner');
  assert.equal(chunkDataSubscribers.chunkDataDuplicateRequests, 0);
  assert.equal(scheduling.inFlightCenter, null);
  assert.equal(scheduling.pendingCenter, null);
  assert.deepEqual(scheduling.activeCenter, {
    chunkX: movement.at(-1).playerCenter.chunkX,
    chunkZ: movement.at(-1).playerCenter.chunkZ,
    key: `${movement.at(-1).playerCenter.chunkX},${movement.at(-1).playerCenter.chunkZ}`,
  });
  assert.deepEqual(scheduling.playerCenter, scheduling.activeCenter);
  await runtime.shutdown();
  await chunkDataService.shutdown();
});

test('Terrain scheduler starts the latest pending generation before the prior READY claim completes', async t => {
  const generationDelayMs = 500;
  const arrivalIntervalMs = 334;
  const claimDelayMs = 120;
  const presentation = new TimedTerrainPresentationGenerationAdapter({ generationDelayMs });
  const { runtime, adapter, chunkDataService } = await createRuntime(
    'p2c-presentation-completion-drain',
    { terrainPresentationAdapter: presentation, fastChunks: true },
  );
  await runtime.updateTerrainReadySet(movingReadyPlan({
    runtimeCenter: { chunkX: 0, chunkZ: 0 },
    playerCenter: { chunkX: 0, chunkZ: 0 },
    direction: { x: 1, z: 0 },
  }));
  const firstStart = await waitForTerrainPresentationStart(presentation, 1);
  const firstTarget = {
    chunkX: firstStart.options.centerChunkX,
    chunkZ: firstStart.options.centerChunkZ,
  };
  const originalRebase = adapter.rebase.bind(adapter);
  let claimDelayStarted;
  const claimDelayStart = new Promise(resolve => { claimDelayStarted = resolve; });
  adapter.rebase = async origin => {
    claimDelayStarted();
    await new Promise(resolve => setTimeout(resolve, claimDelayMs));
    return originalRebase(origin);
  };
  let firstTransitionSettled = false;
  const firstTransition = runtime.transitionToChunk(
    firstTarget.chunkX,
    firstTarget.chunkZ,
    { required: true },
  ).finally(() => { firstTransitionSettled = true; });

  await new Promise(resolve => setTimeout(resolve, arrivalIntervalMs));
  const secondTarget = { chunkX: firstTarget.chunkX + 1, chunkZ: firstTarget.chunkZ };
  await runtime.updateTerrainReadySet(movingReadyPlan({
    runtimeCenter: { chunkX: 0, chunkZ: 0 },
    playerCenter: secondTarget,
    direction: { x: 1, z: 0 },
  }));
  const pendingSnapshot = runtime.snapshot().terrainReady.terrainPresentationScheduling;
  assert.equal(pendingSnapshot.inFlightCenter.key, `${firstTarget.chunkX},${firstTarget.chunkZ}`);
  assert.equal(pendingSnapshot.pendingCenter.key, `${secondTarget.chunkX},${secondTarget.chunkZ}`);

  await claimDelayStart;
  const secondStart = await waitForTerrainPresentationStart(presentation, 2);
  assert.equal(firstTransitionSettled, false,
    'the next generation starts while the previous READY generation remains claimable');
  assert.equal(secondStart.options.centerChunkX, secondTarget.chunkX);
  assert.equal(secondStart.options.centerChunkZ, secondTarget.chunkZ);
  let snapshot = runtime.snapshot();
  let scheduling = snapshot.terrainReady.terrainPresentationScheduling;
  assert.equal(scheduling.inFlightCenter.key, `${secondTarget.chunkX},${secondTarget.chunkZ}`);
  assert.equal(scheduling.pendingCenter, null,
    'pending clears atomically after promotion to the single in-flight slot');
  assert.equal(scheduling.terrainSchedulerIdleWithPendingCount, 0);
  assert.equal(scheduling.terrainSchedulerIdleWithPendingMs, 0);
  assert.ok(scheduling.maxPendingWaitMs >= 100);
  const liveFirst = snapshot.terrainReady.terrainPresentationGenerations
    .find(entry => entry.centerKey === `${firstTarget.chunkX},${firstTarget.chunkZ}`);
  const liveSecond = snapshot.terrainReady.terrainPresentationGenerations
    .find(entry => entry.centerKey === `${secondTarget.chunkX},${secondTarget.chunkZ}`);
  assert.equal(liveFirst?.state, 'ready');
  assert.equal(liveSecond?.state, 'building');
  assert.ok(liveSecond.pendingEnteredAtMs <= liveSecond.pendingPromotedAtMs);
  assert.ok(liveSecond.pendingPromotedAtMs <= liveSecond.inFlightStartedAtMs);

  await firstTransition;
  await runtime.transitionToChunk(secondTarget.chunkX, secondTarget.chunkZ, { required: true });
  snapshot = runtime.snapshot();
  scheduling = snapshot.terrainReady.terrainPresentationScheduling;
  assert.equal(snapshot.counts.terrainPresentationGenerationsStarted, 2);
  assert.equal(snapshot.counts.terrainPresentationGenerationsCompleted, 2);
  assert.equal(snapshot.counts.terrainPresentationGenerationsClaimed, 2);
  assert.equal(snapshot.counts.terrainPresentationGenerationsCancelled, 0);
  assert.equal(snapshot.counts.terrainPresentationCompletedUnclaimedDiscards, 0);
  assert.equal(snapshot.counts.terrainPresentationDuplicateGenerations, 0);
  assert.equal(snapshot.counts.terrainPresentationStalePublishes, 0);
  assert.equal(scheduling.terrainSchedulerIdleWithPendingCount, 0);
  assert.equal(scheduling.terrainSchedulerIdleWithPendingMs, 0);
  assert.equal(scheduling.inFlightCenter, null);
  assert.equal(scheduling.pendingCenter, null);
  const claimedHistory = snapshot.terrainReady.recentTerrainPresentationGenerations
    .filter(entry => entry.outcome === 'claimed');
  assert.equal(claimedHistory.length, 2);
  assert.ok(claimedHistory.every(entry => entry.completedAtMs <= entry.claimedAtMs));
  t.diagnostic(JSON.stringify({
    generationDelayMs,
    arrivalIntervalMs,
    claimDelayMs,
    requested: snapshot.counts.terrainPresentationGenerationsRequested,
    started: snapshot.counts.terrainPresentationGenerationsStarted,
    completed: snapshot.counts.terrainPresentationGenerationsCompleted,
    claimed: snapshot.counts.terrainPresentationGenerationsClaimed,
    cancelled: snapshot.counts.terrainPresentationGenerationsCancelled,
    schedulerIdleWithPendingCount: scheduling.terrainSchedulerIdleWithPendingCount,
    schedulerIdleWithPendingMs: scheduling.terrainSchedulerIdleWithPendingMs,
    maxPendingWaitMs: scheduling.maxPendingWaitMs,
  }));
  await runtime.shutdown();
  await chunkDataService.shutdown();
});

test('production-like 60-second MAX Sprint keeps one generation in flight while 180 arrivals coalesce', async t => {
  const presentation = new ControlledTerrainPresentationGenerationAdapter({ reuseRatio: 0.94 });
  const { runtime, chunkDataService } = await createRuntime('p2b-60-second-max-sprint', {
    terrainPresentationAdapter: presentation,
    fastChunks: true,
  });
  let playerStep = 0;
  let startCount = 0;
  let maximumLagChunks = 0;
  let presentationSwapCount = 0;
  const totalArrivals = 180;
  await runtime.updateTerrainReadySet(movingReadyPlan({
    runtimeCenter: maxSprintStressCenter(0),
    playerCenter: maxSprintStressCenter(0),
    direction: maxSprintStressDirection(0),
  }));

  while (playerStep < totalArrivals || !runtime.isCenteredAt(
    maxSprintStressCenter(playerStep).chunkX,
    maxSprintStressCenter(playerStep).chunkZ,
  )) {
    const start = await waitForTerrainPresentationStart(presentation, ++startCount, 20_000);
    const target = {
      chunkX: start.options.centerChunkX,
      chunkZ: start.options.centerChunkZ,
    };
    const transition = runtime.transitionToChunk(target.chunkX, target.chunkZ, { required: true });
    const readyWork = [];
    for (let arrival = 0; arrival < 2 && playerStep < totalArrivals; arrival += 1) {
      playerStep += 1;
      const active = runtime.getCommittedChunkState();
      readyWork.push(runtime.updateTerrainReadySet(movingReadyPlan({
        runtimeCenter: { chunkX: active.centerChunkX, chunkZ: active.centerChunkZ },
        playerCenter: maxSprintStressCenter(playerStep),
        direction: maxSprintStressDirection(playerStep),
      })));
      const player = maxSprintStressCenter(playerStep);
      maximumLagChunks = Math.max(maximumLagChunks, Math.max(
        Math.abs(player.chunkX - active.centerChunkX),
        Math.abs(player.chunkZ - active.centerChunkZ),
      ));
    }
    start.release();
    const committed = await transition;
    presentationSwapCount += Number(committed?.terrainPresentationClaimed === true);
    await Promise.allSettled(readyWork);
    if (playerStep < totalArrivals) {
      const active = runtime.getCommittedChunkState();
      await runtime.updateTerrainReadySet(movingReadyPlan({
        runtimeCenter: { chunkX: active.centerChunkX, chunkZ: active.centerChunkZ },
        playerCenter: maxSprintStressCenter(playerStep),
        direction: maxSprintStressDirection(playerStep),
      }));
    }
  }

  const snapshot = runtime.snapshot();
  const scheduling = snapshot.terrainReady.terrainPresentationScheduling;
  const chunkDataSubscribers = snapshot.terrainReady.chunkDataSubscriberDiagnostics;
  const terrainDependencies = snapshot.terrainReady.terrainDependencyDiagnostics;
  const completionRate = snapshot.counts.terrainPresentationGenerationsCompleted
    / snapshot.counts.terrainPresentationGenerationsStarted;
  const active = scheduling.activeCenter;
  const player = maxSprintStressCenter(totalArrivals);
  const latestLagChunks = Math.max(
    Math.abs(player.chunkX - active.chunkX),
    Math.abs(player.chunkZ - active.chunkZ),
  );
  assert.equal(snapshot.counts.terrainPresentationGenerationsCancelled, 0);
  assert.equal(completionRate >= 0.95, true);
  assert.equal(snapshot.counts.terrainPresentationGenerationsStarted,
    snapshot.counts.terrainPresentationGenerationsCompleted);
  assert.equal(snapshot.counts.terrainPresentationGenerationsCompleted,
    snapshot.counts.terrainPresentationGenerationsClaimed);
  assert.equal(snapshot.counts.terrainPresentationGenerationsCoalesced > 0, true);
  assert.equal(presentationSwapCount, snapshot.counts.terrainPresentationGenerationsClaimed);
  assert.equal(latestLagChunks <= 2, true);
  assert.equal(maximumLagChunks <= 4, true);
  assert.equal(maximumLagChunks * 16 + 8 <= 352, true,
    'the active complete Terrain extent continues to cover the player owner');
  assert.equal(snapshot.counts.terrainPresentationCatchupSteps, 0);
  assert.ok(Math.abs(snapshot.counts.terrainPresentationReuseRatio - 0.94) < 1e-12);
  assert.equal(
    Object.values(scheduling.terrainPresentationJumpHistogram)
      .reduce((sum, count) => sum + count, 0),
    snapshot.counts.terrainPresentationGenerationsCompleted - 1,
  );
  for (const [band, count] of Object.entries(scheduling.terrainPresentationJumpHistogram)) {
    assert.equal(
      count === 0 || Number.isFinite(scheduling.terrainPresentationReuseRatioByJump[band]),
      true,
    );
  }
  assert.equal(snapshot.counts.terrainPresentationDuplicateGenerations, 0);
  assert.equal(snapshot.counts.terrainPresentationStalePublishes, 0);
  assert.equal(snapshot.counts.terrainReadyGateBlockedFrames, 0);
  assert.equal(chunkDataSubscribers.chunkDataWorkerCancelRequests, 0);
  assert.equal(chunkDataSubscribers.chunkDataSameOwnerRerequestCount, 0);
  assert.equal(chunkDataSubscribers.chunkDataDuplicateRequests, 0);
  assert.equal(scheduling.terrainSchedulerIdleWithPendingCount, 0);
  assert.equal(scheduling.terrainSchedulerIdleWithPendingMs, 0);
  assert.equal(terrainDependencies.terrainDependencyOwnerCount, 25);
  assert.equal(terrainDependencies.terrainDependencyCompleted, 25);
  assert.equal(terrainDependencies.terrainDependencyCancelled, 0);
  assert.equal(terrainDependencies.maximumRegistrationDurationMs < 33, true);
  t.diagnostic(JSON.stringify({
    simulatedSeconds: 60.12,
    arrivalIntervalMs: 334,
    arrivalCount: totalArrivals,
    requested: snapshot.counts.terrainPresentationGenerationsRequested,
    started: snapshot.counts.terrainPresentationGenerationsStarted,
    completed: snapshot.counts.terrainPresentationGenerationsCompleted,
    claimed: snapshot.counts.terrainPresentationGenerationsClaimed,
    cancelled: snapshot.counts.terrainPresentationGenerationsCancelled,
    coalesced: snapshot.counts.terrainPresentationGenerationsCoalesced,
    completionRate,
    presentationSwapCount,
    latestGenerationLagChunks: latestLagChunks,
    maximumGenerationLagChunks: maximumLagChunks,
    reuseRatio: snapshot.counts.terrainPresentationReuseRatio,
    jumpHistogram: scheduling.terrainPresentationJumpHistogram,
    reuseRatioByJump: scheduling.terrainPresentationReuseRatioByJump,
    terrainSchedulerIdleWithPendingCount: scheduling.terrainSchedulerIdleWithPendingCount,
    terrainSchedulerIdleWithPendingMs: scheduling.terrainSchedulerIdleWithPendingMs,
    maxPendingWaitMs: scheduling.maxPendingWaitMs,
    chunkDataUnderlyingRequestReuseRatio:
      chunkDataSubscribers.chunkDataUnderlyingRequestReuseRatio,
    chunkDataWorkerCancelRequests: chunkDataSubscribers.chunkDataWorkerCancelRequests,
    chunkDataSameOwnerRerequestCount: chunkDataSubscribers.chunkDataSameOwnerRerequestCount,
    chunkDataCachePressure: chunkDataSubscribers.cachePressure,
    terrainDependencyOwnerCount: terrainDependencies.terrainDependencyOwnerCount,
    terrainDependencyCompleted: terrainDependencies.terrainDependencyCompleted,
    terrainDependencyWaitMs: terrainDependencies.terrainDependencyWaitMs,
    terrainDependencyP50Ms: terrainDependencies.terrainDependencyP50Ms,
    terrainDependencyP95Ms: terrainDependencies.terrainDependencyP95Ms,
    terrainDependencyMaxMs: terrainDependencies.terrainDependencyMaxMs,
    maximumDependencyRegistrationMs:
      terrainDependencies.maximumRegistrationDurationMs,
  }));
  await runtime.shutdown();
  await chunkDataService.shutdown();
});

test('shutdown remains an explicit cancellation boundary for an in-flight Terrain generation', async () => {
  const presentation = new ControlledTerrainPresentationGenerationAdapter();
  const { runtime, chunkDataService } = await createRuntime('p2b-shutdown-cancel', {
    terrainPresentationAdapter: presentation,
    fastChunks: true,
  });
  await runtime.updateTerrainReadySet(readyPlan({ path: 'straight' }));
  const started = await waitForTerrainPresentationStart(presentation, 1);
  const shutdown = runtime.shutdown();
  started.release();
  await shutdown;
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.counts.terrainPresentationGenerationsStarted, 1);
  assert.equal(snapshot.counts.terrainPresentationGenerationsCompleted, 0);
  assert.equal(snapshot.counts.terrainPresentationGenerationsCancelled, 1);
  assert.equal(snapshot.counts.terrainPresentationGenerationsClaimed, 0);
  assert.equal(presentation.discarded.length, 1);
  await chunkDataService.shutdown();
});

test('READY set handles stop, restart, scale change, and direction reversal without retained stale staging', async () => {
  const { runtime, adapter, chunkDataService } = await createRuntime('p1-ready-motion-changes');
  await runtime.updateTerrainReadySet(readyPlan({ stageId: 'MAX', sprint: true }));
  assert.ok(runtime.snapshot().terrainReady.stagedProjectionCount > 0);

  const stopped = planRuntimeTerrainReadySet({
    centerChunkX: 0,
    centerChunkZ: 0,
    logicalX: 8,
    logicalZ: 8,
    velocityX: 0,
    velocityZ: 0,
    speedMetersPerSecond: 0,
    scaleStageId: 'MAX',
    sprint: false,
  });
  await runtime.updateTerrainReadySet(stopped);
  let snapshot = runtime.snapshot();
  assert.equal(snapshot.terrainReady.desiredDataOwnerCount, 25);
  assert.equal(snapshot.terrainReady.desiredRenderOwnerCount, 9);
  assert.equal(snapshot.terrainReady.stagedProjectionCount, 0);
  assert.equal(snapshot.terrainReady.queueDepth, 0);

  const tinyRestart = readyPlan({ stageId: 'TINY', sprint: false });
  await runtime.updateTerrainReadySet(tinyRestart);
  snapshot = runtime.snapshot();
  assert.equal(snapshot.terrainReady.planSignature, tinyRestart.signature);
  assert.equal(snapshot.terrainReady.queueDepth, 0);

  const profile = getW6ScaleProfile('MAX');
  const west = planRuntimeTerrainReadySet({
    centerChunkX: 0,
    centerChunkZ: 0,
    logicalX: 8,
    logicalZ: 8,
    velocityX: -profile.sprintMetersPerSecond,
    velocityZ: 0,
    speedMetersPerSecond: profile.sprintMetersPerSecond,
    scaleStageId: 'MAX',
    sprint: true,
  });
  await runtime.updateTerrainReadySet(west);
  snapshot = runtime.snapshot();
  assert.equal(snapshot.terrainReady.planSignature, west.signature);
  assert.equal(snapshot.terrainReady.queueDepth, 0);
  assert.equal(snapshot.terrainReady.readyRenderOwnerCount, west.renderCoordinates.length);
  assert.equal(new Set(snapshot.terrainReady.stagedProjectionKeys).size,
    snapshot.terrainReady.stagedProjectionKeys.length);
  await runtime.shutdown();
  await chunkDataService.shutdown();
  assert.equal(adapter.loaded.size, 0);
});

test('READY generation failure preserves published Terrain and resumes without stale publication', async () => {
  const source = await createSandboxChunkGenerator({ worldSeed: 'p1-ready-worker-failure' });
  let failOnce = true;
  const generator = {
    async generateChunk(chunkX, chunkZ) {
      if (failOnce && `${chunkX},${chunkZ}` === '3,-1') {
        failOnce = false;
        throw new Error('injected READY Worker failure');
      }
      return source.generateChunk(chunkX, chunkZ);
    },
  };
  const adapter = new PreparedAdapter();
  const chunkDataService = new ChunkDataService({
    transport: createInlineChunkGeneratorTransport({ generator }),
    cacheCapacity: 81,
  });
  const runtime = new ChunkRuntimeManager({
    chunkDataService,
    renderAdapter: adapter,
    cacheCapacity: 81,
    yieldToHost: () => Promise.resolve(),
  });
  await runtime.initialize(0, 0);
  const oldCoverage = [...adapter.loaded.keys()].sort();
  const plan = readyPlan();
  await assert.rejects(runtime.updateTerrainReadySet(plan), /injected READY Worker failure/);
  assert.deepEqual([...adapter.loaded.keys()].sort(), oldCoverage);
  assert.equal(runtime.snapshot().terrainReady.planFailed, true);
  await runtime.updateTerrainReadySet(plan);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.terrainReady.planFailed, false);
  assert.equal(snapshot.terrainReady.queueDepth, 0);
  assert.equal(snapshot.counts.terrainReadyRequiredProjections, 0);
  assert.deepEqual([...adapter.loaded.keys()].sort(), oldCoverage);
  await runtime.shutdown();
  await chunkDataService.shutdown();
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

test('required transition yields between projection units just like normal transition and prefetch', async () => {
  assert.equal(await countPreparationYields('p1-prefetch-yields'), 8);
  assert.equal(await countPreparationYields('p1-normal-transition-yields', {}), 8);
  assert.equal(await countPreparationYields('p1-required-transition-yields', { required: true }), 8);
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

test('a superseded directional prefetch cancels its in-flight owner before required preparation waits', async () => {
  const source = await createSandboxChunkGenerator({ worldSeed: 'p1-required-supersedes-prefetch' });
  let delayStaleOwner = false;
  let delayedRequest = null;
  let notifyStaleOwnerStarted;
  const staleOwnerStarted = new Promise(resolve => { notifyStaleOwnerStarted = resolve; });
  const cancelledRequestIds = [];
  const transport = {
    async initialize() {
      return {
        worldSeed: source.worldSeed,
        worldSeedHash: source.worldSeedHash,
        generatorVersion: source.generatorVersion,
        experienceSpawn: source.experienceSpawn,
        reviewSpawn: source.reviewSpawn,
      };
    },
    generateChunk(request) {
      if (delayStaleOwner && `${request.chunkX},${request.chunkZ}` === '3,-2') {
        return new Promise(resolve => {
          delayedRequest = { requestId: request.requestId, resolve };
          notifyStaleOwnerStarted();
        });
      }
      return source.generateChunk(request.chunkX, request.chunkZ);
    },
    cancelGenerationRequest({ requestId }) {
      if (requestId !== delayedRequest?.requestId) return false;
      cancelledRequestIds.push(requestId);
      delayedRequest.resolve(null);
      return true;
    },
    snapshot: () => Object.freeze({ kind: 'supersession-test' }),
    shutdown: () => source.shutdown?.(),
  };
  const chunkDataService = new ChunkDataService({ transport, cacheCapacity: 81 });
  const runtime = new ChunkRuntimeManager({
    chunkDataService,
    renderAdapter: new PreparedAdapter(),
    cacheCapacity: 81,
    yieldToHost: () => Promise.resolve(),
  });
  await runtime.initialize(0, 0);

  delayStaleOwner = true;
  const stale = runtime.prepareTransition(1, 0);
  await staleOwnerStarted;
  const required = runtime.prepareTransition(0, -1);
  await Promise.resolve();

  assert.deepEqual(cancelledRequestIds, [delayedRequest.requestId]);
  assert.equal(await stale, null);
  assert.ok(await required);
  await runtime.transitionToChunk(0, -1);
  assert.equal(runtime.snapshot().centerChunkX, 0);
  assert.equal(runtime.snapshot().centerChunkZ, -1);
  await runtime.shutdown();
  await chunkDataService.shutdown();
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
