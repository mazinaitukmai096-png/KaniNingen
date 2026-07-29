import {
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
  createChunkGeneratorInitializeRequest,
  createChunkGeneratorRequest,
} from './chunk-data-service-protocol.js';

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
  let controlRequestId = 1_000_000_000;
  const pending = new Map();
  const removers = [];
  const generationTimes = [];
  const receiveTimes = [];
  const settlementQueryTimes = [];
  const settlementQueryReceiveTimes = [];
  const settlementTemplateTimes = [];
  const settlementTemplateReceiveTimes = [];
  const counts = {
    generated: 0,
    settlementQueries: 0,
    settlementTemplateQueries: 0,
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
      lastGeneratorSnapshot = metadata?.generatorSnapshot ?? null;
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
    lastGeneratorSnapshot = message.generatorSnapshot ?? lastGeneratorSnapshot;
    if (message.type === CHUNK_GENERATOR_MESSAGE.GENERATED) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const generationMs = Math.max(0, Number(message.generationMs) || 0);
      generationTimes.push(generationMs);
      receiveTimes.push(Math.max(0, receivedMs - generationMs));
      counts.generated += 1;
      operation.resolve(message.chunkData);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.SETTLEMENTS) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const operationMs = Math.max(0, Number(message.operationMs) || 0);
      settlementQueryTimes.push(operationMs);
      settlementQueryReceiveTimes.push(Math.max(0, receivedMs - operationMs));
      counts.settlementQueries += 1;
      operation.resolve(message.settlements);
      return;
    }
    if (message.type === CHUNK_GENERATOR_MESSAGE.SETTLEMENT_TEMPLATE) {
      const receivedMs = Math.max(0, clock() - operation.sentAt);
      const operationMs = Math.max(0, Number(message.operationMs) || 0);
      settlementTemplateTimes.push(operationMs);
      settlementTemplateReceiveTimes.push(Math.max(0, receivedMs - operationMs));
      counts.settlementTemplateQueries += 1;
      operation.resolve(message.template);
    }
  };

  const onWorkerError = error => {
    counts.workerErrors += 1;
    const normalized = error instanceof Error ? error : new Error(error?.message ?? 'Chunk generator Worker failed');
    if (!initialized) initializeReject?.(normalized);
    else rejectPending(normalized);
  };

  const activateFallback = async error => {
    if (fallbackTransportFactory === null) throw error;
    await terminateWorker();
    fallbackReason = Object.freeze({ name: error?.name ?? 'Error', message: error?.message ?? String(error) });
    fallbackTransport = await fallbackTransportFactory();
    if (typeof fallbackTransport?.generateChunk !== 'function') {
      throw new TypeError('fallback transport must provide generateChunk');
    }
    metadata = await fallbackTransport.initialize?.() ?? null;
    lastGeneratorSnapshot = metadata?.generatorSnapshot ?? null;
    mode = 'inline-fallback';
    initialized = true;
    counts.fallbackCount += 1;
    return metadata;
  };

  const initialize = () => {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      if (isShutdown) throw new Error('Worker ChunkData transport is shut down');
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
    pending.set(request.requestId, { resolve, reject, sentAt: clock() });
    worker.postMessage(request);
  });

  return Object.freeze({
    initialize,
    async generateChunk({ requestId, chunkX, chunkZ, priority } = {}) {
      await initialize();
      if (isShutdown) throw new Error('Worker ChunkData transport is shut down');
      if (fallbackTransport) {
        return fallbackTransport.generateChunk({ requestId, chunkX, chunkZ, priority });
      }
      return requestWorker(createChunkGeneratorRequest({
        requestId, serviceGeneration, chunkX, chunkZ,
      }));
    },
    async findSettlementsNear(centerWorldX, centerWorldZ, radiusMeters) {
      await initialize();
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
    snapshot() {
      const sortedGeneration = [...generationTimes].sort((a, b) => a - b);
      const sortedReceive = [...receiveTimes].sort((a, b) => a - b);
      const sortedSettlementQuery = [...settlementQueryTimes].sort((a, b) => a - b);
      const sortedSettlementQueryReceive = [...settlementQueryReceiveTimes].sort((a, b) => a - b);
      const sortedSettlementTemplate = [...settlementTemplateTimes].sort((a, b) => a - b);
      const sortedSettlementTemplateReceive = [...settlementTemplateReceiveTimes].sort((a, b) => a - b);
      const median = values => values.length ? values[Math.floor((values.length - 1) * 0.5)] : 0;
      return Object.freeze({
        kind: 'worker', mode, initialized, isShutdown, serviceGeneration,
        protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
        pendingCount: pending.size,
        fallbackOccurred: fallbackTransport !== null,
        fallbackReason,
        generationMsP50: median(sortedGeneration),
        generationMsMaximum: sortedGeneration.at(-1) ?? 0,
        mainThreadReceiveMsP50: median(sortedReceive),
        mainThreadReceiveMsMaximum: sortedReceive.at(-1) ?? 0,
        settlementQueryMsP50: median(sortedSettlementQuery),
        settlementQueryMsMaximum: sortedSettlementQuery.at(-1) ?? 0,
        settlementQueryReceiveMsMaximum: sortedSettlementQueryReceive.at(-1) ?? 0,
        settlementTemplateMsP50: median(sortedSettlementTemplate),
        settlementTemplateMsMaximum: sortedSettlementTemplate.at(-1) ?? 0,
        settlementTemplateReceiveMsMaximum: sortedSettlementTemplateReceive.at(-1) ?? 0,
        generatorSnapshot: fallbackTransport?.snapshot?.().generatorSnapshot ?? lastGeneratorSnapshot,
        counts: Object.freeze({ ...counts }),
      });
    },
    get metadata() { return metadata; },
    async shutdown() {
      if (isShutdown) return;
      isShutdown = true;
      rejectPending(new Error('Worker ChunkData transport shut down before response'));
      await fallbackTransport?.shutdown?.();
      await terminateWorker();
    },
  });
}
