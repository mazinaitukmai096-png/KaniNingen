import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_CHUNK_SIZE,
  UNITS_PER_METER,
  chunkRenderPosition,
  createChunkKey,
  decomposeLogicalWorldPosition,
  logicalWorldToOwnedChunk,
} from '../src/infinite-world/chunk-coordinates.js';
import { canonicalizeJson } from '../src/infinite-world/legacy-core/g0/canonical-json.js';
import { sha256Hex } from '../src/infinite-world/legacy-core/g0/sha256.js';
import { validateTerrainEdgePair } from '../src/infinite-world/legacy-core/g2/terrain-edge.js';
import {
  createSandboxChunkGenerator,
  validateW1AChunkData,
} from '../src/infinite-world/sandbox-chunk-generator.js';

test('logical/render scale is explicit and West/North boundary ownership handles negative coordinates and -0', () => {
  assert.equal(LOGICAL_CHUNK_SIZE_METERS, 16);
  assert.equal(RENDER_CHUNK_SIZE, 4096);
  assert.equal(UNITS_PER_METER, 256);
  assert.equal(createChunkKey(-0, -0), '0,0');
  assert.deepEqual(logicalWorldToOwnedChunk(0, 0), { chunkX: -1, chunkZ: -1, key: '-1,-1' });
  assert.deepEqual(logicalWorldToOwnedChunk(16, 16), { chunkX: 0, chunkZ: 0, key: '0,0' });
  assert.deepEqual(logicalWorldToOwnedChunk(-16, -16), { chunkX: -2, chunkZ: -2, key: '-2,-2' });
  assert.deepEqual(logicalWorldToOwnedChunk(-15.999, 0.001), { chunkX: -1, chunkZ: 0, key: '-1,0' });
  const boundary = decomposeLogicalWorldPosition(-16, 16);
  assert.equal(boundary.logicalLocalX, 16);
  assert.equal(boundary.logicalLocalZ, 16);
  assert.deepEqual(chunkRenderPosition(1_000_000_000, -1_000_000_000, 1_000_000_000, -1_000_000_000), { x: 0, z: 0 });
});

test('W1A ChunkData is deterministic in isolated, reverse, and parallel generation order', async () => {
  const coordinates = [[0, 0], [-1, 2], [3, -4], [-8, -9]];
  const isolated = await Promise.all(coordinates.map(async ([x, z]) => {
    const generator = await createSandboxChunkGenerator({ worldSeed: 'order-independent' });
    return generator.generateChunk(x, z);
  }));
  const reverseGenerator = await createSandboxChunkGenerator({ worldSeed: 'order-independent' });
  const reverse = [];
  for (const [x, z] of [...coordinates].reverse()) reverse.push(await reverseGenerator.generateChunk(x, z));
  reverse.reverse();
  const parallelGenerator = await createSandboxChunkGenerator({ worldSeed: 'order-independent' });
  const parallel = await Promise.all(coordinates.map(([x, z]) => parallelGenerator.generateChunk(x, z)));
  assert.deepEqual(reverse, isolated);
  assert.deepEqual(parallel, isolated);
  for (const chunkData of isolated) assert.equal(validateW1AChunkData(chunkData).valid, true);
});

test('contentHash covers the canonical ChunkData content and changes with semantic identity', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'content-hash' });
  const chunk = await generator.generateChunk(-2, 5);
  const { contentHash, ...content } = chunk;
  assert.equal(contentHash, `sha256:${await sha256Hex(canonicalizeJson(content))}`);
  const neighbor = await generator.generateChunk(-1, 5);
  assert.notEqual(chunk.chunkId, neighbor.chunkId);
  assert.notEqual(chunk.contentHash, neighbor.contentHash);
});

test('flat terrain edges agree with all adjacent chunks', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'shared-edge' });
  const center = await generator.generateChunk(-3, 7);
  const east = await generator.generateChunk(-2, 7);
  const south = await generator.generateChunk(-3, 8);
  assert.deepEqual(validateTerrainEdgePair(center.terrain, 'east', east.terrain, 'west'), { valid: true, errors: [] });
  assert.deepEqual(validateTerrainEdgePair(center.terrain, 'south', south.terrain, 'north'), { valid: true, errors: [] });
  assert.equal(center.edgeData.east.hash, east.edgeData.west.hash);
  assert.equal(center.edgeData.south.hash, south.edgeData.north.hash);
});

test('sandbox proxies remain lightweight, sorted, unique, owned, and explicitly non-formal', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'proxy-audit' });
  const chunks = await Promise.all(Array.from({ length: 25 }, (_, index) => {
    const x = index % 5 - 2;
    const z = Math.floor(index / 5) - 2;
    return generator.generateChunk(x, z);
  }));
  const allIds = [];
  for (const chunk of chunks) {
    assert.equal(chunk.vegetationProxies.length, 4);
    assert.ok(chunk.rockProxies.length >= 0 && chunk.rockProxies.length <= 2);
    for (const list of [chunk.vegetationProxies, chunk.rockProxies]) {
      assert.deepEqual(list.map(proxy => proxy.stableId), [...list].map(proxy => proxy.stableId).sort());
      for (const proxy of list) {
        assert.equal(proxy.metadata.sandboxProxy, true);
        assert.equal(proxy.metadata.formalCandidate, false);
        assert.equal(proxy.metadata.ownerChunkX, chunk.chunkX);
        assert.equal(proxy.metadata.ownerChunkZ, chunk.chunkZ);
        assert.deepEqual(
          logicalWorldToOwnedChunk(proxy.logicalWorldMeters.x, proxy.logicalWorldMeters.z),
          { chunkX: chunk.chunkX, chunkZ: chunk.chunkZ, key: createChunkKey(chunk.chunkX, chunk.chunkZ) },
        );
        allIds.push(proxy.stableId);
      }
    }
  }
  assert.equal(new Set(allIds).size, allIds.length);
});
