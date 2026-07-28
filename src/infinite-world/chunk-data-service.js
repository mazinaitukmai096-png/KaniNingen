import {
  assertChunkDataPriority,
  createChunkDataRequestKey,
  CHUNK_DATA_PRIORITY,
} from './chunk-data-service-protocol.js';

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function scheduleMicrotask(callback) {
  if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(callback);
  else Promise.resolve().then(callback);
}

function compareQueuedRequests(left, right) {
  return left.priority - right.priority || left.sequence - right.sequence;
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
    this.transport = transport;
    this.cacheCapacity = cacheCapacity;
    this.identityAuditCapacity = identityAuditCapacity;
    this.clock = clock;
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
  } = {}) {
    const key = createChunkDataRequestKey(chunkX, chunkZ);
    assertChunkDataPriority(priority);
    if (typeof consumerId !== 'string' || !consumerId) throw new TypeError('consumerId is required');
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('epoch must be a non-negative safe integer');
    this.counts.requests += 1;
    if (this.isShutdown) return this.#cancelledHandle({ key, consumerId, epoch });

    const knownEpoch = this.consumerEpochs.get(consumerId) ?? -1;
    if (epoch < knownEpoch) return this.#cancelledHandle({ key, consumerId, epoch });
    if (epoch > knownEpoch) {
      this.consumerEpochs.set(consumerId, epoch);
      this.cancelConsumer({ consumerId, beforeEpoch: epoch });
    }

    const cached = this.#getCompleted(key);
    if (cached) {
      this.counts.completedCacheHits += 1;
      return Object.freeze({
        key, consumerId, epoch, cancel: () => false, promise: Promise.resolve(cached),
      });
    }

    let entry = this.pending.get(key);
    if (!entry) {
      entry = {
        key, chunkX, chunkZ, priority, sequence: ++this.sequence,
        state: 'queued', subscribers: new Map(),
      };
      this.pending.set(key, entry);
      this.queue.push(entry);
    } else {
      this.counts.pendingDedupeHits += 1;
      if (entry.state === 'queued' && priority < entry.priority) {
        entry.priority = priority;
        this.counts.priorityPromotions += 1;
      }
    }
    const handle = this.#subscribe(entry, { consumerId, epoch });
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
    const queued = [...this.queue].filter(entry => entry.state === 'queued').sort(compareQueuedRequests);
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
        subscriberCount: entry.subscribers.size,
      }))),
      transport: this.transport.snapshot?.() ?? null,
      metadata: this.metadata,
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

  #subscribe(entry, { consumerId, epoch }) {
    let resolve;
    const promise = new Promise(nextResolve => { resolve = nextResolve; });
    const subscriber = {
      id: ++this.subscriberSequence, consumerId, epoch, resolve, cancelled: false,
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
    if (entry.state === 'queued' && entry.subscribers.size === 0) {
      this.pending.delete(entry.key);
      this.queue = this.queue.filter(candidate => candidate !== entry);
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
    this.queue.sort(compareQueuedRequests);
    const entry = this.queue.shift();
    if (!entry) return;
    entry.state = 'in-flight';
    this.inFlight = entry;
    this.counts.dispatched += 1;
    let chunkData = null;
    let error = null;
    try {
      this.counts.transportCalls += 1;
      chunkData = await this.transport.generateChunk({
        requestId: entry.sequence,
        chunkX: entry.chunkX,
        chunkZ: entry.chunkZ,
        priority: entry.priority,
      });
      if (!this.isShutdown) this.#validateAndCache(entry, chunkData);
      else this.counts.shutdownLateResultCount += 1;
    } catch (caught) {
      error = caught;
    } finally {
      this.pending.delete(entry.key);
      this.inFlight = null;
    }
    for (const subscriber of entry.subscribers.values()) {
      const currentEpoch = this.consumerEpochs.get(subscriber.consumerId) ?? subscriber.epoch;
      if (this.isShutdown || subscriber.cancelled || subscriber.epoch !== currentEpoch) {
        this.counts.staleSubscriberResults += 1;
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
