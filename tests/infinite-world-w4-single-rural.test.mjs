import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ChunkRuntimeManager } from '../src/infinite-world/chunk-runtime-manager.js';
import { createFormalNaturalChunkGenerator } from '../src/infinite-world/formal-natural-chunk-generator.js';
import { PersistentChunkIndex } from '../src/infinite-world/persistent-chunk-index.js';
import { ChunkRenderAdapter } from '../src/infinite-world/render/chunk-render-adapter.js';
import {
  createSingleRuralChunkGenerator,
  hashW4ChunkContent,
  validateW4SingleRuralChunkData,
} from '../src/infinite-world/single-rural-chunk-generator.js';
import {
  FINITE_WORLD_UNITS_PER_METER,
  W4_SINGLE_RURAL,
} from '../src/infinite-world/single-rural-settlement.js';

const repoRoot = resolve(import.meta.dirname, '..');

test('W4 migrates the finite scale and exactly one current RURAL topology contract', async () => {
  const generator = await createSingleRuralChunkGenerator({ worldSeed: 'W4 scale contract' });
  const settlement = generator.settlement;
  assert.equal(FINITE_WORLD_UNITS_PER_METER, 40);
  assert.equal(W4_SINGLE_RURAL.sourceHumanHeightUnits
    * W4_SINGLE_RURAL.productionHumanVisualScale / FINITE_WORLD_UNITS_PER_METER, 1.75);
  assert.equal(settlement.scaleContract.productionHumanHeightMeters, 1.75);
  assert.equal(settlement.settlementType, 'RURAL');
  assert.equal(settlement.townType, 'residential');
  assert.equal(settlement.roads.length, 25);
  assert.equal(settlement.roadSummary.localRouteCount, 4);
  assert.equal(settlement.roadSummary.localSegmentCount, 16);
  assert.equal(settlement.roadSummary.alleyRouteCount, 3);
  assert.equal(settlement.roadSummary.alleySegmentCount, 9);
  assert.equal(settlement.roadSummary.junctionCount, 6);
  assert.equal(settlement.roadSummary.omittedRouteCount, 0);
  assert.equal(settlement.roads.find(road => road.roadKind === 'LOCAL').widthMeters, 1.375);
  assert.ok(settlement.buildings.length > 0);
  assert.equal(settlement.requestedBuildingCount, 106);
  assert.equal(settlement.buildings.length + settlement.buildingShortageCount, 106);
  assert.ok(settlement.buildings.every(building => (
    ['house', 'tower', 'school', 'church'].includes(building.buildingType)
    && building.lot.lotStatus === 'ACTIVE'
  )));
});

test('W4 ChunkData is deterministic in isolated, reverse, and parallel order', async () => {
  const coordinates = [[0, 0], [1, 0], [-1, -1], [10, 10]];
  const isolated = [];
  for (const [x, z] of coordinates) {
    const generator = await createSingleRuralChunkGenerator({ worldSeed: 'W4 deterministic order' });
    isolated.push(await generator.generateChunk(x, z));
  }
  const reverseGenerator = await createSingleRuralChunkGenerator({ worldSeed: 'W4 deterministic order' });
  const reverse = [];
  for (const [x, z] of [...coordinates].reverse()) reverse.push(await reverseGenerator.generateChunk(x, z));
  reverse.reverse();
  const parallelGenerator = await createSingleRuralChunkGenerator({ worldSeed: 'W4 deterministic order' });
  const parallel = await Promise.all(coordinates.map(([x, z]) => parallelGenerator.generateChunk(x, z)));
  assert.deepEqual(reverse, isolated);
  assert.deepEqual(parallel, isolated);
  for (const chunk of isolated) {
    assert.equal(validateW4SingleRuralChunkData(chunk).valid, true);
    const { contentHash, ...content } = chunk;
    assert.equal(contentHash, await hashW4ChunkContent(content));
  }
});

test('W4 Settlement identity and Chunk content have fixed golden vectors', async () => {
  const generator = await createSingleRuralChunkGenerator({ worldSeed: 'W4 single rural golden' });
  assert.deepEqual({
    settlementId: generator.settlement.settlementId,
    roads: generator.settlement.roads.length,
    buildings: generator.settlement.buildings.length,
    firstRoad: generator.settlement.roads[0].stableId,
    firstBuilding: generator.settlement.buildings[0].stableId,
  }, {
    settlementId: 'settlement-v1:048841a6f5d8412262e596ea',
    roads: 25,
    buildings: 8,
    firstRoad: 'settlement-road-v1:17da7790ff486322a1c7f597',
    firstBuilding: 'settlement-building-v1:250f481b7d24fdc151d09acc',
  });
  const vectors = [
    [0, 0, 'chunk-v1:400:d23443c6446e2d4b9a92a76de8ffa2861a60cce31edac66b51bd36f4e5bb8ce2:0:0', 'sha256:514657b22e2bbb5131da18a48dc879d1fd16fe697389146d8588c7327e647c1f', 5],
    [1, 0, 'chunk-v1:400:d23443c6446e2d4b9a92a76de8ffa2861a60cce31edac66b51bd36f4e5bb8ce2:1:0', 'sha256:9468faf754d5fe9620147bb6bdb866663a8731fc5c86bfcc2769ca744a0532c2', 13],
  ];
  for (const [x, z, chunkId, contentHash, featureCount] of vectors) {
    const chunk = await generator.generateChunk(x, z);
    assert.equal(chunk.chunkId, chunkId);
    assert.equal(chunk.contentHash, contentHash);
    assert.equal(chunk.settlementFeatures.length, featureCount);
  }
});

test('W4 projects roads continuously across Chunk boundaries and owns every feature ID once', async () => {
  const generator = await createSingleRuralChunkGenerator({ worldSeed: 'W4 projected boundaries' });
  const chunks = [];
  for (let z = -4; z <= 4; z += 1) {
    for (let x = -4; x <= 4; x += 1) chunks.push(await generator.generateChunk(x, z));
  }
  const projectionIds = new Set();
  const roadsBySource = new Map();
  for (const chunk of chunks) {
    for (const feature of chunk.settlementFeatures) {
      assert.equal(projectionIds.has(feature.stableId), false, feature.stableId);
      projectionIds.add(feature.stableId);
      assert.deepEqual(feature.owningChunkCoordinate, { x: chunk.chunkX, z: chunk.chunkZ });
      if (feature.featureType !== 'settlement-road') continue;
      if (!roadsBySource.has(feature.sourceStableId)) roadsBySource.set(feature.sourceStableId, []);
      roadsBySource.get(feature.sourceStableId).push(feature);
    }
  }
  const splitRoads = [...roadsBySource.values()].filter(projections => projections.length > 1);
  assert.ok(splitRoads.length > 0);
  for (const projections of splitRoads) {
    for (let first = 0; first < projections.length; first += 1) {
      for (let second = first + 1; second < projections.length; second += 1) {
        const a = projections[first]; const b = projections[second];
        const adjacent = Math.abs(a.owningChunkCoordinate.x - b.owningChunkCoordinate.x)
          + Math.abs(a.owningChunkCoordinate.z - b.owningChunkCoordinate.z) === 1;
        if (!adjacent) continue;
        const aPoints = [a.start, a.end].map(point => `${point.x},${point.z}`);
        const bPoints = new Set([b.start, b.end].map(point => `${point.x},${point.z}`));
        assert.ok(aPoints.some(point => bPoints.has(point)), `${a.sourceStableId} boundary mismatch`);
      }
    }
  }
});

test('W4 preserves W3 terrain and removes natural Candidates only where Settlement bounds conflict', async () => {
  const seed = 'W4 natural exclusion';
  const w3 = await createFormalNaturalChunkGenerator({ worldSeed: seed });
  const w4 = await createSingleRuralChunkGenerator({ worldSeed: seed });
  let removed = 0;
  for (let z = -2; z <= 2; z += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const [formal, settled] = await Promise.all([w3.generateChunk(x, z), w4.generateChunk(x, z)]);
      assert.deepEqual(settled.terrain, formal.terrain);
      assert.deepEqual(settled.biomeField, formal.biomeField);
      assert.deepEqual(settled.edgeData, formal.edgeData);
      assert.equal(settled.generationProof.sourceW3ContentHash, formal.contentHash);
      const formalVegetationIds = new Set(formal.vegetationCandidates.map(candidate => candidate.candidateId));
      const formalRockIds = new Set(formal.rockCandidates.map(candidate => candidate.candidateId));
      assert.ok(settled.vegetationCandidates.every(candidate => formalVegetationIds.has(candidate.candidateId)));
      assert.ok(settled.rockCandidates.every(candidate => formalRockIds.has(candidate.candidateId)));
      removed += formal.vegetationCandidates.length - settled.vegetationCandidates.length;
      removed += formal.rockCandidates.length - settled.rockCandidates.length;
    }
  }
  assert.ok(removed > 0, 'Settlement must clear conflicting formal natural Candidates');
});

class RecordingAdapter {
  constructor() { this.loaded = new Map(); this.maxLoaded = 0; }
  async rebase() {}
  async projectChunk(data) { return { key: `${data.chunkX},${data.chunkZ}`, data }; }
  async loadProjected(projected) { this.loaded.set(projected.key, projected); this.maxLoaded = Math.max(this.maxLoaded, this.loaded.size); }
  async unloadChunk(key) { assert.equal(this.loaded.delete(key), true); }
  async shutdown() { this.loaded.clear(); }
}

test('W4 runtime indexes projected Settlement features without Stable ID collisions or growth', async () => {
  const generator = await createSingleRuralChunkGenerator({ worldSeed: 'W4 indexed runtime' });
  const index = new PersistentChunkIndex({ capacity: 256 });
  const adapter = new RecordingAdapter();
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 40, chunkIndex: index });
  await runtime.initialize(0, 0);
  for (let x = 1; x <= 8; x += 1) {
    await runtime.transitionToChunk(x, x % 2);
    const state = runtime.snapshot();
    assert.equal(state.activeDataCount, 25);
    assert.equal(state.renderedCount, 9);
    assert.ok(state.cacheSize <= 40);
    assert.equal(adapter.loaded.size, 9);
  }
  const state = runtime.snapshot();
  assert.ok(state.chunkIndex.candidateCount > 0);
  assert.equal(state.chunkIndex.counts.evicted, 0);
  assert.equal(adapter.maxLoaded, 9);
  assert.ok(state.performance.generation.p95 < 250);
  assert.ok(state.performance.crossing.p95 < 1000);
  await runtime.shutdown();
  assert.equal(adapter.loaded.size, 0);
  assert.ok(index.snapshot().size > 0);
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

test('W4 renderer lazily shares Settlement resources and releases all streamed Chunk resources', async () => {
  const generator = await createSingleRuralChunkGenerator({ worldSeed: 'W4 renderer resources' });
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 40 });
  await runtime.initialize(0, 0);
  let resources = adapter.resourceSnapshot();
  assert.equal(resources.sharedGeometryCount, 6);
  assert.equal(resources.sharedMaterialCount, 7);
  assert.equal(resources.liveChunkGroups, 9);
  assert.equal(resources.liveChunkOwnedGeometryCount, 9);
  assert.ok([...adapter.loaded.values()].some(projected => (
    projected.group.children.some(child => child.name === 'w4-rural-roads')
  )));
  for (let x = 1; x <= 5; x += 1) {
    await runtime.transitionToChunk(x, 0);
    resources = adapter.resourceSnapshot();
    assert.equal(resources.liveChunkGroups, 9);
    assert.equal(resources.liveChunkOwnedGeometryCount, 9);
  }
  await runtime.shutdown();
  resources = adapter.resourceSnapshot();
  assert.equal(resources.liveChunkGroups, 0);
  assert.equal(resources.liveChunkOwnedGeometryCount, 0);
  assert.equal(resources.chunkOwnedGeometriesCreated, resources.chunkOwnedGeometriesDisposed);
  assert.equal(resources.sharedDisposed, true);
});

test('W4 production sources connect no Gameplay, TOWN, CITY, Growth, Worker, or LOD systems', () => {
  const sources = [
    'src/infinite-world/single-rural-settlement.js',
    'src/infinite-world/single-rural-chunk-generator.js',
  ].map(path => readFileSync(resolve(repoRoot, path), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /from ['"]\.\.\/game\.js|SETTLEMENT_TYPES\.(?:TOWN|CITY)|\b(?:Growth|Wanted|Threat|Nation|Worker|LOD)\b/);
  assert.doesNotMatch(sources, /Math\.random|\b(?:THREE|document|window|WebGL|HTMLElement)\b/);
});
