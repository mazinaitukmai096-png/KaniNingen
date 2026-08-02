import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_STREAMING_BENCHMARK_SCHEMA,
  evaluateNodeStreamingBenchmark,
} from './infinite-world-streaming-performance-benchmark-helper.mjs';

const passingInput = Object.freeze({
  requiredOwnerMissingCount: 0,
  duplicateQueueCount: 0,
  stalePublicationCount: 0,
  orphanResourceCount: 0,
  admissionMaximumPerFrame: 1,
  configuredAdmissionLimit: 1,
  baselineWork: Object.freeze({ matrixUpdates: 40, uploadBytes: 3_040, allocations: 45 }),
  observedWork: Object.freeze({ matrixUpdates: 40, uploadBytes: 3_040, allocations: 45 }),
});

test('Node/FakeThree benchmark is deterministic evidence and leaves Browser frame gates pending', () => {
  const result = evaluateNodeStreamingBenchmark(passingInput);
  assert.equal(result.schemaVersion, NODE_STREAMING_BENCHMARK_SCHEMA);
  assert.equal(result.environment, 'node-fakethree');
  assert.equal(result.browserFrameGate, 'pending');
  assert.equal(result.deterministicPass, true);
  assert.equal(result.admissionLimitChangeRequired, false);
  assert.equal(result.productionBudgetChangeRequired, false);
});

test('admission changes require measured missing required owners', () => {
  const result = evaluateNodeStreamingBenchmark({
    ...passingInput,
    requiredOwnerMissingCount: 1,
  });
  assert.equal(result.deterministicPass, false);
  assert.equal(result.admissionLimitChangeRequired, true);
});

test('production budget changes require deterministic work regression', () => {
  const result = evaluateNodeStreamingBenchmark({
    ...passingInput,
    observedWork: Object.freeze({ matrixUpdates: 41, uploadBytes: 3_040, allocations: 45 }),
  });
  assert.equal(result.deterministicPass, false);
  assert.equal(result.productionBudgetChangeRequired, true);
  assert.deepEqual(result.workRegressions, ['matrixUpdates']);
});
