import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import {
  bootInfiniteWorldSandbox,
  createSandboxBootState,
  createSandboxEntryController,
  createW8ScenePresentation,
  isW8GameplaySimulationEnabled,
  recordSandboxBootFailure,
  w8CloudDeltaSeconds,
} from '../src/infinite-world/sandbox-boot.js';
import { InfiniteGameplayRuntime } from '../src/infinite-world/gameplay-runtime.js';
import { UNITS_PER_METER } from '../src/infinite-world/chunk-coordinates.js';
import {
  PRODUCTION_VISUAL_UNITS_PER_METER,
  createW8ParityVisualAssetLibrary,
} from '../src/infinite-world/render/w8-parity-visual-assets.js';

const repoRoot = resolve(import.meta.dirname, '..');
let nodeObjectConstructionCount = 0;

class Triple {
  constructor() { this.set(0, 0, 0); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class NodeObject {
  constructor() {
    nodeObjectConstructionCount += 1;
    this.children = [];
    this.position = new Triple();
    this.rotation = new Triple();
    this.scale = new Triple().set(1, 1, 1);
    this.userData = {};
    this.matrix = {};
  }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) { this.children = this.children.filter(value => value !== child); child.parent = null; }
  clear() { this.children = []; }
  updateMatrix() { this.matrix = { position: { ...this.position }, scale: { ...this.scale } }; }
}
class Group extends NodeObject {}
class Scene extends Group {
  static instances = [];
  constructor() { super(); Scene.instances.push(this); }
}
class Geometry {
  constructor() { this.attributes = {}; }
  clone() { return new this.constructor(); }
  setAttribute(name, value) { this.attributes[name] = value; }
  setIndex(index) { this.index = index; }
  computeVertexNormals() {}
  dispose() { this.disposed = true; }
}
class PlaneGeometry extends Geometry {}
class ConeGeometry extends Geometry {}
class DodecahedronGeometry extends Geometry {}
class BufferGeometry extends Geometry {}
class CylinderGeometry extends Geometry {}
class Float32BufferAttribute { constructor(values, size) { this.values = values; this.size = size; } }
class InstancedBufferAttribute extends Float32BufferAttribute {}
class Material {
  constructor(options = {}) { this.options = options; Object.assign(this, options); }
  clone() { return new this.constructor({ ...this.options }); }
  dispose() { this.disposed = true; }
}
class MeshLambertMaterial extends Material {}
class LineBasicMaterial extends Material {}
class Mesh extends NodeObject {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
}
class InstancedMesh extends Mesh {
  constructor(geometry, material, capacity) {
    super(geometry, material);
    this.capacity = capacity;
    this.instanceMatrix = {};
    this.instanceColor = {};
    this.matrices = [];
    this.colors = [];
  }
  setMatrixAt(index, matrix) { this.matrices[index] = structuredClone(matrix); }
  setColorAt(index, color) { this.colors[index] = color; }
}
class LineSegments extends Mesh {}
class Object3D extends NodeObject {}
class PerspectiveCamera extends NodeObject {
  static instances = [];
  constructor(fov, aspect, near, far) {
    super();
    Object.assign(this, { fov, aspect, near, far });
    PerspectiveCamera.instances.push(this);
  }
  updateProjectionMatrix() {}
  lookAt() {}
}
class HemisphereLight extends NodeObject {}
class DirectionalLight extends NodeObject {}
class Color { constructor(value) { this.value = value; } }
class Fog {
  static instances = [];
  constructor(...values) { this.values = values; Fog.instances.push(this); }
}
class WebGLRenderer {
  static instances = [];
  constructor() {
    this.renderCount = 0;
    this.domElement = { removed: false, remove() { this.removed = true; } };
    WebGLRenderer.instances.push(this);
  }
  setPixelRatio() {}
  setSize() {}
  render() { this.renderCount += 1; }
  dispose() { this.disposed = true; }
}

const FakeThree = {
  Group,
  Scene,
  PlaneGeometry,
  ConeGeometry,
  DodecahedronGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  MeshLambertMaterial,
  LineBasicMaterial,
  Mesh,
  InstancedMesh,
  LineSegments,
  Object3D,
  PerspectiveCamera,
  HemisphereLight,
  DirectionalLight,
  Color,
  Fog,
  WebGLRenderer,
  SRGBColorSpace: 'srgb',
};

test('finite Cloud contract remains logical and continuous across origin updates', () => {
  const scene = new Scene();
  const visualAssets = createW8ParityVisualAssetLibrary({ THREE: FakeThree });
  const presentation = createW8ScenePresentation({
    THREE: FakeThree,
    scene,
    visualAssets,
  });
  const initial = presentation.snapshot();
  assert.equal(initial.cloudBaseCount, 70);
  assert.equal(initial.cloudPuffCount, 21);
  assert.equal(initial.cloudInstanceCount, 91);
  assert.equal(initial.cloudCapacity, 91);
  assert.equal(initial.warmBaseCount, 28);
  assert.equal(initial.cloudAnchorX, 0);
  assert.equal(initial.cloudAnchorZ, 0);
  assert.equal(initial.rootAttached, true);
  assert.equal(initial.rootVisible, true);
  assert.equal(initial.frustumCulled, false);
  assert.equal(initial.renderOrder, 0);
  assert.equal(initial.materialTransparent, true);
  assert.equal(initial.materialOpacity, 1);
  assert.equal(initial.materialDepthWrite, false);
  assert.equal(initial.instanceOpacityAttributeCount, 91);
  assert.equal(initial.instanceOpacityShaderEnabled, true);
  assert.ok(initial.minimumCloudY >= 1_600 / PRODUCTION_VISUAL_UNITS_PER_METER);
  assert.ok(initial.maximumCloudY < 3_500 / PRODUCTION_VISUAL_UNITS_PER_METER);
  assert.equal(initial.clouds.filter(cloud => cloud.puff).length, 21);
  assert.equal(presentation.cloudRoot.material.opacity, 1);
  assert.equal(visualAssets.materials.cloud.opacity, 0.72);
  assert.deepEqual(
    presentation.cloudRoot.colors.map(color => color.value),
    initial.clouds.map(cloud => cloud.warm ? 0xfff3e0 : 0xffffff),
  );
  assert.deepEqual(
    [...presentation.cloudRoot.geometry.attributes.instanceOpacity.values],
    initial.clouds.map(cloud => Math.fround(cloud.opacity)),
  );
  for (const cloud of initial.clouds.filter(value => !value.puff)) {
    assert.ok(cloud.opacity >= 0.55 && cloud.opacity < 0.9);
    assert.ok(cloud.widthFinite >= 600 && cloud.widthFinite < 2_000);
    assert.ok(cloud.heightFinite >= 100 && cloud.heightFinite < 320);
    assert.ok(cloud.depthFinite >= 400 && cloud.depthFinite < 1_300);
    assert.ok(cloud.logicalY * PRODUCTION_VISUAL_UNITS_PER_METER >= 1_600);
    assert.ok(cloud.logicalY * PRODUCTION_VISUAL_UNITS_PER_METER < 3_500);
    assert.ok(cloud.speedFinite >= 1.5 && cloud.speedFinite < 4);
  }
  for (const puff of initial.clouds.filter(value => value.puff)) {
    const base = initial.clouds.find(value =>
      !value.puff && value.sourceIndex === puff.sourceIndex);
    assert.ok(base);
    assert.equal(puff.opacity, base.opacity);
    assert.equal(puff.warm, base.warm);
    assert.equal(puff.speedFinite, base.speedFinite);
    assert.ok(puff.widthFinite >= base.widthFinite * 0.4);
    assert.ok(puff.widthFinite < base.widthFinite * 0.8);
    assert.ok(puff.heightFinite >= base.heightFinite * 0.6);
    assert.ok(puff.heightFinite < base.heightFinite);
    assert.ok(puff.depthFinite >= base.depthFinite * 0.4);
    assert.ok(puff.depthFinite < base.depthFinite * 0.8);
  }

  assert.equal(w8CloudDeltaSeconds({
    deltaSeconds: 1 / 60,
    measurementMode: null,
    runPhase: 'title',
    paused: false,
    hitStopped: false,
  }), 0);
  assert.equal(w8CloudDeltaSeconds({
    deltaSeconds: 1 / 60,
    measurementMode: 'normal',
    runPhase: 'title',
    paused: true,
    hitStopped: false,
  }), 1 / 60);
  assert.equal(w8CloudDeltaSeconds({
    deltaSeconds: 1 / 60,
    measurementMode: null,
    runPhase: 'playing',
    paused: false,
    hitStopped: false,
  }), 1 / 60);
  assert.equal(w8CloudDeltaSeconds({
    deltaSeconds: 1 / 60,
    measurementMode: null,
    runPhase: 'playing',
    paused: true,
    hitStopped: false,
  }), 0);
  assert.equal(w8CloudDeltaSeconds({
    deltaSeconds: 1 / 60,
    measurementMode: null,
    runPhase: 'playing',
    paused: false,
    hitStopped: true,
  }), 0);
  assert.equal(w8CloudDeltaSeconds({
    deltaSeconds: 1 / 60,
    measurementMode: null,
    runPhase: 'dying',
    paused: false,
    hitStopped: false,
  }), 1 / 60 * 0.15);

  const constructedBeforeFrames = nodeObjectConstructionCount;
  const logicalBeforeCrossings = initial.clouds.map(cloud => ({
    x: cloud.logicalX,
    z: cloud.logicalZ,
  }));
  for (let crossing = 1; crossing <= 5; crossing += 1) {
    presentation.rebase({
      renderOriginChunkX: crossing,
      renderOriginChunkZ: -crossing,
    });
  }
  const rebased = presentation.snapshot();
  assert.deepEqual(
    rebased.clouds.map(cloud => ({ x: cloud.logicalX, z: cloud.logicalZ })),
    logicalBeforeCrossings,
  );
  const firstCloud = rebased.clouds[0];
  assert.equal(
    presentation.cloudRoot.matrices[0].position.x,
    (firstCloud.logicalX - 5 * 16) * UNITS_PER_METER,
  );
  assert.equal(
    presentation.cloudRoot.matrices[0].position.z,
    (firstCloud.logicalZ + 5 * 16) * UNITS_PER_METER,
  );
  presentation.update(1 / 60, {
    renderOriginChunkX: 5,
    renderOriginChunkZ: -5,
  });
  const moved = presentation.snapshot();
  for (let index = 0; index < moved.clouds.length; index += 1) {
    assert.ok(Math.abs(
      moved.clouds[index].logicalX
      - rebased.clouds[index].logicalX
      - rebased.clouds[index].speedFinite / PRODUCTION_VISUAL_UNITS_PER_METER,
    ) < 1e-10);
  }
  assert.equal(nodeObjectConstructionCount, constructedBeforeFrames);
  presentation.dispose();
  visualAssets.dispose();
});

function installBrowserEquivalentEnvironment() {
  const saved = new Map();
  const setGlobal = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const viewport = { children: [], append(child) { this.children.push(child); } };
  const hud = { innerHTML: '' };
  const rafInitializationStates = [];
  const rafCallbacks = [];
  const cancelledFrames = [];
  const listeners = new Map();
  const documentListeners = new Map();
  setGlobal('THREE', FakeThree);
  setGlobal('document', {
    readyState: 'complete',
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    querySelector(selector) {
      if (selector === '#viewport') return viewport;
      if (selector === '#hud') return hud;
      return null;
    },
  });
  setGlobal('location', { search: '' });
  setGlobal('innerWidth', 1920);
  setGlobal('innerHeight', 1080);
  setGlobal('devicePixelRatio', 1);
  setGlobal('addEventListener', (type, listener) => listeners.set(type, listener));
  setGlobal('removeEventListener', type => listeners.delete(type));
  setGlobal('requestAnimationFrame', callback => {
    rafInitializationStates.push(globalThis.__infiniteWorldBoot?.snapshot().initializationComplete ?? false);
    rafCallbacks.push(callback);
    return rafInitializationStates.length;
  });
  setGlobal('cancelAnimationFrame', id => cancelledFrames.push(id));
  return {
    viewport,
    hud,
    rafInitializationStates,
    rafCallbacks,
    cancelledFrames,
    listeners,
    documentListeners,
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

function createEntryDocument(readyState) {
  const listeners = new Map();
  return {
    readyState,
    listeners,
    addEventListener(type, listener, options) {
      const entries = listeners.get(type) ?? [];
      entries.push({ listener, options });
      listeners.set(type, entries);
    },
    dispatch(type) {
      for (const entry of [...(listeners.get(type) ?? [])]) entry.listener();
    },
  };
}

function loadPreModuleBridge() {
  const html = readFileSync(resolve(repoRoot, 'infinite-world-sandbox.html'), 'utf8');
  const match = html.match(/<script id="w6-entry-error-bridge">([\s\S]*?)<\/script>/);
  assert.ok(match, 'pre-module error bridge is missing');
  const listeners = new Map();
  const hud = { textContent: '' };
  const windowObject = {
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  vm.runInNewContext(match[1], {
    window: windowObject,
    document: { querySelector: selector => (selector === '#hud' ? hud : null) },
  });
  return { bridge: windowObject.__infiniteWorldEntryBridge, listeners, hud, html };
}

test('browser-equivalent W5 entry resolves every import and completes the real main boot path', async () => {
  WebGLRenderer.instances.length = 0;
  Scene.instances.length = 0;
  PerspectiveCamera.instances.length = 0;
  Fog.instances.length = 0;
  const environment = installBrowserEquivalentEnvironment();
  try {
    const startedAt = performance.now();
    const entryUrl = new URL(`../src/infinite-world/sandbox-main.js?boot-smoke=${Date.now()}`, import.meta.url);
    let importTimeout = null;
    try {
      const entryModule = await Promise.race([
        import(entryUrl.href),
        new Promise((resolve, reject) => {
          importTimeout = setTimeout(() => reject(new Error('entry import timed out')), 5_000);
        }),
      ]);
      await entryModule.startInfiniteWorldSandbox();
    } finally {
      if (importTimeout !== null) clearTimeout(importTimeout);
    }
    const outcome = await globalThis.__infiniteWorldBoot.promise;
    const elapsedMs = performance.now() - startedAt;
    assert.equal(outcome.ok, true);
    assert.ok(elapsedMs < 5_000);

    const snapshot = outcome.sandbox.snapshot();
    assert.equal(snapshot.boot.status, 'ready');
    assert.equal(snapshot.boot.stage, 'Ready');
    assert.equal(snapshot.boot.initializationComplete, true);
    assert.equal(snapshot.boot.loopStarted, true);
    assert.deepEqual(environment.rafInitializationStates, [true]);
    assert.equal(snapshot.runtime.counts.generated, 25);
    assert.equal(snapshot.runtime.renderedCount, 9);
    assert.equal(snapshot.runtime.activeDataCount, 25);
    assert.equal(snapshot.resources.liveChunkGroups, 9);
    assert.equal(snapshot.boot.initialChunkCount, 25);
    assert.equal(snapshot.boot.initialRenderedChunkCount, 9);
    assert.equal(snapshot.boot.initialPrefetchedChunkCount, 25);
    assert.equal(snapshot.boot.initialSettlementCount, 1);
    assert.equal(snapshot.boot.initialSimulationChunkCount, 9);
    assert.ok(snapshot.boot.initialGameplayEntityCount > 0);
    assert.equal(
      snapshot.boot.macroRegionsEvaluated,
      snapshot.generator.distributor.rawCacheSize,
    );
    assert.equal(
      snapshot.boot.rawSettlementCandidateCount,
      snapshot.generator.distributor.rawCandidateCount,
    );
    assert.equal(
      snapshot.boot.acceptedSettlementCandidateCount,
      snapshot.generator.distributor.acceptedSettlementCount,
    );
    assert.ok(snapshot.boot.macroRegionsEvaluated >= 53);
    assert.ok(snapshot.boot.rawSettlementCandidateCount >= 39);
    assert.ok(snapshot.boot.acceptedSettlementCandidateCount >= 1);
    assert.equal(snapshot.boot.materializedSettlementCount, 1);
    assert.equal(snapshot.generator.templatesMaterialized, 1);
    assert.equal(snapshot.boot.startupSurveyExecuted, false);
    assert.equal(snapshot.boot.startupBenchmarkExecuted, false);
    assert.equal(snapshot.gameplay.activeSimulationChunkCount, 9);
    assert.equal(snapshot.gameplay.render.liveChunkGroups, 9);
    assert.equal(snapshot.gameplay.state.activeScaleStageId, 'MAX');
    assert.ok(snapshot.boot.initialSceneObjectCount > 9);
    assert.ok(snapshot.boot.chunkGenerationMs > 0);
    assert.ok(snapshot.boot.settlementGenerationMs > 0);
    assert.ok(snapshot.boot.renderProjectionMs > 0);
    assert.equal(WebGLRenderer.instances.length, 1);
    assert.equal(WebGLRenderer.instances[0].renderCount, 1);
    assert.equal(environment.viewport.children.length, 1);
    assert.match(environment.hud.innerHTML, /World Seed:/);
    assert.doesNotMatch(environment.hud.innerHTML, /起動中/);

    const gameplayScene = Scene.instances[0];
    assert.equal(Scene.instances.length, 1);
    assert.equal(PerspectiveCamera.instances.length, 1);
    const gameplayCamera = PerspectiveCamera.instances[0];
    const gameplayFog = Fog.instances[0];
    assert.equal(gameplayCamera.fov, 70);
    assert.equal(gameplayCamera.near, 64);
    assert.equal(gameplayCamera.far, 224000);
    assert.deepEqual(gameplayFog.values, [0x5dade2, 19200, 76800]);
    assert.equal(gameplayScene.children.some(child => child.name === 'w8-cyclic-scene-clouds'), false);
    const cloudRoot = gameplayScene.children.find(
      child => child.name === 'w8-finite-cloud-instance-pool',
    );
    assert.equal(cloudRoot.count, 91);
    assert.equal(cloudRoot.capacity, 91);
    assert.equal(cloudRoot.visible, true);
    assert.deepEqual(cloudRoot.userData, {
      presentationOnly: true, cloudBaseCount: 70, cloudPuffCount: 21,
    });
    assert.equal(cloudRoot.material.options.transparent, true);
    assert.equal(cloudRoot.material.options.opacity, 0.72);
    assert.equal(cloudRoot.material.options.depthWrite, false);
    assert.equal(snapshot.scenePresentation.cloudAnchorX, snapshot.spatial.spawn.x);
    assert.equal(snapshot.scenePresentation.cloudAnchorZ, snapshot.spatial.spawn.z);
    assert.equal(snapshot.scenePresentation.rootAttached, true);
    assert.equal(snapshot.scenePresentation.rootVisible, true);
    assert.equal(snapshot.scenePresentation.frustumCulled, false);
    assert.equal(snapshot.scenePresentation.materialTransparent, true);
    assert.equal(snapshot.scenePresentation.materialOpacity, 1);
    assert.equal(snapshot.scenePresentation.materialDepthWrite, false);
    assert.equal(snapshot.scenePresentation.instanceOpacityAttributeCount, 91);
    assert.equal(snapshot.scenePresentation.instanceOpacityShaderEnabled, true);
    assert.ok(snapshot.scenePresentation.clouds.filter(cloud => Math.hypot(
      cloud.logicalX - snapshot.spatial.spawn.x,
      cloud.logicalZ - snapshot.spatial.spawn.z,
    ) <= 300).length > 0);
    assert.equal(gameplayScene.children.some(child => child.name === 'w8-visual-horizon-apron'), false);
    const distantWorld = gameplayScene.children.find(child => child.name === 'w8-scene-owned-distant-world');
    assert.ok(distantWorld);
    assert.equal(distantWorld.visible, true);
    assert.equal(distantWorld.userData.presentationOnly, true);
    assert.equal(snapshot.presentation.midgroundChunkCount, 16);
    assert.equal(snapshot.presentation.clipmapMeshCount, 1);
    assert.ok(snapshot.presentation.maximumInnerBoundaryErrorMeters <= 0.001);
    assert.ok(snapshot.presentation.maximumInnerBoundaryColorDifference <= 0.03);
    assert.ok(snapshot.presentation.clipmapDeterministicChecksum > 0);
    assert.equal(snapshot.presentation.distantNaturalProxyCount, 46);
    assert.equal(snapshot.presentation.distantRockProxyLimit, 64);
    assert.equal(snapshot.presentation.distantNaturalProxyLimit, 64);
    assert.equal(snapshot.presentation.distantTreeProxyCount, 0);
    assert.equal(
      snapshot.presentation.distantRockProxyCount,
      snapshot.presentation.distantNaturalProxyCount,
    );
    assert.equal(snapshot.presentation.distantTownProxyCount, 0);
    assert.equal(snapshot.presentation.distantTownProxyLimit, 0);
    assert.ok(snapshot.presentation.canonicalRecordCount > 0);
    assert.equal(snapshot.presentation.canonicalVegetationRecordCount, 17);
    assert.equal(snapshot.presentation.canonicalTreeRecordCount, 7);
    assert.equal(snapshot.presentation.canonicalShrubRecordCount, 10);
    assert.equal(snapshot.presentation.visibleCanonicalVegetationCount, 17);
    assert.equal(snapshot.presentation.visibleCanonicalTreeCount, 7);
    assert.equal(snapshot.presentation.visibleCanonicalShrubCount, 10);
    assert.equal(
      snapshot.presentation.canonicalTreeRecordCount
        + snapshot.presentation.canonicalShrubRecordCount,
      snapshot.presentation.canonicalVegetationRecordCount,
    );
    assert.equal(
      snapshot.presentation.canonicalBuildingRecordCount
        + snapshot.presentation.canonicalVegetationRecordCount
        + snapshot.presentation.canonicalLandmarkRecordCount
        + snapshot.presentation.canonicalRoadRecordCount,
      snapshot.presentation.canonicalRecordCount,
    );
    assert.ok(snapshot.presentation.canonicalFarObjectCount >= 0);
    assert.ok(snapshot.presentation.canonicalMidObjectCount >= 0);
    assert.ok(snapshot.presentation.canonicalNearObjectCount >= 0);
    assert.equal(
      snapshot.presentation.canonicalFarObjectCount
        + snapshot.presentation.canonicalMidObjectCount
        + snapshot.presentation.canonicalNearObjectCount
        + snapshot.presentation.canonicalHiddenObjectCount
        + snapshot.presentation.canonicalDestroyedObjectCount,
      snapshot.presentation.canonicalRecordCount,
    );
    assert.equal(
      snapshot.presentation.queryTemplateSuccessCount,
      snapshot.presentation.queryCandidateCount,
    );
    assert.equal(
      snapshot.presentation.queryCanonicalChunkSuccessCount,
      snapshot.presentation.queryOwnerChunkCount,
    );
    assert.equal(
      snapshot.presentation.queryOwnerChunkKeys.length,
      snapshot.presentation.queryOwnerChunkCount,
    );
    assert.equal(snapshot.presentation.queryNaturalOwnerChunkCount, 0);
    assert.equal(snapshot.presentation.queryNaturalCandidateCount, 0);
    assert.equal(snapshot.presentation.rootAttached, true);
    assert.equal(snapshot.presentation.templateCacheCapacity, 4);
    assert.ok(snapshot.presentation.templateCacheSize <= 4);
    assert.equal(snapshot.presentation.farOwnerChunkCacheCapacity, 128);
    assert.ok(snapshot.presentation.farOwnerChunkCacheSize <= 128);
    assert.equal(snapshot.presentation.queryConcurrencyLimit, 4);
    assert.ok(snapshot.presentation.maximumObservedQueryConcurrency <= 4);
    assert.ok(snapshot.presentation.distantWaterProxyCount <= 24);
    assert.ok(snapshot.presentation.distantProxyInstancedMeshCount > 0);
    assert.equal(distantWorld.children.length, 1);
    assert.match(distantWorld.children[0].name, /^w8-distant-presentation-epoch-/);
    const distantPresentationObjects = [];
    const visitDistantPresentation = object => {
      for (const child of object.children ?? []) {
        distantPresentationObjects.push(child);
        visitDistantPresentation(child);
      }
    };
    visitDistantPresentation(distantWorld);
    assert.ok(distantPresentationObjects.some(
      child => child.name?.includes('finite-language-proxy'),
    ));
    assert.equal(distantPresentationObjects
      .filter(child => child instanceof Mesh && child.userData?.presentationOnly)
      .every(child => child.castShadow === false && child.receiveShadow === false), true);
    const titlePresentation = gameplayScene.children.find(
      child => child.name === 'w8-main-world-title-presentation',
    );
    assert.ok(titlePresentation);
    assert.equal(titlePresentation.userData.presentationOnly, true);
    assert.ok(titlePresentation.children.some(child => child.name === 'w8-finite-parity-player-crab'));
    const titleAtomic = titlePresentation.children.find(
      child => child.name === 'w8-title-atomic-presentation',
    );
    assert.ok(titleAtomic);
    assert.equal(titleAtomic.userData.finiteBaseCount, 50);
    assert.equal(titleAtomic.userData.finiteStemCount, 80);
    assert.equal(titleAtomic.userData.finiteCapCount, 200);
    assert.equal(titleAtomic.children.length, 2);
    assert.equal(titleAtomic.children.reduce((sum, child) => sum + child.count, 0), 330);

    const renderedKeys = new Set(snapshot.runtime.renderedKeys);
    assert.equal(Object.keys(snapshot.resources.chunkRenderables).every(key => renderedKeys.has(key)), true);
    const playerXBeforeInput = outcome.sandbox.logicalPlayer.x;
    environment.listeners.get('keydown')({ code: 'KeyD', preventDefault() {} });
    environment.rafCallbacks[0](performance.now() + 100);
    environment.listeners.get('keyup')({ code: 'KeyD', preventDefault() {} });
    assert.ok(outcome.sandbox.logicalPlayer.x > playerXBeforeInput);
    let warmed = outcome.sandbox.snapshot();
    for (let attempt = 0; attempt < 500 && warmed.presentation.queryNaturalCandidateCount === 0;
      attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      warmed = outcome.sandbox.snapshot();
    }
    assert.equal(warmed.presentation.queryNaturalCandidateCount, 99);
    assert.ok(warmed.presentation.queryNaturalOwnerChunkCount >= 83);
    assert.ok(warmed.presentation.queryNaturalOwnerChunkCount <= 100);
    assert.ok(warmed.presentation.canonicalVegetationRecordCount >= warmed.presentation.visibleCanonicalVegetationCount);
    assert.ok(warmed.presentation.visibleCanonicalVegetationCount > 0);
    assert.ok(warmed.presentation.visibleCanonicalTreeCount > 0);
    assert.equal(
      warmed.presentation.visibleCanonicalFullTreeCount
        + warmed.presentation.visibleCanonicalSilhouetteTreeCount
        + warmed.presentation.visibleCanonicalUltraTreeCount,
      warmed.presentation.visibleCanonicalTreeCount,
    );
    assert.ok(warmed.presentation.visibleCanonicalTreePartInstanceCount
      >= warmed.presentation.visibleCanonicalTreeCount);
    assert.equal(warmed.presentation.distantTreeProxyCount, 0);
    environment.listeners.get('keydown')({ code: 'Tab', preventDefault() {} });
    environment.listeners.get('keydown')({ code: 'Digit1', preventDefault() {} });
    assert.equal(outcome.sandbox.snapshot().gameplay.state.activeScaleStageId, 'TINY');
    environment.listeners.get('keydown')({ code: 'Digit3', preventDefault() {} });
    assert.equal(outcome.sandbox.snapshot().gameplay.state.activeScaleStageId, 'MAX');
    assert.equal(WebGLRenderer.instances[0].renderCount, 2);
    assert.deepEqual(environment.rafInitializationStates, [true, true]);
    await outcome.sandbox.shutdown();
    const stopped = outcome.sandbox.snapshot();
    assert.equal(stopped.runtime.activeDataCount, 0);
    assert.equal(stopped.runtime.renderedCount, 0);
    assert.equal(stopped.resources.liveChunkGroups, 0);
    assert.equal(stopped.resources.liveChunkOwnedGeometryCount, 0);
    assert.equal(stopped.gameplay.activeSimulationChunkCount, 0);
    assert.equal(stopped.gameplay.render.liveChunkGroups, 0);
    assert.equal(stopped.gameplay.render.sharedDisposed, true);
    assert.equal(cloudRoot.parent, null);
    assert.equal(distantWorld.parent, null);
    assert.equal(WebGLRenderer.instances[0].disposed, true);
    assert.deepEqual(environment.cancelledFrames, [2]);
  } finally {
    environment.restore();
  }
});

test('measurement frames pass strict boolean simulation state into Gameplay Runtime', async () => {
  assert.equal(isW8GameplaySimulationEnabled('steady', 'menu'), true);
  assert.equal(isW8GameplaySimulationEnabled('crossing', 'intro'), true);
  assert.equal(isW8GameplaySimulationEnabled(null, 'playing'), true);
  assert.equal(isW8GameplaySimulationEnabled(null, 'menu'), false);
  assert.equal(isW8GameplaySimulationEnabled(null, 'intro'), false);

  for (const measurementMode of ['steady', 'crossing']) {
    const environment = installBrowserEquivalentEnvironment();
    const simulationEnabledValues = [];
    try {
      const sandbox = await bootInfiniteWorldSandbox({
        globalObject: globalThis,
        THREE: FakeThree,
        viewport: environment.viewport,
        hud: environment.hud,
        requestedSeed: 'KaniNingen Infinite Natural World',
        measurementMode,
        gameplayRuntimeFactory(options) {
          const runtime = new InfiniteGameplayRuntime(options);
          const update = runtime.update.bind(runtime);
          runtime.update = input => {
            simulationEnabledValues.push(input.simulationEnabled);
            return update(input);
          };
          return runtime;
        },
      });
      environment.rafCallbacks[0](performance.now() + 100);
      assert.deepEqual(simulationEnabledValues, [true], measurementMode);
      await sandbox.shutdown();
    } finally {
      environment.restore();
    }
  }
});

test('loading document starts once after DOMContentLoaded and never waits through module evaluation', async () => {
  const documentObject = createEntryDocument('loading');
  const state = createSandboxBootState();
  const hud = { innerHTML: '' };
  let executions = 0;
  const controller = createSandboxEntryController({
    documentObject,
    state,
    hud,
    async runSandboxBoot() { executions += 1; return { booted: true }; },
  });
  controller.install();
  assert.equal(executions, 0);
  assert.equal(controller.snapshot().bootExecutionCount, 0);
  assert.equal(state.stage, 'DOMContentLoaded');
  documentObject.dispatch('DOMContentLoaded');
  assert.equal(controller.snapshot().bootExecutionCount, 1);
  assert.equal(state.stage, 'Legacy Core');
  documentObject.dispatch('DOMContentLoaded');
  await controller.startSandboxOnce();
  const outcome = await controller.promise;
  assert.equal(outcome.ok, true);
  assert.equal(executions, 1);
  assert.equal(controller.snapshot().bootExecutionCount, 1);
});

test('complete document starts immediately once without registering a DOMContentLoaded gate', async () => {
  const documentObject = createEntryDocument('complete');
  const state = createSandboxBootState();
  const hud = { innerHTML: '' };
  let executions = 0;
  const controller = createSandboxEntryController({
    documentObject,
    state,
    hud,
    async runSandboxBoot() { executions += 1; return { booted: true }; },
  });
  controller.install();
  assert.equal(controller.snapshot().bootExecutionCount, 1);
  assert.equal(documentObject.listeners.has('DOMContentLoaded'), false);
  assert.equal(state.stage, 'Legacy Core');
  await controller.startSandboxOnce();
  const outcome = await controller.promise;
  assert.equal(outcome.ok, true);
  assert.equal(executions, 1);
});

test('entry boot rejection is consumed once and becomes a visible HUD failure', async () => {
  const documentObject = createEntryDocument('complete');
  const state = createSandboxBootState();
  const hud = { innerHTML: '' };
  let failures = 0;
  const controller = createSandboxEntryController({
    documentObject,
    state,
    hud,
    runSandboxBoot: async () => { throw new TypeError('entry rejection smoke'); },
    handleBootFailure(error) {
      failures += 1;
      recordSandboxBootFailure({ state, hud, error });
    },
  });
  controller.install();
  const outcome = await controller.promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.name, 'TypeError');
  assert.equal(failures, 1);
  assert.equal(controller.snapshot().bootExecutionCount, 1);
  assert.equal(state.status, 'failed');
  assert.equal(state.bootError.stage, 'Legacy Core');
  assert.match(hud.innerHTML, /起動失敗: Legacy Core/);
});

test('pre-module bridge reports the first module error and suppresses duplicates', () => {
  const fixture = loadPreModuleBridge();
  assert.equal(typeof fixture.bridge.reportModuleLoadFailure, 'function');
  fixture.listeners.get('error')({
    error: new SyntaxError('dependency parse failed'),
    filename: 'http://127.0.0.1:8021/src/infinite-world/dependency.js',
    message: 'dependency parse failed',
  });
  assert.match(fixture.hud.textContent, /起動失敗: MODULE_LOAD/);
  assert.match(fixture.hud.textContent, /SyntaxError: dependency parse failed/);
  assert.match(fixture.hud.textContent, /Filename: http:\/\/127\.0\.0\.1:8021\/src\/infinite-world\/dependency\.js/);
  const firstHud = fixture.hud.textContent;
  fixture.listeners.get('unhandledrejection')({ reason: new Error('later rejection') });
  assert.equal(fixture.hud.textContent, firstHud);
  assert.deepEqual({ ...fixture.bridge.snapshot().firstError }, {
    name: 'SyntaxError',
    message: 'dependency parse failed',
    sourceUrl: '',
    filename: 'http://127.0.0.1:8021/src/infinite-world/dependency.js',
  });
});

test('pre-module bridge reports the bootstrap URL for a non-bubbling module resource load failure', () => {
  const fixture = loadPreModuleBridge();
  fixture.listeners.get('error')({
    target: { src: 'http://127.0.0.1:8021/src/infinite-world/sandbox-entry.js?v=w8-finite-parity' },
  });
  assert.match(fixture.hud.textContent, /起動失敗: MODULE_LOAD/);
  assert.match(fixture.hud.textContent, /Error: Module script failed to load/);
  assert.match(fixture.hud.textContent, /Source: http:\/\/127\.0\.0\.1:8021\/src\/infinite-world\/sandbox-entry\.js\?v=w8-finite-parity/);
});

test('pre-module bridge reports an unhandled rejection and disables itself after module start', () => {
  const rejectionFixture = loadPreModuleBridge();
  rejectionFixture.listeners.get('unhandledrejection')({ reason: new TypeError('import promise rejected') });
  assert.match(rejectionFixture.hud.textContent, /起動失敗: MODULE_LOAD/);
  assert.match(rejectionFixture.hud.textContent, /TypeError: import promise rejected/);

  const successFixture = loadPreModuleBridge();
  successFixture.bridge.markModuleStarted();
  successFixture.listeners.get('error')({ error: new Error('runtime error after module start') });
  assert.equal(successFixture.hud.textContent, '');
  assert.equal(successFixture.bridge.snapshot().reported, false);
  assert.equal(successFixture.bridge.snapshot().moduleStarted, true);
});

test('boot timeout resolves as a recorded stage error instead of leaving a pending Promise', async () => {
  const state = createSandboxBootState();
  const hud = { innerHTML: '' };
  const viewport = { append() {} };
  const startedAt = performance.now();
  await assert.rejects(() => bootInfiniteWorldSandbox({
    globalObject: globalThis,
    THREE: FakeThree,
    viewport,
    hud,
    state,
    requestedSeed: 'unresolved boot smoke',
    generatorFactory: () => new Promise(() => {}),
    requestAnimationFrameFn: () => 1,
    bootTimeoutMs: 25,
  }), error => error?.name === 'SandboxBootTimeoutError');
  assert.ok(performance.now() - startedAt < 1_000);
  assert.equal(state.status, 'failed');
  assert.equal(state.stage, 'Legacy Core');
  assert.equal(state.bootError.name, 'SandboxBootTimeoutError');
  assert.match(hud.innerHTML, /起動失敗: Legacy Core/);
});

test('production startup contains no distribution survey, golden generation, or performance benchmark', () => {
  const html = readFileSync(resolve(repoRoot, 'infinite-world-sandbox.html'), 'utf8');
  const bootstrap = readFileSync(resolve(repoRoot, 'src/infinite-world/sandbox-entry.js'), 'utf8');
  const entry = readFileSync(resolve(repoRoot, 'src/infinite-world/sandbox-main.js'), 'utf8');
  const boot = readFileSync(resolve(repoRoot, 'src/infinite-world/sandbox-boot.js'), 'utf8');
  const sources = `${bootstrap}\n${entry}\n${boot}`;
  assert.doesNotMatch(sources, /findInMacroRange\s*\(|41\s*[x×]\s*41|453\s+Settlement/);
  assert.doesNotMatch(sources, /runW1BChunkSizeBenchmark|golden|performance benchmark/i);
  assert.match(boot, /benchmarkExecuted:\s*false/);
  assert.match(boot, /startupSurveyExecuted:\s*false/);
  assert.match(boot, /initializationComplete\s*=\s*true[\s\S]*requestAnimationFrameFn\(frame\)/);
  assert.match(html, /<script type="module" src="\.\/src\/infinite-world\/sandbox-entry\.js\?v=w8-finite-parity"><\/script>/);
  assert.equal(existsSync(resolve(repoRoot, 'src/infinite-world/sandbox-entry.js')), true);
  assert.equal(existsSync(resolve(repoRoot, 'src/infinite-world/sandbox-main.js')), true);
  assert.doesNotMatch(entry, /await\s+(?:bootPromise|waitForSandboxDom)|waitForSandboxDom/);
});
