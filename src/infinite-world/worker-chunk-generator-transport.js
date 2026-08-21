import {
  CHUNK_DATA_PRIORITY,
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
  createCanonicalTreeCellGeneratorRequest,
  createChunkGeneratorCancelRequest,
  createChunkGeneratorInitializeRequest,
  createChunkGeneratorRequest,
  createChunkGeneratorSchedulerEnvelope,
  createForestHorizonGeneratorRequest,
  createPresentationOwnerGeneratorRequest,
} from './chunk-data-service-protocol.js';
import { createW8ForestHorizonManifest } from './forest-horizon-manifest.js';
import { MetricSeries } from './runtime-timing.js';
import { compareWorldGenerationRequests } from './world-generation-scheduler.js';

const TRANSPORT_TIMING_SAMPLE_CAPACITY = 4096;
const WORKER_SCHEDULER_CLOCK_SCHEMA = 'worker-scheduler-clock-1';
const SHARED_CANCELLATION_FLAG_INDEX = 0;
const SHARED_CANCELLATION_PREEMPTOR_INDEX = 1;
const SHARED_CANCELLATION_WORD_COUNT = 2;
const DEFAULT_WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS = 1_000;
export const FIXED_WORKER_LANE_TRANSPORT_SCHEMA = 'worker-fixed-lanes-1';
export const WORKER_GENERATION_LANE = Object.freeze({
  CRITICAL: 'critical',
  BACKGROUND: 'background',
});
const SUCCESS_RESPONSE_TYPES = new Set([
  CHUNK_GENERATOR_MESSAGE.GENERATED,
  CHUNK_GENERATOR_MESSAGE.GENERATED_FOREST_HORIZON,
  CHUNK_GENERATOR_MESSAGE.GENERATED_PRESENTATION_OWNER,
  CHUNK_GENERATOR_MESSAGE.GENERATED_CANONICAL_TREE_CELL,
  CHUNK_GENERATOR_MESSAGE.SETTLEMENTS,
  CHUNK_GENERATOR_MESSAGE.SETTLEMENT_TEMPLATE,
  CHUNK_GENERATOR_MESSAGE.CANONICAL_MAJOR_ROAD_OWNERS,
  CHUNK_GENERATOR_MESSAGE.DIAGNOSTICS,
]);

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function createSharedCancellationBuffer() {
  if (typeof globalThis.crossOriginIsolated === 'boolean'
    && globalThis.crossOriginIsolated !== true) return null;
  if (typeof globalThis.SharedArrayBuffer !== 'function'
    || typeof globalThis.Atomics?.store !== 'function') return null;
  return new globalThis.SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * SHARED_CANCELLATION_WORD_COUNT,
  );
}

function browserWorkerFactory(globalObject = globalThis) {
  if (typeof globalObject.Worker !== 'function') throw new Error('module Worker is unavailable');
  return new globalObject.Worker(
    new URL('./chunk-generator-worker.js', import.meta.url),
    { type: 'module', name: 'w8-chunk-generator' },
  );
}

function addWorkerListener(worker, type, listener) {
  if (typeof worker.addEventListener === 'function') {
    worker.addEventListener(type, listener);
    return () => worker.removeEventListener?.(type, listener);
  }
  if (typeof worker.on === 'function') {
    const wrapped = type === 'message' ? data => listener({ data }) : listener;
    worker.on(type, wrapped);
    return () => worker.off?.(type, wrapped);
  }
  throw new TypeError('Worker must provide addEventListener or on');
}

function transportError(message) {
  const error = new Error(message.message ?? 'Chunk generator Worker failed');
  error.name = message.name ?? 'Error';
  error.recoverable = message.recoverable === true;
  return error;
}

function isCancellationAcknowledgement(message) {
  return message?.type === CHUNK_GENERATOR_MESSAGE.ERROR
    && message.cancelled === true
    && message.code === 'WORLD_GENERATION_CANCELLED';
}

export function createWorkerChunkGeneratorTransport({
  worldSeed,
  settlementRoadGraphGeneratorId = null,
  settlementLotMode = null,
  serviceGeneration = 1,
  workerFactory = () => browserWorkerFactory(globalThis),
  fallbackTransportFactory = null,
  clock = defaultClock,
  sharedCancellationBufferFactory = createSharedCancellationBuffer,
  shutdownDrainTimeoutMs = DEFAULT_WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS,
  onSchedulerEvent = null,
  onPipelineEvent = null,
} = {}) {
  if (typeof worldSeed !== 'string' || !worldSeed) throw new TypeError('worldSeed is required');
  if (settlementRoadGraphGeneratorId !== null
    && (typeof settlementRoadGraphGeneratorId !== 'string' || !settlementRoadGraphGeneratorId)) {
    throw new TypeError('settlementRoadGraphGeneratorId must be a non-empty string when provided');
  }
  if (settlementLotMode !== null
    && (typeof settlementLotMode !== 'string' || !settlementLotMode)) {
    throw new TypeError('settlementLotMode must be a non-empty string when provided');
  }
  if (!Number.isSafeInteger(serviceGeneration) || serviceGeneration < 1) {
    throw new RangeError('serviceGeneration must be a positive safe integer');
  }
  if (typeof workerFactory !== 'function') throw new TypeError('workerFactory is required');
  if (fallbackTransportFactory !== null && typeof fallbackTransportFactory !== 'function') {
    throw new TypeError('fallbackTransportFactory must be a function when provided');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (typeof sharedCancellationBufferFactory !== 'function') {
    throw new TypeError('sharedCancellationBufferFactory must be a function');
  }
  if (!Number.isFinite(shutdownDrainTimeoutMs) || shutdownDrainTimeoutMs < 0) {
    throw new RangeError('shutdownDrainTimeoutMs must be a finite non-negative number');
  }
  if (onSchedulerEvent !== null && typeof onSchedulerEvent !== 'function') {
    throw new TypeError('onSchedulerEvent must be a function when provided');
  }
  if (onPipelineEvent !== null && typeof onPipelineEvent !== 'function') {
    throw new TypeError('onPipelineEvent must be a function when provided');
  }

  let worker = null;
  let fallbackTransport = null;
  let mode = 'pending';
  let initialized = false;
  let isShutdown = false;
  let shutdownDraining = false;
  let shutdownPromise = null;
  let metadata = null;
  let initializeResolve = null;
  let initializeReject = null;
  let initializePromise = null;
  let fallbackActivationPromise = null;
  let recoveryPromise = null;
  let runtimeFailure = null;
  let lastRecoveryFailure = null;
  let controlRequestId = 1_000_000_000;
  const pending = new Map();
  const cancelledAwaitingAcknowledgement = new Map();
  const pipelineReceipts = onPipelineEvent ? new Map() : null;
  const forestHorizonCancelledBeforeEpoch = new Map();
  let drainResolve = null;
  const removers = [];
  const generationTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const receiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const forestHorizonGenerationTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const forestHorizonReceiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const presentationOwnerGenerationTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const presentationOwnerReceiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const canonicalTreeCellGenerationTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const canonicalTreeCellReceiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const settlementQueryTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const settlementQueryReceiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const settlementTemplateTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const settlementTemplateReceiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const canonicalMajorRoadOwnerQueryTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const canonicalMajorRoadOwnerQueryReceiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const diagnosticTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const diagnosticReceiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const cancellationAcknowledgementTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const counts = {
    generated: 0,
    forestHorizonGenerated: 0,
    presentationOwnersGenerated: 0,
    canonicalTreeCellsGenerated: 0,
    settlementQueries: 0,
    settlementTemplateQueries: 0,
    canonicalMajorRoadOwnerQueries: 0,
    diagnosticQueries: 0,
    staleGenerationResponses: 0,
    lateResponses: 0,
    pipelineTimingMessages: 0,
    pipelineTimingOrphans: 0,
    workerErrors: 0,
    fallbackCount: 0,
    cancelRequests: 0,
    cancellationAcknowledgements: 0,
    cancellationAcknowledgementOrphans: 0,
    cancellationAcknowledgementsAbandoned: 0,
    preemptionAcknowledgements: 0,
    sharedCancellationSignals: 0,
    sharedCancellationUnavailable: 0,
    shutdownDrainTimeouts: 0,
    schedulerObserverFailures: 0,
    pipelineObserverFailures: 0,
  };
  let fallbackReason = null;
  let lastGeneratorSnapshot = null;
  let lastWorkerSchedulerSnapshot = null;
  let lastObserverFailure = null;
  let schedulerObserverDisabled = false;
  let pipelineObserverDisabled = false;
  const mainTimeOriginMs = Number.isFinite(globalThis.performance?.timeOrigin)
    ? globalThis.performance.timeOrigin : Date.now() - clock();

  const emitSchedulerEvent = event => {
    if (!onSchedulerEvent || schedulerObserverDisabled) return;
    try {
      onSchedulerEvent(Object.freeze(event));
    } catch (error) {
      schedulerObserverDisabled = true;
      counts.schedulerObserverFailures += 1;
      lastObserverFailure = Object.freeze({
        observer: 'scheduler',
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        observedAtMs: clock(),
      });
    }
  };
  const emitPipelineEvent = (type, details) => {
    if (!onPipelineEvent || pipelineObserverDisabled) return;
    try {
      onPipelineEvent(type, details);
    } catch (error) {
      pipelineObserverDisabled = true;
      counts.pipelineObserverFailures += 1;
      lastObserverFailure = Object.freeze({
        observer: 'pipeline',
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        observedAtMs: clock(),
      });
    }
  };
  const resolveDrainIfIdle = () => {
    if (pending.size !== 0 || cancelledAwaitingAcknowledgement.size !== 0) return;
    drainResolve?.(true);
    drainResolve = null;
  };
  const recordCancellationAcknowledgement = (
    message,
    operation,
    receivedAtMs,
    acknowledgementSource = 'worker-cancellation-response',
  ) => {
    const requestedAtMs = operation.cancellationRequestedAtMs
      ?? operation.cancelRequestedAtMs ?? null;
    const cancellationReason = operation.sharedCancellationReason
      ?? message.cancellationReason ?? operation.cancellationReason ?? 'cancelled';
    const preemptedByRequestId = operation.sharedPreemptedByRequestId
      ?? message.scheduler?.preemptedByRequestId ?? null;
    const workerAcknowledgementMs = Number.isFinite(
      message.scheduler?.cancellationAcknowledgementMs,
    ) ? Math.max(0, message.scheduler.cancellationAcknowledgementMs) : null;
    const workerToMainTime = value => Number.isFinite(message.workerTimeOriginMs)
      && Number.isFinite(value)
      ? message.workerTimeOriginMs + value - mainTimeOriginMs : null;
    const workerCancellationRequestedAtMainMs = workerToMainTime(
      message.scheduler?.cancellationRequestedAtMs,
    );
    const workerCancellationAcknowledgedAtMainMs = workerToMainTime(
      message.scheduler?.cancellationAcknowledgedAtMs,
    );
    const workerTerminalAtMainMs = workerToMainTime(message.scheduler?.terminalAtMs);
    const workerResponseSentAtMainMs = workerToMainTime(message.responseSentAtMs);
    const signalToWorkerObservationMs = requestedAtMs === null
      || workerCancellationRequestedAtMainMs === null ? null
      : Math.max(0, workerCancellationRequestedAtMainMs - requestedAtMs);
    const workerTerminalDrainMs = workerCancellationAcknowledgedAtMainMs === null
      || workerTerminalAtMainMs === null ? null
      : Math.max(0, workerTerminalAtMainMs - workerCancellationAcknowledgedAtMainMs);
    const workerResponseQueueMs = workerTerminalAtMainMs === null
      || workerResponseSentAtMainMs === null ? null
      : Math.max(0, workerResponseSentAtMainMs - workerTerminalAtMainMs);
    const responseDeliveryMs = workerResponseSentAtMainMs === null
      ? null : Math.max(0, receivedAtMs - workerResponseSentAtMainMs);
    // Automatic in-Worker preemption has no main-side cancel timestamp. Do
    // not mislabel the request's entire execution age as cancel latency.
    const acknowledgementMs = requestedAtMs === null
      ? workerAcknowledgementMs ?? 0
      : Math.max(0, receivedAtMs - requestedAtMs);
    cancellationAcknowledgementTimes.record(acknowledgementMs);
    counts.cancellationAcknowledgements += 1;
    if (preemptedByRequestId !== null) {
      counts.preemptionAcknowledgements += 1;
    }
    emitSchedulerEvent({
      type: 'cancel-acknowledged',
      envelope: operation.request.scheduler ?? null,
      state: 'cancelled',
      cancellationReason,
      cancellationRequestedAtMs: requestedAtMs,
      cancellationAcknowledgedAtMs: receivedAtMs,
      cancellationAcknowledgementMs: acknowledgementMs,
      workerCancellationAcknowledgementMs:
        workerAcknowledgementMs,
      cancellationAcknowledgedAtCheckpoint:
        message.scheduler?.cancellationAcknowledgedAtCheckpoint === true,
      cancellationCheckpointSite: message.scheduler?.cancellationCheckpointSite ?? null,
      preemptedByRequestId,
      acknowledgementSource,
      signalToWorkerObservationMs,
      workerTerminalDrainMs,
      workerResponseQueueMs,
      responseDeliveryMs,
      backlog: pending.size,
    });
    emitPipelineEvent('worker-cancel-acknowledged', {
      requestId: message.requestId,
      ownerKey: operation.request.scheduler?.ownerKey ?? null,
      correlationId: operation.request.scheduler?.correlationId ?? null,
      operationKind: operation.request.scheduler?.operationKind ?? null,
      target: operation.request.scheduler?.target ?? null,
      stream: operation.request.scheduler?.stream ?? null,
      cancellationReason,
      cancellationRequestedAtMs: requestedAtMs,
      receivedAtMs,
      cancellationAcknowledgementMs: acknowledgementMs,
      workerCancellationAcknowledgementMs:
        workerAcknowledgementMs,
      cancellationAcknowledgedAtCheckpoint:
        message.scheduler?.cancellationAcknowledgedAtCheckpoint === true,
      preemptedByRequestId,
      acknowledgementSource,
      signalToWorkerObservationMs,
      workerTerminalDrainMs,
      workerResponseQueueMs,
      responseDeliveryMs,
      pendingCount: pending.size,
    });
  };

  const emitCancelledTerminal = (
    message,
    operation,
    receivedAtMs,
    acknowledgementSource = 'worker-cancellation-response',
  ) => {
    recordCancellationAcknowledgement(
      message,
      operation,
      receivedAtMs,
      acknowledgementSource,
    );
    const cancellationReason = operation.sharedCancellationReason
      ?? message.cancellationReason ?? operation.cancellationReason ?? 'cancelled';
    const preemptedByRequestId = operation.sharedPreemptedByRequestId
      ?? message.scheduler?.preemptedByRequestId ?? null;
    emitSchedulerEvent({
      type: 'terminal',
      envelope: operation.request.scheduler ?? null,
      state: 'cancelled',
      terminalAtMs: receivedAtMs,
      cancellationReason,
      cancellationRequestedAtMs: operation.cancellationRequestedAtMs
        ?? message.scheduler?.cancellationRequestedAtMs ?? null,
      cancellationAcknowledgedAtMs: receivedAtMs,
      cancellationAcknowledgementMs: operation.cancellationRequestedAtMs === null
        || operation.cancellationRequestedAtMs === undefined
        ? message.scheduler?.cancellationAcknowledgementMs ?? null
        : Math.max(0, receivedAtMs - operation.cancellationRequestedAtMs),
      cancellationAcknowledgedAtCheckpoint:
        message.scheduler?.cancellationAcknowledgedAtCheckpoint === true,
      preemptedByRequestId,
      acknowledgementSource,
      scheduler: message.scheduler ?? null,
      backlog: pending.size,
    });
  };

  const terminateWorker = async () => {
    for (const remove of removers.splice(0)) remove();
    const target = worker;
    worker = null;
    if (target) await target.terminate?.();
  };

  const rejectPending = error => {
    for (const operation of pending.values()) {
      emitSchedulerEvent({
        type: 'terminal',
        envelope: operation.request.scheduler ?? null,
        state: 'failed',
        terminalAtMs: clock(),
        cancellationReason: null,
        error,
        backlog: Math.max(0, pending.size - 1),
      });
      operation.reject(error);
    }
    pending.clear();
    for (const operation of cancelledAwaitingAcknowledgement.values()) {
      counts.cancellationAcknowledgementsAbandoned += 1;
      emitSchedulerEvent({
        type: 'terminal',
        envelope: operation.request.scheduler ?? null,
        state: 'failed',
        terminalAtMs: clock(),
        cancellationReason: null,
        error,
        backlog: Math.max(0, cancelledAwaitingAcknowledgement.size - 1),
      });
      emitPipelineEvent('worker-cancel-acknowledgement-abandoned', {
        requestId: operation.request.requestId,
        ownerKey: operation.request.scheduler?.ownerKey ?? null,
        cancellationReason: operation.cancellationReason,
        error,
      });
      operation.reject(error);
    }
    cancelledAwaitingAcknowledgement.clear();
    pipelineReceipts?.clear();
    resolveDrainIfIdle();
  };

  const shutdownError = () => new Error('Worker ChunkData transport is shut down');

  const onMessage = event => {
    const receivedAtMs = clock();
    const message = event.data;
    if (!message || message.protocolVersion !== CHUNK_GENERATOR_PROTOCOL_VERSION) return;
    if (message.serviceGeneration !== serviceGeneration) {
      counts.staleGenerationResponses += 1;
      return;
    }
    if (isShutdown && !shutdownDraining) {
      counts.lateResponses += 1;
      return;
    }
    if (isShutdown && shutdownDraining
      && (!Number.isSafeInteger(message.requestId) || message.requestId < 1)) {
      counts.lateResponses += 1;
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.INITIALIZED) {
      metadata = message.metadata;
      initialized = true;
      mode = 'worker';
      initializeResolve?.(metadata);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.ERROR && message.requestId === null) {
      initializeReject?.(transportError(message));
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.PIPELINE_TIMING) {
      const receipt = pipelineReceipts?.get(message.requestId) ?? null;
      if (!receipt) {
        counts.pipelineTimingOrphans += 1;
        return;
      }
      pipelineReceipts.delete(message.requestId);
      counts.pipelineTimingMessages += 1;
      const workerToMainTime = value => Number.isFinite(message.workerTimeOriginMs)
        && Number.isFinite(value)
        ? message.workerTimeOriginMs + value - mainTimeOriginMs : null;
      const responsePostStartedAtMs = workerToMainTime(message.responsePostStartedAtMs);
      const responsePostCompletedAtMs = workerToMainTime(message.responsePostCompletedAtMs);
      const generationStartedAtMs = workerToMainTime(message.generationStartedAtMs);
      const generationCompletedAtMs = workerToMainTime(message.generationCompletedAtMs);
      const transferMs = Number.isFinite(responsePostCompletedAtMs)
        ? Math.max(0, receipt.receivedAtMs - responsePostCompletedAtMs) : null;
      const stageEvents = Array.isArray(message.stageTiming?.events)
        ? message.stageTiming.events.map(stage => Object.freeze({
          ...stage,
          startedAtMs: workerToMainTime(stage.startedAtMs),
          completedAtMs: workerToMainTime(stage.completedAtMs),
        })) : [];
      emitPipelineEvent('worker-chunk-stages', {
        ownerKey: receipt.ownerKey,
        requestId: message.requestId,
        correlationId: receipt.correlationId,
        operationKind: receipt.operationKind,
        target: receipt.target,
        stream: receipt.stream,
        priority: receipt.priority,
        required: receipt.required,
        requestClass: receipt.required === true ? 'required' : 'prefetch',
        deadlineAtMs: receipt.deadlineAtMs,
        deadlineMissAtStart: message.scheduler?.deadlineMiss === true,
        deadlineMissAtMainReceive: Number.isFinite(receipt.deadlineAtMs)
          ? receipt.receivedAtMs > receipt.deadlineAtMs : false,
        workerReceivedAtMs: workerToMainTime(message.requestReceivedAtMs),
        generationStartedAtMs,
        generationCompletedAtMs,
        generationTotalMs: message.generationTotalMs,
        responsePostStartedAtMs,
        responsePostCompletedAtMs,
        postMessageCallMs: message.postMessageCallMs,
        transferMs,
        mainReceivedAtMs: receipt.receivedAtMs,
        workerQueueResidentMs: message.scheduler?.workerQueueResidentMs ?? null,
        schedulerQueueTimeMs: message.scheduler?.queueTimeMs ?? null,
        stageTotalsMs: message.stageTiming?.totalsMs ?? null,
        stageCallCounts: message.stageTiming?.callCounts ?? null,
        stageEvents,
        roadTiming: message.roadTiming ?? null,
        roadTimingSummary: message.roadTimingSummary ?? null,
      });
      return;
    }
    const cancelledOperation = cancelledAwaitingAcknowledgement.get(message.requestId);
    if (cancelledOperation) {
      cancelledAwaitingAcknowledgement.delete(message.requestId);
      if (isCancellationAcknowledgement(message)) {
        emitCancelledTerminal(message, cancelledOperation, receivedAtMs);
        cancelledOperation.resolve(null);
        resolveDrainIfIdle();
        return;
      }
      if (message.type === CHUNK_GENERATOR_MESSAGE.ERROR) {
        const error = transportError(message);
        emitSchedulerEvent({
          type: 'terminal',
          envelope: cancelledOperation.request.scheduler ?? null,
          state: 'failed',
          terminalAtMs: receivedAtMs,
          cancellationReason: null,
          error,
          backlog: pending.size,
        });
        cancelledOperation.reject(error);
        resolveDrainIfIdle();
        return;
      }
      if (!SUCCESS_RESPONSE_TYPES.has(message.type)) {
        const error = new Error(`unexpected Chunk generator Worker response: ${message.type}`);
        emitSchedulerEvent({
          type: 'terminal',
          envelope: cancelledOperation.request.scheduler ?? null,
          state: 'failed',
          terminalAtMs: receivedAtMs,
          cancellationReason: null,
          error,
          backlog: pending.size,
        });
        cancelledOperation.reject(error);
        resolveDrainIfIdle();
        return;
      }
      counts.lateResponses += 1;
      emitPipelineEvent('worker-late-response', {
        requestId: message.requestId,
        ownerKey: message.macroKey ?? message.chunkKey
          ?? cancelledOperation.request.scheduler?.ownerKey ?? null,
        responseType: message.type,
        receivedAtMs,
        cancellationReason: cancelledOperation.cancellationReason,
        cancellationAcknowledged: false,
      });
      emitCancelledTerminal(
        message,
        cancelledOperation,
        receivedAtMs,
        'worker-completion-after-cancel',
      );
      cancelledOperation.resolve(null);
      resolveDrainIfIdle();
      return;
    }
    const operation = pending.get(message.requestId);
    if (!operation) {
      if (isCancellationAcknowledgement(message)) {
        counts.cancellationAcknowledgementOrphans += 1;
      }
      counts.lateResponses += 1;
      emitPipelineEvent('worker-late-response', {
        requestId: message.requestId,
        ownerKey: message.macroKey ?? message.chunkKey ?? null,
        responseType: message.type,
        receivedAtMs,
      });
      return;
    }
    const operationKind = operation.request.scheduler?.operationKind ?? null;
    const ownerKey = message.macroKey ?? message.chunkKey ?? operation.request.scheduler?.ownerKey
      ?? (Number.isSafeInteger(operation.request.chunkX)
        && Number.isSafeInteger(operation.request.chunkZ)
        ? `${operation.request.chunkX},${operation.request.chunkZ}`
        : Number.isSafeInteger(operation.request.macroX)
          && Number.isSafeInteger(operation.request.macroZ)
          ? `${operation.request.macroX},${operation.request.macroZ}` : null);
    const executionMs = Math.max(0, Number(
      message.generationMs ?? message.operationMs ?? 0,
    ) || 0);
    const workerQueueTimeMs = Number.isFinite(message.scheduler?.workerQueueResidentMs)
      ? Math.max(0, message.scheduler.workerQueueResidentMs)
      : Number.isFinite(message.scheduler?.queueTimeMs)
        ? Math.max(0, message.scheduler.queueTimeMs) : null;
    const schedulerQueueTimeMs = Number.isFinite(message.scheduler?.queueTimeMs)
      ? Math.max(0, message.scheduler.queueTimeMs) : null;
    const workerResponseSentAtMs = Number.isFinite(message.pipelineTiming?.workerTimeOriginMs)
      && Number.isFinite(message.pipelineTiming?.responseSentAtMs)
      ? message.pipelineTiming.workerTimeOriginMs
        + message.pipelineTiming.responseSentAtMs - mainTimeOriginMs : null;
    const messageDeliveryMs = Number.isFinite(workerResponseSentAtMs)
      ? Math.max(0, receivedAtMs - workerResponseSentAtMs) : null;
    emitPipelineEvent('worker-message-received', {
      ownerKey,
      requestId: message.requestId,
      correlationId: operation.request.scheduler?.correlationId ?? null,
      operationKind,
      target: operation.request.scheduler?.target ?? null,
      stream: operation.request.scheduler?.stream ?? null,
      priority: operation.request.scheduler?.priority ?? null,
      required: operation.request.scheduler?.required ?? null,
      responseType: message.type,
      sentAtMs: operation.sentAt,
      receivedAtMs,
      requestToMessageMs: Math.max(0, receivedAtMs - operation.sentAt),
      workerQueueTimeMs,
      schedulerQueueTimeMs,
      workerExecutionMs: executionMs,
      workerResponseSentAtMs,
      messageDeliveryMs,
      residualWaitMs: workerQueueTimeMs === null
        ? null : Math.max(0, receivedAtMs - operation.sentAt
          - workerQueueTimeMs - executionMs
          - (messageDeliveryMs ?? 0)),
      pendingCount: pending.size,
    });
    if (pipelineReceipts && message.pipelineTiming) {
      pipelineReceipts.set(message.requestId, Object.freeze({
        ownerKey,
        correlationId: operation.request.scheduler?.correlationId ?? null,
        operationKind,
        target: operation.request.scheduler?.target ?? null,
        stream: operation.request.scheduler?.stream ?? null,
        priority: operation.request.scheduler?.priority ?? null,
        required: operation.request.scheduler?.required ?? null,
        deadlineAtMs: operation.request.scheduler?.deadlineAtMs ?? null,
        receivedAtMs,
      }));
      while (pipelineReceipts.size > TRANSPORT_TIMING_SAMPLE_CAPACITY) {
        pipelineReceipts.delete(pipelineReceipts.keys().next().value);
      }
    }
    pending.delete(message.requestId);
    resolveDrainIfIdle();
    const resolveOperation = value => {
      emitPipelineEvent('worker-response-resolved', {
        ownerKey,
        requestId: message.requestId,
        correlationId: operation.request.scheduler?.correlationId ?? null,
        operationKind,
        responseType: message.type,
        mainHandlerMs: Math.max(0, clock() - receivedAtMs),
        pendingCount: pending.size,
      });
      operation.resolve(value);
    };
    if (isCancellationAcknowledgement(message)) {
      if (message.scheduler) {
        emitSchedulerEvent({
          type: 'started',
          envelope: operation.request.scheduler ?? null,
          state: 'in-flight',
          ...message.scheduler,
          backlog: message.scheduler.backlogAtStart,
        });
      }
      emitCancelledTerminal(message, operation, receivedAtMs);
      operation.resolve(null);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.ERROR) {
      emitSchedulerEvent({
        type: 'terminal',
        envelope: operation.request.scheduler ?? null,
        state: 'failed',
        terminalAtMs: clock(),
        cancellationReason: null,
        error: transportError(message),
        backlog: pending.size,
      });
      operation.reject(transportError(message));
      return;
    }
    if (!SUCCESS_RESPONSE_TYPES.has(message.type)) {
      const error = new Error(`unexpected Chunk generator Worker response: ${message.type}`);
      emitSchedulerEvent({
        type: 'terminal',
        envelope: operation.request.scheduler ?? null,
        state: 'failed',
        terminalAtMs: clock(),
        cancellationReason: null,
        error,
        backlog: pending.size,
      });
      operation.reject(error);
      return;
    }
    if (message.scheduler) {
      emitSchedulerEvent({
        type: 'started',
        envelope: operation.request.scheduler ?? null,
        state: 'in-flight',
        ...message.scheduler,
        backlog: message.scheduler.backlogAtStart,
      });
    }
    emitSchedulerEvent({
      type: 'terminal',
      envelope: operation.request.scheduler ?? null,
      state: 'completed',
      terminalAtMs: clock(),
      cancellationReason: null,
      scheduler: message.scheduler ?? null,
      backlog: pending.size,
    });
    if (message.type === CHUNK_GENERATOR_MESSAGE.GENERATED) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const generationMs = Math.max(0, Number(message.generationMs) || 0);
      generationTimes.record(generationMs);
      receiveTimes.record(Math.max(0, receivedMs - generationMs));
      counts.generated += 1;
      resolveOperation(message.chunkData);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.GENERATED_FOREST_HORIZON) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const generationMs = Math.max(0, Number(message.generationMs) || 0);
      forestHorizonGenerationTimes.record(generationMs);
      forestHorizonReceiveTimes.record(Math.max(0, receivedMs - generationMs));
      counts.forestHorizonGenerated += 1;
      resolveOperation(message.manifest);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.GENERATED_PRESENTATION_OWNER) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const generationMs = Math.max(0, Number(message.generationMs) || 0);
      presentationOwnerGenerationTimes.record(generationMs);
      presentationOwnerReceiveTimes.record(Math.max(0, receivedMs - generationMs));
      counts.presentationOwnersGenerated += 1;
      resolveOperation(message.presentationOwner);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.GENERATED_CANONICAL_TREE_CELL) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const generationMs = Math.max(0, Number(message.generationMs) || 0);
      canonicalTreeCellGenerationTimes.record(generationMs);
      canonicalTreeCellReceiveTimes.record(Math.max(0, receivedMs - generationMs));
      counts.canonicalTreeCellsGenerated += 1;
      resolveOperation(message.canonicalTreeCell);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.SETTLEMENTS) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const operationMs = Math.max(0, Number(message.operationMs) || 0);
      settlementQueryTimes.record(operationMs);
      settlementQueryReceiveTimes.record(Math.max(0, receivedMs - operationMs));
      counts.settlementQueries += 1;
      resolveOperation(message.settlements);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.SETTLEMENT_TEMPLATE) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const operationMs = Math.max(0, Number(message.operationMs) || 0);
      settlementTemplateTimes.record(operationMs);
      settlementTemplateReceiveTimes.record(Math.max(0, receivedMs - operationMs));
      counts.settlementTemplateQueries += 1;
      resolveOperation(message.template);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.CANONICAL_MAJOR_ROAD_OWNERS) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const operationMs = Math.max(0, Number(message.operationMs) || 0);
      canonicalMajorRoadOwnerQueryTimes.record(operationMs);
      canonicalMajorRoadOwnerQueryReceiveTimes.record(Math.max(0, receivedMs - operationMs));
      counts.canonicalMajorRoadOwnerQueries += 1;
      resolveOperation(message.coverage);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.DIAGNOSTICS) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const operationMs = Math.max(0, Number(message.operationMs) || 0);
      diagnosticTimes.record(operationMs);
      diagnosticReceiveTimes.record(Math.max(0, receivedMs - operationMs));
      counts.diagnosticQueries += 1;
      lastGeneratorSnapshot = message.generatorSnapshot ?? null;
      lastWorkerSchedulerSnapshot = message.workerSchedulerSnapshot ?? null;
      resolveOperation(lastGeneratorSnapshot);
    }
  };

  const onWorkerError = error => {
    counts.workerErrors += 1;
    const normalized = error instanceof Error ? error : new Error(error?.message ?? 'Chunk generator Worker failed');
    if (!initialized) initializeReject?.(normalized);
    else {
      rejectPending(normalized);
      runtimeFailure = normalized;
      if (isShutdown || fallbackTransport || recoveryPromise) return;
      mode = fallbackTransportFactory === null ? 'failed' : 'recovering';
      if (fallbackTransportFactory !== null) {
        recoveryPromise = activateFallback(normalized);
        void recoveryPromise.catch(recoveryError => {
          runtimeFailure = recoveryError instanceof Error
            ? recoveryError : new Error(String(recoveryError));
          lastRecoveryFailure = Object.freeze({
            name: runtimeFailure.name,
            message: runtimeFailure.message,
            observedAtMs: clock(),
          });
          if (!isShutdown) mode = 'failed';
        });
      }
    }
  };

  const activateFallback = async error => {
    if (fallbackTransportFactory === null) throw error;
    if (fallbackActivationPromise) return fallbackActivationPromise;
    fallbackActivationPromise = (async () => {
      await terminateWorker();
      if (isShutdown) throw shutdownError();
      let candidate = null;
      try {
        candidate = await fallbackTransportFactory();
        if (isShutdown) throw shutdownError();
        if (typeof candidate?.generateChunk !== 'function') {
          throw new TypeError('fallback transport must provide generateChunk');
        }
        const candidateMetadata = await candidate.initialize?.() ?? null;
        if (isShutdown) throw shutdownError();
        fallbackReason = Object.freeze({ name: error?.name ?? 'Error', message: error?.message ?? String(error) });
        fallbackTransport = candidate;
        candidate = null;
        metadata = candidateMetadata;
        lastGeneratorSnapshot = null;
        lastWorkerSchedulerSnapshot = null;
        pipelineReceipts?.clear();
        runtimeFailure = null;
        mode = 'inline-fallback';
        initialized = true;
        counts.fallbackCount += 1;
        return metadata;
      } catch (fallbackError) {
        if (candidate) {
          try {
            await candidate.shutdown?.();
          } catch (cleanupError) {
            throw new AggregateError(
              [fallbackError, cleanupError],
              'Fallback activation failed and candidate cleanup was incomplete',
            );
          }
        }
        throw fallbackError;
      }
    })();
    void fallbackActivationPromise.catch(recoveryError => {
      runtimeFailure = recoveryError instanceof Error
        ? recoveryError : new Error(String(recoveryError));
      lastRecoveryFailure = Object.freeze({
        name: runtimeFailure.name,
        message: runtimeFailure.message,
        observedAtMs: clock(),
      });
      if (!isShutdown) mode = 'failed';
    });
    return fallbackActivationPromise;
  };

  const initialize = () => {
    if (isShutdown) return Promise.reject(shutdownError());
    if (initializePromise) return recoveryPromise ?? initializePromise;
    initializePromise = (async () => {
      try {
        worker = workerFactory();
        removers.push(addWorkerListener(worker, 'message', onMessage));
        removers.push(addWorkerListener(worker, 'error', onWorkerError));
        initializePromise = new Promise((resolve, reject) => {
          initializeResolve = resolve;
          initializeReject = reject;
        });
        worker.postMessage(createChunkGeneratorInitializeRequest({
          serviceGeneration,
          worldSeed,
          ...(settlementRoadGraphGeneratorId ? { settlementRoadGraphGeneratorId } : {}),
          ...(settlementLotMode ? { settlementLotMode } : {}),
        }));
        return await initializePromise;
      } catch (error) {
        return activateFallback(error);
      } finally {
        initializeResolve = null;
        initializeReject = null;
      }
    })();
    return initializePromise;
  };

  const createRequestCancellationState = request => {
    if (request.scheduler?.required !== false) return null;
    const buffer = sharedCancellationBufferFactory();
    if (buffer === null) {
      counts.sharedCancellationUnavailable += 1;
      return null;
    }
    if (typeof globalThis.SharedArrayBuffer !== 'function'
      || !(buffer instanceof globalThis.SharedArrayBuffer)
      || buffer.byteLength
        < Int32Array.BYTES_PER_ELEMENT * SHARED_CANCELLATION_WORD_COUNT) {
      throw new TypeError('sharedCancellationBufferFactory must return SharedArrayBuffer or null');
    }
    return Object.freeze({
      buffer,
      view: new Int32Array(buffer, 0, SHARED_CANCELLATION_WORD_COUNT),
    });
  };
  const numericSharedPreemptor = requestId => (
    Number.isSafeInteger(requestId) && requestId > 0 && requestId <= 0x7fffffff
      ? requestId : 0
  );
  const preemptorFromReason = reason => {
    const match = /^preempted-by-higher-priority:(\d+)$/.exec(reason ?? '');
    if (!match) return null;
    const requestId = Number(match[1]);
    return Number.isSafeInteger(requestId) && requestId > 0 ? requestId : null;
  };
  const signalSharedCancellation = (operation, {
    reason,
    preemptedByRequestId = null,
  }) => {
    if (!operation?.sharedCancellationState) return false;
    operation.sharedCancellationReason = reason;
    operation.sharedPreemptedByRequestId = preemptedByRequestId;
    Atomics.store(
      operation.sharedCancellationState.view,
      SHARED_CANCELLATION_PREEMPTOR_INDEX,
      numericSharedPreemptor(preemptedByRequestId),
    );
    const previous = Atomics.compareExchange(
      operation.sharedCancellationState.view,
      SHARED_CANCELLATION_FLAG_INDEX,
      0,
      1,
    );
    if (previous === 0) counts.sharedCancellationSignals += 1;
    return previous === 0;
  };
  const signalPreemptiblePendingFor = (request, timestamp) => {
    if (request.scheduler?.required !== true) return;
    for (const operation of pending.values()) {
      if (operation.request.scheduler?.required !== false
        || !operation.sharedCancellationState
        || compareWorldGenerationRequests(
          request.scheduler,
          operation.request.scheduler,
          timestamp,
        ) >= 0) continue;
      signalSharedCancellation(operation, {
        reason: `preempted-by-higher-priority:${request.scheduler.requestId}`,
        preemptedByRequestId: request.scheduler.requestId,
      });
    }
  };

  const requestWorker = request => new Promise((resolve, reject) => {
    const target = worker;
    if (!target) {
      reject(isShutdown
        ? new Error('Worker ChunkData transport shut down before response')
        : runtimeFailure ?? new Error('Chunk generator Worker is unavailable'));
      return;
    }
    const sentAt = clock();
    const sharedCancellationState = createRequestCancellationState(request);
    pending.set(request.requestId, {
      resolve,
      reject,
      sentAt,
      request,
      sharedCancellationState,
      sharedCancellationReason: null,
      sharedPreemptedByRequestId: null,
    });
    emitSchedulerEvent({
      type: 'queued',
      envelope: request.scheduler ?? null,
      state: 'queued',
      queuedAtMs: request.scheduler?.createdAtMs ?? clock(),
      backlog: pending.size,
    });
    try {
      const postStartedAtMs = clock();
      // Scheduler envelopes are authored in the caller's clock domain. A
      // Worker owns a different performance.now() origin, so carry a boundary
      // sample that lets the Worker translate the whole envelope by one
      // offset before it performs deadline or aging comparisons.
      const scheduledRequest = request.scheduler ? {
        ...request,
        schedulerClock: Object.freeze({
          schemaVersion: WORKER_SCHEDULER_CLOCK_SCHEMA,
          sentAtMs: sentAt,
        }),
      } : request;
      const wireRequest = sharedCancellationState ? {
        ...scheduledRequest,
        sharedCancellationBuffer: sharedCancellationState.buffer,
      } : scheduledRequest;
      signalPreemptiblePendingFor(request, sentAt);
      target.postMessage(wireRequest);
      emitPipelineEvent('worker-message-sent', {
        ownerKey: request.scheduler?.ownerKey
          ?? (Number.isSafeInteger(request.chunkX) && Number.isSafeInteger(request.chunkZ)
            ? `${request.chunkX},${request.chunkZ}`
            : Number.isSafeInteger(request.macroX) && Number.isSafeInteger(request.macroZ)
              ? `${request.macroX},${request.macroZ}` : null),
        requestId: request.requestId,
        correlationId: request.scheduler?.correlationId ?? null,
        operationKind: request.scheduler?.operationKind ?? null,
        target: request.scheduler?.target ?? null,
        stream: request.scheduler?.stream ?? null,
        priority: request.scheduler?.priority ?? null,
        required: request.scheduler?.required ?? null,
        deadlineAtMs: request.scheduler?.deadlineAtMs ?? null,
        sentAtMs: sentAt,
        postMessageCallMs: Math.max(0, clock() - postStartedAtMs),
        pendingCount: pending.size,
      });
    } catch (error) {
      pending.delete(request.requestId);
      reject(error);
    }
  });

  const cancelPendingWorkerRequest = ({ requestId, reason }) => {
    const operation = pending.get(requestId);
    let cancelled = false;
    const workerSchedulerRequestId = operation?.request.scheduler?.requestId ?? requestId;
    if (operation) {
      signalSharedCancellation(operation, {
        reason,
        preemptedByRequestId: preemptorFromReason(reason),
      });
      const cancellationRequestedAtMs = clock();
      pending.delete(requestId);
      cancelledAwaitingAcknowledgement.set(requestId, {
        ...operation,
        cancellationRequestedAtMs,
        cancellationReason: reason,
        awaitCancellationAcknowledgement:
          operation.request.scheduler?.resourceKind != null,
      });
      counts.cancelRequests += 1;
      emitSchedulerEvent({
        type: 'cancel-requested',
        envelope: operation.request.scheduler ?? null,
        state: 'in-flight',
        cancellationReason: reason,
        cancellationRequestedAtMs,
        backlog: pending.size,
      });
      cancelled = true;
    }
    if (worker && (!isShutdown || shutdownDraining)) {
      worker.postMessage(createChunkGeneratorCancelRequest({
        requestId: workerSchedulerRequestId,
        serviceGeneration,
        reason,
      }));
    }
    return cancelled;
  };

  return Object.freeze({
    initialize,
    async generateChunk({
      requestId,
      chunkX,
      chunkZ,
      priority = CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
      required = priority <= CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
      createdAtMs = clock(),
      deadlineAtMs = null,
      consumerId = 'chunk-data-service',
      epoch = 0,
      telemetryCorrelationId = null,
      telemetryTarget = null,
      telemetryStream = null,
      scheduler = null,
    } = {}) {
      await initialize();
      if (isShutdown) throw shutdownError();
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        return fallbackTransport.generateChunk({
          requestId, chunkX, chunkZ, priority, required, createdAtMs, deadlineAtMs,
          consumerId, epoch, telemetryCorrelationId, telemetryTarget, telemetryStream, scheduler,
        });
      }
      return requestWorker(createChunkGeneratorRequest({
        requestId, serviceGeneration, chunkX, chunkZ, priority, required, createdAtMs,
        deadlineAtMs, consumerId, epoch, correlationId: telemetryCorrelationId,
        target: telemetryTarget, stream: telemetryStream, scheduler,
        pipelineDiagnostics: onPipelineEvent !== null,
      }));
    },
    async generateForestHorizonManifest({
      chunkX,
      chunkZ,
      consumerId = 'distant-owner-query',
      epoch = 0,
      priority = CHUNK_DATA_PRIORITY.DISTANT_OWNER,
      required = false,
      createdAtMs = clock(),
      deadlineAtMs = null,
      telemetryCorrelationId = null,
      telemetryTarget = 'tree',
      telemetryStream = 'distant',
      scheduler = null,
    } = {}) {
      if (epoch < (forestHorizonCancelledBeforeEpoch.get(consumerId) ?? 0)) return null;
      await initialize();
      if (isShutdown) throw shutdownError();
      if (epoch < (forestHorizonCancelledBeforeEpoch.get(consumerId) ?? 0)) return null;
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        if (typeof fallbackTransport.generateForestHorizonManifest === 'function') {
          return fallbackTransport.generateForestHorizonManifest({
            chunkX, chunkZ, consumerId, epoch, priority, required, createdAtMs,
            deadlineAtMs, telemetryCorrelationId, telemetryTarget, telemetryStream, scheduler,
          });
        }
        return createW8ForestHorizonManifest(await fallbackTransport.generateChunk({
          requestId: ++controlRequestId,
          chunkX,
          chunkZ,
          priority,
          required,
          createdAtMs,
          deadlineAtMs,
          consumerId,
          epoch,
          telemetryCorrelationId,
          telemetryTarget,
          telemetryStream,
          scheduler,
        }));
      }
      const requestId = ++controlRequestId;
      return requestWorker(createForestHorizonGeneratorRequest({
        requestId,
        serviceGeneration,
        chunkX,
        chunkZ,
        consumerId,
        epoch,
        priority,
        required,
        createdAtMs,
        deadlineAtMs,
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        scheduler,
        pipelineDiagnostics: onPipelineEvent !== null,
      }));
    },
    async generatePresentationOwner({
      chunkX,
      chunkZ,
      priority = CHUNK_DATA_PRIORITY.DISTANT_OWNER,
      required = true,
      createdAtMs = clock(),
      deadlineAtMs = null,
      consumerId = 'presentation-owner-service',
      epoch = 0,
      telemetryCorrelationId = null,
      telemetryTarget = 'distant',
      telemetryStream = 'distant',
      scheduler = null,
    } = {}) {
      await initialize();
      if (isShutdown) throw shutdownError();
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        if (typeof fallbackTransport.generatePresentationOwner !== 'function') {
          throw new Error('fallback transport does not expose PresentationOwner generation');
        }
        return fallbackTransport.generatePresentationOwner({
          chunkX, chunkZ, priority, required, createdAtMs, deadlineAtMs,
          consumerId, epoch, telemetryCorrelationId, telemetryTarget,
          telemetryStream, scheduler,
        });
      }
      const requestId = ++controlRequestId;
      return requestWorker(createPresentationOwnerGeneratorRequest({
        requestId,
        serviceGeneration,
        chunkX,
        chunkZ,
        priority,
        required,
        createdAtMs,
        deadlineAtMs,
        consumerId,
        epoch,
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        scheduler,
        pipelineDiagnostics: onPipelineEvent !== null,
      }));
    },
    async generateCanonicalTreeCell({
      macroX,
      macroZ,
      priority = CHUNK_DATA_PRIORITY.DISTANT_OWNER,
      required = true,
      createdAtMs = clock(),
      deadlineAtMs = null,
      consumerId = 'macro-coarse-world',
      epoch = 0,
      telemetryCorrelationId = null,
      telemetryTarget = 'tree',
      telemetryStream = 'distant',
      scheduler = null,
    } = {}) {
      await initialize();
      if (isShutdown) throw shutdownError();
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        if (typeof fallbackTransport.generateCanonicalTreeCell !== 'function') {
          throw new Error('fallback transport does not expose canonical Tree-cell generation');
        }
        return fallbackTransport.generateCanonicalTreeCell({
          macroX,
          macroZ,
          priority,
          required,
          createdAtMs,
          deadlineAtMs,
          consumerId,
          epoch,
          telemetryCorrelationId,
          telemetryTarget,
          telemetryStream,
          scheduler,
        });
      }
      const requestId = ++controlRequestId;
      return requestWorker(createCanonicalTreeCellGeneratorRequest({
        requestId,
        serviceGeneration,
        macroX,
        macroZ,
        priority,
        required,
        createdAtMs,
        deadlineAtMs,
        consumerId,
        epoch,
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        scheduler,
        pipelineDiagnostics: onPipelineEvent !== null,
      }));
    },
    cancelForestHorizonRequests({
      consumerId = 'distant-owner-query',
      epoch = null,
      beforeEpoch = null,
    } = {}) {
      if (typeof consumerId !== 'string' || !consumerId) {
        throw new TypeError('Forest horizon cancellation requires consumerId');
      }
      const cutoff = Number.isSafeInteger(beforeEpoch)
        ? beforeEpoch
        : Number.isSafeInteger(epoch) ? epoch + 1 : Number.MAX_SAFE_INTEGER;
      forestHorizonCancelledBeforeEpoch.set(
        consumerId,
        Math.max(forestHorizonCancelledBeforeEpoch.get(consumerId) ?? 0, cutoff),
      );
      let cancelled = 0;
      for (const [requestId, operation] of pending) {
        const request = operation.request;
        if (request?.type !== CHUNK_GENERATOR_MESSAGE.GENERATE_FOREST_HORIZON
          || request.consumerId !== consumerId || request.epoch >= cutoff) continue;
        signalSharedCancellation(operation, {
          reason: 'stale-forest-horizon-epoch',
        });
        const cancellationRequestedAtMs = clock();
        pending.delete(requestId);
        cancelledAwaitingAcknowledgement.set(requestId, {
          ...operation,
          cancellationRequestedAtMs,
          cancellationReason: 'stale-forest-horizon-epoch',
          awaitCancellationAcknowledgement:
            operation.request.scheduler?.resourceKind != null,
        });
        counts.cancelRequests += 1;
        emitSchedulerEvent({
          type: 'cancel-requested',
          envelope: request.scheduler ?? null,
          state: 'in-flight',
          cancellationReason: 'stale-forest-horizon-epoch',
          cancellationRequestedAtMs,
          backlog: pending.size,
        });
        cancelled += 1;
      }
      if (worker && (!isShutdown || shutdownDraining)) {
        worker.postMessage({
          type: CHUNK_GENERATOR_MESSAGE.CANCEL_FOREST_HORIZON,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          serviceGeneration,
          consumerId,
          beforeEpoch: cutoff,
        });
      }
      fallbackTransport?.cancelForestHorizonRequests?.({
        consumerId,
        beforeEpoch: cutoff,
      });
      return cancelled;
    },
    cancelGenerationRequest({ requestId, reason = 'consumer-cancelled' } = {}) {
      let cancelled = cancelPendingWorkerRequest({ requestId, reason });
      if (fallbackTransport?.cancelGenerationRequest?.({ requestId, reason })) cancelled = true;
      return cancelled;
    },
    cancelGenerationRequestBySchedulerRequestId({
      requestId,
      reason = 'consumer-cancelled',
    } = {}) {
      let cancelled = false;
      for (const [workerRequestId, operation] of [...pending]) {
        if (operation.request.scheduler?.requestId !== requestId) continue;
        if (cancelPendingWorkerRequest({ requestId: workerRequestId, reason })) cancelled = true;
      }
      if (fallbackTransport?.cancelGenerationRequestBySchedulerRequestId?.({
        requestId,
        reason,
      })) cancelled = true;
      return cancelled;
    },
    async findSettlementsNear(centerWorldX, centerWorldZ, radiusMeters, options = {}) {
      await initialize();
      if (isShutdown) throw shutdownError();
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        return fallbackTransport.findSettlementsNear(centerWorldX, centerWorldZ, radiusMeters, options);
      }
      const requestId = ++controlRequestId;
      const scheduler = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'settlement-query',
        priority: options.priority ?? CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
        required: options.required ?? true,
        createdAtMs: options.createdAtMs ?? clock(),
        deadlineAtMs: options.deadlineAtMs ?? null,
        consumerId: options.consumerId ?? 'settlement-query',
        correlationId: options.telemetryCorrelationId ?? null,
        target: options.telemetryTarget ?? 'settlement',
        stream: options.telemetryStream ?? 'distant',
        scheduler: options.scheduler ?? null,
      });
      return requestWorker({
        type: CHUNK_GENERATOR_MESSAGE.FIND_SETTLEMENTS,
        protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
        requestId,
        serviceGeneration,
        centerWorldX,
        centerWorldZ,
        radiusMeters,
        scheduler,
        ...(onPipelineEvent ? { pipelineDiagnostics: true } : {}),
      });
    },
    async resolveSettlementPresentationTemplate({ candidate, ...options } = {}) {
      await initialize();
      if (isShutdown) throw shutdownError();
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        return fallbackTransport.resolveSettlementPresentationTemplate({ candidate, ...options });
      }
      const requestId = ++controlRequestId;
      const scheduler = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'settlement-template',
        priority: options.priority ?? CHUNK_DATA_PRIORITY.PLAYER_RENDER,
        required: options.required ?? true,
        createdAtMs: options.createdAtMs ?? clock(),
        deadlineAtMs: options.deadlineAtMs ?? null,
        consumerId: options.consumerId ?? 'settlement-template',
        correlationId: options.telemetryCorrelationId ?? null,
        target: options.telemetryTarget ?? 'building',
        stream: options.telemetryStream ?? 'distant',
        scheduler: options.scheduler ?? null,
      });
      return requestWorker({
        type: CHUNK_GENERATOR_MESSAGE.RESOLVE_SETTLEMENT_TEMPLATE,
        protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
        requestId,
        serviceGeneration,
        candidate,
        scheduler,
        ...(onPipelineEvent ? { pipelineDiagnostics: true } : {}),
      });
    },
    async resolveCanonicalMajorRoadOwnerCoverage({
      centerWorldX,
      centerWorldZ,
      radiusMeters,
      ...options
    } = {}) {
      await initialize();
      if (isShutdown) throw shutdownError();
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        if (typeof fallbackTransport.resolveCanonicalMajorRoadOwnerCoverage !== 'function') {
          throw new Error('fallback transport does not expose canonical MAJOR Road owner coverage');
        }
        return fallbackTransport.resolveCanonicalMajorRoadOwnerCoverage({
          centerWorldX,
          centerWorldZ,
          radiusMeters,
          ...options,
        });
      }
      const requestId = ++controlRequestId;
      const scheduler = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'canonical-major-road-owner-query',
        priority: options.priority ?? CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
        required: options.required ?? true,
        createdAtMs: options.createdAtMs ?? clock(),
        deadlineAtMs: options.deadlineAtMs ?? null,
        consumerId: options.consumerId ?? 'canonical-major-road-owner-query',
        correlationId: options.telemetryCorrelationId ?? null,
        target: options.telemetryTarget ?? 'road',
        stream: options.telemetryStream ?? 'distant',
        scheduler: options.scheduler ?? null,
      });
      return requestWorker({
        type: CHUNK_GENERATOR_MESSAGE.RESOLVE_CANONICAL_MAJOR_ROAD_OWNERS,
        protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
        requestId,
        serviceGeneration,
        centerWorldX,
        centerWorldZ,
        radiusMeters,
        scheduler,
        ...(onPipelineEvent ? { pipelineDiagnostics: true } : {}),
      });
    },
    async requestDiagnostics(options = {}) {
      await initialize();
      if (isShutdown) throw shutdownError();
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        if (typeof fallbackTransport.requestDiagnostics !== 'function') {
          throw new Error('fallback transport does not expose diagnostics');
        }
        lastGeneratorSnapshot = await fallbackTransport.requestDiagnostics(options);
        counts.diagnosticQueries += 1;
        return lastGeneratorSnapshot;
      }
      const requestId = ++controlRequestId;
      const scheduler = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'diagnostics',
        priority: options.priority ?? CHUNK_DATA_PRIORITY.ULTRA_WARM,
        required: false,
        createdAtMs: options.createdAtMs ?? clock(),
        deadlineAtMs: options.deadlineAtMs ?? null,
        consumerId: 'diagnostics',
        scheduler: options.scheduler ?? null,
      });
      return requestWorker({
        type: CHUNK_GENERATOR_MESSAGE.REQUEST_DIAGNOSTICS,
        protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
        requestId,
        serviceGeneration,
        scheduler,
        ...(onPipelineEvent ? { pipelineDiagnostics: true } : {}),
      });
    },
    snapshot() {
      const generationTiming = generationTimes.snapshot();
      const receiveTiming = receiveTimes.snapshot();
      const forestHorizonGenerationTiming = forestHorizonGenerationTimes.snapshot();
      const forestHorizonReceiveTiming = forestHorizonReceiveTimes.snapshot();
      const presentationOwnerGenerationTiming = presentationOwnerGenerationTimes.snapshot();
      const presentationOwnerReceiveTiming = presentationOwnerReceiveTimes.snapshot();
      const canonicalTreeCellGenerationTiming = canonicalTreeCellGenerationTimes.snapshot();
      const canonicalTreeCellReceiveTiming = canonicalTreeCellReceiveTimes.snapshot();
      const settlementQueryTiming = settlementQueryTimes.snapshot();
      const settlementQueryReceiveTiming = settlementQueryReceiveTimes.snapshot();
      const settlementTemplateTiming = settlementTemplateTimes.snapshot();
      const settlementTemplateReceiveTiming = settlementTemplateReceiveTimes.snapshot();
      const canonicalMajorRoadOwnerQueryTiming = canonicalMajorRoadOwnerQueryTimes.snapshot();
      const canonicalMajorRoadOwnerQueryReceiveTiming =
        canonicalMajorRoadOwnerQueryReceiveTimes.snapshot();
      const diagnosticTiming = diagnosticTimes.snapshot();
      const diagnosticReceiveTiming = diagnosticReceiveTimes.snapshot();
      const cancellationAcknowledgementTiming = cancellationAcknowledgementTimes.snapshot();
      return Object.freeze({
        kind: 'worker', mode, initialized, isShutdown, shutdownDraining, serviceGeneration,
        protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
        pendingCount: pending.size,
        cancelledAwaitingAcknowledgementCount: cancelledAwaitingAcknowledgement.size,
        fallbackOccurred: fallbackTransport !== null,
        fallbackReason,
        lastRecoveryFailure,
        observerFailureCount:
          counts.schedulerObserverFailures + counts.pipelineObserverFailures,
        lastObserverFailure,
        observerCircuitBreakers: Object.freeze({
          scheduler: schedulerObserverDisabled,
          pipeline: pipelineObserverDisabled,
        }),
        timingSampleCapacity: TRANSPORT_TIMING_SAMPLE_CAPACITY,
        timingSampleCount: generationTiming.sampleCount,
        generationMsP50: generationTiming.p50,
        generationMsMaximum: generationTiming.max,
        mainThreadReceiveMsP50: receiveTiming.p50,
        mainThreadReceiveMsMaximum: receiveTiming.max,
        forestHorizonGenerationMsP50: forestHorizonGenerationTiming.p50,
        forestHorizonGenerationMsMaximum: forestHorizonGenerationTiming.max,
        forestHorizonReceiveMsMaximum: forestHorizonReceiveTiming.max,
        presentationOwnerGenerationMsP50: presentationOwnerGenerationTiming.p50,
        presentationOwnerGenerationMsMaximum: presentationOwnerGenerationTiming.max,
        presentationOwnerReceiveMsMaximum: presentationOwnerReceiveTiming.max,
        canonicalTreeCellGenerationMsP50: canonicalTreeCellGenerationTiming.p50,
        canonicalTreeCellGenerationMsMaximum: canonicalTreeCellGenerationTiming.max,
        canonicalTreeCellReceiveMsMaximum: canonicalTreeCellReceiveTiming.max,
        settlementQueryMsP50: settlementQueryTiming.p50,
        settlementQueryMsMaximum: settlementQueryTiming.max,
        settlementQueryReceiveMsMaximum: settlementQueryReceiveTiming.max,
        settlementTemplateMsP50: settlementTemplateTiming.p50,
        settlementTemplateMsMaximum: settlementTemplateTiming.max,
        settlementTemplateReceiveMsMaximum: settlementTemplateReceiveTiming.max,
        canonicalMajorRoadOwnerQueryMsP50: canonicalMajorRoadOwnerQueryTiming.p50,
        canonicalMajorRoadOwnerQueryMsMaximum: canonicalMajorRoadOwnerQueryTiming.max,
        canonicalMajorRoadOwnerQueryReceiveMsMaximum:
          canonicalMajorRoadOwnerQueryReceiveTiming.max,
        diagnosticMsP50: diagnosticTiming.p50,
        diagnosticMsMaximum: diagnosticTiming.max,
        diagnosticReceiveMsMaximum: diagnosticReceiveTiming.max,
        cancellationAcknowledgementMsP50: cancellationAcknowledgementTiming.p50,
        cancellationAcknowledgementMsP95: cancellationAcknowledgementTiming.p95,
        cancellationAcknowledgementMsMaximum: cancellationAcknowledgementTiming.max,
        generatorSnapshot: lastGeneratorSnapshot,
        workerSchedulerSnapshot: lastWorkerSchedulerSnapshot,
        counts: Object.freeze({ ...counts }),
      });
    },
    get metadata() { return metadata; },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shutdownDraining = true;
      isShutdown = true;
      mode = 'shutdown-draining';
      const shutdownFailure = new Error('Worker ChunkData transport shut down before response');
      initializeReject?.(shutdownFailure);
      shutdownPromise = (async () => {
        const cancellationErrors = [];
        for (const requestId of [...pending.keys()]) {
          try {
            cancelPendingWorkerRequest({ requestId, reason: 'transport-shutdown' });
          } catch (error) {
            cancellationErrors.push(error);
          }
        }
        let drained = pending.size === 0 && cancelledAwaitingAcknowledgement.size === 0;
        if (!drained && cancellationErrors.length === 0) {
          let timeoutId = null;
          drained = await Promise.race([
            new Promise(resolve => {
              drainResolve = resolve;
              resolveDrainIfIdle();
            }),
            new Promise(resolve => {
              timeoutId = globalThis.setTimeout?.(
                () => resolve(false),
                shutdownDrainTimeoutMs,
              ) ?? null;
              if (timeoutId === null) resolve(false);
            }),
          ]);
          if (timeoutId !== null) globalThis.clearTimeout?.(timeoutId);
        }
        if (!drained) {
          counts.shutdownDrainTimeouts += 1;
          rejectPending(cancellationErrors.length > 0
            ? new AggregateError(
              [shutdownFailure, ...cancellationErrors],
              'Worker cancellation dispatch failed during shutdown',
            )
            : shutdownFailure);
        }
        const cleanupResults = await Promise.allSettled([
          terminateWorker(),
          fallbackTransport?.shutdown?.(),
        ]);
        shutdownDraining = false;
        mode = 'shutdown';
        lastGeneratorSnapshot = null;
        lastWorkerSchedulerSnapshot = null;
        forestHorizonCancelledBeforeEpoch.clear();
        for (const series of [
          generationTimes,
          receiveTimes,
          forestHorizonGenerationTimes,
          forestHorizonReceiveTimes,
          presentationOwnerGenerationTimes,
          presentationOwnerReceiveTimes,
          canonicalTreeCellGenerationTimes,
          canonicalTreeCellReceiveTimes,
          settlementQueryTimes,
          settlementQueryReceiveTimes,
          settlementTemplateTimes,
          settlementTemplateReceiveTimes,
          canonicalMajorRoadOwnerQueryTimes,
          canonicalMajorRoadOwnerQueryReceiveTimes,
          diagnosticTimes,
          diagnosticReceiveTimes,
          cancellationAcknowledgementTimes,
        ]) series.reset();
        const cleanupErrors = cleanupResults
          .filter(result => result.status === 'rejected')
          .map(result => result.reason);
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, 'Worker transport shutdown cleanup failed');
        }
        return drained;
      })();
      return shutdownPromise;
    },
  });
}

function stableMetadataIdentity(metadata) {
  const normalize = value => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  };
  return JSON.stringify(normalize(metadata));
}

function sumTransportCounts(left, right) {
  const keys = new Set([
    ...Object.keys(left ?? {}),
    ...Object.keys(right ?? {}),
  ]);
  return Object.freeze(Object.fromEntries([...keys].map(key => [
    key,
    (Number(left?.[key]) || 0) + (Number(right?.[key]) || 0),
  ])));
}

/**
 * Exactly two independently scheduled Workers. Full ChunkData is always sent
 * to Critical (including optional future-Full prefetch); every coarse/control
 * resource is always sent to Background. This fixed routing intentionally
 * exposes no pool size or arbitrary lane selection.
 */
export function createFixedLaneWorkerChunkGeneratorTransport({
  workerFactory = null,
  fallbackTransportFactory = null,
  onSchedulerEvent = null,
  onPipelineEvent = null,
  ...sharedOptions
} = {}) {
  if (workerFactory !== null && typeof workerFactory !== 'function') {
    throw new TypeError('fixed-lane workerFactory must be a function when provided');
  }
  if (fallbackTransportFactory !== null && typeof fallbackTransportFactory !== 'function') {
    throw new TypeError('fixed-lane fallbackTransportFactory must be a function when provided');
  }
  if (onSchedulerEvent !== null && typeof onSchedulerEvent !== 'function') {
    throw new TypeError('fixed-lane onSchedulerEvent must be a function when provided');
  }
  if (onPipelineEvent !== null && typeof onPipelineEvent !== 'function') {
    throw new TypeError('fixed-lane onPipelineEvent must be a function when provided');
  }

  let isShutdown = false;
  let initializationPromise = null;
  let shutdownPromise = null;
  let metadata = null;
  let lastCombinedDiagnostics = null;
  const createLane = lane => createWorkerChunkGeneratorTransport({
    ...sharedOptions,
    ...(workerFactory ? { workerFactory: () => workerFactory({ lane }) } : {}),
    ...(fallbackTransportFactory ? {
      fallbackTransportFactory: () => fallbackTransportFactory({ lane }),
    } : {}),
    ...(onSchedulerEvent ? {
      onSchedulerEvent: event => onSchedulerEvent(Object.freeze({ ...event, lane })),
    } : {}),
    ...(onPipelineEvent ? {
      onPipelineEvent: (type, details) => onPipelineEvent(
        type,
        Object.freeze({ ...details, lane }),
      ),
    } : {}),
  });
  const critical = createLane(WORKER_GENERATION_LANE.CRITICAL);
  const background = createLane(WORKER_GENERATION_LANE.BACKGROUND);

  const failLaneMetadataIdentity = async (criticalMetadata, backgroundMetadata) => {
    await shutdown();
    throw new Error(
      `Critical/Background Worker metadata identity mismatch: ${
        stableMetadataIdentity(criticalMetadata)}:${stableMetadataIdentity(backgroundMetadata)}`,
    );
  };
  const refreshLaneMetadataIdentity = async () => {
    const [criticalMetadata, backgroundMetadata] = await Promise.all([
      critical.initialize(),
      background.initialize(),
    ]);
    if (stableMetadataIdentity(criticalMetadata) !== stableMetadataIdentity(backgroundMetadata)) {
      return failLaneMetadataIdentity(criticalMetadata, backgroundMetadata);
    }
    metadata = criticalMetadata;
    return metadata;
  };

  const initialize = () => {
    if (isShutdown) return Promise.reject(new Error('Fixed-lane Worker transport is shut down'));
    if (initializationPromise) return initializationPromise;
    initializationPromise = (async () => {
      let criticalMetadata;
      let backgroundMetadata;
      try {
        [criticalMetadata, backgroundMetadata] = await Promise.all([
          critical.initialize(),
          background.initialize(),
        ]);
      } catch (error) {
        await shutdown();
        throw error;
      }
      if (stableMetadataIdentity(criticalMetadata) !== stableMetadataIdentity(backgroundMetadata)) {
        return failLaneMetadataIdentity(criticalMetadata, backgroundMetadata);
      }
      metadata = criticalMetadata;
      return metadata;
    })();
    return initializationPromise;
  };
  const laneFromOptions = options => options?.lane === WORKER_GENERATION_LANE.CRITICAL
    ? critical : options?.lane === WORKER_GENERATION_LANE.BACKGROUND
      ? background : null;
  const cancelBySchedulerRequestId = options => {
    const lane = laneFromOptions(options);
    if (lane) return lane.cancelGenerationRequestBySchedulerRequestId(options);
    const criticalCancelled = critical.cancelGenerationRequestBySchedulerRequestId(options);
    const backgroundCancelled = background.cancelGenerationRequestBySchedulerRequestId(options);
    return criticalCancelled || backgroundCancelled;
  };
  const runOnLane = async (lane, operation) => {
    await initialize();
    await refreshLaneMetadataIdentity();
    const result = await operation(lane);
    await refreshLaneMetadataIdentity();
    return result;
  };
  const requestDiagnostics = async options => {
    await initialize();
    await refreshLaneMetadataIdentity();
    const [criticalDiagnostics, backgroundDiagnostics] = await Promise.all([
      critical.requestDiagnostics(options),
      background.requestDiagnostics(options),
    ]);
    await refreshLaneMetadataIdentity();
    lastCombinedDiagnostics = Object.freeze({
      ...(backgroundDiagnostics ?? {}),
      fixedWorkerLanes: Object.freeze({
        schemaVersion: FIXED_WORKER_LANE_TRANSPORT_SCHEMA,
        critical: criticalDiagnostics,
        background: backgroundDiagnostics,
      }),
    });
    return lastCombinedDiagnostics;
  };
  const snapshot = () => {
    const criticalSnapshot = critical.snapshot();
    const backgroundSnapshot = background.snapshot();
    const modes = new Set([criticalSnapshot.mode, backgroundSnapshot.mode]);
    return Object.freeze({
      ...backgroundSnapshot,
      kind: 'worker-fixed-lanes',
      schemaVersion: FIXED_WORKER_LANE_TRANSPORT_SCHEMA,
      mode: modes.size === 1 ? criticalSnapshot.mode : 'mixed',
      initialized: criticalSnapshot.initialized && backgroundSnapshot.initialized,
      isShutdown,
      pendingCount: criticalSnapshot.pendingCount + backgroundSnapshot.pendingCount,
      cancelledAwaitingAcknowledgementCount:
        criticalSnapshot.cancelledAwaitingAcknowledgementCount
          + backgroundSnapshot.cancelledAwaitingAcknowledgementCount,
      fallbackOccurred:
        criticalSnapshot.fallbackOccurred || backgroundSnapshot.fallbackOccurred,
      metadataIdentityConsistent: stableMetadataIdentity(critical.metadata)
        === stableMetadataIdentity(background.metadata),
      timingSampleCount:
        criticalSnapshot.timingSampleCount + backgroundSnapshot.timingSampleCount,
      generationMsP50: criticalSnapshot.generationMsP50,
      generationMsMaximum: criticalSnapshot.generationMsMaximum,
      mainThreadReceiveMsP50: criticalSnapshot.mainThreadReceiveMsP50,
      mainThreadReceiveMsMaximum: criticalSnapshot.mainThreadReceiveMsMaximum,
      cancellationAcknowledgementMsP50: Math.max(
        criticalSnapshot.cancellationAcknowledgementMsP50 ?? 0,
        backgroundSnapshot.cancellationAcknowledgementMsP50 ?? 0,
      ),
      cancellationAcknowledgementMsP95: Math.max(
        criticalSnapshot.cancellationAcknowledgementMsP95 ?? 0,
        backgroundSnapshot.cancellationAcknowledgementMsP95 ?? 0,
      ),
      cancellationAcknowledgementMsMaximum: Math.max(
        criticalSnapshot.cancellationAcknowledgementMsMaximum ?? 0,
        backgroundSnapshot.cancellationAcknowledgementMsMaximum ?? 0,
      ),
      generatorSnapshot: lastCombinedDiagnostics,
      workerSchedulerSnapshot: Object.freeze({
        schemaVersion: FIXED_WORKER_LANE_TRANSPORT_SCHEMA,
        critical: criticalSnapshot.workerSchedulerSnapshot,
        background: backgroundSnapshot.workerSchedulerSnapshot,
      }),
      counts: sumTransportCounts(criticalSnapshot.counts, backgroundSnapshot.counts),
      lanes: Object.freeze({
        [WORKER_GENERATION_LANE.CRITICAL]: criticalSnapshot,
        [WORKER_GENERATION_LANE.BACKGROUND]: backgroundSnapshot,
      }),
    });
  };
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    isShutdown = true;
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([critical.shutdown(), background.shutdown()]);
      lastCombinedDiagnostics = null;
      const failures = results.filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Fixed-lane Worker shutdown failed');
      }
      return results.every(result => result.value !== false);
    })();
    return shutdownPromise;
  };

  return Object.freeze({
    initialize,
    generateChunk: request => runOnLane(
      critical,
      lane => lane.generateChunk(request),
    ),
    generateForestHorizonManifest: request => runOnLane(
      background,
      lane => lane.generateForestHorizonManifest(request),
    ),
    generatePresentationOwner: request => runOnLane(
      background,
      lane => lane.generatePresentationOwner(request),
    ),
    generateCanonicalTreeCell: request => runOnLane(
      background,
      lane => lane.generateCanonicalTreeCell(request),
    ),
    cancelForestHorizonRequests: options => background.cancelForestHorizonRequests(options),
    cancelGenerationRequest: options => critical.cancelGenerationRequest(options),
    cancelGenerationRequestBySchedulerRequestId: cancelBySchedulerRequestId,
    findSettlementsNear: (...args) => runOnLane(
      background,
      lane => lane.findSettlementsNear(...args),
    ),
    resolveSettlementPresentationTemplate: request => runOnLane(
      background,
      lane => lane.resolveSettlementPresentationTemplate(request),
    ),
    resolveCanonicalMajorRoadOwnerCoverage: request => runOnLane(
      background,
      lane => lane.resolveCanonicalMajorRoadOwnerCoverage(request),
    ),
    requestDiagnostics,
    snapshot,
    shutdown,
    get metadata() { return metadata; },
  });
}
