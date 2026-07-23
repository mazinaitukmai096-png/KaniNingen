import test from 'node:test';
import assert from 'node:assert/strict';
import {
  W8_DIAGNOSTIC_PROFILES,
  correlateW8HitchStages,
  createW8RuntimeDiagnostics,
  evaluateW8PerformanceRuns,
  parseW8DiagnosticProfile,
} from '../src/infinite-world/runtime-diagnostics.js';

test('diagnostic profiles isolate one W8 subsystem without changing baseline defaults', () => {
  assert.deepEqual(parseW8DiagnosticProfile(), { profileId: 'baseline', ...W8_DIAGNOSTIC_PROFILES.baseline });
  assert.equal(parseW8DiagnosticProfile('no-save').save, false);
  assert.equal(parseW8DiagnosticProfile('no-distant').distant, false);
  assert.equal(parseW8DiagnosticProfile('no-shadows').shadows, false);
  assert.equal(parseW8DiagnosticProfile('no-transparent').transparency, false);
  assert.equal(parseW8DiagnosticProfile('no-gameplay-sync').gameplaySync, false);
  assert.throws(() => parseW8DiagnosticProfile('worker-first'), /unsupported diagnosticProfile/);
});

test('MeasurementReport correlates stage samples with hitch frames and reports percentiles', async () => {
  let now = 0;
  const diagnostics = createW8RuntimeDiagnostics({
    enabled: true,
    clock: () => now,
    globalObject: {},
    profile: parseW8DiagnosticProfile('baseline'),
    runNumber: 2,
    environment: { viewport: '1920x1080' },
  });
  diagnostics.startFrame(0);
  diagnostics.measure('render', () => { now += 12; });
  await diagnostics.measureAsync('save-serialization', async () => { now += 44; });
  diagnostics.finishFrame(56, now);
  now += 1;
  diagnostics.startFrame(now);
  diagnostics.measure('render', () => { now += 10; });
  diagnostics.finishFrame(10, now);

  const report = diagnostics.snapshot({ geometries: 7 });
  assert.equal(report.schemaVersion, 'w8-measurement-report-1');
  assert.equal(report.runNumber, 2);
  assert.equal(report.frame.count, 2);
  assert.equal(report.frame.p95, 56);
  assert.equal(report.hitchRatio, 0.5);
  assert.equal(report.hitches[0].stages['save-serialization'], 44);
  assert.equal(report.stages.render.count, 2);
  assert.equal(report.resources.geometries, 7);
  diagnostics.dispose();
});

test('five-run acceptance uses medians, relative floors, ratio, and recurring stage stops', () => {
  const report = (p95, p99, hitchRatio, { stopStage = null, max = 60 } = {}) => ({
    frame: { p95, p99, max }, hitchRatio, longTasks: [],
    hitches: stopStage ? [{ durationMs: 120, stages: { [stopStage]: 85 } }] : [],
  });
  const finiteReports = [14, 15, 16, 15, 14].map(value => report(value, value + 12, 0));
  const w8Reports = [18, 19, 20, 19, 18].map(value => report(value, 36, 0.004));
  const accepted = evaluateW8PerformanceRuns({ finiteReports, w8Reports });
  assert.equal(accepted.pass, true);
  assert.deepEqual(accepted.limits, { p95: 20, p99: 40.5, over50Ratio: 0.005 });
  assert.equal(accepted.diagnostics.maximumFrameMs, 60);

  const stopped = w8Reports.map((value, index) => index < 2
    ? report(18, 36, 0.004, { stopStage: 'distant-sync', max: 150 }) : value);
  const rejected = evaluateW8PerformanceRuns({ finiteReports, w8Reports: stopped });
  assert.equal(rejected.pass, false);
  assert.deepEqual(rejected.recurringStageStops, [{ stage: 'distant-sync', runCount: 2 }]);
  assert.deepEqual(correlateW8HitchStages(stopped), [{ stage: 'distant-sync', runCount: 2 }]);
  assert.throws(() => evaluateW8PerformanceRuns({ finiteReports: [], w8Reports }), /exactly five/);
});
