function finiteDuration(value) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('duration must be a finite non-negative number');
  return value;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export class MetricSeries {
  constructor(capacity = 2048) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('metric capacity must be positive');
    this.capacity = capacity;
    this.values = [];
    this.totalCount = 0;
  }

  record(durationMs) {
    const value = finiteDuration(durationMs);
    this.values.push(value);
    this.totalCount += 1;
    if (this.values.length > this.capacity) this.values.shift();
    return value;
  }

  snapshot() {
    const sorted = [...this.values].sort((a, b) => a - b);
    return Object.freeze({
      count: this.totalCount,
      sampleCount: this.values.length,
      latest: this.values.at(-1) ?? 0,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.at(-1) ?? 0,
    });
  }
}

export class PerformanceLedger {
  constructor() {
    this.series = Object.freeze({
      generation: new MetricSeries(),
      projection: new MetricSeries(),
      load: new MetricSeries(),
      unload: new MetricSeries(),
      rebase: new MetricSeries(),
      crossing: new MetricSeries(),
      frame: new MetricSeries(4096),
    });
  }

  record(name, durationMs) {
    const series = this.series[name];
    if (!series) throw new TypeError(`unknown performance metric ${name}`);
    return series.record(durationMs);
  }

  snapshot() {
    return Object.freeze(Object.fromEntries(
      Object.entries(this.series).map(([name, series]) => [name, series.snapshot()]),
    ));
  }
}

export function evaluateW1APerformanceWarnings(performanceSnapshot) {
  const warnings = [];
  if (performanceSnapshot.generation.p95 > 100) {
    warnings.push(`generation p95 ${performanceSnapshot.generation.p95.toFixed(1)}ms > 100ms`);
  }
  if (performanceSnapshot.load.p95 > 100) {
    warnings.push(`load p95 ${performanceSnapshot.load.p95.toFixed(1)}ms > 100ms`);
  }
  if (performanceSnapshot.crossing.max > 200) {
    warnings.push(`crossing max ${performanceSnapshot.crossing.max.toFixed(1)}ms > 200ms`);
  }
  return Object.freeze(warnings);
}
