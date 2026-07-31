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
import { createChunkGeneratorWorkerCore } from '../src/infinite-world/chunk-generator-worker-core.js';
import { createNodeChunkGeneratorWorker } from '../src/infinite-world/node-worker-chunk-generator-adapter.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import { createWorkerChunkGeneratorTransport } from '../src/infinite-world/worker-chunk-generator-transport.js';

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
  constructor({ initializeError = null } = {}) {
    this.initializeError = initializeError;
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
      metadata: { worldSeed: seed },
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

test('Worker diagnostics reject stale responses, ignore snapshots attached to normal responses, and stop on shutdown', async () => {
  const fake = new FakeWorker();
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 7,
    workerFactory: () => fake,
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
  assert.equal(await pendingManifest, null);
  assert.equal(fake.messages.at(-1).type, CHUNK_GENERATOR_MESSAGE.CANCEL_FOREST_HORIZON);
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

test('Worker transport sends the unified deadline envelope and settles a generic in-flight cancel', async () => {
  const fake = new FakeWorker();
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 11,
    workerFactory: () => fake,
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
  assert.deepEqual(request.scheduler, {
    schemaVersion: 'world-generation-request-1',
    requestId: 77,
    operationKind: 'chunk',
    priority: CHUNK_DATA_PRIORITY.PLAYER_RENDER,
    required: true,
    createdAtMs: 10,
    deadlineAtMs: 50,
    consumerId: 'phase-4',
    epoch: 9,
    correlationId: null,
    target: null,
    stream: null,
  });
  assert.equal(transport.cancelGenerationRequest({
    requestId: 77,
    reason: 'superseded-plan',
  }), true);
  assert.equal(await pendingChunk, null);
  assert.deepEqual(fake.messages.at(-1), {
    type: CHUNK_GENERATOR_MESSAGE.CANCEL_GENERATION,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 77,
    serviceGeneration: 11,
    reason: 'superseded-plan',
  });
  fake.emit({
    type: CHUNK_GENERATOR_MESSAGE.GENERATED,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: 77,
    serviceGeneration: 11,
    chunkData: fixtureChunk(3, -2),
    generationMs: 1,
  });
  assert.equal(transport.snapshot().counts.generated, 0);
  assert.equal(transport.snapshot().counts.lateResponses, 1);
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
  assert.equal(responses.some(response => response.requestId === 22), false);
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

test('shutdown rejects a late Worker request and ChunkDataService still rejects identity mismatch', async () => {
  const fake = new FakeWorker();
  const transport = createWorkerChunkGeneratorTransport({ worldSeed: seed, workerFactory: () => fake });
  await transport.initialize();
  const pending = transport.generateChunk({ requestId: 1, chunkX: 8, chunkZ: 9 });
  await Promise.resolve();
  await transport.shutdown();
  await assert.rejects(pending, /shut down before response/);

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
