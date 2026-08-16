import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MACRO_CELL_SIZE_METERS,
  MACRO_DEFAULT_MAX_IN_FLIGHT,
  MACRO_MAX_NEW_CELLS_PER_FRAME,
  MACRO_MAX_RETAINED_CELLS,
  MACRO_MAX_SPRINT_METERS_PER_SECOND,
  MACRO_OWNER_SIZE_METERS,
  MACRO_OWNERS_PER_AXIS,
  MACRO_RESIDENT_RADIUS_METERS,
  MACRO_VISIBLE_RADIUS_METERS,
  createMacroCoarseCellGenerator,
  createMacroCoarseWorldController,
  createMacroResidentCoverage,
  diffMacroCoverage,
  logicalWorldToMacroCell,
  macroCellBounds,
  macroInitialFillCohorts,
  pointToMacroCellAabbDistance,
  resolveMacroThroughput,
} from '../src/infinite-world/macro-coarse-world.js';

const flushAsync = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
};

const keySet = coverage => new Set(coverage.map(cell => cell.key));

const cellData = request => Object.freeze({
  schemaVersion: 'macro-coarse-cell-test-1',
  key: request.key,
  macroX: request.macroX,
  macroZ: request.macroZ,
  terrainSamples: Object.freeze([]),
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test('Macro coordinates use a fixed 4x4 owner floor grid, including negatives', () => {
  assert.equal(MACRO_OWNER_SIZE_METERS, 16);
  assert.equal(MACRO_OWNERS_PER_AXIS, 4);
  assert.equal(MACRO_CELL_SIZE_METERS, 64);
  const cases = [
    [0, 0, 0, 0],
    [-0, -0, 0, 0],
    [63.999999, 63.999999, 0, 0],
    [64, 64, 1, 1],
    [-Number.EPSILON, -Number.EPSILON, -1, -1],
    [-63.999999, -63.999999, -1, -1],
    [-64, -64, -1, -1],
    [-64.000001, -64.000001, -2, -2],
    [129, -129, 2, -3],
  ];
  for (const [worldX, worldZ, macroX, macroZ] of cases) {
    assert.deepEqual(logicalWorldToMacroCell(worldX, worldZ), {
      macroX,
      macroZ,
      key: `${macroX},${macroZ}`,
    });
  }
  assert.deepEqual(macroCellBounds(-2, 3), {
    minimumX: -128,
    minimumZ: 192,
    maximumX: -64,
    maximumZ: 256,
    centerX: -96,
    centerZ: 224,
  });
});

test('416m cell-AABB Resident coverage is deterministic, complete, and changes only at a Macro boundary', () => {
  assert.equal(MACRO_RESIDENT_RADIUS_METERS, 416);
  assert.equal(MACRO_VISIBLE_RADIUS_METERS, 352);
  const origin = createMacroResidentCoverage({ macroX: 0, macroZ: 0 });
  const repeat = createMacroResidentCoverage({ macroX: 0, macroZ: 0 });
  assert.equal(origin.length, 153);
  assert.deepEqual(repeat, origin);
  assert.equal(keySet(origin).size, origin.length);
  assert.ok(origin.every(cell => cell.distanceMeters <= 416));
  assert.ok(keySet(origin).has('7,0'), 'the inclusive cardinal 416m cell must be resident');
  assert.equal(keySet(origin).has('7,1'), false);

  const straight = createMacroResidentCoverage({ macroX: 1, macroZ: 0 });
  const diagonal = createMacroResidentCoverage({ macroX: 1, macroZ: 1 });
  const unchanged = diffMacroCoverage(origin, repeat);
  const straightDiff = diffMacroCoverage(origin, straight);
  const diagonalDiff = diffMacroCoverage(origin, diagonal);
  assert.deepEqual([
    unchanged.unchanged.length,
    unchanged.entering.length,
    unchanged.leaving.length,
  ], [153, 0, 0]);
  assert.deepEqual([
    straightDiff.unchanged.length,
    straightDiff.entering.length,
    straightDiff.leaving.length,
  ], [138, 15, 15]);
  assert.deepEqual([
    diagonalDiff.unchanged.length,
    diagonalDiff.entering.length,
    diagonalDiff.leaving.length,
  ], [132, 21, 21]);
  assert.equal(new Set([...origin.map(cell => cell.key), ...diagonal.map(cell => cell.key)]).size,
    MACRO_MAX_RETAINED_CELLS);
});

test('every cell touching 0..352m around a player is inside the current 416m Resident set', () => {
  const localPositions = [0, 0.000001, 1, 8, 16, 31.5, 32, 48, 63, 63.999999];
  for (const playerX of localPositions) {
    for (const playerZ of localPositions) {
      const current = logicalWorldToMacroCell(playerX, playerZ);
      const resident = keySet(createMacroResidentCoverage(current));
      for (let macroZ = -8; macroZ <= 8; macroZ += 1) {
        for (let macroX = -8; macroX <= 8; macroX += 1) {
          const distance = pointToMacroCellAabbDistance(
            playerX,
            playerZ,
            macroX,
            macroZ,
          );
          if (distance <= MACRO_VISIBLE_RADIUS_METERS) {
            assert.ok(resident.has(`${macroX},${macroZ}`),
              `${playerX},${playerZ} misses ${macroX},${macroZ} at ${distance}m`);
          }
        }
      }
    }
  }
});

test('initial fill cohorts use the exact initial player position and finish by two seconds', async () => {
  const cohorts = macroInitialFillCohorts({ macroX: 0, macroZ: 0 });
  assert.deepEqual(Object.keys(cohorts), ['100', '200', '300', '352']);
  assert.deepEqual(Object.values(cohorts).map(keys => keys.length), [13, 45, 89, 113]);
  assert.ok(cohorts[100].every(key => cohorts[200].includes(key)));
  assert.ok(cohorts[200].every(key => cohorts[300].includes(key)));
  assert.ok(cohorts[300].every(key => cohorts[352].includes(key)));

  // An exact 64m boundary floors into Macro cell 1,1 and is its worst-case
  // corner rather than that cell's center. Its closed-AABB visible cohort is
  // larger, but remains within the Stage-1 120-cell/2.0-second budget.
  const boundaryPlayer = Object.freeze({ playerX: 64, playerZ: 64 });
  const boundaryCohorts = macroInitialFillCohorts({
    macroX: 1,
    macroZ: 1,
    ...boundaryPlayer,
  });
  assert.deepEqual(Object.values(boundaryCohorts).map(keys => keys.length),
    [16, 44, 88, 120]);
  assert.ok(boundaryCohorts[100].every(key => boundaryCohorts[200].includes(key)));
  assert.ok(boundaryCohorts[200].every(key => boundaryCohorts[300].includes(key)));
  assert.ok(boundaryCohorts[300].every(key => boundaryCohorts[352].includes(key)));
  const boundaryResident = new Map(createMacroResidentCoverage({ macroX: 1, macroZ: 1 })
    .map(cell => [cell.key, cell]));
  for (const radius of [100, 200, 300, 352]) {
    const exactKeys = [...boundaryResident.values()]
      .filter(cell => pointToMacroCellAabbDistance(
        boundaryPlayer.playerX,
        boundaryPlayer.playerZ,
        cell.macroX,
        cell.macroZ,
      ) <= radius)
      .map(cell => cell.key);
    assert.deepEqual(boundaryCohorts[radius], exactKeys);
  }

  const controller = createMacroCoarseWorldController({
    generateCell: async request => cellData(request),
  });
  let milestone = null;
  for (let frame = 0; frame <= 120; frame += 1) {
    const result = controller.advanceFrame(boundaryPlayer);
    assert.ok(result.requestedCellKeys.length <= 1);
    assert.ok(result.publishedCellKeys.length <= 1);
    await flushAsync();
    milestone = controller.snapshot().initialFill[352];
    if (milestone.completedFrame !== null) break;
  }
  assert.notEqual(milestone.completedFrame, null);
  assert.ok(milestone.elapsedFrames <= 120, String(milestone.elapsedFrames));
  assert.ok(milestone.elapsedMillisecondsAt60Fps <= 2_000,
    String(milestone.elapsedMillisecondsAt60Fps));
  controller.dispose();
});

const expectedHeight = (worldX, worldZ) => (
  worldX * 0.125 - worldZ * 0.0625 + 7.25
);

test('cell generation is Terrain-only and samples one exact world-fixed 5x5 lattice', async () => {
  const calls = [];
  const sampleGround = async (worldX, worldZ, context) => {
    calls.push([worldX, worldZ, context]);
    return Object.freeze({
      heightMeters: expectedHeight(worldX, worldZ),
      color: Object.freeze([
        0.2 + worldX / 10_000,
        0.4,
        0.16 + worldZ / 10_000,
      ]),
      riverSurfaceHeightMeters: worldX === -96 && worldZ === 224 ? 3.5 : null,
      riverStableId: worldX === -96 && worldZ === 224 ? 'river:negative-cell' : null,
    });
  };
  const generator = createMacroCoarseCellGenerator({ sampleGround });
  const context = Object.freeze({ surfacePolicy: 'canonical-test-policy' });
  const cell = await generator.generateCell({ macroX: -2, macroZ: 3, context });

  assert.equal(calls.length, 25, 'Terrain generation makes exactly one probe per lattice point');
  assert.deepEqual(calls.map(([worldX, worldZ]) => [worldX, worldZ]),
    Array.from({ length: 25 }, (_, index) => [
      -128 + (index % 5) * 16,
      192 + Math.floor(index / 5) * 16,
    ]));
  assert.ok(calls.every(([, , value]) => value === context));
  assert.equal(cell.schemaVersion, 'macro-coarse-terrain-cell-1');
  assert.equal(cell.key, '-2,3');
  assert.equal(cell.terrainSamples.length, 25);
  assert.deepEqual(cell.terrainSamples[0], {
    worldX: -128,
    worldZ: 192,
    heightMeters: expectedHeight(-128, 192),
    color: [0.1872, 0.4, 0.1792],
    riverSurfaceHeightMeters: null,
    riverStableId: null,
  });
  assert.deepEqual(cell.terrainSamples[12], {
    worldX: -96,
    worldZ: 224,
    heightMeters: expectedHeight(-96, 224),
    color: [0.1904, 0.4, 0.1824],
    riverSurfaceHeightMeters: 3.5,
    riverStableId: 'river:negative-cell',
  });
  assert.deepEqual(cell.terrainSamples[24], {
    worldX: -64,
    worldZ: 256,
    heightMeters: expectedHeight(-64, 256),
    color: [0.2 + -64 / 10_000, 0.4, 0.16 + 256 / 10_000],
    riverSurfaceHeightMeters: null,
    riverStableId: null,
  });
  assert.deepEqual(
    Object.keys(cell).filter(key => /forest|cluster|biome|stable.?id/i.test(key)),
    [],
    'the Macro control-plane result has no fake Forest or canonical Tree payload',
  );
  assert.equal(Object.isFrozen(cell), true);
  assert.equal(Object.isFrozen(cell.terrainSamples), true);
  assert.ok(cell.terrainSamples.every(Object.isFrozen));

  const repeated = await generator.generateCell({
    macroX: -2,
    macroZ: 3,
    context: Object.freeze({ surfacePolicy: 'different-view-context' }),
  });
  assert.deepEqual(repeated, cell, 'Terrain cell identity is independent of request context');
  assert.equal(calls.length, 50);
  assert.throws(
    () => createMacroCoarseCellGenerator(),
    /canonical ground sampler/,
  );
});

test('one request per 60Hz frame supplies more than 47.85m/s straight and diagonal demand', () => {
  assert.equal(MACRO_MAX_SPRINT_METERS_PER_SECOND, 47.85);
  assert.equal(MACRO_MAX_NEW_CELLS_PER_FRAME, 1);
  const throughput = resolveMacroThroughput();
  assert.deepEqual(throughput, {
    speedMetersPerSecond: 47.85,
    framesPerSecond: 60,
    straightBoundaryCrossingsPerSecond: 0.747656,
    diagonalAxisBoundaryCrossingsPerSecond: 0.528673,
    straightEnteringCellsPerSecond: 11.214844,
    diagonalEnteringCellsPerSecond: 11.102129,
    supplyCellsPerSecond: 60,
    straightSupplyDemandMargin: 5.350052,
    diagonalSupplyDemandMargin: 5.404369,
  });
  assert.ok(throughput.supplyCellsPerSecond > throughput.straightEnteringCellsPerSecond);
  assert.ok(throughput.supplyCellsPerSecond > throughput.diagonalEnteringCellsPerSecond);
});

test('out-of-order async completions publish incrementally without duplicate queued requests', async () => {
  const jobs = [];
  const published = [];
  const controller = createMacroCoarseWorldController({
    maximumInFlight: 3,
    generateCell(request) {
      const gate = deferred();
      jobs.push({ request, gate });
      return gate.promise;
    },
    publishCell(cell) { published.push(cell.key); },
  });

  const startResults = [];
  for (let frame = 0; frame < 3; frame += 1) {
    startResults.push(controller.advanceFrame({ playerX: 32, playerZ: 32 }));
    await flushAsync();
  }
  assert.equal(jobs.length, 3);
  assert.ok(startResults.every(result => result.requestedCellKeys.length <= 1
    && result.publishedCellKeys.length <= 1));
  const [slowA, fastB, mediumC] = jobs;

  fastB.gate.resolve(cellData(fastB.request));
  mediumC.gate.resolve(cellData(mediumC.request));
  await flushAsync();
  const fastFrame = controller.advanceFrame({ playerX: 32, playerZ: 32 });
  assert.deepEqual(fastFrame.publishedCellKeys, [fastB.request.key]);
  assert.equal(fastFrame.requestedCellKeys.includes(mediumC.request.key), false,
    'a completed cell awaiting its publication slot must not be generated twice');

  const mediumFrame = controller.advanceFrame({ playerX: 32, playerZ: 32 });
  assert.deepEqual(mediumFrame.publishedCellKeys, [mediumC.request.key]);
  slowA.gate.resolve(cellData(slowA.request));
  await flushAsync();
  const slowFrame = controller.advanceFrame({ playerX: 32, playerZ: 32 });
  assert.deepEqual(slowFrame.publishedCellKeys, [slowA.request.key]);
  assert.deepEqual(published.slice(0, 3), [
    fastB.request.key,
    mediumC.request.key,
    slowA.request.key,
  ]);
  for (const result of [...startResults, fastFrame, mediumFrame, slowFrame]) {
    assert.ok(result.requestedCellKeys.length <= 1);
    assert.ok(result.publishedCellKeys.length <= 1);
  }
  const snapshot = controller.snapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.lastFrame.requestedCellKeys), true);
  assert.equal(snapshot.residentCellCount, 153);
  assert.equal(snapshot.desiredReadyCellCount, 3);
  assert.equal(snapshot.presentedCellCount, 3);
  assert.equal(snapshot.maximumNewCellsPerFrame, 1);
  assert.equal(snapshot.maximumPublicationsPerFrame, 1);
  assert.equal(snapshot.maximumInFlight, 3);
  assert.ok(snapshot.maximumPendingCount <= 3);
  assert.equal(snapshot.stalePublicationCount, 0);
  assert.equal(snapshot.fullRebuildCount, 0);
  const publishedBeforeDispose = [...published];
  const publicationCountBeforeDispose = snapshot.publicationCount;
  const lastFrameBeforeDispose = snapshot.lastFrame;
  controller.dispose();
  for (const job of jobs.slice(3)) job.gate.resolve(cellData(job.request));
  await flushAsync();
  const disposedSnapshot = controller.snapshot();
  assert.equal(disposedSnapshot.enabled, false);
  assert.equal(disposedSnapshot.residentCellCount, 0);
  assert.equal(disposedSnapshot.presentedCellCount, 0);
  assert.equal(disposedSnapshot.desiredReadyCellCount, 0);
  assert.equal(disposedSnapshot.pendingCellCount, 0);
  assert.equal(disposedSnapshot.completionQueueLength, 0);
  assert.equal(disposedSnapshot.generatedCacheSize, 0);
  assert.equal(disposedSnapshot.publicationCount, publicationCountBeforeDispose);
  assert.deepEqual(published, publishedBeforeDispose,
    'a completion resolving after dispose must not publish');
  assert.strictEqual(controller.advanceFrame({ playerX: 9_999, playerZ: 9_999 }),
    lastFrameBeforeDispose,
    'disposed controllers cannot request, publish, or revise coverage');
});

async function fillController(controller, player = { playerX: 32, playerZ: 32 }) {
  const results = [];
  for (let frame = 0; frame < 400; frame += 1) {
    const result = controller.advanceFrame(player);
    results.push(result);
    assert.ok(result.requestedCellKeys.length <= 1);
    assert.ok(result.publishedCellKeys.length <= 1);
    await flushAsync();
    const snapshot = controller.snapshot();
    if (snapshot.desiredReadyCellCount === snapshot.residentCellCount
      && snapshot.pendingCellCount === 0 && snapshot.completionQueueLength === 0) {
      return results;
    }
  }
  assert.fail('Macro initial fill did not converge');
}

test('velocity only reorders missing Resident-margin cells after visible coverage', async () => {
  const collect = async velocityX => {
    const requested = [];
    const controller = createMacroCoarseWorldController({
      generateCell: async request => cellData(request),
    });
    for (let frame = 0; frame < 180; frame += 1) {
      const result = controller.advanceFrame({ playerX: 32, playerZ: 32, velocityX });
      requested.push(...result.requestedCellKeys);
      await flushAsync();
      if (controller.snapshot().initialFill[352].completedFrame !== null) break;
    }
    const snapshot = controller.snapshot();
    controller.dispose();
    return { requested, snapshot };
  };
  const east = await collect(MACRO_MAX_SPRINT_METERS_PER_SECOND);
  const west = await collect(-MACRO_MAX_SPRINT_METERS_PER_SECOND);
  assert.deepEqual(east.requested.slice(0, 113), west.requested.slice(0, 113),
    'velocity cannot steer visible coverage identity/order');
  assert.notEqual(east.requested[113], west.requested[113],
    'velocity may reorder the first non-visible Resident-margin request');
  const resident = keySet(createMacroResidentCoverage({ macroX: 0, macroZ: 0 }));
  assert.ok(resident.has(east.requested[113]));
  assert.ok(resident.has(west.requested[113]));
  assert.equal(east.snapshot.coverageRevision, west.snapshot.coverageRevision);
  assert.equal(east.snapshot.residentCellCount, west.snapshot.residentCellCount);
});

test('initial fill, old-until-new, yaw, reversal, stop, and restart remain incremental and bounded', async () => {
  const published = [];
  const retired = [];
  const controller = createMacroCoarseWorldController({
    generateCell: async request => cellData(request),
    publishCell(cell) { published.push(cell.key); },
    retireCell(key) { retired.push(key); },
  });
  const fillResults = await fillController(controller);
  let snapshot = controller.snapshot();
  assert.equal(snapshot.residentCellCount, 153);
  assert.equal(snapshot.presentedCellCount, 153);
  assert.equal(snapshot.desiredReadyCellCount, 153);
  assert.equal(snapshot.retainedLeavingCellCount, 0);
  assert.equal(published.length, 153);
  assert.ok(fillResults.every(result => result.requestedCellKeys.length <= 1
    && result.publishedCellKeys.length <= 1));
  const completedFrames = [100, 200, 300, 352]
    .map(radius => snapshot.initialFill[radius].completedFrame);
  assert.ok(completedFrames.every(Number.isSafeInteger));
  assert.ok(completedFrames[0] < completedFrames[1]
    && completedFrames[1] < completedFrames[2]
    && completedFrames[2] < completedFrames[3]);
  assert.equal(snapshot.coverageMissCount, 0);

  const initialRevision = snapshot.coverageRevision;
  const yaw = controller.advanceFrame({
    playerX: 33,
    playerZ: 31,
    velocityX: 0,
    velocityZ: 0,
    cameraYawRadians: Math.PI,
  });
  assert.equal(yaw.coverageChanged, false);
  assert.equal(yaw.requestedCellKeys.length, 0);
  snapshot = controller.snapshot();
  assert.equal(snapshot.coverageRevision, initialRevision);
  assert.equal(snapshot.cameraYawRequestCount, 0);
  assert.equal(snapshot.yawCoverageRevision, 0);

  const east = controller.advanceFrame({
    playerX: 64.000001,
    playerZ: 32,
    velocityX: MACRO_MAX_SPRINT_METERS_PER_SECOND,
  });
  assert.equal(east.coverageChanged, true);
  assert.equal(east.retiredCellKeys.length, 0,
    'leaving cells remain drawable until an entering replacement is ready');
  snapshot = controller.snapshot();
  assert.equal(snapshot.desiredReadyCellCount, 138);
  assert.equal(snapshot.retainedLeavingCellCount, 15);
  assert.equal(snapshot.presentedCellCount, 153);
  await flushAsync();

  const replace = controller.advanceFrame({
    playerX: 64.000001,
    playerZ: 32,
    velocityX: 0,
  });
  assert.equal(replace.publishedCellKeys.length, 1);
  assert.equal(replace.retiredCellKeys.length, 1);
  snapshot = controller.snapshot();
  assert.equal(snapshot.presentedCellCount, 153);
  assert.equal(snapshot.retainedLeavingCellCount, 14);

  const eastRevision = snapshot.coverageRevision;
  const stop = controller.advanceFrame({ playerX: 65, playerZ: 32 });
  const restart = controller.advanceFrame({
    playerX: 66,
    playerZ: 32,
    velocityX: -MACRO_MAX_SPRINT_METERS_PER_SECOND,
  });
  assert.equal(stop.coverageChanged, false);
  assert.equal(restart.coverageChanged, false);
  assert.equal(controller.snapshot().coverageRevision, eastRevision);

  const reverse = controller.advanceFrame({
    playerX: 63.999999,
    playerZ: 32,
    velocityX: -MACRO_MAX_SPRINT_METERS_PER_SECOND,
  });
  assert.equal(reverse.coverageChanged, true);
  snapshot = controller.snapshot();
  assert.ok(snapshot.presentedCellCount <= MACRO_MAX_RETAINED_CELLS);
  assert.ok(snapshot.maximumPendingCount <= MACRO_DEFAULT_MAX_IN_FLIGHT);
  assert.equal(snapshot.fullRebuildCount, 0);
  assert.equal(snapshot.stalePublicationCount, 0);
  assert.equal(snapshot.residentOverflowCount, 0);
  assert.equal(snapshot.cameraYawRequestCount, 0);
  assert.equal(snapshot.yawCoverageRevision, 0);
  controller.dispose();
});

test('out-of-resident completions are never published and their reusable cache stays bounded', async () => {
  const jobs = [];
  const published = [];
  const controller = createMacroCoarseWorldController({
    maximumInFlight: 1,
    generateCell(request) {
      const gate = deferred();
      jobs.push({ request, gate });
      return gate.promise;
    },
    publishCell(cell) { published.push(cell.key); },
  });

  for (let iteration = 0; iteration < 3; iteration += 1) {
    controller.advanceFrame({ playerX: iteration * 6_400 + 32, playerZ: 32 });
    await flushAsync();
    const job = jobs.at(-1);
    controller.advanceFrame({ playerX: (iteration * 6_400) + 3_200, playerZ: 3_200 });
    job.gate.resolve(cellData(job.request));
    await flushAsync();
    controller.advanceFrame({ playerX: (iteration * 6_400) + 3_200, playerZ: 3_200 });
    await flushAsync();
  }
  const snapshot = controller.snapshot();
  assert.equal(published.length, 0);
  assert.equal(snapshot.stalePublicationCount, 0);
  assert.ok(snapshot.generatedCacheSize <= 2);
  assert.ok(snapshot.staleCompletionDiscardCount >= 1,
    'evicting a stale reusable completion is diagnosed');
  assert.equal(snapshot.fullRebuildCount, 0);
  assert.equal(snapshot.residentOverflowCount, 0);
  controller.dispose();
});
