import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ChunkRuntimeManager } from '../src/infinite-world/chunk-runtime-manager.js';
import {
  createFormalNaturalChunkGenerator,
  validateW3FormalChunkData,
} from '../src/infinite-world/formal-natural-chunk-generator.js';
import { vegetationBoundsOverlap } from '../src/infinite-world/legacy-core/g6/rock-redistribution.js';
import { createNaturalChunkGenerator } from '../src/infinite-world/natural-chunk-generator.js';
import { PersistentChunkIndex } from '../src/infinite-world/persistent-chunk-index.js';
import { ChunkRenderAdapter } from '../src/infinite-world/render/chunk-render-adapter.js';
import { verifyOptionalLegacySource } from './infinite-world-provenance-helper.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

test('W3 Legacy formal-detail dependencies match the fixed source commit byte-for-byte', () => {
  const provenance = JSON.parse(readFileSync(
    resolve(repoRoot, 'src/infinite-world/legacy-core/W3-PROVENANCE.json'),
    'utf8',
  ));
  assert.equal(provenance.sourceCommit, '4210c069314a084b528d97e3d5a5e1345d38ad94');
  assert.equal(provenance.importsAdjusted, false);
  assert.equal(provenance.files.length, 7);
  for (const file of provenance.files) {
    const bytes = execFileSync('git', ['show', `HEAD:${file.destination}`], {
      cwd: repoRoot,
      encoding: null,
    });
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(execFileSync('git', ['rev-parse', `HEAD:${file.destination}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim(), file.gitBlob);
    verifyOptionalLegacySource({ provenance, file, repoRoot });
  }
});

test('W3 formal ChunkData is deterministic in isolated, reverse, and parallel order', async () => {
  const coordinates = [[0, 0], [1, -1], [-3, 5], [17, -11]];
  const isolated = [];
  for (const [x, z] of coordinates) {
    const generator = await createFormalNaturalChunkGenerator({ worldSeed: 'W3 deterministic order' });
    isolated.push(await generator.generateChunk(x, z));
  }
  const reverseGenerator = await createFormalNaturalChunkGenerator({ worldSeed: 'W3 deterministic order' });
  const reverse = [];
  for (const [x, z] of [...coordinates].reverse()) reverse.push(await reverseGenerator.generateChunk(x, z));
  reverse.reverse();
  const parallelGenerator = await createFormalNaturalChunkGenerator({ worldSeed: 'W3 deterministic order' });
  const parallel = await Promise.all(coordinates.map(([x, z]) => parallelGenerator.generateChunk(x, z)));
  assert.deepEqual(reverse, isolated);
  assert.deepEqual(parallel, isolated);
  for (const chunk of isolated) assert.equal(validateW3FormalChunkData(chunk).valid, true);
});

test('W3 Chunk IDs, content hashes, counts, and first formal Stable IDs have fixed goldens', async () => {
  const generator = await createFormalNaturalChunkGenerator({ worldSeed: 'W3 formal golden' });
  const vectors = [
    {
      coordinate: [0, 0],
      chunkId: 'chunk-v1:300:0ddef8e7d5e91010ef4139e7e0512578d450a964b40137c436036f3adf4e0870:0:0',
      contentHash: 'sha256:e8c18784609b9d5d226354c936994dec8aa8502256c49404a89f0a44567eb22f',
      vegetationCount: 11,
      rockCount: 0,
      firstVegetationId: 'detail-v1:vegetation:01c40cd4a8202ca5b7a4fba5',
      firstRockId: undefined,
    },
    {
      coordinate: [1, -1],
      chunkId: 'chunk-v1:300:0ddef8e7d5e91010ef4139e7e0512578d450a964b40137c436036f3adf4e0870:1:-1',
      contentHash: 'sha256:223a9fc80cec0ee261811b333ef0c08a0a4aa3b2c20a1a8c690c68da58ae20f2',
      vegetationCount: 22,
      rockCount: 3,
      firstVegetationId: 'detail-v1:vegetation:00655629cd78a7502d7f8b3f',
      firstRockId: 'detail-v1:rock:082debece84f2ca7c782afbb',
    },
  ];
  for (const vector of vectors) {
    const chunk = await generator.generateChunk(...vector.coordinate);
    assert.equal(chunk.chunkId, vector.chunkId);
    assert.equal(chunk.contentHash, vector.contentHash);
    assert.equal(chunk.vegetationCandidates.length, vector.vegetationCount);
    assert.equal(chunk.rockCandidates.length, vector.rockCount);
    assert.equal(chunk.vegetationCandidates[0]?.candidateId, vector.firstVegetationId);
    assert.equal(chunk.rockCandidates[0]?.candidateId, vector.firstRockId);
  }
});

test('W3 preserves W2 terrain/Biome/edge content and owns formal candidates once at boundaries', async () => {
  const seed = 'W3 boundary and W2 preservation';
  const w2 = await createNaturalChunkGenerator({ worldSeed: seed });
  const w3 = await createFormalNaturalChunkGenerator({ worldSeed: seed });
  const coordinates = [[0, 0], [1, 0], [0, 1], [-1, 0]];
  const allIds = new Set();
  for (const [x, z] of coordinates) {
    const [natural, formal] = await Promise.all([w2.generateChunk(x, z), w3.generateChunk(x, z)]);
    assert.deepEqual(formal.terrain, natural.terrain);
    assert.deepEqual(formal.biomeField, natural.biomeField);
    assert.deepEqual(formal.edgeData, natural.edgeData);
    assert.equal(formal.generationProof.sourceW2ContentHash, natural.contentHash);
    assert.equal(formal.generationProof.settlementConnected, false);
    assert.equal(formal.generationProof.gameplayConnected, false);
    for (const candidate of [...formal.vegetationCandidates, ...formal.rockCandidates]) {
      assert.deepEqual(candidate.owningChunkCoordinate, { x, z });
      assert.equal(allIds.has(candidate.candidateId), false, candidate.candidateId);
      allIds.add(candidate.candidateId);
    }
    for (const rock of formal.rockCandidates) {
      assert.equal(vegetationBoundsOverlap(
        rock.worldPosition,
        rock.metadata.candidateRadiusMeters,
        formal.vegetationCandidates,
      ), false);
    }
  }
});

test('persistent Chunk index detects content changes and Stable ID collisions', async () => {
  const generator = await createFormalNaturalChunkGenerator({ worldSeed: 'W3 index integrity' });
  const chunk = await generator.generateChunk(0, 0);
  const index = new PersistentChunkIndex({ capacity: 30 });
  const first = index.registerChunk(chunk);
  assert.equal(index.getChunk(0, 0), first);
  index.registerChunk(structuredClone(chunk));
  assert.equal(index.snapshot().counts.revisited, 1);
  const changed = structuredClone(chunk);
  changed.contentHash = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => index.registerChunk(changed), /mismatch on revisit/);
  const collision = structuredClone(chunk);
  collision.chunkX = 100;
  collision.chunkZ = -100;
  collision.chunkId = `${chunk.chunkId}:collision-test`;
  collision.contentHash = `sha256:${'1'.repeat(64)}`;
  collision.vegetationCandidates = collision.vegetationCandidates.slice(0, 1);
  collision.rockCandidates = [];
  assert.throws(() => index.registerChunk(collision), /Stable ID collision/);
});

class RecordingAdapter {
  constructor() { this.loaded = new Map(); }
  async rebase() {}
  async projectChunk(data) { return { key: `${data.chunkX},${data.chunkZ}`, data }; }
  async loadProjected(projected) { this.loaded.set(projected.key, projected); }
  async unloadChunk(key) { assert.equal(this.loaded.delete(key), true); }
  async shutdown() { this.loaded.clear(); }
}

test('W3 streaming retains the Chunk index across cache eviction/revisit without active-set growth', async t => {
  const formalGenerator = await createFormalNaturalChunkGenerator({ worldSeed: 'W3 sustained streaming' });
  const generationDurations = [];
  const generator = Object.freeze({
    ...formalGenerator,
    async generateChunk(chunkX, chunkZ) {
      const startedAt = performance.now();
      try {
        return await formalGenerator.generateChunk(chunkX, chunkZ);
      } finally {
        generationDurations.push(performance.now() - startedAt);
      }
    },
  });
  const chunkIndex = new PersistentChunkIndex({ capacity: 128 });
  const adapter = new RecordingAdapter();
  const runtime = new ChunkRuntimeManager({
    generator,
    renderAdapter: adapter,
    cacheCapacity: 30,
    chunkIndex,
  });
  await runtime.initialize(0, 0);
  for (let x = 1; x <= 8; x += 1) {
    await runtime.transitionToChunk(x, x % 2);
    const state = runtime.snapshot();
    assert.equal(state.activeDataCount, 25);
    assert.equal(state.renderedCount, 9);
    assert.equal(state.cacheSize, 30);
    assert.equal(adapter.loaded.size, 9);
  }
  assert.ok(runtime.snapshot().counts.dataEvicted > 0);
  const indexedOrigin = chunkIndex.getChunk(0, 0);
  assert.ok(indexedOrigin);
  await runtime.transitionToChunk(0, 0);
  const state = runtime.snapshot();
  assert.ok(state.chunkIndex.counts.revisited > 0);
  assert.equal(chunkIndex.getChunk(0, 0).contentHash, indexedOrigin.contentHash);
  const generationP95 = percentile(generationDurations, 0.95);
  t.diagnostic(`actual generation p95 ${generationP95.toFixed(3)}ms; request latency p95 ${state.performance.generation.p95.toFixed(3)}ms`);
  assert.ok(generationP95 < 250, `actual generation p95 ${generationP95}ms`);
  assert.ok(state.performance.crossing.p95 < 1000, `crossing p95 ${state.performance.crossing.p95}ms`);
  await runtime.shutdown();
  assert.equal(adapter.loaded.size, 0);
  assert.ok(chunkIndex.getChunk(0, 0), 'external persistent index must survive runtime shutdown');
});

class Triple {
  constructor() { this.set(0, 0, 0); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class NodeObject {
  constructor() { this.children = []; this.position = new Triple(); this.rotation = new Triple(); this.scale = new Triple().set(1, 1, 1); this.userData = {}; this.matrix = {}; }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) { this.children = this.children.filter(value => value !== child); child.parent = null; }
  clear() { this.children = []; }
  updateMatrix() { this.matrix = { position: { ...this.position }, scale: { ...this.scale } }; }
}
class Group extends NodeObject {}
class Scene extends Group {}
class Geometry {
  constructor() { this.disposed = false; this.attributes = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  setIndex(index) { this.index = index; }
  computeVertexNormals() {}
  dispose() { this.disposed = true; }
}
class PlaneGeometry extends Geometry {}
class ConeGeometry extends Geometry {}
class DodecahedronGeometry extends Geometry {}
class BufferGeometry extends Geometry {}
class Float32BufferAttribute { constructor(values, size) { this.values = values; this.size = size; } }
class Material { constructor(options) { this.options = options; } dispose() { this.disposed = true; } }
class MeshLambertMaterial extends Material {}
class LineBasicMaterial extends Material {}
class Mesh extends NodeObject { constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; } }
class InstancedMesh extends Mesh {
  constructor(geometry, material, capacity) { super(geometry, material); this.capacity = capacity; this.instanceMatrix = {}; this.matrices = []; }
  setMatrixAt(index, matrix) { this.matrices[index] = structuredClone(matrix); }
}
class LineSegments extends Mesh {}
class Object3D extends NodeObject {}
const FakeThree = { Group, PlaneGeometry, ConeGeometry, DodecahedronGeometry, BufferGeometry, Float32BufferAttribute, MeshLambertMaterial, LineBasicMaterial, Mesh, InstancedMesh, LineSegments, Object3D };

test('renderer consumes formal candidates at terrain height and releases all Chunk-owned geometry', async () => {
  const generator = await createFormalNaturalChunkGenerator({ worldSeed: 'W3 formal rendering' });
  const chunk = await generator.generateChunk(1, -1);
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const projected = await adapter.projectChunk(chunk);
  const treeMeshes = projected.group.children.filter(child => child.name.startsWith('production-vegetation-'));
  const rockMeshes = projected.group.children.filter(child => child.name.startsWith('production-rock-'));
  assert.ok(treeMeshes.reduce((sum, mesh) => sum + mesh.count, 0) >= chunk.vegetationCandidates.length);
  assert.ok(rockMeshes.reduce((sum, mesh) => sum + mesh.count, 0) >= chunk.rockCandidates.length);
  assert.ok(chunk.vegetationCandidates.every(candidate => adapter.featureInstances.has(candidate.candidateId)));
  assert.ok(chunk.rockCandidates.every(candidate => adapter.featureInstances.has(candidate.candidateId)));
  if (chunk.vegetationCandidates.length) {
    const entry = adapter.featureInstances.get(chunk.vegetationCandidates[0].candidateId);
    assert.ok(entry.parts[0].mesh.matrices[entry.parts[0].index].position.y > 0);
  }
  await adapter.loadProjected(projected);
  assert.equal(adapter.resourceSnapshot().liveChunkOwnedGeometryCount, 1);
  await adapter.unloadChunk(projected.key);
  assert.equal(adapter.resourceSnapshot().liveChunkOwnedGeometryCount, 0);
  await adapter.shutdown();
  assert.equal(adapter.resourceSnapshot().sharedDisposed, true);
});

test('formal-detail render streaming keeps Scene and GPU-owned resource counts bounded', async () => {
  const generator = await createFormalNaturalChunkGenerator({ worldSeed: 'W3 renderer sustained streaming' });
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 40 });
  await runtime.initialize(0, 0);
  for (let x = 1; x <= 8; x += 1) {
    await runtime.transitionToChunk(x, x % 2);
    const resources = adapter.resourceSnapshot();
    assert.equal(resources.liveChunkGroups, 9);
    assert.equal(resources.liveChunkOwnedGeometryCount, 9);
    assert.equal(resources.chunkOwnedGeometriesCreated - resources.chunkOwnedGeometriesDisposed, 9);
  }
  await runtime.shutdown();
  const resources = adapter.resourceSnapshot();
  assert.equal(resources.liveChunkGroups, 0);
  assert.equal(resources.liveChunkOwnedGeometryCount, 0);
  assert.equal(resources.chunkOwnedGeometriesCreated, resources.chunkOwnedGeometriesDisposed);
});

test('W3 production sources connect neither Settlement nor Gameplay', () => {
  const sources = [
    'src/infinite-world/formal-natural-chunk-generator.js',
    'src/infinite-world/persistent-chunk-index.js',
  ].map(path => readFileSync(resolve(repoRoot, path), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /(?:road-town-structure|building-frontage|building-lot|capital-civic|civic-space|src\/game)/i);
  assert.doesNotMatch(sources, /\b(?:THREE|document|window|WebGL|HTMLElement)\b/);
});
