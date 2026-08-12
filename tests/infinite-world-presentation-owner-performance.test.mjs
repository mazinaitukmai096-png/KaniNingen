import test from 'node:test';
import assert from 'node:assert/strict';

import { createPresentationOwnerGenerator } from '../src/infinite-world/presentation-owner-generator.js';
import { createResidentWorldCoverage } from '../src/infinite-world/chunk-streaming-plan.js';

const percentile = (values, ratio) => [...values]
  .sort((left, right) => left - right)[Math.floor((values.length - 1) * ratio)];

async function measureBatch(generator, coordinates) {
  const generationMs = [];
  const serializationMs = [];
  const cloneMs = [];
  const payloadBytes = [];
  const startedAt = performance.now();
  for (const { chunkX, chunkZ } of coordinates) {
    const generationStartedAt = performance.now();
    const { resource } = await generator.generateOwner(chunkX, chunkZ);
    generationMs.push(performance.now() - generationStartedAt);
    const serializationStartedAt = performance.now();
    const serialized = JSON.stringify(resource);
    serializationMs.push(performance.now() - serializationStartedAt);
    payloadBytes.push(Buffer.byteLength(serialized));
    const cloneStartedAt = performance.now();
    structuredClone(resource);
    cloneMs.push(performance.now() - cloneStartedAt);
  }
  const wallMs = performance.now() - startedAt;
  return {
    count: coordinates.length,
    wallMs,
    effectiveOwnersPerSecond: coordinates.length * 1000 / wallMs,
    generationMs,
    serializationMs,
    cloneMs,
    payloadBytes,
  };
}

test('purpose-built Presentation generator clears throughput, payload, and initial-fill gates', async t => {
  const generator = await createPresentationOwnerGenerator({
    worldSeed: 'KaniNingen Infinite Natural World',
  });
  const coordinates = (count, offsetX, offsetZ) => Array.from({ length: count }, (_, index) => ({
    chunkX: offsetX + index % 16,
    chunkZ: offsetZ + Math.floor(index / 16),
  }));
  await measureBatch(generator, coordinates(32, 0, 96));
  const batch32 = await measureBatch(generator, coordinates(32, 24, 104));
  const batch128Runs = [];
  for (let run = 0; run < 3; run += 1) {
    batch128Runs.push(await measureBatch(generator, coordinates(128, 64 + run * 20, 120)));
  }
  const centered = createResidentWorldCoverage({ centerChunkX: 34, centerChunkZ: 26 });
  const shifted = createResidentWorldCoverage({ centerChunkX: 35, centerChunkZ: 26 });
  const centeredKeys = new Set(centered.presentationView.ownerKeys);
  const entering = shifted.presentationView.ownerCoordinates
    .filter(value => !centeredKeys.has(value.key));
  const enteringStrip = await measureBatch(generator, entering.map(value => ({
    chunkX: value.chunkX + 180,
    chunkZ: value.chunkZ,
  })));
  const representative = [...batch128Runs]
    .sort((left, right) => left.effectiveOwnersPerSecond - right.effectiveOwnersPerSecond)[1];
  const effectiveOwnersPerSecond = representative.effectiveOwnersPerSecond;
  const initialFillSeconds = 1757 / effectiveOwnersPerSecond;
  const report = {
    batch32OwnersPerSecond: batch32.effectiveOwnersPerSecond,
    batch128OwnersPerSecond: batch128Runs.map(value => value.effectiveOwnersPerSecond),
    enteringStripOwnerCount: enteringStrip.count,
    enteringStripOwnersPerSecond: enteringStrip.effectiveOwnersPerSecond,
    generationP50Ms: percentile(representative.generationMs, 0.5),
    generationP95Ms: percentile(representative.generationMs, 0.95),
    generationMaximumMs: Math.max(...representative.generationMs),
    serializationP50Ms: percentile(representative.serializationMs, 0.5),
    serializationP95Ms: percentile(representative.serializationMs, 0.95),
    cloneP50Ms: percentile(representative.cloneMs, 0.5),
    cloneP95Ms: percentile(representative.cloneMs, 0.95),
    payloadP50Bytes: percentile(representative.payloadBytes, 0.5),
    payloadP95Bytes: percentile(representative.payloadBytes, 0.95),
    payloadMaximumBytes: Math.max(...representative.payloadBytes),
    effectiveOwnersPerSecond,
    initialFillSeconds,
  };
  t.diagnostic(JSON.stringify(report));
  assert.ok(effectiveOwnersPerSecond >= 212.5,
    `Presentation supply ${effectiveOwnersPerSecond.toFixed(3)} owner/s is below 212.5 owner/s`);
  assert.ok(initialFillSeconds < 10);
  assert.ok(report.payloadP50Bytes <= 4000);
  assert.ok(report.payloadP95Bytes <= 7000);
  assert.ok(report.payloadMaximumBytes <= 8000);
});
