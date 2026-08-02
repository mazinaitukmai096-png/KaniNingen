export const ROAD_GENERATION_TIMING_SCHEMA = 'road-generation-timing-1';

export const ROAD_GENERATION_TOP_RUN_CAPACITY = 20;
export const ROAD_GENERATION_FUNCTION_TIMING_CAPACITY = 64;

export const ROAD_GENERATION_SPAN = Object.freeze({
  SEED_INPUT: 'seed-input',
  HIERARCHY_PARAMETERS: 'hierarchy-parameters',
  SETTLEMENT_PLAN: 'settlement-plan',
  GRAPH_SEGMENTS: 'graph-segments',
  SEGMENT_CONNECTIONS_INTERSECTIONS: 'segment-connections-intersections',
  RIVER_CROSSINGS: 'river-crossings',
  BRIDGE_CANDIDATES_GENERATION: 'bridge-candidates-generation',
  TERRAIN_HEIGHT_SAMPLING: 'terrain-height-sampling',
  PATH_SMOOTHING_RESAMPLING: 'path-smoothing-resampling',
  SEGMENT_DEDUPE_MERGE: 'segment-dedupe-merge',
  SPATIAL_QUERY_INDEX: 'spatial-query-index',
  SURFACE_METADATA: 'surface-metadata',
  CANONICALIZATION: 'canonicalization',
  HASH_SIGNATURE: 'hash-signature',
  CACHE_LOOKUP_BUILD: 'cache-lookup-build',
  OTHER: 'other',
});

export const ROAD_GENERATION_SPAN_ORDER = Object.freeze([
  ROAD_GENERATION_SPAN.SEED_INPUT,
  ROAD_GENERATION_SPAN.HIERARCHY_PARAMETERS,
  ROAD_GENERATION_SPAN.SETTLEMENT_PLAN,
  ROAD_GENERATION_SPAN.GRAPH_SEGMENTS,
  ROAD_GENERATION_SPAN.SEGMENT_CONNECTIONS_INTERSECTIONS,
  ROAD_GENERATION_SPAN.RIVER_CROSSINGS,
  ROAD_GENERATION_SPAN.BRIDGE_CANDIDATES_GENERATION,
  ROAD_GENERATION_SPAN.TERRAIN_HEIGHT_SAMPLING,
  ROAD_GENERATION_SPAN.PATH_SMOOTHING_RESAMPLING,
  ROAD_GENERATION_SPAN.SEGMENT_DEDUPE_MERGE,
  ROAD_GENERATION_SPAN.SPATIAL_QUERY_INDEX,
  ROAD_GENERATION_SPAN.SURFACE_METADATA,
  ROAD_GENERATION_SPAN.CANONICALIZATION,
  ROAD_GENERATION_SPAN.HASH_SIGNATURE,
  ROAD_GENERATION_SPAN.CACHE_LOOKUP_BUILD,
  ROAD_GENERATION_SPAN.OTHER,
]);

export const ROAD_GENERATION_COUNTER = Object.freeze({
  SEGMENTS: 'segments',
  NODES: 'nodes',
  INTERSECTION_CANDIDATES: 'intersectionCandidates',
  RIVER_CROSSING_CANDIDATES: 'riverCrossingCandidates',
  BRIDGE_CANDIDATES: 'bridgeCandidates',
  TERRAIN_SAMPLES: 'terrainSamples',
  SPATIAL_QUERIES: 'spatialQueries',
  SORT_DEDUPE_ITEMS: 'sortDedupeItems',
  CACHE_HITS: 'cacheHits',
  CACHE_MISSES: 'cacheMisses',
});

export const ROAD_GENERATION_COUNTER_ORDER = Object.freeze([
  ROAD_GENERATION_COUNTER.SEGMENTS,
  ROAD_GENERATION_COUNTER.NODES,
  ROAD_GENERATION_COUNTER.INTERSECTION_CANDIDATES,
  ROAD_GENERATION_COUNTER.RIVER_CROSSING_CANDIDATES,
  ROAD_GENERATION_COUNTER.BRIDGE_CANDIDATES,
  ROAD_GENERATION_COUNTER.TERRAIN_SAMPLES,
  ROAD_GENERATION_COUNTER.SPATIAL_QUERIES,
  ROAD_GENERATION_COUNTER.SORT_DEDUPE_ITEMS,
  ROAD_GENERATION_COUNTER.CACHE_HITS,
  ROAD_GENERATION_COUNTER.CACHE_MISSES,
]);

export const ROAD_GENERATION_WARMTH = Object.freeze({
  COLD: 'cold',
  WARM: 'warm',
  UNKNOWN: 'unknown',
});

const spanNames = new Set(ROAD_GENERATION_SPAN_ORDER);
const counterNames = new Set(ROAD_GENERATION_COUNTER_ORDER);
const warmthNames = new Set(Object.values(ROAD_GENERATION_WARMTH));
const runStatuses = new Set(['completed', 'failed', 'cancelled']);
const MAX_SETTLEMENT_TYPES = 32;
const MAX_SETTLEMENT_TYPE_LENGTH = 128;
const MAX_FUNCTION_TIMING_NAME_LENGTH = 128;
const functionTimingNamePattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/;

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function finiteClockValue(value) {
  if (!Number.isFinite(value)) throw new TypeError('road timing clock must return a finite number');
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertSpan(span) {
  if (!spanNames.has(span)) throw new RangeError(`unknown Road generation span: ${span}`);
  return span;
}

function assertCounter(counter) {
  if (!counterNames.has(counter)) throw new RangeError(`unknown Road generation counter: ${counter}`);
  return counter;
}

function normalizeOwner(owner) {
  if (typeof owner === 'string') {
    const matched = /^(-?\d+),(-?\d+)$/.exec(owner);
    if (!matched) throw new TypeError('owner string must use the "x,z" form');
    const x = Number(matched[1]);
    const z = Number(matched[2]);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) {
      throw new RangeError('owner coordinates must be safe integers');
    }
    return Object.freeze({ x, z });
  }
  if (!owner || typeof owner !== 'object') {
    throw new TypeError('owner must be an { x, z } coordinate or "x,z" string');
  }
  const { x, z } = owner;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) {
    throw new RangeError('owner coordinates must be safe integers');
  }
  return Object.freeze({ x, z });
}

function normalizeSettlementTypes(settlementTypes) {
  if (settlementTypes === undefined || settlementTypes === null) return Object.freeze([]);
  if (typeof settlementTypes === 'string' || !settlementTypes[Symbol.iterator]) {
    throw new TypeError('settlementTypes must be an iterable of strings');
  }
  const values = new Set();
  for (const settlementType of settlementTypes) {
    if (typeof settlementType !== 'string' || settlementType.length === 0
      || settlementType.length > MAX_SETTLEMENT_TYPE_LENGTH) {
      throw new TypeError('settlementTypes must contain non-empty bounded strings');
    }
    values.add(settlementType);
    if (values.size > MAX_SETTLEMENT_TYPES) {
      throw new RangeError(`settlementTypes may contain at most ${MAX_SETTLEMENT_TYPES} values`);
    }
  }
  return Object.freeze([...values].sort(compareText));
}

function normalizeWarmth({ warmth, cold } = {}) {
  let normalized = warmth ?? ROAD_GENERATION_WARMTH.UNKNOWN;
  if (!warmthNames.has(normalized)) {
    throw new RangeError(`unknown Road generation warmth: ${normalized}`);
  }
  if (cold !== undefined) {
    if (typeof cold !== 'boolean') throw new TypeError('cold must be a boolean when provided');
    const fromCold = cold ? ROAD_GENERATION_WARMTH.COLD : ROAD_GENERATION_WARMTH.WARM;
    if (warmth !== undefined && normalized !== fromCold) {
      throw new RangeError('cold and warmth must describe the same Road generation run');
    }
    normalized = fromCold;
  }
  return normalized;
}

function normalizeStatus(status) {
  if (!runStatuses.has(status)) throw new RangeError(`unknown Road generation status: ${status}`);
  return status;
}

function normalizeFunctionTimingName(name) {
  if (typeof name !== 'string' || name.length === 0
    || name.length > MAX_FUNCTION_TIMING_NAME_LENGTH
    || !functionTimingNamePattern.test(name)) {
    throw new TypeError('Road function timing name must be a bounded identifier');
  }
  return name;
}

function nonNegativeDuration(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

function createSpanTotals() {
  return Object.fromEntries(ROAD_GENERATION_SPAN_ORDER.map(span => [span, {
    durationMs: 0,
    callCount: 0,
  }]));
}

function createCounterTotals() {
  return Object.fromEntries(ROAD_GENERATION_COUNTER_ORDER.map(counter => [counter, 0]));
}

function freezeSpanSnapshot(spanTotals) {
  return Object.freeze(Object.fromEntries(ROAD_GENERATION_SPAN_ORDER.map(span => {
    const value = spanTotals[span];
    return [span, Object.freeze({
      durationMs: value.durationMs,
      callCount: value.callCount,
    })];
  })));
}

function freezeCounterSnapshot(counterTotals) {
  return Object.freeze(Object.fromEntries(ROAD_GENERATION_COUNTER_ORDER.map(counter => [
    counter,
    counterTotals[counter],
  ])));
}

function freezeFunctionTimingSnapshot(functionTimings) {
  return Object.freeze(Object.fromEntries(
    [...functionTimings.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, timing]) => {
        const summary = durationSummary(timing.samples, timing.callCount, timing.totalMs);
        return [name, Object.freeze({
          totalMs: summary.totalMs,
          callCount: timing.callCount,
          sampleCount: summary.sampleCount,
          p50Ms: summary.p50Ms,
          p95Ms: summary.p95Ms,
          maxMs: summary.maxMs,
        })];
      }),
  ));
}

function addBounded(values, value, capacity) {
  values.push(value);
  if (values.length > capacity) values.splice(0, values.length - capacity);
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function durationSummary(values, count, totalMs) {
  const sorted = [...values].sort((left, right) => left - right);
  return Object.freeze({
    count,
    sampleCount: values.length,
    totalMs,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? 0,
  });
}

function compareTopRuns(left, right) {
  if (left.roadTotalMs !== right.roadTotalMs) return right.roadTotalMs - left.roadTotalMs;
  if (left.owner.x !== right.owner.x) return left.owner.x - right.owner.x;
  if (left.owner.z !== right.owner.z) return left.owner.z - right.owner.z;
  const warmth = compareText(left.warmth, right.warmth);
  if (warmth !== 0) return warmth;
  const settlementTypes = compareText(left.settlementTypes.join(','), right.settlementTypes.join(','));
  if (settlementTypes !== 0) return settlementTypes;
  const status = compareText(left.status, right.status);
  if (status !== 0) return status;
  return left.sequence - right.sequence;
}

function createDisabledRun() {
  const noop = () => 0;
  const executeSync = (_span, operation) => operation();
  const execute = async (_span, operation) => operation();
  const emptySnapshot = Object.freeze({
    schemaVersion: ROAD_GENERATION_TIMING_SCHEMA,
    enabled: false,
    status: 'disabled',
  });
  return Object.freeze({
    startSpan: noop,
    endSpan: noop,
    measureSync: executeSync,
    measure: execute,
    addCounter: noop,
    setCounter: noop,
    recordFunction: noop,
    recordCacheHit: noop,
    recordCacheMiss: noop,
    setDeadlineMiss: noop,
    setSettlementTypes: noop,
    setWarmth: noop,
    snapshot: () => emptySnapshot,
    complete: () => null,
  });
}

const disabledRun = createDisabledRun();

const disabledRecorderSnapshot = Object.freeze({
  schemaVersion: ROAD_GENERATION_TIMING_SCHEMA,
  enabled: false,
  runCount: 0,
  failedRunCount: 0,
  deadlineMissCount: 0,
  road: Object.freeze({
    count: 0,
    sampleCount: 0,
    totalMs: 0,
    p50Ms: 0,
    p95Ms: 0,
    maxMs: 0,
  }),
  spans: Object.freeze(Object.fromEntries(ROAD_GENERATION_SPAN_ORDER.map(span => [span, Object.freeze({
    callCount: 0,
    sampleCount: 0,
    totalMs: 0,
    p50Ms: 0,
    p95Ms: 0,
    maxMs: 0,
  })]))),
  counters: Object.freeze(createCounterTotals()),
  functionTimings: Object.freeze({}),
  functionTimingOverflowCount: 0,
  topRuns: Object.freeze([]),
});

/**
 * Creates a bounded, Worker-local recorder for exclusive Road-generation spans.
 *
 * A run has at most one active span. Any elapsed time between explicit spans is
 * attributed to `other`, so a completed run's spans partition `roadTotalMs`.
 * Named function/loop timings are inclusive attribution only: they may overlap
 * each other and exclusive spans, and never contribute to `roadTotalMs`.
 */
export function createRoadGenerationTimingRecorder({
  enabled = true,
  clock = defaultClock,
  topRunCapacity = ROAD_GENERATION_TOP_RUN_CAPACITY,
  sampleCapacity = 256,
  functionTimingCapacity = ROAD_GENERATION_FUNCTION_TIMING_CAPACITY,
} = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (!enabled) {
    return Object.freeze({
      schemaVersion: ROAD_GENERATION_TIMING_SCHEMA,
      enabled: false,
      beginRun: () => disabledRun,
      snapshot: () => disabledRecorderSnapshot,
      reset: () => {},
    });
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  positiveInteger(topRunCapacity, 'topRunCapacity');
  positiveInteger(sampleCapacity, 'sampleCapacity');
  positiveInteger(functionTimingCapacity, 'functionTimingCapacity');

  const roadSamples = [];
  const spanSamples = Object.fromEntries(ROAD_GENERATION_SPAN_ORDER.map(span => [span, []]));
  const spanTotals = Object.fromEntries(ROAD_GENERATION_SPAN_ORDER.map(span => [span, {
    durationMs: 0,
    callCount: 0,
  }]));
  const counterTotals = createCounterTotals();
  const functionTimingTotals = new Map();
  const topRuns = [];
  let sequence = 0;
  let runCount = 0;
  let failedRunCount = 0;
  let deadlineMissCount = 0;
  let roadTotalMs = 0;
  let activeRunCount = 0;
  let functionTimingOverflowCount = 0;

  const readClock = () => finiteClockValue(clock());

  const recordCompletedRun = (runSnapshot, runFunctionTimings) => {
    runCount += 1;
    if (runSnapshot.status === 'failed') failedRunCount += 1;
    if (runSnapshot.deadlineMiss) deadlineMissCount += 1;
    roadTotalMs += runSnapshot.roadTotalMs;
    addBounded(roadSamples, runSnapshot.roadTotalMs, sampleCapacity);
    for (const span of ROAD_GENERATION_SPAN_ORDER) {
      const runSpan = runSnapshot.spans[span];
      const aggregate = spanTotals[span];
      aggregate.durationMs += runSpan.durationMs;
      aggregate.callCount += runSpan.callCount;
      if (runSpan.callCount > 0) addBounded(spanSamples[span], runSpan.durationMs, sampleCapacity);
    }
    for (const counter of ROAD_GENERATION_COUNTER_ORDER) {
      counterTotals[counter] += runSnapshot.counters[counter];
    }
    for (const [name, runTiming] of runFunctionTimings) {
      let aggregate = functionTimingTotals.get(name);
      if (!aggregate) {
        if (functionTimingTotals.size >= functionTimingCapacity) {
          functionTimingOverflowCount += 1;
          continue;
        }
        aggregate = { totalMs: 0, callCount: 0, samples: [] };
        functionTimingTotals.set(name, aggregate);
      }
      aggregate.totalMs += runTiming.totalMs;
      aggregate.callCount += runTiming.callCount;
      for (const sample of runTiming.samples) addBounded(aggregate.samples, sample, sampleCapacity);
    }
    topRuns.push(runSnapshot);
    topRuns.sort(compareTopRuns);
    if (topRuns.length > topRunCapacity) topRuns.splice(topRunCapacity);
  };

  const beginRun = ({
    owner,
    warmth,
    cold,
    deadlineMiss = false,
    settlementTypes,
  } = {}) => {
    const normalizedOwner = normalizeOwner(owner);
    if (typeof deadlineMiss !== 'boolean') throw new TypeError('deadlineMiss must be a boolean');
    let currentWarmth = normalizeWarmth({ warmth, cold });
    let currentDeadlineMiss = deadlineMiss;
    let currentSettlementTypes = normalizeSettlementTypes(settlementTypes);
    const currentSpanTotals = createSpanTotals();
    const currentCounterTotals = createCounterTotals();
    const currentFunctionTimings = new Map();
    const runSequence = ++sequence;
    const startedAtMs = readClock();
    activeRunCount += 1;
    let lastAtMs = startedAtMs;
    let activeSpan = null;
    let activeToken = null;
    let tokenSequence = 0;
    let completed = false;
    let hadFailure = false;
    let totalMs = 0;

    const assertActive = () => {
      if (completed) throw new Error('Road generation run has already completed');
    };

    const recordSpan = (span, startedAt, completedAt) => {
      const durationMs = Math.max(0, completedAt - startedAt);
      const totals = currentSpanTotals[span];
      totals.durationMs += durationMs;
      totals.callCount += 1;
      totalMs += durationMs;
      lastAtMs = Math.max(lastAtMs, completedAt);
      return durationMs;
    };

    const recordGap = now => {
      if (now > lastAtMs) recordSpan(ROAD_GENERATION_SPAN.OTHER, lastAtMs, now);
    };

    const startSpan = spanInput => {
      assertActive();
      const span = assertSpan(spanInput);
      if (activeSpan !== null) {
        throw new Error(`Road generation span ${activeSpan} is still active`);
      }
      const startedAt = readClock();
      recordGap(startedAt);
      activeSpan = span;
      activeToken = Object.freeze({
        span,
        sequence: ++tokenSequence,
        startedAtMs: startedAt,
      });
      return activeToken;
    };

    const endSpan = token => {
      assertActive();
      if (!activeToken || token !== activeToken) {
        throw new TypeError('the active Road generation span token is required');
      }
      const completedAt = readClock();
      const durationMs = recordSpan(activeSpan, activeToken.startedAtMs, completedAt);
      activeSpan = null;
      activeToken = null;
      return durationMs;
    };

    const measureSync = (span, operation) => {
      if (typeof operation !== 'function') throw new TypeError('Road generation span operation must be a function');
      const token = startSpan(span);
      try {
        const value = operation();
        endSpan(token);
        return value;
      } catch (error) {
        if (activeToken === token) endSpan(token);
        hadFailure = true;
        throw error;
      }
    };

    const measure = async (span, operation) => {
      if (typeof operation !== 'function') throw new TypeError('Road generation span operation must be a function');
      const token = startSpan(span);
      try {
        const value = await operation();
        endSpan(token);
        return value;
      } catch (error) {
        if (activeToken === token) endSpan(token);
        hadFailure = true;
        throw error;
      }
    };

    const addCounter = (counterInput, increment = 1) => {
      assertActive();
      const counter = assertCounter(counterInput);
      const normalizedIncrement = nonNegativeInteger(increment, `${counter} increment`);
      const next = currentCounterTotals[counter] + normalizedIncrement;
      if (!Number.isSafeInteger(next)) throw new RangeError(`${counter} exceeds safe integer range`);
      currentCounterTotals[counter] = next;
      return next;
    };

    const setCounter = (counterInput, value) => {
      assertActive();
      const counter = assertCounter(counterInput);
      currentCounterTotals[counter] = nonNegativeInteger(value, counter);
      return currentCounterTotals[counter];
    };

    const recordFunction = (nameInput, durationMs, calls = 1) => {
      assertActive();
      const name = normalizeFunctionTimingName(nameInput);
      const duration = nonNegativeDuration(durationMs, `${name} durationMs`);
      const callCount = positiveInteger(calls, `${name} calls`);
      let timing = currentFunctionTimings.get(name);
      if (!timing) {
        if (currentFunctionTimings.size >= functionTimingCapacity) {
          throw new RangeError(`Road run may record at most ${functionTimingCapacity} named function timings`);
        }
        timing = { totalMs: 0, callCount: 0, samples: [] };
        currentFunctionTimings.set(name, timing);
      }
      timing.totalMs += duration;
      timing.callCount += callCount;
      addBounded(timing.samples, duration, sampleCapacity);
      return Object.freeze({
        name,
        totalMs: timing.totalMs,
        callCount: timing.callCount,
      });
    };

    const snapshot = ({ status = 'active' } = {}) => Object.freeze({
      schemaVersion: ROAD_GENERATION_TIMING_SCHEMA,
      sequence: runSequence,
      owner: normalizedOwner,
      ownerKey: `${normalizedOwner.x},${normalizedOwner.z}`,
      warmth: currentWarmth,
      cold: currentWarmth === ROAD_GENERATION_WARMTH.UNKNOWN
        ? null : currentWarmth === ROAD_GENERATION_WARMTH.COLD,
      deadlineMiss: currentDeadlineMiss,
      settlementTypes: currentSettlementTypes,
      status,
      roadTotalMs: totalMs,
      spans: freezeSpanSnapshot(currentSpanTotals),
      counters: freezeCounterSnapshot(currentCounterTotals),
      functionTimings: freezeFunctionTimingSnapshot(currentFunctionTimings),
      cache: Object.freeze({
        hits: currentCounterTotals[ROAD_GENERATION_COUNTER.CACHE_HITS],
        misses: currentCounterTotals[ROAD_GENERATION_COUNTER.CACHE_MISSES],
      }),
    });

    const complete = ({
      deadlineMiss: completeDeadlineMiss,
      status = hadFailure ? 'failed' : 'completed',
    } = {}) => {
      assertActive();
      if (activeSpan !== null) {
        throw new Error(`cannot complete Road generation while ${activeSpan} is active`);
      }
      if (completeDeadlineMiss !== undefined) {
        if (typeof completeDeadlineMiss !== 'boolean') {
          throw new TypeError('deadlineMiss must be a boolean when provided');
        }
        currentDeadlineMiss = completeDeadlineMiss;
      }
      const normalizedStatus = normalizeStatus(status);
      const completedAtMs = readClock();
      recordGap(completedAtMs);
      completed = true;
      const runSnapshot = snapshot({ status: normalizedStatus });
      recordCompletedRun(runSnapshot, currentFunctionTimings);
      activeRunCount -= 1;
      return runSnapshot;
    };

    return Object.freeze({
      startSpan,
      endSpan,
      measureSync,
      measure,
      addCounter,
      setCounter,
      recordFunction,
      recordCacheHit: (count = 1) => addCounter(ROAD_GENERATION_COUNTER.CACHE_HITS, count),
      recordCacheMiss: (count = 1) => addCounter(ROAD_GENERATION_COUNTER.CACHE_MISSES, count),
      setDeadlineMiss: value => {
        assertActive();
        if (typeof value !== 'boolean') throw new TypeError('deadlineMiss must be a boolean');
        currentDeadlineMiss = value;
        return currentDeadlineMiss;
      },
      setSettlementTypes: value => {
        assertActive();
        currentSettlementTypes = normalizeSettlementTypes(value);
        return currentSettlementTypes;
      },
      setWarmth: ({ warmth: nextWarmth, cold: nextCold } = {}) => {
        assertActive();
        currentWarmth = normalizeWarmth({ warmth: nextWarmth, cold: nextCold });
        return currentWarmth;
      },
      snapshot,
      complete,
    });
  };

  const snapshot = () => Object.freeze({
    schemaVersion: ROAD_GENERATION_TIMING_SCHEMA,
    enabled: true,
    runCount,
    failedRunCount,
    deadlineMissCount,
    road: durationSummary(roadSamples, runCount, roadTotalMs),
    spans: Object.freeze(Object.fromEntries(ROAD_GENERATION_SPAN_ORDER.map(span => {
      const totals = spanTotals[span];
      const summary = durationSummary(spanSamples[span], totals.callCount, totals.durationMs);
      return [span, Object.freeze({
        callCount: totals.callCount,
        sampleCount: summary.sampleCount,
        totalMs: totals.durationMs,
        p50Ms: summary.p50Ms,
        p95Ms: summary.p95Ms,
        maxMs: summary.maxMs,
      })];
    }))),
    counters: freezeCounterSnapshot(counterTotals),
    functionTimings: freezeFunctionTimingSnapshot(functionTimingTotals),
    functionTimingOverflowCount,
    topRuns: Object.freeze([...topRuns]),
  });

  const reset = () => {
    if (activeRunCount !== 0) throw new Error('cannot reset Road timing while a run is active');
    roadSamples.length = 0;
    for (const span of ROAD_GENERATION_SPAN_ORDER) {
      spanSamples[span].length = 0;
      spanTotals[span].durationMs = 0;
      spanTotals[span].callCount = 0;
    }
    for (const counter of ROAD_GENERATION_COUNTER_ORDER) counterTotals[counter] = 0;
    functionTimingTotals.clear();
    topRuns.length = 0;
    sequence = 0;
    runCount = 0;
    failedRunCount = 0;
    deadlineMissCount = 0;
    roadTotalMs = 0;
    functionTimingOverflowCount = 0;
  };

  return Object.freeze({
    schemaVersion: ROAD_GENERATION_TIMING_SCHEMA,
    enabled: true,
    beginRun,
    snapshot,
    reset,
  });
}

export function measureRoadGenerationSpanSync(roadRun, span, operation) {
  return roadRun ? roadRun.measureSync(span, operation) : operation();
}

export function measureRoadGenerationSpan(roadRun, span, operation) {
  return roadRun ? roadRun.measure(span, operation) : operation();
}
