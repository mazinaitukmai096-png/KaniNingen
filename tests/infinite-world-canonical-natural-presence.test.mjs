import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from 'node:v8';

import {
  W8_CANONICAL_NATURAL_PRESENCE_SCHEMA,
  W8_CANONICAL_TREE_CELL_SCHEMA,
  createPresentationOwnerGenerator,
  expandPresentationNaturalRecord,
} from '../src/infinite-world/presentation-owner-generator.js';

const WORLD_SEED = 'KaniNingen Infinite Natural World';

const allPresenceRecords = cell => [
  ...cell.naturalPresence.rocks,
];

const ownerRecords = (cell, boundary) => ({
  trees: cell.trees.slice(boundary.treeOffset, boundary.treeOffset + boundary.treeCount),
  rocks: cell.naturalPresence.rocks.slice(
    boundary.rockOffset,
    boundary.rockOffset + boundary.rockCount,
  ),
});

test('canonical 64 m Tree batch carries only bounded real canonical Rock presence', async () => {
  const generator = await createPresentationOwnerGenerator({ worldSeed: WORLD_SEED });
  const cell = await generator.generateCanonicalTreeCell(1, 0);

  assert.equal(cell.schemaVersion, W8_CANONICAL_TREE_CELL_SCHEMA);
  assert.match(cell.identity.sourceRevision, /decorative-bush-only-1:canonical-rock-presence-5$/);
  assert.equal(cell.naturalPresence.schemaVersion, W8_CANONICAL_NATURAL_PRESENCE_SCHEMA);
  assert.equal(cell.ownerKeys.length, 16);
  assert.equal(cell.ownerBoundaries.length, 16);
  assert.ok(cell.naturalPresence.rocks.length <= 16 * 4);
  assert.equal(Object.hasOwn(cell.naturalPresence, 'shrubs'), false,
    'Bush is Near-only decoration and is forbidden from Macro Natural presence');
  assert.equal(Object.hasOwn(cell.naturalPresence, 'grassPatches'), false,
    'Far-only synthetic Grass objects are forbidden from Macro Natural presence');
  assert.equal(Object.hasOwn(cell.naturalPresence, 'rockProxies'), false,
    'Far-only synthetic Rock proxy objects are forbidden from Macro Natural presence');
  assert.equal(cell.diagnostics.rockGenerationSkippedOwnerCount, 0);
  assert.ok(cell.diagnostics.rockCandidateCount >= cell.naturalPresence.rocks.length);

  const all = [...cell.trees, ...allPresenceRecords(cell)];
  assert.equal(new Set(all.map(record => record.stableId)).size, all.length);
  for (const boundary of cell.ownerBoundaries) {
    assert.equal(Object.hasOwn(boundary, 'shrubOffset'), false);
    assert.equal(Object.hasOwn(boundary, 'shrubCount'), false);
    assert.equal(Object.hasOwn(boundary, 'grassPatchOffset'), false);
    assert.equal(Object.hasOwn(boundary, 'rockProxyOffset'), false);
    const records = ownerRecords(cell, boundary);
    assert.ok([...records.trees, ...records.rocks]
      .every(record => record.owner === boundary.ownerKey));
  }

  for (const record of allPresenceRecords(cell)) {
    const expanded = expandPresentationNaturalRecord(record);
    assert.equal(expanded.stableId, record.stableId);
    assert.ok(Number.isFinite(expanded.worldPosition.y));
    assert.equal(record.objectType, 'rock');
    assert.ok(record.stableId.startsWith('detail-v1:rock:'),
      'Far Rock must retain the normal canonical Rock identity');
    assert.equal(expanded.coarsePresenceKind, 'canonical-rock');
    assert.equal(record.coarsePresenceKind, 'canonical-rock');
  }
  assert.ok(serialize(cell).byteLength < 96 * 1024);
});

test('canonical Rock presence is deterministic and is a subset of the normal owner identities', async () => {
  const generator = await createPresentationOwnerGenerator({ worldSeed: WORLD_SEED });
  const first = await generator.generateCanonicalTreeCell(-3, -3);
  const second = await generator.generateCanonicalTreeCell(-3, -3);

  assert.equal(first.contentHash, second.contentHash);
  assert.deepEqual(first.naturalPresence, second.naturalPresence);
  assert.equal(first.diagnostics.rockGenerationSkippedOwnerCount, 0);
  assert.equal(second.diagnostics.rockGenerationSkippedOwnerCount, 0);

  const boundaries = first.ownerBoundaries.filter(value => value.rockCount > 0);
  assert.ok(boundaries.some(value => value.rockCount > 0),
    'fixture must expose at least one canonical Rock');

  for (const boundary of boundaries) {
    const owner = await generator.generateOwner(boundary.chunkX, boundary.chunkZ);
    const byStableId = new Map(owner.resource.natural.map(record => [record.stableId, record]));
    assert.equal(owner.resource.natural.some(record => record.objectType === 'shrub'), false,
      'formal Shrub proposals must not become published Natural objects');
    for (const compact of ownerRecords(first, boundary).rocks) {
      const normal = byStableId.get(compact.stableId);
      assert.ok(normal, `normal owner must contain ${compact.stableId}`);
      assert.deepEqual(normal.position, compact.position,
        'Far and Near use the same canonical world position');
      assert.equal(normal.objectType, compact.objectType);
      assert.equal(normal.subtype, compact.subtype);
    }
  }
});
