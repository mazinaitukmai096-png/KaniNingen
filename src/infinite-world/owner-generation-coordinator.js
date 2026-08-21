import {
  WORLD_GENERATION_PRIORITY_CLASS,
  WORLD_GENERATION_REPRESENTATION_CLASS,
  compareWorldGenerationRequests,
  createWorldGenerationRequestEnvelope,
  describeWorldGenerationPriority,
} from './world-generation-scheduler.js';

export const OWNER_GENERATION_COORDINATOR_SCHEMA = 'owner-generation-coordinator-1';
export const FIXED_LANE_OWNER_GENERATION_COORDINATOR_SCHEMA =
  'owner-generation-fixed-lanes-1';
export const OWNER_GENERATION_LANE = Object.freeze({
  CRITICAL: 'critical',
  BACKGROUND: 'background',
});

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
  shutdownDrainTimeoutMs = 1_000,
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
  if (!Number.isFinite(shutdownDrainTimeoutMs) || shutdownDrainTimeoutMs < 0) {
    throw new RangeError('shutdownDrainTimeoutMs must be a finite non-negative number');
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
  let shutdownPromise = null;
  let maximumBacklog = 0;
  let observerDisabled = false;
  let lastObserverFailure = null;
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
    cancelRequests: 0,
    cancelAcknowledgements: 0,
    preemptionRequests: 0,
    preemptionAcknowledgements: 0,
    cancelCallbackFailures: 0,
    shutdownDrainTimeouts: 0,
  };

  const emit = event => {
    if (!onEvent || observerDisabled) return;
    try {
      onEvent(Object.freeze(event));
    } catch (error) {
      observerDisabled = true;
      lastObserverFailure = Object.freeze({
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        observedAtMs: clock(),
      });
    }
  };
  const backlog = () => queued.length + inFlight.size;
  const rankingOptions = Object.freeze({ agingIntervalMs, imminentWindowMs });

  const settle = (entry, requestedState, value = null, error = null) => {
    if (entry.terminal) return;
    const cancellationCallbackError = entry.cancellationCallbackError;
    const state = cancellationCallbackError ? 'failed' : requestedState;
    const terminalError = cancellationCallbackError ?? error;
    const terminalAtMs = clock();
    if (state === 'cancelled' && entry.cancellationRequestedAtMs !== null
      && entry.cancellationAcknowledgedAtMs === null) {
      entry.cancellationAcknowledgedAtMs = terminalAtMs;
      counts.cancelAcknowledgements += 1;
      if (entry.preemptedByRequestId !== null) counts.preemptionAcknowledgements += 1;
      emit({
        type: 'cancel-acknowledged',
        envelope: entry.envelope,
        state,
        cancellationReason: entry.cancellationReason,
        cancellationRequestedAtMs: entry.cancellationRequestedAtMs,
        cancellationAcknowledgedAtMs: terminalAtMs,
        cancellationAcknowledgementMs: Math.max(
          0,
          terminalAtMs - entry.cancellationRequestedAtMs,
        ),
        preemptedByRequestId: entry.preemptedByRequestId,
        backlog: backlog(),
      });
    }
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
      for (const subscriber of entry.subscribers) subscriber.reject(terminalError);
    }
    entry.subscribers.clear();
    entry.resolveTerminal();
    emit({
      type: 'terminal',
      state,
      envelope: entry.envelope,
      error: state === 'failed' ? terminalError : null,
      cancellationCallbackError,
      cancellationReason: state === 'cancelled' ? entry.cancellationReason : null,
      cancellationRequestedAtMs: entry.cancellationRequestedAtMs,
      cancellationAcknowledgedAtMs: entry.cancellationAcknowledgedAtMs,
      cancellationAcknowledgementMs: entry.cancellationRequestedAtMs !== null
        && entry.cancellationAcknowledgedAtMs !== null
        ? Math.max(0, entry.cancellationAcknowledgedAtMs - entry.cancellationRequestedAtMs)
        : null,
      preemptedByRequestId: entry.preemptedByRequestId,
      terminalAtMs,
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
      get envelope() { return entry.envelope; },
      startedAtMs,
      ranking,
      get cancelled() { return entry.cancelRequested; },
    });
    Promise.resolve()
      .then(() => entry.execute(execution))
      .then(value => settle(
        entry,
        value === null ? 'cancelled' : 'completed',
        value,
      ))
      .catch(error => settle(entry, 'failed', null, error));
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

  const requestCancellation = (entry, reason, { preemptedByRequestId = null } = {}) => {
    if (!entry || entry.terminal || entry.cancelRequested) return false;
    const cancellationRequestedAtMs = clock();
    entry.cancelRequested = true;
    entry.cancellationReason = reason;
    entry.cancellationRequestedAtMs = cancellationRequestedAtMs;
    entry.preemptedByRequestId = preemptedByRequestId;
    counts.cancelRequests += 1;
    if (preemptedByRequestId !== null) counts.preemptionRequests += 1;
    emit({
      type: 'cancel-requested',
      envelope: entry.envelope,
      state: entry.state,
      cancellationReason: reason,
      cancellationRequestedAtMs,
      preemptedByRequestId,
      backlog: backlog(),
    });
    if (entry.state === 'queued') {
      const index = queued.indexOf(entry);
      if (index >= 0) queued.splice(index, 1);
      counts.queuedCancelled += 1;
      settle(entry, 'cancelled');
    } else {
      counts.inFlightCancelled += 1;
      try {
        entry.onCancel?.(reason, entry.envelope);
      } catch (error) {
        entry.cancellationCallbackError = error instanceof Error
          ? error : new Error(String(error));
        counts.cancelCallbackFailures += 1;
        emit({
          type: 'cancel-callback-failed',
          envelope: entry.envelope,
          state: entry.state,
          cancellationReason: reason,
          cancellationRequestedAtMs,
          preemptedByRequestId,
          error: entry.cancellationCallbackError,
          backlog: backlog(),
        });
      }
    }
    return true;
  };

  const preemptActiveFor = contender => {
    if (!contender.envelope.required || inFlight.size < maximumConcurrentRequests) return false;
    const timestamp = clock();
    const victim = [...inFlight.values()]
      .filter(entry => !entry.cancelRequested && !entry.envelope.required
        && compareWorldGenerationRequests(contender, entry, timestamp, rankingOptions) < 0)
      .sort((left, right) => compareWorldGenerationRequests(
        right,
        left,
        timestamp,
        rankingOptions,
      ))[0] ?? null;
    if (!victim) return false;
    return requestCancellation(
      victim,
      `preempted-by-higher-priority:${contender.envelope.requestId}`,
      { preemptedByRequestId: contender.envelope.requestId },
    );
  };

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
      consumerId: entry.state === 'queued' ? nextConsumerId : entry.envelope.consumerId,
      epoch: entry.state === 'queued' ? nextEpoch : entry.envelope.epoch,
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
    requestCancellation(entry, reason);
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
    requestId = null,
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
    const resolvedRequestId = requestId ?? requestSequence;
    if (!Number.isSafeInteger(resolvedRequestId) || resolvedRequestId < 1) {
      throw new RangeError('Owner generation requestId must be a positive safe integer');
    }
    if (active.has(resolvedRequestId)) {
      throw new Error(`duplicate Owner generation requestId: ${resolvedRequestId}`);
    }
    const subscriber = createSubscriber(subscriberIdentity);
    let resolveTerminal;
    const terminalPromise = new Promise(resolve => { resolveTerminal = resolve; });
    const subscriberIdentities = new Set(
      subscriberIdentity ? [subscriberIdentity] : [],
    );
    const entry = {
      envelope: createWorldGenerationRequestEnvelope({
        requestId: resolvedRequestId,
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
      cancellationRequestedAtMs: null,
      cancellationAcknowledgedAtMs: null,
      preemptedByRequestId: null,
      cancellationCallbackError: null,
      terminal: false,
    };
    active.set(resolvedRequestId, entry);
    activeByCompositeKey.set(compositeKey, entry);
    queued.push(entry);
    counts.scheduled += 1;
    maximumBacklog = Math.max(maximumBacklog, backlog());
    emit({ type: 'queued', envelope: entry.envelope, state: entry.state, backlog: backlog() });
    preemptActiveFor(entry);
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
      state: entry.state,
      cancelRequested: entry.cancelRequested,
      cancellationReason: entry.cancellationReason,
      cancellationRequestedAtMs: entry.cancellationRequestedAtMs,
      cancellationAcknowledgedAtMs: entry.cancellationAcknowledgedAtMs,
      preemptedByRequestId: entry.preemptedByRequestId,
      cancellationCallbackError: entry.cancellationCallbackError
        ? Object.freeze({
          name: entry.cancellationCallbackError.name,
          message: entry.cancellationCallbackError.message,
        }) : null,
      ...describeWorldGenerationPriority(entry.envelope, now, rankingOptions),
    });
    return Object.freeze({
      schemaVersion: OWNER_GENERATION_COORDINATOR_SCHEMA,
      isShutdown,
      maximumConcurrentRequests,
      agingIntervalMs,
      imminentWindowMs,
      shutdownDrainTimeoutMs,
      queuedCount: queued.length,
      inFlightCount: inFlight.size,
      backlog: backlog(),
      maximumBacklog,
      observerFailureCount: lastObserverFailure ? 1 : 0,
      observerCircuitBreaker: observerDisabled,
      lastObserverFailure,
      queued: Object.freeze(ranked.map(describe)),
      inFlight: Object.freeze([...inFlight.values()].map(describe)),
      counts: Object.freeze({ ...counts }),
    });
  };

  const shutdown = ({
    reason = 'shutdown',
    awaitInFlight = true,
    drainTimeoutMs = shutdownDrainTimeoutMs,
  } = {}) => {
    if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 0) {
      throw new RangeError('shutdown drainTimeoutMs must be a finite non-negative number');
    }
    if (shutdownPromise) return shutdownPromise;
    if (!isShutdown) {
      isShutdown = true;
      for (const entry of [...active.values()]) {
        requestCancellation(entry, reason);
      }
    }
    shutdownPromise = (async () => {
      if (!awaitInFlight || inFlight.size === 0) return true;
      let timeoutId = null;
      const drained = await Promise.race([
        Promise.allSettled([...inFlight.values()].map(entry => entry.terminalPromise))
          .then(() => true),
        new Promise(resolve => {
          timeoutId = globalThis.setTimeout?.(() => resolve(false), drainTimeoutMs) ?? null;
          if (timeoutId === null) resolve(false);
        }),
      ]);
      if (timeoutId !== null) globalThis.clearTimeout?.(timeoutId);
      if (!drained) counts.shutdownDrainTimeouts += 1;
      return drained;
    })();
    return shutdownPromise;
  };

  return Object.freeze({
    schedule,
    snapshot,
    shutdown,
    get backlog() { return backlog(); },
    get isShutdown() { return isShutdown; },
  });
}

function aggregateLaneCounts(left, right) {
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
 * Fixed two-lane owner admission. Full ChunkData (including future-Full
 * prefetch) is the only Critical-lane resource; all presentation/control work
 * stays on one Background lane. This is deliberately not a configurable pool.
 */
export function createFixedLaneOwnerGenerationCoordinator({
  clock = defaultClock,
  agingIntervalMs = 250,
  imminentWindowMs = 100,
  shutdownDrainTimeoutMs = 1_000,
  onEvent = null,
} = {}) {
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw new TypeError('Fixed-lane Owner generation onEvent must be a function');
  }

  let isShutdown = false;
  let nextRequestId = 0;
  const backgroundAdmissionWaiters = new Map();
  let critical = null;
  let criticalPrefetch = null;

  const emit = (lane, event) => {
    if (!onEvent) return;
    onEvent(Object.freeze({ ...event, lane }));
  };
  const criticalRequiredPending = () => {
    const snapshots = [critical?.snapshot(), criticalPrefetch?.snapshot()];
    return snapshots.flatMap(snapshot => [
      ...(snapshot?.queued ?? []),
      ...(snapshot?.inFlight ?? []),
    ])
      .some(entry => entry.required === true);
  };
  const releaseBackgroundAdmission = () => {
    if (criticalRequiredPending()) return;
    for (const resolve of backgroundAdmissionWaiters.values()) resolve();
    backgroundAdmissionWaiters.clear();
  };
  const waitForCriticalIdle = async requestId => {
    if (!criticalRequiredPending() || isShutdown) return;
    await new Promise(resolve => backgroundAdmissionWaiters.set(requestId, resolve));
    backgroundAdmissionWaiters.delete(requestId);
  };
  const commonOptions = {
    clock,
    agingIntervalMs,
    imminentWindowMs,
    shutdownDrainTimeoutMs,
  };
  critical = createOwnerGenerationCoordinator({
    ...commonOptions,
    maximumConcurrentRequests: 1,
    onEvent: event => {
      emit(OWNER_GENERATION_LANE.CRITICAL, event);
      if (event.type === 'terminal') scheduleMicrotask(releaseBackgroundAdmission);
    },
  });
  criticalPrefetch = createOwnerGenerationCoordinator({
    ...commonOptions,
    maximumConcurrentRequests: 1,
    onEvent: event => emit(OWNER_GENERATION_LANE.CRITICAL, event),
  });
  const background = createOwnerGenerationCoordinator({
    ...commonOptions,
    maximumConcurrentRequests: 1,
    onEvent: event => emit(OWNER_GENERATION_LANE.BACKGROUND, event),
  });

  const laneFor = options => options?.resourceKind === 'full'
    ? OWNER_GENERATION_LANE.CRITICAL : OWNER_GENERATION_LANE.BACKGROUND;
  const schedule = options => {
    if (isShutdown) throw new Error('Fixed-lane Owner generation coordinator is shut down');
    const lane = laneFor(options);
    const coordinator = lane === OWNER_GENERATION_LANE.CRITICAL
      ? options?.required === false ? criticalPrefetch : critical
      : background;
    const requestId = ++nextRequestId;
    const execute = options?.execute;
    const laneOptions = lane === OWNER_GENERATION_LANE.BACKGROUND ? {
      ...options,
      requestId,
      execute: async execution => {
        await waitForCriticalIdle(requestId);
        if (isShutdown || execution.cancelled) return null;
        return execute(execution);
      },
      onCancel: (reason, envelope) => {
        const release = backgroundAdmissionWaiters.get(requestId);
        if (release) {
          backgroundAdmissionWaiters.delete(requestId);
          release();
        }
        return options?.onCancel?.(reason, envelope);
      },
    } : { ...options, requestId };
    const handle = coordinator.schedule(laneOptions);
    return Object.freeze({
      requestId: handle.requestId,
      sequence: handle.sequence,
      lane,
      promise: handle.promise,
      cancel: handle.cancel,
      update: handle.update,
      get state() { return handle.state; },
      get envelope() { return handle.envelope; },
    });
  };
  const snapshot = () => {
    const criticalRequiredSnapshot = critical.snapshot();
    const criticalPrefetchSnapshot = criticalPrefetch.snapshot();
    const criticalSnapshot = Object.freeze({
      schemaVersion: FIXED_LANE_OWNER_GENERATION_COORDINATOR_SCHEMA,
      maximumConcurrentRequests: 2,
      queuedCount:
        criticalRequiredSnapshot.queuedCount + criticalPrefetchSnapshot.queuedCount,
      inFlightCount:
        criticalRequiredSnapshot.inFlightCount + criticalPrefetchSnapshot.inFlightCount,
      backlog: criticalRequiredSnapshot.backlog + criticalPrefetchSnapshot.backlog,
      maximumBacklog:
        criticalRequiredSnapshot.maximumBacklog + criticalPrefetchSnapshot.maximumBacklog,
      queued: Object.freeze([
        ...criticalRequiredSnapshot.queued,
        ...criticalPrefetchSnapshot.queued,
      ].sort((left, right) => left.requestId - right.requestId)),
      inFlight: Object.freeze([
        ...criticalRequiredSnapshot.inFlight,
        ...criticalPrefetchSnapshot.inFlight,
      ].sort((left, right) => left.requestId - right.requestId)),
      counts: aggregateLaneCounts(
        criticalRequiredSnapshot.counts,
        criticalPrefetchSnapshot.counts,
      ),
      subdivisions: Object.freeze({
        required: criticalRequiredSnapshot,
        prefetch: criticalPrefetchSnapshot,
      }),
    });
    const backgroundSnapshot = background.snapshot();
    const annotate = (lane, entries) => entries.map(entry => Object.freeze({ ...entry, lane }));
    const queued = [
      ...annotate(OWNER_GENERATION_LANE.CRITICAL, criticalSnapshot.queued),
      ...annotate(OWNER_GENERATION_LANE.BACKGROUND, backgroundSnapshot.queued),
    ].sort((left, right) => left.requestId - right.requestId);
    const inFlight = [
      ...annotate(OWNER_GENERATION_LANE.CRITICAL, criticalSnapshot.inFlight),
      ...annotate(OWNER_GENERATION_LANE.BACKGROUND, backgroundSnapshot.inFlight),
    ].sort((left, right) => left.requestId - right.requestId);
    return Object.freeze({
      schemaVersion: FIXED_LANE_OWNER_GENERATION_COORDINATOR_SCHEMA,
      isShutdown,
      maximumConcurrentRequests: 2,
      queuedCount: queued.length,
      inFlightCount: inFlight.length,
      backlog: queued.length + inFlight.length,
      maximumBacklog:
        criticalSnapshot.maximumBacklog + backgroundSnapshot.maximumBacklog,
      backgroundAdmissionSuppressed:
        backgroundAdmissionWaiters.size > 0 && criticalRequiredPending(),
      queued: Object.freeze(queued),
      inFlight: Object.freeze(inFlight),
      counts: aggregateLaneCounts(criticalSnapshot.counts, backgroundSnapshot.counts),
      lanes: Object.freeze({
        [OWNER_GENERATION_LANE.CRITICAL]: criticalSnapshot,
        [OWNER_GENERATION_LANE.BACKGROUND]: backgroundSnapshot,
      }),
    });
  };
  let shutdownPromise = null;
  const shutdown = ({
    reason = 'shutdown',
    awaitInFlight = true,
    drainTimeoutMs = shutdownDrainTimeoutMs,
  } = {}) => {
    if (shutdownPromise) return shutdownPromise;
    if (!isShutdown) {
      isShutdown = true;
      for (const resolve of backgroundAdmissionWaiters.values()) resolve();
      backgroundAdmissionWaiters.clear();
    }
    shutdownPromise = Promise.all([
      critical.shutdown({ reason, awaitInFlight, drainTimeoutMs }),
      criticalPrefetch.shutdown({ reason, awaitInFlight, drainTimeoutMs }),
      background.shutdown({ reason, awaitInFlight, drainTimeoutMs }),
    ]).then(results => results.every(Boolean));
    return shutdownPromise;
  };

  return Object.freeze({
    schedule,
    snapshot,
    shutdown,
    get backlog() { return critical.backlog + criticalPrefetch.backlog + background.backlog; },
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
