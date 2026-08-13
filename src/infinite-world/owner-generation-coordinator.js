import {
  WORLD_GENERATION_PRIORITY_CLASS,
  WORLD_GENERATION_REPRESENTATION_CLASS,
  compareWorldGenerationRequests,
  createWorldGenerationRequestEnvelope,
  describeWorldGenerationPriority,
} from './world-generation-scheduler.js';

export const OWNER_GENERATION_COORDINATOR_SCHEMA = 'owner-generation-coordinator-1';

const defaultClock = () => globalThis.performance?.now?.() ?? Date.now();
const scheduleMicrotask = callback => {
  if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(callback);
  else Promise.resolve().then(callback);
};

function earlierDeadline(left, right) {
  if (left === null || left === undefined) return right ?? null;
  if (right === null || right === undefined) return left;
  return Math.min(left, right);
}

function strongerRepresentation(left, right) {
  if (left === WORLD_GENERATION_REPRESENTATION_CLASS.COARSE
    || right === WORLD_GENERATION_REPRESENTATION_CLASS.COARSE) {
    return WORLD_GENERATION_REPRESENTATION_CLASS.COARSE;
  }
  return left ?? right ?? null;
}

/**
 * One main-side deadline queue for every owner resource sent to the shared
 * generation transport. Resource stores retain cache/subscriber ownership;
 * this coordinator alone owns dispatch order and admission.
 */
export function createOwnerGenerationCoordinator({
  clock = defaultClock,
  maximumConcurrentRequests = 1,
  agingIntervalMs = 250,
  imminentWindowMs = 100,
  onEvent = null,
} = {}) {
  if (typeof clock !== 'function') throw new TypeError('Owner generation coordinator clock is required');
  if (!Number.isSafeInteger(maximumConcurrentRequests) || maximumConcurrentRequests < 1) {
    throw new RangeError('maximumConcurrentRequests must be a positive safe integer');
  }
  if (!Number.isFinite(agingIntervalMs) || agingIntervalMs <= 0) {
    throw new RangeError('agingIntervalMs must be positive');
  }
  if (!Number.isFinite(imminentWindowMs) || imminentWindowMs < 0) {
    throw new RangeError('imminentWindowMs must be non-negative');
  }
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw new TypeError('Owner generation coordinator onEvent must be a function');
  }

  const queued = [];
  const active = new Map();
  const activeByCompositeKey = new Map();
  const inFlight = new Map();
  let sequence = 0;
  let dispatchScheduled = false;
  let isShutdown = false;
  let maximumBacklog = 0;
  const counts = {
    scheduled: 0,
    deduplicated: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    queuedCancelled: 0,
    inFlightCancelled: 0,
    promotions: 0,
    deadlineMisses: 0,
    deadlineImminentStarts: 0,
  };

  const emit = event => {
    if (!onEvent) return;
    try { onEvent(Object.freeze(event)); } catch { /* diagnostics are isolated */ }
  };
  const backlog = () => queued.length + inFlight.size;
  const rankingOptions = Object.freeze({ agingIntervalMs, imminentWindowMs });

  const settle = (entry, state, value = null, error = null) => {
    if (entry.terminal) return;
    entry.terminal = true;
    entry.state = state;
    active.delete(entry.envelope.requestId);
    if (activeByCompositeKey.get(entry.compositeKey) === entry) {
      activeByCompositeKey.delete(entry.compositeKey);
    }
    inFlight.delete(entry.envelope.requestId);
    if (state === 'completed') {
      counts.completed += 1;
      for (const subscriber of entry.subscribers) subscriber.resolve(value);
    } else if (state === 'cancelled') {
      counts.cancelled += 1;
      for (const subscriber of entry.subscribers) subscriber.resolve(null);
    } else {
      counts.failed += 1;
      for (const subscriber of entry.subscribers) subscriber.reject(error);
    }
    entry.subscribers.clear();
    entry.resolveTerminal();
    emit({
      type: 'terminal',
      state,
      envelope: entry.envelope,
      error: state === 'failed' ? error : null,
      cancellationReason: state === 'cancelled' ? entry.cancellationReason : null,
      terminalAtMs: clock(),
      backlog: backlog(),
    });
    scheduleDispatch();
  };

  const start = entry => {
    const startedAtMs = clock();
    const ranking = describeWorldGenerationPriority(entry.envelope, startedAtMs, rankingOptions);
    entry.state = 'in-flight';
    entry.startedAtMs = startedAtMs;
    entry.ranking = ranking;
    inFlight.set(entry.envelope.requestId, entry);
    counts.started += 1;
    if (ranking.deadlineMiss) counts.deadlineMisses += 1;
    if (ranking.deadlineImminent) counts.deadlineImminentStarts += 1;
    emit({
      type: 'started',
      envelope: entry.envelope,
      state: entry.state,
      startedAtMs,
      ...ranking,
      backlog: backlog(),
    });
    const execution = Object.freeze({
      envelope: entry.envelope,
      startedAtMs,
      ranking,
      get cancelled() { return entry.cancelRequested; },
    });
    Promise.resolve()
      .then(() => entry.execute(execution))
      .then(value => settle(
        entry,
        entry.cancelRequested || value === null ? 'cancelled' : 'completed',
        value,
      ))
      .catch(error => settle(entry, entry.cancelRequested ? 'cancelled' : 'failed', null, error));
  };

  const dispatch = () => {
    dispatchScheduled = false;
    if (isShutdown) return;
    const now = clock();
    queued.sort((left, right) => compareWorldGenerationRequests(
      left,
      right,
      now,
      rankingOptions,
    ));
    while (inFlight.size < maximumConcurrentRequests && queued.length > 0) {
      const entry = queued.shift();
      if (!entry || entry.state !== 'queued' || entry.cancelRequested) continue;
      start(entry);
    }
  };

  function scheduleDispatch() {
    if (dispatchScheduled || isShutdown || queued.length === 0
      || inFlight.size >= maximumConcurrentRequests) return;
    dispatchScheduled = true;
    scheduleMicrotask(dispatch);
  }

  const createSubscriber = identity => {
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    return { identity: identity ?? null, resolve, reject, promise, cancelled: false };
  };

  const updateEntry = (entry, {
    priority: nextPriority = entry.envelope.priority,
    priorityClass: nextPriorityClass = entry.envelope.priorityClass,
    required: nextRequired = entry.envelope.required,
    firstVisibleDeadlineMs: nextDeadline = entry.envelope.firstVisibleDeadlineMs,
    representationClass: nextRepresentation = entry.envelope.representationClass,
    subscriberIdentity: nextSubscriberIdentity = null,
    consumerId: nextConsumerId = entry.envelope.consumerId,
    epoch: nextEpoch = entry.envelope.epoch,
  } = {}) => {
    if (entry.terminal || entry.cancelRequested) return false;
    if (nextSubscriberIdentity) entry.subscriberIdentities.add(nextSubscriberIdentity);
    if (entry.state !== 'queued') return false;
    const mergedPriority = Math.min(entry.envelope.priority, nextPriority);
    const mergedPriorityClass = Math.min(
      entry.envelope.priorityClass ?? entry.envelope.priority,
      nextPriorityClass ?? nextPriority,
    );
    const mergedDeadline = earlierDeadline(
      entry.envelope.firstVisibleDeadlineMs,
      nextDeadline,
    );
    entry.envelope = createWorldGenerationRequestEnvelope({
      ...entry.envelope,
      priority: mergedPriority,
      priorityClass: mergedPriorityClass,
      required: entry.envelope.required || nextRequired,
      deadlineAtMs: mergedDeadline,
      firstVisibleDeadlineMs: mergedDeadline,
      representationClass: strongerRepresentation(
        entry.envelope.representationClass,
        nextRepresentation,
      ),
      consumerId: nextConsumerId,
      epoch: nextEpoch,
    });
    counts.promotions += 1;
    scheduleDispatch();
    return true;
  };

  const cancelSubscriber = (entry, subscriber, reason = 'cancelled') => {
    if (subscriber.cancelled || entry.terminal || !entry.subscribers.has(subscriber)) return false;
    subscriber.cancelled = true;
    entry.subscribers.delete(subscriber);
    subscriber.resolve(null);
    if (entry.subscribers.size > 0 || entry.cancelRequested) return true;
    entry.cancelRequested = true;
    entry.cancellationReason = reason;
    if (entry.state === 'queued') {
      const index = queued.indexOf(entry);
      if (index >= 0) queued.splice(index, 1);
      counts.queuedCancelled += 1;
      settle(entry, 'cancelled');
    } else {
      counts.inFlightCancelled += 1;
      try { entry.onCancel?.(reason, entry.envelope); } catch { /* best effort */ }
    }
    return true;
  };

  const createHandle = (entry, subscriber) => Object.freeze({
    requestId: entry.envelope.requestId,
    sequence: entry.sequence,
    promise: subscriber.promise,
    cancel: reason => cancelSubscriber(entry, subscriber, reason),
    update: options => (
      subscriber.cancelled ? false : updateEntry(entry, options)
    ),
    get state() { return entry.state; },
    get envelope() { return entry.envelope; },
  });

  const schedule = ({
    ownerKey,
    resourceKind,
    operationKind = resourceKind,
    priority,
    priorityClass,
    required,
    createdAtMs = clock(),
    firstVisibleDeadlineMs = null,
    representationClass,
    subscriberIdentity,
    consumerId = null,
    epoch = 0,
    correlationId = null,
    target = null,
    stream = null,
    execute,
    onCancel = null,
  } = {}) => {
    if (isShutdown) throw new Error('Owner generation coordinator is shut down');
    if (typeof ownerKey !== 'string' || !ownerKey
      || typeof resourceKind !== 'string' || !resourceKind) {
      throw new TypeError('Owner generation ownerKey and resourceKind are required');
    }
    if (typeof execute !== 'function') throw new TypeError('Owner generation execute is required');
    if (onCancel !== null && typeof onCancel !== 'function') {
      throw new TypeError('Owner generation onCancel must be a function');
    }
    const compositeKey = `${resourceKind}\n${ownerKey}`;
    const existing = activeByCompositeKey.get(compositeKey);
    if (existing && !existing.terminal && !existing.cancelRequested) {
      const subscriber = createSubscriber(subscriberIdentity);
      existing.subscribers.add(subscriber);
      if (subscriberIdentity) existing.subscriberIdentities.add(subscriberIdentity);
      counts.deduplicated += 1;
      updateEntry(existing, {
        priority,
        priorityClass,
        required,
        firstVisibleDeadlineMs,
        representationClass,
        subscriberIdentity,
        consumerId,
        epoch,
      });
      return createHandle(existing, subscriber);
    }
    const requestSequence = ++sequence;
    const subscriber = createSubscriber(subscriberIdentity);
    let resolveTerminal;
    const terminalPromise = new Promise(resolve => { resolveTerminal = resolve; });
    const subscriberIdentities = new Set(
      subscriberIdentity ? [subscriberIdentity] : [],
    );
    const entry = {
      envelope: createWorldGenerationRequestEnvelope({
        requestId: requestSequence,
        operationKind,
        priority,
        priorityClass,
        required,
        createdAtMs,
        deadlineAtMs: firstVisibleDeadlineMs,
        firstVisibleDeadlineMs,
        ownerKey,
        resourceKind,
        representationClass,
        sequence: requestSequence,
        subscriberIdentity: subscriberIdentity ?? null,
        consumerId,
        epoch,
        correlationId,
        target,
        stream,
      }),
      sequence: requestSequence,
      compositeKey,
      subscriberIdentities,
      subscribers: new Set([subscriber]),
      execute,
      onCancel,
      resolveTerminal,
      terminalPromise,
      state: 'queued',
      startedAtMs: null,
      ranking: null,
      cancelRequested: false,
      cancellationReason: null,
      terminal: false,
    };
    active.set(requestSequence, entry);
    activeByCompositeKey.set(compositeKey, entry);
    queued.push(entry);
    counts.scheduled += 1;
    maximumBacklog = Math.max(maximumBacklog, backlog());
    emit({ type: 'queued', envelope: entry.envelope, state: entry.state, backlog: backlog() });
    scheduleDispatch();
    return createHandle(entry, subscriber);
  };

  const snapshot = () => {
    const now = clock();
    const ranked = [...queued].sort((left, right) => compareWorldGenerationRequests(
      left,
      right,
      now,
      rankingOptions,
    ));
    const describe = entry => Object.freeze({
      requestId: entry.envelope.requestId,
      sequence: entry.envelope.sequence,
      compositeKey: entry.compositeKey,
      ownerKey: entry.envelope.ownerKey,
      resourceKind: entry.envelope.resourceKind,
      operationKind: entry.envelope.operationKind,
      representationClass: entry.envelope.representationClass,
      priority: entry.envelope.priority,
      priorityClass: entry.envelope.priorityClass,
      required: entry.envelope.required,
      firstVisibleDeadlineMs: entry.envelope.firstVisibleDeadlineMs,
      subscriberIdentities: Object.freeze([...entry.subscriberIdentities]),
      subscriberCount: entry.subscribers.size,
      ...describeWorldGenerationPriority(entry.envelope, now, rankingOptions),
    });
    return Object.freeze({
      schemaVersion: OWNER_GENERATION_COORDINATOR_SCHEMA,
      isShutdown,
      maximumConcurrentRequests,
      agingIntervalMs,
      imminentWindowMs,
      queuedCount: queued.length,
      inFlightCount: inFlight.size,
      backlog: backlog(),
      maximumBacklog,
      queued: Object.freeze(ranked.map(describe)),
      inFlight: Object.freeze([...inFlight.values()].map(describe)),
      counts: Object.freeze({ ...counts }),
    });
  };

  const shutdown = async ({ reason = 'shutdown', awaitInFlight = false } = {}) => {
    if (!isShutdown) {
      isShutdown = true;
      for (const entry of [...active.values()]) {
        if (!entry.terminal && !entry.cancelRequested) {
          entry.cancelRequested = true;
          entry.cancellationReason = reason;
          if (entry.state === 'queued') {
            const index = queued.indexOf(entry);
            if (index >= 0) queued.splice(index, 1);
            counts.queuedCancelled += 1;
            settle(entry, 'cancelled');
          } else {
            counts.inFlightCancelled += 1;
            try { entry.onCancel?.(reason, entry.envelope); } catch { /* best effort */ }
          }
        }
      }
    }
    if (awaitInFlight && inFlight.size > 0) {
      await Promise.allSettled([...inFlight.values()].map(entry => entry.terminalPromise));
    }
  };

  return Object.freeze({
    schedule,
    snapshot,
    shutdown,
    get backlog() { return backlog(); },
    get isShutdown() { return isShutdown; },
  });
}

export function defaultOwnerGenerationPriorityClass({
  resourceKind,
  priority,
  required,
  firstVisibleDeadlineMs = null,
} = {}) {
  if (priority <= 2 || (resourceKind === 'full' && required
    && firstVisibleDeadlineMs !== null)) {
    return WORLD_GENERATION_PRIORITY_CLASS.DEADLINE_SAFETY;
  }
  if (!required || priority >= 5) return WORLD_GENERATION_PRIORITY_CLASS.PREFETCH;
  if (resourceKind === 'presentation') {
    return WORLD_GENERATION_PRIORITY_CLASS.COARSE_EXISTENCE;
  }
  if (priority === 3) return WORLD_GENERATION_PRIORITY_CLASS.GAMEPLAY_FULL;
  return WORLD_GENERATION_PRIORITY_CLASS.DETAIL;
}
