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
