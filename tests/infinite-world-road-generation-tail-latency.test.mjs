import assert from 'node:assert/strict';
import test from 'node:test';

import { selectSettlementBuildingType } from '../src/settlement-building-visuals.js';
import {
  ROAD_GENERATION_COUNTER_ORDER,
  ROAD_GENERATION_SPAN_ORDER,
  ROAD_GENERATION_TIMING_SCHEMA,
  createRoadGenerationTimingRecorder,
} from '../src/infinite-world/road-generation-timing.js';
import {
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
} from '../src/infinite-world/chunk-data-service-protocol.js';
import { createChunkGeneratorWorkerCore } from '../src/infinite-world/chunk-generator-worker-core.js';
import { createNodeChunkGeneratorWorker } from '../src/infinite-world/node-worker-chunk-generator-adapter.js';
import {
  createW8ParityChunkGenerator,
  hashW8ParityChunkContent,
} from '../src/infinite-world/w8-parity-chunk-generator.js';
import {
  createW8SettlementBuildingTypeSelector,
} from '../src/infinite-world/w8-settlement-building-visual-policy.js';
import {
  createWorkerChunkGeneratorTransport,
} from '../src/infinite-world/worker-chunk-generator-transport.js';

const ROAD_HEAVY_OWNER = Object.freeze({ x: 55, z: 77 });
const ROAD_HEAVY_OWNER_KEY = `${ROAD_HEAVY_OWNER.x},${ROAD_HEAVY_OWNER.z}`;
const REPORTED_OWNER = Object.freeze({ x: 160, z: 29 });
const REPORTED_OWNER_CONTENT_HASH =
  'sha256:d3f2838c2b19a1862e55918a12a4d7fcf5fba47f4abe2fd0523cfd213378caab';
const REPORTED_OWNER_PREDECESSOR = Object.freeze({ x: 159, z: 29 });
const REPORTED_OWNER_COMPARISON = Object.freeze({ x: 161, z: 29 });
const ROAD_HEAVY_OWNER_CONTENT_HASH =
  'sha256:9dd3b8a235e2e59ccc143e568b2a3da1eff37906117c08a9f02523789a7f93e0';
const WORLD_SEED = 'KaniNingen Infinite Natural World';
const BUILDING_SELECTOR_INDEX_COUNT = 512;

function nonMonotonicIndices(count) {
  // 173 is coprime with 512, so this is a deterministic permutation rather
  // than a sequential cache-fill order.
  return Object.freeze(Array.from({ length: count }, (_, offset) => (
    (offset * 173) % count + 1
  )));
}

function roadTimingContext() {
  const recorder = createRoadGenerationTimingRecorder();
  return {
    recorder,
    deadlineAtMs: null,
    deadlineMissAtStart: false,
    cold: false,
    run: null,
    completedRun: null,
  };
}

function canonicalMajorRoadFeatures(chunk) {
  return chunk.settlementFeatures.filter(feature => feature.canonicalMajorRoad === true);
}

function assertRoadTimingSnapshot(snapshot, owner = ROAD_HEAVY_OWNER) {
  assert.ok(snapshot);
  assert.equal(snapshot.schemaVersion, ROAD_GENERATION_TIMING_SCHEMA);
  assert.equal(snapshot.ownerKey, `${owner.x},${owner.z}`);
  assert.deepEqual(snapshot.owner, owner);
  assert.equal(snapshot.status, 'completed');
  assert.equal(typeof snapshot.cold, 'boolean');
  assert.equal(typeof snapshot.deadlineMiss, 'boolean');
  assert.ok(Number.isFinite(snapshot.roadTotalMs));
  assert.ok(snapshot.roadTotalMs >= 0);
  assert.equal(typeof snapshot.cache.hits, 'number');
  assert.equal(typeof snapshot.cache.misses, 'number');
  assert.ok(Array.isArray(snapshot.settlementTypes));

  let partitionedTotalMs = 0;
  for (const span of ROAD_GENERATION_SPAN_ORDER) {
    const timing = snapshot.spans[span];
    assert.ok(timing, `missing Road timing span: ${span}`);
    assert.ok(Number.isFinite(timing.durationMs), `${span} has invalid duration`);
    assert.ok(Number.isSafeInteger(timing.callCount), `${span} has invalid call count`);
    assert.ok(timing.durationMs >= 0);
    assert.ok(timing.callCount >= 0);
    partitionedTotalMs += timing.durationMs;
  }
  assert.ok(Math.abs(partitionedTotalMs - snapshot.roadTotalMs) < 0.000001);

  for (const counter of ROAD_GENERATION_COUNTER_ORDER) {
    assert.ok(Number.isSafeInteger(snapshot.counters[counter]), `missing counter: ${counter}`);
    assert.ok(snapshot.counters[counter] >= 0);
  }
  assert.ok(Object.keys(snapshot.functionTimings).length > 0);
  for (const timing of Object.values(snapshot.functionTimings)) {
    assert.ok(Number.isFinite(timing.totalMs));
    assert.ok(Number.isFinite(timing.p50Ms));
    assert.ok(Number.isFinite(timing.p95Ms));
    assert.ok(Number.isFinite(timing.maxMs));
    assert.ok(Number.isSafeInteger(timing.callCount));
  }
}

function createPipelineCollector() {
  const events = [];
  const waiters = new Set();
  const onPipelineEvent = (type, details) => {
    const event = Object.freeze({ type, ...details });
    events.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
    }
  };
  const waitFor = (predicate, timeoutMs = 30_000) => {
    const recorded = events.find(predicate);
    if (recorded) return Promise.resolve(recorded);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('timed out waiting for Worker Road diagnostic event'));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  };
  return Object.freeze({ events, onPipelineEvent, waitFor });
}

async function generateWorkerChunk({
  transport,
  collector = null,
  requestId,
  owner = ROAD_HEAVY_OWNER,
}) {
  const chunk = await transport.generateChunk({
    requestId,
    chunkX: owner.x,
    chunkZ: owner.z,
  });
  const stageEvent = collector ? await collector.waitFor(event => (
    event.type === 'worker-chunk-stages' && event.requestId === requestId
  )) : null;
  return Object.freeze({ chunk, stageEvent });
}

test('reported owner has isolated, repeated, adjacent-order, and comparison-owner Worker reproduction coverage', {
  timeout: 90_000,
}, async () => {
  const isolatedCollector = createPipelineCollector();
  const isolatedTransport = createWorkerChunkGeneratorTransport({
    worldSeed: WORLD_SEED,
    serviceGeneration: 160,
    workerFactory: createNodeChunkGeneratorWorker,
    onPipelineEvent: isolatedCollector.onPipelineEvent,
  });
  const orderedCollector = createPipelineCollector();
  const orderedTransport = createWorkerChunkGeneratorTransport({
    worldSeed: WORLD_SEED,
    serviceGeneration: 161,
    workerFactory: createNodeChunkGeneratorWorker,
    onPipelineEvent: orderedCollector.onPipelineEvent,
  });
  try {
    await Promise.all([isolatedTransport.initialize(), orderedTransport.initialize()]);

    const isolated = await generateWorkerChunk({
      transport: isolatedTransport,
      collector: isolatedCollector,
      requestId: 16001,
      owner: REPORTED_OWNER,
    });
    assert.equal(isolated.chunk.contentHash, REPORTED_OWNER_CONTENT_HASH);
    assertRoadTimingSnapshot(isolated.stageEvent.roadTiming, REPORTED_OWNER);
    assert.equal(isolated.stageEvent.roadTimingSummary.runCount, 1);

    const repeated = [];
    for (const requestId of [16002, 16003, 16004]) {
      repeated.push(await generateWorkerChunk({
        transport: isolatedTransport,
        collector: isolatedCollector,
        requestId,
        owner: REPORTED_OWNER,
      }));
    }
    for (const result of repeated) {
      assert.equal(result.chunk.contentHash, REPORTED_OWNER_CONTENT_HASH);
      assert.equal(result.stageEvent.roadTiming, null,
        'canonical owner cache must avoid rebuilding Road work on a warm repeat');
      assert.equal(result.stageEvent.roadTimingSummary.runCount, 1);
    }

    await generateWorkerChunk({
      transport: orderedTransport,
      collector: orderedCollector,
      requestId: 16101,
      owner: REPORTED_OWNER_PREDECESSOR,
    });
    const ordered = await generateWorkerChunk({
      transport: orderedTransport,
      collector: orderedCollector,
      requestId: 16102,
      owner: REPORTED_OWNER,
    });
    const comparison = await generateWorkerChunk({
      transport: isolatedTransport,
      collector: isolatedCollector,
      requestId: 16005,
      owner: REPORTED_OWNER_COMPARISON,
    });
    assert.equal(ordered.chunk.contentHash, REPORTED_OWNER_CONTENT_HASH);
    assert.notEqual(comparison.chunk.chunkId, isolated.chunk.chunkId);
    assert.ok(comparison.stageEvent.roadTimingSummary.runCount >= 2);
  } finally {
    await Promise.all([isolatedTransport.shutdown(), orderedTransport.shutdown()]);
  }
});

test('W8 cached building type selection is exactly parity-safe for 512 non-monotonic lookups', () => {
  const lookupOrder = nonMonotonicIndices(BUILDING_SELECTOR_INDEX_COUNT);
  assert.notDeepEqual(lookupOrder, Array.from({ length: BUILDING_SELECTOR_INDEX_COUNT },
    (_, index) => index + 1));

  for (const settlementType of ['CITY', 'TOWN', 'RURAL']) {
    const townId = `road-tail-latency-${settlementType.toLowerCase()}`;
    const cached = createW8SettlementBuildingTypeSelector({ settlementType, townId });
    const protectedTypes = new Map(lookupOrder.map(buildingIndex => [
      buildingIndex,
      selectSettlementBuildingType({ settlementType, townId, buildingIndex }),
    ]));
    for (const buildingIndex of lookupOrder) {
      assert.equal(
        cached(buildingIndex),
        protectedTypes.get(buildingIndex),
        `${settlementType} cached index ${buildingIndex} drifted from protected selection`,
      );
    }
    for (const buildingIndex of [...lookupOrder].reverse()) {
      assert.equal(
        cached(buildingIndex),
        protectedTypes.get(buildingIndex),
        `${settlementType} repeated cached index ${buildingIndex} drifted`,
      );
    }
  }
});

test('W8 Road diagnostics preserve the road-heavy canonical output with diagnostics on and off', {
  timeout: 60_000,
}, async () => {
  const [diagnosticGenerator, baselineGenerator] = await Promise.all([
    createW8ParityChunkGenerator({ worldSeed: WORLD_SEED }),
    createW8ParityChunkGenerator({ worldSeed: WORLD_SEED }),
  ]);
  try {
    const timingContext = roadTimingContext();
    const diagnosticChunk = await diagnosticGenerator.generateChunk(
      ROAD_HEAVY_OWNER.x,
      ROAD_HEAVY_OWNER.z,
      { roadTimingContext: timingContext },
    );
    const baselineChunk = await baselineGenerator.generateChunk(
      ROAD_HEAVY_OWNER.x,
      ROAD_HEAVY_OWNER.z,
    );

    assert.equal(diagnosticChunk.contentHash, ROAD_HEAVY_OWNER_CONTENT_HASH);
    assert.equal(baselineChunk.contentHash, ROAD_HEAVY_OWNER_CONTENT_HASH);
    assert.equal(diagnosticChunk.contentHash, baselineChunk.contentHash);
    assert.equal(diagnosticChunk.chunkId, baselineChunk.chunkId);
    assert.equal(await hashW8ParityChunkContent(diagnosticChunk), diagnosticChunk.contentHash);
    assert.equal(await hashW8ParityChunkContent(baselineChunk), baselineChunk.contentHash);

    const diagnosticRoads = canonicalMajorRoadFeatures(diagnosticChunk);
    const baselineRoads = canonicalMajorRoadFeatures(baselineChunk);
    assert.ok(diagnosticRoads.length > 0, 'the Road-heavy fixture must include projected Roads');
    assert.deepEqual(
      diagnosticRoads.map(feature => feature.stableId),
      baselineRoads.map(feature => feature.stableId),
    );
    // Full feature equality includes route geometry, portals, frontage handoff,
    // owner metadata, and each canonical Road stable ID.
    assert.deepEqual(diagnosticRoads, baselineRoads);
    assert.deepEqual(diagnosticChunk.riverRoadCrossings, baselineChunk.riverRoadCrossings);

    assertRoadTimingSnapshot(timingContext.completedRun);
    const timingSummary = timingContext.recorder.snapshot();
    assert.equal(timingSummary.runCount, 1);
    assert.equal(timingSummary.topRuns.length, 1);
    assert.deepEqual(timingSummary.topRuns[0], timingContext.completedRun);
  } finally {
    await Promise.all([diagnosticGenerator.shutdown(), baselineGenerator.shutdown()]);
  }
});

test('Worker core creates Road timing only for an explicit diagnostics request', async () => {
  const responses = [];
  const generationOptions = [];
  const generator = {
    worldSeed: WORLD_SEED,
    worldSeedHash: `sha256:${'a'.repeat(64)}`,
    generatorVersion: { major: 800, minor: 0, patch: 0 },
    experienceSpawn: { x: 0, z: 0 },
    reviewSpawn: { x: 0, z: 0 },
    distributor: { findSettlementsNear: async () => [] },
    async generateChunk(chunkX, chunkZ, options) {
      generationOptions.push(options);
      return {
        chunkId: `chunk:${chunkX}:${chunkZ}`,
        contentHash: `sha256:${'b'.repeat(64)}`,
      };
    },
  };
  const core = createChunkGeneratorWorkerCore({
    postMessage: message => responses.push(message),
    generatorFactory: async () => generator,
  });
  const request = ({ requestId, pipelineDiagnostics = false }) => ({
    type: CHUNK_GENERATOR_MESSAGE.GENERATE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 77,
    requestId,
    chunkX: 4,
    chunkZ: -3,
    ...(pipelineDiagnostics ? { pipelineDiagnostics: true } : {}),
  });

  try {
    await core.receive({
      type: CHUNK_GENERATOR_MESSAGE.INITIALIZE,
      protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
      serviceGeneration: 77,
      worldSeed: WORLD_SEED,
    });
    responses.length = 0;
    await core.receive(request({ requestId: 7701 }));
    assert.equal(Object.hasOwn(generationOptions[0], 'roadTimingContext'), false);
    assert.deepEqual(responses.map(message => message.type), [
      CHUNK_GENERATOR_MESSAGE.GENERATED,
    ]);

    responses.length = 0;
    await core.receive(request({ requestId: 7702, pipelineDiagnostics: true }));
    assert.ok(generationOptions[1].roadTimingContext);
    assert.equal(generationOptions[1].roadTimingContext.recorder.snapshot().runCount, 0);
    assert.deepEqual(responses.map(message => message.type), [
      CHUNK_GENERATOR_MESSAGE.GENERATED,
      CHUNK_GENERATOR_MESSAGE.PIPELINE_TIMING,
    ]);
    assert.equal(responses[1].roadTiming, null);
    assert.equal(responses[1].roadTimingSummary.runCount, 0);
  } finally {
    await core.shutdown();
  }
});

test('Node Worker transport forwards Road diagnostics only when pipeline diagnostics are enabled', {
  timeout: 90_000,
}, async () => {
  const collector = createPipelineCollector();
  const diagnosticTransport = createWorkerChunkGeneratorTransport({
    worldSeed: WORLD_SEED,
    serviceGeneration: 55,
    workerFactory: createNodeChunkGeneratorWorker,
    onPipelineEvent: collector.onPipelineEvent,
  });
  const quietTransport = createWorkerChunkGeneratorTransport({
    worldSeed: WORLD_SEED,
    serviceGeneration: 56,
    workerFactory: createNodeChunkGeneratorWorker,
  });

  try {
    await Promise.all([diagnosticTransport.initialize(), quietTransport.initialize()]);
    const diagnostic = await generateWorkerChunk({
      transport: diagnosticTransport,
      collector,
      requestId: 5501,
    });
    const quiet = await generateWorkerChunk({
      transport: quietTransport,
      requestId: 5601,
    });

    assert.equal(diagnostic.chunk.contentHash, ROAD_HEAVY_OWNER_CONTENT_HASH);
    assert.equal(quiet.chunk.contentHash, ROAD_HEAVY_OWNER_CONTENT_HASH);
    assert.equal(diagnostic.chunk.chunkId, quiet.chunk.chunkId);
    assert.deepEqual(canonicalMajorRoadFeatures(diagnostic.chunk), canonicalMajorRoadFeatures(quiet.chunk));
    assert.deepEqual(diagnostic.chunk.riverRoadCrossings, quiet.chunk.riverRoadCrossings);

    assertRoadTimingSnapshot(diagnostic.stageEvent.roadTiming);
    assert.ok(diagnostic.stageEvent.roadTimingSummary);
    assert.equal(diagnostic.stageEvent.roadTimingSummary.runCount, 1);
    assert.equal(diagnostic.stageEvent.roadTimingSummary.topRuns.length, 1);
    assert.deepEqual(
      diagnostic.stageEvent.roadTimingSummary.topRuns[0],
      diagnostic.stageEvent.roadTiming,
    );

    const diagnosticSnapshot = diagnosticTransport.snapshot();
    const quietSnapshot = quietTransport.snapshot();
    assert.equal(diagnosticSnapshot.counts.pipelineTimingMessages, 1);
    assert.equal(quietSnapshot.counts.pipelineTimingMessages, 0);
    assert.equal(quietSnapshot.counts.pipelineTimingOrphans, 0);
    assert.equal(collector.events.some(event => (
      event.type === 'worker-chunk-stages' && event.requestId === 5601
    )), false, 'diagnostics-off requests must not emit a Road timing trailer');
  } finally {
    await Promise.all([diagnosticTransport.shutdown(), quietTransport.shutdown()]);
  }
});
