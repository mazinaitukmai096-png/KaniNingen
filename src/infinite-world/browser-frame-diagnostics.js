const DEFAULT_FRAME_LIMIT = 300;
const DEFAULT_HITCH_LIMIT = 64;
const DEFAULT_EVENT_LIMIT = 2_048;
const DEFAULT_CONTEXT_RADIUS = 5;
const HITCH_THRESHOLDS_MS = Object.freeze([33, 50, 100]);

const EMPTY_SNAPSHOT = Object.freeze({
  schemaVersion: 'w8-browser-frame-attribution-1',
  enabled: false,
  measurementSource: 'disabled',
  frameWindowCapacity: DEFAULT_FRAME_LIMIT,
  frame: Object.freeze({ count: 0, p50: 0, p95: 0, max: 0 }),
  callback: Object.freeze({ count: 0, p50: 0, p95: 0, max: 0 }),
  over33Ratio: 0,
  over50Ratio: 0,
  over100Ratio: 0,
  frames: Object.freeze([]),
  heaviestFrames: Object.freeze([]),
  hitchWindows: Object.freeze([]),
  timeline: Object.freeze([]),
  terrainReadyGate: Object.freeze({
    blockedFrameCount: 0,
    blockedDurationMs: 0,
    longestBlockedDurationMs: 0,
    active: false,
  }),
  notes: Object.freeze({
    frameTotal: 'requestAnimationFrame callback interval',
    callback: 'JavaScript callback wall-clock duration',
    stages: 'Synchronous stage wall-clock; nested stages may overlap parent stages',
    asyncStages: 'Await wall-clock and not synchronous CPU attribution',
    gpuOrCompositorWait: 'Inference only; requires a browser Performance trace for confirmation',
  }),
});

const noop = () => null;
const DISABLED_COLLECTOR = Object.freeze({
  enabled: false,
  startFrame: noop,
  recordStage: noop,
  recordWork: noop,
  recordEvent: noop,
  recordTerrainGate: noop,
  sealFrame: noop,
  finishFrame: noop,
  reset: noop,
  snapshot: () => EMPTY_SNAPSHOT,
});

function percentile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.min(
    ordered.length - 1,
    Math.ceil(ordered.length * fraction) - 1,
  ))];
}

function summarize(values) {
  return Object.freeze({
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : 0,
  });
}

function pushBounded(target, value, limit) {
  target.push(value);
  if (target.length > limit) target.splice(0, target.length - limit);
}

function freezeMetrics(metrics) {
  return Object.freeze(Object.fromEntries(Object.entries(metrics).map(([key, value]) => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? [key, Object.freeze({ ...value })]
      : [key, value]
  ))));
}

const sumStages = (stages, names) => names.reduce(
  (sum, name) => sum + (stages[name] ?? 0),
  0,
);

function sumWorkMetrics(work, matcher) {
  let total = 0;
  for (const metrics of Object.values(work)) {
    for (const [name, value] of Object.entries(metrics)) {
      if (matcher.test(name) && Number.isFinite(value)) total += value;
    }
  }
  return total;
}

function classifyFrame(frame) {
  const stages = frame.stages;
  const asyncStages = frame.asyncStages;
  const javascriptUpdateMs = sumStages(stages, [
    'scene-presentation',
    'player-update',
    'gameplay-update',
    'distant-update',
    'render-distance-publication',
    'presentation-effects',
  ]);
  const rendererRenderMs = stages.render ?? 0;
  const diagnosticsHudMs = stages.hud ?? 0;
  const topLevelCallbackMs = javascriptUpdateMs + rendererRenderMs + diagnosticsHudMs;
  const synchronousStageEntries = Object.entries(stages)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return Object.freeze({
    javascriptUpdateMs,
    worldNaturalPlanningMs: sumStages(stages, [
      'world-streaming-plan',
      'natural-policy-plan',
      'static-natural-apply-plan',
      'static-natural-ready-admission',
    ]),
    buildingSettlementMs: sumStages(stages, [
      'settlement-shadow-observation',
      'settlement-shadow-compare',
      'settlement-staging-signature',
    ]),
    rendererRenderMs,
    diagnosticsHudMs,
    topLevelCallbackMs,
    callbackUnattributedMs: Math.max(0, frame.callbackDurationMs - topLevelCallbackMs),
    diagnosticsSnapshotMs: sumStages(stages, [
      'distant-diagnostics-snapshot',
      'diagnostics-snapshot',
    ]),
    terrainAsyncWallClockMs: sumStages(asyncStages, [
      'chunk-transition',
      'chunk-prefetch',
      'distant-local-terrain-sync',
      'distant-sync',
    ]),
    workerAsyncWallClockMs: sumWorkMetrics(frame.work, /worker.*(?:wait|duration)Ms/i),
    canonicalVisibilityMs: sumWorkMetrics(frame.work, /(?:visibilityMs|maximumSynchronousSliceMs)$/),
    matrixUpdates: sumWorkMetrics(frame.work, /matrix(?:Updates|UpdateCount)$/i),
    bufferUpdates: sumWorkMetrics(frame.work, /buffer(?:Updates|UpdateCount)$/i),
    uploadBytes: sumWorkMetrics(frame.work, /(?:uploadBytes|bufferUploadBytes)$/),
    disposeCount: sumWorkMetrics(frame.work, /(?:disposedOwners|disposedResources)$/),
    terrainReadyGateBlocked: frame.terrainReadyGate?.blocked === true,
    gpuOrCompositorWaitSuspected: frame.gpuOrCompositorWaitSuspected,
    gpuOrCompositorWaitMs: frame.gpuOrCompositorWaitMs,
    dominantSynchronousStage: synchronousStageEntries[0]?.[0] ?? null,
    dominantSynchronousStageMs: synchronousStageEntries[0]?.[1] ?? 0,
  });
}

function cloneFrame(frame) {
  return Object.freeze({
    ...frame,
    stages: Object.freeze({ ...frame.stages }),
    stageCalls: Object.freeze({ ...frame.stageCalls }),
    asyncStages: Object.freeze({ ...frame.asyncStages }),
    work: freezeMetrics(frame.work),
    renderer: frame.renderer ? Object.freeze({ ...frame.renderer }) : null,
    memory: Object.freeze({ ...frame.memory }),
    terrainReadyGate: frame.terrainReadyGate
      ? Object.freeze({ ...frame.terrainReadyGate }) : null,
    classification: classifyFrame(frame),
  });
}

function readHeapBytes(performanceObject) {
  const value = performanceObject?.memory?.usedJSHeapSize;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function classifyMeasurementSource(environment) {
  const userAgent = String(environment?.userAgent ?? 'unknown');
  return /node\.js|jsdom|happy-dom|fakethree/i.test(userAgent)
    ? 'node-fakethree'
    : userAgent === 'unknown' ? 'unknown' : 'browser';
}

function rendererSnapshot(rendererInfo) {
  if (!rendererInfo) return null;
  return Object.freeze({
    drawCalls: rendererInfo.render?.calls ?? rendererInfo.drawCalls ?? null,
    triangles: rendererInfo.render?.triangles ?? rendererInfo.triangles ?? null,
    geometries: rendererInfo.memory?.geometries ?? rendererInfo.geometries ?? null,
    textures: rendererInfo.memory?.textures ?? rendererInfo.textures ?? null,
  });
}

function highestThreshold(durationMs) {
  let result = null;
  for (const threshold of HITCH_THRESHOLDS_MS) {
    if (durationMs > threshold) result = threshold;
  }
  return result;
}

function terrainTransitionTimeline(events) {
  const byEpoch = new Map();
  const interesting = new Set([
    'terrain-replacement-requested',
    'terrain-replacement-ready',
    'terrain-replacement-attached',
    'terrain-old-released',
  ]);
  for (const event of events) {
    if (!interesting.has(event.type) || !Number.isSafeInteger(event.coverageEpoch)) continue;
    const record = byEpoch.get(event.coverageEpoch) ?? {
      coverageEpoch: event.coverageEpoch,
      transitionGeneration: event.transitionGeneration ?? null,
      requestedAtMs: null,
      readyAtMs: null,
      attachedAtMs: null,
      oldReleasedAtMs: null,
    };
    if (event.type === 'terrain-replacement-requested') record.requestedAtMs = event.timestampMs;
    else if (event.type === 'terrain-replacement-ready') record.readyAtMs = event.timestampMs;
    else if (event.type === 'terrain-replacement-attached') record.attachedAtMs = event.timestampMs;
    else record.oldReleasedAtMs = event.timestampMs;
    byEpoch.set(event.coverageEpoch, record);
  }
  return Object.freeze([...byEpoch.values()].slice(-32).map(record => Object.freeze({
    ...record,
    requestToReadyMs: record.requestedAtMs !== null && record.readyAtMs !== null
      ? record.readyAtMs - record.requestedAtMs : null,
    readyToAttachMs: record.readyAtMs !== null && record.attachedAtMs !== null
      ? record.attachedAtMs - record.readyAtMs : null,
    totalPublicationMs: record.requestedAtMs !== null && record.oldReleasedAtMs !== null
      ? record.oldReleasedAtMs - record.requestedAtMs : null,
  })));
}

function workerRequestTimeline(events) {
  const byCorrelation = new Map();
  for (const event of events) {
    if (!['worker-request-started', 'worker-request-terminal'].includes(event.type)
      || !event.correlationId) continue;
    const record = byCorrelation.get(event.correlationId) ?? {
      correlationId: event.correlationId,
      requestId: event.requestId,
      operationKind: event.operationKind,
      target: event.target,
      queueTimeMs: event.queueTimeMs ?? null,
      startedAtMs: null,
      terminalAtMs: null,
      executionWallClockMs: null,
      terminalState: null,
      backlog: null,
    };
    if (event.type === 'worker-request-started') record.startedAtMs = event.startedAtMs;
    else {
      record.terminalAtMs = event.terminalAtMs;
      record.executionWallClockMs = event.executionWallClockMs;
      record.terminalState = event.terminalState;
    }
    record.backlog = event.backlog;
    byCorrelation.set(event.correlationId, record);
  }
  return Object.freeze([...byCorrelation.values()].slice(-128).map(record => Object.freeze({
    ...record,
    requestToResponseMs: Number.isFinite(record.queueTimeMs)
      && Number.isFinite(record.executionWallClockMs)
      ? record.queueTimeMs + record.executionWallClockMs : null,
  })));
}

export function createBrowserFrameDiagnostics({
  enabled = false,
  globalObject = globalThis,
  clock = () => globalObject.performance?.now?.() ?? Date.now(),
  environment = {},
  frameLimit = DEFAULT_FRAME_LIMIT,
  hitchLimit = DEFAULT_HITCH_LIMIT,
  contextRadius = DEFAULT_CONTEXT_RADIUS,
} = {}) {
  if (!enabled) return DISABLED_COLLECTOR;
  if (!Number.isSafeInteger(frameLimit) || frameLimit < 11) {
    throw new RangeError('Browser frame diagnostics frameLimit must be at least 11');
  }
  if (!Number.isSafeInteger(hitchLimit) || hitchLimit < 1) {
    throw new RangeError('Browser frame diagnostics hitchLimit must be positive');
  }
  if (!Number.isSafeInteger(contextRadius) || contextRadius < 1) {
    throw new RangeError('Browser frame diagnostics contextRadius must be positive');
  }

  const performanceObject = globalObject.performance ?? null;
  const frames = [];
  const hitchWindows = [];
  const pendingHitchWindows = [];
  const timeline = [];
  const measurementSource = classifyMeasurementSource(environment);
  let currentFrame = null;
  let sequence = 0;
  let eventSequence = 0;
  let previousHeapBytes = null;
  let activeTerrainGate = null;
  let terrainBlockedFrameCount = 0;
  let terrainBlockedDurationMs = 0;
  let longestTerrainBlockedDurationMs = 0;

  const recordEvent = (type, details = {}) => {
    const event = Object.freeze({
      sequence: ++eventSequence,
      type,
      timestampMs: clock(),
      frameSequence: currentFrame?.sequence ?? sequence,
      ...details,
    });
    pushBounded(timeline, event, DEFAULT_EVENT_LIMIT);
    return event;
  };

  const closeTerrainGate = timestampMs => {
    if (!activeTerrainGate) return;
    const durationMs = Math.max(0, timestampMs - activeTerrainGate.startedAtMs);
    terrainBlockedDurationMs += durationMs;
    longestTerrainBlockedDurationMs = Math.max(longestTerrainBlockedDurationMs, durationMs);
    recordEvent('terrain-ready-gate-ended', {
      ownerKey: activeTerrainGate.ownerKey,
      startedFrameSequence: activeTerrainGate.startedFrameSequence,
      blockedFrameCount: activeTerrainGate.blockedFrameCount,
      durationMs,
    });
    activeTerrainGate = null;
  };

  const sealCurrentFrame = ({ rendererInfo = null } = {}) => {
    if (!currentFrame || currentFrame.callbackEndedAtMs !== null) return null;
    const endedAtMs = clock();
    const heapEndBytes = readHeapBytes(performanceObject);
    currentFrame.callbackEndedAtMs = endedAtMs;
    currentFrame.callbackDurationMs = Math.max(
      0,
      endedAtMs - currentFrame.callbackStartedAtMs,
    );
    currentFrame.renderer = rendererSnapshot(rendererInfo);
    currentFrame.memory.heapEndBytes = heapEndBytes;
    currentFrame.memory.callbackHeapDeltaBytes = heapEndBytes !== null
      && currentFrame.memory.heapStartBytes !== null
      ? heapEndBytes - currentFrame.memory.heapStartBytes : null;
    const largestPositiveDelta = Math.max(
      currentFrame.memory.callbackHeapDeltaBytes ?? 0,
      currentFrame.memory.heapDeltaFromPreviousFrameBytes ?? 0,
    );
    const largestNegativeDelta = Math.min(
      currentFrame.memory.callbackHeapDeltaBytes ?? 0,
      currentFrame.memory.heapDeltaFromPreviousFrameBytes ?? 0,
    );
    currentFrame.memory.allocationSpikeSuspected = largestPositiveDelta >= 2 * 1024 * 1024;
    currentFrame.memory.garbageCollectionSuspected = largestNegativeDelta <= -2 * 1024 * 1024;
    return currentFrame.sequence;
  };

  return Object.freeze({
    enabled: true,
    startFrame(rafTimestampMs = clock()) {
      const heapBytes = readHeapBytes(performanceObject);
      currentFrame = {
        sequence: ++sequence,
        rafTimestampMs,
        callbackStartedAtMs: clock(),
        callbackEndedAtMs: null,
        callbackDurationMs: 0,
        frameTotalMs: 0,
        stages: {},
        stageCalls: {},
        asyncStages: {},
        work: {},
        renderer: null,
        memory: {
          heapStartBytes: heapBytes,
          heapEndBytes: null,
          heapDeltaFromPreviousFrameBytes: heapBytes !== null && previousHeapBytes !== null
            ? heapBytes - previousHeapBytes : null,
          callbackHeapDeltaBytes: null,
          allocationSpikeSuspected: false,
          garbageCollectionSuspected: false,
        },
        terrainReadyGate: null,
        gpuOrCompositorWaitMs: 0,
        gpuOrCompositorWaitSuspected: false,
        visibilityState: globalObject.document?.visibilityState ?? null,
      };
      previousHeapBytes = heapBytes;
      return currentFrame.sequence;
    },
    recordStage(stage, durationMs, { async = false } = {}) {
      if (!currentFrame || !Number.isFinite(durationMs)) return null;
      const target = async ? currentFrame.asyncStages : currentFrame.stages;
      target[stage] = (target[stage] ?? 0) + Math.max(0, durationMs);
      if (!async) currentFrame.stageCalls[stage] = (currentFrame.stageCalls[stage] ?? 0) + 1;
      return currentFrame.sequence;
    },
    recordWork(route, values = {}) {
      if (!currentFrame) return null;
      const target = currentFrame.work[route] ??= {};
      for (const [metric, value] of Object.entries(values)) {
        if (Number.isFinite(value)) target[metric] = (target[metric] ?? 0) + value;
      }
      return currentFrame.sequence;
    },
    recordEvent,
    recordTerrainGate({ blocked, ownerKey = null } = {}) {
      if (!currentFrame) return null;
      if (blocked === true) {
        if (currentFrame.terrainReadyGate?.blocked !== true) terrainBlockedFrameCount += 1;
        if (!activeTerrainGate) {
          activeTerrainGate = {
            ownerKey,
            startedAtMs: clock(),
            startedFrameSequence: currentFrame.sequence,
            blockedFrameCount: 0,
          };
          recordEvent('terrain-ready-gate-started', { ownerKey });
        }
        if (activeTerrainGate.lastFrameSequence !== currentFrame.sequence) {
          activeTerrainGate.blockedFrameCount += 1;
          activeTerrainGate.lastFrameSequence = currentFrame.sequence;
        }
        currentFrame.terrainReadyGate = { blocked: true, ownerKey };
      } else {
        currentFrame.terrainReadyGate = { blocked: false, ownerKey };
        closeTerrainGate(clock());
      }
      return currentFrame.sequence;
    },
    sealFrame: sealCurrentFrame,
    finishFrame(frameTotalMs, frameNow = clock()) {
      if (!currentFrame) return null;
      if (currentFrame.callbackEndedAtMs === null) sealCurrentFrame();
      currentFrame.frameTotalMs = Math.max(0, frameTotalMs);
      const nominalFrameMs = 1000 / 60;
      const unoccupiedIntervalMs = Math.max(
        0,
        currentFrame.frameTotalMs - currentFrame.callbackDurationMs - nominalFrameMs,
      );
      currentFrame.gpuOrCompositorWaitSuspected = currentFrame.frameTotalMs > 33
        && currentFrame.callbackDurationMs < currentFrame.frameTotalMs * 0.5
        && currentFrame.visibilityState !== 'hidden';
      currentFrame.gpuOrCompositorWaitMs = currentFrame.gpuOrCompositorWaitSuspected
        ? unoccupiedIntervalMs : 0;
      currentFrame.finishedAtMs = frameNow;
      const record = cloneFrame(currentFrame);

      for (let index = pendingHitchWindows.length - 1; index >= 0; index -= 1) {
        const pending = pendingHitchWindows[index];
        pending.after.push(record);
        if (pending.after.length >= contextRadius) {
          pushBounded(hitchWindows, Object.freeze({
            thresholdMs: pending.thresholdMs,
            hitch: pending.hitch,
            before: Object.freeze(pending.before),
            after: Object.freeze(pending.after),
          }), hitchLimit);
          pendingHitchWindows.splice(index, 1);
        }
      }

      const thresholdMs = highestThreshold(record.frameTotalMs);
      if (thresholdMs !== null) {
        pendingHitchWindows.push({
          thresholdMs,
          hitch: record,
          before: frames.slice(-contextRadius),
          after: [],
        });
      }
      pushBounded(frames, record, frameLimit);
      currentFrame = null;
      return record;
    },
    reset() {
      frames.length = 0;
      hitchWindows.length = 0;
      pendingHitchWindows.length = 0;
      timeline.length = 0;
      currentFrame = null;
      sequence = 0;
      eventSequence = 0;
      previousHeapBytes = null;
      activeTerrainGate = null;
      terrainBlockedFrameCount = 0;
      terrainBlockedDurationMs = 0;
      longestTerrainBlockedDurationMs = 0;
    },
    snapshot() {
      const frameTotals = frames.map(frame => frame.frameTotalMs);
      const callbackDurations = frames.map(frame => frame.callbackDurationMs);
      const activeGateDurationMs = activeTerrainGate
        ? Math.max(0, clock() - activeTerrainGate.startedAtMs) : 0;
      const allHitchWindows = [
        ...hitchWindows,
        ...pendingHitchWindows.map(pending => Object.freeze({
          thresholdMs: pending.thresholdMs,
          hitch: pending.hitch,
          before: Object.freeze([...pending.before]),
          after: Object.freeze([...pending.after]),
        })),
      ].slice(-hitchLimit);
      const heaviestFrames = [...frames]
        .sort((left, right) => right.frameTotalMs - left.frameTotalMs
          || left.sequence - right.sequence)
        .slice(0, 10);
      const gpuWaitFrames = frames.filter(frame => frame.gpuOrCompositorWaitSuspected);
      const allocationSpikeFrames = frames.filter(
        frame => frame.memory.allocationSpikeSuspected,
      );
      const garbageCollectionFrames = frames.filter(
        frame => frame.memory.garbageCollectionSuspected,
      );
      return Object.freeze({
        schemaVersion: 'w8-browser-frame-attribution-1',
        enabled: true,
        measurementSource,
        frameWindowCapacity: frameLimit,
        environment: Object.freeze({ ...environment }),
        frame: summarize(frameTotals),
        callback: summarize(callbackDurations),
        over33Ratio: frames.length
          ? frames.filter(frame => frame.frameTotalMs > 33).length / frames.length : 0,
        over50Ratio: frames.length
          ? frames.filter(frame => frame.frameTotalMs > 50).length / frames.length : 0,
        over100Ratio: frames.length
          ? frames.filter(frame => frame.frameTotalMs > 100).length / frames.length : 0,
        gpuOrCompositorWait: Object.freeze({
          suspectedFrameCount: gpuWaitFrames.length,
          suspectedFrameRatio: frames.length ? gpuWaitFrames.length / frames.length : 0,
          maximumSuspectedWaitMs: gpuWaitFrames.length
            ? Math.max(...gpuWaitFrames.map(frame => frame.gpuOrCompositorWaitMs)) : 0,
          inferenceOnly: true,
        }),
        memorySignals: Object.freeze({
          allocationSpikeFrameCount: allocationSpikeFrames.length,
          garbageCollectionSuspectedFrameCount: garbageCollectionFrames.length,
          maximumPositiveHeapDeltaBytes: frames.length ? Math.max(
            0,
            ...frames.flatMap(frame => [
              frame.memory.heapDeltaFromPreviousFrameBytes ?? 0,
              frame.memory.callbackHeapDeltaBytes ?? 0,
            ]),
          ) : 0,
          maximumNegativeHeapDeltaBytes: frames.length ? Math.min(
            0,
            ...frames.flatMap(frame => [
              frame.memory.heapDeltaFromPreviousFrameBytes ?? 0,
              frame.memory.callbackHeapDeltaBytes ?? 0,
            ]),
          ) : 0,
          source: performanceObject?.memory ? 'performance.memory' : 'unavailable',
        }),
        frames: Object.freeze([...frames]),
        heaviestFrames: Object.freeze(heaviestFrames),
        hitchWindows: Object.freeze(allHitchWindows),
        timeline: Object.freeze([...timeline]),
        terrainTransitions: terrainTransitionTimeline(timeline),
        workerRequests: workerRequestTimeline(timeline),
        terrainReadyGate: Object.freeze({
          blockedFrameCount: terrainBlockedFrameCount,
          blockedDurationMs: terrainBlockedDurationMs + activeGateDurationMs,
          longestBlockedDurationMs: Math.max(
            longestTerrainBlockedDurationMs,
            activeGateDurationMs,
          ),
          active: activeTerrainGate !== null,
          activeOwnerKey: activeTerrainGate?.ownerKey ?? null,
        }),
        notes: EMPTY_SNAPSHOT.notes,
      });
    },
  });
}
