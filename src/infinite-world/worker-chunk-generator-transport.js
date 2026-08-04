import {
  CHUNK_DATA_PRIORITY,
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
  createChunkGeneratorCancelRequest,
  createChunkGeneratorInitializeRequest,
  createChunkGeneratorRequest,
  createChunkGeneratorSchedulerEnvelope,
  createForestHorizonGeneratorRequest,
} from './chunk-data-service-protocol.js';
import { createW8ForestHorizonManifest } from './forest-horizon-manifest.js';
import { MetricSeries } from './runtime-timing.js';

const TRANSPORT_TIMING_SAMPLE_CAPACITY = 4096;

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
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

export function createWorkerChunkGeneratorTransport({
  worldSeed,
  settlementRoadGraphGeneratorId = null,
  serviceGeneration = 1,
  workerFactory = () => browserWorkerFactory(globalThis),
  fallbackTransportFactory = null,
  clock = defaultClock,
  onSchedulerEvent = null,
  onPipelineEvent = null,
} = {}) {
  if (typeof worldSeed !== 'string' || !worldSeed) throw new TypeError('worldSeed is required');
  if (settlementRoadGraphGeneratorId !== null
    && (typeof settlementRoadGraphGeneratorId !== 'string' || !settlementRoadGraphGeneratorId)) {
    throw new TypeError('settlementRoadGraphGeneratorId must be a non-empty string when provided');
  }
  if (!Number.isSafeInteger(serviceGeneration) || serviceGeneration < 1) {
    throw new RangeError('serviceGeneration must be a positive safe integer');
  }
  if (typeof workerFactory !== 'function') throw new TypeError('workerFactory is required');
  if (fallbackTransportFactory !== null && typeof fallbackTransportFactory !== 'function') {
    throw new TypeError('fallbackTransportFactory must be a function when provided');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
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
  let metadata = null;
  let initializeResolve = null;
  let initializeReject = null;
  let initializePromise = null;
  let fallbackActivationPromise = null;
  let recoveryPromise = null;
  let runtimeFailure = null;
  let controlRequestId = 1_000_000_000;
  const pending = new Map();
  const pipelineReceipts = onPipelineEvent ? new Map() : null;
  const forestHorizonCancelledBeforeEpoch = new Map();
  const removers = [];
  const generationTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const receiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const forestHorizonGenerationTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const forestHorizonReceiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const settlementQueryTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const settlementQueryReceiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const settlementTemplateTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const settlementTemplateReceiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const diagnosticTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const diagnosticReceiveTimes = new MetricSeries(TRANSPORT_TIMING_SAMPLE_CAPACITY);
  const counts = {
    generated: 0,
    forestHorizonGenerated: 0,
    settlementQueries: 0,
    settlementTemplateQueries: 0,
    diagnosticQueries: 0,
    staleGenerationResponses: 0,
    lateResponses: 0,
    pipelineTimingMessages: 0,
    pipelineTimingOrphans: 0,
    workerErrors: 0,
    fallbackCount: 0,
  };
  let fallbackReason = null;
  let lastGeneratorSnapshot = null;
  let lastWorkerSchedulerSnapshot = null;
  const mainTimeOriginMs = Number.isFinite(globalThis.performance?.timeOrigin)
    ? globalThis.performance.timeOrigin : Date.now() - clock();

  const emitSchedulerEvent = event => {
    if (!onSchedulerEvent) return;
    try { onSchedulerEvent(Object.freeze(event)); } catch { /* diagnostics are isolated */ }
  };
  const emitPipelineEvent = (type, details) => {
    if (!onPipelineEvent) return;
    try { onPipelineEvent(type, details); } catch { /* diagnostics are isolated */ }
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
    pipelineReceipts?.clear();
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
    if (isShutdown) {
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
    const operation = pending.get(message.requestId);
    if (!operation) {
      counts.lateResponses += 1;
      emitPipelineEvent('worker-late-response', {
        requestId: message.requestId,
        ownerKey: message.chunkKey ?? null,
        responseType: message.type,
        receivedAtMs,
      });
      return;
    }
    const operationKind = operation.request.scheduler?.operationKind ?? null;
    const ownerKey = message.chunkKey
      ?? (Number.isSafeInteger(operation.request.chunkX)
        && Number.isSafeInteger(operation.request.chunkZ)
        ? `${operation.request.chunkX},${operation.request.chunkZ}` : null);
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
        void recoveryPromise.catch(() => {});
      }
    }
  };

  const activateFallback = async error => {
    if (fallbackTransportFactory === null) throw error;
    if (fallbackActivationPromise) return fallbackActivationPromise;
    fallbackActivationPromise = (async () => {
      await terminateWorker();
      if (isShutdown) throw shutdownError();
      const candidate = await fallbackTransportFactory();
      if (isShutdown) {
        await candidate?.shutdown?.();
        throw shutdownError();
      }
      if (typeof candidate?.generateChunk !== 'function') {
        await candidate?.shutdown?.();
        throw new TypeError('fallback transport must provide generateChunk');
      }
      const candidateMetadata = await candidate.initialize?.() ?? null;
      if (isShutdown) {
        await candidate.shutdown?.();
        throw shutdownError();
      }
      fallbackReason = Object.freeze({ name: error?.name ?? 'Error', message: error?.message ?? String(error) });
      fallbackTransport = candidate;
      metadata = candidateMetadata;
      lastGeneratorSnapshot = null;
      lastWorkerSchedulerSnapshot = null;
      pipelineReceipts?.clear();
      runtimeFailure = null;
      mode = 'inline-fallback';
      initialized = true;
      counts.fallbackCount += 1;
      return metadata;
    })();
    void fallbackActivationPromise.catch(() => {});
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

  const requestWorker = request => new Promise((resolve, reject) => {
    const target = worker;
    if (!target) {
      reject(isShutdown
        ? new Error('Worker ChunkData transport shut down before response')
        : runtimeFailure ?? new Error('Chunk generator Worker is unavailable'));
      return;
    }
    const sentAt = clock();
    pending.set(request.requestId, { resolve, reject, sentAt, request });
    emitSchedulerEvent({
      type: 'queued',
      envelope: request.scheduler ?? null,
      state: 'queued',
      queuedAtMs: request.scheduler?.createdAtMs ?? clock(),
      backlog: pending.size,
    });
    try {
      const postStartedAtMs = clock();
      target.postMessage(request);
      emitPipelineEvent('worker-message-sent', {
        ownerKey: Number.isSafeInteger(request.chunkX) && Number.isSafeInteger(request.chunkZ)
          ? `${request.chunkX},${request.chunkZ}` : null,
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
        pending.delete(requestId);
        emitSchedulerEvent({
          type: 'terminal',
          envelope: request.scheduler ?? null,
          state: 'cancelled',
          terminalAtMs: clock(),
          cancellationReason: 'stale-forest-horizon-epoch',
          backlog: pending.size,
        });
        operation.resolve(null);
        cancelled += 1;
      }
      if (worker && !isShutdown) {
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
      const operation = pending.get(requestId);
      let cancelled = false;
      if (operation) {
        pending.delete(requestId);
        emitSchedulerEvent({
          type: 'terminal',
          envelope: operation.request.scheduler ?? null,
          state: 'cancelled',
          terminalAtMs: clock(),
          cancellationReason: reason,
          backlog: pending.size,
        });
        operation.resolve(null);
        cancelled = true;
      }
      if (fallbackTransport?.cancelGenerationRequest?.({ requestId, reason })) cancelled = true;
      if (worker && !isShutdown) {
        worker.postMessage(createChunkGeneratorCancelRequest({
          requestId,
          serviceGeneration,
          reason,
        }));
      }
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
      const settlementQueryTiming = settlementQueryTimes.snapshot();
      const settlementQueryReceiveTiming = settlementQueryReceiveTimes.snapshot();
      const settlementTemplateTiming = settlementTemplateTimes.snapshot();
      const settlementTemplateReceiveTiming = settlementTemplateReceiveTimes.snapshot();
      const diagnosticTiming = diagnosticTimes.snapshot();
      const diagnosticReceiveTiming = diagnosticReceiveTimes.snapshot();
      return Object.freeze({
        kind: 'worker', mode, initialized, isShutdown, serviceGeneration,
        protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
        pendingCount: pending.size,
        fallbackOccurred: fallbackTransport !== null,
        fallbackReason,
        timingSampleCapacity: TRANSPORT_TIMING_SAMPLE_CAPACITY,
        timingSampleCount: generationTiming.sampleCount,
        generationMsP50: generationTiming.p50,
        generationMsMaximum: generationTiming.max,
        mainThreadReceiveMsP50: receiveTiming.p50,
        mainThreadReceiveMsMaximum: receiveTiming.max,
        forestHorizonGenerationMsP50: forestHorizonGenerationTiming.p50,
        forestHorizonGenerationMsMaximum: forestHorizonGenerationTiming.max,
        forestHorizonReceiveMsMaximum: forestHorizonReceiveTiming.max,
        settlementQueryMsP50: settlementQueryTiming.p50,
        settlementQueryMsMaximum: settlementQueryTiming.max,
        settlementQueryReceiveMsMaximum: settlementQueryReceiveTiming.max,
        settlementTemplateMsP50: settlementTemplateTiming.p50,
        settlementTemplateMsMaximum: settlementTemplateTiming.max,
        settlementTemplateReceiveMsMaximum: settlementTemplateReceiveTiming.max,
        diagnosticMsP50: diagnosticTiming.p50,
        diagnosticMsMaximum: diagnosticTiming.max,
        diagnosticReceiveMsMaximum: diagnosticReceiveTiming.max,
        generatorSnapshot: lastGeneratorSnapshot,
        workerSchedulerSnapshot: lastWorkerSchedulerSnapshot,
        counts: Object.freeze({ ...counts }),
      });
    },
    get metadata() { return metadata; },
    async shutdown() {
      if (isShutdown) return;
      isShutdown = true;
      mode = 'shutdown';
      const error = new Error('Worker ChunkData transport shut down before response');
      initializeReject?.(error);
      rejectPending(error);
      await terminateWorker();
      await fallbackTransport?.shutdown?.();
      lastGeneratorSnapshot = null;
      lastWorkerSchedulerSnapshot = null;
      forestHorizonCancelledBeforeEpoch.clear();
      for (const series of [
        generationTimes,
        receiveTimes,
        forestHorizonGenerationTimes,
        forestHorizonReceiveTimes,
        settlementQueryTimes,
        settlementQueryReceiveTimes,
        settlementTemplateTimes,
        settlementTemplateReceiveTimes,
        diagnosticTimes,
        diagnosticReceiveTimes,
      ]) series.reset();
    },
  });
}
