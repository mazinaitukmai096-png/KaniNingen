import test from 'node:test';
import assert from 'node:assert/strict';

import { ChunkRenderAdapter } from '../src/infinite-world/render/chunk-render-adapter.js';
import { resolveW8RockCanonicalObject } from '../src/infinite-world/rock-canonical-object.js';
import { resolveW8CanonicalWorldObject } from '../src/infinite-world/world-object-canonical-contract.js';
import { createSandboxChunkGenerator } from '../src/infinite-world/sandbox-chunk-generator.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import { createCanonicalRiverProjection } from '../src/infinite-world/canonical-river-realization.js';
import {
  DEFAULT_STREAMING_UPLOAD_BUDGET_BYTES,
  createProjectedUploadManifest,
  createThreeProjectedUploadStager,
} from '../src/infinite-world/render-upload-admission.js';
import { sampleW8SurfaceHeightMeters } from '../src/infinite-world/w8-surface-policy.js';
import { resolveW8LowPolyTreePresentationParts } from '../src/infinite-world/vegetation-lod-policy.js';
import { hashWorldSeed } from '../src/infinite-world/legacy-core/g0/seed.js';
import {
  createGpuAttributeMirror,
  createRenderFrameAcknowledger,
  createRendererGpuAttributeMirror,
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
  traverse(visitor) {
    visitor(this);
    for (const child of this.children) child.traverse(visitor);
  }
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
class BufferGeometry extends Geometry {
  setIndex(value) { this.index = value; }
  computeVertexNormals() { this.vertexNormalsComputed = true; }
}
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
    this.matrixWriteCount = 0;
  }
  setMatrixAt(index, matrix) {
    this.matrixWriteCount += 1;
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

function assertReferenceArray(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(actual[index], expected[index], `${label}[${index}] identity`);
  }
}

function snapshotPublishedRegistries(adapter) {
  return {
    featureInstances: [...adapter.featureInstances],
    chunkFeatureIds: [...adapter.chunkFeatureIds],
    occlusionMeshes: [...adapter.occlusionMeshes],
    cameraCollisionBounds: [...adapter.cameraCollisionBounds],
    transparentMeshes: [...adapter.transparentMeshes],
  };
}

function assertPublishedRegistries(adapter, expected, label) {
  assertReferenceArray([...adapter.featureInstances.keys()],
    expected.featureInstances.map(([key]) => key), `${label} feature keys`);
  assertReferenceArray([...adapter.featureInstances.values()],
    expected.featureInstances.map(([, value]) => value), `${label} feature values`);
  assertReferenceArray([...adapter.chunkFeatureIds.keys()],
    expected.chunkFeatureIds.map(([key]) => key), `${label} chunk keys`);
  assertReferenceArray([...adapter.chunkFeatureIds.values()],
    expected.chunkFeatureIds.map(([, value]) => value), `${label} chunk values`);
  assertReferenceArray(adapter.occlusionMeshes, expected.occlusionMeshes,
    `${label} occlusion meshes`);
  assertReferenceArray(adapter.cameraCollisionBounds, expected.cameraCollisionBounds,
    `${label} collision bounds`);
  assertReferenceArray([...adapter.transparentMeshes], expected.transparentMeshes,
    `${label} transparent meshes`);
}

function completeActualAdapterDraw({ adapter, scene, frames, frameSequence, draw = () => true }) {
  const token = frames.beginFrame({ frameSequence, scene });
  adapter.beginProjectedOwnerDrawFrame(frameSequence);
  try {
    scene.traverse(object => {
      if (!object?.geometry || !object?.material || !draw(object)) return;
      for (let current = object; current; current = current.parent) {
        if (current.visible === false) return;
      }
      object.onBeforeRender?.(null, scene, null, object.geometry, object.material, null);
    });
    adapter.completeProjectedOwnerDrawFrame(frameSequence);
    return frames.completeFrame(token, { scene });
  } catch (error) {
    adapter.abortProjectedOwnerDrawFrame(frameSequence);
    frames.abortFrame(token);
    throw error;
  }
}

function createPublicationTestChunk({
  chunkX = 0,
  chunkZ = 0,
  prefix = 'publication-test',
  naturalTerrain = false,
  includeRoad = false,
} = {}) {
  const terrainWidth = naturalTerrain ? 3 : 2;
  const terrainDepth = naturalTerrain ? 3 : 2;
  const terrainVertexCount = terrainWidth * terrainDepth;
  const building = {
    stableId: `${prefix}-building`,
    featureType: 'settlement-building',
    buildingType: 'house',
    worldPosition: { x: chunkX * 16 + 11, y: 0, z: chunkZ * 16 + 8 },
    rotationY: 0,
    widthMeters: 6.5,
    heightMeters: 4.5,
    depthMeters: 5.25,
  };
  const road = {
    stableId: `${prefix}-road-projection`,
    sourceStableId: `${prefix}-road-source`,
    featureType: 'settlement-road',
    widthMeters: 2,
    start: { x: chunkX * 16 + 2, z: chunkZ * 16 + 8 },
    end: { x: chunkX * 16 + 8, z: chunkZ * 16 + 8 },
    worldPosition: { x: chunkX * 16 + 5, y: 0, z: chunkZ * 16 + 8 },
  };
  return {
    chunkX,
    chunkZ,
    chunkId: `${prefix}-chunk`,
    contentHash: `sha256:${prefix}`,
    generatorVersion: { major: 800 },
    terrain: {
      resolution: { x: terrainWidth, z: terrainDepth },
      heights: new Array(terrainVertexCount).fill(0),
      heightUnitMeters: 0.001,
      materialWeights: Array.from({ length: terrainVertexCount }, () => (
        [1, 0, 0, 0, 0]
      )).flat(),
    },
    vegetationCandidates: [],
    rockCandidates: [],
    waterSurfaces: [],
    ambientDetails: [],
    settlementLandmarks: [],
    streetDetails: [],
    settlementFeatures: includeRoad ? [road, building] : [building],
  };
}

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

test('cooperative projection cancellation disposes partial owned geometry without publishing staged registries', async () => {
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const chunk = createPublicationTestChunk({
    chunkX: 7,
    chunkZ: -4,
    prefix: 'projection-cancel-cleanup',
    naturalTerrain: true,
  });
  const beforeResources = adapter.resourceSnapshot();
  const beforeRegistries = snapshotPublishedRegistries(adapter);
  let cancellationChecks = 0;

  await assert.rejects(
    () => adapter.projectChunk(chunk, null, {
      deferredRegistration: true,
      yieldToHost: async () => {},
      cooperativeSliceMs: 1_000_000,
      shouldCancel: () => {
        cancellationChecks += 1;
        return cancellationChecks >= 5;
      },
    }),
    error => {
      assert.equal(error?.code, 'CHUNK_PROJECTION_CANCELLED');
      assert.equal(error?.cancelled, true);
      return true;
    },
  );

  const afterResources = adapter.resourceSnapshot();
  assert.ok(cancellationChecks >= 5);
  assert.equal(afterResources.projectedCount, beforeResources.projectedCount);
  assert.equal(afterResources.chunkOwnedGeometriesCreated,
    beforeResources.chunkOwnedGeometriesCreated + 1);
  assert.equal(afterResources.chunkOwnedGeometriesDisposed,
    beforeResources.chunkOwnedGeometriesDisposed + 1);
  assert.equal(afterResources.liveChunkOwnedGeometryCount,
    beforeResources.liveChunkOwnedGeometryCount);
  assertPublishedRegistries(adapter, beforeRegistries, 'cancelled projection');
  assert.deepEqual(adapter.renderCoverageSnapshot().loadedKeys, []);

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

test('Near registry preflight rejects a late Stable-ID collision before publishing any staged entry', async () => {
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const liveChunk = createPublicationTestChunk({ prefix: 'transaction-live' });
  const candidateChunk = createPublicationTestChunk({
    chunkX: 1,
    prefix: 'transaction-candidate',
  });
  const live = await adapter.projectChunk(liveChunk, null, { deferredRegistration: true });
  await adapter.loadProjected(live);
  const candidate = await adapter.projectChunk(candidateChunk, null, {
    deferredRegistration: true,
  });
  const liveStableId = liveChunk.settlementFeatures[0].stableId;
  const uniqueStableId = candidateChunk.settlementFeatures[0].stableId;
  const uniqueEntry = candidate.registry.featureInstances.get(uniqueStableId);
  assert.ok(uniqueEntry);

  // Put a valid unique entry before the collision. The former progressive
  // commit leaked this first entry before discovering the second one.
  candidate.registry.featureInstances = new Map([
    [uniqueStableId, uniqueEntry],
    [liveStableId, { ...uniqueEntry, stableId: liveStableId }],
  ]);
  candidate.registry.chunkFeatureIds.set(candidate.key,
    new Set([uniqueStableId, liveStableId]));
  const registriesBefore = snapshotPublishedRegistries(adapter);
  const rootChildrenBefore = [...adapter.worldRoot.children];
  const resourcesBefore = adapter.resourceSnapshot();

  await assert.rejects(
    adapter.loadProjected(candidate),
    error => {
      assert.equal(error.code, 'CANONICAL_WORLD_INVARIANT');
      assert.equal(error.faultDomain, 'canonical-world');
      assert.equal(error.stage, 'render-registry-preflight');
      assert.equal(error.retryable, false);
      assert.match(error.message,
        new RegExp(`Stable ID collision in render adapter: ${liveStableId}`));
      return true;
    },
  );

  assert.equal(candidate.lifecycle, 'staged');
  assert.equal(candidate.group.parent ?? null, null);
  assert.equal(adapter.featureInstances.has(uniqueStableId), false,
    'the valid prefix before a collision must not leak into the live registry');
  assertPublishedRegistries(adapter, registriesBefore, 'collision preflight rollback');
  assertReferenceArray(adapter.worldRoot.children, rootChildrenBefore,
    'collision preflight world root');
  assert.deepEqual(adapter.resourceSnapshot(), resourcesBefore);

  await adapter.discardProjected(candidate);
  await adapter.unloadChunk(live.key);
  await adapter.shutdown();
});

test('Near publication quarantines a failing telemetry observer without rolling back canonical state', async () => {
  let recordCalls = 0;
  const adapter = new ChunkRenderAdapter({
    THREE: FakeThree,
    scene: new Scene(),
    telemetry: {
      enabled: true,
      record() {
        recordCalls += 1;
        throw new Error('injected telemetry observer failure');
      },
    },
  });
  const chunk = createPublicationTestChunk({ prefix: 'telemetry-observer-failure' });
  const projected = await adapter.projectChunk(chunk, null, { deferredRegistration: true });

  await adapter.loadProjected(projected);

  assert.equal(projected.lifecycle, 'loaded');
  assert.equal(adapter.loaded.get(projected.key), projected);
  assert.ok(adapter.featureInstances.size > 0);
  const resources = adapter.resourceSnapshot();
  assert.equal(resources.telemetryObserverEnabled, false);
  assert.equal(resources.telemetryObserverFailureCount, 1);
  assert.deepEqual(resources.lastTelemetryObserverFailure, {
    type: 'publish',
    name: 'Error',
    message: 'injected telemetry observer failure',
  });
  assert.equal(recordCalls, 1, 'the failing observer is circuit-broken after the first error');

  await adapter.unloadChunk(projected.key);
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

test('provisional Terrain manifest finalizes exactly and requires every owner upload target to be GPU-resident', async () => {
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const chunk = createPublicationTestChunk({
    prefix: 'effective-upload-manifest',
    naturalTerrain: true,
    includeRoad: true,
  });
  const provisional = await adapter.projectTerrainChunk(chunk);
  await adapter.loadProjectedTerrain(provisional);
  const full = await adapter.projectChunk(chunk, null, { deferredRegistration: true });
  const discardedFullTerrain = full.group.children.find(child => /terrain/.test(child.name));
  assert.ok(discardedFullTerrain);
  assert.notEqual(discardedFullTerrain, provisional.terrain);

  let now = 0;
  const frames = createRenderFrameAcknowledger({
    clock: () => ++now,
    gpuMirror: createGpuAttributeMirror(),
  });
  const provisionalReceipt = completeActualAdapterDraw({
    adapter,
    scene,
    frames,
    frameSequence: 1,
  });
  adapter.markFirstDraw(provisionalReceipt);
  const manifest = await adapter.finalizeProjectedUploadManifest(full, { generation: 41 });
  assert.equal(manifest.generation, 41);
  assert.equal(manifest.residentResourceProofs.length, 1);
  assert.deepEqual(manifest.residentResourceProofs[0], {
    ownerKey: full.key,
    resourceKind: 'provisional-terrain',
    frameSequence: provisionalReceipt.frameSequence,
    completedAtMs: provisionalReceipt.completedAtMs,
  });
  assert.equal(full.uploadManifestEffectiveTerrain, provisional.terrain);
  assert.equal(manifest.referencedSharedGeometryCount >= 1, true,
    'resident promoted Terrain is referenced, not counted as a new owner upload');

  const effectiveChildren = full.group.children.map(child => (
    child === discardedFullTerrain ? provisional.terrain : child
  ));
  const effectiveOwnedGeometries = new Set(full.ownedGeometries);
  effectiveOwnedGeometries.delete(discardedFullTerrain.geometry);
  const expected = createProjectedUploadManifest({
    ownerKey: full.key,
    generation: 41,
    root: { children: effectiveChildren },
    ownedGeometries: effectiveOwnedGeometries,
    residentResourceProofs: [{
      ownerKey: full.key,
      resourceKind: 'provisional-terrain',
      frameSequence: provisionalReceipt.frameSequence,
      completedAtMs: provisionalReceipt.completedAtMs,
    }],
  });
  assert.deepEqual(manifest, expected,
    'same-task promotion manifest has exact effective membership, byte totals, and buckets');

  full.uploadStagingProof = {
    manifest,
    bucketIndices: new Set(manifest.resourceBuckets.map(bucket => bucket.bucketIndex + 1000)),
  };
  await assert.rejects(adapter.loadProjected(full), error => {
    assert.match(error.message, /resources were not fully staged/);
    assert.equal(error.code, 'RUNTIME_WORLD_INVARIANT');
    assert.equal(error.faultDomain, 'render-invariant');
    assert.equal(error.stage, 'near-upload-manifest-invariant');
    assert.equal(error.retryable, false);
    return true;
  }, 'a same-sized forged bucket set cannot stand in for exact manifest-complete staging');
  assert.equal(full.lifecycle, 'staged');
  assert.equal(adapter.provisionalTerrain.get(full.key), provisional,
    'failed staging proof retains the last-known-good Terrain');
  delete full.uploadStagingProof;

  class UploadCamera extends NodeObject {
    constructor() {
      super();
      this.layers = { mask: 1 };
    }
  }
  class UploadTarget {
    constructor() { this.texture = {}; }
    dispose() { this.disposed = true; }
  }
  class UploadRenderer {
    constructor() {
      this.renderTarget = null;
      this.xr = { enabled: true };
      this.attributeVersions = new WeakMap();
      this.attributes = { get: attribute => this.attributeVersions.get(attribute) ?? null };
      this.drawCount = 0;
    }
    getRenderTarget() { return this.renderTarget; }
    getActiveCubeFace() { return 0; }
    getActiveMipmapLevel() { return 0; }
    setRenderTarget(target) { this.renderTarget = target; }
    render(root) {
      root.traverse(object => {
        for (let current = object; current; current = current.parent) {
          if (current.visible === false) return;
        }
        if (!object?.geometry || !object?.material) return;
        for (const attribute of [
          ...Object.values(object.geometry.attributes ?? {}),
          object.geometry.index,
          object.instanceMatrix,
          object.instanceColor,
        ]) {
          if (!attribute) continue;
          this.attributeVersions.set(attribute, {
            version: Number.isSafeInteger(attribute.version) ? attribute.version : 0,
          });
          attribute.onUploadCallback?.();
        }
        this.drawCount += 1;
        object.onBeforeRender?.(this, root, null, object.geometry, object.material, null);
      });
    }
  }
  const renderer = new UploadRenderer();
  const stager = createThreeProjectedUploadStager({
    THREE: {
      ...FakeThree,
      Scene,
      OrthographicCamera: UploadCamera,
      WebGLRenderTarget: UploadTarget,
    },
    renderer,
  });
  for (const bucket of manifest.resourceBuckets) {
    stager.stage({ projected: full, manifest, bucket });
  }
  assert.equal(stager.snapshot().stagedBytes, manifest.uploadBytes,
    'every owner-owned upload target is staged before world publication');
  assert.equal(manifest.uploadTargets.every(target => (
    renderer.attributes.get(target.attribute)?.version
      === (Number.isSafeInteger(target.attribute.version) ? target.attribute.version : 0)
  )), true, 'the detached renderer has uploaded every manifest target version');

  await adapter.loadProjected(full);
  assert.equal(full.group.children.includes(provisional.terrain), true);
  assert.equal(full.group.children.includes(discardedFullTerrain), false);

  const missingTarget = manifest.uploadTargets.at(-1).attribute;
  const incompleteFrames = createRenderFrameAcknowledger({
    clock: () => ++now,
    gpuMirror: {
      uploadFrame() { return null; },
      matches(attribute) { return attribute !== missingTarget; },
    },
  });
  const incompleteToken = incompleteFrames.beginFrame({ frameSequence: 2, scene });
  const incompleteReceipt = incompleteFrames.completeFrame(incompleteToken, { scene });
  assert.equal(adapter.projectedOwnerUploadProof(full.key, incompleteReceipt, manifest), false,
    'one cold owner-owned target prevents whole-owner acknowledgement');

  full.group.visible = false;
  renderer.drawCount = 0;
  const residentFrames = createRenderFrameAcknowledger({
    clock: () => ++now,
    gpuMirror: createRendererGpuAttributeMirror(),
  });
  const residentToken = residentFrames.beginFrame({ frameSequence: 3, scene });
  adapter.beginProjectedOwnerDrawFrame(3);
  renderer.render(scene);
  adapter.completeProjectedOwnerDrawFrame(3);
  const residentReceipt = residentFrames.completeFrame(residentToken, { scene, renderer });
  assert.equal(renderer.drawCount, 0, 'culled owner emits no world draw callback');
  assert.equal(adapter.projectedOwnerUploadProof(full.key, residentReceipt, manifest), true,
    'culled owner publication completes from exact scene membership and full GPU residency');
  assert.equal(full.uploadCompleteReceipt, residentReceipt);
  assert.equal(Object.hasOwn(full, 'firstDrawReceipt'), false,
    'resource admission must not manufacture an actual-draw receipt');
  assert.equal(adapter.resourceSnapshot().renderCoverage.loadedKeys.includes(full.key), true);
  await adapter.unloadChunk(full.key);
  await adapter.shutdown();
  stager.dispose();
});

test('private staged renderer uploads seed the GPU mirror when Three keeps WebGLAttributes private', async () => {
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const chunk = createPublicationTestChunk({
    prefix: 'private-webgl-attributes-upload-proof',
    naturalTerrain: true,
    includeRoad: true,
  });
  const projected = await adapter.projectChunk(chunk, null, { deferredRegistration: true });
  const manifest = await adapter.finalizeProjectedUploadManifest(projected, { generation: 45 });

  class UploadCamera extends NodeObject {
    constructor() {
      super();
      this.layers = { mask: 1 };
    }
  }
  class UploadTarget {
    constructor() { this.texture = {}; }
    dispose() { this.disposed = true; }
  }
  class PrivateAttributeRenderer {
    constructor() {
      this.renderTarget = null;
      this.xr = { enabled: true };
      this.uploadedVersions = new WeakMap();
      this.uploadCallbacks = 0;
      this.drawCount = 0;
      // Deliberately no public renderer.attributes. Three r160 keeps the
      // WebGLAttributes registry private, matching the production browser.
    }
    getRenderTarget() { return this.renderTarget; }
    getActiveCubeFace() { return 0; }
    getActiveMipmapLevel() { return 0; }
    setRenderTarget(target) { this.renderTarget = target; }
    render(root) {
      root.traverse(object => {
        for (let current = object; current; current = current.parent) {
          if (current.visible === false) return;
        }
        if (!object?.geometry || !object?.material) return;
        for (const attribute of [
          ...Object.values(object.geometry.attributes ?? {}),
          object.geometry.index,
          object.instanceMatrix,
          object.instanceColor,
        ]) {
          if (!attribute) continue;
          const version = Number.isSafeInteger(attribute.version) ? attribute.version : 0;
          if (this.uploadedVersions.get(attribute) === version) continue;
          this.uploadedVersions.set(attribute, version);
          this.uploadCallbacks += 1;
          attribute.onUploadCallback?.();
        }
        this.drawCount += 1;
        object.onBeforeRender?.(this, root, null, object.geometry, object.material, null);
      });
    }
  }

  const renderer = new PrivateAttributeRenderer();
  const gpuMirror = createRendererGpuAttributeMirror();
  const stager = createThreeProjectedUploadStager({
    THREE: {
      ...FakeThree,
      Scene,
      OrthographicCamera: UploadCamera,
      WebGLRenderTarget: UploadTarget,
    },
    renderer,
    gpuMirror,
  });
  for (const bucket of manifest.resourceBuckets) {
    stager.stage({ projected, manifest, bucket });
  }
  assert.equal(renderer.uploadCallbacks > 0, true,
    'the private staging render performs actual renderer uploads');
  assert.equal(manifest.uploadTargets.every(target => (
    gpuMirror.residentVersion(target.attribute)
      === (Number.isSafeInteger(target.attribute.version) ? target.attribute.version : 0)
      && gpuMirror.matches(target.attribute) === true
  )), true, 'private staging seeds exact target versions into the renderer GPU mirror');
  assert.equal(stager.snapshot().rendererUploadProofFailures, 0);

  await adapter.loadProjected(projected);
  projected.group.visible = false;
  const callbacksAfterStage = renderer.uploadCallbacks;
  let now = 0;
  const frames = createRenderFrameAcknowledger({ clock: () => ++now, gpuMirror });
  const token = frames.beginFrame({ frameSequence: 1, scene });
  adapter.beginProjectedOwnerDrawFrame(1);
  renderer.render(scene);
  adapter.completeProjectedOwnerDrawFrame(1);
  const receipt = frames.completeFrame(token, { scene, renderer });
  assert.equal(renderer.uploadCallbacks, callbacksAfterStage,
    'the world frame does not re-upload already resident private-staged attributes');
  assert.equal(adapter.projectedOwnerUploadProof(projected.key, receipt, manifest), true,
    'scene membership plus the private-stage GPU proof admits the owner without public WebGLAttributes');

  await adapter.unloadChunk(projected.key);
  await adapter.shutdown();
  stager.dispose();
});

test('a completed receipt cannot prove an owner attached after that frame completed', async () => {
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const chunk = createPublicationTestChunk({
    prefix: 'receipt-scene-snapshot',
    naturalTerrain: true,
    includeRoad: true,
  });
  const projected = await adapter.projectChunk(chunk, null, { deferredRegistration: true });
  const manifest = await adapter.finalizeProjectedUploadManifest(projected, { generation: 44 });
  projected.uploadStagingProof = {
    manifest,
    bucketIndices: new Set(manifest.resourceBuckets.map(bucket => bucket.bucketIndex)),
  };

  const gpuMirror = createGpuAttributeMirror();
  for (const target of manifest.uploadTargets) gpuMirror.uploadAttribute(target.attribute);
  let now = 0;
  const frames = createRenderFrameAcknowledger({ clock: () => ++now, gpuMirror });
  const oldToken = frames.beginFrame({ frameSequence: 1, scene });
  const oldReceipt = frames.completeFrame(oldToken, { scene });
  assert.equal(scene.children.includes(projected.group), false,
    'the owner is detached when the old frame completes');

  await adapter.loadProjected(projected);
  assert.equal(scene.children.includes(adapter.worldRoot), true);
  assert.equal(adapter.projectedOwnerUploadProof(projected.key, oldReceipt, manifest), false,
    'mutating the same Scene after completion cannot backfill old receipt evidence');
  assert.equal(Object.hasOwn(projected, 'uploadCompleteReceipt'), false);

  projected.group.visible = false;
  const currentToken = frames.beginFrame({ frameSequence: 2, scene });
  const currentReceipt = frames.completeFrame(currentToken, { scene });
  assert.equal(adapter.projectedOwnerUploadProof(projected.key, currentReceipt, manifest), true,
    'the next completed frame snapshots the exact owner and all resident targets');
  assert.equal(Object.hasOwn(projected, 'firstDrawReceipt'), false,
    'residency proof remains separate from continuity actual-draw evidence');
  const changedAfterReceipt = manifest.uploadTargets[0].attribute;
  changedAfterReceipt.version = (changedAfterReceipt.version ?? 0) + 1;
  assert.equal(adapter.projectedOwnerUploadProof(projected.key, currentReceipt, manifest), false,
    'an immutable receipt cannot prove a target version changed after completion');

  await adapter.unloadChunk(projected.key);
  await adapter.shutdown();
});

test('culled provisional Terrain is privately staged and survives supersede/reversal without a draw waiter', async () => {
  const scene = new Scene();
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene });
  const chunk = createPublicationTestChunk({
    prefix: 'culled-provisional-private-stage',
    naturalTerrain: true,
    includeRoad: true,
  });
  const provisional = await adapter.projectTerrainChunk(chunk);
  await adapter.loadProjectedTerrain(provisional);
  provisional.group.visible = false;
  provisional.terrain.visible = false;
  const provisionalChildren = [...provisional.group.children];
  const superseded = await adapter.projectChunk(chunk, null, { deferredRegistration: true });
  const supersededChildren = [...superseded.group.children];
  const discardedTerrain = superseded.group.children.find(child => /terrain/.test(child.name));
  let timeoutId;
  const manifest = await Promise.race([
    adapter.finalizeProjectedUploadManifest(superseded, { generation: 42 }),
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('culled provisional manifest deadlocked')), 250);
    }),
  ]);
  clearTimeout(timeoutId);
  assert.deepEqual(manifest.residentResourceProofs, [],
    'a culled provisional has no fabricated world-draw receipt');
  assert.equal(superseded.uploadManifestEffectiveTerrainRequiresUpload, true);
  const provisionalAttributes = new Set([
    ...Object.values(provisional.terrain.geometry.attributes ?? {}),
    provisional.terrain.geometry.index,
  ].filter(Boolean));
  const discardedAttributes = new Set([
    ...Object.values(discardedTerrain.geometry.attributes ?? {}),
    discardedTerrain.geometry.index,
  ].filter(Boolean));
  assert.equal([...provisionalAttributes].every(attribute => (
    manifest.uploadTargets.some(target => target.attribute === attribute)
  )), true, 'the exact provisional Terrain buffers become manifest upload targets');
  assert.equal(manifest.uploadTargets.every(target => !discardedAttributes.has(target.attribute)), true,
    'the discarded full Terrain never enters the effective upload manifest');

  class UploadCamera extends NodeObject {
    constructor() { super(); this.layers = { mask: 1 }; }
  }
  class UploadTarget {
    constructor() { this.texture = {}; }
    dispose() { this.disposed = true; }
  }
  class UploadRenderer {
    constructor() {
      this.renderTarget = null;
      this.xr = { enabled: true };
      this.attributeVersions = new WeakMap();
      this.attributes = { get: attribute => this.attributeVersions.get(attribute) ?? null };
    }
    getRenderTarget() { return this.renderTarget; }
    getActiveCubeFace() { return 0; }
    getActiveMipmapLevel() { return 0; }
    setRenderTarget(target) { this.renderTarget = target; }
    render(root) {
      root.traverse(object => {
        for (let current = object; current; current = current.parent) {
          if (current.visible === false) return;
        }
        if (!object?.geometry || !object?.material) return;
        for (const attribute of [
          ...Object.values(object.geometry.attributes ?? {}),
          object.geometry.index,
          object.instanceMatrix,
          object.instanceColor,
        ]) {
          if (!attribute) continue;
          this.attributeVersions.set(attribute, {
            version: Number.isSafeInteger(attribute.version) ? attribute.version : 0,
          });
          attribute.onUploadCallback?.();
        }
      });
    }
  }
  const renderer = new UploadRenderer();
  const stager = createThreeProjectedUploadStager({
    THREE: {
      ...FakeThree,
      Scene,
      OrthographicCamera: UploadCamera,
      WebGLRenderTarget: UploadTarget,
    },
    renderer,
  });
  for (const bucket of manifest.resourceBuckets) {
    stager.stage({ projected: superseded, manifest, bucket });
    assertReferenceArray(provisional.group.children, provisionalChildren,
      'culled provisional children after synchronous staging');
    assertReferenceArray(superseded.group.children, supersededChildren,
      'staged Full children after synchronous staging');
    assert.equal(provisional.terrain.parent, provisional.group);
    assert.equal(provisional.group.parent, adapter.worldRoot,
      'the existing canonical Terrain is restored before control returns');
  }
  await adapter.discardProjected(superseded);
  assert.equal(adapter.provisionalTerrain.get(provisional.key), provisional,
    'superseding staged Full preserves the last-known-good Terrain owner');
  assertReferenceArray(provisional.group.children, provisionalChildren,
    'provisional children after supersede');

  const returning = await adapter.projectChunk(chunk, null, { deferredRegistration: true });
  const returningManifest = await adapter.finalizeProjectedUploadManifest(returning, {
    generation: 43,
  });
  for (const bucket of returningManifest.resourceBuckets) {
    stager.stage({ projected: returning, manifest: returningManifest, bucket });
  }
  await adapter.loadProjected(returning);
  assert.equal(returning.group.children.includes(provisional.terrain), true);
  assert.deepEqual(adapter.renderCoverageSnapshot().provisionalTerrainKeys, []);
  assert.deepEqual(adapter.renderCoverageSnapshot().loadedKeys, [returning.key]);

  returning.group.visible = false;
  let now = 0;
  const frames = createRenderFrameAcknowledger({
    clock: () => ++now,
    gpuMirror: createRendererGpuAttributeMirror(),
  });
  const token = frames.beginFrame({ frameSequence: 1, scene });
  renderer.render(scene);
  const receipt = frames.completeFrame(token, { scene, renderer });
  assert.equal(adapter.projectedOwnerUploadProof(
    returning.key, receipt, returningManifest,
  ), true, 'culled promotion completes from private-stage residency without onBeforeRender');
  assert.equal(adapter.resourceSnapshot().projectedUploadManifestWaiterCancellationCount, 0,
    'normal operation no longer creates a provisional draw waiter');
  await adapter.unloadChunk(returning.key);
  await adapter.shutdown();
  stager.dispose();
});

test('Near load rolls back provisional promotion and every registry/scene mutation, then retries cleanly', async () => {
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const chunk = createPublicationTestChunk({
    prefix: 'transaction-provisional',
    naturalTerrain: true,
  });
  const provisional = await adapter.projectTerrainChunk(chunk);
  await adapter.loadProjectedTerrain(provisional);
  const projected = await adapter.projectChunk(chunk, null, { deferredRegistration: true });
  const projectedTerrain = projected.group.children.find(child => /terrain/.test(child.name));
  const lateFaultChild = projected.group.children.find(child => child !== projectedTerrain);
  assert.ok(projectedTerrain);
  assert.ok(lateFaultChild, 'fixture must reach a post-publication child scan');
  const projectedChildrenBefore = [...projected.group.children];
  const provisionalChildrenBefore = [...provisional.group.children];
  const rootChildrenBefore = [...adapter.worldRoot.children];
  const ownedGeometriesBefore = projected.ownedGeometries;
  const registriesBefore = snapshotPublishedRegistries(adapter);
  const resourcesBefore = adapter.resourceSnapshot();
  const projectedPositionBefore = {
    x: projected.group.position.x,
    y: projected.group.position.y,
    z: projected.group.position.z,
  };

  const assertRolledBack = label => {
    assert.equal(projected.lifecycle, 'staged', `${label} projected lifecycle`);
    assert.equal(provisional.lifecycle, 'provisional', `${label} provisional lifecycle`);
    assert.equal(adapter.loaded.has(projected.key), false, `${label} loaded registry`);
    assert.equal(adapter.provisionalTerrain.get(projected.key), provisional,
      `${label} provisional registry`);
    assert.equal(projected.ownedGeometries, ownedGeometriesBefore,
      `${label} owned geometry array identity`);
    assert.equal(Object.hasOwn(projected, 'promotedTerrain'), false,
      `${label} promoted Terrain marker`);
    assert.deepEqual({
      x: projected.group.position.x,
      y: projected.group.position.y,
      z: projected.group.position.z,
    }, projectedPositionBefore, `${label} projected position`);
    assertReferenceArray(projected.group.children, projectedChildrenBefore,
      `${label} projected children`);
    assertReferenceArray(provisional.group.children, provisionalChildrenBefore,
      `${label} provisional children`);
    assertReferenceArray(adapter.worldRoot.children, rootChildrenBefore,
      `${label} world root`);
    assert.equal(projectedTerrain.parent, projected.group, `${label} projected Terrain parent`);
    assert.equal(provisional.terrain.parent, provisional.group,
      `${label} provisional Terrain parent`);
    assert.equal(projectedTerrain.geometry.disposed, false,
      `${label} projected Terrain geometry remains retryable`);
    assert.equal(provisional.terrain.geometry.disposed, false,
      `${label} provisional Terrain geometry remains live`);
    assertPublishedRegistries(adapter, registriesBefore, `${label} registries`);
    assert.deepEqual(adapter.resourceSnapshot(), resourcesBefore, `${label} resources`);
  };

  const originalWorldRootAdd = adapter.worldRoot.add;
  let failScenePublication = true;
  adapter.worldRoot.add = function addWithPublicationFault(child) {
    originalWorldRootAdd.call(this, child);
    if (failScenePublication && child === projected.group) {
      failScenePublication = false;
      throw new Error('injected Near scene publication failure');
    }
  };
  await assert.rejects(adapter.loadProjected(projected), /injected Near scene publication failure/);
  adapter.worldRoot.add = originalWorldRootAdd;
  assertRolledBack('scene-add fault');

  const userDataDescriptor = Object.getOwnPropertyDescriptor(lateFaultChild, 'userData');
  let lateUserData = lateFaultChild.userData;
  let failLatePublication = true;
  Object.defineProperty(lateFaultChild, 'userData', {
    configurable: true,
    enumerable: userDataDescriptor.enumerable,
    get() {
      if (failLatePublication) {
        failLatePublication = false;
        throw new Error('injected Near post-ownership failure');
      }
      return lateUserData;
    },
    set(value) { lateUserData = value; },
  });
  await assert.rejects(adapter.loadProjected(projected), /injected Near post-ownership failure/);
  Object.defineProperty(lateFaultChild, 'userData', userDataDescriptor);
  assertRolledBack('post-ownership fault');

  await adapter.loadProjected(projected);
  assert.equal(projected.lifecycle, 'loaded');
  assert.equal(projected.promotedTerrain, provisional);
  assert.equal(projected.group.children.includes(provisional.terrain), true);
  assert.equal(projected.group.children.includes(projectedTerrain), false);
  assert.equal(projectedTerrain.geometry.disposed, false,
    'publication does not irreversibly dispose superseded Terrain');
  assert.equal(projected.ownedGeometries.includes(provisional.terrain.geometry), true);
  assert.equal(projected.ownedGeometries.includes(projectedTerrain.geometry), true,
    'detached Terrain remains owned until the normal disposal boundary');

  await adapter.retainTerrainChunk(projected.key);
  assert.equal(projectedTerrain.geometry.disposed, true,
    'retainTerrainChunk reclaims the detached Terrain exactly once');
  assert.equal(provisional.terrain.geometry.disposed, false);
  await adapter.unloadProvisionalTerrain(projected.key);
  assert.equal(provisional.terrain.geometry.disposed, true);
  const resourcesAfterUnload = adapter.resourceSnapshot();
  assert.equal(resourcesAfterUnload.liveChunkOwnedGeometryCount, 0);
  assert.equal(resourcesAfterUnload.chunkOwnedGeometriesCreated,
    resourcesAfterUnload.chunkOwnedGeometriesDisposed);
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
  const initialMatrixWrites = entry.parts.reduce(
    (sum, part) => sum + part.mesh.matrixWriteCount, 0,
  );
  assert.equal(adapter.setFeatureDestroyed(stableId, false), true);
  assert.equal(entry.parts.reduce((sum, part) => sum + part.mesh.matrixWriteCount, 0),
    initialMatrixWrites,
    'an unchanged canonical damage state performs no matrix writes');
  assert.equal(adapter.setFeatureDestroyed(stableId, true), true);
  const destroyedMatrixWrites = entry.parts.reduce(
    (sum, part) => sum + part.mesh.matrixWriteCount, 0,
  );
  assert.equal(adapter.setFeatureDestroyed(stableId, true), true);
  assert.equal(entry.parts.reduce((sum, part) => sum + part.mesh.matrixWriteCount, 0),
    destroyedMatrixWrites,
    'repeating the same destroyed state does not invalidate instance buffers');
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
  assert.equal(Object.isFrozen(projected.uploadManifest), true);
  assert.equal(projected.uploadManifest.ownerKey, '0,0');
  assert.equal(projected.uploadManifest.meshCount, projected.group.children.length,
    'the manifest describes only the initially drawable owner resources');
  await adapter.loadProjected(projected);
  const entry = adapter.featureInstances.get(stableId);
  assert.ok(entry.parts.every(part => part.fadeMesh === null));
  assert.equal(adapter.transparentMeshes.size, 0,
    'a zero-occlusion owner must not allocate or upload a duplicate fade buffer');
  const first = entry.parts[0];
  Raycaster.hits = [{ object: first.mesh, instanceId: first.index }];
  assert.equal(adapter.updateCameraOcclusion({
    camera: { position: { x: 0, y: 100, z: 0 } }, target: { x: 100, y: 0, z: 100 }, nowMs: 1_000,
  }), 1);
  assert.ok(first.fadeMesh, 'the first actual occlusion lazily materializes the fade mesh');
  assert.equal(first.fadeMesh.material.options.opacity, 0.25);
  assert.equal(first.fadeMesh.material.options.depthWrite, false);
  assert.equal(adapter.transparentMeshes.size, new Set(entry.parts.map(part => part.fadeMesh)).size,
    'each affected Building resource bucket materializes exactly one fade buffer');
  assert.deepEqual(first.mesh.matrices[first.index].scale, { x: 0, y: 0, z: 0 });
  assert.notEqual(first.fadeMesh.matrices[first.index].scale.x, 0);
  const occludedMatrixWrites = entry.parts.reduce((sum, part) => (
    sum + part.mesh.matrixWriteCount + part.fadeMesh.matrixWriteCount
  ), 0);
  assert.equal(adapter.setFeatureOccluded(stableId, true), true);
  assert.equal(entry.parts.reduce((sum, part) => (
    sum + part.mesh.matrixWriteCount + part.fadeMesh.matrixWriteCount
  ), 0), occludedMatrixWrites,
  'unchanged occlusion membership performs no matrix or buffer invalidation');
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
  const bound = adapter.cameraCollisionBounds.find(value => value.stableId === stableId);
  const clearance = 0.1 * adapter.unitsPerMeter;
  const boundCenterX = bound.worldX * adapter.unitsPerMeter;
  const boundCenterZ = bound.worldZ * adapter.unitsPerMeter;
  const entryT = Math.max(
    (boundCenterX - bound.halfWidth - clearance) / 2_048,
    (boundCenterZ - bound.halfDepth - clearance) / 2_048,
  );
  const expectedT = Math.max(0, entryT - 1e-7);
  const expectedCamera = {
    x: 2_048 * expectedT,
    y: 320 * expectedT,
    z: 2_048 * expectedT,
  };
  assert.ok(Math.abs(result.resolvedDistance - Math.hypot(
    expectedCamera.x,
    expectedCamera.y,
    expectedCamera.z,
  )) < 1e-9);
  assert.ok(Math.abs(camera.position.x - expectedCamera.x) < 1e-9);
  assert.ok(Math.abs(camera.position.y - expectedCamera.y) < 1e-9);
  assert.ok(Math.abs(camera.position.z - expectedCamera.z) < 1e-9);
  assert.ok(camera.position.x < boundCenterX - bound.halfWidth,
    'the resolved camera must sit outside the penetrated Building bound');
  assert.ok(Math.abs(camera.position.x / 2_048 - camera.position.y / 320) < 1e-12,
    'collision resolution must preserve the intended target-to-camera line');
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
  const firstReceipt = frameAcknowledger.completeFrame(frameToken, { scene });
  adapter.markFirstDraw(firstReceipt);
  assert.equal(adapter.drawableStableIdsSnapshot().includes('tree-after-town'), true,
    'completed scene receipt publishes the actually drawn Near Stable ID');
  assert.deepEqual(adapter.drawableStableIdsSnapshot(),
    adapter.drawableStableIdsFullScanSnapshot(firstReceipt),
  'owner-indexed receipt identity must equal the retained full-scan oracle');
  const firstDrawableSnapshot = adapter.drawableStableIdsSnapshot();
  const firstReceiptIndexCounts = adapter.resourceSnapshot().drawableReceiptIndexCounts;
  const unchangedFrame = frameAcknowledger.beginFrame({ frameSequence: 2 });
  const unchangedReceipt = frameAcknowledger.completeFrame(unchangedFrame, { scene });
  adapter.markFirstDraw(unchangedReceipt);
  const unchangedReceiptIndexCounts = adapter.resourceSnapshot().drawableReceiptIndexCounts;
  assert.equal(adapter.drawableStableIdsSnapshot(), firstDrawableSnapshot,
    'an unchanged owner receipt reuses the immutable Stable ID snapshot');
  assert.equal(unchangedReceiptIndexCounts.ownerRecomputes,
    firstReceiptIndexCounts.ownerRecomputes,
  'unchanged owners avoid per-feature and per-part scans');
  assert.ok(unchangedReceiptIndexCounts.ownerFastProofs
    > firstReceiptIndexCounts.ownerFastProofs);
  assert.deepEqual(adapter.drawableStableIdsSnapshot(),
    adapter.drawableStableIdsFullScanSnapshot(unchangedReceipt));
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
  const destroyedFrame = frameAcknowledger.beginFrame({ frameSequence: 3 });
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
  const receiptProvenReturn = await adapter.projectChunk(chunk, null, {
    deferredRegistration: true,
  });
  await adapter.loadProjected(receiptProvenReturn);
  assert.equal(adapter.presentationHoldSnapshot().length, 1,
    'without a visual registry, OLD still survives until returning Near actually draws');
  const returnFrames = createRenderFrameAcknowledger({
    clock: () => 2,
    gpuMirror: createGpuAttributeMirror(),
  });
  const returnToken = returnFrames.beginFrame({ frameSequence: 1 });
  adapter.markFirstDraw(returnFrames.completeFrame(returnToken, { scene }));
  assert.equal(adapter.presentationHoldSnapshot().length, 0);
  await adapter.unloadChunk('0,0');
  await adapter.shutdown();
  assert.equal(adapter.presentationHoldSnapshot().length, 0);
});

test('failed returning Near publication preserves its Settlement hold and retries without orphaning geometry', async () => {
  const scene = new Scene();
  const visualRegistry = createVisualContinuityRegistry({ clock: () => 1 });
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene, visualRegistry });
  const chunk = createPublicationTestChunk({
    prefix: 'transaction-hold',
    includeRoad: true,
  });
  visualRegistry.expect({ ownerKey: '0,0', expectedAt: 1 });
  const initial = await adapter.projectChunk(chunk, null, { deferredRegistration: true });
  const heldRoadGeometry = initial.group.children
    .find(child => child.name === 'infinite-settlement-roads').geometry;
  await adapter.loadProjected(initial);
  await adapter.unloadChunk(initial.key, { deferSettlementPresentation: true });
  const hold = adapter.settlementPresentationHolds.get(initial.key);
  assert.ok(hold);
  assert.equal(heldRoadGeometry.disposed, false);

  const returning = await adapter.projectChunk(chunk, null, { deferredRegistration: true });
  const returningRoadGeometry = returning.group.children
    .find(child => child.name === 'infinite-settlement-roads').geometry;
  const returningChildrenBefore = [...returning.group.children];
  const returningOwnedBefore = returning.ownedGeometries;
  const rootChildrenBefore = [...adapter.worldRoot.children];
  const registriesBefore = snapshotPublishedRegistries(adapter);
  const resourcesBefore = adapter.resourceSnapshot();
  const holdSnapshotBefore = adapter.presentationHoldSnapshot();
  const barrierSnapshotBefore = adapter.settlementReplacementBarrier.snapshot();

  const assertHoldRollback = label => {
    assert.equal(returning.lifecycle, 'staged', `${label} lifecycle`);
    assert.equal(adapter.loaded.has(returning.key), false, `${label} loaded registry`);
    assert.equal(returning.ownedGeometries, returningOwnedBefore,
      `${label} owned geometry identity`);
    assert.equal(Object.hasOwn(returning, 'settlementReplacementHold'), false,
      `${label} replacement marker`);
    assertReferenceArray(returning.group.children, returningChildrenBefore,
      `${label} returning children`);
    assertReferenceArray(adapter.worldRoot.children, rootChildrenBefore,
      `${label} world root`);
    assert.equal(returning.group.parent ?? null, null, `${label} scene parent`);
    assert.equal(adapter.settlementPresentationHolds.get(initial.key), hold,
      `${label} retained OLD drawable identity`);
    assert.deepEqual(adapter.presentationHoldSnapshot(), holdSnapshotBefore,
      `${label} hold snapshot`);
    assert.deepEqual(adapter.settlementReplacementBarrier.snapshot(), barrierSnapshotBefore,
      `${label} barrier ownership`);
    assert.equal(adapter.settlementReplacementBarrierLeases.size, 0,
      `${label} barrier lease registry`);
    assert.equal(hold.lifecycle, 'held', `${label} hold lifecycle`);
    assert.equal(heldRoadGeometry.disposed, false, `${label} held Road geometry`);
    assert.equal(returningRoadGeometry.disposed, false, `${label} returning Road geometry`);
    assertPublishedRegistries(adapter, registriesBefore, `${label} registries`);
    assert.deepEqual(adapter.resourceSnapshot(), resourcesBefore, `${label} resources`);
  };

  const originalWorldRootAdd = adapter.worldRoot.add;
  let failReturningPublication = true;
  adapter.worldRoot.add = function addWithReturningOwnerFault(child) {
    originalWorldRootAdd.call(this, child);
    if (failReturningPublication && child === returning.group) {
      failReturningPublication = false;
      throw new Error('injected returning Near publication failure');
    }
  };
  await assert.rejects(
    adapter.loadProjected(returning),
    /injected returning Near publication failure/,
  );
  adapter.worldRoot.add = originalWorldRootAdd;
  assertHoldRollback('scene-add fault');

  const replacementBarrier = adapter.settlementReplacementBarrier;
  let failBarrierRetain = true;
  adapter.settlementReplacementBarrier = {
    retain(options) {
      const retained = replacementBarrier.retain(options);
      if (failBarrierRetain) {
        failBarrierRetain = false;
        throw new Error('injected replacement barrier retain failure');
      }
      return retained;
    },
    acknowledgeReplacement: options => replacementBarrier.acknowledgeReplacement(options),
    release: ownerKey => replacementBarrier.release(ownerKey),
    snapshot: () => replacementBarrier.snapshot(),
  };
  await assert.rejects(
    adapter.loadProjected(returning),
    /injected replacement barrier retain failure/,
  );
  adapter.settlementReplacementBarrier = replacementBarrier;
  assertHoldRollback('barrier-retain fault');

  await adapter.loadProjected(returning);
  assert.equal(returning.lifecycle, 'loaded');
  assert.equal(adapter.settlementPresentationHolds.get(initial.key), hold);
  assert.deepEqual(adapter.settlementReplacementBarrier.snapshot(), {
    retainedOwnerCount: 1,
    retainedOwnerKeys: [initial.key],
  });
  assert.equal(adapter.settlementReplacementBarrierLeases.size, 1);
  assert.equal(heldRoadGeometry.disposed, false,
    'a committed Near owner still waits for receipt-backed replacement');
  assert.equal(returningRoadGeometry.disposed, false);

  visualRegistry.retire({ ownerKey: initial.key, at: 2 });
  const frames = createRenderFrameAcknowledger({
    clock: () => 2,
    gpuMirror: createGpuAttributeMirror(),
  });
  const token = frames.beginFrame({ frameSequence: 1 });
  adapter.markFirstDraw(frames.completeFrame(token, { scene }));
  assert.equal(adapter.settlementPresentationHolds.has(initial.key), false);
  assert.equal(adapter.settlementReplacementBarrier.snapshot().retainedOwnerCount, 0);
  assert.equal(adapter.settlementReplacementBarrierLeases.size, 0);
  assert.equal(heldRoadGeometry.disposed, true,
    'receipt-backed replacement releases the stale hold exactly once');
  await adapter.unloadChunk(returning.key);
  assert.equal(returningRoadGeometry.disposed, true);
  await adapter.shutdown();
});

test('publication batch defers replacement acknowledgement and rollback preserves the proven OLD hold', async () => {
  let now = 1;
  const scene = new Scene();
  const visualRegistry = createVisualContinuityRegistry({ clock: () => now });
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene, visualRegistry });
  const chunk = createPublicationTestChunk({ prefix: 'batch-hold', includeRoad: true });
  visualRegistry.expect({ ownerKey: '0,0', expectedAt: now });
  const initial = await adapter.projectChunk(chunk, null, { deferredRegistration: true });
  const oldRoadGeometry = initial.group.children
    .find(child => child.name === 'infinite-settlement-roads').geometry;
  await adapter.loadProjected(initial);
  await adapter.unloadChunk(initial.key, { deferSettlementPresentation: true });
  assert.equal(adapter.presentationHoldSnapshot().length, 1);

  const frames = createRenderFrameAcknowledger({ clock: () => now });
  const returning = await adapter.projectChunk(chunk, null, { deferredRegistration: true });
  const failedBatch = adapter.beginProjectedPublicationBatch({
    batchId: 'returning-near-failed', ownerKeys: [returning.key],
  });
  await adapter.loadProjected(returning);
  visualRegistry.retire({ ownerKey: returning.key, at: ++now });
  let token = frames.beginFrame({ frameSequence: 1 });
  adapter.markFirstDraw(frames.completeFrame(token, { scene }));
  assert.equal(adapter.presentationHoldSnapshot().length, 1,
    'a receipt inside an uncommitted multi-owner batch cannot release OLD');
  assert.equal(oldRoadGeometry.disposed, false);

  assert.equal(adapter.rollbackProjectedPublicationBatch(failedBatch), true);
  assert.equal(adapter.settlementReplacementBarrierLeases.size, 0);
  await adapter.unloadChunk(returning.key);
  assert.equal(adapter.presentationHoldSnapshot().length, 1);
  assert.equal(oldRoadGeometry.disposed, false,
    'rolling back NEW leaves the receipt-proven OLD geometry retryable');

  const retry = await adapter.projectChunk(chunk, null, { deferredRegistration: true });
  const committedBatch = adapter.beginProjectedPublicationBatch({
    batchId: 'returning-near-committed', ownerKeys: [retry.key],
  });
  await adapter.loadProjected(retry);
  token = frames.beginFrame({ frameSequence: 2 });
  adapter.markFirstDraw(frames.completeFrame(token, { scene }));
  assert.equal(adapter.presentationHoldSnapshot().length, 1);
  assert.equal(adapter.commitProjectedPublicationBatch(committedBatch), true);
  assert.equal(adapter.presentationHoldSnapshot().length, 1,
    'commit itself does not reuse a stale receipt or mutate the scene');
  token = frames.beginFrame({ frameSequence: 3 });
  adapter.markFirstDraw(frames.completeFrame(token, { scene }));
  assert.equal(adapter.presentationHoldSnapshot().length, 0,
    'the first post-commit renderer receipt releases OLD');
  assert.equal(oldRoadGeometry.disposed, true);
  await adapter.unloadChunk(retry.key);
  await adapter.shutdown();
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

test('production Settlement/Road witness Near manifests stay within one 512KiB rendered frame', async t => {
  const generator = await createW8ParityChunkGenerator({
    worldSeed: 'KaniNingen Infinite Natural World',
  });
  const adapter = new ChunkRenderAdapter({ THREE: FakeThree, scene: new Scene() });
  const witnesses = [
    { label: 'road-heavy', centerX: 55, centerZ: 77 },
    { label: 'building', centerX: 58, centerZ: 71 },
  ];
  const measurements = [];
  try {
    let generation = 1;
    for (const witness of witnesses) {
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const chunkX = witness.centerX + dx;
          const chunkZ = witness.centerZ + dz;
          const data = await generator.generateChunk(chunkX, chunkZ);
          const projected = await adapter.projectChunk(data, null, {
            deferredRegistration: true,
          });
          const manifest = await adapter.finalizeProjectedUploadManifest(projected, {
            generation: generation++,
          });
          measurements.push(Object.freeze({
            witness: witness.label,
            ownerKey: projected.key,
            uploadBytes: manifest.uploadBytes,
            maximumBucketBytes: Math.max(
              0,
              ...manifest.resourceBuckets.map(bucket => bucket.byteLength),
            ),
            meshCount: manifest.meshCount,
            geometryCount: manifest.geometryCount,
            bucketCount: manifest.resourceBuckets.length,
          }));
          assert.equal(manifest.uploadBytes <= DEFAULT_STREAMING_UPLOAD_BUDGET_BYTES, true,
            `${witness.label} owner ${projected.key} requires ${manifest.uploadBytes} bytes`);
          assert.equal(manifest.resourceBuckets.every(bucket => (
            bucket.byteLength <= DEFAULT_STREAMING_UPLOAD_BUDGET_BYTES
          )), true, `${witness.label} owner ${projected.key} has an indivisible oversized bucket`);
          await adapter.discardProjected(projected);
        }
      }
    }
    const maximum = measurements.reduce((left, right) => (
      right.uploadBytes > left.uploadBytes ? right : left
    ));
    t.diagnostic(JSON.stringify({
      budgetBytes: DEFAULT_STREAMING_UPLOAD_BUDGET_BYTES,
      maximum,
      measurements,
    }));
  } finally {
    await adapter.shutdown();
    await generator.shutdown?.();
  }
});
