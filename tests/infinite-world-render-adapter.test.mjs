import test from 'node:test';
import assert from 'node:assert/strict';

import { ChunkRenderAdapter } from '../src/infinite-world/render/chunk-render-adapter.js';
import { resolveW8RockCanonicalObject } from '../src/infinite-world/rock-canonical-object.js';
import { createSandboxChunkGenerator } from '../src/infinite-world/sandbox-chunk-generator.js';
import { createCanonicalRiverProjection } from '../src/infinite-world/canonical-river-realization.js';
import { hashWorldSeed } from '../src/infinite-world/legacy-core/g0/seed.js';

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
    this.matrix = {};
  }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) { this.children = this.children.filter(value => value !== child); child.parent = null; }
  clear() { for (const child of this.children) child.parent = null; this.children = []; }
  updateMatrix() {
    this.matrix = {
      position: { x: this.position.x, y: this.position.y, z: this.position.z },
      rotation: { x: this.rotation.x, y: this.rotation.y, z: this.rotation.z },
      scale: { x: this.scale.x, y: this.scale.y, z: this.scale.z },
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
    this.instanceMatrix = { needsUpdate: false }; this.matrices = [];
  }
  setMatrixAt(index, matrix) { this.matrices[index] = structuredClone(matrix); }
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
  assert.notEqual(entry.mesh.matrices[entry.index].scale.x, 0);
  assert.equal(adapter.setFeatureDestroyed(stableId, true), true);
  assert.deepEqual(entry.mesh.matrices[entry.index].scale, { x: 0, y: 0, z: 0 });
  destroyed.add(stableId);
  adapter.refreshFeatureStates();
  assert.deepEqual(entry.mesh.matrices[entry.index].scale, { x: 0, y: 0, z: 0 });
  destroyed.delete(stableId);
  adapter.refreshFeatureStates();
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

test('Settlement projection preserves finite layer order and renders junction, entrance, and forecourt surfaces', async () => {
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
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
  assert.ok(junctionIndex > roadIndex);
  assert.ok(lotIndex > junctionIndex);
  assert.ok(buildingIndex > lotIndex);
  assert.ok(vegetationIndex > buildingIndex);
  const lotMesh = projected.group.children[lotIndex];
  assert.deepEqual(lotMesh.userData.surfaceKinds.sort(), ['entrance-path', 'forecourt']);
  assert.equal(lotMesh.count, 2);
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
