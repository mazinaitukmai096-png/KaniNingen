import test from 'node:test';
import assert from 'node:assert/strict';

import { ChunkRenderAdapter } from '../src/infinite-world/render/chunk-render-adapter.js';
import { createSandboxChunkGenerator } from '../src/infinite-world/sandbox-chunk-generator.js';

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
    assert.ok(projected.group.children.length >= 3 && projected.group.children.length <= 4);
    const projectedRenderableCount = projected.group.children.length;
    assert.deepEqual({ x: projected.group.position.x, z: projected.group.position.z }, { x: 0, z: 0 });
    await adapter.loadProjected(projected);
    assert.equal(adapter.resourceSnapshot().liveChunkGroups, 1);
    assert.equal(adapter.resourceSnapshot().chunkRenderables[`${iteration},${-iteration}`], projectedRenderableCount);
    await adapter.unloadChunk(`${iteration},${-iteration}`);
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

test('Settlement instances between camera and Player fade to 0.25 and restore next frame', async () => {
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
    camera: { position: { x: 0, y: 100, z: 0 } }, target: { x: 100, y: 0, z: 100 },
  }), 1);
  assert.deepEqual(first.mesh.matrices[first.index].scale, { x: 0, y: 0, z: 0 });
  assert.notEqual(first.fadeMesh.matrices[first.index].scale.x, 0);
  Raycaster.hits = [];
  assert.equal(adapter.updateCameraOcclusion({
    camera: { position: { x: 0, y: 100, z: 0 } }, target: { x: 100, y: 0, z: 100 },
  }), 0);
  assert.notEqual(first.mesh.matrices[first.index].scale.x, 0);
  assert.deepEqual(first.fadeMesh.matrices[first.index].scale, { x: 0, y: 0, z: 0 });
  const fadeMaterial = first.fadeMesh.material;
  await adapter.shutdown();
  assert.equal(fadeMaterial.disposed, true);
});

test('Camera collision resolves the desired camera position before the nearest Settlement wall', async () => {
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
  const entry = adapter.featureInstances.get(stableId);
  const camera = { position: new Triple().set(0, 0, 100) };
  Raycaster.hits = [{ object: entry.parts[0].mesh, instanceId: entry.parts[0].index, distance: 60 }];
  const result = adapter.resolveCameraCollision({
    camera,
    target: { x: 0, y: 0, z: 0 },
    clearanceMeters: 0.1,
  });
  assert.equal(result.collided, true);
  assert.equal(result.stableId, stableId);
  assert.equal(result.desiredDistance, 100);
  assert.equal(result.resolvedDistance, 34.4);
  assert.deepEqual({ x: camera.position.x, y: camera.position.y, z: camera.position.z }, {
    x: 0, y: 0, z: 34.4,
  });
  Raycaster.hits = [];
  await adapter.shutdown();
});
