import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createCanonicalTreeOwnerViewBroker,
  requestCanonicalTreeCellThroughOwnerCoordinator,
} from '../src/infinite-world/sandbox-boot.js';
import { CHUNK_DATA_PRIORITY } from '../src/infinite-world/chunk-data-service-protocol.js';
import {
  WORLD_GENERATION_PRIORITY_CLASS,
  WORLD_GENERATION_REPRESENTATION_CLASS,
} from '../src/infinite-world/world-generation-scheduler.js';
import {
  derivePresentationOwnerCoarseSummary,
  validatePresentationOwnerResource,
} from '../src/infinite-world/presentation-owner-generator.js';

const repoRoot = resolve(import.meta.dirname, '..');
const worldSeedHash = 'sha256:canonical-tree-sandbox-wiring';

function createBatch(macroX = 2, macroZ = -1) {
  const ownerKeys = [];
  const ownerBoundaries = [];
  const trees = [];
  const rocks = [];
  for (let offsetZ = 0; offsetZ < 4; offsetZ += 1) {
    for (let offsetX = 0; offsetX < 4; offsetX += 1) {
      const chunkX = macroX * 4 + offsetX;
      const chunkZ = macroZ * 4 + offsetZ;
      const ownerKey = `${chunkX},${chunkZ}`;
      const treeOffset = trees.length;
      const rockOffset = rocks.length;
      trees.push(Object.freeze({
        stableId: `tree:${ownerKey}`,
        owner: ownerKey,
        position: Object.freeze([chunkX * 16 + 4, 3.25, chunkZ * 16 + 6]),
        objectType: 'tree',
        subtype: 'broadleaf-tree',
        visualKind: 'broadleaf-tree',
        dimensions: Object.freeze([2, 8, 2]),
        rotationY: 0.5,
        variationSeed: offsetZ * 4 + offsetX,
        densityRank: 0.25,
        paletteKey: 'tree:broadleaf-tree',
      }));
      rocks.push(Object.freeze({
        stableId: `rock:${ownerKey}`,
        owner: ownerKey,
        position: Object.freeze([chunkX * 16 + 11, 3.05, chunkZ * 16 + 12]),
        objectType: 'rock',
        subtype: 'medium-rock',
        visualKind: 'rock',
        dimensions: Object.freeze([1.4, 1.1, 1.3]),
        rotationY: 0.35,
        variationSeed: 0.6,
        densityRank: 0.2,
        paletteKey: 'rock:rock',
        coarsePresenceKind: 'canonical-rock',
      }));
      ownerKeys.push(ownerKey);
      ownerBoundaries.push(Object.freeze({
        ownerKey,
        chunkX,
        chunkZ,
        minimumX: chunkX * 16,
        minimumZ: chunkZ * 16,
        maximumExclusiveX: (chunkX + 1) * 16,
        maximumExclusiveZ: (chunkZ + 1) * 16,
        treeOffset,
        treeCount: 1,
        rockOffset,
        rockCount: 1,
      }));
    }
  }
  return Object.freeze({
    schemaVersion: 'w8-canonical-tree-cell-5',
    identity: Object.freeze({ worldSeedHash }),
    contentHash: `sha256:batch:${macroX},${macroZ}`,
    key: `${macroX},${macroZ}`,
    macroX,
    macroZ,
    ownerKeys: Object.freeze(ownerKeys),
    ownerBoundaries: Object.freeze(ownerBoundaries),
    trees: Object.freeze(trees),
    naturalPresence: Object.freeze({
      schemaVersion: 'w8-canonical-natural-presence-4',
      rocks: Object.freeze(rocks),
    }),
  });
}

test('sandbox canonical Tree request is one coarse 64 m coordinator operation', async () => {
  const batch = createBatch();
  let scheduled = null;
  let transported = null;
  let published = null;
  const coordinator = {
    schedule(options) {
      scheduled = options;
      const envelope = Object.freeze({
        requestId: 41,
        ownerKey: options.ownerKey,
        resourceKind: options.resourceKind,
        operationKind: options.operationKind,
        representationClass: options.representationClass,
      });
      return Object.freeze({
        promise: Promise.resolve().then(() => options.execute({
          cancelled: false,
          envelope,
        })),
      });
    },
  };
  const transport = {
    generateCanonicalTreeCell(request) {
      transported = request;
      return Promise.resolve(batch);
    },
  };
  const result = await requestCanonicalTreeCellThroughOwnerCoordinator({
    macroX: 2,
    macroZ: -1,
    coordinator,
    transport,
    ownerViewBroker: { publishBatch(value) { published = value; } },
    clock: () => 125,
    telemetryCorrelationId: 'tree-cell-correlation',
  });

  assert.equal(result, batch);
  assert.equal(published, batch);
  assert.equal(scheduled.ownerKey, '2,-1');
  assert.equal(scheduled.resourceKind, 'canonical-tree-cell');
  assert.equal(scheduled.operationKind, 'canonical-tree-cell');
  assert.equal(scheduled.priority, CHUNK_DATA_PRIORITY.DISTANT_OWNER);
  assert.equal(scheduled.priorityClass, WORLD_GENERATION_PRIORITY_CLASS.COARSE_EXISTENCE);
  assert.equal(scheduled.representationClass, WORLD_GENERATION_REPRESENTATION_CLASS.COARSE);
  assert.equal(scheduled.required, true);
  assert.equal(transported.macroX, 2);
  assert.equal(transported.macroZ, -1);
  assert.equal(transported.scheduler.ownerKey, '2,-1');
  assert.equal(transported.scheduler.resourceKind, 'canonical-tree-cell');
});

test('direct Tree batch fans out to real per-owner metadata without PresentationOwner generation', async () => {
  const batch = createBatch();
  const broker = createCanonicalTreeOwnerViewBroker({ worldSeedHash, readyCapacity: 32 });
  const firstPending = broker.requestOwner({ ownerKey: batch.ownerKeys[0] });
  const cancelled = broker.requestOwner({ ownerKey: batch.ownerKeys[1] });
  assert.equal(cancelled.cancel(), true);

  const invalidSyntheticPresence = Object.freeze({
    ...batch,
    naturalPresence: Object.freeze({
      ...batch.naturalPresence,
      grassPatches: Object.freeze([]),
    }),
  });
  assert.throws(() => broker.publishBatch(invalidSyntheticPresence),
    /invalid canonical Tree owner-view batch/,
    'the current Macro schema must fail closed if a forbidden Far-only field is reintroduced');

  const invalidBushPresence = Object.freeze({
    ...batch,
    naturalPresence: Object.freeze({
      ...batch.naturalPresence,
      shrubs: Object.freeze([]),
    }),
  });
  assert.throws(() => broker.publishBatch(invalidBushPresence),
    /invalid canonical Tree owner-view batch/,
    'Bush is Near-only decoration and cannot be reintroduced into Macro Natural');

  assert.equal(broker.publishBatch(batch), 16);
  const first = await firstPending.promise;
  assert.equal(await cancelled.promise, null);
  assert.equal(first.schemaVersion, 'w8-direct-canonical-natural-owner-view-4');
  assert.equal(first.diagnostics.presentationOwnerGenerated, false);
  assert.deepEqual(first.resource.natural.map(record => record.stableId).sort(), [
    `rock:${batch.ownerKeys[0]}`,
    `tree:${batch.ownerKeys[0]}`,
  ]);
  assert.equal(first.diagnostics.canonicalTreeCount, 1);
  assert.equal(first.diagnostics.coarseShrubCount, 0);
  assert.equal(first.diagnostics.canonicalRockCount, 1);
  assert.deepEqual(first.resource.structures, []);
  assert.equal(validatePresentationOwnerResource(first.resource).valid, true);
  const summary = derivePresentationOwnerCoarseSummary(first);
  assert.equal(summary.ownerKey, batch.ownerKeys[0]);
  assert.deepEqual(summary.selectedForestStableIds, [`tree:${batch.ownerKeys[0]}`]);

  const cached = await broker.requestOwner({ ownerKey: batch.ownerKeys[0] }).promise;
  assert.equal(cached, first);
  assert.deepEqual(broker.snapshot(), {
    schemaVersion: 'w8-direct-canonical-tree-owner-view-broker-1',
    disposed: false,
    readyCapacity: 32,
    readyOwnerCount: 16,
    pendingOwnerCount: 0,
    pendingSubscriberCount: 0,
    publishedBatchCount: 1,
    publishedOwnerCount: 16,
    cacheHitCount: 1,
    cancelledSubscriberCount: 1,
  });
  assert.equal(broker.dispose(), true);
});

test('production sandbox wires direct Tree supply and keeps non-Tree canonical reads on the existing path', () => {
  const source = readFileSync(
    resolve(repoRoot, 'src/infinite-world/sandbox-boot.js'),
    'utf8',
  );
  assert.match(source, /generateCanonicalTreeCell:\s*request\s*=>\s*\n\s*workerTransport\.generateCanonicalTreeCell\(request\)/);
  assert.match(source, /generateCanonicalTreeCell:\s*directCanonicalTreeSupplyActive[\s\S]{0,1600}?requestCanonicalTreeCellThroughOwnerCoordinator\(/);
  assert.match(source, /directCanonicalTreeSupplyActive[\s\S]{0,500}?canonicalTreeOwnerViewBroker\.requestOwner\(\{ ownerKey \}\)/);
  assert.match(source, /const staticNaturalKinds = Object\.freeze\(\[\s*W8_VEGETATION_LOD_KINDS\.TREE,\s*W8_VEGETATION_LOD_KINDS\.ROCK,\s*\]\);/,
    'persistent Natural planning must exclude Near-only Bush and currently-unsupplied Grass');
  assert.match(source, /naturalStaticStreamSuspended \|\| directCanonicalTreeSupplyActive\) return fallback\(\)/);
  assert.doesNotMatch(source, /canonicalTreeOwnerViewBroker\.requestOwner[\s\S]{0,300}?generatePresentationOwner/);
});
