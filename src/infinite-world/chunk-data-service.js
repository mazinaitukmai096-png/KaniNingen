import {
  assertChunkDataPriority,
  createChunkDataRequestKey,
  CHUNK_DATA_PRIORITY,
} from './chunk-data-service-protocol.js';
import { WORLD_STREAMING_EVENT } from './world-streaming-telemetry.js';
import {
  WORLD_GENERATION_REPRESENTATION_CLASS,
} from './world-generation-scheduler.js';
import {
  createOwnerGenerationCoordinator,
  defaultOwnerGenerationPriorityClass,
} from './owner-generation-coordinator.js';

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function identityOf(chunkData) {
  return Object.freeze({ chunkId: chunkData.chunkId, contentHash: chunkData.contentHash });
}

function sampleDistribution(values) {
  if (values.length === 0) return Object.freeze({ count: 0, p50: 0, p95: 0, max: 0 });
  const ordered = [...values].sort((left, right) => left - right);
  const at = ratio => ordered[Math.min(
    ordered.length - 1,
    Math.floor((ordered.length - 1) * ratio),
  )];
  return Object.freeze({
    count: ordered.length,
    p50: at(0.5),
    p95: at(0.95),
    max: ordered.at(-1),
  });
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
    onPipelineEvent = null,
    agingIntervalMs = 250,
    coordinator = null,
    resourceKind = 'full',
    representationClass = WORLD_GENERATION_REPRESENTATION_CLASS.DETAIL,
    operationKind = 'chunk',
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
    if (onPipelineEvent !== null && typeof onPipelineEvent !== 'function') {
      throw new TypeError('onPipelineEvent must be a function when provided');
    }
    if (!Number.isFinite(agingIntervalMs) || agingIntervalMs <= 0) {
      throw new RangeError('agingIntervalMs must be positive');
    }
    if (typeof resourceKind !== 'string' || !resourceKind) {
      throw new TypeError('resourceKind must be a non-empty string');
    }
    if (typeof operationKind !== 'string' || !operationKind) {
      throw new TypeError('operationKind must be a non-empty string');
    }
    this.transport = transport;
    this.cacheCapacity = cacheCapacity;
    this.identityAuditCapacity = identityAuditCapacity;
    this.clock = clock;
    this.telemetry = telemetry?.enabled === true ? telemetry : null;
    this.onPipelineEvent = onPipelineEvent;
    this.agingIntervalMs = agingIntervalMs;
    this.coordinator = coordinator ?? createOwnerGenerationCoordinator({
      clock,
      agingIntervalMs,
    });
    if (typeof this.coordinator?.schedule !== 'function'
      || typeof this.coordinator?.snapshot !== 'function') {
      throw new TypeError('coordinator must be an OwnerGenerationCoordinator');
    }
    this.ownsCoordinator = coordinator === null;
    this.resourceKind = resourceKind;
    this.representationClass = representationClass;
    this.operationKind = operationKind;
    this.completed = new Map();
    this.protectedOwnerKeys = new Set();
    this.identityAudit = new Map();
    this.pending = new Map();
    this.consumerEpochs = new Map();
    this.subscriberSequence = 0;
    this.queueWaitSamples = [];
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
      protectedOwnerEvictions: 0,
      protectedOwnerSetUpdates: 0,
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
          backlog: this.coordinator.backlog,
        },
      })
      ?? null;
    if (this.onPipelineEvent) this.#recordPipelineEvent('chunk-request-issued', {
      ownerKey: key,
      resourceKind: this.resourceKind,
      representationClass: this.representationClass,
      operationKind: this.operationKind,
      createdAtMs,
      firstVisibleDeadlineMs: deadlineAtMs,
      subscriberIdentity: `${this.resourceKind}:${consumerId}:${epoch}`,
      chunkX,
      chunkZ,
      consumerId,
      epoch,
      priority,
      required,
      deadlineAtMs,
      correlationId: telemetryCorrelationId,
      backlog: this.coordinator.backlog,
    });
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
      if (this.onPipelineEvent) this.#recordPipelineEvent('chunk-request-cache-hit', {
        ownerKey: key,
        resourceKind: this.resourceKind,
        representationClass: this.representationClass,
        operationKind: this.operationKind,
        chunkX,
        chunkZ,
        consumerId,
        epoch,
        priority,
        required,
        correlationId: telemetryCorrelationId,
      });
      return Object.freeze({
        key, consumerId, epoch, cancel: () => false, promise: Promise.resolve(cached),
      });
    }

    let entry = this.pending.get(key);
    // A request whose final subscriber cancelled is a terminal generation
    // token even while its transport result is still draining. Never attach a
    // successor subscriber to that tombstone; the old completion is guarded by
    // the pending-entry identity check in #completeEntry.
    const isNewEntry = !entry || entry.cancelRequested;
    if (isNewEntry) {
      entry = {
        key, chunkX, chunkZ, priority, sequence: null,
        state: 'queued', subscribers: new Map(), telemetryCorrelationId,
        telemetryTarget, telemetryStream,
        createdAtMs,
        deadlineAtMs,
        required,
        cancelRequested: false,
        coordinatorHandle: null,
      };
      this.pending.set(key, entry);
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
      if (this.onPipelineEvent) this.#recordPipelineEvent('chunk-request-deduped', {
        ownerKey: key,
        resourceKind: this.resourceKind,
        representationClass: this.representationClass,
        operationKind: this.operationKind,
        chunkX,
        chunkZ,
        requestId: entry.sequence,
        consumerId,
        epoch,
        priority,
        required,
        correlationId: telemetryCorrelationId,
        entryState: entry.state,
        backlog: this.coordinator.backlog,
      });
      if (entry.coordinatorHandle?.state === 'queued' && priority < entry.priority) {
        entry.priority = priority;
        this.counts.priorityPromotions += 1;
      }
      if (entry.coordinatorHandle?.state === 'queued') {
        entry.required ||= required;
        if (deadlineAtMs !== null
          && (entry.deadlineAtMs === null || deadlineAtMs < entry.deadlineAtMs)) {
          entry.deadlineAtMs = deadlineAtMs;
        }
      }
    }
    const handle = this.#subscribe(entry, {
      consumerId, epoch, telemetryCorrelationId, telemetryTarget, telemetryStream,
    });
    const subscriberIdentity = `${this.resourceKind}:${consumerId}:${epoch}`;
    if (isNewEntry) {
      try {
        this.#scheduleEntry(entry, { consumerId, epoch, subscriberIdentity });
      } catch (error) {
        this.pending.delete(key);
        throw error;
      }
      if (this.onPipelineEvent) this.#recordPipelineEvent('chunk-request-queued', {
        ownerKey: key,
        resourceKind: this.resourceKind,
        representationClass: this.representationClass,
        operationKind: this.operationKind,
        createdAtMs,
        firstVisibleDeadlineMs: deadlineAtMs,
        subscriberIdentity,
        chunkX,
        chunkZ,
        requestId: entry.sequence,
        consumerId,
        epoch,
        priority,
        required,
        deadlineAtMs,
        correlationId: telemetryCorrelationId,
        backlog: this.coordinator.backlog,
      });
      this.counts.maximumBacklog = Math.max(
        this.counts.maximumBacklog,
        this.coordinator.backlog,
      );
    } else if (entry.coordinatorHandle?.state === 'queued') {
      entry.coordinatorHandle.update({
        priority: entry.priority,
        priorityClass: defaultOwnerGenerationPriorityClass({
          resourceKind: this.resourceKind,
          priority: entry.priority,
          required: entry.required,
          firstVisibleDeadlineMs: entry.deadlineAtMs,
        }),
        required: entry.required,
        firstVisibleDeadlineMs: entry.deadlineAtMs,
        representationClass: this.representationClass,
        subscriberIdentity,
        consumerId,
        epoch,
      });
      entry.scheduler = entry.coordinatorHandle.envelope;
    }
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

  replaceProtectedOwnerKeys(ownerKeys) {
    if (!Array.isArray(ownerKeys) && !(ownerKeys instanceof Set)) {
      throw new TypeError('protected owner keys must be an array or Set');
    }
    const next = new Set(ownerKeys);
    if ([...next].some(key => typeof key !== 'string' || key.length === 0)) {
      throw new TypeError('protected owner keys must be non-empty strings');
    }
    if (next.size > this.cacheCapacity) {
      throw new RangeError(
        `protected owner set exceeds ChunkData cache capacity: ${next.size}/${this.cacheCapacity}`,
      );
    }
    const previous = this.protectedOwnerKeys;
    this.protectedOwnerKeys = next;
    this.counts.protectedOwnerSetUpdates += 1;
    this.#trimCompletedCache();
    return Object.freeze({
      unchanged: [...next].filter(key => previous.has(key)).length,
      entering: [...next].filter(key => !previous.has(key)).length,
      leaving: [...previous].filter(key => !next.has(key)).length,
    });
  }

  snapshot() {
    const coordinator = this.coordinator.snapshot();
    const queued = coordinator.queued.filter(entry => entry.resourceKind === this.resourceKind);
    const inFlight = coordinator.inFlight.filter(entry => entry.resourceKind === this.resourceKind);
    return Object.freeze({
      resourceKind: this.resourceKind,
      representationClass: this.representationClass,
      cacheCapacity: this.cacheCapacity,
      completedCacheSize: this.completed.size,
      completedKeys: Object.freeze([...this.completed.keys()]),
      protectedOwnerCount: this.protectedOwnerKeys.size,
      protectedResidentOwnerCount: [...this.protectedOwnerKeys]
        .filter(key => this.completed.has(key)).length,
      protectedOwnerKeys: Object.freeze([...this.protectedOwnerKeys]),
      identityAuditSize: this.identityAudit.size,
      pendingCount: this.pending.size,
      queuedCount: queued.length,
      inFlightCount: inFlight.length,
      inFlightKey: inFlight[0]?.ownerKey ?? null,
      inFlightKeys: Object.freeze(inFlight.map(entry => entry.ownerKey)),
      queued: Object.freeze(queued.map(item => Object.freeze({
        ...item,
        key: item.ownerKey,
        subscriberCount: this.pending.get(item.ownerKey)?.subscribers.size ?? 0,
      }))),
      transport: this.transport.snapshot?.() ?? null,
      metadata: this.metadata,
      coordinator,
      scheduler: Object.freeze({
        workerCount: 1,
        globalOwnerQueue: true,
        agingIntervalMs: this.agingIntervalMs,
        backlog: coordinator.backlog,
        queueWaitMs: sampleDistribution(this.queueWaitSamples),
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
    if (this.ownsCoordinator) await this.coordinator.shutdown({ reason: 'service-shutdown' });
    await this.transport.shutdown?.();
    this.completed.clear();
    this.protectedOwnerKeys.clear();
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
      cancelWithDetails: () => this.#cancelSubscriberDetailed(entry, subscriber),
    });
  }

  #cancelledHandle({ key, consumerId, epoch }) {
    return Object.freeze({
      key,
      consumerId,
      epoch,
      cancel: () => false,
      cancelWithDetails: () => Object.freeze({
        subscriberCancelled: false,
        underlyingRequestCancelled: false,
        workerCancelRequested: false,
      }),
      promise: Promise.resolve(null),
    });
  }

  #cancelSubscriberDetailed(entry, subscriber) {
    if (subscriber.cancelled || !entry.subscribers.has(subscriber.id)) {
      return Object.freeze({
        subscriberCancelled: false,
        underlyingRequestCancelled: false,
        workerCancelRequested: false,
      });
    }
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
        backlog: this.coordinator.backlog,
      },
    });
    let underlyingRequestCancelled = false;
    let workerCancelRequested = false;
    if (entry.subscribers.size === 0 && !entry.cancelRequested) {
      const coordinatorState = entry.coordinatorHandle?.state;
      entry.cancelRequested = true;
      underlyingRequestCancelled = entry.coordinatorHandle?.cancel(
        'no-active-subscribers',
      ) ?? false;
      workerCancelRequested = entry.workerCancelRequested === true;
      if (underlyingRequestCancelled && coordinatorState === 'queued') {
        this.pending.delete(entry.key);
        entry.state = 'cancelled';
        entry.terminalCounted = true;
        this.counts.queuedOperationCancels += 1;
        this.counts.cancelledOperations += 1;
      } else if (underlyingRequestCancelled && coordinatorState === 'in-flight') {
        this.counts.inFlightOperationCancels += 1;
      }
    }
    return Object.freeze({
      subscriberCancelled: true,
      underlyingRequestCancelled,
      workerCancelRequested,
    });
  }

  #cancelSubscriber(entry, subscriber) {
    return this.#cancelSubscriberDetailed(entry, subscriber).subscriberCancelled;
  }

  #scheduleEntry(entry, { consumerId, epoch, subscriberIdentity }) {
    const priorityClass = defaultOwnerGenerationPriorityClass({
      resourceKind: this.resourceKind,
      priority: entry.priority,
      required: entry.required,
      firstVisibleDeadlineMs: entry.deadlineAtMs,
    });
    const coordinatorHandle = this.coordinator.schedule({
      ownerKey: entry.key,
      resourceKind: this.resourceKind,
      operationKind: this.operationKind,
      priority: entry.priority,
      priorityClass,
      required: entry.required,
      createdAtMs: entry.createdAtMs,
      firstVisibleDeadlineMs: entry.deadlineAtMs,
      representationClass: this.representationClass,
      subscriberIdentity,
      consumerId,
      epoch,
      correlationId: entry.telemetryCorrelationId,
      target: entry.telemetryTarget,
      stream: entry.telemetryStream,
      execute: execution => {
        if (execution.cancelled) return null;
        entry.state = 'in-flight';
        entry.scheduler = execution.envelope;
        return this.#startTransport(
          entry,
          execution.startedAtMs,
          execution.ranking,
        );
      },
      onCancel: (reason, envelope) => {
        entry.workerCancelRequested = this.transport.cancelGenerationRequest?.({
          requestId: envelope.requestId,
          reason,
        }) === true;
      },
    });
    entry.coordinatorHandle = coordinatorHandle;
    entry.sequence = coordinatorHandle.sequence;
    entry.scheduler = coordinatorHandle.envelope;
    void coordinatorHandle.promise.then(
      () => this.#finishCoordinatorEntry(entry),
      () => this.#finishCoordinatorEntry(entry),
    );
  }

  #finishCoordinatorEntry(entry) {
    if (entry.transportResult) return this.#completeEntry(entry);
    if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key);
    entry.state = 'cancelled';
    if (!entry.terminalCounted) {
      entry.terminalCounted = true;
      this.counts.cancelledOperations += 1;
    }
    for (const subscriber of entry.subscribers.values()) subscriber.resolve(null);
    entry.subscribers.clear();
    return undefined;
  }

  #startTransport(entry, dispatchAtMs, ranking) {
    this.counts.dispatched += 1;
    this.queueWaitSamples.push(ranking.queueTimeMs);
    if (this.queueWaitSamples.length > 512) this.queueWaitSamples.shift();
    entry.dispatchAtMs = dispatchAtMs;
    entry.ranking = ranking;
    if (this.onPipelineEvent) this.#recordPipelineEvent('chunk-worker-dispatch', {
      ownerKey: entry.key,
      resourceKind: this.resourceKind,
      representationClass: this.representationClass,
      operationKind: this.operationKind,
      createdAtMs: entry.createdAtMs,
      firstVisibleDeadlineMs: entry.deadlineAtMs,
      subscriberIdentity: entry.scheduler.subscriberIdentity,
      chunkX: entry.chunkX,
      chunkZ: entry.chunkZ,
      requestId: entry.sequence,
      consumerId: entry.scheduler.consumerId,
      epoch: entry.scheduler.epoch,
      priority: entry.priority,
      effectivePriority: ranking.effectivePriority,
      required: entry.required,
      deadlineAtMs: entry.deadlineAtMs,
      deadlineMiss: ranking.deadlineMiss,
      serviceQueueTimeMs: ranking.queueTimeMs,
      correlationId: entry.telemetryCorrelationId,
      backlog: this.coordinator.backlog,
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
        backlog: this.coordinator.backlog,
      },
    });
    this.counts.transportCalls += 1;
    let transportPromise;
    try {
      transportPromise = Promise.resolve(this.transport.generateChunk({
        requestId: entry.sequence,
        chunkX: entry.chunkX,
        chunkZ: entry.chunkZ,
        priority: entry.priority,
        priorityClass: entry.scheduler.priorityClass,
        required: entry.required,
        createdAtMs: entry.createdAtMs,
        deadlineAtMs: entry.deadlineAtMs,
        firstVisibleDeadlineMs: entry.scheduler.firstVisibleDeadlineMs,
        ownerKey: entry.key,
        resourceKind: this.resourceKind,
        representationClass: this.representationClass,
        operationKind: this.operationKind,
        createdAtMs: entry.createdAtMs,
        firstVisibleDeadlineMs: entry.deadlineAtMs,
        sequence: entry.scheduler.sequence,
        subscriberIdentity: entry.scheduler.subscriberIdentity,
        consumerId: entry.scheduler.consumerId,
        epoch: entry.scheduler.epoch,
        telemetryCorrelationId: entry.telemetryCorrelationId,
        telemetryTarget: entry.telemetryTarget,
        telemetryStream: entry.telemetryStream,
        scheduler: entry.scheduler,
      }));
    } catch (error) {
      transportPromise = Promise.reject(error);
    }
    entry.transportResult = transportPromise.then(
      chunkData => Object.freeze({
        chunkData,
        error: null,
        responseReceivedAtMs: this.clock(),
      }),
      error => Object.freeze({
        chunkData: null,
        error,
        responseReceivedAtMs: this.clock(),
      }),
    );
    return entry.transportResult.then(result => {
      if (result.error) throw result.error;
      return result.chunkData;
    });
  }

  async #completeEntry(entry) {
    if (entry.completionStarted) return;
    entry.completionStarted = true;
    const { ranking, dispatchAtMs } = entry;
    let chunkData = null;
    let error = null;
    try {
      const transportResult = await entry.transportResult;
      if (transportResult.error) throw transportResult.error;
      chunkData = transportResult.chunkData;
      const { responseReceivedAtMs } = transportResult;
      if (this.onPipelineEvent) this.#recordPipelineEvent('chunk-main-response-received', {
        ownerKey: entry.key,
        resourceKind: this.resourceKind,
        representationClass: this.representationClass,
        chunkX: entry.chunkX,
        chunkZ: entry.chunkZ,
        requestId: entry.sequence,
        consumerId: entry.scheduler.consumerId,
        epoch: entry.scheduler.epoch,
        priority: entry.priority,
        required: entry.required,
        correlationId: entry.telemetryCorrelationId,
        requestToMainReceiveMs: Math.max(0, responseReceivedAtMs - entry.createdAtMs),
        serviceQueueTimeMs: ranking.queueTimeMs,
        backlog: this.coordinator.backlog,
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
            backlog: this.coordinator.backlog,
          },
        });
        if (!this.isShutdown) {
          const validationStartedAtMs = this.clock();
          this.#validateAndCache(entry, chunkData);
          if (this.onPipelineEvent) this.#recordPipelineEvent('chunk-owner-ready', {
            ownerKey: entry.key,
            resourceKind: this.resourceKind,
            representationClass: this.representationClass,
            operationKind: this.operationKind,
            createdAtMs: entry.createdAtMs,
            firstVisibleDeadlineMs: entry.deadlineAtMs,
            chunkX: entry.chunkX,
            chunkZ: entry.chunkZ,
            requestId: entry.sequence,
            consumerId: entry.scheduler.consumerId,
            epoch: entry.scheduler.epoch,
            priority: entry.priority,
            required: entry.required,
            correlationId: entry.telemetryCorrelationId,
            validationMs: Math.max(0, this.clock() - validationStartedAtMs),
            requestToReadyMs: Math.max(0, this.clock() - entry.createdAtMs),
            backlog: this.coordinator.backlog,
          });
        }
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
            backlog: this.coordinator.backlog,
          },
        });
      }
    } finally {
      if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key);
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
        if (this.onPipelineEvent) this.#recordPipelineEvent('chunk-owner-delivered', {
          ownerKey: entry.key,
          resourceKind: this.resourceKind,
          representationClass: this.representationClass,
          operationKind: this.operationKind,
          createdAtMs: entry.createdAtMs,
          firstVisibleDeadlineMs: entry.deadlineAtMs,
          subscriberIdentity: `${this.resourceKind}:${subscriber.consumerId}:${subscriber.epoch}`,
          chunkX: entry.chunkX,
          chunkZ: entry.chunkZ,
          requestId: entry.sequence,
          consumerId: subscriber.consumerId,
          epoch: subscriber.epoch,
          correlationId: subscriber.telemetryCorrelationId,
          requestToDeliveryMs: Math.max(0, this.clock() - entry.createdAtMs),
        });
        subscriber.resolve(chunkData);
      }
    }
    entry.subscribers.clear();
  }

  #recordTelemetry(type, details) {
    return this.telemetry?.record(type, details) ?? null;
  }

  #recordPipelineEvent(type, details) {
    if (!this.onPipelineEvent) return null;
    try {
      return this.onPipelineEvent(type, details);
    } catch {
      return null;
    }
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
    this.#trimCompletedCache();
    return chunkData;
  }

  #trimCompletedCache() {
    while (this.completed.size > this.cacheCapacity) {
      let evictableKey;
      for (const key of this.completed.keys()) {
        if (this.protectedOwnerKeys.has(key)) continue;
        evictableKey = key;
        break;
      }
      if (evictableKey === undefined) {
        throw new Error('ChunkData cache capacity is smaller than protected Resident owners');
      }
      if (this.protectedOwnerKeys.has(evictableKey)) {
        this.counts.protectedOwnerEvictions += 1;
        throw new Error(`protected Resident owner selected for eviction: ${evictableKey}`);
      }
      this.completed.delete(evictableKey);
      this.counts.completedEvictions += 1;
    }
  }

  #getCompleted(key) {
    const entry = this.completed.get(key);
    if (!entry) return null;
    this.completed.delete(key);
    this.completed.set(key, entry);
    return entry.data;
  }
}
