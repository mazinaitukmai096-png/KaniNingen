import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { ChunkDataService } from '../src/infinite-world/chunk-data-service.js';
import {
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
  CHUNK_DATA_PRIORITY,
} from '../src/infinite-world/chunk-data-service-protocol.js';
import { createInlineChunkGeneratorTransport } from '../src/infinite-world/inline-chunk-generator-transport.js';
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
      metadata: { worldSeed: seed, generatorSnapshot: null },
    }));
  }
  emit(data) { this.listeners.get('message')?.({ data }); }
  async terminate() { this.terminated = true; }
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

test('real Node module Worker matches Inline W8 identity, owner, terrain, Settlement, presentation and spawn metadata', async () => {
  const inlineGenerator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const inline = createInlineChunkGeneratorTransport({ generator: inlineGenerator });
  const worker = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    workerFactory: createNodeChunkGeneratorWorker,
  });
  const [inlineMetadata, workerMetadata] = await Promise.all([inline.initialize(), worker.initialize()]);
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
  assert.equal(worker.snapshot().mode, 'worker');
  assert.equal(worker.snapshot().counts.generated, coordinates.length);
  assert.ok(worker.snapshot().generationMsMaximum > 0);
  assert.ok(worker.snapshot().settlementQueryMsMaximum >= 0);
  assert.ok(worker.snapshot().settlementQueryReceiveMsMaximum >= 0);
  assert.ok(worker.snapshot().settlementTemplateMsMaximum > 0);
  assert.ok(worker.snapshot().settlementTemplateReceiveMsMaximum >= 0);
  await Promise.all([inline.shutdown(), worker.shutdown()]);
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
    assert.equal(transport.snapshot().mode, 'inline-fallback');
    assert.equal(transport.snapshot().counts.fallbackCount, 1);
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
