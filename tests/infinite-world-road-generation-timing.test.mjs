import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROAD_GENERATION_COUNTER,
  ROAD_GENERATION_SPAN,
  ROAD_GENERATION_SPAN_ORDER,
  ROAD_GENERATION_TOP_RUN_CAPACITY,
  ROAD_GENERATION_WARMTH,
  createRoadGenerationTimingRecorder,
} from '../src/infinite-world/road-generation-timing.js';

test('Road timing records exclusive spans, required counters, and sanitized owner metadata', () => {
  let now = 0;
  const recorder = createRoadGenerationTimingRecorder({ clock: () => now });
  const run = recorder.beginRun({
    owner: { x: 160, z: 29 },
    cold: true,
    settlementTypes: ['TOWN', 'CITY', 'TOWN'],
  });

  run.measureSync(ROAD_GENERATION_SPAN.SEED_INPUT, () => { now += 3; });
  now += 2;
  run.measureSync(ROAD_GENERATION_SPAN.HIERARCHY_PARAMETERS, () => { now += 5; });
  run.measureSync(ROAD_GENERATION_SPAN.GRAPH_SEGMENTS, () => { now += 7; });
  run.measureSync(ROAD_GENERATION_SPAN.SEGMENT_CONNECTIONS_INTERSECTIONS, () => { now += 11; });
  run.measureSync(ROAD_GENERATION_SPAN.TERRAIN_HEIGHT_SAMPLING, () => { now += 13; });
  run.measureSync(ROAD_GENERATION_SPAN.CACHE_LOOKUP_BUILD, () => { now += 17; });
  run.setCounter(ROAD_GENERATION_COUNTER.SEGMENTS, 31);
  run.setCounter(ROAD_GENERATION_COUNTER.NODES, 19);
  run.addCounter(ROAD_GENERATION_COUNTER.INTERSECTION_CANDIDATES, 47);
  run.addCounter(ROAD_GENERATION_COUNTER.RIVER_CROSSING_CANDIDATES, 5);
  run.addCounter(ROAD_GENERATION_COUNTER.BRIDGE_CANDIDATES, 3);
  run.addCounter(ROAD_GENERATION_COUNTER.TERRAIN_SAMPLES, 101);
  run.addCounter(ROAD_GENERATION_COUNTER.SPATIAL_QUERIES, 13);
  run.addCounter(ROAD_GENERATION_COUNTER.SORT_DEDUPE_ITEMS, 61);
  run.recordCacheHit(2);
  run.recordCacheMiss();
  run.recordFunction('prepareMajorRoadSource', 31);
  run.recordFunction('prepareMajorRoadSource', 47);
  run.recordFunction('obstacle-build', 13, 3);
  run.setDeadlineMiss(true);
  now += 19;
  const finished = run.complete();

  assert.equal(finished.ownerKey, '160,29');
  assert.deepEqual(finished.owner, { x: 160, z: 29 });
  assert.equal(finished.warmth, ROAD_GENERATION_WARMTH.COLD);
  assert.equal(finished.cold, true);
  assert.equal(finished.deadlineMiss, true);
  assert.deepEqual(finished.settlementTypes, ['CITY', 'TOWN']);
  assert.equal(finished.roadTotalMs, 77);
  assert.deepEqual(finished.spans[ROAD_GENERATION_SPAN.SEED_INPUT], {
    durationMs: 3,
    callCount: 1,
  });
  assert.deepEqual(finished.spans[ROAD_GENERATION_SPAN.OTHER], {
    durationMs: 21,
    callCount: 2,
  });
  assert.deepEqual(finished.spans[ROAD_GENERATION_SPAN.CACHE_LOOKUP_BUILD], {
    durationMs: 17,
    callCount: 1,
  });
  assert.equal(finished.counters.segments, 31);
  assert.equal(finished.counters.nodes, 19);
  assert.equal(finished.counters.intersectionCandidates, 47);
  assert.equal(finished.counters.riverCrossingCandidates, 5);
  assert.equal(finished.counters.bridgeCandidates, 3);
  assert.equal(finished.counters.terrainSamples, 101);
  assert.equal(finished.counters.spatialQueries, 13);
  assert.equal(finished.counters.sortDedupeItems, 61);
  assert.deepEqual(finished.cache, { hits: 2, misses: 1 });
  assert.deepEqual(finished.functionTimings, {
    'obstacle-build': {
      totalMs: 13,
      callCount: 3,
      sampleCount: 1,
      p50Ms: 13,
      p95Ms: 13,
      maxMs: 13,
    },
    prepareMajorRoadSource: {
      totalMs: 78,
      callCount: 2,
      sampleCount: 2,
      p50Ms: 31,
      p95Ms: 47,
      maxMs: 47,
    },
  });
  for (const span of ROAD_GENERATION_SPAN_ORDER) {
    assert.equal(typeof finished.spans[span].durationMs, 'number');
    assert.equal(typeof finished.spans[span].callCount, 'number');
  }
  assert.equal(Object.isFrozen(finished), true);
  assert.equal(Object.isFrozen(finished.spans), true);
  assert.equal(Object.isFrozen(finished.counters), true);

  const report = recorder.snapshot();
  assert.equal(report.runCount, 1);
  assert.equal(report.deadlineMissCount, 1);
  assert.equal(report.road.maxMs, 77);
  assert.equal(report.spans[ROAD_GENERATION_SPAN.OTHER].totalMs, 21);
  assert.equal(report.spans[ROAD_GENERATION_SPAN.SEGMENT_CONNECTIONS_INTERSECTIONS].callCount, 1);
  assert.equal(report.counters.cacheHits, 2);
  assert.equal(report.counters.cacheMisses, 1);
  assert.deepEqual(report.functionTimings, finished.functionTimings);
  assert.deepEqual(report.topRuns, [finished]);
});

test('Road timing rejects overlapping spans and retains only deterministic slowest runs', () => {
  let now = 0;
  const recorder = createRoadGenerationTimingRecorder({
    clock: () => now,
    topRunCapacity: 2,
    sampleCapacity: 3,
  });
  const overlapping = recorder.beginRun({ owner: '2,3', warmth: ROAD_GENERATION_WARMTH.WARM });
  const first = overlapping.startSpan(ROAD_GENERATION_SPAN.SETTLEMENT_PLAN);
  assert.throws(
    () => overlapping.startSpan(ROAD_GENERATION_SPAN.GRAPH_SEGMENTS),
    /still active/,
  );
  now += 1;
  overlapping.endSpan(first);
  overlapping.complete();

  const recordRun = (owner, duration) => {
    const run = recorder.beginRun({ owner, warmth: ROAD_GENERATION_WARMTH.WARM });
    run.measureSync(ROAD_GENERATION_SPAN.GRAPH_SEGMENTS, () => { now += duration; });
    return run.complete();
  };
  recordRun({ x: 10, z: 1 }, 20);
  recordRun({ x: 9, z: 1 }, 20);
  recordRun({ x: 12, z: 1 }, 5);

  const report = recorder.snapshot();
  assert.equal(report.runCount, 4);
  assert.equal(report.road.sampleCount, 3);
  assert.equal(report.road.maxMs, 20);
  assert.equal(report.topRuns.length, 2);
  assert.deepEqual(
    report.topRuns.map(run => [run.ownerKey, run.roadTotalMs]),
    [['9,1', 20], ['10,1', 20]],
  );
  assert.equal(report.spans[ROAD_GENERATION_SPAN.GRAPH_SEGMENTS].callCount, 3);
  assert.equal(ROAD_GENERATION_TOP_RUN_CAPACITY, 20);
  assert.throws(() => recorder.beginRun({ owner: 'not-an-owner' }), /owner string/);
});

test('disabled Road timing does not read the clock or retain diagnostic aggregation', () => {
  const recorder = createRoadGenerationTimingRecorder({
    enabled: false,
    clock: () => { throw new Error('diagnostics-off must not read the clock'); },
  });
  const run = recorder.beginRun({ owner: { x: 160, z: 29 } });
  assert.equal(run.measureSync(ROAD_GENERATION_SPAN.GRAPH_SEGMENTS, () => 42), 42);
  assert.equal(run.recordCacheHit(), 0);
  assert.equal(run.complete(), null);
  assert.deepEqual(recorder.snapshot().topRuns, []);
  assert.equal(recorder.snapshot().runCount, 0);
  assert.equal(recorder.snapshot().road.totalMs, 0);
  assert.deepEqual(recorder.snapshot().functionTimings, {});
});

test('named Road function timings are bounded, deterministic, and separate from exclusive spans', () => {
  let now = 0;
  const recorder = createRoadGenerationTimingRecorder({
    clock: () => now,
    functionTimingCapacity: 2,
    sampleCapacity: 2,
  });
  const run = recorder.beginRun({ owner: { x: 1, z: -1 } });
  run.recordFunction('z-loop', 9);
  run.recordFunction('a-loop', 3);
  assert.throws(() => run.recordFunction('third-loop', 1), /at most 2/);
  assert.throws(() => run.recordFunction('not a valid name', 1), /bounded identifier/);
  assert.throws(() => run.recordFunction('a-loop', -1), /finite non-negative/);
  now += 4;
  const completed = run.complete();

  assert.equal(completed.roadTotalMs, 4);
  assert.deepEqual(Object.keys(completed.functionTimings), ['a-loop', 'z-loop']);
  assert.equal(completed.functionTimings['z-loop'].totalMs, 9);
  assert.equal(completed.functionTimings['a-loop'].p95Ms, 3);
  assert.equal(recorder.snapshot().functionTimings['z-loop'].maxMs, 9);
});
