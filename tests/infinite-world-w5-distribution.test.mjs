import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ChunkRuntimeManager } from '../src/infinite-world/chunk-runtime-manager.js';
import {
  createDistributedSettlementChunkGenerator,
  hashW5ChunkContent,
  validateW5DistributedChunkData,
} from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { createFormalNaturalChunkGenerator } from '../src/infinite-world/formal-natural-chunk-generator.js';
import { hashWorldSeed } from '../src/infinite-world/legacy-core/g0/seed.js';
import { PersistentChunkIndex } from '../src/infinite-world/persistent-chunk-index.js';
import { ChunkRenderAdapter } from '../src/infinite-world/render/chunk-render-adapter.js';
import {
  createSettlementDistributor,
  W5_SETTLEMENT_DISTRIBUTION,
} from '../src/infinite-world/settlement-distributor.js';
import { createMigratedSettlementTemplate } from '../src/infinite-world/single-rural-settlement.js';

const repoRoot = resolve(import.meta.dirname, '..');

async function distributorFor(seed) {
  const { worldSeedHash } = await hashWorldSeed(seed);
  return createSettlementDistributor({ worldSeedHash });
}

test('W5 distribution has no fixed total and deterministically yields all Settlement types', async () => {
  const first = await distributorFor('W5 distributed golden');
  const second = await distributorFor('W5 distributed golden');
  const [a, b] = await Promise.all([
    first.findInMacroRange(-10, 10, -10, 10),
    second.findInMacroRange(-10, 10, -10, 10),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.length, 247);
  assert.deepEqual(Object.fromEntries(Object.entries(Object.groupBy(a, candidate => candidate.settlementType))
    .map(([type, candidates]) => [type, candidates.length])), { TOWN: 149, RURAL: 85, CITY: 13 });
  assert.deepEqual(a[0], {
    schemaVersion: 'w5-settlement-candidate-1',
    macroRegion: { x: -9, z: -10 },
    proposalKind: 'PRIMARY',
    proposalSlot: 0,
    proposalCell: { x: -9, z: -10 },
    center: { x: -6382.448807, z: -7528.114383 },
    settlementType: 'TOWN',
    townType: 'school_town',
    radiusMeters: 94.5,
    urbanization: 0.57712,
    terrainSuitability: 0.820959,
    proposalPriority: 0.793624,
    selectionScore: 0.792158,
    minimumDistanceMeters: 394.196176,
    eligibility: { biomeAndSlope: true, regionalUrbanization: true },
    settlementId: 'settlement-v1:bf2eb64de8619688ba55cdcc',
  });
  const expanded = await first.findInMacroRange(-20, 20, -20, 20);
  assert.ok(expanded.length > a.length, 'expanding Macro Region coverage must continue adding Settlements');
  assert.equal(Object.hasOwn(W5_SETTLEMENT_DISTRIBUTION, 'settlementCount'), false);
});

test('Seed, Macro Region, minimum distance, urbanization, and terrain suitability govern every Candidate', async () => {
  const first = await distributorFor('W5 distribution rules');
  const second = await distributorFor('W5 distribution rules other seed');
  const candidates = await first.findInMacroRange(-18, 18, -18, 18);
  const otherSeed = await second.findInMacroRange(-18, 18, -18, 18);
  assert.notDeepEqual(candidates, otherSeed);
  for (const candidate of candidates) {
    assert.ok(candidate.terrainSuitability >= W5_SETTLEMENT_DISTRIBUTION.minimumTerrainSuitability);
    assert.ok(candidate.proposalPriority >= W5_SETTLEMENT_DISTRIBUTION.minimumProposalPriority);
    if (candidate.urbanization >= W5_SETTLEMENT_DISTRIBUTION.urbanizationThresholds.city) assert.equal(candidate.settlementType, 'CITY');
    else if (candidate.urbanization >= W5_SETTLEMENT_DISTRIBUTION.urbanizationThresholds.town) assert.equal(candidate.settlementType, 'TOWN');
    else assert.equal(candidate.settlementType, 'RURAL');
  }
  for (let firstIndex = 0; firstIndex < candidates.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < candidates.length; secondIndex += 1) {
      const a = candidates[firstIndex]; const b = candidates[secondIndex];
      const required = W5_SETTLEMENT_DISTRIBUTION
        .minimumDistanceMetersByTypePair[a.settlementType][b.settlementType];
      assert.ok(Math.hypot(a.center.x - b.center.x, a.center.z - b.center.z) >= required - 0.000001);
      assert.ok(Math.hypot(a.center.x - b.center.x, a.center.z - b.center.z)
        > a.radiusMeters + b.radiusMeters);
      assert.notEqual(a.settlementId, b.settlementId);
    }
  }
});

test('RURAL, TOWN, and CITY templates reuse current topology, Frontage, Lot, and scale contracts', async () => {
  const distributor = await distributorFor('W5 template types');
  const candidates = await distributor.findInMacroRange(-20, 20, -20, 20);
  const selected = ['RURAL', 'TOWN', 'CITY'].map(type => candidates.find(candidate => candidate.settlementType === type));
  assert.ok(selected.every(Boolean));
  const templates = await Promise.all(selected.map(candidate => createMigratedSettlementTemplate({ candidate })));
  for (const template of templates) {
    assert.equal(template.scaleContract.finiteWorldUnitsPerMeter, 40);
    assert.equal(template.scaleContract.productionHumanHeightMeters, 1.75);
    assert.ok(template.roads.length > 0);
    assert.ok(template.buildings.length > 0);
    assert.equal(template.buildings.length + template.buildingShortageCount, template.requestedBuildingCount);
    assert.ok(template.buildings.every(building => building.lot.lotStatus === 'ACTIVE'));
    assert.ok(template.roads.every(road => Math.hypot(
      (road.start.x + road.end.x) / 2 - template.center.x,
      (road.start.z + road.end.z) / 2 - template.center.z,
    ) <= template.influenceRadiusMeters + 0.001));
  }
  const byType = Object.fromEntries(templates.map(template => [template.settlementType, template]));
  assert.equal(byType.RURAL.roadSummary.ruralRoadSummary.localRouteCount, 4);
  assert.equal(byType.TOWN.roadSummary.roadSegmentCounts.LOCAL, 26);
  assert.equal(byType.CITY.roadSummary.capitalCivicCoreSummary.civicAccessRoadCount, 1);
  assert.equal(byType.CITY.roadSummary.capitalCivicCoreSummary.normalCoreRoadCount, 0);
});

test('W5 ChunkData is deterministic in isolated, reverse, and parallel order', async () => {
  const seed = 'W5 Chunk order';
  const probe = await createDistributedSettlementChunkGenerator({ worldSeed: seed });
  const center = [Math.floor(probe.reviewSpawn.x / 16), Math.floor(probe.reviewSpawn.z / 16)];
  const coordinates = [center, [center[0] + 1, center[1]], [0, 0], [-300, 421]];
  const isolated = [];
  for (const [x, z] of coordinates) {
    const generator = await createDistributedSettlementChunkGenerator({ worldSeed: seed });
    isolated.push(await generator.generateChunk(x, z));
  }
  const reverseGenerator = await createDistributedSettlementChunkGenerator({ worldSeed: seed });
  const reverse = [];
  for (const [x, z] of [...coordinates].reverse()) reverse.push(await reverseGenerator.generateChunk(x, z));
  reverse.reverse();
  const parallelGenerator = await createDistributedSettlementChunkGenerator({ worldSeed: seed });
  const parallel = await Promise.all(coordinates.map(([x, z]) => parallelGenerator.generateChunk(x, z)));
  assert.deepEqual(reverse, isolated);
  assert.deepEqual(parallel, isolated);
  for (const chunk of isolated) {
    assert.equal(validateW5DistributedChunkData(chunk).valid, true);
    const { contentHash, ...content } = chunk;
    assert.equal(contentHash, await hashW5ChunkContent(content));
  }
});

test('W5 review spawn and Chunk identity have fixed golden vectors', async () => {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed: 'W5 distributed golden' });
  assert.deepEqual(generator.reviewSpawn, {
    x: 393.477751,
    z: 472.059306,
    settlementId: 'settlement-v1:6dd64c62b99e2cba5c12b024',
  });
  const homeChunk = await generator.generateChunk(
    Math.floor(generator.reviewSpawn.x / 16),
    Math.floor(generator.reviewSpawn.z / 16),
  );
  assert.ok(homeChunk.settlementReferences.some(reference => (
    reference.settlementId === generator.reviewSpawn.settlementId
  )));
  // The Phase 5F distributor retains the pre-existing primary Settlement identity/content.
  const chunk = await generator.generateChunk(24, 29);
  assert.equal(chunk.chunkId, 'chunk-v1:500:f327c7698f52548d6f0b42cb879c405de0eb6c480d6742ff48ec077e304162a3:24:29');
  assert.equal(chunk.contentHash, 'sha256:ce5975036825d64069bb51b7d05d0b0aa9fddf4519fa298d6d1e5197ed56b835');
  assert.equal(chunk.settlementReferences[0].settlementId, 'settlement-v1:6dd64c62b99e2cba5c12b024');
  assert.equal(chunk.settlementReferences[0].settlementType, 'RURAL');
  assert.equal(chunk.settlementFeatures.length, 5);
  assert.equal(chunk.settlementFeatures[0].stableId, 'settlement-building-v1:0eb69096eda26365d3144a97');
  const natural = await generator.generateChunk(0, 0);
  assert.equal(natural.contentHash, 'sha256:03134f7e80bccd60115426c34d940a29efe82c9f8351fd105b2a190476905d8d');
  assert.equal(natural.settlementReferences.length, 0);
});

test('distributed road projections are boundary-continuous and Stable IDs do not collide', async () => {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed: 'W5 boundaries' });
  const centerX = Math.floor(generator.reviewSpawn.x / 16);
  const centerZ = Math.floor(generator.reviewSpawn.z / 16);
  const chunks = [];
  for (let z = centerZ - 5; z <= centerZ + 5; z += 1) {
    for (let x = centerX - 5; x <= centerX + 5; x += 1) chunks.push(await generator.generateChunk(x, z));
  }
  const projectionIds = new Set();
  const bySource = new Map();
  for (const chunk of chunks) for (const feature of chunk.settlementFeatures) {
    assert.equal(projectionIds.has(feature.stableId), false, feature.stableId);
    projectionIds.add(feature.stableId);
    if (feature.featureType !== 'settlement-road') continue;
    if (!bySource.has(feature.sourceStableId)) bySource.set(feature.sourceStableId, []);
    bySource.get(feature.sourceStableId).push(feature);
  }
  const split = [...bySource.values()].filter(projections => projections.length > 1);
  assert.ok(split.length > 0);
  for (const projections of split) {
    for (let aIndex = 0; aIndex < projections.length; aIndex += 1) {
      for (let bIndex = aIndex + 1; bIndex < projections.length; bIndex += 1) {
        const a = projections[aIndex]; const b = projections[bIndex];
        const adjacent = Math.abs(a.owningChunkCoordinate.x - b.owningChunkCoordinate.x)
          + Math.abs(a.owningChunkCoordinate.z - b.owningChunkCoordinate.z) === 1;
        if (!adjacent) continue;
        const endpoints = new Set([a.start, a.end].map(point => `${point.x},${point.z}`));
        assert.ok([b.start, b.end].some(point => endpoints.has(`${point.x},${point.z}`)));
      }
    }
  }
});

test('W5 preserves W3 natural data and filters only conflicting natural Candidates', async () => {
  const seed = 'W5 natural continuity';
  const w5 = await createDistributedSettlementChunkGenerator({ worldSeed: seed });
  const w3 = await createFormalNaturalChunkGenerator({ worldSeed: seed });
  const centerX = Math.floor(w5.reviewSpawn.x / 16);
  const centerZ = Math.floor(w5.reviewSpawn.z / 16);
  let removed = 0;
  const sampleCoordinates = [[0, 0]];
  for (let z = centerZ - 2; z <= centerZ + 2; z += 1) {
    for (let x = centerX - 2; x <= centerX + 2; x += 1) sampleCoordinates.push([x, z]);
  }
  for (const [x, z] of sampleCoordinates) {
    const [formal, distributed] = await Promise.all([w3.generateChunk(x, z), w5.generateChunk(x, z)]);
    assert.deepEqual(distributed.terrain, formal.terrain);
    assert.deepEqual(distributed.biomeField, formal.biomeField);
    assert.deepEqual(distributed.edgeData, formal.edgeData);
    assert.equal(distributed.generationProof.sourceW3ContentHash, formal.contentHash);
    const vegetationIds = new Set(formal.vegetationCandidates.map(candidate => candidate.candidateId));
    const rockIds = new Set(formal.rockCandidates.map(candidate => candidate.candidateId));
    assert.ok(distributed.vegetationCandidates.every(candidate => vegetationIds.has(candidate.candidateId)));
    assert.ok(distributed.rockCandidates.every(candidate => rockIds.has(candidate.candidateId)));
    removed += formal.vegetationCandidates.length - distributed.vegetationCandidates.length;
    removed += formal.rockCandidates.length - distributed.rockCandidates.length;
  }
  assert.ok(removed > 0);
});

class RecordingAdapter {
  constructor() { this.loaded = new Map(); this.maximum = 0; }
  async rebase() {}
  async projectChunk(data) { return { key: `${data.chunkX},${data.chunkZ}`, data }; }
  async loadProjected(projected) { this.loaded.set(projected.key, projected); this.maximum = Math.max(this.maximum, this.loaded.size); }
  async unloadChunk(key) { assert.equal(this.loaded.delete(key), true); }
  async shutdown() { this.loaded.clear(); }
}

test('W5 streaming bounds caches, Scene objects, indexes, and performance distributions', async () => {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed: 'W5 streaming' });
  const index = new PersistentChunkIndex({ capacity: 512 });
  const adapter = new RecordingAdapter();
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 40, chunkIndex: index });
  const startX = Math.floor(generator.reviewSpawn.x / 16);
  const startZ = Math.floor(generator.reviewSpawn.z / 16);
  await runtime.initialize(startX, startZ);
  for (let step = 1; step <= 12; step += 1) {
    await runtime.transitionToChunk(startX + step, startZ + step % 2);
    const state = runtime.snapshot();
    assert.equal(state.activeDataCount, 25);
    assert.equal(state.renderedCount, 9);
    assert.ok(state.cacheSize <= 40);
    assert.equal(adapter.loaded.size, 9);
  }
  const state = runtime.snapshot();
  assert.equal(adapter.maximum, 9);
  assert.ok(state.chunkIndex.candidateCount > 0);
  assert.ok(generator.snapshot().templateCacheSize <= generator.snapshot().templateCacheCapacity);
  assert.ok(generator.snapshot().distributor.rawCacheSize <= generator.snapshot().distributor.rawCacheCapacity);
  assert.ok(state.performance.generation.p95 < 300);
  assert.ok(state.performance.crossing.p95 < 1200);
  await runtime.shutdown();
  assert.equal(adapter.loaded.size, 0);
  assert.ok(index.snapshot().size > 0);
});

class Triple { constructor() { this.set(0, 0, 0); } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
class NodeObject {
  constructor() { this.children = []; this.position = new Triple(); this.rotation = new Triple(); this.scale = new Triple().set(1, 1, 1); this.userData = {}; this.matrix = {}; }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) { this.children = this.children.filter(value => value !== child); child.parent = null; }
  clear() { this.children = []; }
  updateMatrix() { this.matrix = { position: { ...this.position }, scale: { ...this.scale } }; }
}
class Group extends NodeObject {}
class Scene extends Group {}
class Geometry { constructor() { this.attributes = {}; } setAttribute(name, value) { this.attributes[name] = value; } setIndex(index) { this.index = index; } computeVertexNormals() {} dispose() { this.disposed = true; } }
class PlaneGeometry extends Geometry {}
class ConeGeometry extends Geometry {}
class DodecahedronGeometry extends Geometry {}
class BufferGeometry extends Geometry {}
class Float32BufferAttribute { constructor(values, size) { this.values = values; this.size = size; } }
class Material { constructor(options) { this.options = options; } dispose() { this.disposed = true; } }
class MeshLambertMaterial extends Material {}
class LineBasicMaterial extends Material {}
class Mesh extends NodeObject { constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; } }
class InstancedMesh extends Mesh { constructor(geometry, material, capacity) { super(geometry, material); this.capacity = capacity; this.instanceMatrix = {}; this.matrices = []; } setMatrixAt(index, matrix) { this.matrices[index] = structuredClone(matrix); } }
class LineSegments extends Mesh {}
class Object3D extends NodeObject {}
const FakeThree = { Group, PlaneGeometry, ConeGeometry, DodecahedronGeometry, BufferGeometry, Float32BufferAttribute, MeshLambertMaterial, LineBasicMaterial, Mesh, InstancedMesh, LineSegments, Object3D };

test('W5 renderer shows distributed Settlement resources and disposes them without leaks', async () => {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed: 'W5 rendering' });
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const runtime = new ChunkRuntimeManager({ generator, renderAdapter: adapter, cacheCapacity: 40 });
  const startX = Math.floor(generator.reviewSpawn.x / 16);
  const startZ = Math.floor(generator.reviewSpawn.z / 16);
  await runtime.initialize(startX, startZ);
  let resources = adapter.resourceSnapshot();
  assert.equal(resources.sharedGeometryCount, 7);
  assert.equal(resources.sharedMaterialCount, 26);
  assert.equal(resources.liveChunkGroups, 9);
  assert.ok([...adapter.loaded.values()].some(projected => projected.group.children.some(child => (
    child.name === 'infinite-settlement-roads' || child.name === 'infinite-settlement-buildings'
  ))));
  const roadProjection = [...adapter.loaded.values()].find(projected => (
    projected.group.children.some(child => child.name === 'infinite-settlement-roads')
  ));
  const roadMesh = roadProjection.group.children.find(child => child.name === 'infinite-settlement-roads');
  const roadChunk = runtime.getChunkData(roadProjection.chunkX, roadProjection.chunkZ);
  const firstRoad = roadChunk.settlementFeatures.find(feature => feature.featureType === 'settlement-road');
  assert.equal(
    roadMesh.matrices[0].position.y,
    (firstRoad.worldPosition.y + 0.075) * adapter.unitsPerMeter,
  );
  for (let step = 1; step <= 6; step += 1) {
    await runtime.transitionToChunk(startX + step, startZ);
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

test('W5 production sources add no Gameplay, Growth, Worker, LOD, or fixed-count system', () => {
  const sources = [
    'src/infinite-world/settlement-distributor.js',
    'src/infinite-world/distributed-settlement-chunk-generator.js',
  ].map(path => readFileSync(resolve(repoRoot, path), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /from ['"]\.\.\/game\.js|\b(?:Growth|Wanted|Threat|Nation|Worker|LOD)\b/);
  assert.doesNotMatch(sources, /Math\.random|\b(?:THREE|document|window|WebGL|HTMLElement)\b/);
  assert.doesNotMatch(sources, /(?:totalSettlementCount|fixedTownCount|settlementCount\s*:)/);
});
