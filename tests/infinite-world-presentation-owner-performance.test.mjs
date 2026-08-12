import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from 'node:v8';

import { createPresentationOwnerGenerator } from '../src/infinite-world/presentation-owner-generator.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import {
  FULL_RESIDENT_BOUNDED_PREFETCH_OWNER_COUNT,
  FULL_RESIDENT_OWNER_COUNT,
  PRESENTATION_RESIDENT_OWNER_COUNT,
  RESIDENT_WORLD_BOUNDED_PREFETCH_OWNER_COUNT,
  createResidentWorldCoverage,
} from '../src/infinite-world/chunk-streaming-plan.js';

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

test('production Presentation cutover clears throughput and nested serialized-memory gates', async t => {
  const generator = await createW8ParityChunkGenerator({
    worldSeed: 'KaniNingen Infinite Natural World',
  });
  const coordinates = Array.from({ length: 128 }, (_, index) => ({
    chunkX: 40 + index % 16,
    chunkZ: 40 + Math.floor(index / 16),
  }));
  try {
    for (const coordinate of coordinates.slice(0, 8)) {
      await generator.generatePresentationOwner(coordinate.chunkX, coordinate.chunkZ);
    }
    const presentationPayloadBytes = [];
    const startedAt = performance.now();
    for (const coordinate of coordinates) {
      const owner = await generator.generatePresentationOwner(
        coordinate.chunkX,
        coordinate.chunkZ,
      );
      presentationPayloadBytes.push(serialize(owner).byteLength);
    }
    const presentationWallMs = performance.now() - startedAt;
    const presentationOwnersPerSecond = coordinates.length * 1000 / presentationWallMs;
    const presentationP50Bytes = percentile(presentationPayloadBytes, 0.5);
    const presentationP95Bytes = percentile(presentationPayloadBytes, 0.95);
    const fullPayloadBytes = [];
    const fullCoordinates = coordinates.slice(0, 24);
    for (const coordinate of fullCoordinates) {
      fullPayloadBytes.push(serialize(await generator.generateChunk(
        coordinate.chunkX,
        coordinate.chunkZ,
      )).byteLength);
    }
    const fullP50Bytes = percentile(fullPayloadBytes, 0.5);
    const fullP95Bytes = percentile(fullPayloadBytes, 0.95);
    const toMiB = bytes => bytes / (1024 ** 2);
    const presentationResidentMiB = toMiB(
      PRESENTATION_RESIDENT_OWNER_COUNT * presentationP50Bytes,
    );
    const presentationPrefetchMiB = toMiB(
      RESIDENT_WORLD_BOUNDED_PREFETCH_OWNER_COUNT * presentationP50Bytes,
    );
    const fullResidentMiB = toMiB(FULL_RESIDENT_OWNER_COUNT * fullP50Bytes);
    const fullPrefetchMiB = toMiB(
      FULL_RESIDENT_BOUNDED_PREFETCH_OWNER_COUNT * fullP50Bytes,
    );
    const nestedTotalMiB = presentationResidentMiB + presentationPrefetchMiB
      + fullResidentMiB + fullPrefetchMiB;
    const snapshot = generator.snapshot().resourceGeneration;
    const report = {
      presentationOwnersPerSecond,
      presentationWallMs,
      initialFillSeconds: PRESENTATION_RESIDENT_OWNER_COUNT / presentationOwnersPerSecond,
      presentationP50Bytes,
      presentationP95Bytes,
      fullP50Bytes,
      fullP95Bytes,
      presentationResidentMiB,
      presentationPrefetchMiB,
      fullResidentMiB,
      fullPrefetchMiB,
      nestedTotalMiB,
      fullChunkRequestsDuringPresentation: snapshot.fullChunkRequests - fullCoordinates.length,
    };
    t.diagnostic(JSON.stringify(report));
    assert.ok(presentationOwnersPerSecond >= 212.5);
    assert.ok(report.initialFillSeconds < 10);
    assert.equal(report.fullChunkRequestsDuringPresentation, 0);
    assert.ok(nestedTotalMiB < 64,
      `nested serialized memory ${nestedTotalMiB.toFixed(3)} MiB must stay below 64 MiB`);
  } finally {
    await generator.shutdown();
  }
});
