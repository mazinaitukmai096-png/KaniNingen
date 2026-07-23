const DEFAULT_SAMPLE_LIMIT = 7_200;
const DEFAULT_HITCH_LIMIT = 256;

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

function distribution(values) {
  if (!values.length) {
    return Object.freeze({ count: 0, latest: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });
  }
  const ordered = [...values].sort((a, b) => a - b);
  const sum = ordered.reduce((total, value) => total + value, 0);
  return Object.freeze({
    count: ordered.length,
    latest: values.at(-1),
    p50: ordered[clampIndex(ordered.length, 0.5)],
    p95: ordered[clampIndex(ordered.length, 0.95)],
    p99: ordered[clampIndex(ordered.length, 0.99)],
    max: ordered.at(-1),
    mean: sum / ordered.length,
  });
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
  const over50RatioLimit = finiteOver50Ratio > 0.005
    ? finiteOver50Ratio + 0.001 : 0.005;
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
    absoluteOver50Ratio: finiteOver50Ratio > 0.005 || over50Ratio <= 0.005,
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
  runNumber = 1,
  environment = {},
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
  hitchLimit = DEFAULT_HITCH_LIMIT,
  hitchThresholdMs = 50,
} = {}) {
  if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw new TypeError('runNumber must be positive');
  if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1) throw new TypeError('sampleLimit must be positive');
  if (!Number.isSafeInteger(hitchLimit) || hitchLimit < 1) throw new TypeError('hitchLimit must be positive');
  if (!Number.isFinite(hitchThresholdMs) || hitchThresholdMs <= 0) {
    throw new TypeError('hitchThresholdMs must be positive');
  }
  const performanceObject = globalObject.performance ?? null;
  const stageSamples = new Map();
  const frameSamples = [];
  const hitches = [];
  const longTasks = [];
  let currentFrame = null;
  let frameSequence = 0;
  let markSequence = 0;
  let observer = null;

  const pushBounded = (target, value, limit) => {
    target.push(value);
    if (target.length > limit) target.splice(0, target.length - limit);
  };
  const recordStage = (stage, durationMs) => {
    if (!enabled) return durationMs;
    if (!stageSamples.has(stage)) stageSamples.set(stage, []);
    pushBounded(stageSamples.get(stage), durationMs, sampleLimit);
    if (currentFrame) {
      currentFrame.stages[stage] = (currentFrame.stages[stage] ?? 0) + durationMs;
    }
    return durationMs;
  };
  const begin = stage => {
    const startedAt = clock();
    const sequence = ++markSequence;
    const startMark = `w8:${stage}:${sequence}:start`;
    const endMark = `w8:${stage}:${sequence}:end`;
    if (enabled) performanceObject?.mark?.(startMark);
    return Object.freeze({ stage, startedAt, sequence, startMark, endMark });
  };
  const end = token => {
    const durationMs = Math.max(0, clock() - token.startedAt);
    if (enabled) {
      performanceObject?.mark?.(token.endMark);
      try {
        performanceObject?.measure?.(`w8:${token.stage}`, token.startMark, token.endMark);
      } catch { /* Performance mark buffers are optional diagnostics. */ }
      performanceObject?.clearMarks?.(token.startMark);
      performanceObject?.clearMarks?.(token.endMark);
    }
    return recordStage(token.stage, durationMs);
  };

  if (enabled && typeof globalObject.PerformanceObserver === 'function') {
    try {
      observer = new globalObject.PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          pushBounded(longTasks, Object.freeze({
            name: String(entry.name ?? 'longtask'),
            startTime: Number(entry.startTime ?? 0),
            durationMs: Number(entry.duration ?? 0),
          }), hitchLimit);
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch { observer = null; }
  }

  return Object.freeze({
    profile,
    enabled,
    begin,
    end,
    measure(stage, operation) {
      const token = begin(stage);
      try { return operation(); }
      finally { end(token); }
    },
    async measureAsync(stage, operation) {
      const token = begin(stage);
      try { return await operation(); }
      finally { end(token); }
    },
    startFrame(frameNow = clock()) {
      if (!enabled) return null;
      currentFrame = { sequence: ++frameSequence, startedAt: frameNow, stages: {} };
      return currentFrame.sequence;
    },
    finishFrame(durationMs, frameNow = clock()) {
      if (!enabled) return null;
      const record = Object.freeze({
        sequence: currentFrame?.sequence ?? ++frameSequence,
        startedAt: currentFrame?.startedAt ?? frameNow - durationMs,
        durationMs,
        stages: Object.freeze({ ...(currentFrame?.stages ?? {}) }),
      });
      pushBounded(frameSamples, durationMs, sampleLimit);
      if (durationMs > hitchThresholdMs) pushBounded(hitches, record, hitchLimit);
      currentFrame = null;
      return record;
    },
    reset() {
      stageSamples.clear();
      frameSamples.length = 0;
      hitches.length = 0;
      longTasks.length = 0;
      currentFrame = null;
    },
    snapshot(resources = {}) {
      const stages = {};
      for (const [stage, values] of [...stageSamples].sort(([a], [b]) => a.localeCompare(b))) {
        stages[stage] = distribution(values);
      }
      const frame = distribution(frameSamples);
      return Object.freeze({
        schemaVersion: 'w8-measurement-report-1',
        enabled,
        runNumber,
        profile: Object.freeze({ ...profile }),
        environment: Object.freeze({ ...environment }),
        frame,
        hitchThresholdMs,
        hitchRatio: frame.count ? hitches.length / frame.count : 0,
        hitches: Object.freeze(hitches.map(value => Object.freeze({
          ...value, stages: Object.freeze({ ...value.stages }),
        }))),
        stages: Object.freeze(stages),
        longTasks: Object.freeze([...longTasks]),
        resources: Object.freeze({ ...resources }),
      });
    },
    dispose() {
      observer?.disconnect?.();
      observer = null;
    },
  });
}
