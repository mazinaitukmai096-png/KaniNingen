import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ChunkRuntimeManager } from '../src/infinite-world/chunk-runtime-manager.js';
import { canonicalizeJson } from '../src/infinite-world/legacy-core/g0/canonical-json.js';
import { sha256Hex } from '../src/infinite-world/legacy-core/g0/sha256.js';
import { validateTerrainEdgePair } from '../src/infinite-world/legacy-core/g2/terrain-edge.js';
import { NATURAL_BIOME_ORDER } from '../src/infinite-world/natural-biome-field.js';
import {
  createNaturalChunkGenerator,
  validateW2NaturalChunkData,
} from '../src/infinite-world/natural-chunk-generator.js';
import { ChunkRenderAdapter } from '../src/infinite-world/render/chunk-render-adapter.js';
import { createSandboxChunkGenerator } from '../src/infinite-world/sandbox-chunk-generator.js';

const repoRoot = resolve(import.meta.dirname, '..');

test('W2 Legacy Macro Terrain dependencies match fixed-commit blobs and SHA-256 provenance', () => {
  const provenance = JSON.parse(readFileSync(
    resolve(repoRoot, 'src/infinite-world/legacy-core/W2-PROVENANCE.json'),
    'utf8',
  ));
  assert.equal(provenance.sourceCommit, '4210c069314a084b528d97e3d5a5e1345d38ad94');
  assert.equal(provenance.files.length, 2);
  for (const file of provenance.files) {
    assert.equal(file.importsAdjusted, false);
    const destination = resolve(repoRoot, file.destination);
    const bytes = readFileSync(destination);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(
      execFileSync('git', ['hash-object', destination], { cwd: repoRoot, encoding: 'utf8' }).trim(),
      file.gitBlob,
    );
    assert.equal(
      execFileSync('git', ['-C', 'C:\\KaniGame(開発用)', 'rev-parse', `${provenance.sourceCommit}:${file.source}`], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim(),
      file.gitBlob,
    );
  }
});

test('W2 natural ChunkData is deterministic in isolated, reverse, and parallel order', async () => {
  const coordinates = [[0, 0], [-1, 2], [8, -5], [-23, -19]];
  const isolated = [];
  for (const [x, z] of coordinates) {
    const generator = await createNaturalChunkGenerator({ worldSeed: 'W2 deterministic order' });
    isolated.push(await generator.generateChunk(x, z));
  }
  const reverseGenerator = await createNaturalChunkGenerator({ worldSeed: 'W2 deterministic order' });
  const reverse = [];
  for (const [x, z] of [...coordinates].reverse()) reverse.push(await reverseGenerator.generateChunk(x, z));
  reverse.reverse();
  const parallelGenerator = await createNaturalChunkGenerator({ worldSeed: 'W2 deterministic order' });
  const parallel = await Promise.all(coordinates.map(([x, z]) => parallelGenerator.generateChunk(x, z)));
  assert.deepEqual(reverse, isolated);
  assert.deepEqual(parallel, isolated);
  for (const chunk of isolated) {
    assert.equal(validateW2NaturalChunkData(chunk).valid, true);
    const { contentHash, ...content } = chunk;
    assert.equal(contentHash, `sha256:${await sha256Hex(canonicalizeJson(content))}`);
  }
});

test('W2 natural Chunk IDs and content hashes have fixed golden vectors', async () => {
  const generator = await createNaturalChunkGenerator({ worldSeed: 'W2 natural golden' });
  const vectors = [
    [0, 0, 'chunk-v1:200:70281bede1f395bf3554e078ab62b3f27497c8583be73f2259326b98cdbc01f5:0:0', 'sha256:3f14c9baefe2bfba4686faef9410b32dba60f4054e36eb35f09a6541587181c4'],
    [-17, 23, 'chunk-v1:200:70281bede1f395bf3554e078ab62b3f27497c8583be73f2259326b98cdbc01f5:-17:23', 'sha256:482529bf8eb90cc1d8474103f32e45e3f981c633da0fbfe1e691b54fe3aaed46'],
  ];
  for (const [x, z, chunkId, contentHash] of vectors) {
    const chunk = await generator.generateChunk(x, z);
    assert.equal(chunk.chunkId, chunkId);
    assert.equal(chunk.contentHash, contentHash);
  }
});

function edge(values, resolution, side, stride = 1) {
  const output = [];
  const add = index => output.push(...values.slice(index * stride, index * stride + stride));
  for (let index = 0; index < resolution; index += 1) {
    if (side === 'east') add(index * resolution + resolution - 1);
    else if (side === 'west') add(index * resolution);
    else if (side === 'south') add((resolution - 1) * resolution + index);
    else add(index);
  }
  return output;
}

function biomeSampleEdge(samples, side) {
  const positions = [];
  for (let index = 0; index < 5; index += 1) {
    const offset = side === 'east' ? index * 5 + 4
      : side === 'west' ? index * 5
        : side === 'south' ? 20 + index : index;
    positions.push(samples[offset]);
  }
  return positions;
}

test('W2 terrain, slopes, materials, climate, and Biome samples match exactly at Chunk boundaries', async () => {
  const generator = await createNaturalChunkGenerator({ worldSeed: 'W2 shared boundaries' });
  const center = await generator.generateChunk(-3, 7);
  const east = await generator.generateChunk(-2, 7);
  const south = await generator.generateChunk(-3, 8);
  for (const [neighbor, a, b] of [[east, 'east', 'west'], [south, 'south', 'north']]) {
    assert.deepEqual(validateTerrainEdgePair(center.terrain, a, neighbor.terrain, b), { valid: true, errors: [] });
    assert.equal(center.edgeData[a].hash, neighbor.edgeData[b].hash);
    assert.deepEqual(edge(center.terrain.heights, 33, a), edge(neighbor.terrain.heights, 33, b));
    assert.deepEqual(edge(center.terrain.finalSlopes, 33, a), edge(neighbor.terrain.finalSlopes, 33, b));
    assert.deepEqual(edge(center.terrain.materialWeights, 33, a, 5), edge(neighbor.terrain.materialWeights, 33, b, 5));
    assert.deepEqual(edge(center.terrain.moisture, 33, a), edge(neighbor.terrain.moisture, 33, b));
    assert.deepEqual(edge(center.terrain.rockiness, 33, a), edge(neighbor.terrain.rockiness, 33, b));
    assert.deepEqual(biomeSampleEdge(center.biomeField.samples, a), biomeSampleEdge(neighbor.biomeField.samples, b));
  }
});

test('natural Biomes are continuous, normalized, and include all four formal W2 categories', async () => {
  const generator = await createNaturalChunkGenerator({ worldSeed: 'W2 biome coverage' });
  const knownCoordinates = [
    [-512, -512],
    [-256, -512],
    [-256, -384],
    [64, 192],
  ];
  const chunks = await Promise.all(knownCoordinates.map(([x, z]) => generator.generateChunk(x, z)));
  assert.deepEqual(new Set(chunks.map(chunk => chunk.biomeField.primaryBiomeId)), new Set(NATURAL_BIOME_ORDER));
  for (const chunk of chunks) {
    assert.equal(chunk.biomeField.samples.length, 25);
    assert.equal(chunk.vegetationProxies.length, 0);
    assert.equal(chunk.rockProxies.length, 0);
    assert.equal(chunk.terrain.waterBodies.length, 0);
    assert.ok(chunk.terrain.heightRangeMeters.maximum > chunk.terrain.heightRangeMeters.minimum);
    for (const sample of chunk.biomeField.samples) {
      assert.ok(NATURAL_BIOME_ORDER.includes(sample.primaryBiomeId));
      assert.ok(Math.abs(sample.memberships.reduce((sum, value) => sum + value.weight, 0) - 1) <= 0.000001);
    }
  }
});

test('W2 activation does not change W1A golden identity and connects no Settlement or Gameplay systems', async () => {
  const w1a = await createSandboxChunkGenerator({ worldSeed: 'W1A preserved through W2' });
  const before = await w1a.generateChunk(-4, 6);
  const w2 = await createNaturalChunkGenerator({ worldSeed: 'W2 independent' });
  const natural = await w2.generateChunk(-4, 6);
  const after = await w1a.generateChunk(-4, 6);
  assert.equal(after.chunkId, before.chunkId);
  assert.equal(after.contentHash, before.contentHash);
  assert.notEqual(natural.chunkId, before.chunkId);
  assert.equal(natural.generationProof.settlementConnected, false);
  assert.equal(natural.generationProof.gameplayConnected, false);
  assert.equal(natural.generationProof.formalVegetationConnected, false);
  assert.equal(natural.generationProof.formalRockConnected, false);
  const sources = [
    'src/infinite-world/natural-biome-field.js',
    'src/infinite-world/natural-chunk-generator.js',
  ].map(path => readFileSync(resolve(repoRoot, path), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /(?:road-town-structure|building-frontage|building-lot|capital-civic|civic-space|src\/game|formal-vegetation|formal-rock)/i);
  assert.doesNotMatch(sources, /\b(?:THREE|document|window|WebGL|HTMLElement)\b/);
});

class Triple {
  constructor() { this.set(0, 0, 0); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class NodeObject {
  constructor() {
    this.children = []; this.position = new Triple(); this.rotation = new Triple();
    this.scale = new Triple().set(1, 1, 1); this.userData = {}; this.matrix = {};
  }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) { this.children = this.children.filter(value => value !== child); child.parent = null; }
  clear() { this.children = []; }
  updateMatrix() { this.matrix = { x: this.position.x, y: this.position.y, z: this.position.z }; }
}
class Group extends NodeObject {}
class Scene extends Group {}
class Geometry {
  constructor() { this.disposed = false; this.attributes = {}; this.index = null; this.normalsComputed = false; }
  setAttribute(name, value) { this.attributes[name] = value; }
  setIndex(value) { this.index = value; }
  computeVertexNormals() { this.normalsComputed = true; }
  dispose() { assert.equal(this.disposed, false); this.disposed = true; }
}
class PlaneGeometry extends Geometry {}
class ConeGeometry extends Geometry {}
class DodecahedronGeometry extends Geometry {}
class BufferGeometry extends Geometry {}
class Float32BufferAttribute { constructor(values, size) { this.values = values; this.size = size; } }
class Material { constructor(options) { this.options = options; this.disposed = false; } dispose() { this.disposed = true; } }
class MeshLambertMaterial extends Material {}
class LineBasicMaterial extends Material {}
class Mesh extends NodeObject { constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; } }
class InstancedMesh extends Mesh {
  constructor(geometry, material, capacity) { super(geometry, material); this.capacity = capacity; this.instanceMatrix = {}; }
  setMatrixAt() {}
}
class LineSegments extends Mesh {}
class Object3D extends NodeObject {}
const FakeThree = {
  Group, PlaneGeometry, ConeGeometry, DodecahedronGeometry, BufferGeometry,
  Float32BufferAttribute, MeshLambertMaterial, LineBasicMaterial,
  Mesh, InstancedMesh, LineSegments, Object3D,
};

test('natural terrain projection owns and disposes only per-Chunk geometry under sustained streaming', async () => {
  const generator = await createNaturalChunkGenerator({ worldSeed: 'W2 renderer lifecycle' });
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 40 });
  await runtime.initialize(0, 0);
  let resources = adapter.resourceSnapshot();
  assert.equal(resources.liveChunkGroups, 9);
  assert.equal(resources.liveChunkOwnedGeometryCount, 9);
  assert.equal(resources.sharedGeometryCount, 4);
  assert.equal(resources.sharedMaterialCount, 5);
  for (let x = 1; x <= 12; x += 1) {
    await runtime.transitionToChunk(x, x % 2);
    resources = adapter.resourceSnapshot();
    assert.equal(resources.liveChunkGroups, 9);
    assert.equal(resources.liveChunkOwnedGeometryCount, 9);
    assert.equal(resources.chunkOwnedGeometriesCreated - resources.chunkOwnedGeometriesDisposed, 9);
  }
  await runtime.shutdown();
  resources = adapter.resourceSnapshot();
  assert.equal(resources.liveChunkGroups, 0);
  assert.equal(resources.liveChunkOwnedGeometryCount, 0);
  assert.equal(resources.chunkOwnedGeometriesCreated, resources.chunkOwnedGeometriesDisposed);
  assert.equal(resources.sharedDisposed, true);
});
