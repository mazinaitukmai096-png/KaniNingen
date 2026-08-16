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
  for (let offsetZ = 0; offsetZ < 4; offsetZ += 1) {
    for (let offsetX = 0; offsetX < 4; offsetX += 1) {
      const chunkX = macroX * 4 + offsetX;
      const chunkZ = macroZ * 4 + offsetZ;
      const ownerKey = `${chunkX},${chunkZ}`;
      const treeOffset = trees.length;
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
      }));
    }
  }
  return Object.freeze({
    schemaVersion: 'w8-canonical-tree-cell-1',
    identity: Object.freeze({ worldSeedHash }),
    contentHash: `sha256:batch:${macroX},${macroZ}`,
    key: `${macroX},${macroZ}`,
    macroX,
    macroZ,
    ownerKeys: Object.freeze(ownerKeys),
    ownerBoundaries: Object.freeze(ownerBoundaries),
    trees: Object.freeze(trees),
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

  assert.equal(broker.publishBatch(batch), 16);
  const first = await firstPending.promise;
  assert.equal(await cancelled.promise, null);
  assert.equal(first.schemaVersion, 'w8-direct-canonical-tree-owner-view-1');
  assert.equal(first.diagnostics.presentationOwnerGenerated, false);
  assert.deepEqual(first.resource.natural.map(tree => tree.stableId), [
    `tree:${batch.ownerKeys[0]}`,
  ]);
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
  assert.match(source, /naturalStaticStreamSuspended \|\| directCanonicalTreeSupplyActive\) return fallback\(\)/);
  assert.doesNotMatch(source, /canonicalTreeOwnerViewBroker\.requestOwner[\s\S]{0,300}?generatePresentationOwner/);
});
