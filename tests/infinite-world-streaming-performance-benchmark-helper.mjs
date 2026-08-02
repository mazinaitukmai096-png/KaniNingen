export const NODE_STREAMING_BENCHMARK_SCHEMA = 'node-streaming-benchmark-1';

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function evaluateNodeStreamingBenchmark({
  requiredOwnerMissingCount,
  duplicateQueueCount,
  stalePublicationCount,
  orphanResourceCount,
  admissionMaximumPerFrame,
  configuredAdmissionLimit,
  baselineWork = null,
  observedWork,
} = {}) {
  const requiredMissing = nonNegativeInteger(
    requiredOwnerMissingCount,
    'requiredOwnerMissingCount',
  );
  const duplicates = nonNegativeInteger(duplicateQueueCount, 'duplicateQueueCount');
  const stale = nonNegativeInteger(stalePublicationCount, 'stalePublicationCount');
  const orphans = nonNegativeInteger(orphanResourceCount, 'orphanResourceCount');
  const admissionMaximum = nonNegativeInteger(
    admissionMaximumPerFrame,
    'admissionMaximumPerFrame',
  );
  const admissionLimit = nonNegativeInteger(configuredAdmissionLimit, 'configuredAdmissionLimit');
  if (!observedWork || typeof observedWork !== 'object') {
    throw new TypeError('observedWork is required');
  }
  const normalizedWork = Object.freeze(Object.fromEntries(
    Object.entries(observedWork).map(([key, value]) => [key, nonNegativeInteger(value, key)]),
  ));
  const workRegressions = Object.freeze(baselineWork
    ? Object.keys(normalizedWork).filter(key => (
      Number.isFinite(baselineWork[key]) && normalizedWork[key] > baselineWork[key]
    ))
    : []);
  const deterministicPass = requiredMissing === 0
    && duplicates === 0
    && stale === 0
    && orphans === 0
    && workRegressions.length === 0;
  return Object.freeze({
    schemaVersion: NODE_STREAMING_BENCHMARK_SCHEMA,
    environment: 'node-fakethree',
    browserFrameGate: 'pending',
    deterministicPass,
    admissionLimitChangeRequired: requiredMissing > 0,
    productionBudgetChangeRequired: workRegressions.length > 0,
    admissionMaximumPerFrame: admissionMaximum,
    configuredAdmissionLimit: admissionLimit,
    workRegressions,
    observedWork: normalizedWork,
  });
}
