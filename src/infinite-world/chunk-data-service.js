import {
  assertChunkDataPriority,
  createChunkGeneratorSchedulerEnvelope,
  createChunkDataRequestKey,
  CHUNK_DATA_PRIORITY,
} from './chunk-data-service-protocol.js';
import { WORLD_STREAMING_EVENT } from './world-streaming-telemetry.js';
import {
  compareWorldGenerationRequests,
  describeWorldGenerationPriority,
} from './world-generation-scheduler.js';

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function scheduleMicrotask(callback) {
  if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(callback);
  else Promise.resolve().then(callback);
}

function identityOf(chunkData) {
  return Object.freeze({ chunkId: chunkData.chunkId, contentHash: chunkData.contentHash });
}

/**
 * The single owner of W8 ChunkData request scheduling.  Stage 2B-0 uses an
 * inline transport; Stage 2B-1 replaces only that transport with a Worker.
 */
export class ChunkDataService {
  constructor({
    transport,
    cacheCapacity = 81,
    identityAuditCapacity = 4096,
    clock = defaultClock,
    telemetry = null,
    agingIntervalMs = 250,
  } = {}) {
    if (typeof transport?.generateChunk !== 'function') {
      throw new TypeError('ChunkData transport.generateChunk is required');
    }
    if (!Number.isSafeInteger(cacheCapacity) || cacheCapacity < 1) {
      throw new RangeError('cacheCapacity must be a positive safe integer');
    }
    if (!Number.isSafeInteger(identityAuditCapacity) || identityAuditCapacity < cacheCapacity) {
      throw new RangeError('identityAuditCapacity must be at least cacheCapacity');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isFinite(agingIntervalMs) || agingIntervalMs <= 0) {
      throw new RangeError('agingIntervalMs must be positive');
    }
    this.transport = transport;
    this.cacheCapacity = cacheCapacity;
    this.identityAuditCapacity = identityAuditCapacity;
    this.clock = clock;
    this.telemetry = telemetry?.enabled === true ? telemetry : null;
    this.agingIntervalMs = agingIntervalMs;
    this.completed = new Map();
    this.identityAudit = new Map();
    this.pending = new Map();
    this.queue = [];
    this.consumerEpochs = new Map();
    this.sequence = 0;
    this.subscriberSequence = 0;
    this.dispatchScheduled = false;
    this.inFlight = null;
    this.initializePromise = null;
    this.metadata = null;
    this.isShutdown = false;
    this.counts = {
      requests: 0,
      completedCacheHits: 0,
      pendingDedupeHits: 0,
      dispatched: 0,
      transportCalls: 0,
      priorityPromotions: 0,
      subscriberCancels: 0,
      staleSubscriberResults: 0,
      completedEvictions: 0,
      identityAuditEvictions: 0,
      identityMismatchCount: 0,
      shutdownLateResultCount: 0,
      queuedOperationCancels: 0,
      inFlightOperationCancels: 0,
      completedOperations: 0,
      cancelledOperations: 0,
      failedOperations: 0,
      deadlineMisses: 0,
      agedDispatches: 0,
      priorityAgingSteps: 0,
      maximumBacklog: 0,
    };
  }

  initialize() {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = Promise.resolve(this.transport.initialize?.()).then(metadata => {
      this.metadata = metadata ?? null;
      return this.metadata;
    });
    return this.initializePromise;
  }

  requestChunk({
    chunkX,
    chunkZ,
    priority = CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
    consumerId = 'anonymous',
    epoch = 0,
    telemetryTarget = 'near',
    telemetryStream = telemetryTarget,
    telemetryCorrelationId: suppliedTelemetryCorrelationId = null,
    deadlineAtMs = null,
    required = priority <= CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
  } = {}) {
    const key = createChunkDataRequestKey(chunkX, chunkZ);
    assertChunkDataPriority(priority);
    if (typeof consumerId !== 'string' || !consumerId) throw new TypeError('consumerId is required');
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('epoch must be a non-negative safe integer');
    const createdAtMs = this.clock();
    const telemetryCorrelationId = suppliedTelemetryCorrelationId
      ?? this.telemetry?.beginRequest({
        target: telemetryTarget,
        stream: telemetryStream,
        resourceKey: key,
        ownerKey: key,
        requestId: `${consumerId}:${epoch}`,
        metadata: {
          consumerId, epoch, priority, required, deadlineAtMs,
          backlog: this.queue.length + (this.inFlight ? 1 : 0),
        },
      })
      ?? null;
    this.counts.requests += 1;
    if (this.isShutdown) {
      this.#recordTelemetry(WORLD_STREAMING_EVENT.CANCELLED, {
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        resourceKey: key,
        ownerKey: key,
        metadata: { reason: 'shutdown' },
      });
      return this.#cancelledHandle({ key, consumerId, epoch });
    }

    const knownEpoch = this.consumerEpochs.get(consumerId) ?? -1;
    if (epoch < knownEpoch) {
      this.#recordTelemetry(WORLD_STREAMING_EVENT.CANCELLED, {
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        resourceKey: key,
        ownerKey: key,
        metadata: { reason: 'stale-consumer-epoch', knownEpoch },
      });
      return this.#cancelledHandle({ key, consumerId, epoch });
    }
    if (epoch > knownEpoch) {
      this.consumerEpochs.set(consumerId, epoch);
      this.cancelConsumer({ consumerId, beforeEpoch: epoch });
    }

    const cached = this.#getCompleted(key);
    if (cached) {
      this.counts.completedCacheHits += 1;
      this.#recordTelemetry(WORLD_STREAMING_EVENT.CACHE_HIT, {
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        resourceKey: key,
        ownerKey: key,
        metadata: { cache: 'completed' },
      });
      return Object.freeze({
        key, consumerId, epoch, cancel: () => false, promise: Promise.resolve(cached),
      });
    }

    let entry = this.pending.get(key);
    if (!entry) {
      entry = {
        key, chunkX, chunkZ, priority, sequence: ++this.sequence,
        state: 'queued', subscribers: new Map(), telemetryCorrelationId,
        telemetryTarget, telemetryStream,
        createdAtMs,
        deadlineAtMs,
        required,
        cancelRequested: false,
      };
      entry.scheduler = this.#createSchedulerEnvelope(entry, consumerId, epoch);
      this.pending.set(key, entry);
      this.queue.push(entry);
      this.counts.maximumBacklog = Math.max(
        this.counts.maximumBacklog,
        this.queue.length + (this.inFlight ? 1 : 0),
      );
      this.#recordTelemetry(WORLD_STREAMING_EVENT.CACHE_MISS, {
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        resourceKey: key,
        ownerKey: key,
        metadata: { cache: 'completed-and-pending' },
      });
    } else {
      this.counts.pendingDedupeHits += 1;
      this.#recordTelemetry(WORLD_STREAMING_EVENT.CACHE_HIT, {
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        resourceKey: key,
        ownerKey: key,
        metadata: { cache: 'pending-dedupe' },
      });
      if (entry.state === 'queued' && priority < entry.priority) {
        entry.priority = priority;
        this.counts.priorityPromotions += 1;
      }
      if (entry.state === 'queued') {
        entry.required ||= required;
        if (deadlineAtMs !== null
          && (entry.deadlineAtMs === null || deadlineAtMs < entry.deadlineAtMs)) {
          entry.deadlineAtMs = deadlineAtMs;
        }
        entry.scheduler = this.#createSchedulerEnvelope(entry, consumerId, epoch);
      }
    }
    const handle = this.#subscribe(entry, {
      consumerId, epoch, telemetryCorrelationId, telemetryTarget, telemetryStream,
    });
    this.#scheduleDispatch();
    return handle;
  }

  cancelConsumer({ consumerId, epoch = null, beforeEpoch = null } = {}) {
    if (typeof consumerId !== 'string' || !consumerId) throw new TypeError('consumerId is required');
    if (epoch !== null && (!Number.isSafeInteger(epoch) || epoch < 0)) throw new RangeError('epoch must be valid');
    if (beforeEpoch !== null && (!Number.isSafeInteger(beforeEpoch) || beforeEpoch < 0)) throw new RangeError('beforeEpoch must be valid');
    let cancelled = 0;
    for (const entry of this.pending.values()) {
      for (const subscriber of [...entry.subscribers.values()]) {
        if (subscriber.consumerId !== consumerId) continue;
        if (epoch !== null && subscriber.epoch !== epoch) continue;
        if (beforeEpoch !== null && subscriber.epoch >= beforeEpoch) continue;
        if (this.#cancelSubscriber(entry, subscriber)) cancelled += 1;
      }
    }
    return cancelled;
  }

  getCompletedChunk(chunkX, chunkZ) {
    return this.#getCompleted(createChunkDataRequestKey(chunkX, chunkZ)) ?? null;
  }

  snapshot() {
    const timestamp = this.clock();
    const queued = [...this.queue].filter(entry => entry.state === 'queued').sort(
      (left, right) => compareWorldGenerationRequests(left, right, timestamp, {
        agingIntervalMs: this.agingIntervalMs,
      }),
    );
    return Object.freeze({
      cacheCapacity: this.cacheCapacity,
      completedCacheSize: this.completed.size,
      completedKeys: Object.freeze([...this.completed.keys()]),
      identityAuditSize: this.identityAudit.size,
      pendingCount: this.pending.size,
      queuedCount: queued.length,
      inFlightKey: this.inFlight?.key ?? null,
      inFlightCount: this.inFlight ? 1 : 0,
      queued: Object.freeze(queued.map(entry => Object.freeze({
        key: entry.key,
        priority: entry.priority,
        required: entry.required,
        deadlineAtMs: entry.deadlineAtMs,
        ...describeWorldGenerationPriority(entry.scheduler, timestamp, {
          agingIntervalMs: this.agingIntervalMs,
        }),
        subscriberCount: entry.subscribers.size,
      }))),
      transport: this.transport.snapshot?.() ?? null,
      metadata: this.metadata,
      scheduler: Object.freeze({
        workerCount: 1,
        agingIntervalMs: this.agingIntervalMs,
        backlog: queued.length + (this.inFlight ? 1 : 0),
      }),
      isShutdown: this.isShutdown,
      counts: Object.freeze({ ...this.counts }),
    });
  }

  async shutdown() {
    if (this.isShutdown) return;
    this.isShutdown = true;
    for (const entry of [...this.pending.values()]) {
      for (const subscriber of [...entry.subscribers.values()]) this.#cancelSubscriber(entry, subscriber);
    }
    this.queue.length = 0;
    await this.transport.shutdown?.();
    this.completed.clear();
    this.identityAudit.clear();
  }

  #subscribe(entry, {
    consumerId, epoch, telemetryCorrelationId, telemetryTarget, telemetryStream,
  }) {
    let resolve;
    const promise = new Promise(nextResolve => { resolve = nextResolve; });
    const subscriber = {
      id: ++this.subscriberSequence,
      consumerId,
      epoch,
      resolve,
      cancelled: false,
      telemetryCorrelationId,
      telemetryTarget,
      telemetryStream,
    };
    entry.subscribers.set(subscriber.id, subscriber);
    return Object.freeze({
      key: entry.key,
      consumerId,
      epoch,
      promise,
      cancel: () => this.#cancelSubscriber(entry, subscriber),
    });
  }

  #cancelledHandle({ key, consumerId, epoch }) {
    return Object.freeze({
      key, consumerId, epoch, cancel: () => false, promise: Promise.resolve(null),
    });
  }

  #cancelSubscriber(entry, subscriber) {
    if (subscriber.cancelled || !entry.subscribers.has(subscriber.id)) return false;
    subscriber.cancelled = true;
    entry.subscribers.delete(subscriber.id);
    subscriber.resolve(null);
    this.counts.subscriberCancels += 1;
    this.#recordTelemetry(WORLD_STREAMING_EVENT.CANCELLED, {
      correlationId: subscriber.telemetryCorrelationId,
      target: subscriber.telemetryTarget,
      stream: subscriber.telemetryStream,
      resourceKey: entry.key,
      ownerKey: entry.key,
      metadata: {
        reason: 'consumer-cancelled',
        consumerId: subscriber.consumerId,
        terminalState: 'cancelled',
        cancellationReason: 'consumer-cancelled',
        deadlineMiss: entry.deadlineAtMs !== null && this.clock() > entry.deadlineAtMs,
        backlog: this.queue.length + (this.inFlight ? 1 : 0),
      },
    });
    if (entry.state === 'queued' && entry.subscribers.size === 0) {
      this.pending.delete(entry.key);
      this.queue = this.queue.filter(candidate => candidate !== entry);
      entry.state = 'cancelled';
      this.counts.queuedOperationCancels += 1;
      this.counts.cancelledOperations += 1;
    } else if (entry.state === 'in-flight' && entry.subscribers.size === 0
      && !entry.cancelRequested) {
      entry.cancelRequested = true;
      if (this.transport.cancelGenerationRequest?.({
        requestId: entry.sequence,
        reason: 'no-active-subscribers',
      })) {
        this.counts.inFlightOperationCancels += 1;
      }
    }
    return true;
  }

  #scheduleDispatch() {
    if (this.dispatchScheduled || this.inFlight || this.isShutdown) return;
    this.dispatchScheduled = true;
    scheduleMicrotask(() => {
      this.dispatchScheduled = false;
      void this.#dispatchNext();
    });
  }

  async #dispatchNext() {
    if (this.isShutdown || this.inFlight) return;
    this.queue = this.queue.filter(entry => entry.state === 'queued' && entry.subscribers.size > 0);
    const dispatchAtMs = this.clock();
    this.queue.sort((left, right) => compareWorldGenerationRequests(
      left,
      right,
      dispatchAtMs,
      { agingIntervalMs: this.agingIntervalMs },
    ));
    const entry = this.queue.shift();
    if (!entry) return;
    entry.state = 'in-flight';
    this.inFlight = entry;
    this.counts.dispatched += 1;
    const ranking = describeWorldGenerationPriority(entry.scheduler, dispatchAtMs, {
      agingIntervalMs: this.agingIntervalMs,
    });
    this.counts.priorityAgingSteps += ranking.agingSteps;
    if (ranking.agingSteps > 0) this.counts.agedDispatches += 1;
    if (ranking.deadlineMiss) this.counts.deadlineMisses += 1;
    this.#recordTelemetry(WORLD_STREAMING_EVENT.WORKER_START, {
      correlationId: entry.telemetryCorrelationId,
      target: entry.telemetryTarget,
      stream: entry.telemetryStream,
      resourceKey: entry.key,
      ownerKey: entry.key,
      requestId: entry.sequence,
      metadata: {
        boundary: 'transport-dispatch',
        priority: entry.priority,
        effectivePriority: ranking.effectivePriority,
        queueTimeMs: ranking.queueTimeMs,
        startTimeMs: dispatchAtMs,
        terminalState: null,
        cancellationReason: null,
        deadlineMiss: ranking.deadlineMiss,
        priorityAging: ranking.agingSteps,
        backlog: this.queue.length + 1,
      },
    });
    let chunkData = null;
    let error = null;
    try {
      this.counts.transportCalls += 1;
      chunkData = await this.transport.generateChunk({
        requestId: entry.sequence,
        chunkX: entry.chunkX,
        chunkZ: entry.chunkZ,
        priority: entry.priority,
        required: entry.required,
        createdAtMs: entry.createdAtMs,
        deadlineAtMs: entry.deadlineAtMs,
        consumerId: entry.scheduler.consumerId,
        epoch: entry.scheduler.epoch,
        telemetryCorrelationId: entry.telemetryCorrelationId,
        telemetryTarget: entry.telemetryTarget,
        telemetryStream: entry.telemetryStream,
        scheduler: entry.scheduler,
      });
      if (entry.cancelRequested || chunkData === null) {
        entry.state = 'cancelled';
        this.counts.cancelledOperations += 1;
      } else {
        entry.state = 'completed';
        this.counts.completedOperations += 1;
        this.#recordTelemetry(WORLD_STREAMING_EVENT.WORKER_COMPLETE, {
          correlationId: entry.telemetryCorrelationId,
          target: entry.telemetryTarget,
          stream: entry.telemetryStream,
          resourceKey: entry.key,
          ownerKey: entry.key,
          requestId: entry.sequence,
          metadata: {
            boundary: 'transport-receive',
            queueTimeMs: ranking.queueTimeMs,
            startTimeMs: dispatchAtMs,
            terminalState: 'completed',
            cancellationReason: null,
            deadlineMiss: entry.deadlineAtMs !== null && this.clock() > entry.deadlineAtMs,
            priorityAging: ranking.agingSteps,
            backlog: this.queue.length,
          },
        });
        if (!this.isShutdown) this.#validateAndCache(entry, chunkData);
        else this.counts.shutdownLateResultCount += 1;
      }
    } catch (caught) {
      if (entry.cancelRequested) {
        entry.state = 'cancelled';
        this.counts.cancelledOperations += 1;
      } else {
        error = caught;
        entry.state = 'failed';
        this.counts.failedOperations += 1;
        this.#recordTelemetry(WORLD_STREAMING_EVENT.FAILED, {
          correlationId: entry.telemetryCorrelationId,
          target: entry.telemetryTarget,
          stream: entry.telemetryStream,
          resourceKey: entry.key,
          ownerKey: entry.key,
          requestId: entry.sequence,
          metadata: {
            name: caught?.name ?? 'Error',
            message: caught?.message ?? String(caught),
            queueTimeMs: ranking.queueTimeMs,
            startTimeMs: dispatchAtMs,
            terminalState: 'failed',
            cancellationReason: null,
            deadlineMiss: entry.deadlineAtMs !== null && this.clock() > entry.deadlineAtMs,
            priorityAging: ranking.agingSteps,
            backlog: this.queue.length,
          },
        });
      }
    } finally {
      this.pending.delete(entry.key);
      this.inFlight = null;
    }
    for (const subscriber of entry.subscribers.values()) {
      const currentEpoch = this.consumerEpochs.get(subscriber.consumerId) ?? subscriber.epoch;
      if (this.isShutdown || subscriber.cancelled || subscriber.epoch !== currentEpoch) {
        this.counts.staleSubscriberResults += 1;
        if (!subscriber.cancelled) {
          this.#recordTelemetry(WORLD_STREAMING_EVENT.CANCELLED, {
            correlationId: subscriber.telemetryCorrelationId,
            target: subscriber.telemetryTarget,
            stream: subscriber.telemetryStream,
            resourceKey: entry.key,
            ownerKey: entry.key,
            metadata: { reason: this.isShutdown ? 'shutdown-late-result' : 'stale-result' },
          });
        }
        subscriber.resolve(null);
      } else if (error) {
        subscriber.resolve(Promise.reject(error));
      } else {
        subscriber.resolve(chunkData);
      }
    }
    entry.subscribers.clear();
    this.#scheduleDispatch();
  }

  #recordTelemetry(type, details) {
    return this.telemetry?.record(type, details) ?? null;
  }

  #createSchedulerEnvelope(entry, consumerId, epoch) {
    return createChunkGeneratorSchedulerEnvelope({
      requestId: entry.sequence,
      operationKind: 'chunk',
      priority: entry.priority,
      required: entry.required,
      createdAtMs: entry.createdAtMs,
      deadlineAtMs: entry.deadlineAtMs,
      consumerId,
      epoch,
      correlationId: null,
      target: null,
      stream: null,
    });
  }

  #validateAndCache(entry, chunkData) {
    if (!chunkData || chunkData.chunkX !== entry.chunkX || chunkData.chunkZ !== entry.chunkZ
      || typeof chunkData.chunkId !== 'string' || typeof chunkData.contentHash !== 'string') {
      throw new Error(`transport returned invalid ChunkData for ${entry.key}`);
    }
    const identity = identityOf(chunkData);
    const audited = this.identityAudit.get(entry.key);
    if (audited && (audited.chunkId !== identity.chunkId || audited.contentHash !== identity.contentHash)) {
      this.counts.identityMismatchCount += 1;
      throw new Error(`regenerated chunk changed identity/content: ${entry.key}`);
    }
    const cached = this.completed.get(entry.key);
    if (cached && (cached.chunkId !== identity.chunkId || cached.contentHash !== identity.contentHash)) {
      this.counts.identityMismatchCount += 1;
      throw new Error(`regenerated chunk changed identity/content: ${entry.key}`);
    }
    if (audited) this.identityAudit.delete(entry.key);
    this.identityAudit.set(entry.key, identity);
    while (this.identityAudit.size > this.identityAuditCapacity) {
      this.identityAudit.delete(this.identityAudit.keys().next().value);
      this.counts.identityAuditEvictions += 1;
    }
    if (cached) return cached.data;
    this.completed.set(entry.key, { data: chunkData, identity });
    while (this.completed.size > this.cacheCapacity) {
      this.completed.delete(this.completed.keys().next().value);
      this.counts.completedEvictions += 1;
    }
    return chunkData;
  }

  #getCompleted(key) {
    const entry = this.completed.get(key);
    if (!entry) return null;
    this.completed.delete(key);
    this.completed.set(key, entry);
    return entry.data;
  }
}
