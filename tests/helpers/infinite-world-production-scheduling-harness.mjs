import { bootInfiniteWorldSandbox } from '../../src/infinite-world/sandbox-boot.js';
import { createNodeChunkGeneratorWorker } from '../../src/infinite-world/node-worker-chunk-generator-adapter.js';

export const PRODUCTION_FRAME_MS = 1_000 / 60;
export const PRODUCTION_FRAME_SECONDS = PRODUCTION_FRAME_MS / 1_000;

const nativeSetImmediate = globalThis.setImmediate.bind(globalThis);
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

const waitForImmediate = () => new Promise(resolve => nativeSetImmediate(resolve));
const waitForHostDelay = delayMs => new Promise(resolve => nativeSetTimeout(resolve, delayMs));

export function createProductionVirtualScheduler({
  startAtMs = 10_000,
  frameMs = PRODUCTION_FRAME_MS,
} = {}) {
  if (!Number.isFinite(startAtMs)) throw new TypeError('virtual start time must be finite');
  if (!Number.isFinite(frameMs) || frameMs <= 0) {
    throw new RangeError('virtual frame duration must be positive');
  }

  let nowMs = startAtMs;
  let sequence = 0;
  let timerPumpScheduled = false;
  const animationFrames = new Map();
  const timers = new Map();
  const frameTimestamps = [];
  const asynchronousErrors = [];

  const throwAsynchronousError = () => {
    if (asynchronousErrors.length > 0) throw asynchronousErrors.shift();
  };
  const dueTimers = () => [...timers.values()]
    .filter(timer => timer.dueAtMs <= nowMs)
    .sort((left, right) => left.dueAtMs - right.dueAtMs || left.id - right.id);
  const runDueTimers = () => {
    let ran = 0;
    for (const timer of dueTimers()) {
      if (!timers.delete(timer.id)) continue;
      try { timer.callback(...timer.args); }
      catch (error) { asynchronousErrors.push(error); }
      ran += 1;
    }
    return ran;
  };
  const scheduleTimerPump = () => {
    if (timerPumpScheduled) return;
    timerPumpScheduled = true;
    nativeSetImmediate(() => {
      timerPumpScheduled = false;
      runDueTimers();
      if (dueTimers().length > 0) scheduleTimerPump();
    });
  };

  const requestAnimationFrame = callback => {
    if (typeof callback !== 'function') throw new TypeError('rAF callback must be a function');
    const id = ++sequence;
    animationFrames.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = id => animationFrames.delete(id);
  const setTimeout = (callback, delayMs = 0, ...args) => {
    if (typeof callback !== 'function') throw new TypeError('timer callback must be a function');
    const id = ++sequence;
    const normalizedDelay = Number.isFinite(Number(delayMs))
      ? Math.max(0, Number(delayMs)) : 0;
    timers.set(id, { id, callback, args, dueAtMs: nowMs + normalizedDelay });
    if (normalizedDelay === 0) scheduleTimerPump();
    return id;
  };
  const clearTimeout = id => timers.delete(id);

  async function settleHostTasks({ turns = 3, delayMs = 0 } = {}) {
    for (let turn = 0; turn < turns; turn += 1) {
      runDueTimers();
      await waitForImmediate();
    }
    if (delayMs > 0) await waitForHostDelay(delayMs);
    runDueTimers();
    throwAsynchronousError();
  }

  async function advanceFrame({ hostTurns = 3, hostDelayMs = 0 } = {}) {
    throwAsynchronousError();
    const next = [...animationFrames.entries()].sort((left, right) => left[0] - right[0])[0];
    if (!next) throw new Error('production boot did not schedule its next animation frame');
    animationFrames.delete(next[0]);
    nowMs += frameMs;
    frameTimestamps.push(nowMs);
    next[1](nowMs);
    await settleHostTasks({ turns: hostTurns, delayMs: hostDelayMs });
    return nowMs;
  }

  async function advanceFrames(count, options) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('frame count must be a non-negative safe integer');
    }
    for (let frame = 0; frame < count; frame += 1) await advanceFrame(options);
    return nowMs;
  }

  return Object.freeze({
    clock: () => nowMs,
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout,
    clearTimeout,
    settleHostTasks,
    advanceFrame,
    advanceFrames,
    snapshot: () => Object.freeze({
      nowMs,
      frameMs,
      frameCount: frameTimestamps.length,
      frameTimestamps: Object.freeze([...frameTimestamps]),
      pendingAnimationFrameCount: animationFrames.size,
      pendingTimerCount: timers.size,
    }),
  });
}

class Triple {
  constructor() { this.set(0, 0, 0); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(value) { return this.set(value.x, value.y, value.z); }
  clone() { return new Triple().copy(this); }
}

class NodeObject {
  constructor() {
    this.children = [];
    this.parent = null;
    this.position = new Triple();
    this.rotation = new Triple();
    this.scale = new Triple().set(1, 1, 1);
    this.userData = {};
    this.visible = true;
    this.frustumCulled = true;
    this.renderOrder = 0;
    this.matrix = matrixFromTransform(this.position, this.scale);
    this.matrixWorld = this.matrix;
  }
  add(...children) {
    for (const child of children) {
      if (!child) continue;
      child.parent?.remove?.(child);
      this.children.push(child);
      child.parent = this;
    }
    return this;
  }
  remove(...children) {
    const removals = new Set(children);
    for (const child of this.children) if (removals.has(child)) child.parent = null;
    this.children = this.children.filter(child => !removals.has(child));
    return this;
  }
  clear() {
    for (const child of this.children) child.parent = null;
    this.children = [];
  }
  traverse(visitor) {
    visitor(this);
    for (const child of this.children) child.traverse?.(visitor) ?? visitor(child);
  }
  updateMatrix() {
    this.matrix = matrixFromTransform(this.position, this.scale);
    this.matrixWorld = this.matrix;
  }
  updateMatrixWorld() { this.updateMatrix(); }
}

function matrixFromTransform(position, scale) {
  return Object.freeze({
    elements: Object.freeze([
      scale.x, 0, 0, 0,
      0, scale.y, 0, 0,
      0, 0, scale.z, 0,
      position.x, position.y, position.z, 1,
    ]),
    position: Object.freeze({ x: position.x, y: position.y, z: position.z }),
    scale: Object.freeze({ x: scale.x, y: scale.y, z: scale.z }),
  });
}

class Group extends NodeObject {}
class Scene extends Group {
  static instances = [];
  constructor() { super(); Scene.instances.push(this); }
}

class BufferAttribute {
  constructor(values, itemSize) {
    this.array = ArrayBuffer.isView(values) ? values : new Float32Array(values);
    this.values = this.array;
    this.itemSize = itemSize;
    this.size = itemSize;
    this.count = Math.floor(this.array.length / itemSize);
    this.version = 0;
    this.updateRanges = [];
  }
  set needsUpdate(value) { if (value === true) this.version += 1; }
  setUsage(value) { this.usage = value; return this; }
  addUpdateRange(start, count) { this.updateRanges.push({ start, count }); }
  clearUpdateRanges() { this.updateRanges.length = 0; }
}
class Float32BufferAttribute extends BufferAttribute {}
class InstancedBufferAttribute extends BufferAttribute {}

class Geometry {
  constructor() { this.attributes = {}; this.index = null; }
  clone() {
    const clone = new this.constructor();
    clone.attributes = { ...this.attributes };
    clone.index = this.index;
    return clone;
  }
  setAttribute(name, value) { this.attributes[name] = value; return this; }
  setIndex(index) { this.index = index; return this; }
  computeVertexNormals() {}
  dispose() { this.disposed = true; }
}
class PlaneGeometry extends Geometry {}
class ConeGeometry extends Geometry {}
class DodecahedronGeometry extends Geometry {}
class BufferGeometry extends Geometry {}
class CylinderGeometry extends Geometry {}

class Color {
  constructor(value = 0xffffff) { this.set(value); }
  set(value) {
    this.value = value instanceof Color ? value.value : Number(value);
    this.isColor = true;
    this.r = ((this.value >> 16) & 0xff) / 255;
    this.g = ((this.value >> 8) & 0xff) / 255;
    this.b = (this.value & 0xff) / 255;
    return this;
  }
  setRGB(r, g, b) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.value = (Math.round(r * 255) << 16)
      | (Math.round(g * 255) << 8)
      | Math.round(b * 255);
    return this;
  }
  copy(value) { return this.set(value); }
  clone() { return new Color(this.value); }
  getHex() { return this.value; }
}

class Material {
  constructor(options = {}) {
    this.options = { ...options };
    Object.assign(this, options);
    this.visible ??= true;
    this.opacity ??= 1;
    if (options.color !== undefined) this.color = new Color(options.color);
  }
  clone() { return new this.constructor({ ...this.options }); }
  dispose() { this.disposed = true; }
}
class MeshLambertMaterial extends Material {}
class LineBasicMaterial extends Material {}

class Mesh extends NodeObject {
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
    this.isMesh = true;
  }
}
class InstancedMesh extends Mesh {
  constructor(geometry, material, capacity) {
    super(geometry, material);
    this.capacity = capacity;
    this.count = capacity;
    this.isInstancedMesh = true;
    this.instanceMatrix = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    this.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.matrices = [];
    this.colors = [];
  }
  setMatrixAt(index, matrix) {
    this.matrices[index] = matrix;
    const elements = matrix?.elements ?? matrixFromTransform(
      matrix?.position ?? new Triple(),
      matrix?.scale ?? new Triple().set(1, 1, 1),
    ).elements;
    this.instanceMatrix.array.set(elements, index * 16);
  }
  setColorAt(index, color) {
    this.colors[index] = color;
    const hex = color?.getHex?.() ?? color?.value ?? Number(color) ?? 0xffffff;
    this.instanceColor.array.set([
      ((hex >> 16) & 0xff) / 255,
      ((hex >> 8) & 0xff) / 255,
      (hex & 0xff) / 255,
    ], index * 3);
  }
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
  lookAt(targetOrX, y, z) {
    this.lookAtTarget = typeof targetOrX === 'object'
      ? { ...targetOrX } : { x: targetOrX, y, z };
  }
}
class HemisphereLight extends NodeObject {}
class DirectionalLight extends NodeObject {}
class Fog {
  static instances = [];
  constructor(color, near, far) {
    this.color = new Color(color);
    Object.assign(this, { near, far, values: [color, near, far] });
    Fog.instances.push(this);
  }
}

class FakeCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.removed = false;
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  remove() { this.removed = true; }
  requestPointerLock() { return Promise.resolve(); }
  getContext() { return null; }
}

class WebGLRenderer {
  static instances = [];
  constructor() {
    this.renderCount = 0;
    this.domElement = new FakeCanvas();
    this.shadowMap = {};
    this.info = {
      render: { calls: 0, triangles: 0 },
      memory: { geometries: 0, textures: 0 },
    };
    this.gpuAttributes = new WeakMap();
    this.attributes = { get: attribute => this.gpuAttributes.get(attribute) };
    WebGLRenderer.instances.push(this);
  }
  setPixelRatio(value) { this.pixelRatio = value; }
  setSize(width, height) {
    this.domElement.width = width;
    this.domElement.height = height;
  }
  syncAttribute(attribute) {
    if (!attribute?.array) return;
    let mirror = this.gpuAttributes.get(attribute);
    if (!mirror) {
      mirror = { version: attribute.version ?? 0, array: attribute.array.slice() };
      this.gpuAttributes.set(attribute, mirror);
    } else if (mirror.version !== (attribute.version ?? 0)) {
      if (attribute.updateRanges?.length > 0) {
        for (const range of attribute.updateRanges) {
          const end = range.count < 0 ? attribute.array.length : range.start + range.count;
          mirror.array.set(attribute.array.subarray(range.start, end), range.start);
        }
      } else mirror.array.set(attribute.array);
      mirror.version = attribute.version ?? 0;
    }
    attribute.clearUpdateRanges?.();
  }
  render(scene, camera) {
    let drawCalls = 0;
    const visit = (object, hierarchyVisible) => {
      const visible = hierarchyVisible && object?.visible !== false;
      if (visible && object?.geometry && object?.material
        && object.material.visible !== false && (object.count ?? 1) > 0) {
        for (const attribute of Object.values(object.geometry.attributes ?? {})) {
          this.syncAttribute(attribute);
        }
        this.syncAttribute(object.instanceMatrix);
        this.syncAttribute(object.instanceColor);
        object.onBeforeRender?.(this, scene, camera, object.geometry, object.material, null);
        drawCalls += 1;
        object.onAfterRender?.(this, scene, camera, object.geometry, object.material, null);
      }
      for (const child of object?.children ?? []) visit(child, visible);
    };
    visit(scene, true);
    this.renderCount += 1;
    this.info.render.calls = drawCalls;
  }
  gpuMirrorSnapshot(scene) {
    const attributes = [];
    const visit = (object, path) => {
      const nextPath = [...path, object?.name || object?.constructor?.name || 'Object'];
      const sources = [
        ...Object.entries(object?.geometry?.attributes ?? {}),
        ['instanceMatrix', object?.instanceMatrix],
        ['instanceColor', object?.instanceColor],
      ];
      for (const [name, attribute] of sources) {
        if (!attribute?.array) continue;
        const mirror = this.gpuAttributes.get(attribute) ?? null;
        attributes.push(Object.freeze({
          objectName: object?.name ?? null,
          path: nextPath.join('/'),
          attributeName: name,
          cpuVersion: attribute.version ?? 0,
          gpuVersion: mirror?.version ?? null,
          cpuArray: attribute.array.slice(),
          gpuArray: mirror?.array.slice() ?? null,
        }));
      }
      for (const child of object?.children ?? []) visit(child, nextPath);
    };
    if (scene) visit(scene, []);
    return Object.freeze(attributes);
  }
  dispose() { this.disposed = true; }
}

export const ProductionHarnessThree = Object.freeze({
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
  DynamicDrawUsage: 'dynamic-draw',
  PCFSoftShadowMap: 'pcf-soft',
  SRGBColorSpace: 'srgb',
});

function createListenerHub() {
  const listeners = new Map();
  const addEventListener = (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
  };
  const removeEventListener = (type, listener) => listeners.get(type)?.delete(listener);
  const dispatch = (type, values = {}) => {
    const event = {
      type,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...values,
    };
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    return event;
  };
  return Object.freeze({ addEventListener, removeEventListener, dispatch });
}

function installProductionBrowserBoundary({ scheduler, search = '' }) {
  const saved = new Map();
  const setGlobal = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const windowEvents = createListenerHub();
  const documentEvents = createListenerHub();
  const viewport = {
    children: [],
    append(child) { this.children.push(child); child.parentElement = this; },
  };
  const hud = { innerHTML: '', textContent: '' };
  const renderDistanceEvents = createListenerHub();
  const renderDistanceControl = {
    value: 'current',
    addEventListener: renderDistanceEvents.addEventListener,
    removeEventListener: renderDistanceEvents.removeEventListener,
  };
  const documentObject = {
    readyState: 'complete',
    documentElement: { dataset: {} },
    addEventListener: documentEvents.addEventListener,
    removeEventListener: documentEvents.removeEventListener,
    getElementById(id) { return id === 'set-render-distance' ? renderDistanceControl : null; },
    querySelectorAll() { return []; },
    querySelector(selector) {
      if (selector === '#viewport') return viewport;
      if (selector === '#hud') return hud;
      return null;
    },
  };

  Scene.instances.length = 0;
  PerspectiveCamera.instances.length = 0;
  Fog.instances.length = 0;
  WebGLRenderer.instances.length = 0;
  setGlobal('THREE', ProductionHarnessThree);
  setGlobal('document', documentObject);
  setGlobal('location', { search });
  setGlobal('innerWidth', 1920);
  setGlobal('innerHeight', 1080);
  setGlobal('devicePixelRatio', 1);
  setGlobal('performance', {
    timeOrigin: 0,
    now: scheduler.clock,
  });
  setGlobal('addEventListener', windowEvents.addEventListener);
  setGlobal('removeEventListener', windowEvents.removeEventListener);
  setGlobal('requestAnimationFrame', scheduler.requestAnimationFrame);
  setGlobal('cancelAnimationFrame', scheduler.cancelAnimationFrame);
  // W8 presentation continuations currently read the global timer directly
  // instead of the boot injection. Route that remaining production seam into
  // the same deterministic scheduler so every main-thread timestamp and task
  // deadline observes this one virtual clock.
  setGlobal('setTimeout', scheduler.setTimeout);
  setGlobal('clearTimeout', scheduler.clearTimeout);

  return Object.freeze({
    viewport,
    hud,
    documentObject,
    dispatchWindowEvent: windowEvents.dispatch,
    renderer: () => WebGLRenderer.instances.at(-1) ?? null,
    scene: () => Scene.instances.at(-1) ?? null,
    restore() {
      for (const [key, descriptor] of [...saved].reverse()) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  });
}

export async function bootProductionSchedulingHarness({
  requestedSeed = 'KaniNingen Infinite Natural World',
  search = '',
  workerFactory = createNodeChunkGeneratorWorker,
  frameMs = PRODUCTION_FRAME_MS,
} = {}) {
  const scheduler = createProductionVirtualScheduler({ frameMs });
  const environment = installProductionBrowserBoundary({ scheduler, search });
  let sandbox = null;
  let closed = false;
  const pressedKeys = new Set();

  try {
    sandbox = await bootInfiniteWorldSandbox({
      globalObject: globalThis,
      THREE: ProductionHarnessThree,
      viewport: environment.viewport,
      hud: environment.hud,
      requestedSeed,
      chunkGeneratorWorkerFactory: workerFactory,
      clock: scheduler.clock,
      requestAnimationFrameFn: scheduler.requestAnimationFrame,
      cancelAnimationFrameFn: scheduler.cancelAnimationFrame,
      setTimeoutFn: scheduler.setTimeout,
      clearTimeoutFn: scheduler.clearTimeout,
    });
  } catch (error) {
    environment.restore();
    throw error;
  }

  const dispatchKey = (type, code) => environment.dispatchWindowEvent(type, { code });
  const press = (...codes) => {
    for (const code of codes) {
      if (pressedKeys.has(code)) continue;
      pressedKeys.add(code);
      dispatchKey('keydown', code);
    }
  };
  const release = (...codes) => {
    for (const code of codes) {
      if (!pressedKeys.delete(code)) continue;
      dispatchKey('keyup', code);
    }
  };
  const releaseAll = () => release(...pressedKeys);

  const advanceFrame = async options => {
    try { return await scheduler.advanceFrame(options); }
    catch (error) {
      const boot = sandbox.snapshot().boot;
      if (boot.status !== 'failed') throw error;
      throw new Error(`production animation loop failed: ${boot.error?.message
        ?? boot.bootError?.message ?? JSON.stringify(boot)}`, { cause: error });
    }
  };

  async function advanceUntil(predicate, {
    maximumFrames = 180,
    hostDelayMs = 2,
    message = 'production scheduling condition did not settle',
  } = {}) {
    for (let frame = 0; frame < maximumFrames; frame += 1) {
      const snapshot = sandbox.snapshot();
      if (predicate(snapshot)) return snapshot;
      await advanceFrame({ hostDelayMs });
    }
    const snapshot = sandbox.snapshot();
    if (!predicate(snapshot)) throw new Error(`${message}: ${JSON.stringify({
      player: snapshot.spatial.playerLogical,
      runtimeCenter: [snapshot.runtime.centerChunkX, snapshot.runtime.centerChunkZ],
      transitionPending: snapshot.runtime.streaming?.transitionPending ?? null,
      workerMode: snapshot.chunkDataService.transport?.mode ?? null,
      workerCounts: snapshot.chunkDataService.transport?.counts ?? null,
      ownerGeneration: snapshot.ownerGeneration ?? null,
      terrainDependency: snapshot.runtime.terrainReady?.terrainDependencyDiagnostics ?? null,
      terrainPlan: {
        planEpoch: snapshot.runtime.terrainReady?.planEpoch ?? null,
        planReady: snapshot.runtime.terrainReady?.planReady ?? null,
        planFailed: snapshot.runtime.terrainReady?.planFailed ?? null,
        queueDepth: snapshot.runtime.terrainReady?.queueDepth ?? null,
        oldestWaitMs: snapshot.runtime.terrainReady?.oldestWaitMs ?? null,
      },
      staticBacklog: snapshot.staticObjectStreaming?.backlog ?? null,
    })}`);
    return snapshot;
  }

  return Object.freeze({
    sandbox,
    scheduler,
    environment,
    press,
    release,
    releaseAll,
    mouseMove(values) { environment.dispatchWindowEvent('mousemove', values); },
    advanceFrame,
    async advanceFrames(count, options) {
      for (let frame = 0; frame < count; frame += 1) await advanceFrame(options);
      return scheduler.clock();
    },
    advanceUntil,
    snapshot: () => sandbox.snapshot(),
    gpuMirrorSnapshot: () => environment.renderer()?.gpuMirrorSnapshot(
      environment.scene(),
    ) ?? Object.freeze([]),
    async shutdown() {
      if (closed) return;
      closed = true;
      releaseAll();
      try { await sandbox.shutdown(); }
      finally { environment.restore(); }
    },
  });
}
