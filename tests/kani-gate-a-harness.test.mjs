import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  KANI_CONTROLLED_SPRINT_SCENARIOS,
  KANI_PERFORMANCE_CAPTURE_SCHEMA,
  KANI_PERFORMANCE_GATE,
  KANI_PERFORMANCE_SUMMARY_SCHEMA,
  evaluateKaniControlledScenarioMatrix,
  evaluateKaniPerformanceRunSet,
  summarizeKaniPerformanceCapture,
} from '../tools/summarize-kani-performance-capture.mjs';
import {
  KANI_TEST_MANIFEST_SCHEMA,
  compareTestManifests,
  parseTapFailureRecords,
  parseTapFailures,
} from '../tools/run-kani-tests.mjs';

function compactEndpoint({ transitionP95 = 40, runtimeFailures = 0 } = {}) {
  return Object.freeze({
    boot: Object.freeze({ status: 'ready', stage: 'Ready', loopStarted: true }),
    player: Object.freeze({ x: 0, z: 0 }),
    scaleStageId: 'MAX',
    experience: Object.freeze({
      mode: 'playing',
      runPhase: 'playing',
      paused: false,
      cameraYaw: 0,
      quality: 'high',
      renderDistance: 'MAX',
    }),
    runtimeCenter: Object.freeze({ centerChunkX: 0, centerChunkZ: 0 }),
    runtimeFrameFailureCount: runtimeFailures,
    frame: Object.freeze({ count: 3_600, p50: 16, p95: 20, p99: 25, max: 50 }),
    stages: Object.freeze({
      chunkTransition: Object.freeze({ count: 10, p50: 20, p95: transitionP95, max: 60 }),
    }),
    terrainCoverageDiagnostics: Object.freeze({
      movementBlockedByTerrain: 0,
      visualBlankFrame: 0,
      visualWorldCoverageMiss: 0,
      collisionCoverageMiss: 0,
    }),
    presentation: Object.freeze({
      staticTreeMatrixUpdateCount: 20,
      staticTreeBufferRangeUpdateCount: 10,
      staticTreeBufferUploadByteCount: 1_024,
      distantPersistentMatrixUpdateCount: 5,
      distantPersistentBufferUpdateCount: 4,
      distantPersistentUploadByteCount: 512,
      terrainSliceCount: 30,
    }),
  });
}

function exactCapture({
  scenario = 'max-sprint-straight',
  runNumber = 1,
  comparisonRole = 'candidate',
  frameP50 = 16,
  frameP95 = 20,
  frameP99 = 30,
  frameMax = 50,
  over20Ratio = 0.02,
  over50Ratio = 0,
  over100Ratio = 0,
  onePercentLowFps = 1_000 / frameP99,
  transitionP95 = 40,
  validationApplicable = true,
  validationValid = true,
} = {}) {
  const steady = scenario === 'steady-state';
  const targetSpeedMetersPerSecond = steady ? 0 : 30;
  const inputTransitions = [];
  if (!steady) {
    inputTransitions.push(
      { atMs: 0, type: 'keydown', code: 'ShiftLeft' },
      { atMs: 0, type: 'keydown', code: 'KeyW' },
    );
    if (scenario === 'max-sprint-diagonal') {
      inputTransitions.push({ atMs: 0, type: 'keydown', code: 'KeyD' });
    }
    if (scenario === 'max-sprint-90-turn') {
      inputTransitions.push(
        { atMs: 30_000, type: 'keyup', code: 'KeyW' },
        { atMs: 30_000, type: 'keydown', code: 'KeyD' },
      );
    } else if (['max-sprint-reversal', 'max-sprint-warm-revisit'].includes(scenario)) {
      inputTransitions.push(
        { atMs: 30_000, type: 'keyup', code: 'KeyW' },
        { atMs: 30_000, type: 'keydown', code: 'KeyS' },
      );
    } else {
      inputTransitions.push({ atMs: 60_000, type: 'keyup', code: 'KeyW' });
    }
    if (scenario === 'max-sprint-diagonal') {
      inputTransitions.push({ atMs: 60_000, type: 'keyup', code: 'KeyD' });
    }
    if (scenario === 'max-sprint-90-turn') {
      inputTransitions.push({ atMs: 60_000, type: 'keyup', code: 'KeyD' });
    }
    if (['max-sprint-reversal', 'max-sprint-warm-revisit'].includes(scenario)) {
      inputTransitions.push({ atMs: 60_000, type: 'keyup', code: 'KeyS' });
    }
    inputTransitions.push({ atMs: 60_000, type: 'keyup', code: 'ShiftLeft' });
  }
  const before = compactEndpoint({ transitionP95 });
  const afterBase = compactEndpoint({ transitionP95 });
  const after = scenario === 'max-sprint-cold-entry' ? Object.freeze({
    ...afterBase,
    player: Object.freeze({ x: 1_800, z: 0 }),
    runtimeCenter: Object.freeze({ centerChunkX: 7, centerChunkZ: 0 }),
  }) : afterBase;
  return Object.freeze({
    schemaVersion: KANI_PERFORMANCE_CAPTURE_SCHEMA,
    source: Object.freeze({
      scenario,
      runNumber,
      comparisonRole,
      controlMode: 'input-driver',
      targetSpeedMetersPerSecond,
      warmupMs: 10_000,
      requestedDurationMs: 60_000,
      seed: 'gate-a-seed-1',
      worldSeed: 'gate-a-seed-1',
      worldSeedHash: `sha256:${'a'.repeat(64)}`,
      checkpoint: 'gate-a-controlled-spawn',
      routeRevision: 'gate-a-input-route-1',
      startOwnerKey: '0,0',
      quality: 'high',
      renderDistance: 'MAX',
      rendererIdentity: 'Test GPU Vendor | Test Hardware GPU',
      rendererHardwareAccelerated: true,
      requiredVisitedOwnerKeys: Object.freeze(scenario === 'max-sprint-cold-entry'
        ? ['55,77', '58,71'] : []),
      visitedOwnerKeys: Object.freeze(scenario === 'max-sprint-cold-entry'
        ? ['0,0', '55,77', '58,71'] : scenario === 'max-sprint-warm-revisit'
          ? ['0,0', '0,1'] : ['0,0']),
      visitedOwnerSequence: Object.freeze(scenario === 'max-sprint-warm-revisit'
        ? ['0,0', '0,1', '0,0'] : scenario === 'max-sprint-cold-entry'
          ? ['0,0', '55,77', '58,71'] : ['0,0']),
      revisitOwnerKey: scenario === 'max-sprint-warm-revisit' ? '0,0' : null,
      userAgent: 'Edg/140',
      devicePixelRatio: 1,
      viewportWidth: 1_920,
      viewportHeight: 1_080,
    }),
    sample: Object.freeze({
      frame: Object.freeze({
        count: 3_600,
        latest: 16,
        p50: frameP50,
        p95: frameP95,
        p99: frameP99,
        max: frameMax,
        mean: 16.5,
      }),
      onePercentLowFps,
      over20Ratio,
      over33Ratio: 0.001,
      over50Ratio,
      over100Ratio,
      longTasks: Object.freeze({ supported: true, count: 0, max: 0, over100Count: 0 }),
      visibilityChanges: Object.freeze([
        Object.freeze({ atMs: 0, visibilityState: 'visible' }),
      ]),
      control: Object.freeze({
        scenario,
        targetSpeedMetersPerSecond,
        frameCount: 3_600,
        commandDurationMs: 60_000,
        actualPathDistanceMeters: steady ? 0 : 1_800,
        actualAverageSpeedMetersPerSecond: targetSpeedMetersPerSecond,
        expectedDistanceMeters: targetSpeedMetersPerSecond * 60,
        inputTransitions: Object.freeze(inputTransitions.map(Object.freeze)),
      }),
    }),
    before,
    after,
    counterDeltas: Object.freeze({
      recordedFrameCount: 3_600,
      runtimeFrameFailureCount: 0,
      staticTreeBufferUploadBytes: 0,
    }),
    validation: Object.freeze({
      schemaVersion: 'kani-performance-capture-state-validation-1',
      applicable: validationApplicable,
      valid: validationValid,
      expected: Object.freeze({}),
      actual: Object.freeze({}),
      issues: Object.freeze([]),
    }),
  });
}

function fiveRunSummaries(comparisonRole, metrics = {}) {
  return Array.from({ length: 5 }, (_, index) => summarizeKaniPerformanceCapture(exactCapture({
    runNumber: index + 1,
    comparisonRole,
    ...metrics,
  })));
}

test('Gate A summary consumes exact Browser samples without subtracting percentiles', () => {
  const capture = exactCapture();
  const summary = summarizeKaniPerformanceCapture(capture, { fileName: 'capture.json' });
  assert.equal(summary.schemaVersion, KANI_PERFORMANCE_SUMMARY_SCHEMA);
  assert.equal(summary.source.captureSchemaVersion, KANI_PERFORMANCE_CAPTURE_SCHEMA);
  assert.equal(summary.protocol.exactFrameSample, true);
  assert.equal(summary.protocol.endpointPercentileSubtractionUsed, false);
  assert.equal(summary.protocol.actualStateValidated, true);
  assert.equal(summary.sample.frame.p95, 20);
  assert.equal(summary.counterDeltas.staticTreeBufferUploadBytes, 0);
  assert.equal(summary.acceptance.status, 'pass');
  assert.equal(summary.acceptance.criteria.runtimeLoopAlive, true);
});

test('Gate A single-run ceilings include p99, 0.5% over-50, and zero over-100 frames', () => {
  assert.deepEqual(KANI_PERFORMANCE_GATE, {
    frameP95MaximumMs: 33,
    frameP99MaximumMs: 50,
    frameMaximumMs: 100,
    framesOver50MaximumRatio: 0.005,
    framesOver100MaximumRatio: 0,
    chunkTransitionP95MaximumMs: 100,
    relativeNonRegressionMaximumRatio: 1.05,
    frameP50MaximumRegressionMs: 0.5,
    frameP99RequiredImprovementRatio: 0.7,
    framesOver20RequiredImprovementRatio: 0.5,
    framesOver50RequiredImprovementRatio: 0.2,
    onePercentLowRequiredImprovementRatio: 1.25,
  });
  const boundary = summarizeKaniPerformanceCapture(exactCapture({
    frameP99: 50,
    frameMax: 100,
    over50Ratio: 0.005,
  }));
  assert.equal(boundary.acceptance.criteria.frameP99, true);
  assert.equal(boundary.acceptance.criteria.framesOver50, true);
  assert.equal(boundary.acceptance.criteria.framesOver100, true);

  const capture = exactCapture({ frameP99: 50.001, frameMax: 100.001, over50Ratio: 0.005001 });
  const failed = summarizeKaniPerformanceCapture({
    ...capture,
    sample: Object.freeze({ ...capture.sample, over100Ratio: 1 / 3_600 }),
  });
  assert.equal(failed.acceptance.criteria.frameP99, false);
  assert.equal(failed.acceptance.criteria.frameMaximum, false);
  assert.equal(failed.acceptance.criteria.framesOver50, false);
  assert.equal(failed.acceptance.criteria.framesOver100, false);
  assert.equal(failed.acceptance.status, 'fail');
});

test('legacy compact capture remains readable but cannot silently pass the Browser gate', () => {
  const endpoint = compactEndpoint();
  const summary = summarizeKaniPerformanceCapture({
    schemaVersion: 'kani-performance-summary-1',
    source: { label: 'legacy' },
    before: endpoint,
    after: endpoint,
  });
  assert.equal(summary.before, endpoint,
    'an already compact endpoint must not be interpreted as a raw sandbox snapshot');
  assert.equal(summary.protocol.exactFrameSample, false);
  assert.equal(summary.protocol.browserFrameGate, 'pending');
  assert.equal(summary.acceptance.criteria.exactFrameSample, null);
});

test('five-run gate applies documented absolute and relative medians to exact captures', () => {
  const baselineSummaries = Array.from({ length: 5 }, (_, index) => (
    summarizeKaniPerformanceCapture(exactCapture({
      runNumber: index + 1,
      comparisonRole: 'baseline',
      frameP95: 25,
      frameP99: 40,
      frameMax: 80,
      transitionP95: 60,
    }))
  ));
  const candidateSummaries = Array.from({ length: 5 }, (_, index) => (
    summarizeKaniPerformanceCapture(exactCapture({
      runNumber: index + 1,
      frameP95: 23,
      frameP99: 35,
      frameMax: 70,
      transitionP95: 55,
    }))
  ));
  const gate = evaluateKaniPerformanceRunSet({ baselineSummaries, candidateSummaries });
  assert.equal(gate.status, 'pass');
  assert.equal(gate.medians.baseline.frameP95Ms, 25);
  assert.equal(gate.medians.candidate.frameP95Ms, 23);
  assert.equal(gate.criteria.frameP95Relative, true);
  assert.equal(gate.baselineFloorReached, true);

  const regressed = candidateSummaries.map((summary, index) => index < 3
    ? summarizeKaniPerformanceCapture(exactCapture({
      runNumber: index + 1,
      frameP95: 33,
      frameP99: 45,
      frameMax: 70,
      transitionP95: 55,
    }))
    : summary);
  assert.equal(evaluateKaniPerformanceRunSet({
    baselineSummaries,
    candidateSummaries: regressed,
  }).criteria.frameP95Relative, false,
  'the median regression must fail even when the absolute 33ms ceiling is met');
});

test('five-run gate enforces the p50 5% or 0.5ms non-regression ceiling', () => {
  const baselineSummaries = fiveRunSummaries('baseline', { frameP50: 10 });
  const candidateSummaries = fiveRunSummaries('candidate', { frameP50: 10.501 });
  const gate = evaluateKaniPerformanceRunSet({ baselineSummaries, candidateSummaries });
  assert.equal(gate.baselineFloorReached, true);
  assert.equal(gate.criteria.frameP50Relative, false);
  assert.deepEqual(
    Object.entries(gate.criteria).filter(([, value]) => value === false).map(([name]) => name),
    ['frameP50Relative'],
  );
});

test('floor-miss gate requires every documented pacing improvement independently', () => {
  const baselineMetrics = {
    frameP95: 25,
    frameP99: 60,
    frameMax: 80,
    over20Ratio: 0.1,
    over50Ratio: 0.01,
    over100Ratio: 0.001,
    onePercentLowFps: 10,
  };
  const candidateMetrics = {
    frameP95: 20,
    frameP99: 40,
    frameMax: 70,
    over20Ratio: 0.05,
    over50Ratio: 0.002,
    over100Ratio: 0,
    onePercentLowFps: 12.5,
  };
  const baselineSummaries = fiveRunSummaries('baseline', baselineMetrics);
  const evaluate = overrides => evaluateKaniPerformanceRunSet({
    baselineSummaries,
    candidateSummaries: fiveRunSummaries('candidate', {
      ...candidateMetrics,
      ...overrides,
    }),
  });
  const passing = evaluate({});
  assert.equal(passing.baselineFloorReached, false);
  assert.equal(passing.status, 'pass');

  for (const witness of [
    ['frameP99Relative', { frameP99: 42.001 }],
    ['framesOver20Relative', { over20Ratio: 0.05001 }],
    ['framesOver50Relative', { over50Ratio: 0.002001 }],
    ['onePercentLowRelative', { onePercentLowFps: 12.499 }],
  ]) {
    const [expectedFailure, overrides] = witness;
    const gate = evaluate(overrides);
    assert.deepEqual(
      Object.entries(gate.criteria).filter(([, value]) => value === false).map(([name]) => name),
      [expectedFailure],
      `${expectedFailure} must independently fail the floor-miss gate`,
    );
  }
});

test('floor-reached gate limits every major relative metric to five percent', () => {
  const baselineMetrics = {
    frameP50: 10,
    frameP95: 20,
    frameP99: 40,
    frameMax: 80,
    over20Ratio: 0.02,
    over50Ratio: 0.004,
    over100Ratio: 0,
    onePercentLowFps: 25,
    transitionP95: 40,
  };
  const baselineSummaries = fiveRunSummaries('baseline', baselineMetrics);
  const evaluate = overrides => evaluateKaniPerformanceRunSet({
    baselineSummaries,
    candidateSummaries: fiveRunSummaries('candidate', {
      ...baselineMetrics,
      ...overrides,
    }),
  });
  assert.equal(evaluate({}).status, 'pass');
  for (const witness of [
    ['frameP95Relative', { frameP95: 21.001 }],
    ['frameP99Relative', { frameP99: 42.001, onePercentLowFps: 25 }],
    ['frameMaximumRelative', { frameMax: 84.001 }],
    ['framesOver20Relative', { over20Ratio: 0.021001 }],
    ['framesOver50Relative', { over50Ratio: 0.004201 }],
    ['chunkTransitionP95Relative', { transitionP95: 42.001 }],
    ['onePercentLowRelative', { onePercentLowFps: 23.8 }],
  ]) {
    const [expectedFailure, overrides] = witness;
    const gate = evaluate(overrides);
    assert.deepEqual(
      Object.entries(gate.criteria).filter(([, value]) => value === false).map(([name]) => name),
      [expectedFailure],
      `${expectedFailure} must independently fail the floor-reached gate`,
    );
  }
  const zeroBaseline = fiveRunSummaries('baseline', {
    ...baselineMetrics,
    over20Ratio: 0,
    over50Ratio: 0,
    over100Ratio: 0,
  });
  const zeroCandidate = fiveRunSummaries('candidate', {
    ...baselineMetrics,
    over20Ratio: 0,
    over50Ratio: 0,
    over100Ratio: 0,
  });
  assert.equal(evaluateKaniPerformanceRunSet({
    baselineSummaries: zeroBaseline,
    candidateSummaries: zeroCandidate,
  }).status, 'pass', 'zero denominators require non-regression and must not divide by zero');
});

test('candidate immediate criteria must all be strictly true while baseline faults stay comparative', () => {
  const baselineSummaries = fiveRunSummaries('baseline');
  const candidateSummaries = fiveRunSummaries('candidate');
  const original = candidateSummaries[0];
  const pendingCandidate = Object.freeze({
    ...original,
    acceptance: Object.freeze({
      ...original.acceptance,
      status: 'pass',
      pass: true,
      criteria: Object.freeze({
        ...original.acceptance.criteria,
        movementBlockedByTerrain: null,
      }),
    }),
  });
  const pendingGate = evaluateKaniPerformanceRunSet({
    baselineSummaries,
    candidateSummaries: [pendingCandidate, ...candidateSummaries.slice(1)],
  });
  assert.equal(pendingGate.criteria.noImmediateRunFailure, false);

  const baselineFault = Object.freeze({
    ...baselineSummaries[0],
    acceptance: Object.freeze({
      ...baselineSummaries[0].acceptance,
      status: 'fail',
      pass: false,
      criteria: Object.freeze({
        ...baselineSummaries[0].acceptance.criteria,
        runtimeLoopAlive: false,
      }),
    }),
  });
  assert.equal(evaluateKaniPerformanceRunSet({
    baselineSummaries: [baselineFault, ...baselineSummaries.slice(1)],
    candidateSummaries,
  }).status, 'pass');

  const nonApplicable = summarizeKaniPerformanceCapture(exactCapture({
    validationApplicable: false,
    validationValid: true,
  }));
  assert.equal(nonApplicable.acceptance.criteria.captureStateValid, false);
  assert.equal(nonApplicable.acceptance.status, 'fail');
});

test('controlled benchmark matrix requires five runs for seven distinct formal scenarios', () => {
  const captures = comparisonRole => KANI_CONTROLLED_SPRINT_SCENARIOS.flatMap(scenario => (
    Array.from({ length: 5 }, (_, index) => summarizeKaniPerformanceCapture(exactCapture({
      scenario,
      runNumber: index + 1,
      comparisonRole,
      frameP95: comparisonRole === 'baseline' ? 25 : 23,
      frameP99: comparisonRole === 'baseline' ? 40 : 35,
      frameMax: comparisonRole === 'baseline' ? 80 : 70,
      transitionP95: comparisonRole === 'baseline' ? 60 : 55,
    })))
  ));
  const baselineSummaries = captures('baseline');
  const candidateSummaries = captures('candidate');
  const gate = evaluateKaniControlledScenarioMatrix({ baselineSummaries, candidateSummaries });
  assert.equal(gate.status, 'pass');
  assert.equal(gate.criteria.exactlySeventyCaptures, true);
  assert.deepEqual(Object.keys(gate.scenarioGates), KANI_CONTROLLED_SPRINT_SCENARIOS);
  assert.deepEqual(KANI_CONTROLLED_SPRINT_SCENARIOS, [
    'steady-state',
    'max-sprint-straight',
    'max-sprint-diagonal',
    'max-sprint-90-turn',
    'max-sprint-reversal',
    'max-sprint-cold-entry',
    'max-sprint-warm-revisit',
  ]);
  const steady = candidateSummaries.find(summary => summary.source.scenario === 'steady-state');
  assert.equal(steady.source.targetSpeedMetersPerSecond, 0);
  assert.equal(steady.sample.control.actualAverageSpeedMetersPerSecond, 0);
  assert.equal(steady.sample.control.actualPathDistanceMeters, 0);
  assert.deepEqual(steady.sample.control.inputTransitions, []);
  assert.deepEqual(steady.source.visitedOwnerSequence, ['0,0']);
  const straight = candidateSummaries.find(
    summary => summary.source.scenario === 'max-sprint-straight',
  );
  assert.equal(straight.source.targetSpeedMetersPerSecond, 30);
  assert.ok(straight.sample.control.inputTransitions.length > 0);
  assert.equal(Object.values(gate.scenarioGates).every(scenarioGate => (
    scenarioGate.criteria.controlledFormalWorkload
      && scenarioGate.criteria.runNumbersComplete
      && scenarioGate.criteria.frameP50Relative
  )), true);

  const incomplete = evaluateKaniControlledScenarioMatrix({
    baselineSummaries: baselineSummaries.slice(0, -1),
    candidateSummaries,
  });
  assert.equal(incomplete.status, 'fail');
  assert.equal(incomplete.criteria.allRequiredScenariosPresent, false);

  const directMutationDriver = candidateSummaries.map((summary, index) => index === 0
    ? Object.freeze({
      ...summary,
      source: Object.freeze({ ...summary.source, controlMode: 'logical-position-driver' }),
    })
    : summary);
  const rejectedDriver = evaluateKaniControlledScenarioMatrix({
    baselineSummaries,
    candidateSummaries: directMutationDriver,
  });
  assert.equal(rejectedDriver.status, 'fail');
  assert.equal(
    rejectedDriver.scenarioGates['steady-state'].criteria.controlledFormalWorkload,
    false,
    'direct logical position mutation is not valid MAX Sprint evidence',
  );

  const missingColdWitness = candidateSummaries.map(summary => (
    summary.source.scenario === 'max-sprint-cold-entry' && summary.source.runNumber === 1
      ? Object.freeze({
        ...summary,
        source: Object.freeze({
          ...summary.source,
          visitedOwnerKeys: Object.freeze(['0,0', '55,77']),
        }),
      }) : summary
  ));
  assert.equal(evaluateKaniControlledScenarioMatrix({
    baselineSummaries,
    candidateSummaries: missingColdWitness,
  }).scenarioGates['max-sprint-cold-entry'].criteria.controlledFormalWorkload, false);

  const missingWarmRevisit = candidateSummaries.map(summary => (
    summary.source.scenario === 'max-sprint-warm-revisit' && summary.source.runNumber === 1
      ? Object.freeze({
        ...summary,
        source: Object.freeze({
          ...summary.source,
          visitedOwnerSequence: Object.freeze(['0,0', '0,1']),
        }),
      }) : summary
  ));
  assert.equal(evaluateKaniControlledScenarioMatrix({
    baselineSummaries,
    candidateSummaries: missingWarmRevisit,
  }).scenarioGates['max-sprint-warm-revisit'].criteria.controlledFormalWorkload, false);
});

test('Browser capture drives production keyboard input and never mutates logical position', () => {
  const source = readFileSync(resolve(
    import.meta.dirname,
    '../tools/capture-kani-performance-summary.browser.js',
  ), 'utf8');
  assert.match(source, /metadata\.controlMode === 'input-driver'/);
  assert.match(source, /steadyCapture[\s\S]*if \(steadyCapture\) return;[\s\S]*dispatchControlKey\('keydown', 'ShiftLeft'\)/);
  assert.match(source, /new globalThis\.KeyboardEvent\(type/);
  assert.match(source, /'ShiftLeft'[\s\S]*'KeyW'/);
  assert.match(source, /max-sprint-diagonal[\s\S]*dispatchControlKey\('keydown', 'KeyD'\)/);
  assert.match(source, /max-sprint-90-turn[\s\S]*dispatchControlKey\('keyup', 'KeyW'\)[\s\S]*dispatchControlKey\('keydown', 'KeyD'\)/);
  assert.match(source, /max-sprint-reversal[\s\S]*dispatchControlKey\('keyup', 'KeyW'\)[\s\S]*dispatchControlKey\('keydown', 'KeyS'\)/);
  assert.match(source, /max-sprint-warm-revisit[\s\S]*visitedOwnerSequence[\s\S]*revisitOwnerKey/);
  assert.match(source, /actualPathDistanceMeters:[\s\S]*actualAverageSpeedMetersPerSecond:/);
  assert.match(source, /worldSeedHash[\s\S]*startOwnerKey[\s\S]*checkpointPosition/);
  assert.match(source, /renderer\.hardwareAccelerated/);
  assert.match(source, /requiredColdWitnessOwnerKeys[\s\S]*'55,77'[\s\S]*'58,71'/);
  assert.doesNotMatch(source, /sandbox\.logicalPlayer\.(?:x|z|facingY)\s*[+*/-]?=/,
    'formal Browser evidence must not bypass runtime input, collision, or Terrain gating');
  assert.match(source, /__KANI_PERFORMANCE_CAPTURE_ACTIVE\s*=\s*true/,
    'the exact sampling window must suppress runtime HUD DOM work');
  assert.match(source, /delete globalThis\.__KANI_PERFORMANCE_CAPTURE_ACTIVE/,
    'capture teardown must restore the sampling flag even after failure');
});

test('capture-v2 state mismatch is retained and fails the summary gate', () => {
  const capture = exactCapture();
  const invalid = summarizeKaniPerformanceCapture({
    ...capture,
    validation: Object.freeze({
      ...capture.validation,
      valid: false,
      issues: Object.freeze([Object.freeze({
        field: 'worldSeedHash',
        expected: `sha256:${'a'.repeat(64)}`,
        actual: `sha256:${'b'.repeat(64)}`,
      })]),
    }),
  });
  assert.equal(invalid.protocol.exactFrameSample, true);
  assert.equal(invalid.protocol.actualStateValidated, false);
  assert.equal(invalid.acceptance.criteria.captureStateValid, false);
  assert.equal(invalid.acceptance.status, 'fail');
  assert.equal(invalid.validation.issues[0].field, 'worldSeedHash');
});

test('isolated test manifest comparison never hides existing or new failures', () => {
  const file = (path, pass, failureNames = []) => Object.freeze({
    path,
    sha256: `sha256:${path}`,
    pass,
    attempts: Object.freeze([Object.freeze({
      pass,
      timedOut: false,
      failureNames: Object.freeze(failureNames),
    })]),
  });
  const manifest = files => Object.freeze({
    schemaVersion: KANI_TEST_MANIFEST_SCHEMA,
    files: Object.freeze(files),
  });
  const comparison = compareTestManifests(
    manifest([
      file('tests/a.test.mjs', false, ['known']),
      file('tests/b.test.mjs', false, ['resolved']),
    ]),
    manifest([
      file('tests/a.test.mjs', false, ['known', 'new']),
      file('tests/b.test.mjs', true),
    ]),
  );
  assert.equal(comparison.pass, false);
  assert.deepEqual(comparison.existingFailures, [
    { path: 'tests/a.test.mjs', name: 'known' },
  ]);
  assert.deepEqual(comparison.newFailures, [
    { path: 'tests/a.test.mjs', name: 'new' },
  ]);
  assert.deepEqual(comparison.resolvedFailures, [
    { path: 'tests/b.test.mjs', name: 'resolved' },
  ]);

  const changedSource = compareTestManifests(
    manifest([file('tests/a.test.mjs', false, ['known'])]),
    manifest([Object.freeze({
      ...file('tests/a.test.mjs', false, ['known']),
      sha256: 'different-test-source',
    })]),
  );
  assert.deepEqual(changedSource.existingFailures, []);
  assert.deepEqual(changedSource.newFailures, [
    { path: 'tests/a.test.mjs', name: 'known' },
  ]);
  assert.deepEqual(changedSource.changedTestFiles, ['tests/a.test.mjs']);

  const newlyFailingBaselinePass = compareTestManifests(
    manifest([file('tests/a.test.mjs', true)]),
    manifest([file('tests/a.test.mjs', false, ['new after baseline pass'])]),
  );
  assert.equal(newlyFailingBaselinePass.pass, false);
  assert.deepEqual(newlyFailingBaselinePass.existingFailures, []);
  assert.deepEqual(newlyFailingBaselinePass.newFailures, [
    { path: 'tests/a.test.mjs', name: 'new after baseline pass' },
  ]);

  const newlyAddedFailingFile = compareTestManifests(
    manifest([file('tests/a.test.mjs', true)]),
    manifest([
      file('tests/a.test.mjs', true),
      file('tests/new.test.mjs', false, ['new file failure']),
    ]),
  );
  assert.equal(newlyAddedFailingFile.pass, false);
  assert.deepEqual(newlyAddedFailingFile.existingFailures, []);
  assert.deepEqual(newlyAddedFailingFile.newFailures, [
    { path: 'tests/new.test.mjs', name: 'new file failure' },
  ]);
});

test('TAP failure parser records test names rather than reducing a file to one FAIL bit', () => {
  assert.deepEqual(parseTapFailures(`
    not ok 2 - first invariant
      ---
      message: mismatch
      ...
    not ok 4 - second invariant # time=12ms
  `), ['first invariant', 'second invariant']);
});

test('TAP failure records preserve message and normalized stack fingerprints', () => {
  const baseline = parseTapFailureRecords(`
not ok 2 - canonical identity
  ---
  error: |-
    expected Stable ID set to match
  stack: |-
    TestContext.<anonymous> (file:///C:/archive/baseline/tests/world.test.mjs:42:7)
    Test.run (node:internal/test_runner/test:100:1)
  ...
`);
  const current = parseTapFailureRecords(`
not ok 2 - canonical identity
  ---
  error: |-
    expected Stable ID set to match
  stack: |-
    TestContext.<anonymous> (file:///C:/KaniNingen-Game/tests/world.test.mjs:42:7)
    Test.run (node:internal/test_runner/test:100:1)
  ...
`);
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].message, 'expected Stable ID set to match');
  assert.match(baseline[0].normalizedStack, /^TestContext\.<anonymous> \(<repo>\/tests/);
  assert.equal(baseline[0].stackFingerprint, current[0].stackFingerprint);
  assert.equal(baseline[0].fingerprint, current[0].fingerprint);
});

test('manifest comparison detects same-title diagnostic changes and missing baseline files', () => {
  const tap = ({ message, root = 'C:/KaniNingen-Game' }) => `
not ok 1 - canonical identity
  ---
  error: |-
    ${message}
  stack: |-
    TestContext.<anonymous> (file:///${root}/tests/world.test.mjs:42:7)
  ...
`;
  const attempt = output => Object.freeze({
    pass: false,
    timedOut: false,
    failureNames: Object.freeze(['canonical identity']),
    stdout: output,
    stderr: '',
  });
  const detailedAttempt = output => Object.freeze({
    ...attempt(output),
    failures: parseTapFailureRecords(output),
  });
  const file = (path, value) => Object.freeze({
    path,
    sha256: `sha256:${path}`,
    pass: value === null,
    attempts: Object.freeze(value === null
      ? [Object.freeze({ pass: true })] : [value]),
  });
  const manifest = files => Object.freeze({
    schemaVersion: KANI_TEST_MANIFEST_SCHEMA,
    files: Object.freeze(files),
  });

  // The old manifest has no `failures` field, so comparison must reparse its
  // persisted stdout and normalize an archive-root stack path.
  const baseline = manifest([
    file('tests/world.test.mjs', attempt(tap({
      message: 'Stable ID mismatch',
      root: 'C:/archive/baseline',
    }))),
    file('tests/missing.test.mjs', null),
  ]);
  const same = compareTestManifests(baseline, manifest([
    file('tests/world.test.mjs', detailedAttempt(tap({ message: 'Stable ID mismatch' }))),
  ]));
  assert.equal(same.existingFailures.length, 1);
  assert.equal(same.existingFailures[0].name, 'canonical identity');
  assert.equal(same.existingFailures[0].message, 'Stable ID mismatch');
  assert.equal(same.newFailures.some(failure => (
    failure.name === '<baseline-test-file-missing>'
      && failure.path === 'tests/missing.test.mjs'
  )), true);

  const changed = compareTestManifests(baseline, manifest([
    file('tests/world.test.mjs', detailedAttempt(tap({ message: 'Terrain Y mismatch' }))),
    file('tests/missing.test.mjs', null),
  ]));
  assert.equal(changed.existingFailures.length, 0,
    'a reused title must not hide a changed underlying assertion');
  assert.equal(changed.newFailures.length, 1);
  assert.equal(changed.newFailures[0].message, 'Terrain Y mismatch');
  assert.equal(changed.resolvedFailures[0].message, 'Stable ID mismatch');
});

test('non-TAP process diagnostics fingerprint stderr, spawn error, exit, signal, and timeout', () => {
  const attempt = ({ stderr, error, exitCode = 1, signal = null, timedOut = false }) => (
    Object.freeze({
      pass: false,
      timedOut,
      exitCode,
      signal,
      error,
      failureNames: Object.freeze([]),
      stdout: '',
      stderr,
    })
  );
  const file = value => Object.freeze({
    path: 'tests/process.test.mjs',
    sha256: 'same-source',
    pass: false,
    attempts: Object.freeze([value]),
  });
  const manifest = value => Object.freeze({
    schemaVersion: KANI_TEST_MANIFEST_SCHEMA,
    files: Object.freeze([file(value)]),
  });
  const baseline = manifest(attempt({
    stderr: 'fatal: JavaScript heap out of memory',
    error: Object.freeze({ name: 'Error', code: 'ENOMEM', message: 'spawn ENOMEM' }),
  }));
  const current = manifest(attempt({
    stderr: 'spawn blocked by policy: EPERM',
    error: Object.freeze({ name: 'Error', code: 'EPERM', message: 'spawn EPERM' }),
  }));
  const changed = compareTestManifests(baseline, current);
  assert.equal(changed.pass, false);
  assert.equal(changed.existingFailures.length, 0);
  assert.equal(changed.newFailures.length, 1);
  assert.equal(changed.newFailures[0].name, '<process-failure>');
  assert.match(changed.newFailures[0].message, /EPERM/);

  const same = compareTestManifests(baseline, manifest(attempt({
    stderr: 'fatal: JavaScript heap out of memory',
    error: Object.freeze({ name: 'Error', code: 'ENOMEM', message: 'spawn ENOMEM' }),
  })));
  assert.equal(same.pass, true);
  assert.equal(same.existingFailures.length, 1);

  const timedOut = compareTestManifests(baseline, manifest(attempt({
    stderr: 'fatal: JavaScript heap out of memory',
    error: Object.freeze({ name: 'Error', code: 'ENOMEM', message: 'spawn ENOMEM' }),
    exitCode: null,
    signal: 'SIGTERM',
    timedOut: true,
  })));
  assert.equal(timedOut.pass, false);
  assert.equal(timedOut.newFailures.length, 1);
  assert.match(timedOut.newFailures[0].message, /\"timedOut\":true/);
  assert.match(timedOut.newFailures[0].message, /SIGTERM/);
});
