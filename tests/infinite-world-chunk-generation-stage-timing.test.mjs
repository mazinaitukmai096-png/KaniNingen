import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHUNK_GENERATION_STAGE,
  CHUNK_GENERATION_STAGE_ORDER,
  createChunkGenerationStageRecorder,
} from '../src/infinite-world/chunk-generation-stage-timing.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';

test('Chunk generation stage recorder retains bounded deterministic stage timings', async () => {
  let now = 0;
  const recorder = createChunkGenerationStageRecorder({
    clock: () => now,
    capacity: CHUNK_GENERATION_STAGE_ORDER.length,
  });
  const terrain = recorder.start(CHUNK_GENERATION_STAGE.TERRAIN);
  now += 4;
  recorder.end(terrain);
  await recorder.measure(CHUNK_GENERATION_STAGE.RIVER, async () => {
    now += 3;
  });
  assert.throws(() => recorder.measureSync(CHUNK_GENERATION_STAGE.ROAD, () => {
    now += 2;
    throw new Error('road failed');
  }), /road failed/);
  for (let index = 0; index < 6; index += 1) {
    recorder.measureSync(CHUNK_GENERATION_STAGE.CANONICAL, () => { now += 1; });
  }
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.totalsMs.terrain, 4);
  assert.equal(snapshot.totalsMs.river, 3);
  assert.equal(snapshot.totalsMs.road, 2);
  assert.equal(snapshot.totalsMs.canonical, 6);
  assert.equal(snapshot.callCounts.canonical, 6);
  assert.equal(snapshot.events.length, CHUNK_GENERATION_STAGE_ORDER.length);
  assert.equal(snapshot.events.some(event => (
    event.stage === CHUNK_GENERATION_STAGE.ROAD && event.status === 'failed'
  )), true);
});

test('W8 diagnostics split every required generation stage without changing Chunk identity', async () => {
  const worldSeed = 'W8 stage timing determinism';
  const diagnosticGenerator = await createW8ParityChunkGenerator({ worldSeed });
  const baselineGenerator = await createW8ParityChunkGenerator({ worldSeed });
  try {
    const recorder = createChunkGenerationStageRecorder();
    const diagnosticChunk = await diagnosticGenerator.generateChunk(203, -197, {
      stageRecorder: recorder,
    });
    const baselineChunk = await baselineGenerator.generateChunk(203, -197);
    assert.equal(diagnosticChunk.chunkId, baselineChunk.chunkId);
    assert.equal(diagnosticChunk.contentHash, baselineChunk.contentHash);
    assert.deepEqual(
      diagnosticChunk.presentationLayers.integrationOrder,
      baselineChunk.presentationLayers.integrationOrder,
    );
    const snapshot = recorder.snapshot();
    for (const stage of CHUNK_GENERATION_STAGE_ORDER) {
      assert.ok(snapshot.callCounts[stage] > 0, `${stage} was not measured`);
      assert.ok(snapshot.totalsMs[stage] >= 0, `${stage} has an invalid duration`);
    }
  } finally {
    await diagnosticGenerator.shutdown();
    await baselineGenerator.shutdown();
  }
});
