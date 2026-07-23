import test from 'node:test';
import assert from 'node:assert/strict';
import {
  W8_DIAGNOSTIC_PROFILES,
  correlateW8HitchStages,
  createW8RuntimeDiagnostics,
  evaluateW8PerformanceRuns,
  parseW8DiagnosticProfile,
} from '../src/infinite-world/runtime-diagnostics.js';
import {
  W8_PRESENTATION_TERRAIN_PALETTE,
  createW8ClipmapTopology,
  sampleW8DistantTerrainAt,
  w8TerrainColorFromWeights,
} from '../src/infinite-world/render/w8-distant-presentation.js';

const LEGACY_CHUNK_SIZE_METERS = 16;
const LEGACY_FIVE_BY_FIVE_HALF_EXTENT_METERS = LEGACY_CHUNK_SIZE_METERS * 2.5;

function legacyClipmapAxis() {
  const values = [];
  const addRange = (from, to, step) => {
    for (let value = from; value < to - 1e-9; value += step) values.push(value);
  };
  addRange(-352, -192, 16);
  addRange(-192, -96, 8);
  addRange(-96, 96, 4);
  addRange(96, 192, 8);
  addRange(192, 352, 16);
  values.push(352);
  return values;
}

function legacyClipmapTopology() {
  const axis = legacyClipmapAxis();
  const vertices = [];
  const indices = [];
  const vertexByCoordinate = new Map();
  const vertexIndex = (x, z) => {
    const key = `${x},${z}`;
    if (vertexByCoordinate.has(key)) return vertexByCoordinate.get(key);
    const index = vertices.length;
    vertices.push({ x, z });
    vertexByCoordinate.set(key, index);
    return index;
  };
  for (let z = 0; z < axis.length - 1; z += 1) {
    for (let x = 0; x < axis.length - 1; x += 1) {
      const x0 = axis[x]; const x1 = axis[x + 1];
      const z0 = axis[z]; const z1 = axis[z + 1];
      const centerX = (x0 + x1) / 2;
      const centerZ = (z0 + z1) / 2;
      if (Math.max(Math.abs(centerX), Math.abs(centerZ))
        < LEGACY_FIVE_BY_FIVE_HALF_EXTENT_METERS) continue;
      const northwest = vertexIndex(x0, z0);
      const northeast = vertexIndex(x1, z0);
      const southwest = vertexIndex(x0, z1);
      const southeast = vertexIndex(x1, z1);
      indices.push(northwest, southwest, northeast, northeast, southwest, southeast);
    }
  }
  return { vertices, indices };
}

function legacyTerrainColorFromWeights(weights) {
  return [0, 1, 2].map(channel => weights.reduce(
    (sum, weight, index) => sum + weight * W8_PRESENTATION_TERRAIN_PALETTE[index][channel],
    0,
  ));
}

function legacyTerrainSampleAt(chunkData, worldX, worldZ) {
  const terrain = chunkData.terrain;
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const originX = chunkData.chunkX * LEGACY_CHUNK_SIZE_METERS;
  const originZ = chunkData.chunkZ * LEGACY_CHUNK_SIZE_METERS;
  const fx = clamp((worldX - originX) / LEGACY_CHUNK_SIZE_METERS, 0, 1)
    * (terrain.resolution.x - 1);
  const fz = clamp((worldZ - originZ) / LEGACY_CHUNK_SIZE_METERS, 0, 1)
    * (terrain.resolution.z - 1);
  const x0 = Math.floor(fx); const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, terrain.resolution.x - 1);
  const z1 = Math.min(z0 + 1, terrain.resolution.z - 1);
  const tx = fx - x0; const tz = fz - z0;
  const at = (x, z) => terrain.heights[z * terrain.resolution.x + x]
    * terrain.heightUnitMeters;
  const height = (at(x0, z0) * (1 - tx) + at(x1, z0) * tx) * (1 - tz)
    + (at(x0, z1) * (1 - tx) + at(x1, z1) * tx) * tz;
  const weights = [];
  for (let material = 0; material < W8_PRESENTATION_TERRAIN_PALETTE.length; material += 1) {
    const weightAt = (x, z) => terrain.materialWeights[
      (z * terrain.resolution.x + x) * W8_PRESENTATION_TERRAIN_PALETTE.length + material
    ];
    weights.push((weightAt(x0, z0) * (1 - tx) + weightAt(x1, z0) * tx) * (1 - tz)
      + (weightAt(x0, z1) * (1 - tx) + weightAt(x1, z1) * tx) * tz);
  }
  return { height, color: legacyTerrainColorFromWeights(weights) };
}

function deterministicTerrainFixture() {
  const width = 33;
  const depth = 29;
  const materialCount = W8_PRESENTATION_TERRAIN_PALETTE.length;
  const heights = new Int32Array(width * depth);
  const materialWeights = new Float64Array(width * depth * materialCount);
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const sample = z * width + x;
      heights[sample] = ((x * 97 + z * 193 + x * z * 17) % 8_191) - 4_095;
      const raw = Array.from({ length: materialCount }, (_, material) =>
        ((x + 3) * (material + 5) + (z + 7) * (material + 11)) % 97 + 1);
      const total = raw.reduce((sum, value) => sum + value, 0);
      for (let material = 0; material < materialCount; material += 1) {
        materialWeights[sample * materialCount + material] = raw[material] / total;
      }
    }
  }
  return {
    chunkX: -11,
    chunkZ: 39,
    terrain: {
      resolution: { x: width, z: depth },
      heightUnitMeters: 0.001,
      heights,
      materialWeights,
    },
  };
}

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

test('five-run acceptance uses finite, before-W8, and after-W8 medians without weakening hitches', () => {
  const report = (p95, p99, hitchRatio, { stopStage = null, max = 60 } = {}) => ({
    frame: { p95, p99, max }, hitchRatio, longTasks: [],
    hitches: stopStage ? [{ durationMs: 120, stages: { [stopStage]: 85 } }] : [],
  });
  const finiteReports = [14, 15, 16, 15, 14].map(value => report(value, value + 12, 0));
  const beforeW8Reports = [18, 18, 19, 20, 19].map(value => report(value, 35, 0.004));
  const w8Reports = [18, 19, 20, 19, 18].map(value => report(value, 36, 0.004));
  const accepted = evaluateW8PerformanceRuns({ finiteReports, beforeW8Reports, w8Reports });
  assert.equal(accepted.pass, true);
  assert.equal(accepted.scenario, 'normal');
  assert.deepEqual(accepted.limits, {
    finiteP95: 20,
    finiteP99: 40.5,
    absoluteOver50Ratio: 0.005,
    finiteRelativeOver50Ratio: 0.005,
    beforeW8P95: 20.900000000000002,
    beforeW8P99: 38.5,
    beforeW8Over50Ratio: null,
  });
  assert.equal(accepted.diagnostics.maximumFrameMs, 60);

  const stopped = w8Reports.map((value, index) => index < 2
    ? report(18, 36, 0.004, { stopStage: 'distant-sync', max: 150 }) : value);
  const rejected = evaluateW8PerformanceRuns({
    finiteReports, beforeW8Reports, w8Reports: stopped,
  });
  assert.equal(rejected.pass, false);
  assert.deepEqual(rejected.recurringStageStops, [{ stage: 'distant-sync', runCount: 2 }]);
  assert.deepEqual(correlateW8HitchStages(stopped), [{ stage: 'distant-sync', runCount: 2 }]);
  assert.throws(() => evaluateW8PerformanceRuns({ finiteReports: [], w8Reports }), /exactly five/);
});

test('clipmap topology and terrain sampling remain Float32-identical to the pre-refactor path', () => {
  const legacyTopology = legacyClipmapTopology();
  const topology = createW8ClipmapTopology();
  assert.equal(topology.vertices.length, 8_288);
  assert.equal(topology.indices.length, 48_384);
  assert.deepEqual(topology.vertices, legacyTopology.vertices);
  assert.deepEqual(topology.indices, legacyTopology.indices);

  for (const weights of [
    [1, 0, 0, 0, 0],
    [0.05, 0.15, 0.25, 0.3, 0.25],
    [0.123456789, 0.234567891, 0.345678912, 0.111111111, 0.185185297],
  ]) {
    assert.deepEqual(w8TerrainColorFromWeights(weights), legacyTerrainColorFromWeights(weights));
  }

  for (const { centerChunkX, centerChunkZ, originChunkX, originChunkZ } of [
    { centerChunkX: 0, centerChunkZ: 0, originChunkX: 0, originChunkZ: 0 },
    { centerChunkX: -11, centerChunkZ: 39, originChunkX: -11, originChunkZ: 39 },
    { centerChunkX: 8_191, centerChunkZ: -4_097, originChunkX: 8_190, originChunkZ: -4_096 },
  ]) {
    const projected = topology.vertices.flatMap(({ x, z }) => [
      ((centerChunkX + 0.5) * 16 + x - originChunkX * 16) * 64,
      ((centerChunkZ + 0.5) * 16 + z - originChunkZ * 16) * 64,
    ]);
    const legacyProjected = legacyTopology.vertices.flatMap(({ x, z }) => [
      ((centerChunkX + 0.5) * 16 + x - originChunkX * 16) * 64,
      ((centerChunkZ + 0.5) * 16 + z - originChunkZ * 16) * 64,
    ]);
    assert.deepEqual(new Float32Array(projected), new Float32Array(legacyProjected));
  }

  const chunk = deterministicTerrainFixture();
  const originX = chunk.chunkX * LEGACY_CHUNK_SIZE_METERS;
  const originZ = chunk.chunkZ * LEGACY_CHUNK_SIZE_METERS;
  let sampleCount = 0;
  for (let z = 0; z < 165; z += 1) {
    for (let x = 0; x < 165; x += 1) {
      const worldX = originX - 1.25 + x / 164 * 18.5;
      const worldZ = originZ - 0.75 + z / 164 * 17.5;
      const expected = legacyTerrainSampleAt(chunk, worldX, worldZ);
      const actual = sampleW8DistantTerrainAt(chunk, worldX, worldZ);
      assert.deepEqual(
        new Float32Array([actual.height, ...actual.color]),
        new Float32Array([expected.height, ...expected.color]),
        `${x},${z}`,
      );
      sampleCount += 1;
    }
  }
  assert.equal(sampleCount, 27_225);

  const centerWorldX = (chunk.chunkX + 0.5) * LEGACY_CHUNK_SIZE_METERS;
  const centerWorldZ = (chunk.chunkZ + 0.5) * LEGACY_CHUNK_SIZE_METERS;
  const actualPositions = [];
  const legacyPositions = [];
  const actualColors = [];
  const legacyColors = [];
  for (const { x, z } of topology.vertices) {
    const worldX = centerWorldX + x;
    const worldZ = centerWorldZ + z;
    const actual = sampleW8DistantTerrainAt(chunk, worldX, worldZ);
    const expected = legacyTerrainSampleAt(chunk, worldX, worldZ);
    actualPositions.push(
      (worldX - originX) * 64,
      actual.height * 64,
      (worldZ - originZ) * 64,
    );
    legacyPositions.push(
      (worldX - originX) * 64,
      expected.height * 64,
      (worldZ - originZ) * 64,
    );
    actualColors.push(...actual.color);
    legacyColors.push(...expected.color);
  }
  assert.deepEqual(new Float32Array(actualPositions), new Float32Array(legacyPositions));
  assert.deepEqual(new Float32Array(actualColors), new Float32Array(legacyColors));
  assert.deepEqual(
    new Uint32Array(topology.indices),
    new Uint32Array(legacyTopology.indices),
  );

  const clipmapChecksum = (positions, colors) => {
    let checksum = 0x811c9dc5;
    for (const value of [...positions, ...colors]) {
      checksum ^= Math.round(value * 1000);
      checksum = Math.imul(checksum, 0x01000193) >>> 0;
    }
    return checksum;
  };
  assert.equal(
    clipmapChecksum(actualPositions, actualColors),
    clipmapChecksum(legacyPositions, legacyColors),
  );
});

test('the absolute hitch ceiling and crossing regression remain explicit five-run gates', () => {
  const report = (p95, p99, hitchRatio) => ({
    frame: { p95, p99, max: p99 }, hitchRatio, longTasks: [], hitches: [],
  });
  const finiteReports = new Array(5).fill(null).map(() => report(22, 35, 0.008));
  const beforeW8Reports = new Array(5).fill(null).map(() => report(24, 38, 0.0048));
  const overAbsoluteLimit = new Array(5).fill(null).map(() => report(24, 38, 0.0051));
  const rejectedHitches = evaluateW8PerformanceRuns({
    scenario: 'normal', finiteReports, beforeW8Reports, w8Reports: overAbsoluteLimit,
  });
  assert.equal(rejectedHitches.pass, false);
  assert.equal(rejectedHitches.criteria.absoluteOver50Ratio, false);
  assert.equal(rejectedHitches.criteria.finiteRelativeOver50Ratio, false);
  assert.equal(rejectedHitches.limits.finiteRelativeOver50Ratio, 0.005);

  const allowed = new Array(5).fill(null).map(() => report(24, 38, 0.0049));
  const accepted = evaluateW8PerformanceRuns({
    scenario: 'normal', finiteReports, beforeW8Reports, w8Reports: allowed,
  });
  assert.equal(accepted.pass, true);
  assert.equal(accepted.limits.finiteRelativeOver50Ratio, 0.005);
  assert.equal(accepted.limits.beforeW8Over50Ratio, null);

  const regressed = new Array(5).fill(null).map(() => report(24.1, 38.1, 0.0049));
  const rejected = evaluateW8PerformanceRuns({
    scenario: 'crossing', finiteReports, beforeW8Reports, w8Reports: regressed,
  });
  assert.equal(rejected.pass, false);
  assert.equal(rejected.criteria.beforeW8P95, false);
  assert.equal(rejected.criteria.beforeW8P99, false);
  assert.equal(rejected.criteria.beforeW8Over50Ratio, false);
});
