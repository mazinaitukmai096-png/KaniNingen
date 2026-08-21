export const WORLD_GENERATION_REQUEST_SCHEMA = 'world-generation-request-1';
export const WORLD_GENERATION_SCHEDULER_SCHEMA = 'world-generation-scheduler-1';

export const WORLD_GENERATION_PRIORITY_CLASS = Object.freeze({
  DEADLINE_SAFETY: 1,
  COARSE_EXISTENCE: 2,
  GAMEPLAY_FULL: 3,
  DETAIL: 4,
  PREFETCH: 5,
});

export const WORLD_GENERATION_REPRESENTATION_CLASS = Object.freeze({
  COARSE: 'coarse',
  DETAIL: 'detail',
});

export const WORLD_GENERATION_STATE = Object.freeze({
  QUEUED: 'queued',
  IN_FLIGHT: 'in-flight',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

const TERMINAL_STATES = new Set([
  WORLD_GENERATION_STATE.COMPLETED,
  WORLD_GENERATION_STATE.CANCELLED,
  WORLD_GENERATION_STATE.FAILED,
]);

const defaultClock = () => globalThis.performance?.now?.() ?? Date.now();
const scheduleMicrotask = callback => {
  if (typeof globalThis.queueMicrotask === 'function') globalThis.queueMicrotask(callback);
  else Promise.resolve().then(callback);
};

function requestKey(requestId) {
  if ((typeof requestId !== 'string' || !requestId)
    && (!Number.isSafeInteger(requestId) || requestId < 1)) {
    throw new TypeError('World generation requestId must be a non-empty string or positive safe integer');
  }
  return `${typeof requestId}:${requestId}`;
}

function optionalString(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function finiteTime(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite non-negative number`);
  return value;
}

export class WorldGenerationCancellationError extends Error {
  constructor(reason = 'cancelled') {
    super(`World generation cancelled: ${reason}`);
    this.name = 'WorldGenerationCancellationError';
    this.code = 'WORLD_GENERATION_CANCELLED';
    this.reason = reason;
  }
}

export function isWorldGenerationCancellation(error) {
  return error?.code === 'WORLD_GENERATION_CANCELLED';
}

export function createWorldGenerationRequestEnvelope({
  requestId,
  operationKind,
  priority,
  priorityClass = null,
  required = false,
  createdAtMs = 0,
  deadlineAtMs = null,
  firstVisibleDeadlineMs = deadlineAtMs,
  ownerKey = null,
  resourceKind = null,
  representationClass = null,
  sequence = null,
  subscriberIdentity = null,
  consumerId = null,
  epoch = 0,
  correlationId = null,
  target = null,
  stream = null,
} = {}) {
  requestKey(requestId);
  if (typeof operationKind !== 'string' || !operationKind) {
    throw new TypeError('World generation operationKind is required');
  }
  if (!Number.isSafeInteger(priority) || priority < 1 || priority > 5) {
    throw new RangeError('World generation priority must be an integer from 1 through 5');
  }
  if (priorityClass !== null
    && (!Number.isSafeInteger(priorityClass) || priorityClass < 1 || priorityClass > 5)) {
    throw new RangeError('World generation priorityClass must be null or an integer from 1 through 5');
  }
  if (typeof required !== 'boolean') throw new TypeError('World generation required must be boolean');
  const normalizedCreatedAtMs = finiteTime(createdAtMs, 'createdAtMs');
  const normalizedDeadlineAtMs = finiteTime(deadlineAtMs, 'deadlineAtMs', { nullable: true });
  const normalizedFirstVisibleDeadlineMs = finiteTime(
    firstVisibleDeadlineMs,
    'firstVisibleDeadlineMs',
    { nullable: true },
  );
  if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 1)) {
    throw new RangeError('World generation sequence must be null or a positive safe integer');
  }
  if (representationClass !== null
    && !Object.values(WORLD_GENERATION_REPRESENTATION_CLASS).includes(representationClass)) {
    throw new RangeError(`unknown World generation representationClass: ${representationClass}`);
  }
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new RangeError('World generation epoch must be a non-negative safe integer');
  }
  return Object.freeze({
    schemaVersion: WORLD_GENERATION_REQUEST_SCHEMA,
    requestId,
    operationKind,
    priority,
    priorityClass,
    required,
    createdAtMs: normalizedCreatedAtMs,
    deadlineAtMs: normalizedDeadlineAtMs,
    firstVisibleDeadlineMs: normalizedFirstVisibleDeadlineMs,
    ownerKey: optionalString(ownerKey, 'ownerKey'),
    resourceKind: optionalString(resourceKind, 'resourceKind'),
    representationClass,
    sequence,
    subscriberIdentity: optionalString(subscriberIdentity, 'subscriberIdentity'),
    consumerId: optionalString(consumerId, 'consumerId'),
    epoch,
    correlationId: optionalString(correlationId, 'correlationId'),
    target: optionalString(target, 'target'),
    stream: optionalString(stream, 'stream'),
  });
}

export function normalizeWorldGenerationRequestEnvelope(value, defaults = {}) {
  if (value?.schemaVersion === WORLD_GENERATION_REQUEST_SCHEMA) {
    return createWorldGenerationRequestEnvelope(value);
  }
  return createWorldGenerationRequestEnvelope({ ...defaults, ...(value ?? {}) });
}

export function describeWorldGenerationPriority(envelope, nowMs, {
  agingIntervalMs = 250,
  imminentWindowMs = 100,
} = {}) {
  const normalized = normalizeWorldGenerationRequestEnvelope(envelope);
  const now = finiteTime(nowMs, 'nowMs');
  if (!Number.isFinite(agingIntervalMs) || agingIntervalMs <= 0) {
    throw new RangeError('agingIntervalMs must be positive');
  }
  if (!Number.isFinite(imminentWindowMs) || imminentWindowMs < 0) {
    throw new RangeError('imminentWindowMs must be non-negative');
  }
  const queueTimeMs = Math.max(0, now - normalized.createdAtMs);
  const agingSteps = Math.floor(queueTimeMs / agingIntervalMs);
  const requiredBoost = normalized.required && normalized.priority > 3 ? 1 : 0;
  const effectivePriority = Math.max(1, normalized.priority - agingSteps - requiredBoost);
  const visibleDeadline = normalized.firstVisibleDeadlineMs ?? normalized.deadlineAtMs;
  const deadlineMiss = visibleDeadline !== null && now > visibleDeadline;
  const deadlineImminent = visibleDeadline !== null
    && visibleDeadline >= now
    && visibleDeadline - now <= imminentWindowMs;
  return Object.freeze({
    queueTimeMs,
    agingSteps,
    requiredBoost,
    effectivePriority,
    deadlineMiss,
    deadlineImminent,
    deadlineUrgent: deadlineMiss || deadlineImminent,
  });
}

export function compareWorldGenerationRequests(left, right, nowMs, options = {}) {
  const leftEnvelope = left.envelope ?? left.scheduler ?? left;
  const rightEnvelope = right.envelope ?? right.scheduler ?? right;
  const leftRank = describeWorldGenerationPriority(leftEnvelope, nowMs, options);
  const rightRank = describeWorldGenerationPriority(rightEnvelope, nowMs, options);
  const usesGlobalContract = leftEnvelope.priorityClass != null
    || rightEnvelope.priorityClass != null;
  if (usesGlobalContract) {
    const leftClass = leftEnvelope.priorityClass ?? leftEnvelope.priority;
    const rightClass = rightEnvelope.priorityClass ?? rightEnvelope.priority;
    if (leftClass !== rightClass) return leftClass - rightClass;
    // Deadline urgency and aging refine order only inside a semantic class.
    // Otherwise an overdue optional prefetch could invert the global contract
    // and jump ahead of fresh safety, coarse-existence, or gameplay work.
    if (leftRank.deadlineUrgent !== rightRank.deadlineUrgent) {
      return leftRank.deadlineUrgent ? -1 : 1;
    }
    if (leftRank.effectivePriority !== rightRank.effectivePriority) {
      return leftRank.effectivePriority - rightRank.effectivePriority;
    }
  } else {
    if (leftRank.deadlineMiss !== rightRank.deadlineMiss) return leftRank.deadlineMiss ? -1 : 1;
    if (leftRank.effectivePriority !== rightRank.effectivePriority) {
      return leftRank.effectivePriority - rightRank.effectivePriority;
    }
  }
  const leftDeadline = leftEnvelope.firstVisibleDeadlineMs
    ?? leftEnvelope.deadlineAtMs
    ?? Number.POSITIVE_INFINITY;
  const rightDeadline = rightEnvelope.firstVisibleDeadlineMs
    ?? rightEnvelope.deadlineAtMs
    ?? Number.POSITIVE_INFINITY;
  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
  const leftSequence = left.sequence ?? leftEnvelope.sequence ?? 0;
  const rightSequence = right.sequence ?? rightEnvelope.sequence ?? 0;
  return leftSequence - rightSequence;
}

export function createWorldGenerationScheduler({
  clock = defaultClock,
  agingIntervalMs = 250,
  terminalRetentionMs = 5_000,
  terminalCapacity = 512,
  shutdownDrainTimeoutMs = 1_000,
  onEvent = null,
} = {}) {
  if (typeof clock !== 'function') throw new TypeError('World generation scheduler clock is required');
  if (!Number.isFinite(agingIntervalMs) || agingIntervalMs <= 0) {
    throw new RangeError('agingIntervalMs must be positive');
  }
  if (!Number.isFinite(terminalRetentionMs) || terminalRetentionMs < 0) {
    throw new RangeError('terminalRetentionMs must be non-negative');
  }
  if (!Number.isSafeInteger(terminalCapacity) || terminalCapacity < 1) {
    throw new RangeError('terminalCapacity must be a positive safe integer');
  }
  if (!Number.isFinite(shutdownDrainTimeoutMs) || shutdownDrainTimeoutMs < 0) {
    throw new RangeError('shutdownDrainTimeoutMs must be a finite non-negative number');
  }
  if (onEvent !== null && typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');

  const queued = [];
  const active = new Map();
  const terminal = new Map();
  let inFlight = null;
  let sequence = 0;
  let dispatchScheduled = false;
  let isShutdown = false;
  let shutdownPromise = null;
  let drainResolve = null;
  let maximumBacklog = 0;
  let observerDisabled = false;
  let lastObserverFailure = null;
  const counts = {
    scheduled: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    queuedCancelled: 0,
    inFlightCancelled: 0,
    deadlineMisses: 0,
    agedStarts: 0,
    agingSteps: 0,
    cancelRequests: 0,
    checkpointCancelAcknowledgements: 0,
    cancellationsSettledWithoutCheckpoint: 0,
    preemptionRequests: 0,
    preemptionAcknowledgements: 0,
    shutdownDrainTimeouts: 0,
  };

  const now = () => finiteTime(Number(clock()), 'scheduler clock');
  const emit = event => {
    if (!onEvent || observerDisabled) return;
    try {
      onEvent(Object.freeze(event));
    } catch (error) {
      observerDisabled = true;
      lastObserverFailure = Object.freeze({
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        observedAtMs: now(),
      });
    }
  };
  const pruneTerminal = timestamp => {
    for (const [key, value] of terminal) {
      if (timestamp - value.terminalAtMs <= terminalRetentionMs) break;
      terminal.delete(key);
    }
    while (terminal.size > terminalCapacity) terminal.delete(terminal.keys().next().value);
  };
  const backlog = () => queued.length + (inFlight ? 1 : 0);
  const resolveDrainIfIdle = () => {
    if (active.size !== 0 || queued.length !== 0 || inFlight !== null) return;
    drainResolve?.();
    drainResolve = null;
  };
  const transitionTerminal = (entry, state, {
    value = null,
    error = null,
    reason = null,
  } = {}) => {
    if (TERMINAL_STATES.has(entry.state)) return;
    const terminalAtMs = now();
    if (state === WORLD_GENERATION_STATE.CANCELLED
      && entry.cancellationRequestedAtMs !== null
      && entry.cancellationAcknowledgedAtMs === null) {
      entry.cancellationAcknowledgedAtMs = terminalAtMs;
      counts.cancellationsSettledWithoutCheckpoint += 1;
    }
    entry.state = state;
    entry.terminalAtMs = terminalAtMs;
    entry.cancellationReason = reason;
    active.delete(entry.key);
    if (inFlight === entry) inFlight = null;
    if (state === WORLD_GENERATION_STATE.COMPLETED) counts.completed += 1;
    else if (state === WORLD_GENERATION_STATE.CANCELLED) counts.cancelled += 1;
    else counts.failed += 1;
    const deadlineMiss = entry.envelope.deadlineAtMs !== null
      && terminalAtMs > entry.envelope.deadlineAtMs;
    const result = Object.freeze({
      requestId: entry.envelope.requestId,
      operationKind: entry.envelope.operationKind,
      state,
      value: state === WORLD_GENERATION_STATE.COMPLETED ? value : null,
      error: state === WORLD_GENERATION_STATE.FAILED ? error : null,
      cancellationReason: state === WORLD_GENERATION_STATE.CANCELLED ? reason : null,
      cancellationRequestedAtMs: entry.cancellationRequestedAtMs,
      cancellationAcknowledgedAtMs: entry.cancellationAcknowledgedAtMs,
      cancellationAcknowledgementMs: entry.cancellationRequestedAtMs !== null
        && entry.cancellationAcknowledgedAtMs !== null
        ? Math.max(0, entry.cancellationAcknowledgedAtMs - entry.cancellationRequestedAtMs)
        : null,
      cancellationAcknowledgedAtCheckpoint: entry.cancellationAcknowledgedAtCheckpoint,
      cancellationCheckpointSite: entry.cancellationCheckpointSite,
      preemptedByRequestId: entry.preemptedByRequestId,
      queuedAtMs: entry.queuedAtMs,
      startedAtMs: entry.startedAtMs,
      terminalAtMs,
      queueTimeMs: entry.startedAtMs === null ? null : entry.startedAtMs - entry.queuedAtMs,
      deadlineMiss,
      priorityAgingSteps: entry.priorityAgingSteps,
      backlogAtStart: entry.backlogAtStart,
    });
    const terminalRecord = Object.freeze({
      requestId: result.requestId,
      operationKind: result.operationKind,
      state: result.state,
      cancellationReason: result.cancellationReason,
      cancellationRequestedAtMs: result.cancellationRequestedAtMs,
      cancellationAcknowledgedAtMs: result.cancellationAcknowledgedAtMs,
      cancellationAcknowledgementMs: result.cancellationAcknowledgementMs,
      cancellationAcknowledgedAtCheckpoint: result.cancellationAcknowledgedAtCheckpoint,
      cancellationCheckpointSite: result.cancellationCheckpointSite,
      preemptedByRequestId: result.preemptedByRequestId,
      errorName: error?.name ?? null,
      errorMessage: error?.message ?? null,
      queuedAtMs: result.queuedAtMs,
      startedAtMs: result.startedAtMs,
      terminalAtMs: result.terminalAtMs,
      queueTimeMs: result.queueTimeMs,
      deadlineMiss: result.deadlineMiss,
      priorityAgingSteps: result.priorityAgingSteps,
      backlogAtStart: result.backlogAtStart,
    });
    terminal.set(entry.key, terminalRecord);
    pruneTerminal(terminalAtMs);
    emit({
      type: 'terminal',
      envelope: entry.envelope,
      ...terminalRecord,
      error: state === WORLD_GENERATION_STATE.FAILED ? error : null,
      backlog: backlog(),
    });
    entry.resolve(result);
    resolveDrainIfIdle();
    scheduleDispatch();
  };
  const start = entry => {
    const startedAtMs = now();
    const ranking = describeWorldGenerationPriority(entry.envelope, startedAtMs, { agingIntervalMs });
    entry.state = WORLD_GENERATION_STATE.IN_FLIGHT;
    entry.startedAtMs = startedAtMs;
    entry.priorityAgingSteps = ranking.agingSteps;
    entry.backlogAtStart = backlog();
    inFlight = entry;
    counts.started += 1;
    counts.agingSteps += ranking.agingSteps;
    if (ranking.agingSteps > 0) counts.agedStarts += 1;
    if (ranking.deadlineMiss) counts.deadlineMisses += 1;
    emit({
      type: 'started',
      envelope: entry.envelope,
      state: entry.state,
      startedAtMs,
      queueTimeMs: ranking.queueTimeMs,
      effectivePriority: ranking.effectivePriority,
      priorityAgingSteps: ranking.agingSteps,
      deadlineMiss: ranking.deadlineMiss,
      backlog: entry.backlogAtStart,
    });
    const signal = Object.freeze({
      get aborted() { return entry.cancelRequested; },
      get reason() { return entry.cancellationReason; },
    });
    const acknowledgeCancellationAtCheckpoint = details => {
      if (entry.cancellationAcknowledgedAtMs !== null) return;
      const acknowledgedAtMs = now();
      entry.cancellationAcknowledgedAtMs = acknowledgedAtMs;
      entry.cancellationAcknowledgedAtCheckpoint = true;
      entry.cancellationCheckpointSite = details?.site ?? null;
      counts.checkpointCancelAcknowledgements += 1;
      if (entry.preemptedByRequestId !== null) counts.preemptionAcknowledgements += 1;
      emit({
        type: 'cancel-acknowledged',
        envelope: entry.envelope,
        state: entry.state,
        cancellationReason: entry.cancellationReason,
        cancellationRequestedAtMs: entry.cancellationRequestedAtMs,
        cancellationAcknowledgedAtMs: acknowledgedAtMs,
        cancellationAcknowledgementMs: entry.cancellationRequestedAtMs === null
          ? null : Math.max(0, acknowledgedAtMs - entry.cancellationRequestedAtMs),
        cancellationAcknowledgedAtCheckpoint: true,
        cancellationCheckpointSite: entry.cancellationCheckpointSite,
        preemptedByRequestId: entry.preemptedByRequestId,
        backlog: backlog(),
      });
    };
    const checkpoint = (details = null) => {
      if (entry.cancelRequested) {
        acknowledgeCancellationAtCheckpoint(details);
        throw new WorldGenerationCancellationError(entry.cancellationReason);
      }
    };
    const executionContext = Object.freeze({
      signal,
      checkpoint,
      envelope: entry.envelope,
      startedAtMs,
      queueTimeMs: ranking.queueTimeMs,
      effectivePriority: ranking.effectivePriority,
      priorityAgingSteps: ranking.agingSteps,
      deadlineMiss: ranking.deadlineMiss,
      backlogAtStart: entry.backlogAtStart,
    });
    Promise.resolve()
      .then(() => { checkpoint(); return entry.execute(executionContext); })
      .then(value => { checkpoint(); transitionTerminal(entry, WORLD_GENERATION_STATE.COMPLETED, { value }); })
      .catch(error => {
        if (entry.cancellationCallbackError) {
          transitionTerminal(entry, WORLD_GENERATION_STATE.FAILED, {
            error: entry.cancellationCallbackError,
          });
        } else if (isWorldGenerationCancellation(error) && entry.cancelRequested) {
          transitionTerminal(entry, WORLD_GENERATION_STATE.CANCELLED, {
            reason: entry.cancellationReason ?? error?.reason ?? 'cancelled',
          });
        } else {
          transitionTerminal(entry, WORLD_GENERATION_STATE.FAILED, { error });
        }
      });
  };
  const dispatch = () => {
    dispatchScheduled = false;
    if (inFlight || isShutdown) return;
    const timestamp = now();
    queued.sort((left, right) => compareWorldGenerationRequests(
      left,
      right,
      timestamp,
      { agingIntervalMs },
    ));
    const entry = queued.shift();
    if (!entry) { resolveDrainIfIdle(); return; }
    start(entry);
  };
  function scheduleDispatch() {
    if (dispatchScheduled || inFlight || isShutdown || queued.length === 0) return;
    dispatchScheduled = true;
    scheduleMicrotask(dispatch);
  }
  const cancelEntry = (entry, reason, { preemptedByRequestId = null } = {}) => {
    if (!entry || TERMINAL_STATES.has(entry.state) || entry.cancelRequested) return false;
    const cancellationRequestedAtMs = now();
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
    if (entry.state === WORLD_GENERATION_STATE.QUEUED) {
      const index = queued.indexOf(entry);
      if (index >= 0) queued.splice(index, 1);
      counts.queuedCancelled += 1;
      transitionTerminal(entry, WORLD_GENERATION_STATE.CANCELLED, { reason });
    } else {
      counts.inFlightCancelled += 1;
      try {
        entry.onCancel?.(reason, entry.envelope);
      } catch (error) {
        entry.cancellationCallbackError = error instanceof Error
          ? error : new Error(String(error));
        emit({
          type: 'cancel-callback-failed',
          envelope: entry.envelope,
          state: entry.state,
          cancellationReason: reason,
          cancellationRequestedAtMs,
          error: entry.cancellationCallbackError,
          backlog: backlog(),
        });
      }
    }
    return true;
  };
  const preemptActiveFor = contender => {
    if (!inFlight || inFlight.cancelRequested || inFlight.envelope.required
      || !contender.envelope.required) return false;
    const timestamp = now();
    if (compareWorldGenerationRequests(
      contender,
      inFlight,
      timestamp,
      { agingIntervalMs },
    ) >= 0) return false;
    return cancelEntry(
      inFlight,
      `preempted-by-higher-priority:${contender.envelope.requestId}`,
      { preemptedByRequestId: contender.envelope.requestId },
    );
  };

  const schedule = ({ envelope, execute, onCancel = null } = {}) => {
    if (typeof execute !== 'function') throw new TypeError('World generation execute is required');
    if (onCancel !== null && typeof onCancel !== 'function') throw new TypeError('onCancel must be a function');
    const normalized = normalizeWorldGenerationRequestEnvelope(envelope);
    const key = requestKey(normalized.requestId);
    if (isShutdown) throw new Error('World generation scheduler is shut down');
    const queuedAtMs = now();
    pruneTerminal(queuedAtMs);
    if (active.has(key) || terminal.has(key)) throw new Error(`duplicate World generation requestId: ${normalized.requestId}`);
    let resolve;
    const promise = new Promise(nextResolve => { resolve = nextResolve; });
    const entry = {
      key,
      envelope: normalized,
      execute,
      onCancel,
      resolve,
      promise,
      sequence: ++sequence,
      state: WORLD_GENERATION_STATE.QUEUED,
      queuedAtMs,
      startedAtMs: null,
      terminalAtMs: null,
      cancelRequested: false,
      cancellationReason: null,
      cancellationRequestedAtMs: null,
      cancellationAcknowledgedAtMs: null,
      cancellationAcknowledgedAtCheckpoint: false,
      cancellationCheckpointSite: null,
      preemptedByRequestId: null,
      cancellationCallbackError: null,
      priorityAgingSteps: 0,
      backlogAtStart: null,
    };
    active.set(key, entry);
    queued.push(entry);
    counts.scheduled += 1;
    maximumBacklog = Math.max(maximumBacklog, backlog());
    emit({
      type: 'queued', envelope: normalized, state: entry.state,
      queuedAtMs, backlog: backlog(),
    });
    preemptActiveFor(entry);
    scheduleDispatch();
    return Object.freeze({
      requestId: normalized.requestId,
      promise,
      cancel: reason => cancelEntry(entry, reason ?? 'cancelled'),
      get state() { return entry.state; },
    });
  };

  const cancel = ({
    requestId,
    reason = 'cancelled',
    preemptedByRequestId = null,
  } = {}) => (
    cancelEntry(active.get(requestKey(requestId)), reason, { preemptedByRequestId })
  );
  const cancelWhere = (predicate, reason = 'cancelled') => {
    if (typeof predicate !== 'function') throw new TypeError('cancelWhere predicate is required');
    let cancelled = 0;
    for (const entry of [...active.values()]) {
      if (predicate(entry.envelope) && cancelEntry(entry, reason)) cancelled += 1;
    }
    return cancelled;
  };
  const snapshot = () => {
    const timestamp = now();
    pruneTerminal(timestamp);
    const ranked = [...queued].sort((left, right) => compareWorldGenerationRequests(
      left,
      right,
      timestamp,
      { agingIntervalMs },
    ));
    return Object.freeze({
      schemaVersion: WORLD_GENERATION_SCHEDULER_SCHEMA,
      workerCount: 1,
      isShutdown,
      agingIntervalMs,
      terminalRetentionMs,
      terminalCapacity,
      shutdownDrainTimeoutMs,
      queuedCount: queued.length,
      inFlightCount: inFlight ? 1 : 0,
      inFlightRequestId: inFlight?.envelope.requestId ?? null,
      inFlight: inFlight ? Object.freeze({
        requestId: inFlight.envelope.requestId,
        operationKind: inFlight.envelope.operationKind,
        priority: inFlight.envelope.priority,
        priorityClass: inFlight.envelope.priorityClass,
        required: inFlight.envelope.required,
        startedAtMs: inFlight.startedAtMs,
        cancelRequested: inFlight.cancelRequested,
        cancellationReason: inFlight.cancellationReason,
        cancellationRequestedAtMs: inFlight.cancellationRequestedAtMs,
        cancellationAcknowledgedAtMs: inFlight.cancellationAcknowledgedAtMs,
        preemptedByRequestId: inFlight.preemptedByRequestId,
      }) : null,
      backlog: backlog(),
      maximumBacklog,
      observerFailureCount: lastObserverFailure ? 1 : 0,
      observerCircuitBreaker: observerDisabled,
      lastObserverFailure,
      queued: Object.freeze(ranked.map(entry => Object.freeze({
        requestId: entry.envelope.requestId,
        operationKind: entry.envelope.operationKind,
        priority: entry.envelope.priority,
        required: entry.envelope.required,
        ...describeWorldGenerationPriority(entry.envelope, timestamp, { agingIntervalMs }),
      }))),
      terminal: Object.freeze([...terminal.values()]),
      counts: Object.freeze({ ...counts }),
    });
  };
  const shutdown = ({
    reason = 'shutdown',
    cancelInFlight = true,
    drainTimeoutMs = shutdownDrainTimeoutMs,
  } = {}) => {
    if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 0) {
      throw new RangeError('shutdown drainTimeoutMs must be a finite non-negative number');
    }
    if (shutdownPromise) return shutdownPromise;
    if (!isShutdown) {
      isShutdown = true;
      for (const entry of [...active.values()]) {
        if (entry.state === WORLD_GENERATION_STATE.QUEUED || cancelInFlight) {
          cancelEntry(entry, reason);
        }
      }
    }
    shutdownPromise = (async () => {
      if (active.size === 0 && !inFlight) return true;
      let timeoutId = null;
      const drained = await Promise.race([
        new Promise(resolve => {
          drainResolve = () => resolve(true);
          resolveDrainIfIdle();
        }),
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

  return Object.freeze({ schedule, cancel, cancelWhere, snapshot, shutdown });
}
