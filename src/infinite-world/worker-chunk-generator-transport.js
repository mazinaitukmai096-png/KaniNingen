import {
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
  createChunkGeneratorInitializeRequest,
  createChunkGeneratorRequest,
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
  serviceGeneration = 1,
  workerFactory = () => browserWorkerFactory(globalThis),
  fallbackTransportFactory = null,
  clock = defaultClock,
} = {}) {
  if (typeof worldSeed !== 'string' || !worldSeed) throw new TypeError('worldSeed is required');
  if (!Number.isSafeInteger(serviceGeneration) || serviceGeneration < 1) {
    throw new RangeError('serviceGeneration must be a positive safe integer');
  }
  if (typeof workerFactory !== 'function') throw new TypeError('workerFactory is required');
  if (fallbackTransportFactory !== null && typeof fallbackTransportFactory !== 'function') {
    throw new TypeError('fallbackTransportFactory must be a function when provided');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

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
    workerErrors: 0,
    fallbackCount: 0,
  };
  let fallbackReason = null;
  let lastGeneratorSnapshot = null;

  const terminateWorker = async () => {
    for (const remove of removers.splice(0)) remove();
    const target = worker;
    worker = null;
    if (target) await target.terminate?.();
  };

  const rejectPending = error => {
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
  };

  const shutdownError = () => new Error('Worker ChunkData transport is shut down');

  const onMessage = event => {
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
    const operation = pending.get(message.requestId);
    if (!operation) {
      counts.lateResponses += 1;
      return;
    }
    pending.delete(message.requestId);
    if (message.type === CHUNK_GENERATOR_MESSAGE.ERROR) {
      operation.reject(transportError(message));
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.GENERATED) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const generationMs = Math.max(0, Number(message.generationMs) || 0);
      generationTimes.record(generationMs);
      receiveTimes.record(Math.max(0, receivedMs - generationMs));
      counts.generated += 1;
      operation.resolve(message.chunkData);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.GENERATED_FOREST_HORIZON) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const generationMs = Math.max(0, Number(message.generationMs) || 0);
      forestHorizonGenerationTimes.record(generationMs);
      forestHorizonReceiveTimes.record(Math.max(0, receivedMs - generationMs));
      counts.forestHorizonGenerated += 1;
      operation.resolve(message.manifest);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.SETTLEMENTS) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const operationMs = Math.max(0, Number(message.operationMs) || 0);
      settlementQueryTimes.record(operationMs);
      settlementQueryReceiveTimes.record(Math.max(0, receivedMs - operationMs));
      counts.settlementQueries += 1;
      operation.resolve(message.settlements);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.SETTLEMENT_TEMPLATE) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const operationMs = Math.max(0, Number(message.operationMs) || 0);
      settlementTemplateTimes.record(operationMs);
      settlementTemplateReceiveTimes.record(Math.max(0, receivedMs - operationMs));
      counts.settlementTemplateQueries += 1;
      operation.resolve(message.template);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.DIAGNOSTICS) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const operationMs = Math.max(0, Number(message.operationMs) || 0);
      diagnosticTimes.record(operationMs);
      diagnosticReceiveTimes.record(Math.max(0, receivedMs - operationMs));
      counts.diagnosticQueries += 1;
      lastGeneratorSnapshot = message.generatorSnapshot ?? null;
      operation.resolve(lastGeneratorSnapshot);
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
        worker.postMessage(createChunkGeneratorInitializeRequest({ serviceGeneration, worldSeed }));
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
    pending.set(request.requestId, { resolve, reject, sentAt: clock(), request });
    try {
      target.postMessage(request);
    } catch (error) {
      pending.delete(request.requestId);
      reject(error);
    }
  });

  return Object.freeze({
    initialize,
    async generateChunk({ requestId, chunkX, chunkZ, priority } = {}) {
      await initialize();
      if (isShutdown) throw shutdownError();
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        return fallbackTransport.generateChunk({ requestId, chunkX, chunkZ, priority });
      }
      return requestWorker(createChunkGeneratorRequest({
        requestId, serviceGeneration, chunkX, chunkZ,
      }));
    },
    async generateForestHorizonManifest({
      chunkX,
      chunkZ,
      consumerId = 'distant-owner-query',
      epoch = 0,
    } = {}) {
      if (epoch < (forestHorizonCancelledBeforeEpoch.get(consumerId) ?? 0)) return null;
      await initialize();
      if (isShutdown) throw shutdownError();
      if (epoch < (forestHorizonCancelledBeforeEpoch.get(consumerId) ?? 0)) return null;
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        if (typeof fallbackTransport.generateForestHorizonManifest === 'function') {
          return fallbackTransport.generateForestHorizonManifest({
            chunkX, chunkZ, consumerId, epoch,
          });
        }
        return createW8ForestHorizonManifest(await fallbackTransport.generateChunk({
          requestId: ++controlRequestId,
          chunkX,
          chunkZ,
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
      return cancelled;
    },
    async findSettlementsNear(centerWorldX, centerWorldZ, radiusMeters) {
      await initialize();
      if (isShutdown) throw shutdownError();
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        return fallbackTransport.findSettlementsNear(centerWorldX, centerWorldZ, radiusMeters);
      }
      const requestId = ++controlRequestId;
      return requestWorker({
        type: CHUNK_GENERATOR_MESSAGE.FIND_SETTLEMENTS,
        protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
        requestId,
        serviceGeneration,
        centerWorldX,
        centerWorldZ,
        radiusMeters,
      });
    },
    async resolveSettlementPresentationTemplate({ candidate } = {}) {
      await initialize();
      if (isShutdown) throw shutdownError();
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        return fallbackTransport.resolveSettlementPresentationTemplate({ candidate });
      }
      const requestId = ++controlRequestId;
      return requestWorker({
        type: CHUNK_GENERATOR_MESSAGE.RESOLVE_SETTLEMENT_TEMPLATE,
        protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
        requestId,
        serviceGeneration,
        candidate,
      });
    },
    async requestDiagnostics() {
      await initialize();
      if (isShutdown) throw shutdownError();
      if (runtimeFailure && !fallbackTransport) throw runtimeFailure;
      if (fallbackTransport) {
        if (typeof fallbackTransport.requestDiagnostics !== 'function') {
          throw new Error('fallback transport does not expose diagnostics');
        }
        lastGeneratorSnapshot = await fallbackTransport.requestDiagnostics();
        counts.diagnosticQueries += 1;
        return lastGeneratorSnapshot;
      }
      const requestId = ++controlRequestId;
      return requestWorker({
        type: CHUNK_GENERATOR_MESSAGE.REQUEST_DIAGNOSTICS,
        protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
        requestId,
        serviceGeneration,
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
