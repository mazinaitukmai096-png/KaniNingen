import { createBrowserFrameDiagnostics } from './browser-frame-diagnostics.js';

const DEFAULT_SAMPLE_LIMIT = 7_200;
const DEFAULT_HITCH_LIMIT = 256;
const DEFAULT_FRAME_DETAIL_LIMIT = 512;
const DEFAULT_EVENT_LIMIT = 2_048;

export const RUNTIME_DIAGNOSTIC_MODE = Object.freeze({
  OFF: 'off',
  LIGHT: 'light',
  DEEP_ATTRIBUTION: 'deep-attribution',
});

function resolveRuntimeDiagnosticMode(mode, enabled) {
  const resolved = mode ?? (enabled === true
    ? RUNTIME_DIAGNOSTIC_MODE.LIGHT : RUNTIME_DIAGNOSTIC_MODE.OFF);
  if (!Object.values(RUNTIME_DIAGNOSTIC_MODE).includes(resolved)) {
    throw new RangeError('Runtime diagnostic mode must be off, light, or deep-attribution');
  }
  return resolved;
}

function errorSummary(error) {
  return Object.freeze({
    name: String(error?.name ?? 'Error'),
    message: String(error?.message ?? error),
  });
}

/**
 * @typedef {object} MeasurementReport
 * @property {'w8-measurement-report-1'} schemaVersion
 * @property {number} runNumber
 * @property {Readonly<Record<string, unknown>>} environment
 * @property {Readonly<Record<string, number>>} frame
 * @property {Readonly<Record<string, Readonly<Record<string, number>>>>} stages
 * @property {readonly object[]} hitches
 * @property {readonly object[]} longTasks
 * @property {Readonly<Record<string, unknown>>} resources
 */

export const W8_DIAGNOSTIC_PROFILES = Object.freeze({
  baseline: Object.freeze({
    save: true, distant: true, shadows: true, transparency: true, gameplaySync: true,
  }),
  'no-save': Object.freeze({
    save: false, distant: true, shadows: true, transparency: true, gameplaySync: true,
  }),
  'no-distant': Object.freeze({
    save: true, distant: false, shadows: true, transparency: true, gameplaySync: true,
  }),
  'no-shadows': Object.freeze({
    save: true, distant: true, shadows: false, transparency: true, gameplaySync: true,
  }),
  'no-transparent': Object.freeze({
    save: true, distant: true, shadows: true, transparency: false, gameplaySync: true,
  }),
  'no-gameplay-sync': Object.freeze({
    save: true, distant: true, shadows: true, transparency: true, gameplaySync: false,
  }),
});

const clampIndex = (length, fraction) => Math.max(0, Math.min(
  length - 1,
  Math.ceil(length * fraction) - 1,
));

function createCircularBuffer(capacity) {
  const storage = new Array(capacity);
  let start = 0;
  let size = 0;
  return Object.freeze({
    get length() { return size; },
    push(value) {
      const index = (start + size) % capacity;
      if (size < capacity) size += 1;
      else start = (start + 1) % capacity;
      storage[index] = value;
      return value;
    },
    at(index) {
      const normalized = index < 0 ? size + index : index;
      if (normalized < 0 || normalized >= size) return undefined;
      return storage[(start + normalized) % capacity];
    },
    toArray() {
      return Array.from({ length: size }, (_, index) => storage[(start + index) % capacity]);
    },
    clear() {
      storage.fill(undefined);
      start = 0;
      size = 0;
    },
  });
}

function createNumericCircularBuffer(capacity) {
  const storage = new Float64Array(capacity);
  let start = 0;
  let size = 0;
  let total = 0;
  let latest = 0;
  return Object.freeze({
    get length() { return size; },
    get sum() { return total; },
    get latest() { return size > 0 ? latest : 0; },
    push(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return false;
      const index = (start + size) % capacity;
      if (size < capacity) size += 1;
      else {
        total -= storage[index];
        start = (start + 1) % capacity;
      }
      storage[index] = numeric;
      total += numeric;
      latest = numeric;
      return true;
    },
    toArray() {
      return Array.from(
        { length: size },
        (_, index) => storage[(start + index) % capacity],
      );
    },
    clear() {
      storage.fill(0);
      start = 0;
      size = 0;
      total = 0;
      latest = 0;
    },
  });
}

function distribution(values) {
  const samples = typeof values?.toArray === 'function' ? values.toArray() : values;
  if (!samples.length) {
    return Object.freeze({ count: 0, latest: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });
  }
  const ordered = [...samples].sort((a, b) => a - b);
  const sum = typeof values?.sum === 'number'
    ? values.sum : ordered.reduce((total, value) => total + value, 0);
  return Object.freeze({
    count: ordered.length,
    latest: typeof values?.latest === 'number' ? values.latest : samples.at(-1),
    p50: ordered[clampIndex(ordered.length, 0.5)],
    p95: ordered[clampIndex(ordered.length, 0.95)],
    p99: ordered[clampIndex(ordered.length, 0.99)],
    max: ordered.at(-1),
    mean: sum / ordered.length,
  });
}

function workDistributions(frameRecords) {
  const samples = new Map();
  const records = typeof frameRecords?.toArray === 'function'
    ? frameRecords.toArray() : frameRecords;
  for (const frame of records) {
    for (const [route, metrics] of Object.entries(frame.work ?? {})) {
      for (const [metric, value] of Object.entries(metrics)) {
        if (!Number.isFinite(value)) continue;
        const key = `${route}\n${metric}`;
        if (!samples.has(key)) samples.set(key, []);
        samples.get(key).push(value);
      }
    }
  }
  const result = {};
  for (const [key, values] of [...samples].sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    const [route, metric] = key.split('\n');
    result[route] ??= {};
    result[route][metric] = distribution(values);
  }
  return Object.freeze(Object.fromEntries(Object.entries(result).map(([route, metrics]) => (
    [route, Object.freeze(metrics)]
  ))));
}

function sampledWorkDistributions(sampleMaps) {
  const result = {};
  for (const [route, metrics] of [...sampleMaps].sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    result[route] = Object.freeze(Object.fromEntries(
      [...metrics].sort(([left], [right]) => left.localeCompare(right))
        .map(([metric, samples]) => [metric, distribution(samples)]),
    ));
  }
  return Object.freeze(result);
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function correlateW8HitchStages(reports, {
  minimumRuns = 2,
  minimumStageDurationMs = 20,
} = {}) {
  const runsByStage = new Map();
  for (const report of reports) {
    const stagesInRun = new Set();
    for (const hitch of report?.hitches ?? []) {
      const entries = Object.entries(hitch.stages ?? {})
        .filter(([, duration]) => duration >= minimumStageDurationMs)
        .sort((a, b) => b[1] - a[1]);
      if (entries[0]) stagesInRun.add(entries[0][0]);
    }
    for (const stage of stagesInRun) runsByStage.set(stage, (runsByStage.get(stage) ?? 0) + 1);
  }
  return Object.freeze([...runsByStage]
    .filter(([, runCount]) => runCount >= minimumRuns)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([stage, runCount]) => Object.freeze({ stage, runCount })));
}

export function evaluateW8PerformanceRuns({
  scenario = 'normal', finiteReports, beforeW8Reports, w8Reports,
} = {}) {
  if (!['normal', 'crossing', 'combat'].includes(scenario)) {
    throw new RangeError('scenario must be normal, crossing, or combat');
  }
  if (!Array.isArray(finiteReports) || !Array.isArray(beforeW8Reports)
    || !Array.isArray(w8Reports) || finiteReports.length !== 5
    || beforeW8Reports.length !== 5 || w8Reports.length !== 5) {
    throw new TypeError(
      'exactly five finite, five before-W8, and five after-W8 MeasurementReports are required',
    );
  }
  const finiteP95 = median(finiteReports.map(report => report.frame.p95));
  const finiteP99 = median(finiteReports.map(report => report.frame.p99));
  const finiteOver50Ratio = median(finiteReports.map(report => report.hitchRatio));
  const beforeW8P95 = median(beforeW8Reports.map(report => report.frame.p95));
  const beforeW8P99 = median(beforeW8Reports.map(report => report.frame.p99));
  const beforeW8Over50Ratio = median(beforeW8Reports.map(report => report.hitchRatio));
  const w8P95 = median(w8Reports.map(report => report.frame.p95));
  const w8P99 = median(w8Reports.map(report => report.frame.p99));
  const over50Ratio = median(w8Reports.map(report => report.hitchRatio));
  const p95Limit = Math.max(20, finiteP95 * 1.25);
  const p99Limit = Math.max(40, finiteP99 * 1.5);
  const over50RatioLimit = 0.005;
  const beforeP95Limit = beforeW8P95 * (scenario === 'crossing' ? 1 : 1.1);
  const beforeP99Limit = beforeW8P99 * (scenario === 'crossing' ? 1 : 1.1);
  const beforeOver50RatioLimit = scenario === 'crossing'
    ? beforeW8Over50Ratio : null;
  const recurringStops = new Map();
  for (const report of w8Reports) {
    const stagesInRun = new Set();
    for (const hitch of report.hitches ?? []) {
      if (hitch.durationMs <= 100) continue;
      const dominant = Object.entries(hitch.stages ?? {}).sort((a, b) => b[1] - a[1])[0];
      if (dominant) stagesInRun.add(dominant[0]);
    }
    for (const stage of stagesInRun) recurringStops.set(stage, (recurringStops.get(stage) ?? 0) + 1);
  }
  const recurringStageStops = [...recurringStops]
    .filter(([, runCount]) => runCount >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([stage, runCount]) => Object.freeze({ stage, runCount }));
  const criteria = Object.freeze({
    finiteP95: w8P95 <= p95Limit,
    finiteP99: w8P99 <= p99Limit,
    absoluteOver50Ratio: over50Ratio <= 0.005,
    finiteRelativeOver50Ratio: over50Ratio <= over50RatioLimit,
    beforeW8P95: w8P95 <= beforeP95Limit,
    beforeW8P99: w8P99 <= beforeP99Limit,
    beforeW8Over50Ratio: beforeOver50RatioLimit === null
      || over50Ratio <= beforeOver50RatioLimit,
    recurringStageStops: recurringStageStops.length === 0,
  });
  return Object.freeze({
    schemaVersion: 'w8-performance-acceptance-1',
    scenario,
    pass: Object.values(criteria).every(Boolean),
    criteria,
    medians: Object.freeze({
      finiteP95, finiteP99, finiteOver50Ratio,
      beforeW8P95, beforeW8P99, beforeW8Over50Ratio,
      w8P95, w8P99, over50Ratio,
    }),
    limits: Object.freeze({
      finiteP95: p95Limit,
      finiteP99: p99Limit,
      absoluteOver50Ratio: 0.005,
      finiteRelativeOver50Ratio: over50RatioLimit,
      beforeW8P95: beforeP95Limit,
      beforeW8P99: beforeP99Limit,
      beforeW8Over50Ratio: beforeOver50RatioLimit,
    }),
    recurringStageStops: Object.freeze(recurringStageStops),
    diagnostics: Object.freeze({
      maximumFrameMs: Math.max(...w8Reports.map(report => report.frame.max)),
      longTaskCount: w8Reports.reduce((sum, report) => sum + (report.longTasks?.length ?? 0), 0),
    }),
  });
}

export function parseW8DiagnosticProfile(value) {
  const profileId = value || 'baseline';
  const flags = W8_DIAGNOSTIC_PROFILES[profileId];
  if (!flags) throw new RangeError(`unsupported diagnosticProfile: ${profileId}`);
  return Object.freeze({ profileId, ...flags });
}

export function createW8RuntimeDiagnostics({
  globalObject = globalThis,
  clock = () => globalObject.performance?.now?.() ?? Date.now(),
  profile = parseW8DiagnosticProfile('baseline'),
  enabled = false,
  mode = null,
  runNumber = 1,
  environment = {},
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
  hitchLimit = DEFAULT_HITCH_LIMIT,
  hitchThresholdMs = 50,
  hudRefreshIntervalMs = 1_000,
  onObserverError = null,
} = {}) {
  if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw new TypeError('runNumber must be positive');
  if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1) throw new TypeError('sampleLimit must be positive');
  if (!Number.isSafeInteger(hitchLimit) || hitchLimit < 1) throw new TypeError('hitchLimit must be positive');
  if (!Number.isFinite(hitchThresholdMs) || hitchThresholdMs <= 0) {
    throw new TypeError('hitchThresholdMs must be positive');
  }
  if (!Number.isFinite(hudRefreshIntervalMs) || hudRefreshIntervalMs < 0) {
    throw new TypeError('hudRefreshIntervalMs must be non-negative');
  }
  if (onObserverError !== null && typeof onObserverError !== 'function') {
    throw new TypeError('onObserverError must be a function or null');
  }
  const diagnosticMode = resolveRuntimeDiagnosticMode(mode, enabled);
  const active = diagnosticMode !== RUNTIME_DIAGNOSTIC_MODE.OFF;
  const detailed = diagnosticMode === RUNTIME_DIAGNOSTIC_MODE.DEEP_ATTRIBUTION;
  const performanceObject = globalObject.performance ?? null;
  const userTimingSupported = [
    'mark', 'measure', 'clearMarks', 'clearMeasures',
  ].every(method => typeof performanceObject?.[method] === 'function');
  let userTimingActive = diagnosticMode === RUNTIME_DIAGNOSTIC_MODE.DEEP_ATTRIBUTION
    && userTimingSupported;
  const browserFrames = createBrowserFrameDiagnostics({
    mode: diagnosticMode,
    globalObject,
    clock,
    environment,
  });
  const stageSamples = new Map();
  const frameSamples = createNumericCircularBuffer(sampleLimit);
  const frameHitchFlags = createNumericCircularBuffer(sampleLimit);
  const frameRecords = createCircularBuffer(DEFAULT_FRAME_DETAIL_LIMIT);
  const hitches = createCircularBuffer(hitchLimit);
  const longTasks = createCircularBuffer(hitchLimit);
  const events = createCircularBuffer(DEFAULT_EVENT_LIMIT);
  const lightWorkTotals = new Map();
  const lightActiveWorkRoutes = new Set();
  const lightWorkSamples = new Map();
  const lightFrameState = { sequence: 0, startedAt: 0 };
  let currentFrame = null;
  let frameSequence = 0;
  let eventSequence = 0;
  let markSequence = 0;
  let observer = null;
  let observerErrorCount = 0;
  let observerLastError = null;
  let longTaskObserverQuarantined = false;
  let userTimingQuarantined = false;
  let hudCache = null;
  let hudCacheAtMs = Number.NEGATIVE_INFINITY;
  let hudCacheStageNames = null;

  const reportObserverError = (stage, error) => {
    observerErrorCount += 1;
    observerLastError = Object.freeze({ stage, ...errorSummary(error) });
    if (typeof onObserverError === 'function') {
      try {
        onObserverError(Object.freeze({ subsystem: 'runtime-diagnostics', ...observerLastError }));
      } catch (callbackError) {
        observerErrorCount += 1;
        observerLastError = Object.freeze({
          stage: 'observer-error-reporter',
          ...errorSummary(callbackError),
        });
      }
    }
  };

  const recordStage = (stage, durationMs, { async = false } = {}) => {
    if (!active) return durationMs;
    if (!stageSamples.has(stage)) {
      stageSamples.set(stage, createNumericCircularBuffer(sampleLimit));
    }
    stageSamples.get(stage).push(durationMs);
    if (detailed && currentFrame) {
      currentFrame.stages[stage] = (currentFrame.stages[stage] ?? 0) + durationMs;
    }
    browserFrames.recordStage(stage, durationMs, { async });
    return durationMs;
  };
  const begin = (stage, { async = false } = {}) => {
    if (!active) return Object.freeze({ stage, disabled: true, async });
    const startedAt = clock();
    if (!userTimingActive) return Object.freeze({ stage, startedAt, async, userTiming: false });
    const sequence = ++markSequence;
    const startMark = `w8:${stage}:${sequence}:start`;
    const endMark = `w8:${stage}:${sequence}:end`;
    try {
      performanceObject.mark(startMark);
    } catch (error) {
      userTimingActive = false;
      userTimingQuarantined = true;
      reportObserverError('user-timing-begin', error);
      return Object.freeze({ stage, startedAt, async, userTiming: false });
    }
    return Object.freeze({
      stage, startedAt, sequence, startMark, endMark, async, userTiming: true,
    });
  };
  const end = token => {
    if (token?.disabled) return 0;
    const durationMs = Math.max(0, clock() - token.startedAt);
    if (token.userTiming === true && userTimingActive) {
      const measureName = `w8:${token.stage}`;
      let timingError = null;
      try {
        performanceObject.mark(token.endMark);
        performanceObject.measure(measureName, token.startMark, token.endMark);
      } catch (error) {
        timingError = error;
      } finally {
        try {
          performanceObject.clearMarks(token.startMark);
          performanceObject.clearMarks(token.endMark);
          performanceObject.clearMeasures(measureName);
        } catch (error) {
          timingError ??= error;
        }
      }
      if (timingError) {
        userTimingActive = false;
        userTimingQuarantined = true;
        reportObserverError('user-timing-end', timingError);
      }
    }
    return recordStage(token.stage, durationMs, { async: token.async });
  };

  if (active && typeof globalObject.PerformanceObserver === 'function') {
    try {
      observer = new globalObject.PerformanceObserver(list => {
        if (longTaskObserverQuarantined) return;
        try {
          for (const entry of list.getEntries()) {
            longTasks.push(Object.freeze({
              name: String(entry.name ?? 'longtask'),
              startTime: Number(entry.startTime ?? 0),
              durationMs: Number(entry.duration ?? 0),
            }));
          }
        } catch (error) {
          longTaskObserverQuarantined = true;
          reportObserverError('long-task-callback', error);
          const failedObserver = observer;
          observer = null;
          try {
            failedObserver?.disconnect?.();
          } catch (disconnectError) {
            reportObserverError('long-task-disconnect', disconnectError);
          }
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch (error) {
      longTaskObserverQuarantined = true;
      reportObserverError('long-task-observe', error);
      const failedObserver = observer;
      observer = null;
      try {
        failedObserver?.disconnect?.();
      } catch (disconnectError) {
        reportObserverError('long-task-disconnect', disconnectError);
      }
    }
  }

  return Object.freeze({
    profile,
    enabled: active,
    mode: diagnosticMode,
    begin,
    end,
    measure(stage, operation) {
      if (!active) return operation();
      if (!detailed) {
        const startedAt = clock();
        try { return operation(); }
        finally { recordStage(stage, Math.max(0, clock() - startedAt)); }
      }
      const token = begin(stage);
      try { return operation(); }
      finally { end(token); }
    },
    async measureAsync(stage, operation) {
      if (!active) return operation();
      if (!detailed) {
        const startedAt = clock();
        try { return await operation(); }
        finally { recordStage(stage, Math.max(0, clock() - startedAt), { async: true }); }
      }
      const token = begin(stage, { async: true });
      try { return await operation(); }
      finally { end(token); }
    },
    startFrame(frameNow = clock()) {
      if (!active) return null;
      lightActiveWorkRoutes.clear();
      if (detailed) {
        currentFrame = {
          sequence: ++frameSequence,
          startedAt: frameNow,
          stages: {},
          work: {},
        };
      } else {
        lightFrameState.sequence = ++frameSequence;
        lightFrameState.startedAt = frameNow;
        currentFrame = lightFrameState;
      }
      browserFrames.startFrame(frameNow);
      return currentFrame.sequence;
    },
    currentFrameSequence() {
      return active ? currentFrame?.sequence ?? frameSequence : null;
    },
    recordWork(route, values = { count: 1 }) {
      if (!active || !currentFrame) return null;
      if (typeof route !== 'string' || !route) throw new TypeError('diagnostic work route is required');
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new TypeError('diagnostic work values must be an object');
      }
      if (detailed) {
        const target = currentFrame.work[route] ??= {};
        for (const [metric, value] of Object.entries(values)) {
          if (!Number.isFinite(value)) continue;
          target[metric] = (target[metric] ?? 0) + value;
        }
      } else {
        let target = lightWorkTotals.get(route);
        if (!target) {
          target = new Map();
          lightWorkTotals.set(route, target);
        }
        if (!lightActiveWorkRoutes.has(route)) {
          for (const metric of target.keys()) target.set(metric, 0);
          lightActiveWorkRoutes.add(route);
        }
        for (const [metric, value] of Object.entries(values)) {
          if (!Number.isFinite(value)) continue;
          target.set(metric, (target.get(metric) ?? 0) + value);
        }
      }
      browserFrames.recordWork(route, values);
      return detailed
        ? Object.freeze({ frameSequence: currentFrame.sequence, route })
        : currentFrame.sequence;
    },
    recordEvent(type, details = {}) {
      if (!active) return null;
      if (typeof type !== 'string' || !type) throw new TypeError('diagnostic event type is required');
      if (!details || typeof details !== 'object' || Array.isArray(details)) {
        throw new TypeError('diagnostic event details must be an object');
      }
      const event = Object.freeze({
        sequence: ++eventSequence,
        type,
        timestampMs: clock(),
        frameSequence: currentFrame?.sequence ?? frameSequence,
        ...details,
      });
      events.push(event);
      browserFrames.recordEvent(type, details);
      return event;
    },
    recordTerrainGate(details) {
      if (!active) return null;
      return browserFrames.recordTerrainGate(details);
    },
    sealFrame({ rendererInfo = null } = {}) {
      if (!active) return null;
      return browserFrames.sealFrame({ rendererInfo });
    },
    finishFrame(durationMs, frameNow = clock()) {
      if (!active) return null;
      frameSamples.push(durationMs);
      const hitch = durationMs > hitchThresholdMs;
      frameHitchFlags.push(Number(hitch));
      if (!detailed) {
        for (const route of lightActiveWorkRoutes) {
          const totals = lightWorkTotals.get(route);
          let samples = lightWorkSamples.get(route);
          if (!samples) {
            samples = new Map();
            lightWorkSamples.set(route, samples);
          }
          for (const [metric, value] of totals) {
            if (!samples.has(metric)) {
              samples.set(metric, createNumericCircularBuffer(sampleLimit));
            }
            samples.get(metric).push(value);
          }
        }
        browserFrames.finishFrame(durationMs, frameNow);
        const completedSequence = currentFrame?.sequence ?? ++frameSequence;
        currentFrame = null;
        return completedSequence;
      }
      const record = Object.freeze({
        sequence: currentFrame?.sequence ?? ++frameSequence,
        startedAt: currentFrame?.startedAt ?? frameNow - durationMs,
        durationMs,
        stages: Object.freeze({ ...(currentFrame?.stages ?? {}) }),
        work: Object.freeze(Object.fromEntries(Object.entries(currentFrame?.work ?? {}).map(
          ([route, values]) => [route, Object.freeze({ ...values })],
        ))),
      });
      frameRecords.push(record);
      if (hitch) hitches.push(record);
      browserFrames.finishFrame(durationMs, frameNow);
      currentFrame = null;
      return record;
    },
    reset() {
      stageSamples.clear();
      frameSamples.clear();
      frameHitchFlags.clear();
      frameRecords.clear();
      hitches.clear();
      longTasks.clear();
      events.clear();
      lightWorkTotals.clear();
      lightActiveWorkRoutes.clear();
      lightWorkSamples.clear();
      currentFrame = null;
      eventSequence = 0;
      hudCache = null;
      hudCacheAtMs = Number.NEGATIVE_INFINITY;
      hudCacheStageNames = null;
      browserFrames.reset();
    },
    snapshot(resources = {}) {
      const stages = {};
      for (const [stage, values] of [...stageSamples].sort(([a], [b]) => a.localeCompare(b))) {
        stages[stage] = distribution(values);
      }
      const frame = distribution(frameSamples);
      const hitchRecords = hitches.toArray();
      const detailedFrames = frameRecords.toArray();
      const longTaskRecords = longTasks.toArray();
      return Object.freeze({
        schemaVersion: 'w8-measurement-report-1',
        enabled: active,
        mode: diagnosticMode,
        runNumber,
        profile: Object.freeze({ ...profile }),
        environment: Object.freeze({ ...environment }),
        frame,
        hitchThresholdMs,
        hitchRatio: frameHitchFlags.length
          ? frameHitchFlags.sum / frameHitchFlags.length : 0,
        hitches: Object.freeze(hitchRecords.map(value => Object.freeze({
          ...value,
          stages: Object.freeze({ ...value.stages }),
          work: Object.freeze({ ...value.work }),
        }))),
        frames: Object.freeze(detailedFrames.map(value => Object.freeze({
          ...value,
          stages: Object.freeze({ ...value.stages }),
          work: Object.freeze({ ...value.work }),
        }))),
        work: detailed
          ? workDistributions(frameRecords) : sampledWorkDistributions(lightWorkSamples),
        events: Object.freeze(events.toArray()),
        stages: Object.freeze(stages),
        longTasks: Object.freeze(longTaskRecords),
        resources: Object.freeze({ ...resources }),
        browserFrameAttribution: browserFrames.snapshot(),
        observers: Object.freeze({
          longTaskSupported: typeof globalObject.PerformanceObserver === 'function',
          longTaskActive: observer !== null && !longTaskObserverQuarantined,
          longTaskQuarantined: longTaskObserverQuarantined,
          userTimingSupported,
          userTimingActive,
          userTimingQuarantined,
          errorCount: observerErrorCount,
          lastError: observerLastError,
        }),
        storage: Object.freeze({
          numericFrameSampleCount: frameSamples.length,
          numericFrameSampleCapacity: sampleLimit,
          numericHitchFlagCount: frameHitchFlags.length,
          frameDetailCount: frameRecords.length,
          frameDetailCapacity: DEFAULT_FRAME_DETAIL_LIMIT,
          numericOnlyLightPath: active && !detailed,
          eventCount: events.length,
          eventCapacity: DEFAULT_EVENT_LIMIT,
          longTaskCount: longTasks.length,
          longTaskCapacity: hitchLimit,
        }),
      });
    },
    hudSnapshot(resources = {}, stageNames = []) {
      const snapshotAtMs = clock();
      if (hudCache && hudCacheStageNames === stageNames
          && snapshotAtMs - hudCacheAtMs < hudRefreshIntervalMs) return hudCache;
      const stages = {};
      for (const stage of stageNames) {
        if (typeof stage !== 'string' || !stage || stages[stage]) continue;
        stages[stage] = distribution(stageSamples.get(stage) ?? []);
      }
      const frame = distribution(frameSamples);
      const longTaskRecords = longTasks.toArray();
      hudCache = Object.freeze({
        schemaVersion: 'w8-hud-measurement-summary-1',
        frame,
        hitchRatio: frameHitchFlags.length
          ? frameHitchFlags.sum / frameHitchFlags.length : 0,
        stages: Object.freeze(stages),
        longTaskCount: longTasks.length,
        longTaskMaximumMs: longTaskRecords.reduce(
          (maximum, entry) => Math.max(maximum, entry.durationMs), 0,
        ),
        resources: Object.freeze({ ...resources }),
      });
      hudCacheAtMs = snapshotAtMs;
      hudCacheStageNames = stageNames;
      return hudCache;
    },
    dispose() {
      try {
        observer?.disconnect?.();
      } catch (error) {
        reportObserverError('long-task-disconnect', error);
      }
      observer = null;
    },
  });
}
