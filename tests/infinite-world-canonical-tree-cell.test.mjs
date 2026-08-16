import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  CHUNK_DATA_PRIORITY,
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
  createCanonicalTreeCellGeneratorRequest,
} from '../src/infinite-world/chunk-data-service-protocol.js';
import { createFormalNaturalCandidateKernel } from '../src/infinite-world/formal-natural-chunk-generator.js';
import { createInlineChunkGeneratorTransport } from '../src/infinite-world/inline-chunk-generator-transport.js';
import { hashWorldSeed, normalizeWorldSeed } from '../src/infinite-world/legacy-core/g0/seed.js';
import { createSharedCanonicalNaturalKernel } from '../src/infinite-world/natural-chunk-generator.js';
import { createNodeChunkGeneratorWorker } from '../src/infinite-world/node-worker-chunk-generator-adapter.js';
import {
  W8_CANONICAL_TREE_CELL_SCHEMA,
  W8_CANONICAL_TREE_OWNERS_PER_AXIS,
} from '../src/infinite-world/presentation-owner-generator.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import { createWorkerChunkGeneratorTransport } from '../src/infinite-world/worker-chunk-generator-transport.js';

const seed = 'KaniNingen Infinite Natural World';
const compactTreeFields = Object.freeze([
  'stableId',
  'owner',
  'position',
  'objectType',
  'subtype',
  'visualKind',
  'dimensions',
  'rotationY',
  'variationSeed',
  'densityRank',
  'paletteKey',
]);

function ownerCoordinates(macroX, macroZ) {
  return Array.from({ length: W8_CANONICAL_TREE_OWNERS_PER_AXIS ** 2 }, (_, index) => ({
    chunkX: macroX * W8_CANONICAL_TREE_OWNERS_PER_AXIS
      + index % W8_CANONICAL_TREE_OWNERS_PER_AXIS,
    chunkZ: macroZ * W8_CANONICAL_TREE_OWNERS_PER_AXIS
      + Math.floor(index / W8_CANONICAL_TREE_OWNERS_PER_AXIS),
  }));
}

async function presentationTreesForCell(generator, macroX, macroZ) {
  const owners = await Promise.all(ownerCoordinates(macroX, macroZ).map(
    ({ chunkX, chunkZ }) => generator.generatePresentationOwner(chunkX, chunkZ),
  ));
  return {
    owners,
    trees: owners.flatMap(owner => (
      owner.resource.natural.filter(record => record.objectType === 'tree')
    )),
  };
}

test('vegetation-only candidate preparation preserves Full vegetation and Rock conflicts', async () => {
  const { worldSeedHash } = await hashWorldSeed(normalizeWorldSeed(seed));
  const [naturalKernel, candidateKernel] = await Promise.all([
    createSharedCanonicalNaturalKernel({ worldSeedHash }),
    createFormalNaturalCandidateKernel({ worldSeedHash }),
  ]);
  const chunkX = -3;
  const chunkZ = 2;
  const createInput = ownerSampler => ({
    chunk: { chunkX, chunkZ, worldSeedHash },
    sampleTerrainAt: (_chunk, point, candidateKind) => ownerSampler.sampleTerrain(
      point,
      { includeMaterials: candidateKind === 'rock' },
    ),
    sampleBiomeWeightsAt: (_chunk, point) => ownerSampler.sampleBiomeWeights(point),
  });
  const full = await candidateKernel.generate(
    createInput(naturalKernel.createOwnerSampler(chunkX, chunkZ)),
  );
  const vegetation = await candidateKernel.generateVegetation(
    createInput(naturalKernel.createOwnerSampler(chunkX, chunkZ)),
  );
  const rocks = await candidateKernel.generateRocks({
    ...createInput(naturalKernel.createOwnerSampler(chunkX, chunkZ)),
    vegetationCandidates: vegetation.vegetationCandidates,
  });

  assert.deepEqual(vegetation.vegetationCandidates, full.vegetationCandidates);
  assert.deepEqual(rocks.rockCandidates, full.rockCandidates);
  assert.ok(Object.isFrozen(vegetation.vegetationCandidates));
  assert.ok(Object.isFrozen(rocks.rockCandidates));
});

test('canonical Tree cell exactly matches production PresentationOwner Trees for spawn/River and Settlement owners', async t => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  try {
    const measurements = [];
    for (const [macroX, macroZ, expectedContext] of [
      [0, 0, 'spawn-river'],
      [8, 6, 'settlement-structure'],
    ]) {
      const graphRequestsBefore = generator.snapshot().canonicalMajorRoad.graphRequests;
      const startedAt = performance.now();
      const cell = await generator.generateCanonicalTreeCell(macroX, macroZ);
      const cellReadyAt = performance.now();
      assert.equal(
        generator.snapshot().canonicalMajorRoad.graphRequests - graphRequestsBefore,
        1,
        'one 64 m Tree batch must prepare its shared Major Road graph once',
      );
      const expected = await presentationTreesForCell(generator, macroX, macroZ);
      measurements.push({
        key: cell.key,
        context: expectedContext,
        treeOnlyMs: Math.round((cellReadyAt - startedAt) * 1_000) / 1_000,
        presentationParityMs: Math.round((performance.now() - cellReadyAt) * 1_000) / 1_000,
        treeCount: cell.trees.length,
      });

      assert.equal(cell.schemaVersion, W8_CANONICAL_TREE_CELL_SCHEMA);
      assert.equal(cell.key, `${macroX},${macroZ}`);
      assert.equal(cell.ownerKeys.length, 16);
      assert.deepEqual(cell.ownerKeys, ownerCoordinates(macroX, macroZ)
        .map(({ chunkX, chunkZ }) => `${chunkX},${chunkZ}`));
      assert.equal(cell.ownerBoundaries.length, 16);
      assert.deepEqual(cell.trees, expected.trees,
        `${expectedContext} must use the identical production exclusion result`);
      assert.equal(new Set(cell.trees.map(tree => tree.stableId)).size, cell.trees.length);
      assert.match(cell.contentHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(cell.diagnostics.ownerCount, 16);
      assert.equal(cell.diagnostics.treeCount, cell.trees.length);
      assert.equal(cell.diagnostics.rockCandidateCount, 0);
      assert.equal(cell.diagnostics.rockGenerationSkippedOwnerCount, 16);
      assert.equal(cell.identity.worldSeedHash, generator.worldSeedHash);
      assert.ok(cell.identity.sourceRevision.includes('formal-natural-candidate-kernel-1'));

      for (const tree of cell.trees) {
        assert.deepEqual(Object.keys(tree), compactTreeFields);
        assert.equal(tree.objectType, 'tree');
        assert.ok(tree.stableId.startsWith('detail-v1:vegetation:'));
        assert.ok(tree.position.every(Number.isFinite));
        assert.ok(tree.dimensions.every(Number.isFinite));
        assert.ok(Number.isFinite(tree.rotationY));
        assert.ok(Number.isFinite(tree.densityRank));
        assert.equal('candidateId' in tree, false);
        assert.equal('canonicalInput' in tree, false);
      }
      for (const boundary of cell.ownerBoundaries) {
        assert.deepEqual(
          cell.trees.slice(boundary.treeOffset, boundary.treeOffset + boundary.treeCount)
            .map(tree => tree.owner),
          Array.from({ length: boundary.treeCount }, () => boundary.ownerKey),
        );
        assert.equal(boundary.maximumExclusiveX - boundary.minimumX, 16);
        assert.equal(boundary.maximumExclusiveZ - boundary.minimumZ, 16);
      }
      if (expectedContext === 'settlement-structure') {
        assert.ok(expected.owners.some(owner => owner.resource.structures.length > 0));
      }
    }
    const counters = generator.snapshot().resourceGeneration;
    assert.equal(counters.fullChunkRequests, 0);
    assert.equal(counters.canonicalTreeCellRequests, 2);
    assert.equal(counters.canonicalTreeCellCompleted, 2);
    assert.equal(counters.presentationOwnerRequests, 32);
    t.diagnostic(JSON.stringify({ productionTreeCellMeasurements: measurements }));
  } finally {
    await generator.shutdown();
  }
});

test('canonical Tree-cell request and Inline transport are one dedicated coarse operation', async () => {
  const request = createCanonicalTreeCellGeneratorRequest({
    requestId: 7,
    serviceGeneration: 3,
    macroX: -2,
    macroZ: 4,
    priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
    createdAtMs: 10,
    deadlineAtMs: 30,
    epoch: 5,
  });
  assert.equal(request.type, CHUNK_GENERATOR_MESSAGE.GENERATE_CANONICAL_TREE_CELL);
  assert.equal(request.protocolVersion, CHUNK_GENERATOR_PROTOCOL_VERSION);
  assert.equal(request.scheduler.operationKind, 'canonical-tree-cell');
  assert.equal(request.scheduler.ownerKey, '-2,4');
  assert.equal(request.scheduler.resourceKind, 'canonical-tree-cell');
  assert.equal(request.scheduler.representationClass, 'coarse');
  assert.equal(request.scheduler.target, 'tree');
  assert.equal(request.scheduler.epoch, 5);
  assert.throws(() => createCanonicalTreeCellGeneratorRequest({
    requestId: 8,
    serviceGeneration: 3,
    macroX: Number.MAX_SAFE_INTEGER,
    macroZ: 0,
  }), /exceed safe owner coordinates/);

  let fullCalls = 0;
  const canonicalCalls = [];
  const fixture = Object.freeze({ schemaVersion: W8_CANONICAL_TREE_CELL_SCHEMA, key: '-2,4' });
  const transport = createInlineChunkGeneratorTransport({
    generator: {
      worldSeed: seed,
      async generateChunk() { fullCalls += 1; return null; },
      async generateCanonicalTreeCell(macroX, macroZ, options) {
        canonicalCalls.push({ macroX, macroZ, options });
        return fixture;
      },
    },
  });
  try {
    const value = await transport.generateCanonicalTreeCell({ macroX: -2, macroZ: 4 });
    assert.equal(value, fixture);
    assert.equal(fullCalls, 0);
    assert.equal(canonicalCalls.length, 1);
    assert.deepEqual(canonicalCalls[0].macroX, -2);
    assert.deepEqual(canonicalCalls[0].macroZ, 4);
    assert.equal(canonicalCalls[0].options.scheduler.operationKind, 'canonical-tree-cell');
    assert.equal(canonicalCalls[0].options.scheduler.representationClass, 'coarse');
    assert.equal(transport.snapshot().canonicalTreeCellGeneratedCount, 1);
  } finally {
    await transport.shutdown();
  }
});

test('real Worker performs one logical 64m Tree-only batch matching Inline identity', async t => {
  const inlineGenerator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const inline = createInlineChunkGeneratorTransport({ generator: inlineGenerator });
  const worker = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    workerFactory: createNodeChunkGeneratorWorker,
  });
  try {
    await Promise.all([inline.initialize(), worker.initialize()]);
    const inlineStartedAt = performance.now();
    const inlineCell = await inline.generateCanonicalTreeCell({ macroX: 20, macroZ: 20 });
    const inlineMs = performance.now() - inlineStartedAt;
    const workerStartedAt = performance.now();
    const workerCell = await worker.generateCanonicalTreeCell({ macroX: 20, macroZ: 20 });
    const workerMs = performance.now() - workerStartedAt;

    assert.deepEqual(workerCell, inlineCell);
    assert.equal(workerCell.ownerKeys.length, 16);
    assert.equal(workerCell.diagnostics.rockCandidateCount, 0);
    assert.equal(worker.snapshot().counts.canonicalTreeCellsGenerated, 1);
    assert.equal(worker.snapshot().counts.generated, 0);
    assert.equal(inline.snapshot().canonicalTreeCellGeneratedCount, 1);
    assert.ok(worker.snapshot().canonicalTreeCellGenerationMsMaximum > 0);
    assert.ok(worker.snapshot().canonicalTreeCellReceiveMsMaximum >= 0);

    const [inlineDiagnostics, workerDiagnostics] = await Promise.all([
      inline.requestDiagnostics(),
      worker.requestDiagnostics(),
    ]);
    assert.equal(inlineDiagnostics.resourceGeneration.fullChunkRequests, 0);
    assert.equal(workerDiagnostics.resourceGeneration.fullChunkRequests, 0);
    assert.equal(inlineDiagnostics.resourceGeneration.canonicalTreeCellRequests, 1);
    assert.equal(workerDiagnostics.resourceGeneration.canonicalTreeCellRequests, 1);
    t.diagnostic(JSON.stringify({
      productionLikeTreeCellThroughput: {
        inlineMs: Math.round(inlineMs * 1_000) / 1_000,
        inlineCellsPerSecond: Math.round(1_000_000 / inlineMs) / 1_000,
        workerRoundTripMs: Math.round(workerMs * 1_000) / 1_000,
        workerRoundTripCellsPerSecond: Math.round(1_000_000 / workerMs) / 1_000,
        treeCount: workerCell.trees.length,
      },
    }));
  } finally {
    await Promise.all([inline.shutdown(), worker.shutdown()]);
  }
});
