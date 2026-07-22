import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import {
  bootInfiniteWorldSandbox,
  createSandboxBootState,
  createSandboxEntryController,
  recordSandboxBootFailure,
} from '../src/infinite-world/sandbox-boot.js';

const repoRoot = resolve(import.meta.dirname, '..');

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
  clear() { this.children = []; }
  updateMatrix() { this.matrix = { position: { ...this.position }, scale: { ...this.scale } }; }
}
class Group extends NodeObject {}
class Scene extends Group {}
class Geometry {
  constructor() { this.attributes = {}; }
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
class Material {
  constructor(options) { this.options = options; }
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
    this.matrices = [];
  }
  setMatrixAt(index, matrix) { this.matrices[index] = structuredClone(matrix); }
}
class LineSegments extends Mesh {}
class Object3D extends NodeObject {}
class PerspectiveCamera extends NodeObject {
  updateProjectionMatrix() {}
  lookAt() {}
}
class HemisphereLight extends NodeObject {}
class DirectionalLight extends NodeObject {}
class Color { constructor(value) { this.value = value; } }
class Fog { constructor(...values) { this.values = values; } }
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
    assert.equal(snapshot.boot.macroRegionsEvaluated, 53);
    assert.equal(snapshot.boot.rawSettlementCandidateCount, 39);
    assert.equal(snapshot.boot.acceptedSettlementCandidateCount, 1);
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

    const renderedKeys = new Set(snapshot.runtime.renderedKeys);
    assert.equal(Object.keys(snapshot.resources.chunkRenderables).every(key => renderedKeys.has(key)), true);
    const playerXBeforeInput = outcome.sandbox.logicalPlayer.x;
    environment.listeners.get('keydown')({ code: 'KeyD', preventDefault() {} });
    environment.rafCallbacks[0](performance.now() + 100);
    environment.listeners.get('keyup')({ code: 'KeyD', preventDefault() {} });
    assert.ok(outcome.sandbox.logicalPlayer.x > playerXBeforeInput);
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
    assert.equal(WebGLRenderer.instances[0].disposed, true);
    assert.deepEqual(environment.cancelledFrames, [2]);
  } finally {
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
    target: { src: 'http://127.0.0.1:8021/src/infinite-world/sandbox-entry.js?v=w6-official-runtime' },
  });
  assert.match(fixture.hud.textContent, /起動失敗: MODULE_LOAD/);
  assert.match(fixture.hud.textContent, /Error: Module script failed to load/);
  assert.match(fixture.hud.textContent, /Source: http:\/\/127\.0\.0\.1:8021\/src\/infinite-world\/sandbox-entry\.js\?v=w6-official-runtime/);
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
  assert.match(html, /<script type="module" src="\.\/src\/infinite-world\/sandbox-entry\.js\?v=w6-official-runtime"><\/script>/);
  assert.equal(existsSync(resolve(repoRoot, 'src/infinite-world/sandbox-entry.js')), true);
  assert.equal(existsSync(resolve(repoRoot, 'src/infinite-world/sandbox-main.js')), true);
  assert.doesNotMatch(entry, /await\s+(?:bootPromise|waitForSandboxDom)|waitForSandboxDom/);
});
