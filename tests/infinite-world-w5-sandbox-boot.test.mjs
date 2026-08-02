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
  gatePlayerMovementByTerrainCoverage,
  isW8GameplaySimulationEnabled,
  recordSandboxBootFailure,
  w8CloudDeltaSeconds,
} from '../src/infinite-world/sandbox-boot.js';
import { ChunkRuntimeManager } from '../src/infinite-world/chunk-runtime-manager.js';
import {
  InfiniteGameplayRuntime,
  createW6ChunkGameplay,
} from '../src/infinite-world/gameplay-runtime.js';
import {
  W6_ENTITY_CONTRACTS,
  getW6ScaleProfile,
} from '../src/infinite-world/gameplay-contract.js';
import {
  LOGICAL_CHUNK_SIZE_METERS,
  UNITS_PER_METER,
} from '../src/infinite-world/chunk-coordinates.js';
import {
  PRODUCTION_VISUAL_UNITS_PER_METER,
  createW8ParityVisualAssetLibrary,
} from '../src/infinite-world/render/w8-parity-visual-assets.js';
import {
  decodeInfiniteWorldSave,
  InfiniteWorldSaveStore,
  InfiniteWorldState,
} from '../src/infinite-world/world-state-store.js';

const repoRoot = resolve(import.meta.dirname, '..');
const runIsolatedW5BootPerformanceGate = process.env.KANININGEN_RUN_W5_BOOT_PERFORMANCE === '1';
let nodeObjectConstructionCount = 0;

test('Player terrain coverage gate retains the last formal position and height until ready', () => {
  const samples = [];
  const blocked = gatePlayerMovementByTerrainCoverage({
    horizontalMovement: Object.freeze({ x: 48.25, z: -3, collided: false }),
    startX: 47.75,
    startZ: -3,
    sampleCanonicalTerrainHeight(x, z) {
      samples.push([x, z]);
      return x === 47.75 ? 12.5 : null;
    },
  });
  assert.deepEqual(samples, [[48.25, -3], [47.75, -3]]);
  assert.equal(blocked.terrainCoverageBlocked, true);
  assert.deepEqual({ x: blocked.x, z: blocked.z }, { x: 47.75, z: -3 });
  assert.equal(blocked.terrainHeightMeters, 12.5);
  assert.equal(blocked.terrainCoverageOwner.key, '3,-1');

  const ready = gatePlayerMovementByTerrainCoverage({
    horizontalMovement: Object.freeze({ x: 48.25, z: -3, collided: false }),
    startX: 47.75,
    startZ: -3,
    sampleCanonicalTerrainHeight: () => 14.25,
  });
  assert.equal(ready.terrainCoverageBlocked, false);
  assert.deepEqual({ x: ready.x, z: ready.z }, { x: 48.25, z: -3 });
  assert.equal(ready.terrainHeightMeters, 14.25);
});

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
  const renderDistanceListeners = new Map();
  const renderDistanceControl = {
    value: 'current',
    addEventListener(type, listener) { renderDistanceListeners.set(type, listener); },
    removeEventListener(type) { renderDistanceListeners.delete(type); },
    dispatch(type) {
      renderDistanceListeners.get(type)?.({ target: this, type });
    },
  };
  setGlobal('THREE', FakeThree);
  setGlobal('document', {
    readyState: 'complete',
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    getElementById(id) { return id === 'set-render-distance' ? renderDistanceControl : null; },
    querySelectorAll() { return []; },
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
    renderDistanceControl,
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

function createDeferredValue() {
  let resolvePromise;
  const promise = new Promise(resolveValue => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

class ControlledSaveStorage {
  constructor() {
    this.values = new Map();
    this.calls = [];
    this.deferWrites = false;
    this.diagnosticStage = 'controlled-storage';
  }

  getItem(key) { return this.values.get(key) ?? null; }

  async setItem(key, value) {
    const gate = createDeferredValue();
    const call = { key, value, gate, released: !this.deferWrites };
    this.calls.push(call);
    if (this.deferWrites) await gate.promise;
    this.values.set(key, value);
  }

  release(index) {
    const call = this.calls[index];
    assert.ok(call, `Save storage call ${index} did not start`);
    if (call.released) return;
    call.released = true;
    call.gate.resolve();
  }

  releaseAll() {
    for (let index = 0; index < this.calls.length; index += 1) this.release(index);
  }
}

function createHeldBootTimers() {
  let sequence = 0;
  const entries = [];
  return {
    entries,
    setTimeoutFn(callback, delayMs) {
      const entry = { id: ++sequence, callback, delayMs, active: true };
      entries.push(entry);
      return entry.id;
    },
    clearTimeoutFn(id) {
      const entry = entries.find(candidate => candidate.id === id);
      if (entry) entry.active = false;
    },
  };
}

function installExperienceControls() {
  const createElement = () => {
    const listeners = new Map();
    const classes = new Set();
    return {
      style: {}, disabled: false, textContent: '', value: '', checked: false,
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      setAttribute() {},
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
      dispatch(type, event = {}) {
        for (const listener of listeners.get(type) ?? []) listener({ type, target: this, ...event });
      },
    };
  };
  const elements = new Map([
    'start-screen', 'start-button', 'continue-button', 'set-home-btn', 'set-reset-btn',
  ].map(id => [id, createElement()]));
  const documentObject = globalThis.document;
  const originalGetElementById = documentObject.getElementById.bind(documentObject);
  documentObject.getElementById = id => elements.get(id) ?? originalGetElementById(id);
  documentObject.body = { classList: { toggle() {} } };
  documentObject.pointerLockElement = null;
  documentObject.exitPointerLock = () => {};
  return elements;
}

async function waitForSaveCondition(condition, message) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) {
    await new Promise(resolveValue => setImmediate(resolveValue));
  }
  assert.equal(condition(), true, message);
}

async function waitForLifeCycleCondition(condition, message) {
  for (let attempt = 0; attempt < 2_000 && !condition(); attempt += 1) {
    await new Promise(resolveValue => setTimeout(resolveValue, 10));
  }
  assert.equal(condition(), true, typeof message === 'function' ? message() : message);
}

async function drainHeldZeroDelayTimersUntil(timers, condition, message) {
  for (let attempt = 0; attempt < 2_000 && !condition(); attempt += 1) {
    const entry = timers.entries.find(candidate => candidate.active && candidate.delayMs === 0);
    if (entry) {
      entry.active = false;
      entry.callback();
    }
    await new Promise(resolveValue => setTimeout(resolveValue, 10));
  }
  assert.equal(condition(), true, typeof message === 'function' ? message() : message);
}

async function verifyGpSave03Pagehide() {
  const environment = installBrowserEquivalentEnvironment();
  const storage = new ControlledSaveStorage();
  const timers = createHeldBootTimers();
  let worldState = null;
  let sandbox = null;
  try {
    sandbox = await bootInfiniteWorldSandbox({
      globalObject: globalThis,
      THREE: FakeThree,
      viewport: environment.viewport,
      hud: environment.hud,
      requestedSeed: 'KaniNingen Infinite Natural World',
      measurementMode: 'steady',
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      worldStateFactory(options) {
        worldState = new InfiniteWorldState(options);
        return worldState;
      },
      saveStoreFactory(options) {
        return new InfiniteWorldSaveStore({ ...options, storage });
      },
    });
    assert.equal(storage.calls.length, 1, 'New Game performs the initial durable Save');
    storage.deferWrites = true;

    worldState.updatePlayer({ score: 10 });
    const timerCountBeforePageHide = timers.entries.length;
    environment.listeners.get('pagehide')({ persisted: true });
    assert.equal(timers.entries.length, timerCountBeforePageHide,
      'pagehide must not reserve even a zero-delay timer');
    assert.equal(sandbox.snapshot().save.queue.requestedGeneration, 2,
      'pagehide captures snapshot and revision inside the event handler');
    await waitForSaveCondition(() => storage.calls.length === 2,
      'pagehide must reach storage without advancing timers');

    environment.listeners.get('pagehide')({ persisted: true });
    assert.equal(sandbox.snapshot().save.queue.requestedGeneration, 2,
      'repeated pagehide for one revision must reuse the same completion');
    worldState.updatePlayer({ score: 20 });
    environment.listeners.get('pagehide')({ persisted: true });
    environment.listeners.get('pagehide')({ persisted: true });
    assert.equal(sandbox.snapshot().save.queue.requestedGeneration, 3,
      'a newer pagehide snapshot replaces the pending generation exactly once');
    storage.release(1);
    await waitForSaveCondition(() => storage.calls.length === 3,
      'latest pagehide generation must follow the active older Save');
    const latestPageHide = await decodeInfiniteWorldSave(storage.calls[2].value, {
      worldSeedHash: worldState.worldSeedHash,
    });
    assert.equal(latestPageHide.player.score, 20);
    storage.release(2);
    await waitForSaveCondition(
      () => sandbox.snapshot().save.queue.committedGeneration === 3,
      'latest pagehide generation must commit',
    );

    worldState.updatePlayer({ score: 30 });
    environment.listeners.get('keydown')({ code: 'KeyP', preventDefault() {} });
    await waitForSaveCondition(() => storage.calls.length === 4,
      'manual Save must enter the shared queue');
    worldState.updatePlayer({ score: 40 });
    environment.listeners.get('pagehide')({ persisted: true });
    assert.equal(sandbox.snapshot().save.queue.requestedGeneration, 5);
    storage.release(3);
    await waitForSaveCondition(() => storage.calls.length === 5,
      'pagehide must follow an active manual Save');
    const manualConflictWinner = await decodeInfiniteWorldSave(storage.calls[4].value, {
      worldSeedHash: worldState.worldSeedHash,
    });
    assert.equal(manualConflictWinner.player.score, 40);
    storage.release(4);
    await waitForSaveCondition(
      () => sandbox.snapshot().save.queue.committedGeneration === 5,
      'pagehide must win the manual Save conflict',
    );

    worldState.updatePlayer({ score: 50 });
    environment.rafCallbacks.at(-1)(performance.now() + 100);
    const autosaveTimer = [...timers.entries].reverse().find(
      entry => entry.active && entry.delayMs === 5_000,
    );
    assert.ok(autosaveTimer, 'dirty state must schedule autosave');
    environment.listeners.get('pagehide')({ persisted: true });
    assert.equal(autosaveTimer.active, false, 'pagehide cancels the pending autosave timer');
    await waitForSaveCondition(() => storage.calls.length === 6,
      'pagehide must replace a pending autosave without running its timer');
    storage.release(5);
    await waitForSaveCondition(
      () => sandbox.snapshot().save.queue.committedGeneration === 6,
      'pagehide replacement for autosave must commit',
    );

    worldState.updatePlayer({ score: 60 });
    environment.listeners.get('pagehide')({ persisted: true });
    await waitForSaveCondition(() => storage.calls.length === 7,
      'final pagehide Save must start');
    const exitGeneration = sandbox.snapshot().save.queue.requestedGeneration;
    const shutdown = sandbox.shutdown();
    assert.equal(sandbox.snapshot().save.queue.requestedGeneration, exitGeneration,
      'shutdown must await the matching pagehide Save instead of duplicating it');
    storage.release(6);
    await shutdown;
    sandbox = null;
  } finally {
    storage.deferWrites = false;
    storage.releaseAll();
    if (sandbox) await sandbox.shutdown();
    environment.restore();
  }
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

test('browser-equivalent W5 entry resolves every import and completes the real main boot path', async t => {
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
    const snapshot = outcome.sandbox.snapshot();
    t.diagnostic(`Static Tree activation timeline (boot) ${JSON.stringify(
      snapshot.treePathAudit.activationTimeline,
    )}`);
    t.diagnostic(`boot ${elapsedMs.toFixed(3)}ms; distant sync ${snapshot.presentation.syncDurationMs.toFixed(3)}ms; root swap ${snapshot.presentation.rootSwapDurationMs.toFixed(3)}ms; remote horizon parts ${snapshot.presentation.remoteHorizonPartInstanceCount}`);
    t.diagnostic(`settlements queried/templates/remote-visible ${snapshot.presentation.queryCandidateCount}/${snapshot.presentation.queryTemplateSuccessCount}/${snapshot.presentation.visibleRemoteHorizonSettlementCount}; full buildings ${snapshot.presentation.canonicalBuildingRecordCount}; remote building/landmark silhouettes ${snapshot.presentation.remoteHorizonBuildingCount}/${snapshot.presentation.remoteHorizonLandmarkCount}`);
    t.diagnostic(`active Chunk generation ${snapshot.boot.chunkGenerationMs.toFixed(3)}ms; Settlement generation ${snapshot.boot.settlementGenerationMs.toFixed(3)}ms; projection ${snapshot.boot.renderProjectionMs.toFixed(3)}ms; tracked feature instances ${snapshot.resources.trackedFeatureInstanceCount}`);
    t.diagnostic(`MAJOR Road ${JSON.stringify(snapshot.generator.canonicalMajorRoad)}`);
    t.diagnostic(`Worker ${JSON.stringify({ ...snapshot.chunkDataService.transport, generatorSnapshot: undefined })}`);
    assert.equal(snapshot.chunkDataService.transport.counts.diagnosticQueries, 1,
      'boot requests one explicit generator diagnostic snapshot');
    // This wall-clock gate intentionally runs only in a separately invoked
    // single-file process. In the repository-wide parallel run it measures
    // unrelated test-process scheduling contention rather than W5 boot work.
    if (runIsolatedW5BootPerformanceGate) {
      assert.ok(elapsedMs < 5_000, `isolated W5 boot ${elapsedMs}ms`);
    }
    assert.equal(snapshot.boot.status, 'ready');
    assert.equal(snapshot.boot.stage, 'Ready');
    assert.equal(snapshot.boot.initializationComplete, true);
    assert.equal(snapshot.boot.loopStarted, true);
    assert.equal(snapshot.treePathAudit.treeStaticStreamActivated, true);
    assert.equal(snapshot.staticObjectStreaming.counts.plans > 0, true);
    assert.deepEqual(new Set(snapshot.staticObjectStreaming.policyKinds), new Set([
      'natural-tree',
      'natural-bush',
      'natural-grass',
      'natural-rock',
    ]));
    assert.equal(
      snapshot.treePathAudit.activationTimeline.activationSource,
      'first-shadow-plan',
    );
    assert.notEqual(
      snapshot.treePathAudit.activationTimeline.firstShadowPlanGeneratedAtMs,
      null,
    );
    assert.notEqual(
      snapshot.treePathAudit.activationTimeline.firstStaticPlanAppliedAtMs,
      null,
    );
    assert.notEqual(
      snapshot.treePathAudit.activationTimeline.firstRequiredOwnerRequestAtMs,
      null,
    );
    assert.equal(snapshot.treePathAudit.activationTimeline.outerWarmCompletedAtMs, null);
    assert.equal(snapshot.treePathAudit.near.pathId, 'near-tree');
    assert.equal(snapshot.treePathAudit.near.active, true);
    assert.equal(snapshot.treePathAudit.near.instanceCount > 0, true);
    const initialStaticTreePath = snapshot.treePathAudit.distant.find(path => (
      path.pathId === 'distant-static-tree'
    ));
    assert.equal(initialStaticTreePath.rootCount, 1);
    assert.equal(initialStaticTreePath.planIds.length, 1);
    assert.deepEqual(initialStaticTreePath.coverageGenerations, [1]);
    assert.equal(snapshot.treePathAudit.distant.some(path => (
      path.pathId === 'distant-legacy-tree' && path.instanceCount > 0
    )), false);
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
    assert.ok(snapshot.boot.materializedSettlementCount
      >= snapshot.boot.initialSettlementCount + snapshot.presentation.queryRemoteSelectedCount);
    assert.equal(
      snapshot.boot.materializedSettlementCount,
      snapshot.generator.templatesMaterialized,
    );
    assert.equal(
      snapshot.generator.templatesMaterialized,
      snapshot.generator.source.templateCacheMisses,
    );
    assert.ok(snapshot.generator.templatesMaterialized
      >= snapshot.boot.materializedSettlementCount);
    assert.equal(
      snapshot.generator.canonicalMajorRoad.settlementTemplateCacheMisses,
      snapshot.generator.templatesMaterialized,
    );
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
    assert.doesNotMatch(environment.hud.innerHTML, /World Seed:/);
    assert.match(environment.hud.innerHTML, /W8 \/ FINITE EXPERIENCE PARITY/);

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
    assert.deepEqual(snapshot.gameplay.render.renderOrigin, {
      renderOriginChunkX: snapshot.runtime.renderOrigin.renderOriginChunkX,
      renderOriginChunkZ: snapshot.runtime.renderOrigin.renderOriginChunkZ,
      rebaseCount: snapshot.runtime.renderOrigin.rebaseCount,
    });
    assert.deepEqual(snapshot.presentation.committedRenderOrigin, {
      renderOriginChunkX: snapshot.runtime.renderOrigin.renderOriginChunkX,
      renderOriginChunkZ: snapshot.runtime.renderOrigin.renderOriginChunkZ,
      rebaseCount: snapshot.runtime.renderOrigin.rebaseCount,
    });
    assert.ok(snapshot.presentation.maximumInnerBoundaryErrorMeters <= 0.001);
    assert.ok(snapshot.presentation.maximumInnerBoundaryColorDifference <= 0.03);
    assert.ok(snapshot.presentation.clipmapDeterministicChecksum > 0);
    assert.equal(snapshot.presentation.distantNaturalProxyCount, 0);
    assert.equal(snapshot.presentation.distantRockProxyLimit, 0);
    assert.equal(snapshot.presentation.distantNaturalProxyLimit, 0);
    assert.equal(snapshot.presentation.distantTreeProxyCount, 0);
    assert.equal(
      snapshot.presentation.distantRockProxyCount,
      snapshot.presentation.distantNaturalProxyCount,
    );
    assert.equal(snapshot.presentation.distantTownProxyCount, 0);
    assert.equal(snapshot.presentation.distantTownProxyLimit, 0);
    assert.ok(snapshot.presentation.canonicalRecordCount > 0);
    // Stage 3B deliberately removes the presentation-only 12m cluster gate.
    // Keep this boot check tied to the canonical-set contract, rather than a
    // historic post-filter count: all canonical records must be visible and
    // their subtype totals must describe the same set.
    assert.ok(snapshot.presentation.canonicalVegetationRecordCount > 0);
    assert.ok(snapshot.presentation.canonicalTreeRecordCount > 0);
    assert.ok(snapshot.presentation.canonicalShrubRecordCount > 0);
    assert.ok(snapshot.presentation.canonicalGrassRecordCount > 0);
    assert.equal(
      snapshot.presentation.visibleCanonicalVegetationCount,
      snapshot.presentation.canonicalVegetationRecordCount,
    );
    assert.equal(
      snapshot.presentation.visibleCanonicalTreeCount,
      snapshot.presentation.canonicalTreeRecordCount,
    );
    assert.equal(
      snapshot.presentation.visibleCanonicalShrubCount,
      snapshot.presentation.canonicalShrubRecordCount,
    );
    assert.equal(
      snapshot.presentation.visibleCanonicalGrassCount,
      snapshot.presentation.canonicalGrassRecordCount,
    );
    assert.ok(snapshot.presentation.canonicalRockRecordCount > 0);
    assert.ok(snapshot.presentation.visibleCanonicalRockCount > 0);
    assert.equal(
      snapshot.presentation.canonicalTreeRecordCount
        + snapshot.presentation.canonicalShrubRecordCount
        + snapshot.presentation.canonicalGrassRecordCount,
      snapshot.presentation.canonicalVegetationRecordCount,
    );
    assert.equal(
      snapshot.presentation.canonicalBuildingRecordCount
        + snapshot.presentation.canonicalVegetationRecordCount
        + snapshot.presentation.canonicalRockRecordCount
        + snapshot.presentation.canonicalLandmarkRecordCount
        + snapshot.presentation.canonicalRoadRecordCount
        + snapshot.presentation.canonicalWorldDetailRecordCount
        + snapshot.presentation.remoteHorizonSyntheticBuildingCount
        + snapshot.presentation.remoteHorizonSyntheticLandmarkCount,
      snapshot.presentation.canonicalRecordCount,
      JSON.stringify({
        building: snapshot.presentation.canonicalBuildingRecordCount,
        vegetation: snapshot.presentation.canonicalVegetationRecordCount,
        rock: snapshot.presentation.canonicalRockRecordCount,
        landmark: snapshot.presentation.canonicalLandmarkRecordCount,
        road: snapshot.presentation.canonicalRoadRecordCount,
        detail: snapshot.presentation.canonicalWorldDetailRecordCount,
        remoteBuilding: snapshot.presentation.remoteHorizonSyntheticBuildingCount,
        remoteLandmark: snapshot.presentation.remoteHorizonSyntheticLandmarkCount,
        total: snapshot.presentation.canonicalRecordCount,
        activeNatural: snapshot.presentation.staticNaturalActiveLegacyRecordCount,
        persistentNatural: snapshot.presentation.staticNaturalPersistentRecordCount,
        overlappingNatural: snapshot.presentation.staticNaturalOverlappingStableIdCount,
      }),
    );
    assert.ok(snapshot.presentation.canonicalWorldDetailRecordCount >= 0);
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
      JSON.stringify({
        activeNatural: snapshot.presentation.staticNaturalActiveLegacyRecordCount,
        persistentNatural: snapshot.presentation.staticNaturalPersistentRecordCount,
        overlappingNatural: snapshot.presentation.staticNaturalOverlappingStableIdCount,
        river: snapshot.presentation.canonicalRiverRecordCount,
        activeRiver: snapshot.presentation.canonicalActiveRiverRecordCount,
      }),
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
    assert.equal(snapshot.presentation.templateCacheCapacity, 5);
    assert.ok(snapshot.presentation.templateCacheSize <= 5);
    assert.equal(
      snapshot.presentation.remoteHorizonCanonicalBuildingCount,
      snapshot.presentation.remoteHorizonBuildingCount,
    );
    assert.equal(snapshot.presentation.remoteHorizonMissingBuildingCount, 0);
    assert.equal(
      snapshot.presentation.remoteHorizonMergedBuildingCount,
      snapshot.presentation.canonicalBuildingRecordCount,
    );
    assert.equal(snapshot.presentation.duplicateVisibleStableIdCount, 0);
    assert.equal(snapshot.presentation.farOwnerChunkCacheCapacity, 128);
    assert.ok(snapshot.presentation.farOwnerChunkCacheSize <= 128);
    assert.equal(snapshot.presentation.queryConcurrencyLimit, 4);
    assert.ok(snapshot.presentation.maximumObservedQueryConcurrency <= 4);
    assert.ok(snapshot.presentation.distantWaterProxyCount <= 24);
    assert.ok(snapshot.presentation.distantProxyInstancedMeshCount > 0);
    assert.equal(distantWorld.children.length, 2);
    assert.ok(distantWorld.children.some(child => /^w8-distant-presentation-epoch-/.test(child.name)));
    assert.ok(distantWorld.children.some(child => /^w8-local-terrain-coverage-epoch-/.test(child.name)));
    const distantPresentationObjects = [];
    const visitDistantPresentation = object => {
      for (const child of object.children ?? []) {
        distantPresentationObjects.push(child);
        visitDistantPresentation(child);
      }
    };
    visitDistantPresentation(distantWorld);
    assert.equal(distantPresentationObjects.some(
      child => child.name?.includes('finite-language-proxy')
        || child.name?.includes('w8-midground-major-natural'),
    ), false);
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
    environment.rafCallbacks[0](performance.now() + 100);
    assert.equal(outcome.sandbox.logicalPlayer.x, playerXBeforeInput);
    let warmed = outcome.sandbox.snapshot();
    for (let attempt = 0; attempt < 500 && warmed.presentation.queryNaturalCandidateCount === 0;
      attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      warmed = outcome.sandbox.snapshot();
    }
    assert.ok(warmed.presentation.queryNaturalCandidateCount > 0, JSON.stringify({
      farSyncPending: warmed.presentation.farSyncPending,
      farSyncPendingCount: warmed.presentation.farSyncPendingCount,
      syncEpoch: warmed.presentation.syncEpoch,
      committedEpoch: warmed.presentation.committedEpoch,
      staleEpochDiscardCount: warmed.presentation.staleEpochDiscardCount,
      localTerrainCoverageCenter: warmed.presentation.localTerrainCoverageCenter,
      localTerrainCommitCount: warmed.presentation.localTerrainCommitCount,
      localTerrainRejectionCount: warmed.presentation.localTerrainRejectionCount,
    }));
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
    assert.equal(warmed.treePathAudit.treeStaticStreamActivated, true);
    assert.equal(warmed.staticObjectStreaming.counts.plans > 0, true);
    let firstDraw = warmed;
    let activationDiagnosticFrameCount = 0;
    for (let attempt = 0; attempt < 100
      && (firstDraw.treePathAudit.activationTimeline.firstPersistentTreeDrawAtMs === null
        || firstDraw.treePathAudit.activationTimeline.firstDistantTreeVisibleAtMs === null);
      attempt += 1) {
      environment.rafCallbacks.at(-1)(performance.now() + 120 + attempt);
      activationDiagnosticFrameCount += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      firstDraw = outcome.sandbox.snapshot();
    }
    assert.notEqual(
      firstDraw.treePathAudit.activationTimeline.firstRequiredOwnerRequestAtMs,
      null,
    );
    assert.notEqual(firstDraw.treePathAudit.activationTimeline.firstReadyOwnerAtMs, null);
    assert.notEqual(
      firstDraw.treePathAudit.activationTimeline.firstPersistentTreePublishAtMs,
      null,
    );
    assert.notEqual(firstDraw.treePathAudit.activationTimeline.firstPersistentTreeDrawAtMs, null);
    assert.equal(
      firstDraw.treePathAudit.activationTimeline.staticStreamActivatedAtMs
        < firstDraw.treePathAudit.activationTimeline.firstDistantTreeVisibleAtMs,
      true,
      JSON.stringify(firstDraw.treePathAudit.activationTimeline),
    );
    assert.equal(firstDraw.treePathAudit.distant.some(path => (
      path.pathId === 'distant-static-tree'
        && path.rootCount === 1
        && path.planIds.length > 0
    )), true);
    assert.equal(
      firstDraw.treePathAudit.activationTimeline.outerWarmCompletedAtMs === null
        || firstDraw.treePathAudit.activationTimeline.firstPersistentTreePublishAtMs
          < firstDraw.treePathAudit.activationTimeline.outerWarmCompletedAtMs,
      true,
      'persistent Tree must publish before the independent outer warm completes',
    );
    t.diagnostic(`Static Tree activation timeline (first draw) ${JSON.stringify(
      firstDraw.treePathAudit.activationTimeline,
    )}`);
    let outerCompleted = firstDraw;
    for (let attempt = 0; attempt < 1_000
      && outerCompleted.treePathAudit.activationTimeline.outerWarmCompletedAtMs === null;
      attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      outerCompleted = outcome.sandbox.snapshot();
    }
    const activationTimeline = outerCompleted.treePathAudit.activationTimeline;
    assert.notEqual(activationTimeline.outerWarmCompletedAtMs, null);
    assert.equal(
      activationTimeline.staticStreamActivatedAtMs < activationTimeline.outerWarmCompletedAtMs,
      true,
    );
    assert.equal(
      activationTimeline.firstPersistentTreePublishAtMs < activationTimeline.outerWarmCompletedAtMs,
      true,
    );
    assert.equal(
      activationTimeline.staticStreamActivatedAtMs
        - activationTimeline.firstShadowPlanGeneratedAtMs < 50,
      true,
    );
    assert.equal(
      activationTimeline.firstRequiredOwnerRequestAtMs
        - activationTimeline.staticStreamActivatedAtMs < 50,
      true,
    );
    for (let attempt = 0; attempt < 1_000
      && outerCompleted.staticObjectStreaming.backlog > 0;
      attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      outerCompleted = outcome.sandbox.snapshot();
    }
    assert.equal(outerCompleted.staticObjectStreaming.backlog, 0);
    assert.equal(outerCompleted.staticObjectStreaming.counts.failed, 0);
    assert.equal(outerCompleted.presentation.staticTreeDuplicatePageQueueCount, 0);
    assert.equal(
      new Set([
        ...outerCompleted.staticObjectStreaming.queuedOwnerKeys,
        ...outerCompleted.staticObjectStreaming.inFlightOwnerKeys,
      ]).size,
      outerCompleted.staticObjectStreaming.queuedCount
        + outerCompleted.staticObjectStreaming.inFlightCount,
    );
    assert.equal(
      outerCompleted.staticObjectStreaming.counts.pendingReuse
        + outerCompleted.staticObjectStreaming.counts.readyHits > 0,
      true,
      'Distant warm must reuse Static Stream owners instead of generating duplicates',
    );
    t.diagnostic(`Static Tree activation timeline (outer complete) ${JSON.stringify(
      activationTimeline,
    )}`);
    t.diagnostic(`Static Tree outer warm ${JSON.stringify({
      ownerCount: outerCompleted.presentation.queryNaturalOwnerChunkCount,
      innerOwnerCount: outerCompleted.presentation.queryInnerNaturalOwnerChunkCount,
      ultraOwnerCount: outerCompleted.presentation.queryUltraOwnerChunkCount,
      ultraOnlyOwnerCount: outerCompleted.presentation.queryUltraOnlyOwnerChunkCount,
      forestHorizonOwnerCount: outerCompleted.presentation.queryForestHorizonOwnerChunkCount,
      forestHorizonOnlyOwnerCount:
        outerCompleted.presentation.queryForestHorizonOnlyOwnerChunkCount,
      farCacheHits: outerCompleted.presentation.queryFarOwnerChunkCacheHits,
      farCacheMisses: outerCompleted.presentation.queryFarOwnerChunkCacheMisses,
      ultraCacheHits: outerCompleted.presentation.queryUltraOwnerChunkCacheHits,
      ultraCacheMisses: outerCompleted.presentation.queryUltraOwnerChunkCacheMisses,
      forestHorizonCacheHits: outerCompleted.presentation.queryForestHorizonOwnerChunkCacheHits,
      forestHorizonCacheMisses:
        outerCompleted.presentation.queryForestHorizonOwnerChunkCacheMisses,
      innerWarmMs: outerCompleted.presentation.innerWarmDurationMs,
      ultraWarmMs: outerCompleted.presentation.ultraWarmDurationMs,
      forestHorizonWarmMs: outerCompleted.presentation.forestHorizonWarmDurationMs,
      preparationMs: outerCompleted.presentation.queryPreparationDurationMs,
      pendingReuse: outerCompleted.staticObjectStreaming.counts.pendingReuse,
      readyHits: outerCompleted.staticObjectStreaming.counts.readyHits,
    })}`);
    environment.listeners.get('keydown')({ code: 'KeyD', preventDefault() {} });
    environment.rafCallbacks.at(-1)(performance.now() + 120);
    environment.listeners.get('keyup')({ code: 'KeyD', preventDefault() {} });
    assert.ok(outcome.sandbox.logicalPlayer.x > playerXBeforeInput);
    const inputDiagnosticFrameCount = 1;
    environment.listeners.get('keydown')({ code: 'Tab', preventDefault() {} });
    environment.listeners.get('keydown')({ code: 'Digit1', preventDefault() {} });
    assert.equal(outcome.sandbox.snapshot().gameplay.state.activeScaleStageId, 'TINY');
    environment.listeners.get('keydown')({ code: 'Digit3', preventDefault() {} });
    assert.equal(outcome.sandbox.snapshot().gameplay.state.activeScaleStageId, 'MAX');
    assert.equal(
      WebGLRenderer.instances[0].renderCount,
      environment.rafInitializationStates.length,
    );
    assert.deepEqual(
      environment.rafInitializationStates,
      Array.from({
        length: 2 + activationDiagnosticFrameCount + inputDiagnosticFrameCount,
      }, () => true),
    );
    const expectedCancelledFrameId = environment.rafInitializationStates.length;
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
    assert.deepEqual(environment.cancelledFrames, [expectedCancelledFrameId]);
  } finally {
    environment.restore();
  }
});

test('GP-SAVE-03 pagehide directly captures dirty state and coordinates queue conflicts',
  verifyGpSave03Pagehide);

test('persistent Tree publication A/B flag preserves Near and Distant warm while withholding pages',
  async () => {
    const environment = installBrowserEquivalentEnvironment();
    let sandbox = null;
    try {
      globalThis.location.search = '?disablePersistentTreePublication=1';
      sandbox = await bootInfiniteWorldSandbox({
        globalObject: globalThis,
        THREE: FakeThree,
        viewport: environment.viewport,
        hud: environment.hud,
        requestedSeed: 'KaniNingen Infinite Natural World',
      });
      let snapshot = sandbox.snapshot();
      assert.equal(snapshot.boot.status, 'ready');
      assert.equal(snapshot.treePathAudit.near.active, true);
      assert.ok(snapshot.treePathAudit.near.instanceCount > 0);
      assert.equal(snapshot.staticObjectStreaming.counts.plans > 0, true);
      assert.equal(snapshot.presentation.staticTreePublishedOwnerCount, 0);

      for (let attempt = 0; attempt < 500
        && (snapshot.presentation.queryNaturalCandidateCount === 0
          || snapshot.staticObjectStreaming.readyPageQueueCount === 0);
        attempt += 1) {
        environment.rafCallbacks.at(-1)(performance.now() + 100 + attempt);
        await new Promise(resolve => setTimeout(resolve, 10));
        snapshot = sandbox.snapshot();
      }

      assert.ok(snapshot.presentation.queryNaturalCandidateCount > 0);
      assert.ok(snapshot.presentation.visibleCanonicalTreeCount > 0);
      assert.ok(snapshot.staticObjectStreaming.readyPageQueueCount > 0);
      assert.ok(snapshot.presentation.staticTreePublishedOwnerCount > 0,
        'Distant warm must retain its active-coverage seed display');
      assert.equal(
        snapshot.presentation.staticTreePublishedOwnerCount,
        snapshot.runtime.activeDataCount,
        'only the retained active-coverage seed may publish while A/B is disabled',
      );
      assert.equal(snapshot.presentation.staticTreeDuplicatePageQueueCount, 0);
      assert.equal(snapshot.staticObjectStreaming.counts.failed, 0);
      assert.equal(snapshot.treePathAudit.distant.some(path => (
        path.active && path.instanceCount > 0
      )), true);
      assert.equal(snapshot.treePathAudit.distant.some(path => (
        path.pathId === 'distant-legacy-tree' && path.instanceCount > 0
      )), false);
    } finally {
      if (sandbox) await sandbox.shutdown();
      environment.restore();
    }
  });

test('MAX Player movement waits for formal destination Terrain and resumes after transition',
  async () => {
    const environment = installBrowserEquivalentEnvironment();
    const controls = installExperienceControls();
    const transitionGate = createDeferredValue();
    const prepareRequests = [];
    const transitionRequests = [];
    let runtime = null;
    let blockedOwnerKey = null;
    let holdDestination = false;
    let sandbox = null;
    try {
      sandbox = await bootInfiniteWorldSandbox({
        globalObject: globalThis,
        THREE: FakeThree,
        viewport: environment.viewport,
        hud: environment.hud,
        requestedSeed: 'KaniNingen Infinite Natural World',
        runtimeFactory(options) {
          runtime = new ChunkRuntimeManager(options);
          const getChunkData = runtime.getChunkData.bind(runtime);
          const prepareTransition = runtime.prepareTransition.bind(runtime);
          const transitionToChunk = runtime.transitionToChunk.bind(runtime);
          runtime.getChunkData = (chunkX, chunkZ) => (
            holdDestination && `${chunkX},${chunkZ}` === blockedOwnerKey
              ? null : getChunkData(chunkX, chunkZ)
          );
          runtime.prepareTransition = (chunkX, chunkZ) => {
            if (holdDestination) prepareRequests.push(`${chunkX},${chunkZ}`);
            return prepareTransition(chunkX, chunkZ);
          };
          runtime.transitionToChunk = (chunkX, chunkZ) => {
            const key = `${chunkX},${chunkZ}`;
            if (holdDestination && key === blockedOwnerKey) {
              transitionRequests.push(key);
              return transitionGate.promise.then(() => transitionToChunk(chunkX, chunkZ));
            }
            return transitionToChunk(chunkX, chunkZ);
          };
          return runtime;
        },
      });

      controls.get('start-button').dispatch('click');
      await waitForLifeCycleCondition(() => (
        sandbox.snapshot().runStart?.startMode === 'new'
        && sandbox.snapshot().experience.runPhase === 'intro'
      ), 'MAX coverage test must enter the run');
      let frameNow = performance.now();
      for (let frameIndex = 0; frameIndex < 130
        && sandbox.snapshot().experience.runPhase !== 'playing'; frameIndex += 1) {
        frameNow += 50;
        environment.rafCallbacks.at(-1)(frameNow);
        await new Promise(resolveValue => setImmediate(resolveValue));
      }
      assert.equal(
        sandbox.snapshot().experience.runPhase,
        'playing',
        JSON.stringify({
          boot: sandbox.snapshot().boot,
          experience: sandbox.snapshot().experience,
          runtime: sandbox.snapshot().runtime,
        }),
      );
      await waitForLifeCycleCondition(() => {
        const streaming = sandbox.snapshot().runtime.streaming;
        return streaming.transitionPending === false && streaming.preparationPending === false;
      }, 'intro coverage work must settle before the blocked MAX step');
      await new Promise(resolveValue => setImmediate(resolveValue));
      environment.listeners.get('keydown')({ code: 'Digit3', preventDefault() {} });
      assert.equal(sandbox.snapshot().gameplay.state.activeScaleStageId, 'MAX');

      const before = sandbox.snapshot();
      const yaw = before.experience.camera.yaw;
      const directionX = Math.cos(yaw);
      const directionZ = -Math.sin(yaw);
      const chunkSize = LOGICAL_CHUNK_SIZE_METERS;
      const centerX = before.runtime.centerChunkX;
      const centerZ = before.runtime.centerChunkZ;
      sandbox.logicalPlayer.x = directionX >= 0
        ? (centerX + 1) * chunkSize - 0.05 : centerX * chunkSize + 0.05;
      sandbox.logicalPlayer.z = directionZ >= 0
        ? (centerZ + 1) * chunkSize - 0.05 : centerZ * chunkSize + 0.05;

      frameNow += 50;
      environment.rafCallbacks.at(-1)(frameNow);
      const retainedPosition = Object.freeze({
        x: sandbox.logicalPlayer.x,
        z: sandbox.logicalPlayer.z,
      });
      const retainedHeight = sandbox.snapshot().experience.playerVertical.terrainHeightMeters;
      const maxStepMeters = getW6ScaleProfile('MAX').movementMetersPerSecond * 1.45 * 0.05;
      const candidateX = retainedPosition.x + directionX * maxStepMeters;
      const candidateZ = retainedPosition.z + directionZ * maxStepMeters;
      const candidateChunkX = Math.floor(candidateX / chunkSize);
      const candidateChunkZ = Math.floor(candidateZ / chunkSize);
      blockedOwnerKey = `${candidateChunkX},${candidateChunkZ}`;
      assert.notEqual(blockedOwnerKey, `${centerX},${centerZ}`);

      holdDestination = true;
      environment.listeners.get('keydown')({ code: 'KeyD', preventDefault() {} });
      environment.listeners.get('keydown')({ code: 'ShiftLeft', preventDefault() {} });
      const frameCountBeforeBlockedMove = environment.rafCallbacks.length;
      frameNow += 50;
      environment.rafCallbacks.at(-1)(frameNow);

      assert.deepEqual({ x: sandbox.logicalPlayer.x, z: sandbox.logicalPlayer.z }, retainedPosition);
      assert.equal(
        sandbox.snapshot().experience.playerVertical.terrainHeightMeters,
        retainedHeight,
      );
      assert.deepEqual(prepareRequests, [blockedOwnerKey]);
      assert.deepEqual(transitionRequests, [blockedOwnerKey]);
      assert.equal(sandbox.snapshot().boot.status, 'ready');
      assert.equal(environment.rafCallbacks.length, frameCountBeforeBlockedMove + 1,
        'a blocked Terrain candidate must not stop the animation loop');

      holdDestination = false;
      transitionGate.resolve();
      await waitForLifeCycleCondition(() => (
        runtime.isCenteredAt(candidateChunkX, candidateChunkZ)
      ), 'destination transition must complete after canonical Terrain becomes ready');
      frameNow += 50;
      environment.rafCallbacks.at(-1)(frameNow);
      environment.listeners.get('keyup')({ code: 'KeyD', preventDefault() {} });
      environment.listeners.get('keyup')({ code: 'ShiftLeft', preventDefault() {} });
      assert.equal(
        Math.hypot(
          sandbox.logicalPlayer.x - retainedPosition.x,
          sandbox.logicalPlayer.z - retainedPosition.z,
        ) > 0,
        true,
        'MAX movement must resume once destination canonical Terrain is ready',
      );
      assert.equal(Number.isFinite(
        sandbox.snapshot().experience.playerVertical.terrainHeightMeters,
      ), true);
      assert.equal(sandbox.snapshot().boot.status, 'ready');
    } finally {
      holdDestination = false;
      transitionGate.resolve();
      if (sandbox) await sandbox.shutdown();
      environment.restore();
    }
  });

test('GP-LIFE-01 title preserves the interrupted World while home reset alone relocates Player', async () => {
  const environment = installBrowserEquivalentEnvironment();
  globalThis.location.search = '?disablePersistentTreePublication=1';
  const controls = installExperienceControls();
  const storage = new ControlledSaveStorage();
  const timers = createHeldBootTimers();
  let worldState = null;
  let sandbox = null;
  try {
    sandbox = await bootInfiniteWorldSandbox({
      globalObject: globalThis,
      THREE: FakeThree,
      viewport: environment.viewport,
      hud: environment.hud,
      requestedSeed: 'KaniNingen Infinite Natural World',
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      worldStateFactory(options) {
        worldState = new InfiniteWorldState(options);
        return worldState;
      },
      saveStoreFactory(options) {
        return new InfiniteWorldSaveStore({ ...options, storage });
      },
    });

    controls.get('start-button').dispatch('click');
    await waitForLifeCycleCondition(() => sandbox.snapshot().save.queue.committedGeneration === 1,
      'New Game must complete its initial Save');
    await waitForLifeCycleCondition(() => (
      sandbox.snapshot().runStart?.startMode === 'new'
      && sandbox.snapshot().experience.runPhase === 'intro'
    ),
      'New Game preparation must enter the run before lifecycle assertions');

    worldState.updatePlayer({ score: 7700, hp: 61 });
    let autosaveTimer = null;
    for (let frameIndex = 0; frameIndex < 3 && !autosaveTimer; frameIndex += 1) {
      environment.rafCallbacks.at(-1)(performance.now() + 100 + frameIndex * 20);
      await new Promise(resolveValue => setImmediate(resolveValue));
      autosaveTimer = [...timers.entries].reverse().find(
        entry => entry.active && entry.delayMs === 5_000,
      ) ?? null;
    }
    assert.ok(autosaveTimer, 'dirty gameplay must have a pending autosave before title');

    worldState.updatePlayer({ x: 37.25, z: -21.5, facingY: 1.25 });
    worldState.damageFeature({ stableId: 'wf1:tree:gp-life-01', maxHp: 80 }, 80);
    const reinforcementSequence = worldState.nextTankReinforcementSequence();
    worldState.ensureEntity({
      stableId: 'wf1:tank:gp-life-01', ownerChunkKey: '2,-2', type: 'tank',
      maxHp: W6_ENTITY_CONTRACTS.tank.maxHp, x: 36, z: -20, rotationY: 0.5,
      aiState: 'engage', spawned: true, reinforcementSequence,
    });
    worldState.ensureEntity({
      stableId: 'wf1:boss:gp-life-01', ownerChunkKey: '2,-2', type: 'boss',
      maxHp: W6_ENTITY_CONTRACTS.boss.maxHp, x: 39, z: -23, rotationY: 0.75,
      aiState: 'slither',
    });
    worldState.setManualBoss('wf1:boss:gp-life-01', 1);
    const interrupted = structuredClone(worldState.createSaveSnapshot());
    const interruptedChunk = { x: Math.floor(interrupted.player.x / 16), z: Math.floor(interrupted.player.z / 16) };

    controls.get('set-home-btn').dispatch('click');
    await waitForLifeCycleCondition(() => sandbox.snapshot().save.queue.committedGeneration === 2,
      'returning to title must flush the interrupted snapshot');
    assert.deepEqual(worldState.createSaveSnapshot(), interrupted);
    assert.deepEqual({
      x: Math.floor(sandbox.logicalPlayer.x / 16), z: Math.floor(sandbox.logicalPlayer.z / 16),
    }, interruptedChunk);

    autosaveTimer.active = false;
    autosaveTimer.callback();
    await new Promise(resolveValue => setImmediate(resolveValue));
    assert.deepEqual(worldState.createSaveSnapshot(), interrupted,
      'autosave after title cannot replace the interrupted location');

    const callsBeforePageHide = storage.calls.length;
    environment.listeners.get('pagehide')({ persisted: true });
    await waitForLifeCycleCondition(() => storage.calls.length > callsBeforePageHide,
      'pagehide after title must persist through the shared queue');
    const pagehideSnapshot = await decodeInfiniteWorldSave(storage.calls.at(-1).value, {
      worldSeedHash: worldState.worldSeedHash,
    });
    assert.deepEqual(pagehideSnapshot, interrupted);

    controls.get('continue-button').dispatch('click');
    await waitForLifeCycleCondition(
      () => sandbox.snapshot().runStart?.startMode === 'continue',
      () => `Continue must load the title-flushed Save: ${JSON.stringify({
        boot: sandbox.snapshot().boot,
        experience: sandbox.snapshot().experience,
        save: sandbox.snapshot().save,
        runtimeCenter: {
          x: sandbox.snapshot().runtime.centerChunkX,
          z: sandbox.snapshot().runtime.centerChunkZ,
        },
      })}`,
    );
    assert.deepEqual(worldState.createSaveSnapshot(), interrupted);
    assert.deepEqual(sandbox.snapshot().spatial.playerLogical, {
      x: interrupted.player.x, z: interrupted.player.z, facingY: interrupted.player.facingY,
    });

    const persistentBeforeHomeReset = structuredClone(interrupted);
    const spawnBeforeReset = sandbox.snapshot().spatial.spawn;
    const terrainBeforeHomeReset = sandbox.snapshot().experience.playerVertical.terrainHeightMeters;
    controls.get('set-reset-btn').dispatch('click');
    await waitForLifeCycleCondition(() => (
      sandbox.logicalPlayer.x === spawnBeforeReset.x
      && sandbox.logicalPlayer.z === spawnBeforeReset.z
      && sandbox.snapshot().runtime.centerChunkX === Math.floor(spawnBeforeReset.x / 16)
      && sandbox.snapshot().runtime.centerChunkZ === Math.floor(spawnBeforeReset.z / 16)
      && sandbox.snapshot().experience.playerVertical.terrainHeightMeters
        !== terrainBeforeHomeReset
    ), 'home reset alone must relocate Player to the formal spawn');
    assert.equal(sandbox.logicalPlayer.facingY, spawnBeforeReset.facingY);
    const afterHomeReset = worldState.createSaveSnapshot();
    assert.deepEqual({ ...afterHomeReset.player, x: 0, z: 0, facingY: 0 }, {
      ...persistentBeforeHomeReset.player, x: 0, z: 0, facingY: 0,
    });

    worldState.updatePlayer({ x: -34.5, z: 49.25, facingY: -0.8 });
    const beforeShutdown = structuredClone(worldState.createSaveSnapshot());
    controls.get('set-home-btn').dispatch('click');
    await waitForLifeCycleCondition(() => sandbox.snapshot().save.queue.committedGeneration >= 4,
      'the second title transition must flush the latest location');
    await sandbox.shutdown();
    sandbox = null;

    const restored = new InfiniteWorldState({
      worldSeed: worldState.worldSeed,
      worldSeedHash: worldState.worldSeedHash,
      playerSpawn: { x: 0, z: 0 },
    });
    await new InfiniteWorldSaveStore({
      storage, worldSeedHash: worldState.worldSeedHash,
    }).loadInto(restored);
    assert.deepEqual(restored.createSaveSnapshot(), beforeShutdown,
      'shutdown after title must preserve the latest interrupted snapshot for Continue');
  } finally {
    if (sandbox) await sandbox.shutdown();
    environment.restore();
  }
});

test('Render Distance presets keep fixed gameplay coverage and resync Distant roots live', async t => {
  const expected = {
    short: {
      natural: 84, terrain: 192, general: 112.5,
      settlementMetadata: 352, settlementRender: 112.5, atmosphere: 'disabled',
    },
    standard: {
      natural: 112, terrain: 256, general: 150,
      settlementMetadata: 656.25, settlementRender: 150, atmosphere: 'disabled',
    },
    current: {
      natural: 140, terrain: 352, general: 187.5,
      settlementMetadata: 875, settlementRender: 875, atmosphere: 'manual-fog-blend',
    },
  };
  const results = [];
  for (const preset of ['current', 'standard', 'short']) {
    const environment = installBrowserEquivalentEnvironment();
    try {
      const bootStartedAt = performance.now();
      const sandbox = await bootInfiniteWorldSandbox({
        globalObject: globalThis,
        THREE: FakeThree,
        viewport: environment.viewport,
        hud: environment.hud,
        requestedSeed: 'KaniNingen Infinite Natural World',
        worldStateFactory(options) {
          const state = new InfiniteWorldState(options);
          state.updateExperience({ settings: { renderDistance: preset } });
          return state;
        },
      });
      const bootMs = performance.now() - bootStartedAt;
      const values = expected[preset];
      const snapshot = sandbox.snapshot();
      assert.equal(snapshot.runtime.activeDataCount, 25);
      assert.equal(snapshot.runtime.renderedCount, 9);
      assert.equal(snapshot.runtime.cacheCapacity, 81);
      assert.equal(snapshot.presentation.renderDistancePreset, preset);
      assert.equal(snapshot.presentation.naturalVisibilityMeters, values.natural);
      assert.equal(snapshot.presentation.clipmapExtentMeters, values.terrain);
      assert.equal(snapshot.presentation.visibilityMeters, values.general);
      assert.equal(snapshot.presentation.settlementMetadataQueryDistanceMeters,
        values.settlementMetadata);
      assert.equal(snapshot.presentation.remoteHorizonHiddenDistanceMeters,
        values.settlementRender);
      assert.equal(snapshot.presentation.remoteHorizonFadeEndMeters,
        values.settlementRender);
      assert.equal(snapshot.presentation.remoteHorizonAtmosphereMode, values.atmosphere);
      assert.equal(snapshot.buildingSettlementShadow.matches, true,
        JSON.stringify(snapshot.buildingSettlementShadow));
      assert.equal(snapshot.worldStreaming.latestComparison.policies.filter(policy => (
        ['building-presentation', 'settlement-presentation'].includes(policy.kind)
      )).every(policy => policy.matches === true), true);
      assert.equal(snapshot.buildingSettlementStreaming.mode, 'shared');
      assert.equal(snapshot.buildingSettlementStreaming.counts.published, 1);
      assert.notEqual(snapshot.buildingSettlementStreaming.readyStage, null);
      assert.equal(snapshot.presentation.buildingPublicationSource, 'shared-streaming-plan');
      assert.equal(snapshot.presentation.settlementRoadPublicationSource, 'shared-streaming-plan');
      assert.equal(snapshot.presentation.settlementMetadataPublicationSource,
        'shared-streaming-plan');
      results.push({
        preset,
        bootMs,
        distantSyncMs: snapshot.presentation.syncDurationMs,
        rootSwapMs: snapshot.presentation.rootSwapDurationMs,
        workerRequests: snapshot.chunkDataService.counts.transportCalls,
        trackedInstances: snapshot.resources.trackedFeatureInstanceCount,
        canonicalMeshes: snapshot.presentation.canonicalMeshCount,
        remoteMeshes: snapshot.presentation.remoteHorizonMeshCount,
        visibleRemoteMeshes: snapshot.presentation.remoteHorizonVisibleMeshCount,
        remoteMaterials: snapshot.presentation.remoteHorizonMaterialCount,
        sceneObjects: snapshot.sceneObjectCount,
        drawCalls: snapshot.renderInfo.drawCalls,
        naturalOwners: snapshot.presentation.queryNaturalOwnerChunkCount,
        settlements: snapshot.presentation.queryCandidateCount,
        buildings: snapshot.presentation.canonicalBuildingRecordCount
          + snapshot.presentation.remoteHorizonBuildingCount,
        riverOwners: snapshot.presentation.visibleFarRiverOwnerCount,
      });

      await sandbox.shutdown();
    } finally {
      environment.restore();
    }
  }

  // Keep the live-resync measurement separate from the three boot samples so
  // its complete Far/Local rebuild and subsequent GC cannot contaminate a
  // later preset's cold-boot gate.
  const environment = installBrowserEquivalentEnvironment();
  try {
    const sandbox = await bootInfiniteWorldSandbox({
      globalObject: globalThis,
      THREE: FakeThree,
      viewport: environment.viewport,
      hud: environment.hud,
      requestedSeed: 'KaniNingen Infinite Natural World',
    });
    const before = sandbox.snapshot();
    const chunkIdentities = before.runtime.activeDataKeys.map(key => {
      const [chunkX, chunkZ] = key.split(',').map(Number);
      const chunk = sandbox.runtime.getChunkData(chunkX, chunkZ);
      return [key, chunk?.chunkId, chunk?.contentHash];
    });
    const switchStartedAt = performance.now();
    environment.renderDistanceControl.value = 'short';
    environment.renderDistanceControl.dispatch('change');
    const switching = sandbox.snapshot();
    assert.equal(switching.renderDistanceConsistency.requestedPreset, 'short');
    assert.equal(switching.renderDistanceConsistency.appliedPreset, 'current');
    assert.equal(switching.renderDistanceConsistency.presets.fog, 'current');
    assert.equal(switching.renderDistanceConsistency.mixed, false);
    assert.equal(switching.renderDistanceConsistency.requestedMismatch, true);
    assert.equal(switching.renderDistanceConsistency.publicationPending, true);
    assert.equal(switching.renderDistanceConsistency.atomicPublicationRequired, false);
    let switched = sandbox.snapshot();
    for (let attempt = 0; attempt < 1_000
      && (switched.presentation.renderDistancePreset !== 'short'
        || switched.presentation.clipmapExtentMeters !== 192
        || switched.presentation.farSyncPending
        || switched.renderDistanceConsistency.publicationPending);
      attempt += 1) {
      environment.rafCallbacks.at(-1)(performance.now() + 100 + attempt * 16);
      await new Promise(resolve => setTimeout(resolve, 10));
      switched = sandbox.snapshot();
    }
    const switchMs = performance.now() - switchStartedAt;
    assert.equal(switched.presentation.renderDistancePreset, 'short', JSON.stringify({
      consistency: switched.renderDistanceConsistency,
      presentation: {
        distant: switched.presentation.distantRenderDistancePreset,
        local: switched.presentation.localTerrainRenderDistancePreset,
        natural: switched.presentation.staticNaturalRenderDistancePreset,
        preparedDistant: switched.presentation.preparedDistantRenderDistancePreset,
        preparedLocal: switched.presentation.preparedLocalTerrainRenderDistancePreset,
        stagedNatural: switched.presentation.stagedStaticNaturalRenderDistancePreset,
      },
      staticObjectStreaming: switched.staticObjectStreaming,
    }));
    assert.equal(switched.renderDistanceConsistency.appliedPreset, 'short', JSON.stringify({
      boot: switched.boot,
      consistency: switched.renderDistanceConsistency,
    }));
    assert.equal(switched.renderDistanceConsistency.publicationPending, false);
    assert.equal(switched.renderDistanceConsistency.mixed, false);
    assert.equal(switched.renderDistanceConsistency.requestedMismatch, false);
    assert.equal(switched.staticObjectStreaming.policyCoverage.every(coverage => (
      coverage.readyRequiredOwnerCount === coverage.requiredOwnerCount
    )), true, 'atomic publication must wait for every required Natural owner');
    assert.equal(switched.runtime.activeDataCount, 25);
    assert.equal(switched.runtime.renderedCount, 9);
    assert.deepEqual(switched.runtime.activeDataKeys.map(key => {
      const [chunkX, chunkZ] = key.split(',').map(Number);
      const chunk = sandbox.runtime.getChunkData(chunkX, chunkZ);
      return [key, chunk?.chunkId, chunk?.contentHash];
    }), chunkIdentities, 'preset resync must not regenerate active ChunkData');
    assert.ok(switched.presentation.rootSwapDurationMs < 100);
    assert.ok(switched.presentation.localTerrainLastMaximumSliceMs < 100,
      `Local preset slice ${switched.presentation.localTerrainLastMaximumSliceMs}ms`);
    assert.ok(switched.presentation.localTerrainLastRootSwapDurationMs < 100,
      `Local root swap ${switched.presentation.localTerrainLastRootSwapDurationMs}ms`);
    const currentResult = results.find(result => result.preset === 'current');
    currentResult.presetSwitchMs = switchMs;
    currentResult.presetLocalSyncMs = switched.presentation.localTerrainLastSyncDurationMs;
    currentResult.presetMaximumMainThreadSliceMs =
      switched.presentation.localTerrainLastMaximumSliceMs;
    await sandbox.shutdown();
  } finally {
    environment.restore();
  }
  for (const result of results) t.diagnostic(JSON.stringify(result));
  if (runIsolatedW5BootPerformanceGate) {
    assert.ok(results.every(result => result.bootMs < 5_000));
  }
  assert.ok(results.every(result => result.rootSwapMs < 100));
});

test('measurement frames pass strict boolean simulation state into Gameplay Runtime', async () => {
  assert.equal(isW8GameplaySimulationEnabled('steady', 'menu', true), true);
  assert.equal(isW8GameplaySimulationEnabled('crossing', 'intro', true), true);
  assert.equal(isW8GameplaySimulationEnabled(null, 'playing', false), true);
  assert.equal(isW8GameplaySimulationEnabled(null, 'playing', true), false);
  assert.equal(isW8GameplaySimulationEnabled(null, 'menu', false), false);
  assert.equal(isW8GameplaySimulationEnabled(null, 'intro', false), false);

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

test('normal play skips detailed runtime snapshots and debug HUD writes while diagnostics are off', async () => {
  const environment = installBrowserEquivalentEnvironment();
  let snapshotCalls = 0;
  try {
    const sandbox = await bootInfiniteWorldSandbox({
      globalObject: globalThis,
      THREE: FakeThree,
      viewport: environment.viewport,
      hud: environment.hud,
      requestedSeed: 'KaniNingen Infinite Natural World',
      runtimeFactory(options) {
        const runtime = new ChunkRuntimeManager(options);
        const snapshot = runtime.snapshot.bind(runtime);
        runtime.snapshot = (...args) => {
          snapshotCalls += 1;
          return snapshot(...args);
        };
        return runtime;
      },
    });
    const snapshotsBeforeFrame = snapshotCalls;
    const hudBeforeFrame = environment.hud.innerHTML;
    environment.rafCallbacks[0](performance.now() + 100);
    assert.equal(snapshotCalls, snapshotsBeforeFrame);
    assert.equal(environment.hud.innerHTML, hudBeforeFrame);
    await sandbox.shutdown();
  } finally {
    environment.restore();
  }
});

test('a newly visible full Chunk object is damage-queryable before deferred presentation work', async () => {
  const environment = installBrowserEquivalentEnvironment();
  const timers = createHeldBootTimers();
  let gameplay = null;
  let sandbox = null;
  try {
    sandbox = await bootInfiniteWorldSandbox({
      globalObject: globalThis,
      THREE: FakeThree,
      viewport: environment.viewport,
      hud: environment.hud,
      requestedSeed: 'KaniNingen Infinite Natural World',
      measurementMode: 'steady',
      diagnosticProfile: {
        profileId: 'movement-presentation-regression',
        save: true,
        distant: true,
        shadows: true,
        transparency: true,
        gameplaySync: true,
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      gameplayRuntimeFactory(options) {
        gameplay = new InfiniteGameplayRuntime(options);
        return gameplay;
      },
    });
    const initial = sandbox.snapshot();
    // Move west through three boundaries toward the deterministic Settlement around x=32.
    // Three transitions are required to expose a rendered Chunk outside the old 5x5 Gameplay set.
    const targetChunkX = initial.runtime.centerChunkX - 3;
    const targetChunkZ = initial.runtime.centerChunkZ;
    for (let offset = 1; offset <= 3; offset += 1) {
      const nextChunkX = initial.runtime.centerChunkX - offset;
      sandbox.logicalPlayer.x = (nextChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
      sandbox.logicalPlayer.z = (targetChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
      environment.rafCallbacks.at(-1)(performance.now() + offset * 100);
      await waitForLifeCycleCondition(() => {
        const snapshot = sandbox.snapshot();
        return snapshot.runtime.centerChunkX === nextChunkX
          && snapshot.runtime.centerChunkZ === targetChunkZ
          && timers.entries.some(entry => entry.active && entry.delayMs === 0);
      }, () => JSON.stringify({
        nextChunkX,
        targetChunkZ,
        runtime: sandbox.snapshot().runtime,
        spatial: sandbox.snapshot().spatial,
        timers: timers.entries.map(entry => ({
          active: entry.active,
          delayMs: entry.delayMs,
        })),
      }));
    }
    environment.rafCallbacks.at(-1)(performance.now() + 400);

    await waitForLifeCycleCondition(() => {
      const snapshot = sandbox.snapshot();
      return snapshot.gameplay.transitionGeneration
        === snapshot.runtime.transitionContract.generation
        && snapshot.gameplay.coverageSignature
          === snapshot.runtime.transitionContract.coverageSignature;
    }, () => JSON.stringify({
      runtime: sandbox.snapshot().runtime.transitionContract,
      gameplay: sandbox.snapshot().gameplay,
    }));

    const moved = sandbox.snapshot();
    const visibleStableIds = new Set(sandbox.renderAdapter.visibleStableIdsSnapshot());
    const visibleTargets = [];
    const visibleSettlementBuildingIds = [];
    for (const key of moved.runtime.renderedKeys) {
      const [chunkX, chunkZ] = key.split(',').map(Number);
      const chunkData = sandbox.runtime.getChunkData(chunkX, chunkZ);
      for (const feature of chunkData.settlementFeatures ?? []) {
        if (feature.featureType === 'settlement-building'
          && visibleStableIds.has(feature.stableId)) {
          visibleSettlementBuildingIds.push(feature.stableId);
        }
      }
      const model = await createW6ChunkGameplay({
        chunkData,
        worldSeedHash: sandbox.generator.worldSeedHash,
        generatorMajor: sandbox.generator.generatorVersion.major,
      });
      for (const target of model.staticTargets) {
        if (visibleStableIds.has(target.stableId)) visibleTargets.push(target);
      }
    }
    assert.ok(visibleTargets.length > 0,
      'the transition fixture must expose at least one full destructible Object');
    assert.ok(visibleSettlementBuildingIds.length > 0,
      'the continuous boundary route must finish while approaching a visible Settlement');
    const mismatchedDamageTargets = visibleTargets
      .filter(target => {
        const resolved = gameplay.resolveCombatTarget(target.stableId);
        return !resolved?.target
          || resolved.target.ownerChunkKey !== target.ownerChunkKey
          || resolved.target.x !== target.x
          || resolved.target.z !== target.z;
      })
      .map(target => ({
        stableId: target.stableId,
        ownerChunkKey: target.ownerChunkKey,
        x: target.x,
        z: target.z,
        renderX: (target.x - moved.runtime.renderOrigin.renderOriginChunkX
          * LOGICAL_CHUNK_SIZE_METERS) * UNITS_PER_METER,
        renderZ: (target.z - moved.runtime.renderOrigin.renderOriginChunkZ
          * LOGICAL_CHUNK_SIZE_METERS) * UNITS_PER_METER,
      }));
    assert.equal(mismatchedDamageTargets.length, 0,
      `every visible full Object must enter the Gameplay damage query with the same Stable ID: ${
        JSON.stringify({
          runtimeCenter: {
            chunkX: moved.runtime.centerChunkX,
            chunkZ: moved.runtime.centerChunkZ,
          },
          renderOrigin: moved.runtime.renderOrigin,
          playerLogical: moved.spatial.playerLogical,
          playerRender: moved.spatial.playerRender,
          localTerrain: {
            epoch: moved.presentation.committedLocalTerrainEpoch,
            center: moved.presentation.localTerrainCoverageCenter,
            activeRoot: moved.presentation.activeLocalTerrainRootId,
            stagingRoot: moved.presentation.stagingLocalTerrainRootId,
          },
          far: {
            epoch: moved.presentation.committedEpoch,
            syncEpoch: moved.presentation.syncEpoch,
            buildOrigin: moved.presentation.buildOrigin,
            currentOrigin: moved.presentation.currentOrigin,
            pending: moved.presentation.farSyncPending,
          },
          gameplayActiveDataKeys: moved.gameplay.activeDataChunkKeys,
          mismatchCount: mismatchedDamageTargets.length,
          mismatchSample: mismatchedDamageTargets.slice(0, 5),
        })}`);
    assert.equal(moved.gameplay.activeDataSignature,
      moved.runtime.transitionContract.activeDataSignature);
    assert.equal(moved.gameplay.renderedSignature,
      moved.runtime.transitionContract.renderedSignature);
    const damageTarget = visibleTargets[0];
    const damageResult = gameplay.applyCombatDamage(damageTarget.stableId, 1);
    assert.equal(damageResult.stableId, damageTarget.stableId);
    assert.equal(damageResult.damage, 1,
      'a visible full Object must accept damage after the transition');

    await drainHeldZeroDelayTimersUntil(timers, () => {
      const snapshot = sandbox.snapshot();
      const contract = snapshot.runtime.transitionContract;
      return snapshot.presentation.presentationCoverageAligned
        && snapshot.presentation.localTerrainTransitionGeneration === contract.generation
        && snapshot.presentation.farTransitionGeneration === contract.generation
        && snapshot.gameplay.transitionGeneration === contract.generation
        && snapshot.presentation.localTerrainCoverageSignature === contract.coverageSignature
        && snapshot.presentation.farCoverageSignature === contract.coverageSignature
        && snapshot.gameplay.coverageSignature === contract.coverageSignature;
    }, () => JSON.stringify({
      runtime: sandbox.snapshot().runtime.transitionContract,
      presentation: sandbox.snapshot().presentation,
      gameplay: sandbox.snapshot().gameplay,
    }));
  } finally {
    if (sandbox) await sandbox.shutdown();
    environment.restore();
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
  const runtime = readFileSync(resolve(repoRoot, 'src/infinite-world/chunk-runtime-manager.js'), 'utf8');
  const distant = readFileSync(resolve(repoRoot, 'src/infinite-world/render/w8-distant-presentation.js'), 'utf8');
  const sources = `${bootstrap}\n${entry}\n${boot}`;
  assert.doesNotMatch(sources, /findInMacroRange\s*\(|41\s*[x×]\s*41|453\s+Settlement/);
  assert.doesNotMatch(sources, /runW1BChunkSizeBenchmark|golden|performance benchmark/i);
  assert.match(boot, /benchmarkExecuted:\s*false/);
  assert.match(boot, /startupSurveyExecuted:\s*false/);
  assert.match(boot, /initializationComplete\s*=\s*true[\s\S]*requestAnimationFrameFn\(frame\)/);
  assert.equal((boot.match(/scenePresentation\.rebase\([^)]*renderOrigin\);\s*\n\s*commitDistantRuntimeState\([^)]*\);\s*\n\s*await gameplayRenderAdapter\.rebase\([^)]*renderOrigin\);[\s\S]*?const gameplaySync[\s\S]*?synchronizeLocalTerrain/g) ?? []).length, 1,
    'explicit runtime relocation starts atomic Gameplay staging before Local/Far compose');
  assert.match(boot, /const gameplayRebase = gameplayRenderAdapter\.rebase\(nextState\.renderOrigin\);\s*\n\s*schedulePostCommitWork\(nextState\);\s*\n\s*await gameplayRebase;/,
    'moving Chunk transitions start Gameplay staging before the deferred Local/Far pump');
  assert.match(boot, /const gameplayWork = gameplaySyncWorkByEpoch[\s\S]*distant-local-terrain-sync[\s\S]*distant-sync[\s\S]*await gameplayWork/,
    'the pump joins the already-started Gameplay staging after Local/Far compose');
  assert.match(boot, /async function shutdown\(\) \{[\s\S]*running = false;\s*\n\s*distantPresentation\.invalidatePendingLocalTerrainSync\?\.\(\);\s*\n\s*distantPresentation\.invalidatePendingFarSync\?\.\(\);/,
    'shutdown invalidates detached Local and Far builds before awaiting Save or subsystem disposal');
  assert.doesNotMatch(boot, /distantPresentation\.rebase\(runtimeState\.renderOrigin\)[\s\S]*synchronizeLocalTerrain\(runtimeState\)/,
    'delayed work cannot reapply an origin or rebuild Local terrain from an older snapshot');
  assert.match(html, /<script type="module" src="\.\/src\/infinite-world\/sandbox-entry\.js\?v=w8-finite-parity"><\/script>/);
  assert.equal(existsSync(resolve(repoRoot, 'src/infinite-world/sandbox-entry.js')), true);
  assert.equal(existsSync(resolve(repoRoot, 'src/infinite-world/sandbox-main.js')), true);
  assert.doesNotMatch(entry, /await\s+(?:bootPromise|waitForSandboxDom)|waitForSandboxDom/);
  assert.match(boot, /new ChunkDataService\(/);
  assert.match(boot, /createInlineChunkGeneratorTransport/);
  assert.doesNotMatch(runtime, /this\.generator\.generateChunk/);
  assert.doesNotMatch(boot, /runtime\.getChunkData\([^)]*\)\s*\?\?\s*generator\.generateChunk/);
  assert.doesNotMatch(boot, /getChunkDataForQuery:\s*\([^)]*\)\s*=>\s*generator\.generateChunk/);
  assert.doesNotMatch(distant, /generator\.generateChunk/);
});
