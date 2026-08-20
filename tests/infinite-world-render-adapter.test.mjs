import test from 'node:test';
import assert from 'node:assert/strict';

import { ChunkRenderAdapter } from '../src/infinite-world/render/chunk-render-adapter.js';
import { resolveW8RockCanonicalObject } from '../src/infinite-world/rock-canonical-object.js';
import { resolveW8CanonicalWorldObject } from '../src/infinite-world/world-object-canonical-contract.js';
import { createSandboxChunkGenerator } from '../src/infinite-world/sandbox-chunk-generator.js';
import { createCanonicalRiverProjection } from '../src/infinite-world/canonical-river-realization.js';
import { sampleW8SurfaceHeightMeters } from '../src/infinite-world/w8-surface-policy.js';
import { resolveW8LowPolyTreePresentationParts } from '../src/infinite-world/vegetation-lod-policy.js';
import { hashWorldSeed } from '../src/infinite-world/legacy-core/g0/seed.js';
import {
  createGpuAttributeMirror,
  createRenderFrameAcknowledger,
  createVisualContinuityRegistry,
} from '../src/infinite-world/visual-continuity.js';

class Triple {
  constructor() { this.set(0, 0, 0); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class NodeObject {
  constructor() {
    this.children = [];
    this.position = new Triple();
    this.rotation = new Triple();
    this.scale = new Triple().set(1, 1, 1);
    this.userData = {};
    this.matrix = { elements: new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]) };
  }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) { this.children = this.children.filter(value => value !== child); child.parent = null; }
  clear() { for (const child of this.children) child.parent = null; this.children = []; }
  updateMatrix() {
    this.matrix = {
      position: { x: this.position.x, y: this.position.y, z: this.position.z },
      rotation: { x: this.rotation.x, y: this.rotation.y, z: this.rotation.z },
      scale: { x: this.scale.x, y: this.scale.y, z: this.scale.z },
      elements: new Float32Array([
        this.scale.x, 0, 0, 0,
        0, this.scale.y, 0, 0,
        0, 0, this.scale.z, 0,
        this.position.x, this.position.y, this.position.z, 1,
      ]),
    };
  }
}
class Group extends NodeObject {}
class Scene extends Group {}
class Geometry {
  constructor() { this.disposed = false; this.attributes = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  dispose() { assert.equal(this.disposed, false, 'geometry disposed twice'); this.disposed = true; }
}
class PlaneGeometry extends Geometry {}
class ConeGeometry extends Geometry {}
class DodecahedronGeometry extends Geometry {}
class BufferGeometry extends Geometry {}
class Float32BufferAttribute { constructor(values, size) { this.values = values; this.size = size; } }
class Material {
  constructor(options) { this.options = options; this.disposed = false; }
  dispose() { assert.equal(this.disposed, false, 'material disposed twice'); this.disposed = true; }
}
class MeshLambertMaterial extends Material {}
class LineBasicMaterial extends Material {}
class Mesh extends NodeObject { constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; } }
class InstancedMesh extends Mesh {
  constructor(geometry, material, capacity) {
    super(geometry, material); this.capacity = capacity; this.count = capacity;
    this.instanceMatrix = { needsUpdate: false, array: new Float32Array(capacity * 16) };
    this.matrices = [];
  }
  setMatrixAt(index, matrix) {
    this.matrices[index] = structuredClone(matrix);
    this.instanceMatrix.array.set(matrix.elements, index * 16);
  }
}
class LineSegments extends Mesh {}
class Object3D extends NodeObject {}
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const length = this.length() || 1; this.x /= length; this.y /= length; this.z /= length; return this; }
}
class Raycaster {
  static hits = [];
  intersectObjects() { return Raycaster.hits; }
}

const FakeThree = {
  Group, PlaneGeometry, ConeGeometry, DodecahedronGeometry, BufferGeometry,
  Float32BufferAttribute, MeshLambertMaterial, LineBasicMaterial,
  Mesh, InstancedMesh, LineSegments, Object3D, Vector3, Raycaster,
};

test('render adapter shares geometry/materials, releases chunk objects, and disposes shared resources only at shutdown', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'renderer-resources' });
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const initialResources = adapter.resourceSnapshot();
  assert.equal(initialResources.sharedGeometryCount, 6);
  assert.equal(initialResources.sharedMaterialCount, 26);
  assert.equal(initialResources.sharedDisposed, false);

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const data = await generator.generateChunk(iteration, -iteration);
    await adapter.rebase({ renderOriginChunkX: iteration, renderOriginChunkZ: -iteration, rebaseCount: iteration });
    const projected = await adapter.projectChunk(data);
    assert.equal(projected.lifecycle, 'staged');
    assert.ok(projected.group.children.length >= 3 && projected.group.children.length <= 4);
    const projectedRenderableCount = projected.group.children.length;
    assert.deepEqual({ x: projected.group.position.x, z: projected.group.position.z }, { x: 0, z: 0 });
    await adapter.loadProjected(projected);
    assert.equal(projected.lifecycle, 'loaded');
    const coverage = adapter.renderCoverageSnapshot();
    assert.deepEqual(coverage.loadedKeys, [`${iteration},${-iteration}`]);
    assert.deepEqual(coverage.terrainKeys, [`${iteration},${-iteration}`]);
    assert.deepEqual(coverage.missingTerrainKeys, []);
    assert.deepEqual(coverage.disposedTerrainKeys, []);
    assert.deepEqual(coverage.lifecycleMismatchKeys, []);
    await assert.rejects(() => adapter.discardProjected(projected), /cannot discard loaded chunk/);
    assert.equal(adapter.resourceSnapshot().liveChunkGroups, 1);
    assert.equal(adapter.resourceSnapshot().chunkRenderables[`${iteration},${-iteration}`], projectedRenderableCount);
    await adapter.unloadChunk(`${iteration},${-iteration}`);
    assert.equal(projected.lifecycle, 'unloaded');
    const afterUnload = adapter.resourceSnapshot();
    assert.equal(afterUnload.liveChunkGroups, 0);
    assert.equal(afterUnload.sharedDisposed, false);
    assert.equal(afterUnload.sharedGeometryCount, 6);
    assert.equal(afterUnload.sharedMaterialCount, 26);
  }
  assert.equal(scene.children.includes(adapter.worldRoot), true);
  await adapter.shutdown();
  assert.equal(adapter.resourceSnapshot().sharedDisposed, true);
  assert.equal(scene.children.includes(adapter.worldRoot), false);
  assert.ok(Object.values(adapter.geometries).every(geometry => geometry.disposed));
  assert.ok(Object.values(adapter.materials).every(material => material.disposed));
  await adapter.shutdown();
});

test('a staged duplicate can be discarded while another projection for the owner is live', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'renderer-staged-duplicate' });
  const data = await generator.generateChunk(0, 0);
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const live = await adapter.projectChunk(data);
  const duplicate = await adapter.projectChunk(data);

  await adapter.loadProjected(live);
  assert.equal(await adapter.discardProjected(duplicate), true);
  assert.equal(live.lifecycle, 'loaded');
  assert.equal(duplicate.lifecycle, 'discarded');
  assert.deepEqual(adapter.renderCoverageSnapshot().loadedKeys, ['0,0']);

  await adapter.unloadChunk('0,0');
  await adapter.shutdown();
});

test('Terrain-only publication defers auxiliary layers and promotes the same mesh into the formal owner', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'renderer-terrain-promotion' });
  const data = await generator.generateChunk(0, 0);
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const provisional = await adapter.projectTerrainChunk(data, {
    renderOriginChunkX: 0, renderOriginChunkZ: 0,
  });
  const terrain = provisional.terrain;
  await adapter.loadProjectedTerrain(provisional);
  assert.deepEqual(adapter.renderCoverageSnapshot().provisionalTerrainKeys, ['0,0']);
  assert.equal(provisional.group.children.length, 1);
  assert.equal(adapter.featureInstances.size, 0, 'Stable IDs are not registered by Phase 1');

  const full = await adapter.projectChunk(data, null, { deferredRegistration: true });
  assert.equal(adapter.featureInstances.size, 0, 'supplemental projection remains staged');
  await adapter.loadProjected(full);
  assert.equal(full.group.children.includes(terrain), true);
  assert.equal(full.group.children.filter(child => (
    child.name === 'w2-natural-terrain' || child.name === 'w1a-terrain'
  )).length, 1);
  assert.deepEqual(adapter.renderCoverageSnapshot().provisionalTerrainKeys, []);
  assert.deepEqual(adapter.renderCoverageSnapshot().loadedKeys, ['0,0']);
  assert.ok(adapter.featureInstances.size > 0, 'Stable IDs publish only with the full owner');

  await adapter.retainTerrainChunk('0,0');
  assert.equal(provisional.group.children[0], terrain);
  assert.deepEqual(adapter.renderCoverageSnapshot().loadedKeys, []);
  assert.deepEqual(adapter.renderCoverageSnapshot().provisionalTerrainKeys, ['0,0']);
  assert.equal(adapter.featureInstances.size, 0);
  await adapter.unloadProvisionalTerrain('0,0');
  await adapter.shutdown();
});

test('render adapter applies Stable-ID destruction without allocating or leaking Chunk resources', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'renderer-destruction-state' });
  const data = await generator.generateChunk(0, 0);
  const stableId = (data.vegetationProxies[0] ?? data.rockProxies[0]).stableId;
  const destroyed = new Set();
  const adapter = new ChunkRenderAdapter({
    THREE: FakeThree,
    scene: new Scene(),
    isFeatureDestroyed: id => destroyed.has(id),
  });
  const projected = await adapter.projectChunk(data);
  await adapter.loadProjected(projected);
  const entry = adapter.featureInstances.get(stableId);
  assert.ok(entry);
  const firstVisibleSnapshot = adapter.visibleStableIdsSnapshot();
  assert.equal(firstVisibleSnapshot.includes(stableId), true);
  assert.equal(adapter.visibleStableIdsSnapshot(), firstVisibleSnapshot,
    'unchanged Near ownership reuses the immutable Stable ID snapshot');
  assert.notEqual(entry.mesh.matrices[entry.index].scale.x, 0);
  assert.equal(adapter.setFeatureDestroyed(stableId, true), true);
  const destroyedSnapshot = adapter.visibleStableIdsSnapshot();
  assert.notEqual(destroyedSnapshot, firstVisibleSnapshot);
  assert.equal(destroyedSnapshot.includes(stableId), false);
  assert.deepEqual(entry.mesh.matrices[entry.index].scale, { x: 0, y: 0, z: 0 });
  destroyed.add(stableId);
  adapter.refreshFeatureStates();
  assert.deepEqual(entry.mesh.matrices[entry.index].scale, { x: 0, y: 0, z: 0 });
  destroyed.delete(stableId);
  adapter.refreshFeatureStates();
  assert.equal(adapter.visibleStableIdsSnapshot().includes(stableId), true);
  assert.notEqual(entry.mesh.matrices[entry.index].scale.x, 0);
  await adapter.unloadChunk('0,0');
  assert.equal(adapter.resourceSnapshot().trackedFeatureInstanceCount, 0);
  await adapter.shutdown();
});

test('Near projection renders every canonical River centerline segment with its owner Stable ID', async () => {
  const { worldSeedHash } = await hashWorldSeed('Near canonical River projection');
  const projection = await createCanonicalRiverProjection({
    worldSeedHash,
    chunkX: 0,
    chunkZ: 0,
    sampleSurfaceHeight: () => 0.25,
  });
  const river = projection.waterSurface;
  const chunk = {
    chunkX: 0, chunkZ: 0, chunkId: 'canonical-river-near-chunk', contentHash: 'sha256:test',
    generatorVersion: { major: 800 },
    terrain: {
      resolution: { x: 2, z: 2 }, heights: [0, 0, 0, 0], heightUnitMeters: 0.001,
      materialWeights: new Array(20).fill(0),
    },
    vegetationCandidates: [], rockCandidates: [], ambientDetails: [],
    settlementFeatures: [], settlementLandmarks: [], streetDetails: [],
    waterSurfaces: [river],
  };
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const projected = await adapter.projectChunk(chunk);
  const riverMesh = projected.group.children.find(child => (
    child.name === 'w8-canonical-river-water'
  ));
  const expectedSegmentCount = river.centerlines.reduce((total, line) => (
    total + line.length - 1
  ), 0);
  assert.ok(riverMesh);
  assert.equal(riverMesh.count, expectedSegmentCount);
  assert.equal(riverMesh.userData.waterType, 'river');
  assert.deepEqual(riverMesh.userData.featureStableIds,
    Array(expectedSegmentCount).fill(river.stableId));
  assert.ok(riverMesh.matrices.every(matrix => matrix.scale.x > 0 && matrix.scale.y > 0));
  assert.ok(riverMesh.matrices.every(matrix => matrix.position.y === 0.25 * 256 + 1.5));
  await adapter.shutdown();
});

test('destroyed canonical Rock removes every instance without retaining a full-scale rubble mesh', async () => {
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const stableId = 'detail-v1:rock:destroyed-presentation';
  const canonicalObject = resolveW8RockCanonicalObject(Object.freeze({
    candidateId: stableId,
    subtype: 'medium-rock',
    sizeClass: 'medium',
    variationSeed: 1,
    orientationSeed: 0,
    worldPosition: Object.freeze({ x: 8, y: 0, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 0, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.22 }),
  }));
  const mesh = new InstancedMesh(new DodecahedronGeometry(), new MeshLambertMaterial({}), 1);
  const transform = new Object3D();
  transform.position.set(8, 0, 8);
  transform.scale.set(4, 4, 4);
  transform.updateMatrix();
  mesh.setMatrixAt(0, transform.matrix);
  const group = new Group();
  group.add(mesh);
  adapter.featureInstances.set(stableId, {
    stableId,
    chunkKey: '0,0',
    mesh,
    index: 0,
    originalMatrix: structuredClone(transform.matrix),
    parts: [{ mesh, fadeMesh: null, index: 0, originalMatrix: structuredClone(transform.matrix) }],
    group,
    rubbleMesh: null,
    canonicalObject,
  });

  assert.equal(canonicalObject.destruction.presentation, 'none');
  assert.equal(adapter.setFeatureDestroyed(stableId, true), true);
  assert.deepEqual(mesh.matrices[0].scale, { x: 0, y: 0, z: 0 });
  assert.equal(adapter.featureInstances.get(stableId).rubbleMesh, null);
  assert.equal(group.children.includes(mesh), true);
  assert.equal(group.children.some(child => child.name === 'w8-persistent-destruction-rubble'), false);
  await adapter.shutdown();
});

test('Settlement instances fade in one frame and restore after the bounded hysteresis', async () => {
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const stableId = 'building-camera-occlusion';
  const chunk = {
    chunkX: 0, chunkZ: 0, chunkId: 'occlusion-chunk', contentHash: 'sha256:test',
    generatorVersion: { major: 800 },
    terrain: {
      resolution: { x: 2, z: 2 }, heights: [0, 0, 0, 0], heightUnitMeters: 0.001,
      materialWeights: new Array(20).fill(0),
    },
    vegetationCandidates: [], rockCandidates: [], waterSurfaces: [], ambientDetails: [],
    settlementLandmarks: [], streetDetails: [],
    settlementFeatures: [{
      stableId, featureType: 'settlement-building', buildingType: 'house',
      worldPosition: { x: 8, y: 0, z: 8 }, rotationY: 0,
      widthMeters: 3, heightMeters: 2.5, depthMeters: 3,
    }],
  };
  const projected = await adapter.projectChunk(chunk);
  await adapter.loadProjected(projected);
  const entry = adapter.featureInstances.get(stableId);
  assert.ok(entry.parts.every(part => part.fadeMesh));
  const first = entry.parts[0];
  assert.equal(first.fadeMesh.material.options.opacity, 0.25);
  assert.equal(first.fadeMesh.material.options.depthWrite, false);
  Raycaster.hits = [{ object: first.mesh, instanceId: first.index }];
  assert.equal(adapter.updateCameraOcclusion({
    camera: { position: { x: 0, y: 100, z: 0 } }, target: { x: 100, y: 0, z: 100 }, nowMs: 1_000,
  }), 1);
  assert.deepEqual(first.mesh.matrices[first.index].scale, { x: 0, y: 0, z: 0 });
  assert.notEqual(first.fadeMesh.matrices[first.index].scale.x, 0);
  assert.equal(adapter.updateCameraOcclusion({ enabled: false }), 0);
  assert.notEqual(first.mesh.matrices[first.index].scale.x, 0);
  assert.deepEqual(first.fadeMesh.matrices[first.index].scale, { x: 0, y: 0, z: 0 });
  Raycaster.hits = [{ object: first.mesh, instanceId: first.index }];
  assert.equal(adapter.updateCameraOcclusion({
    camera: { position: { x: 0, y: 100, z: 0 } }, target: { x: 100, y: 0, z: 100 },
    nowMs: 1_010, enabled: false,
  }), 0);
  assert.notEqual(first.mesh.matrices[first.index].scale.x, 0);
  Raycaster.hits = [{ object: first.mesh, instanceId: first.index }];
  assert.equal(adapter.updateCameraOcclusion({
    camera: { position: { x: 0, y: 100, z: 0 } }, target: { x: 100, y: 0, z: 100 },
    nowMs: 1_020, enabled: true,
  }), 1);
  Raycaster.hits = [];
  assert.equal(adapter.updateCameraOcclusion({
    camera: { position: { x: 0, y: 100, z: 0 } }, target: { x: 100, y: 0, z: 100 }, nowMs: 1_100,
  }), 0);
  assert.deepEqual(first.mesh.matrices[first.index].scale, { x: 0, y: 0, z: 0 });
  assert.notEqual(first.fadeMesh.matrices[first.index].scale.x, 0);
  assert.equal(adapter.updateCameraOcclusion({
    camera: { position: { x: 0, y: 100, z: 0 } }, target: { x: 100, y: 0, z: 100 }, nowMs: 1_140,
  }), 0);
  assert.notEqual(first.mesh.matrices[first.index].scale.x, 0);
  assert.deepEqual(first.fadeMesh.matrices[first.index].scale, { x: 0, y: 0, z: 0 });
  const fadeMaterial = first.fadeMesh.material;
  await adapter.shutdown();
  assert.equal(fadeMaterial.disposed, true);
});

test('Camera collision ignores LOS obstruction and only pushes a camera penetrating a building', async () => {
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const stableId = 'building-camera-collision';
  const chunk = {
    chunkX: 0, chunkZ: 0, chunkId: 'camera-collision-chunk', contentHash: 'sha256:test',
    generatorVersion: { major: 800 },
    terrain: {
      resolution: { x: 2, z: 2 }, heights: [0, 0, 0, 0], heightUnitMeters: 0.001,
      materialWeights: new Array(20).fill(0),
    },
    vegetationCandidates: [], rockCandidates: [], waterSurfaces: [], ambientDetails: [],
    settlementLandmarks: [], streetDetails: [],
    settlementFeatures: [{
      stableId, featureType: 'settlement-building', buildingType: 'house',
      worldPosition: { x: 8, y: 0, z: 8 }, rotationY: 0,
      widthMeters: 3, heightMeters: 2.5, depthMeters: 3,
    }],
  };
  const projected = await adapter.projectChunk(chunk);
  await adapter.loadProjected(projected);
  const clearCamera = { position: new Triple().set(0, 320, 100) };
  Raycaster.hits = [{ object: adapter.featureInstances.get(stableId).parts[0].mesh, instanceId: 0, distance: 60 }];
  const clearResult = adapter.resolveCameraCollision({
    camera: clearCamera,
    target: { x: 0, y: 0, z: 0 },
    clearanceMeters: 0.1,
  });
  assert.equal(clearResult.collided, false);
  assert.deepEqual({ x: clearCamera.position.x, y: clearCamera.position.y, z: clearCamera.position.z }, {
    x: 0, y: 320, z: 100,
  });

  const camera = { position: new Triple().set(2_048, 320, 2_048) };
  const result = adapter.resolveCameraCollision({
    camera,
    target: { x: 0, y: 0, z: 0 },
    clearanceMeters: 0.1,
  });
  assert.equal(result.collided, true);
  assert.equal(result.stableId, stableId);
  assert.equal(result.desiredDistance, Math.hypot(2_048, 320, 2_048));
  assert.equal(result.resolvedDistance, Math.hypot(2_048, 665.6, 2_048));
  assert.deepEqual({ x: camera.position.x, y: camera.position.y, z: camera.position.z }, {
    x: 2_048, y: 665.6, z: 2_048,
  });
  Raycaster.hits = [];
  await adapter.shutdown();
});

test('Settlement projection preserves finite layer order and renders ribbon, entrance, and forecourt surfaces', async () => {
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const roads = [
    {
      stableId: 'road-a', featureType: 'settlement-road', widthMeters: 2,
      start: { x: 2, z: 8 }, end: { x: 8, z: 8 }, worldPosition: { x: 5, y: 0, z: 8 },
    },
    {
      stableId: 'road-b', featureType: 'settlement-road', widthMeters: 2,
      start: { x: 8, z: 8 }, end: { x: 8, z: 14 }, worldPosition: { x: 8, y: 0, z: 11 },
    },
  ];
  const building = {
    stableId: 'house-with-lot', featureType: 'settlement-building', buildingType: 'house',
    worldPosition: { x: 11, y: 0, z: 8 }, rotationY: 0,
    widthMeters: 6.5, heightMeters: 4.5, depthMeters: 5.25,
    lot: {
      lotStatus: 'ACTIVE',
      path: { centerX: 9.5, centerZ: 8, rotationY: 0, width: 0.35, depth: 3 },
      forecourt: { centerX: 10.2, centerZ: 8, rotationY: 0, width: 2.25, depth: 0.625 },
    },
  };
  const chunk = {
    chunkX: 0, chunkZ: 0, chunkId: 'settlement-order-chunk', contentHash: 'sha256:test',
    generatorVersion: { major: 800 },
    terrain: {
      resolution: { x: 2, z: 2 }, heights: [0, 0, 0, 0], heightUnitMeters: 0.001,
      materialWeights: new Array(20).fill(0),
    },
    vegetationCandidates: [{
      candidateId: 'tree-after-town', subtype: 'broadleaf-tree', variationSeed: 0.99,
      orientationSeed: 0.25, worldPosition: { x: 14, y: 0, z: 14 },
      metadata: { candidateRadiusMeters: 0.625 },
    }],
    rockCandidates: [], waterSurfaces: [], ambientDetails: [], settlementLandmarks: [], streetDetails: [],
    settlementFeatures: [...roads, building],
  };
  const projected = await adapter.projectChunk(chunk);
  const names = projected.group.children.map(child => child.name);
  const indexOf = pattern => names.findIndex(name => pattern.test(name));
  const roadIndex = indexOf(/infinite-settlement-roads/);
  const junctionIndex = indexOf(/infinite-settlement-junctions/);
  const lotIndex = indexOf(/infinite-settlement-residential-lot-paths-and-forecourts/);
  const buildingIndex = indexOf(/production-infinite-settlement-building/);
  const vegetationIndex = indexOf(/production-vegetation/);
  assert.ok(roadIndex > 0);
  assert.equal(junctionIndex, -1);
  assert.ok(lotIndex > roadIndex);
  assert.ok(buildingIndex > lotIndex);
  assert.ok(vegetationIndex > buildingIndex);
  assert.equal(names.some(name => /production-vegetation-dodeca-treeLeaves/.test(name)), true,
    'Near broadleaf uses the same angular dodeca crown as Distant presentation');
  assert.equal(names.some(name => /production-vegetation-sphere-treeLeaves/.test(name)), false,
    'Near projection does not restore the smooth multi-sphere crown');
  const roadMesh = projected.group.children[roadIndex];
  assert.equal(roadMesh.userData.roadRibbon.roadRecordCount, 2);
  assert.equal(roadMesh.userData.roadRibbon.degenerateTriangleCount, 0);
  assert.equal(roadMesh.userData.roadRibbon.duplicateFaceCount, 0);
  const lotMesh = projected.group.children[lotIndex];
  assert.deepEqual(lotMesh.userData.surfaceKinds.sort(), ['entrance-path', 'forecourt']);
  assert.equal(lotMesh.count, 2);
  assert.equal(lotMesh.matrices[0].scale.x, 0.9 * adapter.unitsPerMeter);
  assert.equal(lotMesh.matrices[1].scale.x, 2.25 * adapter.unitsPerMeter);
  await adapter.loadProjected(projected);
  assert.deepEqual(adapter.drawableStableIdsSnapshot(), [],
    'Near publication is not renderer proof before a completed receipt');
  assert.equal(adapter.markFirstDraw({ rendererFrameCompleted: true }), 0,
    'a forgeable manual first-draw object must not update receipt-backed identity');
  assert.deepEqual(adapter.drawableStableIdsSnapshot(), []);
  const frameAcknowledger = createRenderFrameAcknowledger({ clock: () => 1 });
  const frameToken = frameAcknowledger.beginFrame({ frameSequence: 1 });
  adapter.markFirstDraw(frameAcknowledger.completeFrame(frameToken, { scene }));
  assert.equal(adapter.drawableStableIdsSnapshot().includes('tree-after-town'), true,
    'completed scene receipt publishes the actually drawn Near Stable ID');
  const pathAudit = adapter.treePathAuditSnapshot();
  assert.equal(pathAudit.pathId, 'near-tree');
  assert.deepEqual(pathAudit.rootNames, ['w1a-render-root']);
  assert.equal(pathAudit.rootCount, 1);
  assert.equal(pathAudit.ownerCount, 1);
  assert.equal(pathAudit.stableIdCount, 1);
  assert.equal(pathAudit.instanceCount > 0, true);
  assert.equal(pathAudit.firstDrawAtMs !== null, true);
  assert.deepEqual(pathAudit.publicationSources, ['runtime-chunk-load']);
  adapter.setFeatureDestroyed('tree-after-town', true);
  const destroyedFrame = frameAcknowledger.beginFrame({ frameSequence: 2 });
  adapter.markFirstDraw(frameAcknowledger.completeFrame(destroyedFrame, { scene }));
  assert.equal(adapter.drawableStableIdsSnapshot().includes('tree-after-town'), false,
    'a zero-scale destroyed slot is not retained as a drawable Near presenter');
  await adapter.unloadChunk('0,0');
  assert.equal(adapter.treePathAuditSnapshot().disposeCount, 1);
  await adapter.shutdown();
});

test('Settlement presentation hold releases Terrain and collision while retaining Building and Road until covered', async () => {
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const road = {
    stableId: 'road-hold-projection',
    sourceStableId: 'road-hold-source',
    featureType: 'settlement-road', widthMeters: 2,
    start: { x: 2, z: 8 }, end: { x: 8, z: 8 }, worldPosition: { x: 5, y: 0, z: 8 },
  };
  const building = {
    stableId: 'building-hold-projection',
    featureType: 'settlement-building', buildingType: 'house',
    worldPosition: { x: 11, y: 0, z: 8 }, rotationY: 0,
    widthMeters: 6.5, heightMeters: 4.5, depthMeters: 5.25,
  };
  const chunk = {
    chunkX: 0, chunkZ: 0, chunkId: 'settlement-hold-chunk', contentHash: 'sha256:test',
    generatorVersion: { major: 800 },
    terrain: {
      resolution: { x: 2, z: 2 }, heights: [0, 0, 0, 0], heightUnitMeters: 0.001,
      materialWeights: new Array(20).fill(0),
    },
    vegetationCandidates: [], rockCandidates: [], waterSurfaces: [], ambientDetails: [],
    settlementLandmarks: [], streetDetails: [], settlementFeatures: [road, building],
  };
  const projected = await adapter.projectChunk(chunk);
  const roadGeometry = projected.group.children
    .find(child => child.name === 'infinite-settlement-roads').geometry;
  await adapter.loadProjected(projected);
  assert.equal(adapter.resourceSnapshot().cameraCollisionBoundCount, 1);

  await adapter.unloadChunk('0,0', { deferSettlementPresentation: true });
  const held = adapter.presentationHoldSnapshot();
  assert.equal(projected.lifecycle, 'presentation-held');
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].descriptors.map(value => value.projectionIdentity).sort(),
    [building.stableId, road.stableId].sort());
  assert.deepEqual(adapter.visibleStableIdsSnapshot(), [building.stableId, road.stableId].sort());
  assert.equal(adapter.resourceSnapshot().liveChunkGroups, 0);
  assert.equal(adapter.resourceSnapshot().heldSettlementPresentationOwnerCount, 1);
  assert.equal(adapter.resourceSnapshot().cameraCollisionBoundCount, 0,
    'presentation hold must not retain camera/collision ownership');
  assert.equal(projected.group.children.some(child => /terrain/.test(child.name)), false);
  assert.equal(projected.group.children.some(child => /lot-paths/.test(child.name)), false);
  assert.equal(roadGeometry.disposed, false);

  await adapter.rebase({ renderOriginChunkX: 2, renderOriginChunkZ: -1, rebaseCount: 1 });
  assert.deepEqual({ x: projected.group.position.x, z: projected.group.position.z }, {
    x: -2 * adapter.renderChunkSize,
    z: adapter.renderChunkSize,
  });

  const buildingDescriptor = held[0].descriptors.find(value => value.kind === 'building');
  const buildingRelease = adapter.releaseSettlementPresentationHolds({
    ownerKeys: ['0,0'], descriptors: [buildingDescriptor], reason: 'building-covered',
  });
  assert.equal(buildingRelease.released, true);
  assert.deepEqual(adapter.visibleStableIdsSnapshot(), [road.stableId]);
  assert.equal(adapter.presentationHoldSnapshot().length, 1);

  const roadDescriptor = adapter.presentationHoldSnapshot()[0].descriptors[0];
  const roadRelease = adapter.releaseSettlementPresentationHolds({
    ownerKeys: ['0,0'], descriptors: [roadDescriptor], reason: 'road-covered',
  });
  assert.equal(roadRelease.released, true);
  assert.deepEqual(adapter.visibleStableIdsSnapshot(), []);
  assert.equal(adapter.presentationHoldSnapshot().length, 0);
  assert.equal(roadGeometry.disposed, true);
  const repeatedRoadRelease = adapter.releaseSettlementPresentationHolds({
    ownerKeys: ['0,0'], descriptors: [roadDescriptor], reason: 'covered-repeat',
  });
  assert.equal(repeatedRoadRelease.released, true);
  assert.equal(roadGeometry.disposed, true, 'an already released Road must not be disposed twice');

  const returnedNear = await adapter.projectChunk(chunk);
  await adapter.loadProjected(returnedNear);
  assert.equal(adapter.presentationHoldSnapshot().length, 0,
    'an owner returning Near releases its stale presentation hold before publish');
  assert.deepEqual(adapter.visibleStableIdsSnapshot(), [building.stableId, road.stableId].sort());
  await adapter.unloadChunk('0,0', { deferSettlementPresentation: true });
  assert.equal(adapter.presentationHoldSnapshot().length, 1);
  await adapter.shutdown();
  assert.equal(adapter.presentationHoldSnapshot().length, 0);
});

test('generic replacement barrier releases presentation-only coarse hold only after returning Near detail actually draws', async () => {
  let now = 1;
  const scene = new Scene();
  const visualRegistry = createVisualContinuityRegistry({ clock: () => now });
  const adapter = new ChunkRenderAdapter({
    THREE: FakeThree,
    scene,
    visualRegistry,
    // No diagnostic or telemetry switch is supplied: this is the normal path.
  });
  const road = {
    stableId: 'road-replacement-projection',
    sourceStableId: 'road-replacement-source',
    featureType: 'settlement-road', widthMeters: 2,
    start: { x: 2, z: 8 }, end: { x: 8, z: 8 }, worldPosition: { x: 5, y: 0, z: 8 },
  };
  const secondRoad = {
    stableId: 'road-replacement-projection-2',
    sourceStableId: 'road-replacement-source-2',
    featureType: 'settlement-road', widthMeters: 2,
    start: { x: 8, z: 8 }, end: { x: 14, z: 8 }, worldPosition: { x: 11, y: 0, z: 8 },
  };
  const building = {
    stableId: 'building-replacement-projection',
    featureType: 'settlement-building', buildingType: 'house',
    worldPosition: { x: 11, y: 0, z: 8 }, rotationY: 0,
    widthMeters: 6.5, heightMeters: 4.5, depthMeters: 5.25,
  };
  const chunk = {
    chunkX: 0, chunkZ: 0, chunkId: 'settlement-replacement-chunk', contentHash: 'sha256:test',
    generatorVersion: { major: 800 },
    terrain: {
      resolution: { x: 2, z: 2 }, heights: [0, 0, 0, 0], heightUnitMeters: 0.001,
      materialWeights: new Array(20).fill(0),
    },
    vegetationCandidates: [], rockCandidates: [], waterSurfaces: [], ambientDetails: [],
    settlementLandmarks: [], streetDetails: [], settlementFeatures: [road, secondRoad, building],
  };

  visualRegistry.expect({ ownerKey: '0,0', expectedAt: now });
  visualRegistry.resolveCoarseRequirements({
    ownerKey: '0,0',
    structureStableIds: [road.stableId, secondRoad.stableId, building.stableId],
    forestStableIds: [],
    at: now,
  });
  const initial = await adapter.projectChunk(chunk);
  const oldRoadGeometry = initial.group.children
    .find(child => child.name === 'infinite-settlement-roads').geometry;
  await adapter.loadProjected(initial);
  const frames = createRenderFrameAcknowledger({
    clock: () => now,
    gpuMirror: createGpuAttributeMirror(),
  });
  let token = frames.beginFrame({ frameSequence: 1 });
  let receipt = frames.completeFrame(token, { scene });
  adapter.markFirstDraw(receipt);
  const terrain = initial.group.children.find(child => /terrain/.test(child.name));
  assert.equal(visualRegistry.acknowledgeCoarseComponent({
    ownerKey: '0,0', component: 'terrain', receipt, drawable: { mesh: terrain },
  }), true, 'the test Terrain has actual receipt evidence');
  visualRegistry.acknowledgeScene({ receipt, scene });
  assert.deepEqual(visualRegistry.get('0,0').drawnStructureStableIds,
    [building.stableId, road.stableId, secondRoad.stableId].sort(),
    'merged ribbon receipt credits every declared Road ID while Building stays per-instance');
  assert.deepEqual(adapter.drawableStableIdsSnapshot(),
    [building.stableId, road.stableId, secondRoad.stableId].sort(),
    'receipt-backed Near identity includes merged Road IDs on the normal path');

  await adapter.unloadChunk('0,0', { deferSettlementPresentation: true });
  const returning = await adapter.projectChunk(chunk);
  await adapter.loadProjected(returning);
  assert.equal(adapter.presentationHoldSnapshot().length, 1,
    'loading new Near detail must not publish-dispose the coarse hold');
  assert.equal(oldRoadGeometry.disposed, false);
  assert.equal(adapter.markFirstDraw({ rendererFrameCompleted: true }), 0);
  assert.equal(adapter.presentationHoldSnapshot().length, 1,
    'a forgeable receipt cannot release the retained drawable');

  const hidden = new Object3D();
  hidden.scale.set(0, 0, 0);
  hidden.updateMatrix();
  const hiddenBuildingParts = [];
  for (const mesh of returning.group.children) {
    const slot = mesh.userData?.featureStableIds?.indexOf(building.stableId) ?? -1;
    if (slot < 0) continue;
    hiddenBuildingParts.push({ mesh, slot, matrix: structuredClone(mesh.matrices[slot]) });
    mesh.setMatrixAt(slot, hidden.matrix);
  }
  assert.ok(hiddenBuildingParts.length > 0);
  now = 2;
  token = frames.beginFrame({ frameSequence: 2 });
  receipt = frames.completeFrame(token, { scene });
  adapter.markFirstDraw(receipt);
  assert.equal(adapter.presentationHoldSnapshot().length, 1,
    'one drawn Road cannot release the hold while matching Building detail is zero-scale');
  assert.equal(oldRoadGeometry.disposed, false);

  for (const part of hiddenBuildingParts) part.mesh.setMatrixAt(part.slot, part.matrix);
  const returningRoad = returning.group.children
    .find(child => child.name === 'infinite-settlement-roads');
  const completeRoadStableIds = returningRoad.userData.sourceRoadStableIds;
  returningRoad.userData.sourceRoadStableIds = Object.freeze([road.stableId]);
  now = 3;
  token = frames.beginFrame({ frameSequence: 3 });
  receipt = frames.completeFrame(token, { scene });
  adapter.markFirstDraw(receipt);
  assert.equal(adapter.presentationHoldSnapshot().length, 1,
    'a partial merged ribbon cannot stand in for its missing declared Road ID');
  assert.equal(oldRoadGeometry.disposed, false);

  returningRoad.userData.sourceRoadStableIds = completeRoadStableIds;
  returningRoad.visible = false;
  now = 4;
  token = frames.beginFrame({ frameSequence: 4 });
  receipt = frames.completeFrame(token, { scene });
  adapter.markFirstDraw(receipt);
  assert.equal(adapter.presentationHoldSnapshot().length, 1,
    'an absent merged ribbon produces no renderer evidence and keeps OLD coarse');
  assert.equal(oldRoadGeometry.disposed, false);
  returningRoad.visible = true;

  await adapter.unloadChunk('0,0', { deferSettlementPresentation: true });
  assert.equal(adapter.presentationHoldSnapshot().length, 1,
    'rapid reversal before receipt keeps the proven OLD coarse hold');
  assert.equal(oldRoadGeometry.disposed, false);
  const retry = await adapter.projectChunk(chunk);
  await adapter.loadProjected(retry);

  now = 5;
  token = frames.beginFrame({ frameSequence: 5 });
  receipt = frames.completeFrame(token, { scene });
  adapter.markFirstDraw(receipt);
  assert.deepEqual(adapter.drawableStableIdsSnapshot(),
    [building.stableId, road.stableId, secondRoad.stableId].sort());
  assert.equal(adapter.presentationHoldSnapshot().length, 0,
    'all matching Near Structure Stable IDs on a completed receipt release coarse');
  assert.equal(oldRoadGeometry.disposed, true);
  await adapter.shutdown();
});

test('canonical MAJOR projection seams do not become artificial road junctions', async () => {
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const segment = (stableId, sourceSegmentStableId, startX, endX) => ({
    stableId,
    sourceStableId: 'major-road-v1:seam-test',
    sourceSegmentStableId,
    featureType: 'settlement-road',
    canonicalMajorRoad: true,
    roadKind: 'MAJOR',
    widthMeters: 2.25,
    start: { x: startX, y: 0, z: 8 },
    end: { x: endX, y: 0, z: 8 },
    worldPosition: { x: (startX + endX) / 2, y: 0, z: 8 },
  });
  const chunk = {
    chunkX: 0, chunkZ: 0, chunkId: 'major-road-seam-chunk', contentHash: 'sha256:test',
    generatorVersion: { major: 800 },
    terrain: {
      resolution: { x: 2, z: 2 }, heights: [0, 0, 0, 0], heightUnitMeters: 0.001,
      materialWeights: new Array(20).fill(0),
    },
    vegetationCandidates: [], rockCandidates: [], waterSurfaces: [], ambientDetails: [],
    settlementLandmarks: [], streetDetails: [],
    settlementFeatures: [
      segment('major-segment-a', 'source-segment-a', 2, 6),
      segment('major-segment-b', 'source-segment-b', 6, 10),
    ],
  };
  const projected = await adapter.projectChunk(chunk);
  const roadMesh = projected.group.children.find(child => (
    child.name === 'infinite-settlement-roads'
  ));
  assert.equal(roadMesh.count, 2);
  assert.equal(projected.group.children.some(child => (
    child.name === 'infinite-settlement-junctions'
  )), false);
  await adapter.shutdown();
});

test('Near W8 canonical vegetation anchors every part at canonical position Y without Terrain resampling', async () => {
  const candidate = Object.freeze({
    candidateId: 'detail-v1:tree:canonical-y-anchor',
    candidateType: 'vegetation',
    subtype: 'broadleaf-tree',
    variationSeed: 0.625,
    orientationSeed: 0.375,
    worldPosition: Object.freeze({ x: 8, y: 1.23456789, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 0, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.625 }),
  });
  const chunk = {
    chunkX: 0, chunkZ: 0, chunkId: 'canonical-tree-y-anchor', contentHash: 'sha256:test',
    generatorVersion: { major: 800 },
    terrain: {
      resolution: { x: 2, z: 2 }, heights: [9000, 9000, 9000, 9000],
      heightUnitMeters: 0.001, materialWeights: new Array(20).fill(0),
    },
    vegetationCandidates: [candidate], rockCandidates: [], waterSurfaces: [], ambientDetails: [],
    settlementFeatures: [], settlementLandmarks: [], streetDetails: [],
  };
  const canonical = resolveW8CanonicalWorldObject(candidate);
  const sampledTerrainY = sampleW8SurfaceHeightMeters(
    chunk,
    canonical.position.x,
    canonical.position.z,
  );
  assert.notEqual(sampledTerrainY, canonical.position.y,
    'the fixture must distinguish canonical identity Y from sampled Terrain Y');

  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const projected = await adapter.projectChunk(chunk);
  await adapter.loadProjected(projected);
  const entry = adapter.featureInstances.get(canonical.stableId);
  assert.ok(entry, 'canonical Tree must be registered on the Near path');

  const lowPolyParts = resolveW8LowPolyTreePresentationParts({
    subtype: candidate.subtype,
    parts: canonical.presentation.parts,
    supportsDodeca: true,
  });
  const expectedCanonicalPartY = lowPolyParts.map(part => (
    canonical.position.y * adapter.unitsPerMeter
      + part.position[1] * canonical.visualBounds.height * adapter.unitsPerMeter
  )).sort((left, right) => left - right);
  const terrainResampledPartY = lowPolyParts.map(part => (
    sampledTerrainY * adapter.unitsPerMeter
      + part.position[1] * canonical.visualBounds.height * adapter.unitsPerMeter
  )).sort((left, right) => left - right);
  const actualPartY = entry.parts.map(part => part.originalMatrix.position.y)
    .sort((left, right) => left - right);

  assert.deepEqual(actualPartY, expectedCanonicalPartY,
    'each Near Tree part must preserve the exact canonical.position.y anchor');
  assert.notDeepEqual(actualPartY, terrainResampledPartY,
    'Near Tree placement must not substitute the sampled Terrain height');
  assert.equal(entry.parts.length, 2, 'Near broadleaf retains one trunk and one low-poly crown');
  assert.equal(entry.parts.some(part => part.mesh.geometry === adapter.visualAssets.geometries.dodeca), true,
    'Near broadleaf crown uses the angular DodecahedronGeometry');
  assert.equal(entry.parts.some(part => part.mesh.geometry === adapter.visualAssets.geometries.sphere), false,
    'Near broadleaf does not allocate a smooth SphereGeometry crown');
  await adapter.shutdown();
});

test('ambient Bush remains a Near-only decorative renderable with no gameplay-style state', async () => {
  const bush = Object.freeze({
    stableId: 'wf1:ambient-detail:near-decoration-bush',
    detailType: 'shrub',
    worldPosition: Object.freeze({ x: 8, y: 0.75, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 0, z: 0 }),
    rotationY: 0.4,
    variation: 1.1,
    destructible: false,
  });
  const chunk = {
    chunkX: 0, chunkZ: 0, chunkId: 'near-decoration-bush', contentHash: 'sha256:test',
    generatorVersion: { major: 800 },
    terrain: {
      resolution: { x: 2, z: 2 }, heights: [0, 0, 0, 0],
      heightUnitMeters: 0.001, materialWeights: new Array(20).fill(0),
    },
    vegetationCandidates: [], rockCandidates: [], waterSurfaces: [], ambientDetails: [bush],
    settlementFeatures: [], settlementLandmarks: [], streetDetails: [],
  };
  const canonical = resolveW8CanonicalWorldObject(bush);
  assert.equal(canonical.objectType, 'shrub');
  assert.equal(canonical.collision.shape, 'none');
  assert.equal(canonical.interaction.enabled, false);
  assert.equal(canonical.destruction.destructible, false);
  assert.equal(canonical.lodPolicy.outer, null);
  assert.equal(canonical.lodPolicy.far, null);

  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const projected = await adapter.projectChunk(chunk);
  await adapter.loadProjected(projected);
  const entry = adapter.featureInstances.get(bush.stableId);
  assert.ok(entry, 'ambient Bush must remain visible on the Near chunk path');
  assert.ok(entry.parts.length > 0);
  await adapter.shutdown();
});
