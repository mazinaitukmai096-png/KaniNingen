import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { ChunkDataService } from '../src/infinite-world/chunk-data-service.js';
import {
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
  CHUNK_DATA_PRIORITY,
  createChunkGeneratorSchedulerEnvelope,
} from '../src/infinite-world/chunk-data-service-protocol.js';
import { createInlineChunkGeneratorTransport } from '../src/infinite-world/inline-chunk-generator-transport.js';
import { CHUNK_GENERATION_STAGE } from '../src/infinite-world/chunk-generation-stage-timing.js';
import { createChunkGeneratorWorkerCore } from '../src/infinite-world/chunk-generator-worker-core.js';
import { LOGICAL_CHUNK_SIZE_METERS } from '../src/infinite-world/chunk-coordinates.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { createNodeChunkGeneratorWorker } from '../src/infinite-world/node-worker-chunk-generator-adapter.js';
import {
  OWNER_GENERATION_LANE,
  createFixedLaneOwnerGenerationCoordinator,
  createOwnerGenerationCoordinator,
} from '../src/infinite-world/owner-generation-coordinator.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import {
  WORKER_GENERATION_LANE,
  createFixedLaneWorkerChunkGeneratorTransport,
  createWorkerChunkGeneratorTransport,
} from '../src/infinite-world/worker-chunk-generator-transport.js';

const seed = 'KaniNingen Infinite Natural World';

function stableIds(chunkData) {
  return [
    ...(chunkData.vegetationCandidates ?? []),
    ...(chunkData.rockCandidates ?? []),
    ...(chunkData.settlementFeatures ?? []),
    ...(chunkData.waterSurfaces ?? []),
    ...(chunkData.ambientDetails ?? []),
    ...(chunkData.settlementLandmarks ?? []),
    ...(chunkData.streetDetails ?? []),
  ].map(value => value.stableId ?? value.candidateId).filter(Boolean).sort();
}

class FakeWorker {
  constructor({ initializeError = null, metadata = { worldSeed: seed } } = {}) {
    this.initializeError = initializeError;
    this.metadata = metadata;
    this.listeners = new Map();
    this.messages = [];
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  postMessage(message) {
    this.messages.push(message);
    if (message.type !== CHUNK_GENERATOR_MESSAGE.INITIALIZE) return;
    queueMicrotask(() => this.emit(this.initializeError ? {
      type: CHUNK_GENERATOR_MESSAGE.ERROR,
      protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
      requestId: null,
      serviceGeneration: message.serviceGeneration,
      name: 'InitializationError',
      message: this.initializeError,
      recoverable: false,
    } : {
      type: CHUNK_GENERATOR_MESSAGE.INITIALIZED,
      protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
      serviceGeneration: message.serviceGeneration,
      metadata: this.metadata,
    }));
  }
  emit(data) { this.listeners.get('message')?.({ data }); }
  emitError(error = new Error('Worker crashed after initialization')) {
    this.crashed = true;
    this.listeners.get('error')?.(error);
  }
  async terminate() { this.terminated = true; }
}

async function drainAsyncWork(turns = 8) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

async function waitFor(predicate, turns = 64) {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail('condition did not become true');
}

function fixtureChunk(chunkX, chunkZ, revision = 'a') {
  return {
    chunkX, chunkZ,
    chunkId: `chunk:${chunkX},${chunkZ}:${revision}`,
    contentHash: `sha256:${`${chunkX},${chunkZ}:${revision}`.padEnd(64, '0')}`,
  };
}

function fallbackFactory() {
  const generator = {
    worldSeed: seed,
    worldSeedHash: `sha256:${'1'.repeat(64)}`,
    generatorVersion: { major: 800, minor: 0, patch: 0 },
    experienceSpawn: { x: 0, z: 0 },
    reviewSpawn: { x: 0, z: 0 },
    distributor: { findSettlementsNear: async () => [] },
    snapshot: () => ({ fallback: true }),
    generateChunk: async (chunkX, chunkZ) => fixtureChunk(chunkX, chunkZ),
  };
  return createInlineChunkGeneratorTransport({ generator });
}

test('Worker core includes the full generator snapshot only in an explicit diagnostics response', async () => {
  const responses = [];
  let snapshotCalls = 0;
  let shutdownCalls = 0;
  const generator = {
    worldSeed: seed,
    worldSeedHash: `sha256:${'2'.repeat(64)}`,
    generatorVersion: { major: 800, minor: 0, patch: 0 },
    experienceSpawn: { x: 1, z: 2 },
    reviewSpawn: { x: 3, z: 4 },
    distributor: { findSettlementsNear: async () => [{ settlementId: 'settlement:test' }] },
    resolveSettlementPresentationTemplate: async () => ({ settlementId: 'settlement:test' }),
    generateChunk: async (chunkX, chunkZ) => fixtureChunk(chunkX, chunkZ),
    snapshot() {
      snapshotCalls += 1;
      return { fullDiagnosticPayload: ['only', 'on', 'request'] };
    },
    async shutdown() { shutdownCalls += 1; },
  };
  const core = createChunkGeneratorWorkerCore({
    postMessage: response => responses.push(response),
    generatorFactory: async () => generator,
  });
  const request = (type, requestId, extra = {}) => ({
    type,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 5,
    requestId,
    ...extra,
  });

  await core.receive(request(CHUNK_GENERATOR_MESSAGE.INITIALIZE, undefined, { worldSeed: seed }));
  await core.receive(request(CHUNK_GENERATOR_MESSAGE.GENERATE, 1, { chunkX: 2, chunkZ: 3 }));
  await core.receive(request(CHUNK_GENERATOR_MESSAGE.FIND_SETTLEMENTS, 2, {
    centerWorldX: 0, centerWorldZ: 0, radiusMeters: 10,
  }));
  await core.receive(request(CHUNK_GENERATOR_MESSAGE.RESOLVE_SETTLEMENT_TEMPLATE, 3, {
    candidate: { settlementId: 'settlement:test' },
  }));

  assert.equal(snapshotCalls, 0);
  for (const response of responses) {
    assert.equal(Object.hasOwn(response, 'generatorSnapshot'), false, response.type);
    assert.equal(Object.hasOwn(response.metadata ?? {}, 'generatorSnapshot'), false, response.type);
  }

  await core.receive(request(CHUNK_GENERATOR_MESSAGE.REQUEST_DIAGNOSTICS, 4));
  assert.equal(snapshotCalls, 1);
  const diagnosticsResponse = responses.at(-1);
  const { scheduler, workerSchedulerSnapshot, ...diagnosticsPayload } = diagnosticsResponse;
  assert.deepEqual(diagnosticsPayload, {
    type: CHUNK_GENERATOR_MESSAGE.DIAGNOSTICS,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 4,
    serviceGeneration: 5,
    generatorSnapshot: { fullDiagnosticPayload: ['only', 'on', 'request'] },
    operationMs: diagnosticsResponse.operationMs,
  });
  assert.equal(scheduler.operationKind, 'diagnostics');
  assert.equal(scheduler.priority, CHUNK_DATA_PRIORITY.ULTRA_WARM);
  assert.equal(scheduler.required, false);
  assert.equal(workerSchedulerSnapshot.workerCount, 1);
  assert.equal(workerSchedulerSnapshot.inFlightRequestId, 4);
  assert.equal(workerSchedulerSnapshot.counts.completed, 3);
  assert.ok(diagnosticsResponse.operationMs >= 0);
  await core.shutdown();
  assert.equal(shutdownCalls, 1);
});

test('Worker core ERROR responses and scheduler terminal state both report failure', async () => {
  const responses = [];
  const schedulerEvents = [];
  const core = createChunkGeneratorWorkerCore({
    postMessage: response => responses.push(response),
    schedulerOptions: { onEvent: event => schedulerEvents.push(event) },
    generatorFactory: async () => ({
      worldSeed: seed,
      worldSeedHash: `sha256:${'e'.repeat(64)}`,
      generatorVersion: { major: 800, minor: 0, patch: 0 },
      experienceSpawn: { x: 0, z: 0 },
      reviewSpawn: { x: 0, z: 0 },
      distributor: { findSettlementsNear: async () => [] },
      async generateChunk() { throw new Error('injected-worker-generation-failure'); },
    }),
  });
  const base = {
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 6,
  };
  await core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.INITIALIZE,
    worldSeed: seed,
  });
  await core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.GENERATE,
    requestId: 91,
    chunkX: 0,
    chunkZ: 0,
  });
  const error = responses.find(response => response.requestId === 91);
  assert.equal(error.type, CHUNK_GENERATOR_MESSAGE.ERROR);
  assert.equal(error.cancelled, undefined);
  assert.match(error.message, /injected-worker-generation-failure/);
  const terminal = schedulerEvents.find(event => (
    event.type === 'terminal' && event.envelope.requestId === 91
  ));
  assert.equal(terminal.state, 'failed');
  assert.match(terminal.error.message, /injected-worker-generation-failure/);
  await core.shutdown();
});

test('Worker core preserves ERROR over a simultaneous cancel and emits one failed terminal', async () => {
  const responses = [];
  const schedulerEvents = [];
  let rejectGeneration;
  const generationGate = new Promise((resolve, reject) => { rejectGeneration = reject; });
  const core = createChunkGeneratorWorkerCore({
    postMessage: response => responses.push(response),
    schedulerOptions: { onEvent: event => schedulerEvents.push(event) },
    generatorFactory: async () => ({
      worldSeed: seed,
      worldSeedHash: `sha256:${'f'.repeat(64)}`,
      generatorVersion: { major: 800, minor: 0, patch: 0 },
      experienceSpawn: { x: 0, z: 0 },
      reviewSpawn: { x: 0, z: 0 },
      distributor: { findSettlementsNear: async () => [] },
      generateChunk: async () => generationGate,
    }),
  });
  const base = {
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 16,
  };
  await core.receive({ ...base, type: CHUNK_GENERATOR_MESSAGE.INITIALIZE, worldSeed: seed });
  responses.length = 0;
  const generation = core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.GENERATE,
    requestId: 92,
    chunkX: 0,
    chunkZ: 0,
  });
  await drainAsyncWork(2);
  await core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.CANCEL_GENERATION,
    requestId: 92,
    reason: 'cancel-raced-error',
  });
  rejectGeneration(new Error('authoritative-worker-error'));
  await generation;

  const requestResponses = responses.filter(response => response.requestId === 92);
  assert.equal(requestResponses.length, 1);
  assert.equal(requestResponses[0].type, CHUNK_GENERATOR_MESSAGE.ERROR);
  assert.equal(requestResponses[0].cancelled, undefined);
  assert.match(requestResponses[0].message, /authoritative-worker-error/);
  assert.deepEqual(
    schedulerEvents.filter(event => (
      event.type === 'terminal' && event.envelope.requestId === 92
    )).map(event => event.state),
    ['failed'],
  );
  await core.shutdown();
});

test('Worker core rebases main scheduler times before Worker deadline and aging comparisons', async () => {
  const responses = [];
  const executionEnvelopes = [];
  let workerNow = 10_000;
  const generator = {
    worldSeed: seed,
    worldSeedHash: `sha256:${'7'.repeat(64)}`,
    generatorVersion: { major: 800, minor: 0, patch: 0 },
    experienceSpawn: { x: 0, z: 0 },
    reviewSpawn: { x: 0, z: 0 },
    distributor: { findSettlementsNear: async () => [] },
    async generateChunk(chunkX, chunkZ, options = {}) {
      executionEnvelopes.push(options.scheduler);
      workerNow += 10;
      return fixtureChunk(chunkX, chunkZ);
    },
  };
  const core = createChunkGeneratorWorkerCore({
    postMessage: response => responses.push(response),
    generatorFactory: async () => generator,
    schedulerOptions: { clock: () => workerNow },
  });
  await core.receive({
    type: CHUNK_GENERATOR_MESSAGE.INITIALIZE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 17,
    worldSeed: seed,
  });
  responses.length = 0;
  await core.receive({
    type: CHUNK_GENERATOR_MESSAGE.GENERATE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 101,
    serviceGeneration: 17,
    chunkX: 1,
    chunkZ: 2,
    scheduler: createChunkGeneratorSchedulerEnvelope({
      requestId: 101,
      operationKind: 'chunk',
      priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
      required: false,
      createdAtMs: 900,
      deadlineAtMs: 1_050,
      consumerId: 'clock-domain-test',
    }),
    schedulerClock: {
      schemaVersion: 'worker-scheduler-clock-1',
      sentAtMs: 1_000,
    },
  });

  assert.equal(executionEnvelopes.length, 1);
  assert.equal(executionEnvelopes[0].createdAtMs, 9_900);
  assert.equal(executionEnvelopes[0].deadlineAtMs, 10_050);
  assert.equal(executionEnvelopes[0].firstVisibleDeadlineMs, 10_050);
  assert.equal(responses[0].scheduler.queueTimeMs, 100);
  assert.equal(responses[0].scheduler.deadlineMiss, false);
  assert.equal(responses[0].scheduler.deadlineAtMs, 1_050,
    'the response keeps the caller protocol clock domain');
  await core.shutdown();
});

test('Worker core emits one diagnostics-only generation profile trailer after the Chunk payload', async () => {
  const responses = [];
  const generator = {
    worldSeed: seed,
    worldSeedHash: `sha256:${'8'.repeat(64)}`,
    generatorVersion: { major: 800, minor: 0, patch: 0 },
    experienceSpawn: { x: 0, z: 0 },
    reviewSpawn: { x: 0, z: 0 },
    distributor: { findSettlementsNear: async () => [] },
    async generateChunk(chunkX, chunkZ, options = {}) {
      options.stageRecorder?.measureSync(CHUNK_GENERATION_STAGE.TERRAIN, () => chunkX + chunkZ);
      return fixtureChunk(chunkX, chunkZ);
    },
  };
  const core = createChunkGeneratorWorkerCore({
    postMessage: response => responses.push(response),
    generatorFactory: async () => generator,
  });
  await core.receive({
    type: CHUNK_GENERATOR_MESSAGE.INITIALIZE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 13,
    worldSeed: seed,
  });
  responses.length = 0;
  await core.receive({
    type: CHUNK_GENERATOR_MESSAGE.GENERATE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 91,
    serviceGeneration: 13,
    chunkX: 5,
    chunkZ: -2,
    pipelineDiagnostics: true,
  });
  assert.deepEqual(responses.map(response => response.type), [
    CHUNK_GENERATOR_MESSAGE.GENERATED,
    CHUNK_GENERATOR_MESSAGE.PIPELINE_TIMING,
  ]);
  assert.equal(responses[0].chunkData.contentHash, fixtureChunk(5, -2).contentHash);
  assert.equal(responses[1].stageTiming.callCounts.terrain, 1);
  assert.ok(responses[1].generationTotalMs >= responses[1].stageTiming.totalsMs.terrain);
  assert.ok(responses[1].postMessageCallMs >= 0);

  responses.length = 0;
  await core.receive({
    type: CHUNK_GENERATOR_MESSAGE.GENERATE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 92,
    serviceGeneration: 13,
    chunkX: 6,
    chunkZ: -2,
  });
  assert.deepEqual(responses.map(response => response.type), [
    CHUNK_GENERATOR_MESSAGE.GENERATED,
  ]);
  assert.equal(Object.hasOwn(responses[0], 'pipelineTiming'), false);
  await core.shutdown();
});

test('Inline diagnostics are explicit and shutdown waits for active generation before releasing the generator', async () => {
  let releaseGeneration;
  let generationFinished = false;
  let snapshotCalls = 0;
  let shutdownCalls = 0;
  const generationGate = new Promise(resolve => { releaseGeneration = resolve; });
  const generator = {
    worldSeed: seed,
    async generateChunk(chunkX, chunkZ) {
      await generationGate;
      generationFinished = true;
      return fixtureChunk(chunkX, chunkZ);
    },
    snapshot() { snapshotCalls += 1; return { inlineDiagnostic: true }; },
    async shutdown() {
      assert.equal(generationFinished, true);
      shutdownCalls += 1;
    },
  };
  const transport = createInlineChunkGeneratorTransport({ generator });
  const metadata = await transport.initialize();
  assert.equal(Object.hasOwn(metadata, 'generatorSnapshot'), false);
  assert.equal(transport.snapshot().generatorSnapshot, null);
  assert.equal(snapshotCalls, 0);

  const generation = transport.generateChunk({ requestId: 1, chunkX: 8, chunkZ: 9 });
  await drainAsyncWork(2);
  const shutdown = transport.shutdown();
  await drainAsyncWork(2);
  assert.equal(shutdownCalls, 0);
  releaseGeneration();
  assert.equal((await generation).chunkId, fixtureChunk(8, 9).chunkId);
  await shutdown;
  assert.equal(shutdownCalls, 1);
  assert.equal(snapshotCalls, 0);
  await assert.rejects(transport.requestDiagnostics(), /shut down/);
});

test('real Node module Worker matches Inline W8 identity, owner, terrain, Settlement, presentation and spawn metadata', async () => {
  const inlineGenerator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const inline = createInlineChunkGeneratorTransport({ generator: inlineGenerator });
  const worker = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    workerFactory: createNodeChunkGeneratorWorker,
  });
  const [inlineMetadata, workerMetadata] = await Promise.all([inline.initialize(), worker.initialize()]);
  assert.equal(Object.hasOwn(inlineMetadata, 'generatorSnapshot'), false);
  assert.equal(Object.hasOwn(workerMetadata, 'generatorSnapshot'), false);
  assert.deepEqual(workerMetadata.experienceSpawn, inlineMetadata.experienceSpawn);
  assert.deepEqual(workerMetadata.generatorVersion, inlineMetadata.generatorVersion);
  assert.equal(workerMetadata.worldSeedHash, inlineMetadata.worldSeedHash);

  const [candidate] = await inlineGenerator.distributor.findSettlementsNear(
    inlineGenerator.reviewSpawn.x,
    inlineGenerator.reviewSpawn.z,
    350,
  );
  const [inlineTemplate, workerTemplate] = await Promise.all([
    inline.resolveSettlementPresentationTemplate({ candidate }),
    worker.resolveSettlementPresentationTemplate({ candidate }),
  ]);
  assert.deepEqual(workerTemplate, inlineTemplate);
  assert.equal(workerTemplate.canonicalBuildingCount, workerTemplate.buildings.length);
  assert.equal(new Set(workerTemplate.buildings.map(building => building.stableId)).size,
    workerTemplate.buildings.length);

  const coordinates = [[0, 0], [1, -1], [-2, 2]];
  const inlineChunks = [];
  for (const [chunkX, chunkZ] of coordinates.toReversed()) {
    inlineChunks.unshift(await inline.generateChunk({ requestId: inlineChunks.length + 1, chunkX, chunkZ }));
  }
  const workerChunks = await Promise.all(coordinates.map(([chunkX, chunkZ], index) => worker.generateChunk({
    requestId: index + 1, chunkX, chunkZ,
  })));
  for (let index = 0; index < coordinates.length; index += 1) {
    const expected = inlineChunks[index];
    const actual = workerChunks[index];
    assert.equal(actual.chunkId, expected.chunkId);
    assert.equal(actual.contentHash, expected.contentHash);
    assert.deepEqual(actual.terrain, expected.terrain);
    assert.deepEqual(actual.biomeField, expected.biomeField);
    assert.deepEqual(actual.settlementFeatures, expected.settlementFeatures);
    assert.deepEqual(actual.presentationLayers, expected.presentationLayers);
    assert.deepEqual(actual.waterSurfaces, expected.waterSurfaces);
    assert.deepEqual(actual.ambientDetails, expected.ambientDetails);
    assert.deepEqual(stableIds(actual), stableIds(expected));
    assert.deepEqual(actual.owningChunkCoordinate, expected.owningChunkCoordinate);
    assert.equal(ArrayBuffer.isView(actual.terrain.heights), false);
  }
  const [inlineForest, workerForest] = await Promise.all([
    inline.generateForestHorizonManifest({ chunkX: 0, chunkZ: 0 }),
    worker.generateForestHorizonManifest({ chunkX: 0, chunkZ: 0 }),
  ]);
  assert.deepEqual(workerForest, inlineForest);
  assert.equal(workerForest.schemaVersion, 'w8-forest-horizon-owner-summary-1');
  assert.equal(Object.hasOwn(workerForest, 'terrain'), false);
  assert.equal(Object.hasOwn(workerForest, 'sourceChunkData'), false);
  assert.equal(workerForest.presentationLayers.natural.rocks.length, 0);
  assert.equal(worker.snapshot().mode, 'worker');
  assert.equal(worker.snapshot().counts.generated, coordinates.length);
  assert.equal(worker.snapshot().counts.forestHorizonGenerated, 1);
  assert.equal(inline.snapshot().forestHorizonGeneratedCount, 1);
  assert.ok(worker.snapshot().generationMsMaximum > 0);
  assert.ok(worker.snapshot().forestHorizonGenerationMsMaximum > 0);
  assert.ok(worker.snapshot().forestHorizonReceiveMsMaximum >= 0);
  assert.ok(worker.snapshot().settlementQueryMsMaximum >= 0);
  assert.ok(worker.snapshot().settlementQueryReceiveMsMaximum >= 0);
  assert.ok(worker.snapshot().settlementTemplateMsMaximum > 0);
  assert.ok(worker.snapshot().settlementTemplateReceiveMsMaximum >= 0);
  assert.equal(inline.snapshot().generatorSnapshot, null);
  assert.equal(worker.snapshot().generatorSnapshot, null);
  const [inlineDiagnostics, workerDiagnostics] = await Promise.all([
    inline.requestDiagnostics(),
    worker.requestDiagnostics(),
  ]);
  assert.equal(workerDiagnostics.schemaVersion, inlineDiagnostics.schemaVersion);
  assert.equal(workerDiagnostics.warmSourceChunkCacheSize, inlineDiagnostics.warmSourceChunkCacheSize);
  assert.equal(
    workerDiagnostics.canonicalMajorRoad.graphCacheSize,
    inlineDiagnostics.canonicalMajorRoad.graphCacheSize,
  );
  assert.equal(worker.snapshot().generatorSnapshot, workerDiagnostics);
  assert.equal(inline.snapshot().generatorSnapshot, inlineDiagnostics);
  assert.equal(worker.snapshot().counts.diagnosticQueries, 1);
  await Promise.all([inline.shutdown(), worker.shutdown()]);
  assert.equal(inline.snapshot().generatorSnapshot, null);
  assert.equal(worker.snapshot().generatorSnapshot, null);
  assert.equal(worker.snapshot().timingSampleCount, 0);
});

test('legacy Settlement phase checkpoints preserve the canonical template', {
  timeout: 30_000,
}, async t => {
  const worldSeed = seed;
  const [checkpointed, concurrentCheckpointed, baseline] = await Promise.all([
    createDistributedSettlementChunkGenerator({ worldSeed }),
    createDistributedSettlementChunkGenerator({ worldSeed }),
    createDistributedSettlementChunkGenerator({ worldSeed }),
  ]);
  try {
    const [candidate] = await checkpointed.distributor.findSettlementsNear(
      checkpointed.reviewSpawn.x,
      checkpointed.reviewSpawn.z,
      350,
    );
    assert.ok(candidate);
    let phaseCheckpointCount = 0;
    let concurrentPhaseCheckpointCount = 0;
    let buildingCheckpointCount = 0;
    let concurrentBuildingCheckpointCount = 0;
    const startedAt = performance.now();
    const [actual, concurrentActual, expected] = await Promise.all([
      checkpointed.resolveSettlementTemplate({
        candidate,
        checkpoint(details) {
          phaseCheckpointCount += 1;
          if (details?.site?.startsWith('cooperative-migrated-settlement-building:')) {
            buildingCheckpointCount += 1;
          }
        },
      }),
      concurrentCheckpointed.resolveSettlementTemplate({
        candidate,
        checkpoint(details) {
          concurrentPhaseCheckpointCount += 1;
          if (details?.site?.startsWith('cooperative-migrated-settlement-building:')) {
            concurrentBuildingCheckpointCount += 1;
          }
        },
      }),
      baseline.resolveSettlementTemplate({ candidate }),
    ]);
    const elapsedMs = performance.now() - startedAt;

    assert.ok(
      phaseCheckpointCount >= Math.ceil(actual.requestedBuildingCount / 4),
      'the cooperative implementation must checkpoint within Building placement',
    );
    assert.ok(
      concurrentPhaseCheckpointCount >= Math.ceil(concurrentActual.requestedBuildingCount / 4),
      'the same-town lease must preserve the concurrent generator checkpoint',
    );
    assert.ok(buildingCheckpointCount > 0,
      'the first same-town generator must own its Building checkpoint callback');
    assert.ok(concurrentBuildingCheckpointCount > 0,
      'the second same-town generator must own its Building checkpoint callback');
    assert.equal(
      concurrentBuildingCheckpointCount,
      buildingCheckpointCount,
      'an uninstrumented same-town generator must not consume another generator callback',
    );
    assert.deepEqual(actual, expected);
    assert.deepEqual(concurrentActual, expected);
    assert.equal(checkpointed.snapshot().templateCachePendingCount, 0);
    assert.equal(concurrentCheckpointed.snapshot().templateCachePendingCount, 0);
    t.diagnostic(JSON.stringify({
      schemaVersion: 'legacy-settlement-phase-checkpoint-benchmark-1',
      settlementType: candidate.settlementType,
      phaseCheckpointCount,
      buildingCheckpointCount,
      concurrentBuildingCheckpointCount,
      elapsedMs,
      buildingCount: actual.buildings.length,
    }));
  } finally {
    await Promise.all([
      checkpointed.shutdown(),
      concurrentCheckpointed.shutdown(),
      baseline.shutdown(),
    ]);
  }
});

test('real Worker profiles pre-lane legacy Settlement cancellation and bounds cancel-to-stop across ten owners', {
  timeout: 60_000,
}, async t => {
  const schedulerEvents = [];
  const worker = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 24,
    workerFactory: createNodeChunkGeneratorWorker,
    onSchedulerEvent: event => schedulerEvents.push(event),
  });
  try {
    await worker.initialize();
    const owner = { x: 55, z: 77 };
    const candidates = await worker.findSettlementsNear(
      (owner.x + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
      (owner.z + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
      2_000,
    );
    const typeRank = Object.freeze({ CITY: 0, TOWN: 1, RURAL: 2 });
    const targets = candidates.toSorted((left, right) => (
      typeRank[left.settlementType] - typeRank[right.settlementType]
        || left.settlementId.localeCompare(right.settlementId)
    ));
    assert.ok(targets.length >= 10);
    const samples = [];
    let completedBeforeCancel = 0;
    for (let index = 0; index < targets.length && samples.length < 10; index += 1) {
      const candidate = targets[index];
      const consumerId = `legacy-hotpath-cancel-test-${index}`;
      const urgentRequestId = 240 + index;
      const eventStart = schedulerEvents.length;
      const template = worker.resolveSettlementPresentationTemplate({
        candidate,
        priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
        required: false,
        consumerId,
      });
      await new Promise(resolve => setTimeout(resolve, 1));
      const requestedAt = performance.now();
      const urgent = worker.generateChunk({
        requestId: urgentRequestId,
        chunkX: owner.x,
        chunkZ: owner.z,
        priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
        required: true,
        consumerId: `legacy-hotpath-urgent-full-${index}`,
      });
      const [templateResult, urgentChunk] = await Promise.all([template, urgent]);
      const iterationEvents = schedulerEvents.slice(eventStart);
      const acknowledgement = iterationEvents.find(event => (
        event.type === 'cancel-acknowledged'
          && event.envelope?.consumerId === consumerId
      ));
      const urgentStart = iterationEvents.find(event => (
        event.type === 'started' && event.envelope?.requestId === urgentRequestId
      ));

      assert.ok(urgentChunk?.contentHash);
      assert.ok(urgentStart);
      if (templateResult !== null) {
        completedBeforeCancel += 1;
        assert.equal(acknowledgement, undefined);
        continue;
      }
      assert.ok(acknowledgement);
      assert.equal(acknowledgement.cancellationAcknowledgedAtCheckpoint, true);
      samples.push(Object.freeze({
        settlementType: candidate.settlementType,
        requestToAcknowledgementMs:
          acknowledgement.cancellationAcknowledgedAtMs - requestedAt,
        cancelToStopMs: acknowledgement.cancellationAcknowledgementMs,
        workerCancellationAcknowledgementMs:
          acknowledgement.workerCancellationAcknowledgementMs,
        urgentQueueMs: urgentStart.queueTimeMs,
        signalToWorkerObservationMs: acknowledgement.signalToWorkerObservationMs,
        workerTerminalDrainMs: acknowledgement.workerTerminalDrainMs,
        workerResponseQueueMs: acknowledgement.workerResponseQueueMs,
        responseDeliveryMs: acknowledgement.responseDeliveryMs,
        cancellationCheckpointSite: acknowledgement.cancellationCheckpointSite,
      }));
    }
    assert.equal(samples.length, 10,
      `only ${samples.length} legacy requests reached a cancellation terminal`);
    const distribution = key => {
      const values = samples.map(sample => sample[key]).filter(Number.isFinite)
        .toSorted((left, right) => left - right);
      return Object.freeze({
        p50: values[Math.floor((values.length - 1) * 0.5)],
        p95: values[Math.floor((values.length - 1) * 0.95)],
        max: values.at(-1),
      });
    };
    const requestToAcknowledgement = distribution('requestToAcknowledgementMs');
    const cancelToStop = distribution('cancelToStopMs');
    const urgentQueue = distribution('urgentQueueMs');
    t.diagnostic(JSON.stringify({
      schemaVersion: 'legacy-settlement-worker-cancel-benchmark-1',
      classification: 'single-worker-pre-lane-diagnostic',
      productionGateTest:
        'fixed real Worker lanes keep urgent Full queue below the 50 ms gate under cold Forest and Road work',
      samples: samples.length,
      completedBeforeCancel,
      requestToAcknowledgement,
      cancelToStop,
      urgentQueue,
      workerCancellationAcknowledgement: distribution(
        'workerCancellationAcknowledgementMs',
      ),
      signalToWorkerObservation: distribution('signalToWorkerObservationMs'),
      workerTerminalDrain: distribution('workerTerminalDrainMs'),
      workerResponseQueue: distribution('workerResponseQueueMs'),
      responseDelivery: distribution('responseDeliveryMs'),
      details: samples,
    }));
    // A required request and the cancellation signal share this diagnostic
    // Worker's MessagePort.  Delivery before the Worker observes cancellation
    // is intentionally measured above, but it is not the production admission
    // gate: fixed lanes put required Full work on the independent Critical
    // Worker, whose <50 ms max and <16.7 ms p95 remain hard assertions below.
    assert.ok(Number.isFinite(requestToAcknowledgement.max));
    assert.ok(samples.every(sample => (
      sample.requestToAcknowledgementMs >= sample.cancelToStopMs
    )), 'request-to-acknowledgement must include the transport cancel-to-stop interval');
    assert.ok(cancelToStop.max < 50,
      `legacy cancel-to-stop exceeded 50 ms: ${cancelToStop.max}`);
    assert.ok(urgentQueue.max < 50,
      `legacy urgent queue exceeded 50 ms: ${urgentQueue.max}`);
  } finally {
    await worker.shutdown();
  }
});

test('real Worker preempts an active Forest owner for urgent Full at a cooperative checkpoint', {
  timeout: 30_000,
}, async t => {
  const schedulerEvents = [];
  let urgentRequestedAt = null;
  let acknowledgementObservedAt = null;
  const worker = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 17,
    workerFactory: createNodeChunkGeneratorWorker,
    onSchedulerEvent: event => {
      schedulerEvents.push(event);
      if (event.type === 'cancel-acknowledged' && urgentRequestedAt !== null) {
        acknowledgementObservedAt = performance.now();
      }
    },
  });
  t.after(() => worker.shutdown());
  await worker.initialize();
  const owner = { x: 55, z: 77 };
  const optional = worker.generateForestHorizonManifest({
    chunkX: owner.x,
    chunkZ: owner.z,
    consumerId: 'real-worker-preemption-gate',
    epoch: 1,
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    required: false,
  });
  // Let the optional request enter its cold canonical-owner build before the
  // required Full request arrives. This owner exercises Settlement/Road work.
  await new Promise(resolve => setTimeout(resolve, 20));
  const urgentRequestId = 7_001;
  urgentRequestedAt = performance.now();
  const urgent = worker.generateChunk({
    requestId: urgentRequestId,
    chunkX: owner.x,
    chunkZ: owner.z,
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    required: true,
  });
  const [optionalResult, urgentChunk] = await Promise.all([optional, urgent]);
  const urgentResolvedAt = performance.now();
  assert.equal(optionalResult, null);
  assert.equal(urgentChunk.chunkX, owner.x);
  assert.equal(urgentChunk.chunkZ, owner.z);
  const acknowledgement = schedulerEvents.find(event => (
    event.type === 'cancel-acknowledged'
      && event.preemptedByRequestId === urgentRequestId
  ));
  assert.ok(acknowledgement, 'the active Forest request must acknowledge preemption');
  assert.equal(acknowledgement.cancellationAcknowledgedAtCheckpoint, true);
  const urgentRequestToAcknowledgementMs = acknowledgementObservedAt - urgentRequestedAt;
  assert.ok(urgentRequestToAcknowledgementMs <= 100,
    `main urgent request-to-acknowledgement exceeded 100 ms: ${
      urgentRequestToAcknowledgementMs}`);
  assert.ok(acknowledgement.workerCancellationAcknowledgementMs <= 100,
    `cancel-to-checkpoint acknowledgement exceeded 100 ms: ${
      acknowledgement.workerCancellationAcknowledgementMs}`);
  const urgentStart = schedulerEvents.find(event => (
    event.type === 'started' && event.envelope?.requestId === urgentRequestId
  ));
  assert.ok(urgentStart, 'the urgent Full request must expose Worker queue timing');
  assert.ok(urgentStart.queueTimeMs <= 100,
    `urgent Full Worker queue time exceeded 100 ms: ${urgentStart.queueTimeMs}`);
  const snapshot = worker.snapshot();
  assert.equal(snapshot.counts.preemptionAcknowledgements, 1);
  assert.equal(snapshot.counts.forestHorizonGenerated, 0);
  assert.equal(snapshot.counts.generated, 1);
  const revisitedManifest = await worker.generateForestHorizonManifest({
    chunkX: owner.x,
    chunkZ: owner.z,
    consumerId: 'real-worker-preemption-gate',
    epoch: 2,
  });
  assert.ok(revisitedManifest?.contentHash,
    'cancelled canonical-owner work must remain safely regenerable');
  assert.equal(revisitedManifest.sourceW5ContentHash, urgentChunk.sourceW5ContentHash);
  t.diagnostic(JSON.stringify({
    schemaVersion: 'single-worker-cooperative-preemption-gate-1',
    owner,
    workerCancelToAcknowledgementMs:
      acknowledgement.workerCancellationAcknowledgementMs,
    urgentRequestToAcknowledgementMs,
    urgentWorkerQueueMs: urgentStart.queueTimeMs,
    urgentRequestToResolutionMs: urgentResolvedAt - urgentRequestedAt,
  }));
});

test('real Worker preempts optional Road coverage for urgent Full on the same checkpoint path', {
  timeout: 30_000,
}, async t => {
  const schedulerEvents = [];
  const unhandledRejections = [];
  const onUnhandledRejection = reason => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  t.after(() => process.off('unhandledRejection', onUnhandledRejection));
  let urgentRequestedAt = null;
  let acknowledgementObservedAt = null;
  const worker = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 18,
    workerFactory: createNodeChunkGeneratorWorker,
    onSchedulerEvent: event => {
      schedulerEvents.push(event);
      if (event.type === 'cancel-acknowledged' && urgentRequestedAt !== null) {
        acknowledgementObservedAt = performance.now();
      }
    },
  });
  t.after(() => worker.shutdown());
  await worker.initialize();
  const owner = { x: 55, z: 77 };
  const optionalCoverage = worker.resolveCanonicalMajorRoadOwnerCoverage({
    centerWorldX: (owner.x + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
    centerWorldZ: (owner.z + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
    radiusMeters: 0,
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    required: false,
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  const urgentRequestId = 7_002;
  urgentRequestedAt = performance.now();
  const urgent = worker.generateChunk({
    requestId: urgentRequestId,
    chunkX: owner.x,
    chunkZ: owner.z,
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    required: true,
  });
  const [coverageResult, urgentChunk] = await Promise.all([optionalCoverage, urgent]);
  assert.equal(coverageResult, null);
  assert.equal(urgentChunk.chunkX, owner.x);
  const acknowledgement = schedulerEvents.find(event => (
    event.type === 'cancel-acknowledged'
      && event.preemptedByRequestId === urgentRequestId
  ));
  assert.ok(acknowledgement, 'optional Road coverage must acknowledge preemption');
  assert.equal(acknowledgement.cancellationAcknowledgedAtCheckpoint, true);
  const urgentRequestToAcknowledgementMs = acknowledgementObservedAt - urgentRequestedAt;
  const urgentStart = schedulerEvents.find(event => (
    event.type === 'started' && event.envelope?.requestId === urgentRequestId
  ));
  t.diagnostic(JSON.stringify({
    schemaVersion: 'single-worker-road-preemption-gate-1',
    owner,
    workerCancelToAcknowledgementMs:
      acknowledgement.workerCancellationAcknowledgementMs,
    urgentRequestToAcknowledgementMs,
    urgentWorkerQueueMs: urgentStart?.queueTimeMs ?? null,
    cancellationCheckpointSite: urgentRequestToAcknowledgementMs > 50
      ? acknowledgement.cancellationCheckpointSite ?? null : null,
  }));
  assert.ok(urgentRequestToAcknowledgementMs <= 100,
    `Road main urgent request-to-acknowledgement exceeded 100 ms: ${
      urgentRequestToAcknowledgementMs}`);
  assert.ok(acknowledgement.workerCancellationAcknowledgementMs <= 100,
    `Road cancel-to-checkpoint acknowledgement exceeded 100 ms: ${
      acknowledgement.workerCancellationAcknowledgementMs}`);
  assert.ok(urgentStart, 'urgent Full must expose a Worker start event');
  assert.ok(urgentStart.queueTimeMs <= 100,
    `urgent Full queue behind Road coverage exceeded 100 ms: ${urgentStart.queueTimeMs}`);
  const diagnostics = await worker.requestDiagnostics();
  const pendingCaches = {
    sourceChunk: diagnostics.warmSourceChunkPendingCount,
    settlementOverlay: diagnostics.settlementOverlayCachePendingCount,
    settlementTemplate: diagnostics.source?.templateCachePendingCount
      ?? diagnostics.templateCachePendingCount,
    roadGraph: diagnostics.canonicalMajorRoad.graphCachePendingCount,
    roadRoute: diagnostics.canonicalMajorRoad.routeCachePendingCount,
    roadObstacle: diagnostics.canonicalMajorRoad.obstacleCachePendingCount,
    roadPreparation: diagnostics.canonicalMajorRoad.preparationCachePendingCount,
    roadSourceHash: diagnostics.canonicalMajorRoad.sourceHashCachePendingCount,
  };
  assert.deepEqual(pendingCaches, {
    sourceChunk: 0,
    settlementOverlay: 0,
    settlementTemplate: 0,
    roadGraph: 0,
    roadRoute: 0,
    roadObstacle: 0,
    roadPreparation: 0,
    roadSourceHash: 0,
  }, 'CANCELLED must publish only after every nested pending-cache loader settles');
  const revisitedChunk = await worker.generateChunk({
    requestId: urgentRequestId + 1,
    chunkX: owner.x,
    chunkZ: owner.z,
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    required: true,
  });
  assert.equal(revisitedChunk.contentHash, urgentChunk.contentHash);
  assert.equal(revisitedChunk.sourceW5ContentHash, urgentChunk.sourceW5ContentHash);
  assert.equal(worker.snapshot().fallbackOccurred, false);
  assert.deepEqual(unhandledRejections, []);
});

test('fixed Critical/Background owner admission suppresses new Background work and never blocks Critical behind active Background', async () => {
  const order = [];
  let releaseFirstCritical;
  let releaseBackground;
  const firstCriticalGate = new Promise(resolve => { releaseFirstCritical = resolve; });
  const backgroundGate = new Promise(resolve => { releaseBackground = resolve; });
  const coordinator = createFixedLaneOwnerGenerationCoordinator({ clock: () => 0 });
  const firstCritical = coordinator.schedule({
    ownerKey: 'full:1,1',
    resourceKind: 'full',
    operationKind: 'chunk',
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    required: true,
    representationClass: 'detail',
    execute: async () => {
      order.push('critical-1-start');
      await firstCriticalGate;
      order.push('critical-1-finish');
      return 'critical-1';
    },
  });
  const background = coordinator.schedule({
    ownerKey: 'presentation:2,2',
    resourceKind: 'presentation',
    operationKind: 'presentation-owner',
    priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
    required: false,
    representationClass: 'coarse',
    execute: async () => {
      order.push('background-start');
      await backgroundGate;
      order.push('background-finish');
      return 'background';
    },
  });
  await drainAsyncWork(8);
  assert.deepEqual(order, ['critical-1-start']);
  assert.equal(firstCritical.lane, OWNER_GENERATION_LANE.CRITICAL);
  assert.equal(background.lane, OWNER_GENERATION_LANE.BACKGROUND);
  assert.notEqual(firstCritical.requestId, background.requestId,
    'scheduler request IDs must stay unique across lanes');
  assert.equal(coordinator.snapshot().backgroundAdmissionSuppressed, true);

  releaseFirstCritical();
  assert.equal(await firstCritical.promise, 'critical-1');
  await waitFor(() => order.includes('background-start'));
  const secondCritical = coordinator.schedule({
    ownerKey: 'full:3,3',
    resourceKind: 'full',
    operationKind: 'chunk',
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    required: true,
    representationClass: 'detail',
    execute: async () => {
      order.push('critical-2');
      return 'critical-2';
    },
  });
  assert.equal(await secondCritical.promise, 'critical-2');
  assert.equal(background.state, 'in-flight',
    'an already active Background request may finish without occupying Critical');
  releaseBackground();
  assert.equal(await background.promise, 'background');
  assert.deepEqual(order, [
    'critical-1-start',
    'critical-1-finish',
    'background-start',
    'critical-2',
    'background-finish',
  ]);
  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.backlog, 0);
  assert.equal(snapshot.lanes.critical.counts.completed, 2);
  assert.equal(snapshot.lanes.background.counts.completed, 1);
  await coordinator.shutdown();
});

test('fixed Worker lanes revalidate metadata identity after one lane falls back', async () => {
  const workers = new Map();
  const transport = createFixedLaneWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 29,
    workerFactory: ({ lane }) => {
      const worker = new FakeWorker();
      workers.set(lane, worker);
      return worker;
    },
    fallbackTransportFactory: async ({ lane }) => {
      assert.equal(lane, WORKER_GENERATION_LANE.BACKGROUND);
      return fallbackFactory();
    },
  });
  await transport.initialize();
  workers.get(WORKER_GENERATION_LANE.BACKGROUND)
    .emitError(new Error('background lane failed'));
  await waitFor(() => (
    transport.snapshot().lanes.background.mode === 'inline-fallback'
  ));

  await assert.rejects(
    transport.findSettlementsNear(0, 0, 8),
    /Critical\/Background Worker metadata identity mismatch/,
  );
  const snapshot = transport.snapshot();
  assert.equal(snapshot.isShutdown, true);
  assert.equal(snapshot.metadataIdentityConsistent, false);
  assert.equal(workers.get(WORKER_GENERATION_LANE.CRITICAL).terminated, true);
  assert.equal(workers.get(WORKER_GENERATION_LANE.BACKGROUND).terminated, true);
});

test('fixed Worker shutdown is one awaitable drain and preserves both lane results', async () => {
  const workers = [];
  const transport = createFixedLaneWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 30,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  await transport.initialize();
  const firstShutdown = transport.shutdown();
  const concurrentShutdown = transport.shutdown();
  assert.equal(concurrentShutdown, firstShutdown,
    'concurrent callers must own the same bounded lane-drain promise');
  assert.equal(await firstShutdown, true);
  assert.equal(transport.snapshot().isShutdown, true);
  assert.equal(workers.length, 2);
  assert.ok(workers.every(worker => worker.terminated === true));
});

test('fixed real Worker lanes keep urgent Full queue below the 50 ms gate under cold Forest and Road work', {
  timeout: 60_000,
}, async t => {
  const owner = { x: 55, z: 77 };
  const queueSamples = [];
  const wallSamples = [];
  const residentSamples = [];
  const rssBefore = process.memoryUsage().rss;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const schedulerEvents = [];
    const transport = createFixedLaneWorkerChunkGeneratorTransport({
      worldSeed: seed,
      serviceGeneration: 30 + iteration,
      workerFactory: createNodeChunkGeneratorWorker,
      onSchedulerEvent: event => schedulerEvents.push(event),
    });
    try {
      await transport.initialize();
      const background = iteration % 2 === 0
        ? transport.generateForestHorizonManifest({
          chunkX: owner.x,
          chunkZ: owner.z,
          consumerId: `fixed-lane-forest-${iteration}`,
          epoch: 1,
          priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
          required: false,
        })
        : transport.resolveCanonicalMajorRoadOwnerCoverage({
          centerWorldX: (owner.x + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
          centerWorldZ: (owner.z + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
          radiusMeters: 0,
          priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
          required: false,
        });
      await new Promise(resolve => setTimeout(resolve, 20));
      const urgentRequestId = 8_000 + iteration;
      const urgentStartedAt = performance.now();
      const urgentChunk = await transport.generateChunk({
        requestId: urgentRequestId,
        chunkX: owner.x,
        chunkZ: owner.z,
        priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
        required: true,
      });
      wallSamples.push(performance.now() - urgentStartedAt);
      const backgroundResult = await background;
      assert.ok(backgroundResult, 'active Background work must reach a terminal result');
      if (backgroundResult.sourceW5ContentHash) {
        assert.equal(backgroundResult.sourceW5ContentHash, urgentChunk.sourceW5ContentHash,
          'cross-lane canonical source identity must match');
      }
      const urgentStart = schedulerEvents.find(event => (
        event.type === 'started'
          && event.lane === WORKER_GENERATION_LANE.CRITICAL
          && event.envelope?.requestId === urgentRequestId
      ));
      assert.ok(urgentStart, 'Critical lane must expose urgent Worker queue timing');
      queueSamples.push(urgentStart.queueTimeMs);
      assert.ok(urgentStart.queueTimeMs < 50,
        `Critical urgent queue exceeded 50 ms: ${urgentStart.queueTimeMs}`);
      const diagnostics = await transport.requestDiagnostics();
      assert.equal(diagnostics.fixedWorkerLanes.schemaVersion, 'worker-fixed-lanes-1');
      const snapshot = transport.snapshot();
      assert.equal(snapshot.kind, 'worker-fixed-lanes');
      assert.equal(snapshot.lanes.critical.mode, 'worker');
      assert.equal(snapshot.lanes.background.mode, 'worker');
      assert.equal(snapshot.pendingCount, 0);
      residentSamples.push(Object.freeze({
        critical: diagnostics.fixedWorkerLanes.critical.canonicalOwnerCache?.size ?? null,
        background: diagnostics.fixedWorkerLanes.background.canonicalOwnerCache?.size ?? null,
      }));
    } finally {
      await transport.shutdown();
    }
  }
  const sortedQueue = [...queueSamples].sort((left, right) => left - right);
  const p95Queue = sortedQueue[Math.floor((sortedQueue.length - 1) * 0.95)];
  assert.ok(p95Queue < 16.7,
    `Critical urgent queue p95 exceeded 16.7 ms: ${p95Queue}`);
  t.diagnostic(JSON.stringify({
    schemaVersion: 'fixed-worker-lane-gate-c-benchmark-1',
    samples: queueSamples.length,
    urgentQueueMs: {
      p50: sortedQueue[Math.floor((sortedQueue.length - 1) * 0.5)],
      p95: p95Queue,
      max: sortedQueue.at(-1),
    },
    urgentWallMs: {
      p50: [...wallSamples].sort((left, right) => left - right)[2],
      max: Math.max(...wallSamples),
    },
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
    residentSamples,
  }));
});

test('Critical lane cancels active future-Full work at a real checkpoint before a different required Full', {
  timeout: 60_000,
}, async t => {
  const queueSamples = [];
  const cancellationSamples = [];
  const sharedSignalSamples = [];
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const schedulerEvents = [];
    const transport = createFixedLaneWorkerChunkGeneratorTransport({
      worldSeed: seed,
      serviceGeneration: 60 + iteration,
      workerFactory: createNodeChunkGeneratorWorker,
      onSchedulerEvent: event => schedulerEvents.push(event),
    });
    const coordinator = createFixedLaneOwnerGenerationCoordinator();
    try {
      await transport.initialize();
      const scheduleFull = ({ owner, priority, required, consumerId }) => {
        const handle = coordinator.schedule({
          ownerKey: `${owner.x},${owner.z}`,
          resourceKind: 'full',
          operationKind: 'chunk',
          priority,
          required,
          representationClass: 'detail',
          consumerId,
          execute: execution => transport.generateChunk({
            requestId: execution.envelope.requestId,
            chunkX: owner.x,
            chunkZ: owner.z,
            scheduler: execution.envelope,
          }),
          onCancel: (reason, envelope) => transport
            .cancelGenerationRequestBySchedulerRequestId({
              requestId: envelope.requestId,
              reason,
              lane: WORKER_GENERATION_LANE.CRITICAL,
            }),
        });
        return handle;
      };
      const futureOwner = { x: 55, z: 77 };
      const requiredOwner = { x: 58, z: 71 };
      const future = scheduleFull({
        owner: futureOwner,
        priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
        required: false,
        consumerId: `future-full-${iteration}`,
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      const required = scheduleFull({
        owner: requiredOwner,
        priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
        required: true,
        consumerId: `required-full-${iteration}`,
      });
      const [futureResult, requiredResult] = await Promise.all([
        future.promise,
        required.promise,
      ]);
      assert.equal(futureResult, null);
      assert.equal(requiredResult.chunkX, requiredOwner.x);
      const urgentStart = schedulerEvents.find(event => (
        event.type === 'started'
          && event.lane === WORKER_GENERATION_LANE.CRITICAL
          && event.envelope?.requestId === required.requestId
      ));
      assert.ok(urgentStart);
      queueSamples.push(urgentStart.queueTimeMs);
      const transportSnapshot = transport.snapshot();
      const cancellationMs = transportSnapshot.lanes.critical
        .cancellationAcknowledgementMsMaximum;
      cancellationSamples.push(cancellationMs);
      sharedSignalSamples.push(
        transportSnapshot.lanes.critical.counts.sharedCancellationSignals,
      );
      if (urgentStart.queueTimeMs >= 50 || cancellationMs >= 50) {
        const cancellationEvent = schedulerEvents.find(event => (
          event.type === 'cancel-acknowledged'
            && event.preemptedByRequestId === required.requestId
        ));
        t.diagnostic(JSON.stringify({
          schemaVersion: 'fixed-worker-critical-prefetch-checkpoint-slow-1',
          iteration,
          queueTimeMs: urgentStart.queueTimeMs,
          cancellationMs,
          sharedCancellationSignals: transportSnapshot.lanes.critical
            .counts.sharedCancellationSignals,
          sharedCancellationUnavailable: transportSnapshot.lanes.critical
            .counts.sharedCancellationUnavailable,
          cancellationCheckpointSite: cancellationEvent?.cancellationCheckpointSite ?? null,
        }));
      }
      assert.ok(urgentStart.queueTimeMs < 50,
        `future-Full blocker held required Full for ${urgentStart.queueTimeMs} ms; `
          + `Worker cancel acknowledgement ${cancellationMs} ms; iteration ${iteration}`);
      assert.ok(cancellationMs < 50,
        `future-Full cancel acknowledgement exceeded 50 ms: ${cancellationMs}`);
      const revisit = scheduleFull({
        owner: futureOwner,
        priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
        required: true,
        consumerId: `future-full-revisit-${iteration}`,
      });
      const revisitedChunk = await revisit.promise;
      assert.ok(revisitedChunk?.contentHash,
        'cancelled future-Full owner must remain canonically regenerable');
    } finally {
      await coordinator.shutdown({ reason: 'test-shutdown' });
      await transport.shutdown();
    }
  }
  const sortedQueue = [...queueSamples].sort((left, right) => left - right);
  const sortedCancel = [...cancellationSamples].sort((left, right) => left - right);
  const p95 = values => values[Math.floor((values.length - 1) * 0.95)];
  assert.ok(p95(sortedQueue) < 16.7,
    `future-Full urgent queue p95 exceeded 16.7 ms: ${p95(sortedQueue)}`);
  assert.ok(Math.max(...sortedCancel) < 50);
  t.diagnostic(JSON.stringify({
    schemaVersion: 'fixed-worker-critical-prefetch-preemption-benchmark-1',
    samples: queueSamples.length,
    urgentQueueMs: {
      p50: sortedQueue[Math.floor((sortedQueue.length - 1) * 0.5)],
      p95: p95(sortedQueue),
      max: sortedQueue.at(-1),
    },
    cancellationAcknowledgementMs: {
      p50: sortedCancel[Math.floor((sortedCancel.length - 1) * 0.5)],
      p95: p95(sortedCancel),
      max: sortedCancel.at(-1),
    },
    sharedCancellationSignals: sharedSignalSamples,
  }));
});

test('Worker diagnostics reject stale responses, ignore snapshots attached to normal responses, and stop on shutdown', async () => {
  const fake = new FakeWorker();
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 7,
    workerFactory: () => fake,
    shutdownDrainTimeoutMs: 5,
  });
  await transport.initialize();
  const generated = transport.generateChunk({ requestId: 61, chunkX: 6, chunkZ: 1 });
  await drainAsyncWork(2);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.GENERATED,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 61,
    serviceGeneration: 7,
    chunkData: fixtureChunk(6, 1),
    generationMs: 1,
    generatorSnapshot: { mustBeIgnored: true },
  });
  await generated;
  assert.equal(transport.snapshot().generatorSnapshot, null);

  const diagnostics = transport.requestDiagnostics();
  await drainAsyncWork(2);
  const requestId = fake.messages.at(-1).requestId;
  assert.equal(fake.messages.at(-1).type, CHUNK_GENERATOR_MESSAGE.REQUEST_DIAGNOSTICS);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.DIAGNOSTICS,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId,
    serviceGeneration: 6,
    generatorSnapshot: { stale: true },
    operationMs: 1,
  });
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.DIAGNOSTICS,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId,
    serviceGeneration: 7,
    generatorSnapshot: { current: true },
    operationMs: 1,
  });
  assert.deepEqual(await diagnostics, { current: true });
  assert.deepEqual(transport.snapshot().generatorSnapshot, { current: true });
  assert.equal(transport.snapshot().counts.staleGenerationResponses, 1);

  const pendingDiagnostics = transport.requestDiagnostics();
  await drainAsyncWork(2);
  await transport.shutdown();
  await assert.rejects(pendingDiagnostics, /shut down before response/);
  assert.equal(transport.snapshot().pendingCount, 0);
  assert.equal(transport.snapshot().generatorSnapshot, null);
  assert.equal(transport.snapshot().timingSampleCount, 0);
});

test('Forest horizon Worker requests are epoch-cancelled before stale generation can publish', async () => {
  const fake = new FakeWorker();
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 9,
    workerFactory: () => fake,
  });
  await transport.initialize();
  const pendingManifest = transport.generateForestHorizonManifest({
    chunkX: 11,
    chunkZ: 4,
    consumerId: 'distant-owner-query',
    epoch: 2,
  });
  await drainAsyncWork(2);
  const request = fake.messages.at(-1);
  assert.equal(request.type, CHUNK_GENERATOR_MESSAGE.GENERATE_FOREST_HORIZON);
  assert.equal(request.epoch, 2);
  assert.equal(transport.cancelForestHorizonRequests({
    consumerId: 'distant-owner-query',
    beforeEpoch: 3,
  }), 1);
  assert.equal(fake.messages.at(-1).type, CHUNK_GENERATOR_MESSAGE.CANCEL_FOREST_HORIZON);
  assert.equal(transport.snapshot().cancelledAwaitingAcknowledgementCount, 1);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.ERROR,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: request.requestId,
    serviceGeneration: 9,
    code: 'WORLD_GENERATION_CANCELLED',
    cancelled: true,
    cancellationReason: 'stale-forest-horizon-epoch',
    scheduler: {
      cancellationAcknowledgedAtCheckpoint: true,
      cancellationAcknowledgementMs: 1,
      preemptedByRequestId: null,
    },
  });
  assert.equal(await pendingManifest, null);
  assert.equal(transport.snapshot().cancelledAwaitingAcknowledgementCount, 0);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.GENERATED_FOREST_HORIZON,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: request.requestId,
    serviceGeneration: 9,
    manifest: { schemaVersion: 'must-not-publish' },
    generationMs: 1,
  });
  assert.equal(transport.snapshot().counts.forestHorizonGenerated, 0);
  assert.equal(transport.snapshot().counts.lateResponses, 1);
  const messageCount = fake.messages.length;
  assert.equal(await transport.generateForestHorizonManifest({
    chunkX: 12,
    chunkZ: 4,
    consumerId: 'distant-owner-query',
    epoch: 2,
  }), null);
  assert.equal(fake.messages.length, messageCount);
  await transport.shutdown();
});

test('non-crossOriginIsolated Worker fallback omits shared control and retains message cancellation', async () => {
  const fake = new FakeWorker();
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 10,
    workerFactory: () => fake,
    sharedCancellationBufferFactory: () => null,
  });
  await transport.initialize();
  const pendingCoverage = transport.resolveCanonicalMajorRoadOwnerCoverage({
    centerWorldX: 0,
    centerWorldZ: 0,
    radiusMeters: 0,
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    required: false,
  });
  await drainAsyncWork(2);
  const request = fake.messages.at(-1);
  assert.equal(request.type, CHUNK_GENERATOR_MESSAGE.RESOLVE_CANONICAL_MAJOR_ROAD_OWNERS);
  assert.equal(Object.hasOwn(request, 'sharedCancellationBuffer'), false);
  assert.equal(transport.cancelGenerationRequest({
    requestId: request.requestId,
    reason: 'non-isolated-message-cancel',
  }), true);
  assert.equal(fake.messages.at(-1).type, CHUNK_GENERATOR_MESSAGE.CANCEL_GENERATION);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.ERROR,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: request.requestId,
    serviceGeneration: 10,
    code: 'WORLD_GENERATION_CANCELLED',
    cancelled: true,
    cancellationReason: 'non-isolated-message-cancel',
    scheduler: {
      cancellationAcknowledgedAtCheckpoint: true,
      cancellationAcknowledgementMs: 1,
      preemptedByRequestId: null,
    },
  });
  assert.equal(await pendingCoverage, null);
  const snapshot = transport.snapshot();
  assert.equal(snapshot.counts.sharedCancellationUnavailable, 1);
  assert.equal(snapshot.counts.sharedCancellationSignals, 0);
  assert.equal(snapshot.counts.cancellationAcknowledgements, 1);
  await transport.shutdown();
});

test('shared cancellation flag reaches optional Worker work before the required message is delivered', async () => {
  const fake = new FakeWorker();
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 12,
    workerFactory: () => fake,
  });
  await transport.initialize();
  const optionalCoverage = transport.resolveCanonicalMajorRoadOwnerCoverage({
    centerWorldX: 0,
    centerWorldZ: 0,
    radiusMeters: 0,
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    required: false,
  });
  await drainAsyncWork(2);
  const optionalRequest = fake.messages.at(-1);
  assert.ok(optionalRequest.sharedCancellationBuffer instanceof SharedArrayBuffer);
  const cancellationView = new Int32Array(optionalRequest.sharedCancellationBuffer);
  assert.deepEqual([...cancellationView], [0, 0]);

  const urgent = transport.generateChunk({
    requestId: 90,
    chunkX: 0,
    chunkZ: 0,
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    required: true,
  });
  await drainAsyncWork(2);
  assert.deepEqual([...cancellationView], [1, 90]);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.ERROR,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: optionalRequest.requestId,
    serviceGeneration: 12,
    code: 'WORLD_GENERATION_CANCELLED',
    cancelled: true,
    cancellationReason: 'shared-control-cancelled',
    scheduler: {
      cancellationAcknowledgedAtCheckpoint: true,
      cancellationAcknowledgementMs: 0.2,
      preemptedByRequestId: 90,
    },
  });
  assert.equal(await optionalCoverage, null);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.GENERATED,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 90,
    serviceGeneration: 12,
    chunkData: fixtureChunk(0, 0),
    generationMs: 1,
  });
  assert.equal((await urgent).contentHash, fixtureChunk(0, 0).contentHash);
  assert.equal(transport.snapshot().counts.sharedCancellationSignals, 1);
  await transport.shutdown();
});

test('Worker transport sends the unified deadline envelope and settles a generic in-flight cancel', async () => {
  const fake = new FakeWorker();
  const schedulerEvents = [];
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 11,
    workerFactory: () => fake,
    clock: () => 40,
    onSchedulerEvent: event => schedulerEvents.push(event),
  });
  await transport.initialize();
  const pendingChunk = transport.generateChunk({
    requestId: 77,
    chunkX: 3,
    chunkZ: -2,
    priority: CHUNK_DATA_PRIORITY.PLAYER_RENDER,
    required: true,
    createdAtMs: 10,
    deadlineAtMs: 50,
    consumerId: 'phase-4',
    epoch: 9,
  });
  await drainAsyncWork(2);
  const request = fake.messages.at(-1);
  assert.equal(request.type, CHUNK_GENERATOR_MESSAGE.GENERATE);
  assert.equal(Object.hasOwn(request, 'pipelineDiagnostics'), false);
  assert.deepEqual(request.scheduler, {
    schemaVersion: 'world-generation-request-1',
    requestId: 77,
    operationKind: 'chunk',
    priority: CHUNK_DATA_PRIORITY.PLAYER_RENDER,
    priorityClass: null,
    required: true,
    createdAtMs: 10,
    deadlineAtMs: 50,
    firstVisibleDeadlineMs: 50,
    ownerKey: null,
    resourceKind: null,
    representationClass: null,
    sequence: null,
    subscriberIdentity: null,
    consumerId: 'phase-4',
    epoch: 9,
    correlationId: null,
    target: null,
    stream: null,
  });
  assert.deepEqual(request.schedulerClock, {
    schemaVersion: 'worker-scheduler-clock-1',
    sentAtMs: 40,
  });
  assert.equal(transport.cancelGenerationRequest({
    requestId: 77,
    reason: 'superseded-plan',
  }), true);
  assert.deepEqual(fake.messages.at(-1), {
    type: CHUNK_GENERATOR_MESSAGE.CANCEL_GENERATION,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 77,
    serviceGeneration: 11,
    reason: 'superseded-plan',
  });
  assert.equal(transport.snapshot().cancelledAwaitingAcknowledgementCount, 1);
  assert.equal(schedulerEvents.some(event => event.type === 'terminal'), false,
    'a cancel request is not terminal until the Worker stops the request');
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.GENERATED,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 77,
    serviceGeneration: 11,
    chunkData: fixtureChunk(3, -2),
    generationMs: 1,
  });
  assert.equal(await pendingChunk, null);
  assert.equal(transport.snapshot().counts.generated, 0);
  assert.equal(transport.snapshot().counts.lateResponses, 1);
  assert.deepEqual(
    schedulerEvents.filter(event => event.type === 'terminal').map(event => event.state),
    ['cancelled'],
  );
  await transport.shutdown();
});

test('Worker transport records the actual Worker checkpoint acknowledgement after main cancellation', async () => {
  const fake = new FakeWorker();
  const schedulerEvents = [];
  const pipelineEvents = [];
  let now = 40;
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 13,
    workerFactory: () => fake,
    clock: () => now,
    onSchedulerEvent: event => schedulerEvents.push(event),
    onPipelineEvent: (type, details) => pipelineEvents.push({ type, ...details }),
  });
  await transport.initialize();
  const pendingChunk = transport.generateChunk({
    requestId: 79,
    chunkX: 4,
    chunkZ: -2,
    priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
    required: false,
    consumerId: 'cancel-ack-test',
    epoch: 3,
  });
  await drainAsyncWork(2);
  now = 45;
  assert.equal(transport.cancelGenerationRequest({
    requestId: 79,
    reason: 'superseded-plan',
  }), true);
  assert.equal(transport.snapshot().cancelledAwaitingAcknowledgementCount, 1);
  now = 52;
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.ERROR,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 79,
    serviceGeneration: 13,
    name: 'WorldGenerationCancellationError',
    code: 'WORLD_GENERATION_CANCELLED',
    message: 'World generation cancelled: superseded-plan',
    recoverable: true,
    cancelled: true,
    cancellationReason: 'superseded-plan',
    scheduler: {
      cancellationAcknowledgementMs: 5,
      cancellationAcknowledgedAtCheckpoint: true,
      preemptedByRequestId: null,
    },
  });
  assert.equal(await pendingChunk, null);
  const snapshot = transport.snapshot();
  assert.equal(snapshot.cancelledAwaitingAcknowledgementCount, 0);
  assert.equal(snapshot.counts.cancelRequests, 1);
  assert.equal(snapshot.counts.cancellationAcknowledgements, 1);
  assert.equal(snapshot.counts.cancellationAcknowledgementOrphans, 0);
  assert.equal(snapshot.cancellationAcknowledgementMsP50, 7);
  assert.equal(snapshot.cancellationAcknowledgementMsMaximum, 7);
  const acknowledgement = schedulerEvents.find(event => event.type === 'cancel-acknowledged');
  assert.equal(acknowledgement.cancellationAcknowledgementMs, 7);
  assert.equal(acknowledgement.workerCancellationAcknowledgementMs, 5);
  assert.equal(acknowledgement.cancellationAcknowledgedAtCheckpoint, true);
  assert.equal(pipelineEvents.some(event => event.type === 'worker-cancel-acknowledged'), true);
  await transport.shutdown();
});

test('Worker transport preserves ERROR over cancel and emits exactly one failed terminal', async () => {
  const fake = new FakeWorker();
  const schedulerEvents = [];
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 18,
    workerFactory: () => fake,
    onSchedulerEvent: event => schedulerEvents.push(event),
  });
  await transport.initialize();
  const pendingChunk = transport.generateChunk({
    requestId: 80,
    chunkX: 4,
    chunkZ: -2,
    priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
    required: false,
  });
  await drainAsyncWork(2);
  assert.equal(transport.cancelGenerationRequest({
    requestId: 80,
    reason: 'cancel-raced-error',
  }), true);
  assert.equal(schedulerEvents.some(event => event.type === 'terminal'), false);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.ERROR,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 80,
    serviceGeneration: 18,
    name: 'CanonicalGenerationError',
    message: 'authoritative-transport-error',
    recoverable: false,
  });

  await assert.rejects(pendingChunk, /authoritative-transport-error/);
  assert.deepEqual(
    schedulerEvents.filter(event => event.type === 'terminal').map(event => event.state),
    ['failed'],
  );
  const snapshot = transport.snapshot();
  assert.equal(snapshot.cancelledAwaitingAcknowledgementCount, 0);
  assert.equal(snapshot.counts.cancellationAcknowledgements, 0);
  await transport.shutdown();
});

test('Worker transport cancels hidden control IDs by their owner scheduler requestId', async () => {
  const fake = new FakeWorker();
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 19,
    workerFactory: () => fake,
  });
  await transport.initialize();
  const schedulerRequestId = 42;
  const control = transport.findSettlementsNear(0, 0, 8, {
    scheduler: createChunkGeneratorSchedulerEnvelope({
      requestId: schedulerRequestId,
      operationKind: 'settlement-query',
      priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
      priorityClass: 5,
      required: false,
      createdAtMs: 0,
      ownerKey: 'settlement-query:0:0:8',
      resourceKind: 'settlement-query',
      representationClass: 'coarse',
      consumerId: 'control-cancel-test',
      epoch: 4,
    }),
  });
  await drainAsyncWork(2);
  const workerRequest = fake.messages.at(-1);
  assert.equal(workerRequest.type, CHUNK_GENERATOR_MESSAGE.FIND_SETTLEMENTS);
  assert.notEqual(workerRequest.requestId, schedulerRequestId);
  assert.equal(workerRequest.scheduler.requestId, schedulerRequestId);
  assert.equal(transport.cancelGenerationRequestBySchedulerRequestId({
    requestId: schedulerRequestId,
    reason: 'owner-control-preempted',
  }), true);
  assert.deepEqual(fake.messages.at(-1), {
    type: CHUNK_GENERATOR_MESSAGE.CANCEL_GENERATION,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: schedulerRequestId,
    serviceGeneration: 19,
    reason: 'owner-control-preempted',
  });
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.ERROR,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: workerRequest.requestId,
    serviceGeneration: 19,
    code: 'WORLD_GENERATION_CANCELLED',
    cancelled: true,
    cancellationReason: 'owner-control-preempted',
    scheduler: {
      cancellationAcknowledgedAtCheckpoint: true,
      preemptedByRequestId: null,
    },
  });
  assert.equal(await control, null);
  assert.equal(transport.snapshot().cancelledAwaitingAcknowledgementCount, 0);
  await transport.shutdown();
});

test('owner admission remains occupied until a coordinated Worker cancellation is acknowledged', async () => {
  const fake = new FakeWorker();
  const timeline = [];
  let now = 20;
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 15,
    workerFactory: () => fake,
    clock: () => now,
    onSchedulerEvent: event => {
      if (event.type === 'cancel-acknowledged') timeline.push('transport-ack');
    },
  });
  await transport.initialize();
  const coordinator = createOwnerGenerationCoordinator({
    clock: () => now,
    maximumConcurrentRequests: 1,
    onEvent: event => {
      if (event.type === 'cancel-acknowledged') timeline.push('coordinator-ack');
    },
  });
  const optional = coordinator.schedule({
    ownerKey: 'optional-owner',
    resourceKind: 'presentation',
    operationKind: 'presentation-owner',
    priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
    priorityClass: 5,
    required: false,
    representationClass: 'detail',
    execute: execution => transport.generateChunk({
      requestId: execution.envelope.requestId,
      chunkX: 7,
      chunkZ: 9,
      scheduler: execution.envelope,
    }),
    onCancel: (reason, envelope) => transport.cancelGenerationRequest({
      requestId: envelope.requestId,
      reason,
    }),
  });
  await drainAsyncWork(4);
  now = 24;
  const required = coordinator.schedule({
    ownerKey: 'required-owner',
    resourceKind: 'full',
    operationKind: 'chunk',
    priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
    priorityClass: 1,
    required: true,
    representationClass: 'detail',
    execute: async () => {
      timeline.push('required-start');
      return fixtureChunk(0, 0);
    },
  });
  await drainAsyncWork(4);
  assert.equal(optional.state, 'in-flight');
  assert.equal(required.state, 'queued');
  assert.deepEqual(timeline, []);
  assert.equal(transport.snapshot().cancelledAwaitingAcknowledgementCount, 1);

  now = 31;
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.ERROR,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: optional.requestId,
    serviceGeneration: 15,
    name: 'WorldGenerationCancellationError',
    code: 'WORLD_GENERATION_CANCELLED',
    message: 'World generation cancelled at checkpoint',
    recoverable: true,
    cancelled: true,
    cancellationReason: `preempted-by-higher-priority:${required.requestId}`,
    scheduler: {
      cancellationAcknowledgementMs: 4,
      cancellationAcknowledgedAtCheckpoint: true,
      preemptedByRequestId: required.requestId,
    },
  });
  assert.equal(await optional.promise, null);
  assert.deepEqual(await required.promise, fixtureChunk(0, 0));
  assert.deepEqual(timeline, [
    'transport-ack',
    'coordinator-ack',
    'required-start',
  ]);
  await coordinator.shutdown();
  await transport.shutdown();
});

test('Worker transport circuit-breaks failing scheduler and pipeline observers with diagnostics', async () => {
  const fake = new FakeWorker();
  let schedulerCalls = 0;
  let pipelineCalls = 0;
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 16,
    workerFactory: () => fake,
    clock: () => 10,
    onSchedulerEvent: () => {
      schedulerCalls += 1;
      throw new Error('scheduler-observer-failure');
    },
    onPipelineEvent: () => {
      pipelineCalls += 1;
      throw new Error('pipeline-observer-failure');
    },
  });
  await transport.initialize();
  const pendingChunk = transport.generateChunk({
    requestId: 81,
    chunkX: 1,
    chunkZ: 2,
  });
  await drainAsyncWork(2);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.GENERATED,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 81,
    serviceGeneration: 16,
    chunkData: fixtureChunk(1, 2),
    generationMs: 1,
  });
  await pendingChunk;
  const snapshot = transport.snapshot();
  assert.equal(schedulerCalls, 1);
  assert.equal(pipelineCalls, 1);
  assert.equal(snapshot.observerFailureCount, 2);
  assert.deepEqual(snapshot.observerCircuitBreakers, {
    scheduler: true,
    pipeline: true,
  });
  assert.equal(snapshot.counts.schedulerObserverFailures, 1);
  assert.equal(snapshot.counts.pipelineObserverFailures, 1);
  assert.ok(snapshot.lastObserverFailure);
  await transport.shutdown();
});

test('Worker transport attributes queue, execution, delivery, and main resolution only when diagnostics are enabled', async () => {
  const fake = new FakeWorker();
  const events = [];
  let now = 100;
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 12,
    workerFactory: () => fake,
    clock: () => now,
    onPipelineEvent: (type, details) => events.push({ type, ...details }),
  });
  await transport.initialize();
  const generated = transport.generateChunk({
    requestId: 78,
    chunkX: -4,
    chunkZ: 7,
    priority: CHUNK_DATA_PRIORITY.PLAYER_RENDER,
    required: true,
  });
  await drainAsyncWork(2);
  const request = fake.messages.at(-1);
  assert.equal(request.pipelineDiagnostics, true);
  assert.equal(events.at(-1).type, 'worker-message-sent');
  assert.equal(events.at(-1).ownerKey, '-4,7');

  now = 125;
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.GENERATED,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 78,
    serviceGeneration: 12,
    chunkKey: '-4,7',
    chunkData: fixtureChunk(-4, 7),
    generationMs: 12,
    scheduler: { queueTimeMs: 5, backlogAtStart: 2 },
    pipelineTiming: {
      workerTimeOriginMs: globalThis.performance.timeOrigin,
      responseSentAtMs: 124,
    },
  });
  assert.equal((await generated).chunkId, fixtureChunk(-4, 7).chunkId);
  const received = events.find(event => event.type === 'worker-message-received');
  assert.equal(received.requestToMessageMs, 25);
  assert.equal(received.workerQueueTimeMs, 5);
  assert.equal(received.workerExecutionMs, 12);
  assert.equal(received.residualWaitMs, 7);
  assert.equal(received.messageDeliveryMs, 1);
  assert.equal(events.at(-1).type, 'worker-response-resolved');
  assert.equal(events.at(-1).mainHandlerMs, 0);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.PIPELINE_TIMING,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 78,
    serviceGeneration: 12,
    chunkKey: '-4,7',
    workerTimeOriginMs: globalThis.performance.timeOrigin,
    requestReceivedAtMs: 104,
    generationStartedAtMs: 110,
    generationCompletedAtMs: 122,
    generationTotalMs: 12,
    responsePostStartedAtMs: 123,
    responsePostCompletedAtMs: 124,
    postMessageCallMs: 1,
    scheduler: {
      queueTimeMs: 5,
      workerQueueResidentMs: 6,
      deadlineMiss: false,
    },
    stageTiming: {
      totalsMs: { terrain: 9, canonical: 3 },
      callCounts: { terrain: 1, canonical: 1 },
      events: [{
        sequence: 1,
        stage: 'terrain',
        startedAtMs: 110,
        completedAtMs: 119,
        durationMs: 9,
        status: 'completed',
      }],
    },
  });
  const stages = events.find(event => event.type === 'worker-chunk-stages');
  assert.equal(stages.ownerKey, '-4,7');
  assert.equal(stages.workerQueueResidentMs, 6);
  assert.equal(stages.generationTotalMs, 12);
  assert.equal(stages.stageTotalsMs.terrain, 9);
  assert.equal(stages.postMessageCallMs, 1);
  assert.equal(stages.transferMs, 1);
  assert.equal(stages.deadlineMissAtMainReceive, false);
  assert.equal(transport.snapshot().counts.lateResponses, 0);
  await transport.shutdown();
});

test('Worker core observes Forest horizon cancellation outside its serial generation chain', async () => {
  const responses = [];
  let manifestCalls = 0;
  const core = createChunkGeneratorWorkerCore({
    postMessage: response => responses.push(response),
    generatorFactory: async () => ({
      worldSeed: seed,
      worldSeedHash: `sha256:${'3'.repeat(64)}`,
      generatorVersion: { major: 800, minor: 0, patch: 0 },
      experienceSpawn: { x: 0, z: 0 },
      reviewSpawn: { x: 0, z: 0 },
      distributor: { findSettlementsNear: async () => [] },
      async generateForestHorizonManifest() {
        manifestCalls += 1;
        return { schemaVersion: 'must-not-run' };
      },
    }),
  });
  await core.receive({
    type: CHUNK_GENERATOR_MESSAGE.INITIALIZE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 4,
    worldSeed: seed,
  });
  const queued = core.receive({
    type: CHUNK_GENERATOR_MESSAGE.GENERATE_FOREST_HORIZON,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 1,
    serviceGeneration: 4,
    chunkX: 11,
    chunkZ: 4,
    consumerId: 'distant-owner-query',
    epoch: 7,
  });
  await core.receive({
    type: CHUNK_GENERATOR_MESSAGE.CANCEL_FOREST_HORIZON,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 4,
    consumerId: 'distant-owner-query',
    beforeEpoch: 8,
  });
  await queued;
  assert.equal(manifestCalls, 0);
  assert.equal(responses.some(response => (
    response.type === CHUNK_GENERATOR_MESSAGE.GENERATED_FOREST_HORIZON
  )), false);
  await core.shutdown();
});

test('Worker core schedules every operation kind through one priority envelope', async () => {
  const responses = [];
  const order = [];
  let releaseBlocker;
  const blocker = new Promise(resolve => { releaseBlocker = resolve; });
  const core = createChunkGeneratorWorkerCore({
    postMessage: response => responses.push(response),
    schedulerOptions: { agingIntervalMs: 100_000 },
    generatorFactory: async () => ({
      worldSeed: seed,
      worldSeedHash: `sha256:${'4'.repeat(64)}`,
      generatorVersion: { major: 800, minor: 0, patch: 0 },
      experienceSpawn: { x: 0, z: 0 },
      reviewSpawn: { x: 0, z: 0 },
      async generateChunk(chunkX, chunkZ) {
        order.push('chunk-blocker');
        await blocker;
        return fixtureChunk(chunkX, chunkZ);
      },
      async generateForestHorizonManifest(chunkX, chunkZ) {
        order.push('forest-warm');
        return {
          ...fixtureChunk(chunkX, chunkZ),
          schemaVersion: 'w8-forest-horizon-owner-summary-1',
        };
      },
      distributor: {
        async findSettlementsNear() {
          order.push('settlement-required');
          return [];
        },
      },
    }),
  });
  const base = {
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 8,
  };
  await core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.INITIALIZE,
    worldSeed: seed,
  });
  const chunkRequest = core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.GENERATE,
    requestId: 1,
    chunkX: 0,
    chunkZ: 0,
    scheduler: createChunkGeneratorSchedulerEnvelope({
      requestId: 1,
      operationKind: 'chunk',
      priority: 1,
      required: true,
      createdAtMs: 0,
    }),
  });
  await drainAsyncWork(2);
  const forestRequest = core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.GENERATE_FOREST_HORIZON,
    requestId: 2,
    chunkX: 1,
    chunkZ: 0,
    consumerId: 'forest',
    epoch: 1,
    scheduler: createChunkGeneratorSchedulerEnvelope({
      requestId: 2,
      operationKind: 'forest-horizon',
      priority: 5,
      required: false,
      createdAtMs: 0,
      consumerId: 'forest',
      epoch: 1,
    }),
  });
  const settlementRequest = core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.FIND_SETTLEMENTS,
    requestId: 3,
    centerWorldX: 0,
    centerWorldZ: 0,
    radiusMeters: 100,
    scheduler: createChunkGeneratorSchedulerEnvelope({
      requestId: 3,
      operationKind: 'settlement-query',
      priority: 1,
      required: true,
      createdAtMs: 0,
    }),
  });
  releaseBlocker();
  await Promise.all([chunkRequest, forestRequest, settlementRequest]);
  assert.deepEqual(order, ['chunk-blocker', 'settlement-required', 'forest-warm']);
  assert.deepEqual(
    responses.filter(response => response.requestId).map(response => response.requestId),
    [1, 3, 2],
  );
  await core.shutdown();
});

test('Worker core preempts optional active work and acknowledges its checkpoint before required work', async () => {
  const responses = [];
  const schedulerEvents = [];
  let releaseOptional;
  const optionalGate = new Promise(resolve => { releaseOptional = resolve; });
  const order = [];
  const core = createChunkGeneratorWorkerCore({
    postMessage: response => responses.push(response),
    schedulerOptions: { onEvent: event => schedulerEvents.push(event) },
    generatorFactory: async () => ({
      worldSeed: seed,
      worldSeedHash: `sha256:${'c'.repeat(64)}`,
      generatorVersion: { major: 800, minor: 0, patch: 0 },
      experienceSpawn: { x: 0, z: 0 },
      reviewSpawn: { x: 0, z: 0 },
      distributor: {
        async findSettlementsNear() {
          order.push('required');
          return [];
        },
      },
      async generateForestHorizonManifest(chunkX, chunkZ, { checkpoint }) {
        order.push('optional-start');
        await optionalGate;
        checkpoint();
        order.push('optional-after-checkpoint');
        return {
          ...fixtureChunk(chunkX, chunkZ),
          schemaVersion: 'must-not-publish',
        };
      },
    }),
  });
  const base = {
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 14,
  };
  await core.receive({ ...base, type: CHUNK_GENERATOR_MESSAGE.INITIALIZE, worldSeed: seed });
  const optional = core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.GENERATE_FOREST_HORIZON,
    requestId: 31,
    chunkX: 8,
    chunkZ: 4,
    consumerId: 'preemption-test',
    epoch: 1,
    scheduler: createChunkGeneratorSchedulerEnvelope({
      requestId: 31,
      operationKind: 'forest-horizon',
      priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
      priorityClass: 5,
      required: false,
      createdAtMs: 0,
      consumerId: 'preemption-test',
      epoch: 1,
    }),
  });
  await drainAsyncWork(2);
  const required = core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.FIND_SETTLEMENTS,
    requestId: 32,
    centerWorldX: 0,
    centerWorldZ: 0,
    radiusMeters: 16,
    scheduler: createChunkGeneratorSchedulerEnvelope({
      requestId: 32,
      operationKind: 'settlement-query',
      priority: CHUNK_DATA_PRIORITY.PLAYER_DATA,
      priorityClass: 1,
      required: true,
      createdAtMs: 0,
    }),
  });
  releaseOptional();
  await Promise.all([optional, required]);
  assert.deepEqual(order, ['optional-start', 'required']);
  assert.equal(responses.some(response => (
    response.type === CHUNK_GENERATOR_MESSAGE.GENERATED_FOREST_HORIZON
      && response.requestId === 31
  )), false);
  const cancellation = responses.find(response => response.requestId === 31);
  assert.equal(cancellation.type, CHUNK_GENERATOR_MESSAGE.ERROR);
  assert.equal(cancellation.cancelled, true);
  assert.equal(cancellation.code, 'WORLD_GENERATION_CANCELLED');
  assert.equal(cancellation.scheduler.cancellationAcknowledgedAtCheckpoint, true);
  assert.equal(cancellation.scheduler.preemptedByRequestId, 32);
  assert.equal(responses.some(response => (
    response.type === CHUNK_GENERATOR_MESSAGE.SETTLEMENTS
      && response.requestId === 32
  )), true);
  assert.equal(schedulerEvents.some(event => (
    event.type === 'cancel-acknowledged' && event.preemptedByRequestId === 32
  )), true);
  await core.shutdown();
});

test('Worker core suppresses an in-flight result after a generic cooperative cancel checkpoint', async () => {
  const responses = [];
  let releaseGeneration;
  const generationGate = new Promise(resolve => { releaseGeneration = resolve; });
  const core = createChunkGeneratorWorkerCore({
    postMessage: response => responses.push(response),
    generatorFactory: async () => ({
      worldSeed: seed,
      worldSeedHash: `sha256:${'5'.repeat(64)}`,
      generatorVersion: { major: 800, minor: 0, patch: 0 },
      experienceSpawn: { x: 0, z: 0 },
      reviewSpawn: { x: 0, z: 0 },
      distributor: { findSettlementsNear: async () => [] },
      async generateChunk(chunkX, chunkZ) {
        await generationGate;
        return fixtureChunk(chunkX, chunkZ);
      },
    }),
  });
  const base = {
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 10,
  };
  await core.receive({ ...base, type: CHUNK_GENERATOR_MESSAGE.INITIALIZE, worldSeed: seed });
  const request = core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.GENERATE,
    requestId: 22,
    chunkX: 2,
    chunkZ: 2,
    scheduler: createChunkGeneratorSchedulerEnvelope({
      requestId: 22,
      operationKind: 'chunk',
      priority: 1,
      required: true,
      createdAtMs: 0,
    }),
  });
  await drainAsyncWork(2);
  await core.receive({
    ...base,
    type: CHUNK_GENERATOR_MESSAGE.CANCEL_GENERATION,
    requestId: 22,
    reason: 'superseded-plan',
  });
  releaseGeneration();
  await request;
  assert.equal(responses.some(response => (
    response.type === CHUNK_GENERATOR_MESSAGE.GENERATED && response.requestId === 22
  )), false);
  const cancellation = responses.find(response => response.requestId === 22);
  assert.equal(cancellation.type, CHUNK_GENERATOR_MESSAGE.ERROR);
  assert.equal(cancellation.cancelled, true);
  assert.equal(cancellation.cancellationReason, 'superseded-plan');
  assert.equal(cancellation.scheduler.cancellationAcknowledgedAtCheckpoint, true);
  await core.shutdown();
});

test('Worker transport discards old serviceGeneration and accepts only the current response', async () => {
  const fake = new FakeWorker();
  const transport = createWorkerChunkGeneratorTransport({ worldSeed: seed, serviceGeneration: 7, workerFactory: () => fake });
  await transport.initialize();
  assert.deepEqual(fake.messages[0], {
    type: CHUNK_GENERATOR_MESSAGE.INITIALIZE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 7,
    worldSeed: seed,
  });
  const pending = transport.generateChunk({ requestId: 11, chunkX: 2, chunkZ: 3 });
  await Promise.resolve();
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.GENERATED,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 11,
    serviceGeneration: 6,
    chunkData: fixtureChunk(2, 3, 'stale'),
    generationMs: 1,
  });
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.GENERATED,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 11,
    serviceGeneration: 7,
    chunkData: fixtureChunk(2, 3),
    generationMs: 1,
  });
  assert.equal((await pending).chunkId, fixtureChunk(2, 3).chunkId);
  assert.equal(transport.snapshot().counts.staleGenerationResponses, 1);
  await transport.shutdown();
});

test('Worker transport rejects an unknown current-schema response with one failed terminal', async () => {
  const fake = new FakeWorker();
  const schedulerEvents = [];
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 8,
    workerFactory: () => fake,
    onSchedulerEvent: event => schedulerEvents.push(event),
  });
  await transport.initialize();
  const pending = transport.generateChunk({ requestId: 12, chunkX: 2, chunkZ: 4 });
  await Promise.resolve();
  fake.emit({
    type: 'chunk-generator:unknown-success',
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 12,
    serviceGeneration: 8,
  });
  await assert.rejects(pending, /unexpected Chunk generator Worker response/);
  const cancelled = transport.generateChunk({
    requestId: 13,
    chunkX: 2,
    chunkZ: 5,
    priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
    required: false,
  });
  await Promise.resolve();
  assert.equal(transport.cancelGenerationRequest({
    requestId: 13,
    reason: 'unknown-response-after-cancel',
  }), true);
  fake.emit({
    type: 'chunk-generator:unknown-success',
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 13,
    serviceGeneration: 8,
  });
  await assert.rejects(cancelled, /unexpected Chunk generator Worker response/);
  const terminals = schedulerEvents.filter(event => event.type === 'terminal');
  assert.deepEqual(terminals.map(event => event.state), ['failed', 'failed']);
  assert.equal(transport.snapshot().pendingCount, 0);
  assert.equal(transport.snapshot().cancelledAwaitingAcknowledgementCount, 0);
  await transport.shutdown();
});

test('Worker constructor and initialize failures fall back once to Inline without concurrent execution', async t => {
  await t.test('constructor failure', async () => {
    const transport = createWorkerChunkGeneratorTransport({
      worldSeed: seed,
      workerFactory: () => { throw new Error('constructor failed'); },
      fallbackTransportFactory: async () => fallbackFactory(),
    });
    await transport.initialize();
    const result = await transport.generateChunk({ requestId: 1, chunkX: 1, chunkZ: 1 });
    assert.equal(result.chunkX, 1);
    assert.deepEqual(await transport.requestDiagnostics(), { fallback: true });
    assert.equal(transport.snapshot().mode, 'inline-fallback');
    assert.equal(transport.snapshot().counts.fallbackCount, 1);
    assert.equal(transport.snapshot().counts.diagnosticQueries, 1);
    assert.deepEqual(transport.snapshot().generatorSnapshot, { fallback: true });
    await transport.shutdown();
  });
  await t.test('initialize failure', async () => {
    const fake = new FakeWorker({ initializeError: 'init failed' });
    const transport = createWorkerChunkGeneratorTransport({
      worldSeed: seed,
      workerFactory: () => fake,
      fallbackTransportFactory: async () => fallbackFactory(),
    });
    await transport.initialize();
    assert.equal(fake.terminated, true);
    assert.equal(transport.snapshot().fallbackOccurred, true);
    assert.match(transport.snapshot().fallbackReason.message, /init failed/);
    await transport.shutdown();
  });
  await t.test('fallback initialize failure closes the unpublished candidate', async () => {
    let candidateShutdownCalls = 0;
    const transport = createWorkerChunkGeneratorTransport({
      worldSeed: seed,
      workerFactory: () => { throw new Error('constructor failed before fallback'); },
      fallbackTransportFactory: async () => ({
        async initialize() { throw new Error('fallback initialize failed'); },
        async generateChunk() { return fixtureChunk(0, 0); },
        async shutdown() { candidateShutdownCalls += 1; },
      }),
    });
    await assert.rejects(transport.initialize(), /fallback initialize failed/);
    assert.equal(candidateShutdownCalls, 1);
    assert.equal(transport.snapshot().fallbackOccurred, false);
    await transport.shutdown();
    assert.equal(candidateShutdownCalls, 1);
  });
});

test('a runtime Worker error rejects current requests once and moves later work to Inline', async () => {
  const fake = new FakeWorker();
  let fallbackCreations = 0;
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    workerFactory: () => fake,
    fallbackTransportFactory: async () => {
      fallbackCreations += 1;
      return fallbackFactory();
    },
  });
  await transport.initialize();
  const first = transport.generateChunk({ requestId: 41, chunkX: 4, chunkZ: 1 });
  const second = transport.generateChunk({ requestId: 42, chunkX: 4, chunkZ: 2 });
  await drainAsyncWork(2);
  fake.emitError(new Error('runtime Worker crashed'));
  await assert.rejects(first, /runtime Worker crashed/);
  await assert.rejects(second, /runtime Worker crashed/);
  await drainAsyncWork();

  assert.equal(fake.terminated, true);
  assert.equal(fallbackCreations, 1);
  assert.equal(transport.snapshot().mode, 'inline-fallback');
  assert.equal(transport.snapshot().counts.fallbackCount, 1);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.GENERATED,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 41,
    serviceGeneration: 1,
    chunkData: fixtureChunk(4, 1, 'stale-after-crash'),
    generationMs: 1,
  });
  const recovered = await transport.generateChunk({ requestId: 43, chunkX: 7, chunkZ: 8 });
  assert.equal(recovered.chunkId, fixtureChunk(7, 8).chunkId);
  assert.equal(transport.snapshot().counts.generated, 0, 'old Worker responses stay detached');
  await transport.shutdown();
});

test('ChunkDataService resumes Chunk dispatch through Inline after its Worker crashes', async () => {
  const fake = new FakeWorker();
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    workerFactory: () => fake,
    fallbackTransportFactory: async () => fallbackFactory(),
  });
  const service = new ChunkDataService({ transport, cacheCapacity: 4 });
  await service.initialize();
  const failed = service.requestChunk({
    chunkX: 20,
    chunkZ: 3,
    priority: CHUNK_DATA_PRIORITY.PLAYER_RENDER,
    consumerId: 'runtime-transition',
    epoch: 1,
  }).promise;
  await drainAsyncWork();
  fake.emitError(new Error('streaming Worker crashed'));
  await assert.rejects(failed, /streaming Worker crashed/);

  const recovered = await service.requestChunk({
    chunkX: 21,
    chunkZ: 3,
    priority: CHUNK_DATA_PRIORITY.PLAYER_RENDER,
    consumerId: 'runtime-transition',
    epoch: 2,
  }).promise;
  assert.equal(recovered.chunkId, fixtureChunk(21, 3).chunkId);
  assert.equal(service.snapshot().transport.mode, 'inline-fallback');
  assert.equal(service.snapshot().counts.transportCalls, 2);
  await service.shutdown();
});

test('shutdown during runtime recovery never publishes or retains the fallback', async () => {
  const fake = new FakeWorker();
  let releaseFallback;
  let fallbackStarted = false;
  let candidate = null;
  const fallbackGate = new Promise(resolve => { releaseFallback = resolve; });
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    workerFactory: () => fake,
    fallbackTransportFactory: async () => {
      fallbackStarted = true;
      await fallbackGate;
      candidate = fallbackFactory();
      return candidate;
    },
  });
  await transport.initialize();
  fake.emitError(new Error('runtime Worker crashed before shutdown'));
  await drainAsyncWork();
  assert.equal(fallbackStarted, true);

  await transport.shutdown();
  await assert.rejects(
    transport.generateChunk({ requestId: 44, chunkX: 1, chunkZ: 1 }),
    /shut down/,
  );
  releaseFallback();
  await waitFor(() => candidate?.snapshot().isShutdown === true);
  assert.equal(transport.snapshot().isShutdown, true);
  assert.equal(transport.snapshot().mode, 'shutdown');
  assert.equal(transport.snapshot().fallbackOccurred, false);
  assert.equal(transport.snapshot().counts.fallbackCount, 0);
  assert.equal(candidate.snapshot().isShutdown, true);
});

test('Worker shutdown waits for cancellation acknowledgement before terminating', async () => {
  const fake = new FakeWorker();
  const schedulerEvents = [];
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 21,
    workerFactory: () => fake,
    shutdownDrainTimeoutMs: 100,
    onSchedulerEvent: event => schedulerEvents.push(event),
  });
  await transport.initialize();
  const pending = transport.generateChunk({ requestId: 1, chunkX: 8, chunkZ: 9 });
  await drainAsyncWork(2);
  const shutdown = transport.shutdown();
  await drainAsyncWork(2);
  assert.equal(fake.terminated, undefined);
  assert.equal(transport.snapshot().shutdownDraining, true);
  assert.equal(transport.snapshot().cancelledAwaitingAcknowledgementCount, 1);
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.ERROR,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 1,
    serviceGeneration: 21,
    code: 'WORLD_GENERATION_CANCELLED',
    cancelled: true,
    cancellationReason: 'transport-shutdown',
    scheduler: {
      cancellationAcknowledgedAtCheckpoint: true,
      cancellationAcknowledgementMs: 1,
      preemptedByRequestId: null,
    },
  });

  assert.equal(await pending, null);
  assert.equal(await shutdown, true);
  assert.equal(fake.terminated, true);
  assert.deepEqual(
    schedulerEvents.filter(event => event.type === 'terminal').map(event => event.state),
    ['cancelled'],
  );
});

test('shutdown rejects a late Worker request and ChunkDataService still rejects identity mismatch', async () => {
  const fake = new FakeWorker();
  const schedulerEvents = [];
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    workerFactory: () => fake,
    shutdownDrainTimeoutMs: 5,
    onSchedulerEvent: event => schedulerEvents.push(event),
  });
  await transport.initialize();
  const pending = transport.generateChunk({ requestId: 1, chunkX: 8, chunkZ: 9 });
  await Promise.resolve();
  const pendingFailure = assert.rejects(pending, /shut down before response/);
  assert.equal(await transport.shutdown(), false);
  await pendingFailure;
  assert.equal(transport.snapshot().counts.shutdownDrainTimeouts, 1);
  assert.deepEqual(
    schedulerEvents.filter(event => event.type === 'terminal').map(event => event.state),
    ['failed'],
  );

  let revision = 'a';
  const identityTransport = {
    async generateChunk({ chunkX, chunkZ }) { return fixtureChunk(chunkX, chunkZ, revision); },
    async shutdown() {},
  };
  const service = new ChunkDataService({ transport: identityTransport, cacheCapacity: 1 });
  await service.requestChunk({ chunkX: 0, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.PLAYER_DATA }).promise;
  await service.requestChunk({ chunkX: 1, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.PLAYER_DATA }).promise;
  revision = 'b';
  await assert.rejects(
    service.requestChunk({ chunkX: 0, chunkZ: 0, priority: CHUNK_DATA_PRIORITY.PLAYER_DATA }).promise,
    /identity\/content/,
  );
  await service.shutdown();
});

test('production consumers do not call generator and only generator transports/core do', () => {
  const root = resolve(import.meta.dirname, '..', 'src', 'infinite-world');
  for (const relative of [
    'chunk-runtime-manager.js', 'gameplay-runtime.js',
    'render/w8-distant-presentation.js', 'sandbox-boot.js', 'chunk-data-service.js',
  ]) {
    assert.doesNotMatch(readFileSync(resolve(root, relative), 'utf8'), /generator\.generateChunk\s*\(/, relative);
  }
  assert.match(readFileSync(resolve(root, 'inline-chunk-generator-transport.js'), 'utf8'), /generator\.generateChunk\s*\(/);
  assert.match(readFileSync(resolve(root, 'chunk-generator-worker-core.js'), 'utf8'), /generator\.generateChunk\s*\(/);
});
