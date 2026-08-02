export const WORLD_STREAMING_TELEMETRY_SCHEMA = 'world-streaming-event-1';

export const WORLD_STREAMING_EVENT = Object.freeze({
  REQUEST: 'request',
  CACHE_HIT: 'cache-hit',
  CACHE_MISS: 'cache-miss',
  WORKER_START: 'worker-start',
  WORKER_COMPLETE: 'worker-complete',
  PUBLISH: 'publish',
  FIRST_DRAW: 'first-draw',
  PLAYER_ARRIVAL: 'player-arrival',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

export const WORLD_STREAMING_TARGET = Object.freeze({
  TREE: 'tree',
  BUSH: 'bush',
  GRASS: 'grass',
  ROCK: 'rock',
  BUILDING: 'building',
  SETTLEMENT: 'settlement',
  NEAR: 'near',
  DISTANT: 'distant',
  GAMEPLAY: 'gameplay',
});

export const WORLD_STREAMING_STREAM = Object.freeze({
  NEAR: 'near',
  DISTANT: 'distant',
  GAMEPLAY: 'gameplay',
});

export const WORLD_STREAMING_NATURAL_TARGETS = Object.freeze([
  WORLD_STREAMING_TARGET.TREE,
  WORLD_STREAMING_TARGET.BUSH,
  WORLD_STREAMING_TARGET.GRASS,
  WORLD_STREAMING_TARGET.ROCK,
]);

const EVENT_TYPES = new Set(Object.values(WORLD_STREAMING_EVENT));
const TARGETS = new Set(Object.values(WORLD_STREAMING_TARGET));
const STREAMS = new Set(Object.values(WORLD_STREAMING_STREAM));
const TERMINAL_EVENTS = new Set([
  WORLD_STREAMING_EVENT.CANCELLED,
  WORLD_STREAMING_EVENT.FAILED,
]);
const EVENT_ORDER = Object.freeze({
  [WORLD_STREAMING_EVENT.REQUEST]: 0,
  [WORLD_STREAMING_EVENT.CACHE_HIT]: 1,
  [WORLD_STREAMING_EVENT.CACHE_MISS]: 1,
  [WORLD_STREAMING_EVENT.WORKER_START]: 2,
  [WORLD_STREAMING_EVENT.WORKER_COMPLETE]: 3,
  [WORLD_STREAMING_EVENT.PUBLISH]: 4,
  [WORLD_STREAMING_EVENT.FIRST_DRAW]: 5,
  [WORLD_STREAMING_EVENT.PLAYER_ARRIVAL]: 6,
});

const EMPTY_ARRAY = Object.freeze([]);
const DISABLED_SNAPSHOT = Object.freeze({
  schemaVersion: WORLD_STREAMING_TELEMETRY_SCHEMA,
  enabled: false,
  capacity: 0,
  size: 0,
  droppedEventCount: 0,
  orderViolationCount: 0,
  resourceIndexSize: 0,
  events: EMPTY_ARRAY,
  lifecycles: EMPTY_ARRAY,
});

const DISABLED_TELEMETRY = Object.freeze({
  enabled: false,
  beginRequest: () => null,
  record: () => null,
  resolveCorrelation: () => null,
  snapshot: () => DISABLED_SNAPSHOT,
  clear: () => {},
  dispose: () => {},
});

const defaultClock = () => globalThis.performance?.now?.() ?? Date.now();

const percentileOf = (values, ratio) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
};

function summarizeAcceptanceSamples(samples) {
  const requestToReady = samples.map(sample => sample.requestToReadyMs).filter(Number.isFinite);
  const workerToPublish = samples.map(sample => sample.workerToPublishMs).filter(Number.isFinite);
  const requestToFirstDraw = samples.map(sample => sample.requestToFirstDrawMs).filter(Number.isFinite);
  return Object.freeze({
    requestToReadyCount: requestToReady.length,
    requestToReadyP50Ms: percentileOf(requestToReady, 0.5),
    requestToReadyP95Ms: percentileOf(requestToReady, 0.95),
    requestToReadyMaximumMs: Math.max(0, ...requestToReady),
    workerToPublishCount: workerToPublish.length,
    workerToPublishP50Ms: percentileOf(workerToPublish, 0.5),
    workerToPublishP95Ms: percentileOf(workerToPublish, 0.95),
    workerToPublishMaximumMs: Math.max(0, ...workerToPublish),
    requestToFirstDrawCount: requestToFirstDraw.length,
    requestToFirstDrawP50Ms: percentileOf(requestToFirstDraw, 0.5),
    requestToFirstDrawP95Ms: percentileOf(requestToFirstDraw, 0.95),
    requestToFirstDrawMaximumMs: Math.max(0, ...requestToFirstDraw),
    playerArrivalMissingCount: samples.filter(sample => sample.playerArrivalMissing).length,
  });
}

export function collectWorldStreamingAcceptanceMetrics(snapshot, {
  targets = WORLD_STREAMING_NATURAL_TARGETS,
  stream = WORLD_STREAMING_STREAM.DISTANT,
} = {}) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const targetSet = new Set(targets);
  const sharedByResource = new Map();
  const samplesByTarget = new Map(targets.map(target => [target, []]));
  const activeSampleByTargetResource = new Map();
  for (const event of events) {
    if (event.stream !== stream || typeof event.resourceKey !== 'string') continue;
    let shared = sharedByResource.get(event.resourceKey);
    if (!shared) {
      shared = { requestAtMs: null, readyAtMs: null, workerCompleteAtMs: null };
      sharedByResource.set(event.resourceKey, shared);
    }
    if (event.type === WORLD_STREAMING_EVENT.REQUEST) shared.requestAtMs = event.timestampMs;
    if (event.type === WORLD_STREAMING_EVENT.CACHE_HIT && shared.readyAtMs === null) {
      shared.readyAtMs = event.timestampMs;
    }
    if (event.type === WORLD_STREAMING_EVENT.WORKER_COMPLETE) {
      shared.workerCompleteAtMs = event.timestampMs;
      shared.readyAtMs = event.timestampMs;
    }
    if (!targetSet.has(event.target)) continue;
    const sampleKey = `${event.target}\n${event.resourceKey}`;
    let sample = activeSampleByTargetResource.get(sampleKey);
    if (event.type === WORLD_STREAMING_EVENT.PUBLISH) {
      sample = {
        resourceKey: event.resourceKey,
        requestAtMs: shared.requestAtMs,
        readyAtMs: shared.readyAtMs,
        workerCompleteAtMs: shared.workerCompleteAtMs,
        publishAtMs: event.timestampMs,
        firstDrawAtMs: null,
        playerArrivalAtMs: null,
      };
      samplesByTarget.get(event.target).push(sample);
      activeSampleByTargetResource.set(sampleKey, sample);
    }
    if (event.type === WORLD_STREAMING_EVENT.FIRST_DRAW && sample) {
      sample.firstDrawAtMs = event.timestampMs;
    }
    if (event.type === WORLD_STREAMING_EVENT.PLAYER_ARRIVAL) {
      if (!sample) {
        sample = {
          resourceKey: event.resourceKey,
          requestAtMs: shared.requestAtMs,
          readyAtMs: shared.readyAtMs,
          workerCompleteAtMs: shared.workerCompleteAtMs,
          publishAtMs: null,
          firstDrawAtMs: null,
          playerArrivalAtMs: null,
        };
        samplesByTarget.get(event.target).push(sample);
        activeSampleByTargetResource.set(sampleKey, sample);
      }
      sample.playerArrivalAtMs = event.timestampMs;
    }
  }
  const resolvedByTarget = Object.freeze(Object.fromEntries(targets.map(target => {
    const resolved = samplesByTarget.get(target).map(sample => Object.freeze({
        requestToReadyMs: Number.isFinite(sample.requestAtMs)
          && Number.isFinite(sample.readyAtMs)
          ? Math.max(0, sample.readyAtMs - sample.requestAtMs) : null,
        workerToPublishMs: Number.isFinite(sample.workerCompleteAtMs)
          && Number.isFinite(sample.publishAtMs)
          ? Math.max(0, sample.publishAtMs - sample.workerCompleteAtMs) : null,
        requestToFirstDrawMs: Number.isFinite(sample.requestAtMs)
          && Number.isFinite(sample.firstDrawAtMs)
          ? Math.max(0, sample.firstDrawAtMs - sample.requestAtMs) : null,
        playerArrivalMissing: Number.isFinite(sample.playerArrivalAtMs)
          && (!Number.isFinite(sample.firstDrawAtMs)
            || sample.firstDrawAtMs > sample.playerArrivalAtMs),
      }));
    return [target, summarizeAcceptanceSamples(resolved)];
  })));
  const aggregateSamples = [];
  for (const target of targets) {
    for (const sample of samplesByTarget.get(target)) {
      aggregateSamples.push({
        requestToReadyMs: Number.isFinite(sample.requestAtMs)
          && Number.isFinite(sample.readyAtMs)
          ? Math.max(0, sample.readyAtMs - sample.requestAtMs) : null,
        workerToPublishMs: Number.isFinite(sample.workerCompleteAtMs)
          && Number.isFinite(sample.publishAtMs)
          ? Math.max(0, sample.publishAtMs - sample.workerCompleteAtMs) : null,
        requestToFirstDrawMs: Number.isFinite(sample.requestAtMs)
          && Number.isFinite(sample.firstDrawAtMs)
          ? Math.max(0, sample.firstDrawAtMs - sample.requestAtMs) : null,
        playerArrivalMissing: Number.isFinite(sample.playerArrivalAtMs)
          && (!Number.isFinite(sample.firstDrawAtMs)
            || sample.firstDrawAtMs > sample.playerArrivalAtMs),
      });
    }
  }
  const natural = summarizeAcceptanceSamples(aggregateSamples);
  return Object.freeze({
    schemaVersion: 'world-streaming-acceptance-1',
    targets: Object.freeze([...targets]),
    byTarget: resolvedByTarget,
    natural,
    ...resolvedByTarget[WORLD_STREAMING_TARGET.TREE],
  });
}

function optionalString(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function immutableRecord(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('World Streaming Telemetry metadata must be an object');
  }
  return Object.freeze({ ...value });
}

function resourceIndexKey(stream, resourceKey, target = null) {
  return `${stream ?? '*'}\n${target ?? '*'}\n${resourceKey}`;
}

/**
 * Bounded, runtime-only lifecycle telemetry for the World Streaming control plane.
 * Disabled collectors are a shared no-op and do not read the clock or retain input.
 */
export function createWorldStreamingTelemetry({
  enabled = false,
  capacity = 8192,
  clock = defaultClock,
  sessionId = 'world-streaming',
} = {}) {
  if (enabled !== true) return DISABLED_TELEMETRY;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('World Streaming Telemetry capacity must be a positive safe integer');
  }
  if (typeof clock !== 'function') throw new TypeError('World Streaming Telemetry clock is required');
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new TypeError('World Streaming Telemetry sessionId is required');
  }

  const ring = new Array(capacity);
  const lifecycles = new Map();
  const latestCorrelationByResource = new Map();
  let ringStart = 0;
  let ringSize = 0;
  let sequence = 0;
  let correlationSequence = 0;
  let droppedEventCount = 0;
  let orderViolationCount = 0;
  let lastTimestampMs = 0;
  let active = true;

  const append = event => {
    if (ringSize < capacity) {
      ring[(ringStart + ringSize) % capacity] = event;
      ringSize += 1;
      return;
    }
    ring[ringStart] = event;
    ringStart = (ringStart + 1) % capacity;
    droppedEventCount += 1;
  };

  const eventsSnapshot = () => Object.freeze(Array.from(
    { length: ringSize },
    (_, index) => ring[(ringStart + index) % capacity],
  ));

  const evictLifecycleIfNeeded = () => {
    while (lifecycles.size > capacity) {
      const oldestCorrelationId = lifecycles.keys().next().value;
      const oldest = lifecycles.get(oldestCorrelationId);
      for (const indexKey of oldest?.resourceIndexKeys ?? []) {
        if (latestCorrelationByResource.get(indexKey) === oldestCorrelationId) {
          latestCorrelationByResource.delete(indexKey);
        }
      }
      lifecycles.delete(oldestCorrelationId);
    }
  };

  const resolveCorrelation = ({ resourceKey, stream = null, target = null } = {}) => {
    if (!active || typeof resourceKey !== 'string' || !resourceKey) return null;
    const exact = latestCorrelationByResource.get(resourceIndexKey(stream, resourceKey, target));
    if (exact && lifecycles.has(exact)) return exact;
    const streamShared = latestCorrelationByResource.get(resourceIndexKey(stream, resourceKey));
    if (streamShared && lifecycles.has(streamShared)) return streamShared;
    const shared = latestCorrelationByResource.get(resourceIndexKey(null, resourceKey));
    return shared && lifecycles.has(shared) ? shared : null;
  };

  const record = (type, details = {}) => {
    if (!active) return null;
    if (!EVENT_TYPES.has(type)) throw new RangeError(`unsupported World Streaming event: ${type}`);
    const target = optionalString(details.target, 'World Streaming target');
    const stream = optionalString(details.stream, 'World Streaming stream');
    if (target !== null && !TARGETS.has(target)) throw new RangeError(`unsupported World Streaming target: ${target}`);
    if (stream !== null && !STREAMS.has(stream)) throw new RangeError(`unsupported World Streaming stream: ${stream}`);
    const resourceKey = optionalString(details.resourceKey, 'World Streaming resourceKey');
    let correlationId = optionalString(details.correlationId, 'World Streaming correlationId');
    if (correlationId === null && resourceKey !== null) {
      correlationId = resolveCorrelation({ resourceKey, stream, target });
    }
    const timestamp = Number(clock());
    if (!Number.isFinite(timestamp)) throw new TypeError('World Streaming Telemetry clock must return a finite number');
    const timestampMs = Math.max(lastTimestampMs, timestamp);
    lastTimestampMs = timestampMs;

    const event = Object.freeze({
      schemaVersion: WORLD_STREAMING_TELEMETRY_SCHEMA,
      sequence: ++sequence,
      timestampMs,
      type,
      correlationId,
      target,
      stream,
      resourceKey,
      ownerKey: optionalString(details.ownerKey, 'World Streaming ownerKey'),
      stableId: optionalString(details.stableId, 'World Streaming stableId'),
      requestId: details.requestId ?? null,
      planId: details.planId ?? null,
      stateRevision: details.stateRevision ?? null,
      playerLogical: immutableRecord(details.playerLogical),
      speedMetersPerSecond: Number.isFinite(details.speedMetersPerSecond)
        ? Math.max(0, details.speedMetersPerSecond) : null,
      metadata: immutableRecord(details.metadata),
    });
    append(event);

    if (correlationId !== null) {
      let lifecycle = lifecycles.get(correlationId);
      if (!lifecycle) {
        lifecycle = {
          correlationId,
          resourceKey,
          target,
          stream,
          requestSequence: null,
          requestAtMs: null,
          workerCompleteSequence: null,
          workerCompleteAtMs: null,
          publishSequence: null,
          publishAtMs: null,
          firstDrawSequence: null,
          firstDrawAtMs: null,
          playerArrivalSequence: null,
          playerArrivalAtMs: null,
          terminalType: null,
          lastRank: -1,
          eventCount: 0,
          resourceIndexKeys: [],
        };
        lifecycles.set(correlationId, lifecycle);
        evictLifecycleIfNeeded();
      }
      const rank = EVENT_ORDER[type];
      if (rank !== undefined && rank < lifecycle.lastRank) orderViolationCount += 1;
      if (rank !== undefined) lifecycle.lastRank = Math.max(lifecycle.lastRank, rank);
      lifecycle.eventCount += 1;
      if (type === WORLD_STREAMING_EVENT.REQUEST && lifecycle.requestSequence === null) {
        lifecycle.requestSequence = event.sequence;
        lifecycle.requestAtMs = timestampMs;
      }
      if (type === WORLD_STREAMING_EVENT.WORKER_COMPLETE
        && lifecycle.workerCompleteSequence === null) {
        lifecycle.workerCompleteSequence = event.sequence;
        lifecycle.workerCompleteAtMs = timestampMs;
      }
      if (type === WORLD_STREAMING_EVENT.PUBLISH && lifecycle.publishSequence === null) {
        lifecycle.publishSequence = event.sequence;
        lifecycle.publishAtMs = timestampMs;
      }
      if (type === WORLD_STREAMING_EVENT.FIRST_DRAW && lifecycle.firstDrawSequence === null) {
        lifecycle.firstDrawSequence = event.sequence;
        lifecycle.firstDrawAtMs = timestampMs;
      }
      if (type === WORLD_STREAMING_EVENT.PLAYER_ARRIVAL && lifecycle.playerArrivalSequence === null) {
        lifecycle.playerArrivalSequence = event.sequence;
        lifecycle.playerArrivalAtMs = timestampMs;
      }
      if (TERMINAL_EVENTS.has(type)) lifecycle.terminalType = type;
    }
    return event;
  };

  const beginRequest = details => {
    if (!active) return null;
    const correlationId = `${sessionId}:${++correlationSequence}`;
    const resourceKey = optionalString(details?.resourceKey, 'World Streaming resourceKey');
    const stream = optionalString(details?.stream, 'World Streaming stream');
    record(WORLD_STREAMING_EVENT.REQUEST, { ...details, correlationId });
    if (resourceKey !== null) {
      const target = optionalString(details?.target, 'World Streaming target');
      const indexKeys = [
        resourceIndexKey(stream, resourceKey, target),
        resourceIndexKey(stream, resourceKey),
        resourceIndexKey(null, resourceKey),
      ];
      for (const indexKey of indexKeys) {
        latestCorrelationByResource.set(indexKey, correlationId);
      }
      const lifecycle = lifecycles.get(correlationId);
      if (lifecycle) lifecycle.resourceIndexKeys = indexKeys;
    }
    return correlationId;
  };

  const snapshot = () => {
    if (!active) return DISABLED_SNAPSHOT;
    const lifecycleSnapshot = Object.freeze([...lifecycles.values()].map(value => Object.freeze({
      correlationId: value.correlationId,
      resourceKey: value.resourceKey,
      target: value.target,
      stream: value.stream,
      requestSequence: value.requestSequence,
      requestAtMs: value.requestAtMs,
      workerCompleteSequence: value.workerCompleteSequence,
      workerCompleteAtMs: value.workerCompleteAtMs,
      publishSequence: value.publishSequence,
      publishAtMs: value.publishAtMs,
      workerCompleteToPublishMs:
        value.workerCompleteAtMs !== null && value.publishAtMs !== null
          ? Math.max(0, value.publishAtMs - value.workerCompleteAtMs) : null,
      requestToPublishMs: value.requestAtMs !== null && value.publishAtMs !== null
        ? Math.max(0, value.publishAtMs - value.requestAtMs) : null,
      firstDrawSequence: value.firstDrawSequence,
      firstDrawAtMs: value.firstDrawAtMs,
      requestToFirstDrawMs: value.requestAtMs !== null && value.firstDrawAtMs !== null
        ? Math.max(0, value.firstDrawAtMs - value.requestAtMs) : null,
      playerArrivalSequence: value.playerArrivalSequence,
      playerArrivalAtMs: value.playerArrivalAtMs,
      firstDrawToPlayerArrivalMs:
        value.firstDrawAtMs !== null && value.playerArrivalAtMs !== null
          ? value.playerArrivalAtMs - value.firstDrawAtMs : null,
      terminalType: value.terminalType,
      eventCount: value.eventCount,
    })));
    return Object.freeze({
      schemaVersion: WORLD_STREAMING_TELEMETRY_SCHEMA,
      enabled: true,
      capacity,
      size: ringSize,
      droppedEventCount,
      orderViolationCount,
      resourceIndexSize: latestCorrelationByResource.size,
      events: eventsSnapshot(),
      lifecycles: lifecycleSnapshot,
    });
  };

  const clear = () => {
    if (!active) return;
    ring.fill(undefined);
    ringStart = 0;
    ringSize = 0;
    droppedEventCount = 0;
    orderViolationCount = 0;
    lifecycles.clear();
    latestCorrelationByResource.clear();
  };

  const dispose = () => {
    clear();
    active = false;
  };

  return Object.freeze({
    get enabled() { return active; },
    beginRequest,
    record,
    resolveCorrelation,
    snapshot,
    clear,
    dispose,
  });
}

export function worldStreamingTargetForCanonicalObject(record) {
  const objectType = record?.objectType ?? null;
  if (objectType === 'tree') return WORLD_STREAMING_TARGET.TREE;
  if (objectType === 'shrub') return WORLD_STREAMING_TARGET.BUSH;
  if (objectType === 'grass') return WORLD_STREAMING_TARGET.GRASS;
  if (objectType === 'rock') return WORLD_STREAMING_TARGET.ROCK;
  if (objectType === 'building' || record?.featureType === 'settlement-building') {
    return WORLD_STREAMING_TARGET.BUILDING;
  }
  return null;
}
