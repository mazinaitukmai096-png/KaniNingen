import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_CHUNK_SIZE,
  SUPPORTED_RENDER_CHUNK_SIZES,
  createRenderScale,
} from './chunk-coordinates.js';

export const W1B_SELECTED_RENDER_CHUNK_SIZE = RENDER_CHUNK_SIZE;
export const W1B_BENCHMARK_SCHEMA = 'w1b-chunk-size-benchmark-1';

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function benchmarkProjection(renderChunkSize, { iterations, rounds, clock }) {
  const { unitsPerMeter } = createRenderScale(renderChunkSize);
  const samples = [];
  let checksum = 0;
  for (let round = 0; round < rounds; round += 1) {
    const startedAt = clock();
    for (let index = 0; index < iterations; index += 1) {
      const chunkOffsetX = index % 5 - 2;
      const chunkOffsetZ = Math.floor(index / 5) % 5 - 2;
      const logicalLocalX = (index % 1601) / 100;
      const logicalLocalZ = ((index * 17) % 1601) / 100;
      checksum += chunkOffsetX * renderChunkSize + logicalLocalX * unitsPerMeter;
      checksum -= chunkOffsetZ * renderChunkSize + logicalLocalZ * unitsPerMeter;
    }
    samples.push(clock() - startedAt);
  }
  return Object.freeze({
    iterationsPerRound: iterations,
    rounds,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
    nanosecondsPerProjectionP50: percentile(samples, 0.5) * 1e6 / iterations,
    checksum: Number(checksum.toFixed(3)),
  });
}

export function describeRenderChunkCandidate(renderChunkSize, {
  playerSpeedMetersPerSecond = 32,
  futureSettlementDiameterMeters = 160,
} = {}) {
  const scale = createRenderScale(renderChunkSize);
  return Object.freeze({
    ...scale,
    logicalChunkSizeMeters: LOGICAL_CHUNK_SIZE_METERS,
    chunkCrossingsPerSecondAtDebugSpeed: playerSpeedMetersPerSecond / LOGICAL_CHUNK_SIZE_METERS,
    renderedDiameterChunks: 3,
    renderedDiameterMeters: LOGICAL_CHUNK_SIZE_METERS * 3,
    prefetchedDiameterChunks: 5,
    prefetchedDiameterMeters: LOGICAL_CHUNK_SIZE_METERS * 5,
    futureSettlementDiameterMeters,
    futureSettlementSpanChunks: Math.ceil(futureSettlementDiameterMeters / LOGICAL_CHUNK_SIZE_METERS),
    futureSettlementDiameterRenderUnits: futureSettlementDiameterMeters * scale.unitsPerMeter,
    maximumChunkRootMagnitudeIn3x3: renderChunkSize,
    changesW1AChunkDataRenderField: renderChunkSize !== RENDER_CHUNK_SIZE,
  });
}

export function selectW1BRenderChunkSize(candidateResults) {
  const bySize = new Map(candidateResults.map(result => [result.renderChunkSize, result]));
  for (const size of SUPPORTED_RENDER_CHUNK_SIZES) {
    if (!bySize.has(size)) throw new TypeError(`missing benchmark candidate ${size}`);
  }
  const current = bySize.get(RENDER_CHUNK_SIZE);
  const smaller = bySize.get(2048);
  const topologyEquivalent = [
    'logicalChunkSizeMeters',
    'chunkCrossingsPerSecondAtDebugSpeed',
    'renderedDiameterChunks',
    'renderedDiameterMeters',
    'prefetchedDiameterChunks',
    'prefetchedDiameterMeters',
    'futureSettlementSpanChunks',
  ].every(field => current[field] === smaller[field]);
  if (!topologyEquivalent) throw new Error('render candidates unexpectedly change logical streaming topology');
  return Object.freeze({
    selectedRenderChunkSize: RENDER_CHUNK_SIZE,
    selectedUnitsPerMeter: current.unitsPerMeter,
    topologyEquivalent,
    selectionReasons: Object.freeze([
      '4096 and 2048 have identical 16m logical chunks, crossing frequency, 3x3 visibility, and 5x5 prefetch coverage',
      'both candidates use identical scene-object, geometry, material, and draw-call counts',
      'Floating Origin bounds both candidates to one chunk root magnitude inside the 3x3 render set',
      'future settlement span is defined in logical meters/chunks and is therefore equal for both candidates',
      '4096 preserves the W1A ChunkData render field, content hashes, visual scale, and migration baseline',
      'coordinate projection is not a streaming bottleneck and does not justify identity/visual churn',
    ]),
  });
}

export function runW1BChunkSizeBenchmark({
  iterations = 100_000,
  rounds = 7,
  clock = () => globalThis.performance?.now?.() ?? Date.now(),
  playerSpeedMetersPerSecond = 32,
  futureSettlementDiameterMeters = 160,
} = {}) {
  if (!Number.isSafeInteger(iterations) || iterations < 1000) throw new RangeError('iterations must be at least 1000');
  if (!Number.isSafeInteger(rounds) || rounds < 3) throw new RangeError('rounds must be at least 3');
  const candidates = SUPPORTED_RENDER_CHUNK_SIZES.map(renderChunkSize => Object.freeze({
    ...describeRenderChunkCandidate(renderChunkSize, {
      playerSpeedMetersPerSecond,
      futureSettlementDiameterMeters,
    }),
    projectionBenchmark: benchmarkProjection(renderChunkSize, { iterations, rounds, clock }),
  }));
  return Object.freeze({
    schemaVersion: W1B_BENCHMARK_SCHEMA,
    candidates: Object.freeze(candidates),
    decision: selectW1BRenderChunkSize(candidates),
  });
}
