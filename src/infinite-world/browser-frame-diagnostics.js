import { CHUNK_GENERATION_STAGE_ORDER } from './chunk-generation-stage-timing.js';

const DEFAULT_FRAME_LIMIT = 300;
const DEFAULT_HITCH_LIMIT = 64;
const DEFAULT_EVENT_LIMIT = 2_048;
const DEFAULT_CONTEXT_RADIUS = 5;
const HITCH_THRESHOLDS_MS = Object.freeze([33, 50, 100]);

export const BROWSER_FRAME_DIAGNOSTIC_MODE = Object.freeze({
  OFF: 'off',
  LIGHT: 'light',
  DEEP_ATTRIBUTION: 'deep-attribution',
});

function resolveDiagnosticMode(mode, enabled) {
  const resolved = mode ?? (enabled === true
    ? BROWSER_FRAME_DIAGNOSTIC_MODE.LIGHT : BROWSER_FRAME_DIAGNOSTIC_MODE.OFF);
  if (!Object.values(BROWSER_FRAME_DIAGNOSTIC_MODE).includes(resolved)) {
    throw new RangeError('Browser frame diagnostic mode must be off, light, or deep-attribution');
  }
  return resolved;
}

const EMPTY_SNAPSHOT = Object.freeze({
  schemaVersion: 'w8-browser-frame-attribution-1',
  enabled: false,
  mode: BROWSER_FRAME_DIAGNOSTIC_MODE.OFF,
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
  chunkSupply: Object.freeze({
    requests: Object.freeze([]),
    completedRequestCount: 0,
    stageTotalsMs: Object.freeze({}),
    stagePercentages: Object.freeze({}),
    dominantStage: null,
    dominantStageMs: 0,
    generationStages: Object.freeze({}),
    top20SlowestGeneration: Object.freeze([]),
    dominantGenerationStage: null,
    dominantGenerationStageMs: 0,
    dominantGenerationStagePercent: 0,
    dominantGenerationStageAtLeast70Percent: false,
    roadGeneration: null,
  }),
  coverageMisses: Object.freeze([]),
  publicationTransitions: Object.freeze([]),
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
  mode: BROWSER_FRAME_DIAGNOSTIC_MODE.OFF,
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
  const samples = typeof values?.toArray === 'function' ? values.toArray() : values;
  if (!samples.length) return 0;
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.min(
    ordered.length - 1,
    Math.ceil(ordered.length * fraction) - 1,
  ))];
}

function summarize(values) {
  const samples = typeof values?.toArray === 'function' ? values.toArray() : values;
  return Object.freeze({
    count: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: samples.length ? Math.max(...samples) : 0,
  });
}

function createCircularBuffer(capacity) {
  const storage = new Array(capacity);
  let start = 0;
  let size = 0;
  return Object.freeze({
    get length() { return size; },
    get full() { return size === capacity; },
    first() {
      return size > 0 ? storage[start] : undefined;
    },
    push(value) {
      const index = (start + size) % capacity;
      if (size < capacity) size += 1;
      else start = (start + 1) % capacity;
      storage[index] = value;
      return value;
    },
    toArray() {
      return Array.from(
        { length: size },
        (_, index) => storage[(start + index) % capacity],
      );
    },
    last(count) {
      const resultLength = Math.min(size, Math.max(0, count));
      const offset = size - resultLength;
      return Array.from(
        { length: resultLength },
        (_, index) => storage[(start + offset + index) % capacity],
      );
    },
    clear() {
      storage.fill(undefined);
      start = 0;
      size = 0;
    },
  });
}

function createNumericCircularBuffer(capacity) {
  const storage = new Float64Array(capacity);
  let start = 0;
  let size = 0;
  let total = 0;
  let latest = 0;
  return Object.freeze({
    get length() { return size; },
    get sum() { return total; },
    get latest() { return size > 0 ? latest : 0; },
    push(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return false;
      const index = (start + size) % capacity;
      if (size < capacity) size += 1;
      else {
        total -= storage[index];
        start = (start + 1) % capacity;
      }
      storage[index] = numeric;
      total += numeric;
      latest = numeric;
      return true;
    },
    toArray() {
      return Array.from(
        { length: size },
        (_, index) => storage[(start + index) % capacity],
      );
    },
    clear() {
      storage.fill(0);
      start = 0;
      size = 0;
      total = 0;
      latest = 0;
    },
  });
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

function chunkSupplyTimeline(events) {
  const byRequest = new Map();
  const relevant = new Set([
    'chunk-request-queued',
    'chunk-worker-dispatch',
    'worker-message-sent',
    'worker-message-received',
    'worker-chunk-stages',
    'worker-late-response',
    'worker-response-resolved',
    'chunk-main-response-received',
    'chunk-owner-ready',
    'chunk-owner-delivered',
  ]);
  for (const event of events) {
    if (!relevant.has(event.type) || !Number.isSafeInteger(event.requestId)) continue;
    const record = byRequest.get(event.requestId) ?? {
      requestId: event.requestId,
      ownerKey: event.ownerKey ?? null,
      consumerId: event.consumerId ?? null,
      operationKind: event.operationKind ?? 'chunk',
      priority: event.priority ?? null,
      required: event.required ?? null,
      requestAtMs: null,
      serviceDispatchAtMs: null,
      workerMessageSentAtMs: null,
      workerMessageReceivedAtMs: null,
      mainResponseAtMs: null,
      readyAtMs: null,
      deliveredAtMs: null,
      runtimeRequestCompleteAtMs: null,
      runtimeOwnerReadyAtMs: null,
      terrainPreparedAtMs: null,
      terrainAttachedAtMs: null,
      terrainOldOwnerReleasedAtMs: null,
      serviceQueueTimeMs: null,
      workerQueueTimeMs: null,
      workerExecutionMs: null,
      messageDeliveryMs: null,
      transportResidualMs: null,
      mainHandlerMs: null,
      backlogAtDispatch: null,
      generationTotalMs: null,
      generationStageTotalsMs: null,
      generationStageCallCounts: null,
      generationStageEvents: null,
      generationStartedAtMs: null,
      generationCompletedAtMs: null,
      responsePostStartedAtMs: null,
      responsePostCompletedAtMs: null,
      postMessageCallMs: null,
      transferMs: null,
      workerQueueResidentMs: null,
      schedulerQueueTimeMs: null,
      deadlineAtMs: null,
      deadlineMissAtStart: false,
      deadlineMissAtMainReceive: false,
      lateResponse: false,
      roadTiming: null,
      roadTimingSummary: null,
    };
    record.ownerKey ??= event.ownerKey ?? null;
    record.consumerId ??= event.consumerId ?? null;
    record.operationKind ??= event.operationKind ?? null;
    record.priority ??= event.priority ?? null;
    record.required ??= event.required ?? null;
    if (event.type === 'chunk-request-queued') record.requestAtMs = event.timestampMs;
    else if (event.type === 'chunk-worker-dispatch') {
      record.serviceDispatchAtMs = event.timestampMs;
      record.serviceQueueTimeMs = event.serviceQueueTimeMs ?? null;
      record.backlogAtDispatch = event.backlog ?? null;
    } else if (event.type === 'worker-message-sent') {
      record.workerMessageSentAtMs = event.sentAtMs ?? event.timestampMs;
    } else if (event.type === 'worker-message-received') {
      record.workerMessageReceivedAtMs = event.receivedAtMs ?? event.timestampMs;
      record.workerQueueTimeMs = event.workerQueueTimeMs ?? null;
      record.workerExecutionMs = event.workerExecutionMs ?? null;
      record.messageDeliveryMs = event.messageDeliveryMs ?? null;
      record.transportResidualMs = event.residualWaitMs ?? null;
      record.schedulerQueueTimeMs = event.schedulerQueueTimeMs ?? null;
    } else if (event.type === 'worker-chunk-stages') {
      record.generationTotalMs = event.generationTotalMs ?? null;
      record.generationStageTotalsMs = event.stageTotalsMs ?? null;
      record.generationStageCallCounts = event.stageCallCounts ?? null;
      record.generationStageEvents = event.stageEvents ?? null;
      record.generationStartedAtMs = event.generationStartedAtMs ?? null;
      record.generationCompletedAtMs = event.generationCompletedAtMs ?? null;
      record.responsePostStartedAtMs = event.responsePostStartedAtMs ?? null;
      record.responsePostCompletedAtMs = event.responsePostCompletedAtMs ?? null;
      record.postMessageCallMs = event.postMessageCallMs ?? null;
      record.transferMs = event.transferMs ?? null;
      record.workerQueueResidentMs = event.workerQueueResidentMs ?? null;
      record.schedulerQueueTimeMs = event.schedulerQueueTimeMs ?? record.schedulerQueueTimeMs;
      record.deadlineAtMs = event.deadlineAtMs ?? null;
      record.deadlineMissAtStart = event.deadlineMissAtStart === true;
      record.deadlineMissAtMainReceive = event.deadlineMissAtMainReceive === true;
      record.roadTiming = event.roadTiming ?? null;
      record.roadTimingSummary = event.roadTimingSummary ?? null;
    } else if (event.type === 'worker-late-response') {
      record.lateResponse = true;
    } else if (event.type === 'worker-response-resolved') {
      record.mainHandlerMs = event.mainHandlerMs ?? null;
    } else if (event.type === 'chunk-main-response-received') {
      record.mainResponseAtMs = event.timestampMs;
    } else if (event.type === 'chunk-owner-ready') {
      record.readyAtMs = event.timestampMs;
    } else if (event.type === 'chunk-owner-delivered') {
      record.deliveredAtMs = event.timestampMs;
    }
    byRequest.set(event.requestId, record);
  }
  const byOwner = new Map();
  for (const record of byRequest.values()) {
    if (!record.ownerKey) continue;
    const ownerRecords = byOwner.get(record.ownerKey) ?? [];
    ownerRecords.push(record);
    byOwner.set(record.ownerKey, ownerRecords);
  }
  const ownerEventFields = Object.freeze({
    'runtime-owner-request-complete': 'runtimeRequestCompleteAtMs',
    'runtime-prefetch-owner-ready': 'runtimeOwnerReadyAtMs',
    'runtime-terrain-prepared': 'terrainPreparedAtMs',
    'runtime-terrain-attached': 'terrainAttachedAtMs',
    'runtime-terrain-old-owner-released': 'terrainOldOwnerReleasedAtMs',
  });
  for (const event of events) {
    const field = ownerEventFields[event.type];
    if (!field || !event.ownerKey) continue;
    const candidate = (byOwner.get(event.ownerKey) ?? []).findLast(record => (
      !Number.isFinite(record.requestAtMs)
      || record.requestAtMs <= event.timestampMs
    ));
    if (candidate) candidate[field] = event.timestampMs;
  }
  const resolved = [...byRequest.values()].map(record => {
    const requestToReadyMs = Number.isFinite(record.requestAtMs)
      && Number.isFinite(record.readyAtMs)
      ? Math.max(0, record.readyAtMs - record.requestAtMs) : null;
    const serviceQueueMs = Number.isFinite(record.serviceQueueTimeMs)
      ? record.serviceQueueTimeMs
      : Number.isFinite(record.requestAtMs) && Number.isFinite(record.serviceDispatchAtMs)
        ? Math.max(0, record.serviceDispatchAtMs - record.requestAtMs) : null;
    const mainReceiveToReadyMs = Number.isFinite(record.workerMessageReceivedAtMs)
      && Number.isFinite(record.readyAtMs)
      ? Math.max(0, record.readyAtMs - record.workerMessageReceivedAtMs) : null;
    const knownDurationMs = [
      serviceQueueMs,
      record.workerQueueTimeMs,
      record.workerExecutionMs,
      record.messageDeliveryMs,
      mainReceiveToReadyMs,
    ].filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
    const generationAccountedMs = CHUNK_GENERATION_STAGE_ORDER.reduce(
      (sum, stage) => sum + (Number.isFinite(record.generationStageTotalsMs?.[stage])
        ? record.generationStageTotalsMs[stage] : 0),
      0,
    );
    const generationTotalMs = Number.isFinite(record.generationTotalMs)
      ? record.generationTotalMs : record.workerExecutionMs;
    const generationPercentages = Object.fromEntries(
      CHUNK_GENERATION_STAGE_ORDER.map(stage => [
        stage,
        Number.isFinite(generationTotalMs) && generationTotalMs > 0
          ? ((record.generationStageTotalsMs?.[stage] ?? 0) / generationTotalMs) * 100
          : 0,
      ]),
    );
    const pipeline = [
      Number.isFinite(record.requestAtMs)
        ? Object.freeze({ stage: 'queue', timestampMs: record.requestAtMs }) : null,
      Number.isFinite(record.generationStartedAtMs)
        ? Object.freeze({ stage: 'start', timestampMs: record.generationStartedAtMs }) : null,
      ...(record.generationStageEvents ?? []).filter(stage => (
        Number.isFinite(stage.startedAtMs) && Number.isFinite(stage.completedAtMs)
      )).flatMap(stage => [
        Object.freeze({
          stage: stage.stage,
          status: 'start',
          timestampMs: stage.startedAtMs,
          durationMs: stage.durationMs,
        }),
        Object.freeze({
          stage: stage.stage,
          status: stage.status ?? 'completed',
          timestampMs: stage.completedAtMs,
          durationMs: stage.durationMs,
        }),
      ]),
      Number.isFinite(record.responsePostStartedAtMs)
        ? Object.freeze({ stage: 'postMessage', timestampMs: record.responsePostStartedAtMs }) : null,
      Number.isFinite(record.workerMessageReceivedAtMs)
        ? Object.freeze({ stage: 'main-receive', timestampMs: record.workerMessageReceivedAtMs }) : null,
      Number.isFinite(record.readyAtMs)
        ? Object.freeze({ stage: 'ready', timestampMs: record.readyAtMs }) : null,
    ].filter(Boolean).sort((left, right) => left.timestampMs - right.timestampMs
      || left.stage.localeCompare(right.stage));
    return Object.freeze({
      ...record,
      requestClass: record.required === true ? 'required' : 'prefetch',
      serviceQueueMs,
      mainReceiveToReadyMs,
      requestToReadyMs,
      requestToTerrainPreparedMs: Number.isFinite(record.requestAtMs)
        && Number.isFinite(record.terrainPreparedAtMs)
        ? Math.max(0, record.terrainPreparedAtMs - record.requestAtMs) : null,
      readyToTerrainPreparedMs: Number.isFinite(record.readyAtMs)
        && Number.isFinite(record.terrainPreparedAtMs)
        ? Math.max(0, record.terrainPreparedAtMs - record.readyAtMs) : null,
      unattributedMs: Number.isFinite(requestToReadyMs)
        ? Math.max(0, requestToReadyMs - knownDurationMs) : null,
      generationTotalMs,
      generationAccountedMs,
      generationUnattributedMs: Number.isFinite(generationTotalMs)
        ? Math.max(0, generationTotalMs - generationAccountedMs) : null,
      generationOverlapMs: Number.isFinite(generationTotalMs)
        ? Math.max(0, generationAccountedMs - generationTotalMs) : null,
      generationPercentages: Object.freeze(generationPercentages),
      deadlineMiss: record.deadlineMissAtStart === true
        || record.deadlineMissAtMainReceive === true,
      timeline: Object.freeze(pipeline),
    });
  }).slice(-256);
  const completed = resolved.filter(record => Number.isFinite(record.requestToReadyMs));
  const stageKeys = Object.freeze([
    'serviceQueueMs',
    'workerQueueTimeMs',
    'workerExecutionMs',
    'messageDeliveryMs',
    'mainReceiveToReadyMs',
    'unattributedMs',
  ]);
  const stageTotalsMs = Object.fromEntries(stageKeys.map(key => [key, completed.reduce(
    (sum, record) => sum + (Number.isFinite(record[key]) ? record[key] : 0),
    0,
  )]));
  const totalKnownMs = Object.values(stageTotalsMs).reduce((sum, value) => sum + value, 0);
  const stagePercentages = Object.fromEntries(stageKeys.map(key => [
    key,
    totalKnownMs > 0 ? stageTotalsMs[key] / totalKnownMs : 0,
  ]));
  const dominant = Object.entries(stageTotalsMs).sort((left, right) => (
    right[1] - left[1] || left[0].localeCompare(right[0])
  ))[0] ?? [null, 0];
  const profiled = resolved.filter(record => Number.isFinite(record.generationTotalMs));
  const generationStages = Object.fromEntries(CHUNK_GENERATION_STAGE_ORDER.map(stage => {
    const durations = profiled.flatMap(record => (
      Array.isArray(record.generationStageEvents)
        ? record.generationStageEvents
          .filter(event => event.stage === stage && Number.isFinite(event.durationMs))
          .map(event => event.durationMs)
        : Number.isFinite(record.generationStageTotalsMs?.[stage])
          && (record.generationStageCallCounts?.[stage] ?? 0) > 0
          ? [record.generationStageTotalsMs[stage]] : []
    ));
    const totalMs = profiled.reduce(
      (sum, record) => sum + (Number.isFinite(record.generationStageTotalsMs?.[stage])
        ? record.generationStageTotalsMs[stage] : 0),
      0,
    );
    const invocationCount = profiled.reduce(
      (sum, record) => sum + (Number.isFinite(record.generationStageCallCounts?.[stage])
        ? record.generationStageCallCounts[stage] : 0),
      0,
    );
    return [stage, Object.freeze({
      invocationCount,
      chunkCount: profiled.filter(record => (
        (record.generationStageCallCounts?.[stage] ?? 0) > 0
      )).length,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.length ? Math.max(...durations) : 0,
      totalMs,
    })];
  }));
  const transferValues = profiled.map(record => record.transferMs).filter(Number.isFinite);
  const postMessageValues = profiled.map(record => record.postMessageCallMs).filter(Number.isFinite);
  generationStages.transfer = Object.freeze({
    invocationCount: transferValues.length,
    chunkCount: transferValues.length,
    ...summarize(transferValues),
    totalMs: transferValues.reduce((sum, value) => sum + value, 0),
    includes: 'structured clone, thread dispatch, main deserialization, and event-loop wait',
  });
  generationStages.postMessage = Object.freeze({
    invocationCount: postMessageValues.length,
    chunkCount: postMessageValues.length,
    ...summarize(postMessageValues),
    totalMs: postMessageValues.reduce((sum, value) => sum + value, 0),
  });
  const totalGenerationMs = profiled.reduce(
    (sum, record) => sum + record.generationTotalMs,
    0,
  );
  const dominantGeneration = totalGenerationMs > 0
    ? CHUNK_GENERATION_STAGE_ORDER.map(stage => [
      stage,
      generationStages[stage].totalMs,
    ]).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]
      ?? [null, 0]
    : [null, 0];
  const dominantGenerationStagePercent = totalGenerationMs > 0
    ? (dominantGeneration[1] / totalGenerationMs) * 100 : 0;
  const top20SlowestGeneration = [...profiled]
    .sort((left, right) => right.generationTotalMs - left.generationTotalMs
      || left.requestId - right.requestId)
    .slice(0, 20)
    .map(record => Object.freeze({
      requestId: record.requestId,
      owner: record.ownerKey,
      priority: record.priority,
      requestClass: record.requestClass,
      generationTotalMs: record.generationTotalMs,
      stagesMs: Object.freeze(Object.fromEntries(CHUNK_GENERATION_STAGE_ORDER.map(stage => [
        stage,
        record.generationStageTotalsMs?.[stage] ?? 0,
      ]))),
      percentages: record.generationPercentages,
      deadlineMiss: record.deadlineMiss,
      lateResponse: record.lateResponse,
      transferMs: record.transferMs,
      postMessageCallMs: record.postMessageCallMs,
      generationUnattributedMs: record.generationUnattributedMs,
      generationOverlapMs: record.generationOverlapMs,
    }));
  const roadGeneration = [...resolved]
    .reverse()
    .find(record => record.roadTimingSummary?.schemaVersion === 'road-generation-timing-1')
    ?.roadTimingSummary ?? null;
  return Object.freeze({
    requests: Object.freeze(resolved),
    completedRequestCount: completed.length,
    requestToReady: summarize(completed.map(record => record.requestToReadyMs)),
    serviceQueue: summarize(completed.map(record => record.serviceQueueMs).filter(Number.isFinite)),
    workerQueue: summarize(completed.map(record => record.workerQueueTimeMs).filter(Number.isFinite)),
    workerExecution: summarize(completed.map(record => record.workerExecutionMs).filter(Number.isFinite)),
    messageDelivery: summarize(completed.map(record => record.messageDeliveryMs).filter(Number.isFinite)),
    mainReceiveToReady: summarize(completed.map(record => record.mainReceiveToReadyMs).filter(Number.isFinite)),
    stageTotalsMs: Object.freeze(stageTotalsMs),
    stagePercentages: Object.freeze(stagePercentages),
    dominantStage: dominant[0],
    dominantStageMs: dominant[1],
    generationStages: Object.freeze(generationStages),
    profiledChunkCount: profiled.length,
    deadlineMissCount: profiled.filter(record => record.deadlineMiss).length,
    lateResponseCount: resolved.filter(record => record.lateResponse).length,
    top20SlowestGeneration: Object.freeze(top20SlowestGeneration),
    dominantGenerationStage: dominantGeneration[0],
    dominantGenerationStageMs: dominantGeneration[1],
    dominantGenerationStagePercent,
    dominantGenerationStageAtLeast70Percent: dominantGenerationStagePercent >= 70,
    generationTotalMs: totalGenerationMs,
    roadGeneration,
  });
}

function coverageMissTimeline(events) {
  const result = [];
  let active = null;
  for (const event of events) {
    if (event.type === 'player-prepared-coverage-miss') {
      if (active) result.push(Object.freeze({ ...active, restoredAtMs: null, durationMs: null }));
      active = { ...event };
    } else if (event.type === 'player-prepared-coverage-restored' && active) {
      result.push(Object.freeze({
        ...active,
        restoredAtMs: event.timestampMs,
        restoredFrameSequence: event.frameSequence,
        durationMs: Math.max(0, event.timestampMs - active.timestampMs),
      }));
      active = null;
    }
  }
  if (active) result.push(Object.freeze({ ...active, restoredAtMs: null, durationMs: null }));
  return Object.freeze(result.slice(-32));
}

function publicationTransitionTimeline(events) {
  const byGeneration = new Map();
  const relevant = new Set([
    'chunk-transition-runtime-ready',
    'terrain-post-commit-started',
    'terrain-post-commit-ready',
    'terrain-replacement-ready',
    'terrain-replacement-attached',
    'terrain-coverage-verified',
    'distant-post-commit-started',
    'distant-post-commit-ready',
    'distant-publication-queued',
    'distant-publication-complete',
    'chunk-transition-publication-complete',
  ]);
  for (const event of events) {
    if (!relevant.has(event.type) || !Number.isSafeInteger(event.transitionGeneration)) continue;
    const record = byGeneration.get(event.transitionGeneration) ?? {
      transitionGeneration: event.transitionGeneration,
      events: [],
    };
    record.events.push(Object.freeze({
      type: event.type,
      timestampMs: event.timestampMs,
      frameSequence: event.frameSequence,
      coverageEpoch: event.coverageEpoch ?? null,
      coverageSignature: event.coverageSignature ?? null,
      rootId: event.rootId ?? event.activeRootId ?? null,
      rootAttached: event.rootAttached ?? null,
      buildingPublicationSource: event.buildingPublicationSource ?? null,
      settlementRoadPublicationSource: event.settlementRoadPublicationSource ?? null,
      settlementPublicationPlanId: event.settlementPublicationPlanId ?? null,
      settlementPublicationRevision: event.settlementPublicationRevision ?? null,
    }));
    byGeneration.set(event.transitionGeneration, record);
  }
  return Object.freeze([...byGeneration.values()].slice(-32).map(record => Object.freeze({
    transitionGeneration: record.transitionGeneration,
    events: Object.freeze(record.events),
    durationMs: record.events.length > 1
      ? Math.max(0, record.events.at(-1).timestampMs - record.events[0].timestampMs) : 0,
  })));
}

export function createBrowserFrameDiagnostics({
  enabled = false,
  mode = null,
  globalObject = globalThis,
  clock = () => globalObject.performance?.now?.() ?? Date.now(),
  environment = {},
  frameLimit = DEFAULT_FRAME_LIMIT,
  hitchLimit = DEFAULT_HITCH_LIMIT,
  contextRadius = DEFAULT_CONTEXT_RADIUS,
} = {}) {
  const diagnosticMode = resolveDiagnosticMode(mode, enabled);
  if (diagnosticMode === BROWSER_FRAME_DIAGNOSTIC_MODE.OFF) return DISABLED_COLLECTOR;
  const detailed = diagnosticMode === BROWSER_FRAME_DIAGNOSTIC_MODE.DEEP_ATTRIBUTION;
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
  const frames = createCircularBuffer(frameLimit);
  const frameTotals = createNumericCircularBuffer(frameLimit);
  const callbackDurations = createNumericCircularBuffer(frameLimit);
  const lightOver33Flags = createNumericCircularBuffer(frameLimit);
  const lightOver50Flags = createNumericCircularBuffer(frameLimit);
  const lightOver100Flags = createNumericCircularBuffer(frameLimit);
  const lightGpuWaitFlags = createNumericCircularBuffer(frameLimit);
  const lightGpuWaitDurations = createNumericCircularBuffer(frameLimit);
  const lightAllocationFlags = createNumericCircularBuffer(frameLimit);
  const lightGarbageCollectionFlags = createNumericCircularBuffer(frameLimit);
  const lightPositiveHeapDeltas = createNumericCircularBuffer(frameLimit);
  const lightNegativeHeapDeltas = createNumericCircularBuffer(frameLimit);
  const hitchWindows = createCircularBuffer(hitchLimit);
  const pendingHitchWindows = [];
  const timeline = createCircularBuffer(DEFAULT_EVENT_LIMIT);
  const measurementSource = classifyMeasurementSource(environment);
  let currentFrame = null;
  let sequence = 0;
  let eventSequence = 0;
  let previousHeapBytes = null;
  let activeTerrainGate = null;
  let terrainBlockedFrameCount = 0;
  let terrainBlockedDurationMs = 0;
  let longestTerrainBlockedDurationMs = 0;
  let over33Count = 0;
  let over50Count = 0;
  let over100Count = 0;
  let gpuWaitCount = 0;
  let allocationSpikeCount = 0;
  let garbageCollectionCount = 0;
  const lightFrameState = {
    sequence: 0,
    rafTimestampMs: 0,
    callbackStartedAtMs: 0,
    callbackEndedAtMs: null,
    callbackDurationMs: 0,
    frameTotalMs: 0,
    heapStartBytes: null,
    heapDeltaFromPreviousFrameBytes: null,
    callbackHeapDeltaBytes: null,
    allocationSpikeSuspected: false,
    garbageCollectionSuspected: false,
    terrainReadyGateBlocked: false,
    visibilityHidden: false,
    gpuOrCompositorWaitMs: 0,
    gpuOrCompositorWaitSuspected: false,
  };

  const removeFrameCounters = frame => {
    if (!frame) return;
    if (frame.frameTotalMs > 33) over33Count -= 1;
    if (frame.frameTotalMs > 50) over50Count -= 1;
    if (frame.frameTotalMs > 100) over100Count -= 1;
    if (frame.gpuOrCompositorWaitSuspected) gpuWaitCount -= 1;
    if (frame.memory.allocationSpikeSuspected) allocationSpikeCount -= 1;
    if (frame.memory.garbageCollectionSuspected) garbageCollectionCount -= 1;
  };

  const addFrameCounters = frame => {
    if (frame.frameTotalMs > 33) over33Count += 1;
    if (frame.frameTotalMs > 50) over50Count += 1;
    if (frame.frameTotalMs > 100) over100Count += 1;
    if (frame.gpuOrCompositorWaitSuspected) gpuWaitCount += 1;
    if (frame.memory.allocationSpikeSuspected) allocationSpikeCount += 1;
    if (frame.memory.garbageCollectionSuspected) garbageCollectionCount += 1;
  };

  const recordEvent = (type, details = {}) => {
    const event = Object.freeze({
      sequence: ++eventSequence,
      type,
      timestampMs: clock(),
      frameSequence: currentFrame?.sequence ?? sequence,
      ...details,
    });
    timeline.push(event);
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
    if (!detailed) {
      currentFrame.callbackHeapDeltaBytes = heapEndBytes !== null
        && currentFrame.heapStartBytes !== null
        ? heapEndBytes - currentFrame.heapStartBytes : null;
      const largestPositiveDelta = Math.max(
        currentFrame.callbackHeapDeltaBytes ?? 0,
        currentFrame.heapDeltaFromPreviousFrameBytes ?? 0,
      );
      const largestNegativeDelta = Math.min(
        currentFrame.callbackHeapDeltaBytes ?? 0,
        currentFrame.heapDeltaFromPreviousFrameBytes ?? 0,
      );
      currentFrame.allocationSpikeSuspected = largestPositiveDelta >= 2 * 1024 * 1024;
      currentFrame.garbageCollectionSuspected = largestNegativeDelta <= -2 * 1024 * 1024;
      return currentFrame.sequence;
    }
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
    mode: diagnosticMode,
    startFrame(rafTimestampMs = clock()) {
      const heapBytes = readHeapBytes(performanceObject);
      if (!detailed) {
        lightFrameState.sequence = ++sequence;
        lightFrameState.rafTimestampMs = rafTimestampMs;
        lightFrameState.callbackStartedAtMs = clock();
        lightFrameState.callbackEndedAtMs = null;
        lightFrameState.callbackDurationMs = 0;
        lightFrameState.frameTotalMs = 0;
        lightFrameState.heapStartBytes = heapBytes;
        lightFrameState.heapDeltaFromPreviousFrameBytes = heapBytes !== null
          && previousHeapBytes !== null ? heapBytes - previousHeapBytes : null;
        lightFrameState.callbackHeapDeltaBytes = null;
        lightFrameState.allocationSpikeSuspected = false;
        lightFrameState.garbageCollectionSuspected = false;
        lightFrameState.terrainReadyGateBlocked = false;
        lightFrameState.visibilityHidden = globalObject.document?.visibilityState === 'hidden';
        lightFrameState.gpuOrCompositorWaitMs = 0;
        lightFrameState.gpuOrCompositorWaitSuspected = false;
        currentFrame = lightFrameState;
      } else currentFrame = {
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
      if (!detailed) return currentFrame.sequence;
      const target = async ? currentFrame.asyncStages : currentFrame.stages;
      target[stage] = (target[stage] ?? 0) + Math.max(0, durationMs);
      if (!async) currentFrame.stageCalls[stage] = (currentFrame.stageCalls[stage] ?? 0) + 1;
      return currentFrame.sequence;
    },
    recordWork(route, values = {}) {
      if (!currentFrame) return null;
      if (!detailed) return currentFrame.sequence;
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
        const alreadyBlocked = detailed
          ? currentFrame.terrainReadyGate?.blocked === true
          : currentFrame.terrainReadyGateBlocked === true;
        if (!alreadyBlocked) terrainBlockedFrameCount += 1;
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
        if (detailed) currentFrame.terrainReadyGate = { blocked: true, ownerKey };
        else currentFrame.terrainReadyGateBlocked = true;
      } else {
        if (detailed) currentFrame.terrainReadyGate = { blocked: false, ownerKey };
        else currentFrame.terrainReadyGateBlocked = false;
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
        && (detailed ? currentFrame.visibilityState !== 'hidden' : !currentFrame.visibilityHidden);
      currentFrame.gpuOrCompositorWaitMs = currentFrame.gpuOrCompositorWaitSuspected
        ? unoccupiedIntervalMs : 0;
      if (!detailed) {
        frameTotals.push(currentFrame.frameTotalMs);
        callbackDurations.push(currentFrame.callbackDurationMs);
        lightOver33Flags.push(Number(currentFrame.frameTotalMs > 33));
        lightOver50Flags.push(Number(currentFrame.frameTotalMs > 50));
        lightOver100Flags.push(Number(currentFrame.frameTotalMs > 100));
        lightGpuWaitFlags.push(Number(currentFrame.gpuOrCompositorWaitSuspected));
        lightGpuWaitDurations.push(currentFrame.gpuOrCompositorWaitMs);
        lightAllocationFlags.push(Number(currentFrame.allocationSpikeSuspected));
        lightGarbageCollectionFlags.push(Number(currentFrame.garbageCollectionSuspected));
        lightPositiveHeapDeltas.push(Math.max(
          0,
          currentFrame.heapDeltaFromPreviousFrameBytes ?? 0,
          currentFrame.callbackHeapDeltaBytes ?? 0,
        ));
        lightNegativeHeapDeltas.push(Math.min(
          0,
          currentFrame.heapDeltaFromPreviousFrameBytes ?? 0,
          currentFrame.callbackHeapDeltaBytes ?? 0,
        ));
        const completedSequence = currentFrame.sequence;
        currentFrame = null;
        return completedSequence;
      }
      currentFrame.finishedAtMs = frameNow;
      const record = cloneFrame(currentFrame);

      for (let index = pendingHitchWindows.length - 1; index >= 0; index -= 1) {
        const pending = pendingHitchWindows[index];
        pending.after.push(record);
        if (pending.after.length >= contextRadius) {
          hitchWindows.push(Object.freeze({
            thresholdMs: pending.thresholdMs,
            hitch: pending.hitch,
            before: Object.freeze(pending.before),
            after: Object.freeze(pending.after),
          }));
          const finalIndex = pendingHitchWindows.length - 1;
          if (index !== finalIndex) pendingHitchWindows[index] = pendingHitchWindows[finalIndex];
          pendingHitchWindows.pop();
        }
      }

      const thresholdMs = highestThreshold(record.frameTotalMs);
      if (thresholdMs !== null) {
        pendingHitchWindows.push({
          thresholdMs,
          hitch: record,
          before: frames.last(contextRadius),
          after: [],
        });
      }
      if (frames.full) removeFrameCounters(frames.first());
      frames.push(record);
      frameTotals.push(record.frameTotalMs);
      callbackDurations.push(record.callbackDurationMs);
      addFrameCounters(record);
      currentFrame = null;
      return record;
    },
    reset() {
      frames.clear();
      frameTotals.clear();
      callbackDurations.clear();
      lightOver33Flags.clear();
      lightOver50Flags.clear();
      lightOver100Flags.clear();
      lightGpuWaitFlags.clear();
      lightGpuWaitDurations.clear();
      lightAllocationFlags.clear();
      lightGarbageCollectionFlags.clear();
      lightPositiveHeapDeltas.clear();
      lightNegativeHeapDeltas.clear();
      hitchWindows.clear();
      pendingHitchWindows.length = 0;
      timeline.clear();
      currentFrame = null;
      sequence = 0;
      eventSequence = 0;
      previousHeapBytes = null;
      activeTerrainGate = null;
      terrainBlockedFrameCount = 0;
      terrainBlockedDurationMs = 0;
      longestTerrainBlockedDurationMs = 0;
      over33Count = 0;
      over50Count = 0;
      over100Count = 0;
      gpuWaitCount = 0;
      allocationSpikeCount = 0;
      garbageCollectionCount = 0;
    },
    snapshot() {
      const frameRecords = frames.toArray();
      const eventRecords = timeline.toArray();
      const activeGateDurationMs = activeTerrainGate
        ? Math.max(0, clock() - activeTerrainGate.startedAtMs) : 0;
      const allHitchWindows = [
        ...hitchWindows.toArray(),
        ...pendingHitchWindows.map(pending => Object.freeze({
          thresholdMs: pending.thresholdMs,
          hitch: pending.hitch,
          before: Object.freeze([...pending.before]),
          after: Object.freeze([...pending.after]),
        })),
      ].sort((left, right) => (
        left.hitch.sequence - right.hitch.sequence
      )).slice(-hitchLimit);
      const heaviestFrames = [...frameRecords]
        .sort((left, right) => right.frameTotalMs - left.frameTotalMs
          || left.sequence - right.sequence)
        .slice(0, 10);
      const gpuWaitFrames = frameRecords.filter(frame => frame.gpuOrCompositorWaitSuspected);
      const numericFrameCount = frameTotals.length;
      const lightGpuWaitValues = detailed ? null : lightGpuWaitDurations.toArray();
      const lightPositiveHeapValues = detailed ? null : lightPositiveHeapDeltas.toArray();
      const lightNegativeHeapValues = detailed ? null : lightNegativeHeapDeltas.toArray();
      return Object.freeze({
        schemaVersion: 'w8-browser-frame-attribution-1',
        enabled: true,
        mode: diagnosticMode,
        measurementSource,
        frameWindowCapacity: frameLimit,
        environment: Object.freeze({ ...environment }),
        frame: summarize(frameTotals),
        callback: summarize(callbackDurations),
        over33Ratio: numericFrameCount ? (detailed
          ? over33Count : lightOver33Flags.sum) / numericFrameCount : 0,
        over50Ratio: numericFrameCount ? (detailed
          ? over50Count : lightOver50Flags.sum) / numericFrameCount : 0,
        over100Ratio: numericFrameCount ? (detailed
          ? over100Count : lightOver100Flags.sum) / numericFrameCount : 0,
        gpuOrCompositorWait: Object.freeze({
          suspectedFrameCount: detailed ? gpuWaitCount : lightGpuWaitFlags.sum,
          suspectedFrameRatio: numericFrameCount
            ? (detailed ? gpuWaitCount : lightGpuWaitFlags.sum) / numericFrameCount : 0,
          maximumSuspectedWaitMs: detailed
            ? gpuWaitFrames.length
              ? Math.max(...gpuWaitFrames.map(frame => frame.gpuOrCompositorWaitMs)) : 0
            : lightGpuWaitValues.length ? Math.max(...lightGpuWaitValues) : 0,
          inferenceOnly: true,
        }),
        memorySignals: Object.freeze({
          allocationSpikeFrameCount: detailed ? allocationSpikeCount : lightAllocationFlags.sum,
          garbageCollectionSuspectedFrameCount: detailed
            ? garbageCollectionCount : lightGarbageCollectionFlags.sum,
          maximumPositiveHeapDeltaBytes: detailed && frames.length ? Math.max(
            0,
            ...frameRecords.flatMap(frame => [
              frame.memory.heapDeltaFromPreviousFrameBytes ?? 0,
              frame.memory.callbackHeapDeltaBytes ?? 0,
            ]),
          ) : !detailed && lightPositiveHeapValues.length
            ? Math.max(0, ...lightPositiveHeapValues) : 0,
          maximumNegativeHeapDeltaBytes: detailed && frames.length ? Math.min(
            0,
            ...frameRecords.flatMap(frame => [
              frame.memory.heapDeltaFromPreviousFrameBytes ?? 0,
              frame.memory.callbackHeapDeltaBytes ?? 0,
            ]),
          ) : !detailed && lightNegativeHeapValues.length
            ? Math.min(0, ...lightNegativeHeapValues) : 0,
          source: performanceObject?.memory ? 'performance.memory' : 'unavailable',
        }),
        frames: Object.freeze(frameRecords),
        heaviestFrames: Object.freeze(heaviestFrames),
        hitchWindows: Object.freeze(allHitchWindows),
        timeline: Object.freeze(eventRecords),
        chunkSupply: chunkSupplyTimeline(eventRecords),
        coverageMisses: coverageMissTimeline(eventRecords),
        publicationTransitions: publicationTransitionTimeline(eventRecords),
        terrainTransitions: terrainTransitionTimeline(eventRecords),
        workerRequests: workerRequestTimeline(eventRecords),
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
        storage: Object.freeze({
          frameCount: numericFrameCount,
          detailedFrameCount: frames.length,
          frameCapacity: frameLimit,
          numericFrameCount: frameTotals.length,
          numericCallbackCount: callbackDurations.length,
          hitchWindowCount: hitchWindows.length,
          hitchWindowCapacity: hitchLimit,
          timelineCount: timeline.length,
          timelineCapacity: DEFAULT_EVENT_LIMIT,
          numericOnlyLightPath: !detailed,
        }),
        notes: EMPTY_SNAPSHOT.notes,
      });
    },
  });
}
