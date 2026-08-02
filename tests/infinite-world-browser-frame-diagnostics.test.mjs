import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserFrameDiagnostics } from '../src/infinite-world/browser-frame-diagnostics.js';
import {
  createW8RuntimeDiagnostics,
  parseW8DiagnosticProfile,
} from '../src/infinite-world/runtime-diagnostics.js';

function createClock() {
  let now = 0;
  return Object.freeze({
    read: () => now,
    advance: value => { now += value; return now; },
  });
}

test('Browser frame attribution is allocation-free and clock-free while disabled', () => {
  let clockCalls = 0;
  const diagnostics = createBrowserFrameDiagnostics({
    enabled: false,
    clock: () => { clockCalls += 1; return 0; },
  });
  diagnostics.startFrame(0);
  diagnostics.recordStage('render', 12);
  diagnostics.recordWork('persistent-natural-frame', { matrixUpdates: 20 });
  diagnostics.recordTerrainGate({ blocked: true, ownerKey: '1,2' });
  diagnostics.sealFrame({ rendererInfo: { render: { calls: 3 } } });
  diagnostics.finishFrame(50, 50);
  const snapshot = diagnostics.snapshot();
  assert.equal(clockCalls, 0);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.frames.length, 0);
});

test('Browser frame attribution retains exactly 300 frames and separates rAF from callback CPU', () => {
  const clock = createClock();
  const performance = {
    now: clock.read,
    memory: { usedJSHeapSize: 10_000_000 },
  };
  const diagnostics = createBrowserFrameDiagnostics({
    enabled: true,
    clock: clock.read,
    globalObject: {
      performance,
      navigator: { userAgent: 'Microsoft Edge Browser' },
      document: { visibilityState: 'visible' },
    },
    environment: { userAgent: 'Microsoft Edge Browser', settlementStreamingMode: 'shared' },
  });
  for (let sequence = 1; sequence <= 305; sequence += 1) {
    diagnostics.startFrame(clock.read());
    clock.advance(2);
    diagnostics.recordStage('player-update', 2);
    diagnostics.recordWork('persistent-natural-frame', {
      matrixUpdates: sequence,
      bufferUploadBytes: 1_024,
    });
    performance.memory.usedJSHeapSize += 256;
    diagnostics.sealFrame({
      rendererInfo: {
        render: { calls: 7, triangles: 900 },
        memory: { geometries: 11, textures: 4 },
      },
    });
    diagnostics.finishFrame(16, clock.read());
  }
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.measurementSource, 'browser');
  assert.equal(snapshot.frames.length, 300);
  assert.equal(snapshot.frames[0].sequence, 6);
  assert.equal(snapshot.frames.at(-1).frameTotalMs, 16);
  assert.equal(snapshot.frames.at(-1).callbackDurationMs, 2);
  assert.equal(snapshot.frames.at(-1).renderer.drawCalls, 7);
  assert.equal(snapshot.frames.at(-1).renderer.triangles, 900);
  assert.equal(snapshot.frames.at(-1).renderer.geometries, 11);
  assert.equal(snapshot.frames.at(-1).renderer.textures, 4);
  assert.equal(snapshot.frames.at(-1).work['persistent-natural-frame'].matrixUpdates, 305);
  assert.equal(snapshot.frames.at(-1).classification.matrixUpdates, 305);
  assert.equal(snapshot.frames.at(-1).classification.uploadBytes, 1_024);
});

test('33/50/100ms hitches retain five frames before and after with stage attribution', () => {
  const clock = createClock();
  const diagnostics = createBrowserFrameDiagnostics({
    enabled: true,
    clock: clock.read,
    globalObject: {
      performance: { now: clock.read },
      document: { visibilityState: 'visible' },
    },
    environment: { userAgent: 'Edg/140' },
  });
  for (let sequence = 1; sequence <= 16; sequence += 1) {
    diagnostics.startFrame(clock.read());
    const callbackMs = sequence === 7 ? 8 : 2;
    clock.advance(callbackMs);
    diagnostics.recordStage(sequence === 7 ? 'render' : 'player-update', callbackMs);
    diagnostics.sealFrame();
    diagnostics.finishFrame(sequence === 7 ? 110 : 16, clock.read());
  }
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.over33Ratio, 1 / 16);
  assert.equal(snapshot.over50Ratio, 1 / 16);
  assert.equal(snapshot.over100Ratio, 1 / 16);
  assert.equal(snapshot.hitchWindows.length, 1);
  assert.equal(snapshot.hitchWindows[0].thresholdMs, 100);
  assert.deepEqual(snapshot.hitchWindows[0].before.map(frame => frame.sequence), [2, 3, 4, 5, 6]);
  assert.equal(snapshot.hitchWindows[0].hitch.sequence, 7);
  assert.deepEqual(snapshot.hitchWindows[0].after.map(frame => frame.sequence), [8, 9, 10, 11, 12]);
  assert.equal(snapshot.heaviestFrames[0].stages.render, 8);
  assert.equal(snapshot.heaviestFrames[0].gpuOrCompositorWaitSuspected, true);
});

test('Terrain ready gate and transition lifecycle share the browser frame timeline', () => {
  const clock = createClock();
  const diagnostics = createW8RuntimeDiagnostics({
    enabled: true,
    clock: clock.read,
    globalObject: { performance: { now: clock.read } },
    profile: parseW8DiagnosticProfile('baseline'),
    environment: { userAgent: 'Edg/140', settlementStreamingMode: 'legacy' },
  });
  diagnostics.startFrame(clock.read());
  diagnostics.recordTerrainGate({ blocked: true, ownerKey: '4,5' });
  diagnostics.recordEvent('chunk-transition-started', { ownerKey: '4,5' });
  diagnostics.recordEvent('terrain-replacement-requested', { coverageEpoch: 9 });
  clock.advance(20);
  diagnostics.sealFrame();
  diagnostics.finishFrame(20, clock.read());
  diagnostics.startFrame(clock.read());
  diagnostics.recordTerrainGate({ blocked: true, ownerKey: '4,5' });
  diagnostics.recordEvent('terrain-replacement-ready', { coverageEpoch: 9 });
  diagnostics.recordEvent('terrain-replacement-attached', { coverageEpoch: 9 });
  diagnostics.recordEvent('terrain-old-released', { coverageEpoch: 9 });
  clock.advance(18);
  diagnostics.recordTerrainGate({ blocked: false, ownerKey: '4,5' });
  diagnostics.recordEvent('chunk-transition-publication-complete', { workEpoch: 3 });
  diagnostics.sealFrame();
  diagnostics.finishFrame(18, clock.read());

  const report = diagnostics.snapshot();
  const browser = report.browserFrameAttribution;
  assert.equal(browser.measurementSource, 'browser');
  assert.equal(browser.terrainReadyGate.blockedFrameCount, 2);
  assert.equal(browser.terrainReadyGate.blockedDurationMs, 38);
  assert.equal(browser.terrainReadyGate.longestBlockedDurationMs, 38);
  assert.deepEqual(browser.timeline.map(event => event.type), [
    'terrain-ready-gate-started',
    'chunk-transition-started',
    'terrain-replacement-requested',
    'terrain-replacement-ready',
    'terrain-replacement-attached',
    'terrain-old-released',
    'terrain-ready-gate-ended',
    'chunk-transition-publication-complete',
  ]);
  assert.equal(browser.terrainTransitions[0].coverageEpoch, 9);
  assert.equal(browser.terrainTransitions[0].readyToAttachMs, 0);
});

test('Async wait is separated from synchronous Browser callback stage attribution', async () => {
  const clock = createClock();
  const diagnostics = createW8RuntimeDiagnostics({
    enabled: true,
    clock: clock.read,
    globalObject: { performance: { now: clock.read } },
    environment: { userAgent: 'Node.js/22 FakeThree' },
  });
  diagnostics.startFrame(clock.read());
  diagnostics.measure('world-streaming-plan', () => clock.advance(3));
  await diagnostics.measureAsync('chunk-prefetch', async () => clock.advance(40));
  diagnostics.sealFrame();
  diagnostics.finishFrame(50, clock.read());
  const frame = diagnostics.snapshot().browserFrameAttribution.frames[0];
  assert.equal(frame.stages['world-streaming-plan'], 3);
  assert.equal(frame.asyncStages['chunk-prefetch'], 40);
  assert.equal(frame.stages['chunk-prefetch'], undefined);
  assert.equal(diagnostics.snapshot().browserFrameAttribution.measurementSource, 'node-fakethree');
});

test('Worker scheduler request and response events retain queue, execution, and backlog context', () => {
  const clock = createClock();
  const diagnostics = createW8RuntimeDiagnostics({
    enabled: true,
    clock: clock.read,
    globalObject: { performance: { now: clock.read } },
    environment: { userAgent: 'Edg/140' },
  });
  diagnostics.startFrame(clock.read());
  diagnostics.recordEvent('worker-request-started', {
    correlationId: 'scheduler:8',
    requestId: 8,
    operationKind: 'canonical-owner',
    queueTimeMs: 12,
    startedAtMs: 100,
    backlog: 4,
  });
  diagnostics.recordEvent('worker-request-terminal', {
    correlationId: 'scheduler:8',
    requestId: 8,
    operationKind: 'canonical-owner',
    terminalAtMs: 142,
    executionWallClockMs: 42,
    terminalState: 'completed',
    backlog: 3,
  });
  diagnostics.sealFrame();
  diagnostics.finishFrame(16, clock.read());
  assert.deepEqual(diagnostics.snapshot().browserFrameAttribution.workerRequests, [{
    correlationId: 'scheduler:8',
    requestId: 8,
    operationKind: 'canonical-owner',
    target: undefined,
    queueTimeMs: 12,
    startedAtMs: 100,
    terminalAtMs: 142,
    executionWallClockMs: 42,
    terminalState: 'completed',
    backlog: 3,
    requestToResponseMs: 54,
  }]);
});

test('Chunk supply attribution correlates request, Worker, receive, ready, and delivery stages', () => {
  const clock = createClock();
  const diagnostics = createW8RuntimeDiagnostics({
    enabled: true,
    clock: clock.read,
    globalObject: { performance: { now: clock.read } },
    environment: { userAgent: 'Edg/140' },
  });
  diagnostics.startFrame(clock.read());
  diagnostics.recordEvent('chunk-request-queued', {
    requestId: 17, ownerKey: '8,-3', priority: 2, required: true, backlog: 3,
  });
  clock.advance(2);
  diagnostics.recordEvent('chunk-worker-dispatch', {
    requestId: 17, ownerKey: '8,-3', serviceQueueTimeMs: 2, backlog: 3,
  });
  clock.advance(1);
  diagnostics.recordEvent('worker-message-sent', {
    requestId: 17, ownerKey: '8,-3', sentAtMs: clock.read(),
  });
  clock.advance(5);
  diagnostics.recordEvent('worker-message-received', {
    requestId: 17,
    ownerKey: '8,-3',
    receivedAtMs: clock.read(),
    workerQueueTimeMs: 2,
    workerExecutionMs: 2,
    messageDeliveryMs: 1,
    residualWaitMs: 1,
  });
  diagnostics.recordEvent('worker-chunk-stages', {
    requestId: 17,
    ownerKey: '8,-3',
    priority: 2,
    required: true,
    generationStartedAtMs: 4,
    generationCompletedAtMs: 6,
    generationTotalMs: 2,
    responsePostStartedAtMs: 6,
    responsePostCompletedAtMs: 6.25,
    postMessageCallMs: 0.25,
    transferMs: 0.75,
    mainReceivedAtMs: 8,
    deadlineAtMs: 20,
    deadlineMissAtStart: false,
    deadlineMissAtMainReceive: false,
    stageTotalsMs: {
      terrain: 1.5,
      river: 0,
      road: 0,
      settlement: 0,
      natural: 0,
      canonical: 0,
      serialize: 0.5,
      hash: 0,
    },
    stageCallCounts: {
      terrain: 1,
      river: 0,
      road: 0,
      settlement: 0,
      natural: 0,
      canonical: 0,
      serialize: 1,
      hash: 0,
    },
    stageEvents: [{
      stage: 'terrain',
      startedAtMs: 4,
      completedAtMs: 5.5,
      durationMs: 1.5,
      status: 'completed',
    }, {
      stage: 'serialize',
      startedAtMs: 5.5,
      completedAtMs: 6,
      durationMs: 0.5,
      status: 'completed',
    }],
  });
  diagnostics.recordEvent('worker-response-resolved', {
    requestId: 17, ownerKey: '8,-3', mainHandlerMs: 0.25,
  });
  clock.advance(1);
  diagnostics.recordEvent('chunk-main-response-received', {
    requestId: 17, ownerKey: '8,-3',
  });
  clock.advance(1);
  diagnostics.recordEvent('chunk-owner-ready', {
    requestId: 17, ownerKey: '8,-3',
  });
  diagnostics.recordEvent('chunk-owner-delivered', {
    requestId: 17, ownerKey: '8,-3', consumerId: 'runtime-prepared:8,-3:2',
  });
  diagnostics.recordEvent('runtime-owner-request-complete', { ownerKey: '8,-3' });
  diagnostics.recordEvent('runtime-prefetch-owner-ready', {
    ownerKey: '8,-3', targetOwnerKey: '8,-2', renderRequired: true,
  });
  clock.advance(3);
  diagnostics.recordEvent('runtime-terrain-prepared', {
    ownerKey: '8,-3', targetOwnerKey: '8,-2',
  });
  diagnostics.sealFrame();
  diagnostics.finishFrame(16, clock.read());

  const supply = diagnostics.snapshot().browserFrameAttribution.chunkSupply;
  assert.equal(supply.completedRequestCount, 1);
  assert.equal(supply.requests[0].ownerKey, '8,-3');
  assert.equal(supply.requests[0].requestToReadyMs, 10);
  assert.equal(supply.requests[0].serviceQueueMs, 2);
  assert.equal(supply.requests[0].workerQueueTimeMs, 2);
  assert.equal(supply.requests[0].workerExecutionMs, 2);
  assert.equal(supply.requests[0].messageDeliveryMs, 1);
  assert.equal(supply.requests[0].mainReceiveToReadyMs, 2);
  assert.equal(supply.requests[0].unattributedMs, 1);
  assert.equal(supply.requests[0].requestToTerrainPreparedMs, 13);
  assert.equal(supply.requests[0].readyToTerrainPreparedMs, 3);
  assert.equal(supply.dominantStage, 'mainReceiveToReadyMs');
  assert.equal(supply.profiledChunkCount, 1);
  assert.equal(supply.generationStages.terrain.invocationCount, 1);
  assert.equal(supply.generationStages.terrain.p50, 1.5);
  assert.equal(supply.generationStages.serialize.max, 0.5);
  assert.equal(supply.generationStages.transfer.p95, 0.75);
  assert.equal(supply.top20SlowestGeneration[0].owner, '8,-3');
  assert.equal(supply.top20SlowestGeneration[0].percentages.terrain, 75);
  assert.equal(supply.dominantGenerationStage, 'terrain');
  assert.equal(supply.dominantGenerationStagePercent, 75);
  assert.equal(supply.dominantGenerationStageAtLeast70Percent, true);
  assert.equal(supply.requests[0].timeline[0].stage, 'queue');
  assert.equal(supply.requests[0].timeline.at(-1).stage, 'ready');
  assert.equal(supply.requests[0].timeline.filter(event => event.stage === 'terrain').length, 2);
  assert.equal(supply.requests[0].timeline.some(event => event.stage === 'main-receive'), true);
});

test('Chunk generation diagnostics retain the twenty slowest owners deterministically', () => {
  const clock = createClock();
  const diagnostics = createW8RuntimeDiagnostics({
    enabled: true,
    clock: clock.read,
    globalObject: { performance: { now: clock.read } },
    environment: { userAgent: 'Edg/140' },
  });
  diagnostics.startFrame(clock.read());
  for (let requestId = 1; requestId <= 25; requestId += 1) {
    diagnostics.recordEvent('worker-chunk-stages', {
      requestId,
      ownerKey: `${requestId},0`,
      priority: 3,
      required: requestId % 2 === 0,
      generationTotalMs: requestId,
      stageTotalsMs: { terrain: requestId * 0.6, natural: requestId * 0.4 },
      stageCallCounts: { terrain: 1, natural: 1 },
      stageEvents: [],
      deadlineMissAtStart: requestId === 25,
    });
  }
  diagnostics.sealFrame();
  diagnostics.finishFrame(16, clock.read());
  const supply = diagnostics.snapshot().browserFrameAttribution.chunkSupply;
  assert.equal(supply.profiledChunkCount, 25);
  assert.equal(supply.top20SlowestGeneration.length, 20);
  assert.equal(supply.top20SlowestGeneration[0].requestId, 25);
  assert.equal(supply.top20SlowestGeneration.at(-1).requestId, 6);
  assert.equal(supply.deadlineMissCount, 1);
  assert.equal(supply.generationStages.terrain.invocationCount, 25);
  assert.equal(supply.dominantGenerationStage, 'terrain');
  assert.equal(supply.dominantGenerationStagePercent, 60);
  assert.equal(supply.dominantGenerationStageAtLeast70Percent, false);
});

test('Coverage misses and Terrain/Distant publication share transition generations', () => {
  const clock = createClock();
  const diagnostics = createW8RuntimeDiagnostics({
    enabled: true,
    clock: clock.read,
    globalObject: { performance: { now: clock.read } },
    environment: { userAgent: 'Edg/140' },
  });
  diagnostics.startFrame(clock.read());
  diagnostics.recordEvent('player-prepared-coverage-miss', {
    ownerKey: '9,0',
    transitionGeneration: 4,
    activeDataKeys: ['6,0', '7,0', '8,0'],
    renderedKeys: ['7,0', '8,0'],
    visibleRoots: [{ role: 'local-terrain', transitionGeneration: 4 }],
  });
  diagnostics.recordEvent('chunk-transition-runtime-ready', { transitionGeneration: 5 });
  diagnostics.recordEvent('terrain-post-commit-started', { transitionGeneration: 5 });
  clock.advance(20);
  diagnostics.recordEvent('terrain-replacement-attached', {
    transitionGeneration: 5, coverageEpoch: 12, rootId: 'terrain-12', rootAttached: true,
  });
  diagnostics.recordEvent('terrain-coverage-verified', {
    transitionGeneration: 5, coverageEpoch: 12, rootId: 'terrain-12', rootAttached: true,
  });
  clock.advance(10);
  diagnostics.recordEvent('distant-publication-complete', {
    transitionGeneration: 5,
    coverageSignature: 'coverage:5',
    buildingPublicationSource: 'shared',
    settlementRoadPublicationSource: 'shared',
    settlementPublicationRevision: 7,
  });
  diagnostics.recordEvent('player-prepared-coverage-restored', { ownerKey: '9,0' });
  diagnostics.sealFrame();
  diagnostics.finishFrame(40, clock.read());

  const browser = diagnostics.snapshot().browserFrameAttribution;
  assert.equal(browser.coverageMisses.length, 1);
  assert.equal(browser.coverageMisses[0].durationMs, 30);
  assert.equal(browser.publicationTransitions.length, 1);
  assert.equal(browser.publicationTransitions[0].transitionGeneration, 5);
  assert.deepEqual(browser.publicationTransitions[0].events.map(event => event.type), [
    'chunk-transition-runtime-ready',
    'terrain-post-commit-started',
    'terrain-replacement-attached',
    'terrain-coverage-verified',
    'distant-publication-complete',
  ]);
});
