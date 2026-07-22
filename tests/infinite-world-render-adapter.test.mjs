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

const FakeThree = {
  Group, PlaneGeometry, ConeGeometry, DodecahedronGeometry, BufferGeometry,
  Float32BufferAttribute, MeshLambertMaterial, LineBasicMaterial,
  Mesh, InstancedMesh, LineSegments, Object3D,
};

test('render adapter shares geometry/materials, releases chunk objects, and disposes shared resources only at shutdown', async () => {
  const generator = await createSandboxChunkGenerator({ worldSeed: 'renderer-resources' });
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const initialResources = adapter.resourceSnapshot();
  assert.equal(initialResources.sharedGeometryCount, 4);
  assert.equal(initialResources.sharedMaterialCount, 5);
  assert.equal(initialResources.sharedDisposed, false);

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const data = await generator.generateChunk(iteration, -iteration);
    await adapter.rebase({ renderOriginChunkX: iteration, renderOriginChunkZ: -iteration, rebaseCount: iteration });
    const projected = await adapter.projectChunk(data);
    assert.equal(projected.group.children.length, 4);
    assert.deepEqual({ x: projected.group.position.x, z: projected.group.position.z }, { x: 0, z: 0 });
    await adapter.loadProjected(projected);
    assert.equal(adapter.resourceSnapshot().liveChunkGroups, 1);
    assert.equal(adapter.resourceSnapshot().chunkRenderables[`${iteration},${-iteration}`], 4);
    await adapter.unloadChunk(`${iteration},${-iteration}`);
    const afterUnload = adapter.resourceSnapshot();
    assert.equal(afterUnload.liveChunkGroups, 0);
    assert.equal(afterUnload.sharedDisposed, false);
    assert.equal(afterUnload.sharedGeometryCount, 4);
    assert.equal(afterUnload.sharedMaterialCount, 5);
  }
  assert.equal(scene.children.includes(adapter.worldRoot), true);
  await adapter.shutdown();
  assert.equal(adapter.resourceSnapshot().sharedDisposed, true);
  assert.equal(scene.children.includes(adapter.worldRoot), false);
  assert.ok(Object.values(adapter.geometries).every(geometry => geometry.disposed));
  assert.ok(Object.values(adapter.materials).every(material => material.disposed));
  await adapter.shutdown();
});
