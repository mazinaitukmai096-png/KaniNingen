import assert from 'node:assert/strict';
import test from 'node:test';

import { LOGICAL_CHUNK_SIZE_METERS } from '../src/infinite-world/chunk-coordinates.js';
import { createNodeChunkGeneratorWorker } from '../src/infinite-world/node-worker-chunk-generator-adapter.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import {
  createFixedLaneWorkerChunkGeneratorTransport,
} from '../src/infinite-world/worker-chunk-generator-transport.js';

const WORLD_SEED = 'KaniNingen Infinite Natural World';
const OWNERS = Object.freeze([
  Object.freeze({ x: 55, z: 77 }),
  Object.freeze({ x: 58, z: 71 }),
]);
const EXPECTED_HASHES = Object.freeze([
  Object.freeze({
    contentHash: 'sha256:98308c3eecff0abd6305c310f285cbed2eb698f34b4c15a891dcedd96c73d4bc',
    sourceW5ContentHash: 'sha256:eaaf9a1538c5b09540f84a891879449c014374b15a77f7dcad2ed639cfc4b5fb',
  }),
  Object.freeze({
    contentHash: 'sha256:41319391c75bef8c66a55482184d9f87dcbcd615dc5967372f130542927be502',
    sourceW5ContentHash: 'sha256:6ed7f9fc22bb78d4f85c61add5eb01308987943519536e41607c167e5e84c4d2',
  }),
]);
const TARGET_SETTLEMENT_ID = 'settlement-v1:7406aeda270ba27e647af7c6';
const QUERY_CENTER = Object.freeze({
  x: (OWNERS[0].x + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
  z: (OWNERS[0].z + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
});

function canonicalPresentationIdentity(owner) {
  return Object.freeze({
    schemaVersion: owner.schemaVersion,
    chunkId: owner.chunkId,
    contentHash: owner.contentHash,
    chunkX: owner.chunkX,
    chunkZ: owner.chunkZ,
    resource: owner.resource,
    canonicalSurfacePolicy: owner.canonicalSurfacePolicy,
    riverProjection: owner.riverProjection,
  });
}

function featureRecords(chunk, predicate) {
  return [
    ...(chunk.settlementFeatures ?? []),
    ...(chunk.settlementOverlayFeatures ?? []),
    ...(chunk.sourceChunkData?.settlementFeatures ?? []),
  ].filter(predicate).sort((left, right) => left.stableId.localeCompare(right.stableId));
}

function stableIds(chunk) {
  return [
    ...(chunk.settlementFeatures ?? []),
    ...(chunk.settlementOverlayFeatures ?? []),
    ...(chunk.sourceChunkData?.settlementFeatures ?? []),
    ...(chunk.vegetationCandidates ?? []),
    ...(chunk.rockCandidates ?? []),
    ...(chunk.sourceChunkData?.vegetationCandidates ?? []),
    ...(chunk.sourceChunkData?.rockCandidates ?? []),
  ].map(record => record.stableId ?? record.candidateId)
    .filter(value => typeof value === 'string')
    .sort((left, right) => left.localeCompare(right));
}

function assertFiniteSettlementMetadata(chunk, label) {
  for (const reference of [
    ...(chunk.settlementReferences ?? []),
    ...(chunk.sourceChunkData?.settlementReferences ?? []),
  ]) {
    assert.equal(typeof reference.settlementId, 'string', `${label} Settlement ID`);
    for (const [field, value] of [
      ['macroRegion.x', reference.macroRegion?.x],
      ['macroRegion.z', reference.macroRegion?.z],
      ['center.x', reference.center?.x],
      ['center.z', reference.center?.z],
      ['radiusMeters', reference.radiusMeters],
      ['urbanization', reference.urbanization],
      ['terrainSuitability', reference.terrainSuitability],
    ]) {
      assert.ok(Number.isFinite(value), `${label} ${reference.settlementId} ${field}`);
    }
  }
}

test('fixed Critical/Background real Workers preserve Inline canonical World identity', {
  timeout: 180_000,
}, async () => {
  const inline = await createW8ParityChunkGenerator({ worldSeed: WORLD_SEED });
  const worker = createFixedLaneWorkerChunkGeneratorTransport({
    worldSeed: WORLD_SEED,
    serviceGeneration: 91_001,
    workerFactory: createNodeChunkGeneratorWorker,
  });
  let requestId = 910_010;
  try {
    await worker.initialize();
    const inlineCandidates = await inline.distributor.findSettlementsNear(
      QUERY_CENTER.x,
      QUERY_CENTER.z,
      0,
    );
    const inlineCandidate = inlineCandidates.find(candidate => (
      candidate.settlementId === TARGET_SETTLEMENT_ID
    ));
    assert.ok(inlineCandidate, 'canonical Settlement witness must exist');
    const inlineChunks = [];
    const inlineOwners = [];
    for (const owner of OWNERS) {
      inlineChunks.push(await inline.generateChunk(owner.x, owner.z));
      inlineOwners.push(await inline.generatePresentationOwner(owner.x, owner.z));
    }
    const inlineTemplate = await inline.resolveSettlementPresentationTemplate({
      candidate: inlineCandidate,
    });

    const workerCandidates = await worker.findSettlementsNear(
      QUERY_CENTER.x,
      QUERY_CENTER.z,
      0,
    );
    const workerCandidate = workerCandidates.find(candidate => (
      candidate.settlementId === TARGET_SETTLEMENT_ID
    ));
    assert.deepEqual(workerCandidate, inlineCandidate);
    const [workerChunks, workerOwners, coverage, workerTemplate] = await Promise.all([
      Promise.all(OWNERS.map(owner => worker.generateChunk({
        requestId: requestId += 1,
        chunkX: owner.x,
        chunkZ: owner.z,
      }))),
      Promise.all(OWNERS.map(owner => worker.generatePresentationOwner({
        chunkX: owner.x,
        chunkZ: owner.z,
      }))),
      worker.resolveCanonicalMajorRoadOwnerCoverage({
        centerWorldX: QUERY_CENTER.x,
        centerWorldZ: QUERY_CENTER.z,
        radiusMeters: 0,
      }),
      worker.resolveSettlementPresentationTemplate({ candidate: workerCandidate }),
    ]);
    assert.ok(coverage.roadCount > 0, 'Background lane must exercise canonical MAJOR Roads');

    for (let index = 0; index < OWNERS.length; index += 1) {
      const actual = workerChunks[index];
      const expected = inlineChunks[index];
      assert.equal(actual.contentHash, EXPECTED_HASHES[index].contentHash);
      assert.equal(actual.sourceW5ContentHash, EXPECTED_HASHES[index].sourceW5ContentHash);
      assertFiniteSettlementMetadata(actual, `owner ${OWNERS[index].x},${OWNERS[index].z}`);
      assert.deepEqual(stableIds(actual), stableIds(expected), 'Stable ID order drifted');
      assert.deepEqual(actual.terrain, expected.terrain, 'canonical Terrain Y drifted');
      assert.deepEqual(actual.sourceChunkData.terrain, expected.sourceChunkData.terrain,
        'source Terrain Y drifted');
      assert.deepEqual(featureRecords(actual, record => (
        record.canonicalMajorRoad === true || record.featureType === 'settlement-road'
      )), featureRecords(expected, record => (
        record.canonicalMajorRoad === true || record.featureType === 'settlement-road'
      )), 'Road records/segments/XYZ drifted');
      assert.deepEqual(featureRecords(actual, record => (
        record.featureType === 'building' || record.featureType === 'settlement-building'
      )), featureRecords(expected, record => (
        record.featureType === 'building' || record.featureType === 'settlement-building'
      )), 'Building records/XYZ drifted');
      assert.deepEqual(actual, expected, 'complete canonical ChunkData drifted');
    }
    assert.deepEqual(
      workerOwners.map(canonicalPresentationIdentity),
      inlineOwners.map(canonicalPresentationIdentity),
      'PresentationOwner canonical identity drifted',
    );
    assert.deepEqual(workerTemplate, inlineTemplate, 'Settlement template drifted');

    const snapshot = worker.snapshot();
    assert.equal(snapshot.kind, 'worker-fixed-lanes');
    assert.equal(snapshot.mode, 'worker');
    assert.equal(snapshot.fallbackOccurred, false);
    assert.equal(snapshot.pendingCount, 0);
    assert.equal(snapshot.lanes.critical.mode, 'worker');
    assert.equal(snapshot.lanes.background.mode, 'worker');
  } finally {
    await Promise.allSettled([worker.shutdown(), inline.shutdown()]);
  }
});
