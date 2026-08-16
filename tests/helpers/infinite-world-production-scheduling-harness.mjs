import { bootInfiniteWorldSandbox } from '../../src/infinite-world/sandbox-boot.js';
import { LOGICAL_CHUNK_SIZE_METERS } from '../../src/infinite-world/chunk-coordinates.js';
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
    for (const child of this.children) {
      if (typeof child.traverse === 'function') child.traverse(visitor);
      else visitor(child);
    }
  }
  updateMatrix() {
    this.matrix = matrixFromTransform(this.position, this.scale);
    this.matrixWorld = this.matrix;
  }
  updateMatrixWorld() { this.updateMatrix(); }
}

export function productionHarnessTraverseVisitCount() {
  const root = new NodeObject();
  const child = new NodeObject();
  root.add(child);
  let childVisits = 0;
  root.traverse(object => { childVisits += Number(object === child); });
  return childVisits;
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
class Uint32BufferAttribute extends BufferAttribute {}
class InstancedBufferAttribute extends BufferAttribute {}

class Geometry {
  constructor() { this.attributes = {}; this.index = null; this.userData = {}; this.groups = []; }
  clone() {
    const clone = new this.constructor();
    clone.attributes = { ...this.attributes };
    clone.index = this.index;
    clone.userData = { ...this.userData };
    clone.groups = this.groups.map(group => ({ ...group }));
    return clone;
  }
  setAttribute(name, value) { this.attributes[name] = value; return this; }
  setIndex(index) { this.index = index; return this; }
  addGroup(start, count, materialIndex) { this.groups.push({ start, count, materialIndex }); }
  computeVertexNormals() {}
  dispose() { this.disposed = true; }
}
function populateTriangleGeometry(geometry, triangleCount) {
  const positions = new Float32Array(triangleCount * 9);
  const normals = new Float32Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 9;
    positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0], offset);
    normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1], offset);
    indices.set([triangle * 3, triangle * 3 + 1, triangle * 3 + 2], triangle * 3);
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.userData.productionHarnessTriangleCount = triangleCount;
}
class PlaneGeometry extends Geometry {
  constructor() { super(); populateTriangleGeometry(this, 2); }
}
class BoxGeometry extends Geometry {
  constructor() { super(); populateTriangleGeometry(this, 12); }
}
class ConeGeometry extends Geometry {
  constructor(radius = 1, height = 1, radialSegments = 8) {
    super();
    populateTriangleGeometry(this, Math.max(3, Math.trunc(radialSegments)) * 3);
  }
}
class SphereGeometry extends Geometry {
  constructor(radius = 1, widthSegments = 12, heightSegments = 12) {
    super();
    const width = Math.max(3, Math.trunc(widthSegments));
    const height = Math.max(2, Math.trunc(heightSegments));
    populateTriangleGeometry(this, width * (height - 1) * 2);
  }
}
class DodecahedronGeometry extends Geometry {
  constructor() { super(); populateTriangleGeometry(this, 36); }
}
class BufferGeometry extends Geometry {}
class CylinderGeometry extends Geometry {
  constructor(radiusTop = 1, radiusBottom = 1, height = 1, radialSegments = 8) {
    super();
    const radial = Math.max(3, Math.trunc(radialSegments));
    const capCount = Number(radiusTop > 0) + Number(radiusBottom > 0);
    populateTriangleGeometry(this, radial * (2 + capCount));
  }
}

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
    const source = attribute?.array
      ?? (ArrayBuffer.isView(attribute) || Array.isArray(attribute) ? attribute : null);
    if (!source) return;
    const version = attribute?.version ?? 0;
    let mirror = this.gpuAttributes.get(attribute);
    if (!mirror) {
      mirror = { version, array: source.slice() };
      this.gpuAttributes.set(attribute, mirror);
    } else if (mirror.version !== version) {
      if (attribute.updateRanges?.length > 0) {
        for (const range of attribute.updateRanges) {
          const end = range.count < 0 ? source.length : range.start + range.count;
          mirror.array.set(source.subarray(range.start, end), range.start);
        }
      } else if (typeof mirror.array.set === 'function') mirror.array.set(source);
      else mirror.array = source.slice();
      mirror.version = version;
    }
    attribute.clearUpdateRanges?.();
  }
  render(scene, camera) {
    let drawCalls = 0;
    let instances = 0;
    let triangles = 0;
    const visit = (object, hierarchyVisible) => {
      const visible = hierarchyVisible && object?.visible !== false;
      const materials = Array.isArray(object?.material) ? object.material : [object?.material];
      const objectUpdateCandidate = visible && object?.geometry && object?.material;
      const renderListCandidate = objectUpdateCandidate
        && materials.some(material => material?.visible !== false);
      // Three r160 calls WebGLObjects.update() before checking material visibility,
      // and InstancedMesh.count controls the draw call rather than buffer upload.
      if (objectUpdateCandidate) {
        for (const attribute of Object.values(object.geometry.attributes ?? {})) {
          this.syncAttribute(attribute);
        }
        this.syncAttribute(object.instanceMatrix);
        this.syncAttribute(object.instanceColor);
      }
      if (renderListCandidate) {
        this.syncAttribute(object.geometry.index);
        object.onBeforeRender?.(this, scene, camera, object.geometry, object.material, null);
        drawCalls += 1;
        const index = object.geometry?.index?.array ?? object.geometry?.index ?? null;
        const position = object.geometry?.attributes?.position;
        const trianglesPerDraw = Number.isFinite(index?.length)
          ? Math.floor(index.length / 3)
          : Math.floor((position?.count ?? 0) / 3);
        const instanceCount = object instanceof InstancedMesh
          ? Math.max(0, Number(object.count) || 0) : 1;
        instances += object instanceof InstancedMesh ? instanceCount : 0;
        triangles += trianglesPerDraw * instanceCount;
        object.onAfterRender?.(this, scene, camera, object.geometry, object.material, null);
      }
      for (const child of object?.children ?? []) visit(child, visible);
    };
    visit(scene, true);
    this.renderCount += 1;
    this.info.render.calls = drawCalls;
    this.info.render.instances = instances;
    this.info.render.triangles = triangles;
  }
  gpuMirrorSnapshot(scene, { attributeName = null } = {}) {
    const attributes = [];
    const visit = (object, path, hierarchyVisible) => {
      const nextPath = [...path, object?.name || object?.constructor?.name || 'Object'];
      const visible = hierarchyVisible && object?.visible !== false;
      const materials = Array.isArray(object?.material) ? object.material : [object?.material];
      const objectUpdateCandidate = visible && object?.geometry && object?.material;
      const renderListCandidate = objectUpdateCandidate
        && materials.some(material => material?.visible !== false);
      const sources = [
        ...Object.entries(object?.geometry?.attributes ?? {}).map(entry => [...entry, false]),
        ['index', object?.geometry?.index, true],
        ['instanceMatrix', object?.instanceMatrix, false],
        ['instanceColor', object?.instanceColor, false],
      ];
      for (const [name, attribute, requiresRenderList] of sources) {
        if (attributeName !== null && name !== attributeName) continue;
        if (!(requiresRenderList ? renderListCandidate : objectUpdateCandidate)) continue;
        const source = attribute?.array
          ?? (ArrayBuffer.isView(attribute) || Array.isArray(attribute) ? attribute : null);
        if (!source) continue;
        const mirror = this.gpuAttributes.get(attribute) ?? null;
        attributes.push(Object.freeze({
          objectName: object?.name ?? null,
          path: nextPath.join('/'),
          attributeName: name,
          cpuVersion: attribute?.version ?? 0,
          gpuVersion: mirror?.version ?? null,
          cpuArray: source.slice(),
          gpuArray: mirror?.array.slice() ?? null,
        }));
      }
      for (const child of object?.children ?? []) visit(child, nextPath, visible);
    };
    if (scene) visit(scene, [], true);
    return Object.freeze(attributes);
  }
  dispose() { this.disposed = true; }
}

export function productionHarnessGpuUploadContractSnapshot() {
  const renderer = new WebGLRenderer();
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 1_000);

  const zeroCount = new InstancedMesh(
    new BoxGeometry(), new MeshLambertMaterial({ visible: true }), 2,
  );
  zeroCount.name = 'zero-count-visible';
  zeroCount.count = 0;
  scene.add(zeroCount);

  const materialHidden = new Mesh(
    new BoxGeometry(), new MeshLambertMaterial({ visible: false }),
  );
  materialHidden.name = 'material-hidden';
  scene.add(materialHidden);

  const hiddenParent = new Group();
  hiddenParent.name = 'hidden-parent';
  hiddenParent.visible = false;
  const hierarchyHidden = new Mesh(
    new BoxGeometry(), new MeshLambertMaterial({ visible: true }),
  );
  hierarchyHidden.name = 'hierarchy-hidden';
  hiddenParent.add(hierarchyHidden);
  scene.add(hiddenParent);

  const visible = new Mesh(new BoxGeometry(), new MeshLambertMaterial({ visible: true }));
  visible.name = 'visible';
  scene.add(visible);

  renderer.render(scene, camera);
  const auditedPaths = renderer.gpuMirrorSnapshot(scene).map(value => (
    `${value.path}\n${value.attributeName}`
  ));
  const mirrorMatches = attribute => {
    const source = attribute?.array
      ?? (ArrayBuffer.isView(attribute) || Array.isArray(attribute) ? attribute : null);
    const gpu = renderer.attributes.get(attribute);
    return gpu?.version === (attribute?.version ?? 0)
      && gpu?.array?.length === source?.length
      && gpu.array.every((value, index) => Object.is(value, source[index]));
  };
  return Object.freeze({
    zeroCountGeometryUploaded: mirrorMatches(zeroCount.geometry.attributes.position),
    zeroCountInstanceMatrixUploaded: mirrorMatches(zeroCount.instanceMatrix),
    materialHiddenGeometryUploaded: mirrorMatches(materialHidden.geometry.attributes.position),
    materialHiddenIndexUploaded: renderer.attributes.get(materialHidden.geometry.index) !== undefined,
    hierarchyHiddenGeometryUploaded:
      renderer.attributes.get(hierarchyHidden.geometry.attributes.position) !== undefined,
    visibleIndexUploaded: mirrorMatches(visible.geometry.index),
    auditIncludesZeroCount: auditedPaths.some(value => value.includes('zero-count-visible')),
    auditIncludesMaterialHiddenGeometry: auditedPaths.some(value => (
      value.includes('material-hidden') && value.endsWith('\nposition')
    )),
    auditIncludesMaterialHiddenIndex: auditedPaths.some(value => (
      value.includes('material-hidden') && value.endsWith('\nindex')
    )),
    auditIncludesHierarchyHidden: auditedPaths.some(value => value.includes('hierarchy-hidden')),
    auditedMismatchCount: renderer.gpuMirrorSnapshot(scene).filter(attribute => (
      attribute.gpuArray === null
        || attribute.gpuVersion !== attribute.cpuVersion
        || attribute.gpuArray.length !== attribute.cpuArray.length
        || attribute.gpuArray.some((value, index) => !Object.is(value, attribute.cpuArray[index]))
    )).length,
  });
}

export const ProductionHarnessThree = Object.freeze({
  Group,
  Scene,
  PlaneGeometry,
  BoxGeometry,
  ConeGeometry,
  SphereGeometry,
  DodecahedronGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Uint32BufferAttribute,
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

const matrixPosition = (attribute, slot) => {
  const values = attribute?.array;
  const offset = slot * 16;
  return values && values.length >= offset + 16
    ? Object.freeze({ x: Number(values[offset + 12]), z: Number(values[offset + 14]) })
    : null;
};

const gpuMatrixElementsAt = (values, slot) => {
  const offset = slot * 16;
  return values && Number.isSafeInteger(slot) && slot >= 0 && values.length >= offset + 16
    ? values.subarray?.(offset, offset + 16) ?? values.slice(offset, offset + 16)
    : null;
};

const isDrawableGpuMatrix = values => values !== null && values.length >= 16
  && Array.from(values).slice(0, 16).every(Number.isFinite)
  && Math.hypot(values[0], values[1], values[2]) > Number.EPSILON
  && Math.hypot(values[4], values[5], values[6]) > Number.EPSILON
  && Math.hypot(values[8], values[9], values[10]) > Number.EPSILON;

const materialValues = material => Array.isArray(material) ? material : [material];
const naturalUniforms = mesh => materialValues(mesh?.material)
  .map(material => material?.userData?.naturalLodUniforms)
  .find(Boolean) ?? null;
const uniformValue = (uniforms, name) => Number(uniforms?.[name]?.value);
const effectiveMaterialOpacity = material => {
  const materials = materialValues(material).filter(Boolean);
  if (materials.length === 0) return 0;
  return Math.max(...materials.map(value => (
    value.visible === false ? 0 : Number.isFinite(value.opacity) ? value.opacity : 1
  )));
};
const clampedSmoothstep = (minimum, maximum, value) => {
  if (minimum === maximum) return value < minimum ? 0 : 1;
  const progress = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  return progress * progress * (3 - 2 * progress);
};
const mixed = (left, right, progress) => left * (1 - progress) + right * progress;

function evaluateCoarseTreeSlot(mesh, slot, gpuAttributes) {
  const uniforms = naturalUniforms(mesh);
  const density = gpuAttributes.get(mesh?.geometry?.attributes?.w8NaturalDensityRank);
  const anchor = gpuAttributes.get(mesh?.geometry?.attributes?.w8NaturalAnchorXZ);
  const reveal = gpuAttributes.get(mesh?.geometry?.attributes?.w8NaturalInitialReveal);
  const matrix = gpuAttributes.get(mesh?.instanceMatrix);
  if (!uniforms || !density || !anchor || !reveal || !matrix) return null;
  const densityRank = Number(density[slot]);
  const anchorX = Number(anchor[slot * 2]);
  const anchorZ = Number(anchor[slot * 2 + 1]);
  const player = uniforms.w8NaturalPlayerLocalXZ?.value;
  const unitsPerMeter = uniformValue(uniforms, 'w8NaturalUnitsPerMeter');
  const playerX = Number(player?.x);
  const playerZ = Number(player?.y ?? player?.z);
  if (![densityRank, anchorX, anchorZ, unitsPerMeter, playerX, playerZ]
    .every(Number.isFinite) || unitsPerMeter <= 0) return null;
  const distanceMeters = Math.hypot(anchorX - playerX, anchorZ - playerZ) / unitsPerMeter;
  const nearStart = uniformValue(uniforms, 'w8NaturalDensityNearTransitionStart');
  const nearEnd = uniformValue(uniforms, 'w8NaturalDensityNearTransitionEnd');
  const farStart = uniformValue(uniforms, 'w8NaturalDensityFarTransitionStart');
  const farEnd = uniformValue(uniforms, 'w8NaturalDensityFarTransitionEnd');
  const nearDensity = uniformValue(uniforms, 'w8NaturalDensityNear');
  const midDensity = uniformValue(uniforms, 'w8NaturalDensityMid');
  const farDensity = uniformValue(uniforms, 'w8NaturalDensityFar');
  const densityFade = uniformValue(uniforms, 'w8NaturalDensityFade');
  const exitStart = uniformValue(uniforms, 'w8NaturalExitStart');
  const exitEnd = uniformValue(uniforms, 'w8NaturalExitEnd');
  const initialReveal = Number(reveal[slot]);
  const streamReveal = Math.max(
    Math.max(0, Math.min(1, initialReveal)),
    uniformValue(uniforms, 'w8NaturalReveal'),
  );
  if ([nearStart, nearEnd, farStart, farEnd, nearDensity, midDensity, farDensity,
    densityFade, exitStart, exitEnd, initialReveal, streamReveal]
    .some(value => !Number.isFinite(value))) return null;
  let threshold = nearDensity;
  if (distanceMeters > nearStart) {
    if (distanceMeters < nearEnd) {
      threshold = mixed(nearDensity, midDensity,
        clampedSmoothstep(nearStart, nearEnd, distanceMeters));
    } else if (distanceMeters <= farStart) threshold = midDensity;
    else if (distanceMeters < farEnd) {
      threshold = mixed(midDensity, farDensity,
        clampedSmoothstep(farStart, farEnd, distanceMeters));
    } else threshold = farDensity;
  }
  const densityOpacity = clampedSmoothstep(0, densityFade, threshold - densityRank);
  const exitOpacity = 1 - clampedSmoothstep(exitStart, exitEnd, distanceMeters);
  const handoffOpacity = initialReveal >= -0.5 ? 1 : 0;
  const matrixElements = gpuMatrixElementsAt(matrix, slot);
  const matrixValue = matrixPosition({ array: matrix }, slot);
  return Object.freeze({
    distanceMeters,
    densityRank,
    threshold,
    opacity: Math.max(0, streamReveal) * handoffOpacity * densityOpacity * exitOpacity,
    matrixPosition: matrixValue,
    drawableMatrix: isDrawableGpuMatrix(matrixElements),
  });
}

function geometryTriangleCount(geometry, readGpu = null) {
  const index = readGpu?.(geometry?.index) ?? geometry?.index?.array ?? geometry?.index;
  if (Number.isFinite(index?.length)) return Math.floor(index.length / 3);
  const position = geometry?.attributes?.position;
  return Math.floor((position?.count ?? 0) / 3);
}

function completedTreeFrameMetrics({
  scene,
  renderer,
  expectedStableIds = [],
  previouslyPresentedStableIds = new Set(),
}) {
  const gpuAttributes = new Map();
  const readGpu = attribute => {
    if (!attribute?.array) return null;
    if (!gpuAttributes.has(attribute)) {
      const mirror = renderer?.attributes?.get?.(attribute);
      gpuAttributes.set(attribute, mirror?.array ?? null);
    }
    return gpuAttributes.get(attribute);
  };
  const near = new Set();
  const coarse = new Set();
  const coarseCanonical = new Set();
  const coarseSuppressed = new Set();
  const coarsePresenterOccurrences = new Map();
  let coarseMeshSequence = 0;
  const objectPath = object => {
    const names = [];
    for (let current = object; current; current = current.parent) {
      names.push(current.name || current.constructor?.name || 'Object');
    }
    return names.reverse().join('/');
  };
  const bands = [
    { label: '0-100', minimum: 0, maximum: 100 },
    { label: '100-200', minimum: 100, maximum: 200 },
    { label: '200-300', minimum: 200, maximum: 300 },
  ].map(band => ({ ...band, canonicalStableIds: new Set(), drawableStableIds: new Set(),
    canonicalInstanceCount: 0, canonicalTriangleCount: 0,
    instanceCount: 0, triangleCount: 0 }));
  scene?.traverse?.(mesh => {
    if (!mesh?.geometry || !mesh?.material || mesh.visible === false || !(mesh.count > 0)) return;
    if (mesh.userData?.treePathId === 'near-tree') {
      const treeStableIds = new Set(mesh.userData?.treeStableIds ?? []);
      const featureStableIds = mesh.userData?.featureStableIds ?? [];
      const matrices = readGpu(mesh.instanceMatrix);
      for (let slot = 0; slot < Math.min(mesh.count, featureStableIds.length); slot += 1) {
        const stableId = featureStableIds[slot];
        const drawableMatrix = isDrawableGpuMatrix(gpuMatrixElementsAt(matrices, slot));
        if (treeStableIds.has(stableId) && drawableMatrix) near.add(stableId);
      }
    }
    const coarseTree = materialValues(mesh.material).some(material => (
      material?.userData?.canonicalCoarseTree === true
    ));
    if (!coarseTree) return;
    coarseMeshSequence += 1;
    const presenterPath = `${objectPath(mesh)}#${coarseMeshSequence}`;
    for (const attribute of [
      ...Object.values(mesh.geometry.attributes ?? {}), mesh.geometry.index,
      mesh.instanceMatrix,
    ]) readGpu(attribute);
    const stableIds = mesh.userData?.canonicalStableIds ?? [];
    const canonicalObjects = mesh.userData?.canonicalObjects ?? [];
    const canonicalOpacities = mesh.userData?.canonicalOpacities ?? [];
    const handoffOpacityAttribute = mesh.geometry?.attributes?.w8LocalHandoffOpacity ?? null;
    const gpuHandoffOpacities = handoffOpacityAttribute ? readGpu(handoffOpacityAttribute) : null;
    const materialOpacity = effectiveMaterialOpacity(mesh.material);
    const trianglesPerInstance = geometryTriangleCount(mesh.geometry, readGpu);
    const slotCount = Math.min(mesh.count, Math.max(stableIds.length, canonicalObjects.length));
    for (let slot = 0; slot < slotCount; slot += 1) {
      const stableId = canonicalObjects[slot]?.stableId ?? stableIds[slot];
      const evaluated = evaluateCoarseTreeSlot(mesh, slot, gpuAttributes);
      if (!stableId || !evaluated || evaluated.distanceMeters >= 300) continue;
      coarseCanonical.add(stableId);
      const band = bands.find(value => evaluated.distanceMeters >= value.minimum
        && evaluated.distanceMeters < value.maximum);
      if (!band) continue;
      band.canonicalStableIds.add(stableId);
      band.canonicalInstanceCount += 1;
      band.canonicalTriangleCount += trianglesPerInstance;
      const canonicalOpacity = Number.isFinite(canonicalOpacities[slot])
        ? canonicalOpacities[slot] : 1;
      // Local handoff opacity is shader input. If present, only the completed
      // renderer-side mirror is authoritative; a CPU write cannot prove drawability.
      const gpuHandoffOpacity = handoffOpacityAttribute
        ? Number(gpuHandoffOpacities?.[slot] ?? 0) : 1;
      const effectiveOpacity = canonicalOpacity * gpuHandoffOpacity
        * materialOpacity * evaluated.opacity;
      if (evaluated.drawableMatrix && effectiveOpacity > 0) {
        band.drawableStableIds.add(stableId);
        band.instanceCount += 1;
        band.triangleCount += trianglesPerInstance;
        coarse.add(stableId);
        const occurrences = coarsePresenterOccurrences.get(stableId) ?? [];
        occurrences.push(`${presenterPath}[slot=${slot}]`);
        coarsePresenterOccurrences.set(stableId, occurrences);
      } else {
        coarseSuppressed.add(stableId);
      }
    }
  });
  const requiredStableIds = new Set(expectedStableIds);
  const zeroPresenterStableIds = [...previouslyPresentedStableIds].filter(stableId => (
    requiredStableIds.has(stableId) && !near.has(stableId) && !coarse.has(stableId)
  )).sort();
  const initialMissingStableIds = [...requiredStableIds].filter(stableId => (
    !previouslyPresentedStableIds.has(stableId)
      && !near.has(stableId) && !coarse.has(stableId)
  )).sort();
  const duplicateStableIds = [...near].filter(stableId => coarse.has(stableId)).sort();
  const duplicateCoarsePresenters = [...coarsePresenterOccurrences]
    .filter(([, paths]) => paths.length > 1)
    .map(([stableId, paths]) => Object.freeze({
      stableId,
      paths: Object.freeze([...paths].sort()),
    })).sort((left, right) => left.stableId.localeCompare(right.stableId));
  const zeroPresenterReasons = Object.freeze(zeroPresenterStableIds.map(stableId => Object.freeze({
    stableId,
    reason: coarseSuppressed.has(stableId)
      ? 'coarse-slot-suppressed-while-near-absent'
      : coarseCanonical.has(stableId)
        ? 'coarse-slot-not-drawable-while-near-absent'
        : 'required-id-not-present-in-completed-receipt',
  })));
  return Object.freeze({
    nearStableIdCount: near.size,
    coarseStableIdCount: coarse.size,
    zeroPresenterCount: zeroPresenterStableIds.length,
    zeroPresenterStableIds: Object.freeze(zeroPresenterStableIds),
    zeroPresenterReasons,
    initialMissingPresenterCount: initialMissingStableIds.length,
    initialMissingPresenterStableIds: Object.freeze(initialMissingStableIds),
    presentedStableIds: Object.freeze([...new Set([...near, ...coarse])].sort()),
    duplicatePresenterCount: duplicateStableIds.length,
    duplicateStableIds: Object.freeze(duplicateStableIds),
    duplicatePresenterEvidence: Object.freeze(duplicateStableIds.map(stableId => Object.freeze({
      stableId,
      near: true,
      coarsePaths: Object.freeze([
        ...(coarsePresenterOccurrences.get(stableId) ?? []),
      ].sort()),
    }))),
    duplicateCoarsePresenterCount: duplicateCoarsePresenters.length,
    duplicateCoarsePresenters: Object.freeze(duplicateCoarsePresenters.slice(0, 16)),
    duplicateCoarsePresenterEvidenceTruncated: duplicateCoarsePresenters.length > 16,
    annuli: Object.freeze(bands.map(band => Object.freeze({
      label: band.label,
      hectares: Math.PI * (band.maximum ** 2 - band.minimum ** 2) / 10_000,
      canonicalCount: band.canonicalStableIds.size,
      drawableCount: band.drawableStableIds.size,
      canonicalTreesPerHectare: band.canonicalStableIds.size
        / (Math.PI * (band.maximum ** 2 - band.minimum ** 2) / 10_000),
      drawableTreesPerHectare: band.drawableStableIds.size
        / (Math.PI * (band.maximum ** 2 - band.minimum ** 2) / 10_000),
      instanceCount: band.instanceCount,
      triangleCount: band.triangleCount,
      before: Object.freeze({
        basis: 'analytical-all-canonical-legacy-density-baseline',
        measuredImplementation: false,
        canonicalCount: band.canonicalStableIds.size,
        drawableCount: band.canonicalStableIds.size,
        treesPerHectare: band.canonicalStableIds.size
          / (Math.PI * (band.maximum ** 2 - band.minimum ** 2) / 10_000),
        instanceCount: band.canonicalInstanceCount,
        triangleCount: band.canonicalTriangleCount,
      }),
      after: Object.freeze({
        canonicalCount: band.canonicalStableIds.size,
        drawableCount: band.drawableStableIds.size,
        treesPerHectare: band.drawableStableIds.size
          / (Math.PI * (band.maximum ** 2 - band.minimum ** 2) / 10_000),
        instanceCount: band.instanceCount,
        triangleCount: band.triangleCount,
      }),
    }))),
  });
}

const percentile = (values, ratio) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
};

const latencySummary = values => Object.freeze({
  count: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: values.length === 0 ? 0 : Math.max(...values),
});

function minimumDistanceToOwner(position, ownerKey) {
  const [chunkX, chunkZ] = String(ownerKey).split(',').map(Number);
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) return Number.POSITIVE_INFINITY;
  const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const dx = Math.max(minimumX - position.x, 0,
    position.x - (minimumX + LOGICAL_CHUNK_SIZE_METERS));
  const dz = Math.max(minimumZ - position.z, 0,
    position.z - (minimumZ + LOGICAL_CHUNK_SIZE_METERS));
  return Math.hypot(dx, dz);
}

function bootCohortState({ snapshot, bootPosition, bootAtMs, bootOwnerKeys }) {
  const owners = snapshot.visualContinuity?.owners ?? [];
  const ownerByKey = new Map(owners.map(owner => [owner.ownerKey, owner]));
  const cohort = bootOwnerKeys.map(ownerKey => ownerByKey.get(ownerKey) ?? null);
  const absentOwnerKeys = bootOwnerKeys.filter(ownerKey => !ownerByKey.has(ownerKey));
  const coarseMissingOwnerKeys = cohort.filter(Boolean)
    .filter(owner => !Number.isFinite(owner.coarseDrawableAt))
    .map(owner => owner.ownerKey);
  const complete = bootOwnerKeys.length > 0
    && absentOwnerKeys.length === 0
    && coarseMissingOwnerKeys.length === 0;
  if (!complete) return Object.freeze({
    complete: false,
    expectedOwnerCount: bootOwnerKeys.length,
    presentOwnerCount: cohort.length - absentOwnerKeys.length,
    coarseDrawableOwnerCount: cohort.filter(owner => Number.isFinite(owner?.coarseDrawableAt)).length,
    absentOwnerKeys: Object.freeze(absentOwnerKeys),
    coarseMissingOwnerKeys: Object.freeze(coarseMissingOwnerKeys),
    fill: null,
  });

  const filledOwners = cohort.filter(Boolean);
  const fillAt = radius => {
    const population = filledOwners.filter(owner => (
      minimumDistanceToOwner(bootPosition, owner.ownerKey) <= radius
    ));
    return population.length === 0 ? null : Math.max(
      ...population.map(owner => owner.coarseDrawableAt),
    ) - bootAtMs;
  };
  const terrainTimes = filledOwners.map(owner => owner.terrainDrawableAt).filter(Number.isFinite);
  const localKey = `${Math.floor(bootPosition.x / LOGICAL_CHUNK_SIZE_METERS)},${
    Math.floor(bootPosition.z / LOGICAL_CHUNK_SIZE_METERS)}`;
  const localOwner = ownerByKey.get(localKey) ?? null;
  return Object.freeze({
    complete: true,
    expectedOwnerCount: bootOwnerKeys.length,
    presentOwnerCount: filledOwners.length,
    coarseDrawableOwnerCount: filledOwners.length,
    absentOwnerKeys: Object.freeze([]),
    coarseMissingOwnerKeys: Object.freeze([]),
    fill: Object.freeze({
      terrain: terrainTimes.length === 0 ? null : Math.min(...terrainTimes) - bootAtMs,
      local: Number.isFinite(localOwner?.coarseDrawableAt)
        ? localOwner.coarseDrawableAt - bootAtMs : null,
      radius100: fillAt(100),
      radius200: fillAt(200),
      radius300: fillAt(300),
    }),
  });
}

export function productionHarnessResidentSafetyMetrics(snapshot) {
  const residentWorld = snapshot?.runtime?.terrainReady?.residentWorld ?? {};
  const subscriberDiagnostics =
    snapshot?.runtime?.terrainReady?.chunkDataSubscriberDiagnostics ?? {};
  const chunkDataCounts = snapshot?.chunkDataService?.counts ?? {};
  return Object.freeze({
    residentRequiredCancellationCount:
      residentWorld.requiredCancellationByPrefetch ?? 0,
    protectedOwnerEvictionCount: chunkDataCounts.protectedOwnerEvictions ?? 0,
    concurrentDuplicateRerequestCount:
      subscriberDiagnostics.chunkDataDuplicateRequests ?? 0,
    coverageMissCount: residentWorld.coverageMiss ?? 0,
    allCancellationCount: chunkDataCounts.cancelledOperations ?? 0,
    historicalSameOwnerRerequestCount:
      subscriberDiagnostics.chunkDataSameOwnerRerequestCount ?? 0,
  });
}

function buildReleaseGateMetrics({
  snapshot,
  bootPosition,
  bootAtMs,
  bootOwnerKeys,
  nowMs,
  treeObservationBaseline,
  detailedTreeFrame,
  bootFillMetrics,
}) {
  const continuity = snapshot.visualContinuity ?? {};
  const allOwners = continuity.owners ?? [];
  const owners = allOwners.filter(owner => owner.state !== 'Retiring');
  const detailMissing = owners.filter(owner => owner.detailDrawableAt === null);
  const gpuLatencies = owners.filter(owner => (
    Number.isFinite(owner.visualWorkStartedAt) && Number.isFinite(owner.gpuUploadedAt)
  )).map(owner => Math.max(0, owner.gpuUploadedAt - owner.visualWorkStartedAt));
  const generationQueueAges = [
    ...(snapshot.ownerGeneration?.queued ?? []),
    ...(snapshot.ownerGeneration?.inFlight ?? []),
  ].map(entry => Number(entry.queueTimeMs)).filter(Number.isFinite);
  const activeTreeFrame = detailedTreeFrame ?? completedTreeFrameMetrics({
    scene: null,
    renderer: null,
  });
  const receiptPresentation = continuity.lastReceiptPresentation ?? {};
  const currentCoarseComponents = continuity.currentReceiptCoarseComponentMetrics ?? null;
  const baseline = treeObservationBaseline ?? Object.freeze({
    completedFrameCount: 0,
    zeroPresenterFrameCount: 0,
    duplicatePresenterFrameCount: 0,
    duplicateCoarsePresenterFrameCount: 0,
    terrainDisappearanceFrameCount: 0,
    structureDisappearanceFrameCount: 0,
    forestDisappearanceFrameCount: 0,
  });
  const observedFrameCount = Math.max(0,
    (continuity.renderFrames?.completedFrameCount ?? 0) - baseline.completedFrameCount);
  const zeroPresenterFrames = Math.max(0,
    (receiptPresentation.treeZeroPresenterFrameCount ?? 0)
      - baseline.zeroPresenterFrameCount);
  const duplicatePresenterFrames = Math.max(0,
    (receiptPresentation.treeDuplicatePresenterFrameCount ?? 0)
      - baseline.duplicatePresenterFrameCount);
  const duplicateCoarsePresenterFrames = Math.max(0,
    (receiptPresentation.treeDuplicateCoarsePresenterFrameCount ?? 0)
      - baseline.duplicateCoarsePresenterFrameCount);
  const currentBootState = bootFillMetrics ? null : bootCohortState({
    snapshot,
    bootPosition,
    bootAtMs,
    bootOwnerKeys,
  });
  const bootFill = bootFillMetrics ?? currentBootState?.fill ?? Object.freeze({
    terrain: null,
    local: null,
    radius100: null,
    radius200: null,
    radius300: null,
  });
  return Object.freeze({
    schemaVersion: 'infinite-world-production-release-gate-metrics-1',
    residentSafety: productionHarnessResidentSafetyMetrics(snapshot),
    lifecycle: Object.freeze({
      expected: continuity.expectedOwnerCount ?? owners.length,
      coarse: continuity.coarseDrawableCount ?? 0,
      detail: continuity.detailDrawableCount ?? 0,
      coarseMiss: continuity.deadlineMissCount ?? 0,
      oldestCoarseMissingMs: continuity.oldestMissingAgeMs ?? 0,
      detailMissingCount: detailMissing.length,
      oldestDetailMissingMs: detailMissing.length === 0 ? 0 : Math.max(
        ...detailMissing.map(owner => Math.max(0, nowMs - owner.expectedAt)),
      ),
    }),
    coarseComponents: continuity.coarseComponentMetrics ?? null,
    currentCoarseComponents,
    coarseContinuity: Object.freeze({
      terrainDisappearanceFrames: Math.max(0,
        (currentCoarseComponents?.terrain?.disappearanceFrameCount ?? 0)
          - baseline.terrainDisappearanceFrameCount),
      structureDisappearanceFrames: Math.max(0,
        (currentCoarseComponents?.structure?.disappearanceFrameCount ?? 0)
          - baseline.structureDisappearanceFrameCount),
      forestDisappearanceFrames: Math.max(0,
        (currentCoarseComponents?.forest?.disappearanceFrameCount ?? 0)
          - baseline.forestDisappearanceFrameCount),
    }),
    queues: Object.freeze({
      generationAgeMs: generationQueueAges.length === 0 ? 0 : Math.max(...generationQueueAges),
      naturalWorkQueueAgeMs: snapshot.staticObjectStreaming?.oldestPendingTaskAgeMs ?? 0,
      naturalAdmissionCursorAgeMs:
        snapshot.staticObjectStreaming?.oldestAdmissionCursorAgeMs ?? 0,
      naturalWorkQueueAgeMaximumMs:
        snapshot.staticObjectStreaming?.maximumPendingTaskAgeMs ?? 0,
      naturalAdmissionCursorAgeMaximumMs:
        snapshot.staticObjectStreaming?.maximumAdmissionCursorAgeMs ?? 0,
      naturalWorkQueueAgeMeasurable: true,
      naturalPublicationWaitLastMs: snapshot.presentation?.staticTreeLastPublicationWaitMs ?? null,
      naturalPublicationWaitMaximumMs:
        snapshot.presentation?.staticTreeMaximumPublicationWaitMs ?? null,
    }),
    gpuUploadLatencyMs: latencySummary(gpuLatencies),
    treePresenters: Object.freeze({
      frameCount: observedFrameCount,
      zeroPresenterFrames,
      duplicatePresenterFrames,
      maximumZeroPresenterCount: receiptPresentation.treeZeroPresenterRequiredCount ?? 0,
      maximumDuplicatePresenterCount: receiptPresentation.treeDuplicatePresenterCount ?? 0,
      duplicateCoarsePresenterFrames,
      maximumDuplicateCoarsePresenterCount:
        receiptPresentation.treeDuplicateCoarsePresenterCount ?? 0,
      latest: activeTreeFrame,
    }),
    bootFillMs: bootFill,
    densityAnnuli: activeTreeFrame.annuli,
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
  let treeObservationBaseline = null;
  let bootFillMetrics = null;
  const bootAtMs = scheduler.clock();

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

  const bootSnapshot = sandbox.snapshot();
  const bootPosition = Object.freeze({
    x: bootSnapshot.spatial.playerLogical.x,
    z: bootSnapshot.spatial.playerLogical.z,
  });
  const activeBootOwnerKeys = (bootSnapshot.visualContinuity?.owners ?? [])
    .filter(owner => owner.state !== 'Retiring')
    .map(owner => owner.ownerKey);
  const bootOwnerKeys = Object.freeze((activeBootOwnerKeys.length > 0
    ? activeBootOwnerKeys
    : bootSnapshot.staticObjectStreaming?.missingRequiredOwnerKeys ?? []
  ).filter((ownerKey, index, values) => values.indexOf(ownerKey) === index));
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
    checkIntervalFrames = 1,
    message = 'production scheduling condition did not settle',
  } = {}) {
    const interval = Number.isSafeInteger(checkIntervalFrames) && checkIntervalFrames > 0
      ? checkIntervalFrames : 1;
    for (let frame = 0; frame < maximumFrames; frame += 1) {
      if (frame % interval === 0) {
        const snapshot = sandbox.snapshot();
        if (predicate(snapshot)) return snapshot;
      }
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
      staticVisual: {
        required: snapshot.staticObjectStreaming?.visualRequiredOwnerCount ?? null,
        expected: snapshot.staticObjectStreaming?.visualExpectedOwnerCount ?? null,
        pendingAdmission: snapshot.staticObjectStreaming?.pendingAdmissionCount ?? null,
      },
      visualContinuity: snapshot.visualContinuity ? {
        expected: snapshot.visualContinuity.expectedOwnerCount,
        coarse: snapshot.visualContinuity.coarseDrawableCount,
        unresolved: snapshot.visualContinuity.coarseComponentMetrics
          ?.requirementsUnresolvedOwnerCount ?? null,
        historicalMissing: Object.fromEntries(['terrain', 'structure', 'forest'].map(
          component => [component,
            snapshot.visualContinuity.coarseComponentMetrics?.[component]?.missingCount ?? null],
        )),
        current: snapshot.visualContinuity.currentReceiptCoarseComponentMetrics ?? null,
        coarseMissingOwners: snapshot.visualContinuity.owners
          ?.filter(owner => owner.state !== 'Retiring' && owner.coarseDrawableAt === null)
          .slice(0, 12)
          .map(owner => ({
            ownerKey: owner.ownerKey,
            structure: owner.requiredStructureStableIds?.filter(stableId => (
              !owner.structureComponentDraws?.some(draw => draw.stableId === stableId)
            )),
            forest: owner.requiredForestStableIds?.filter(stableId => (
              !owner.forestComponentDraws?.some(draw => draw.stableId === stableId)
            )),
          })) ?? [],
      } : null,
    })}`);
    return snapshot;
  }

  async function waitForBootCohortCoarse({
    maximumFrames = 6_000,
    hostDelayMs = 2,
    checkIntervalFrames = 30,
  } = {}) {
    const interval = Number.isSafeInteger(checkIntervalFrames) && checkIntervalFrames > 0
      ? checkIntervalFrames : 30;
    let advancedFrames = 0;
    const wallStartedAt = Date.now();
    while (advancedFrames <= maximumFrames) {
      const progress = sandbox.visualContinuityProgress();
      if (progress.expectedOwnerCount === bootOwnerKeys.length
        && progress.coarseDrawableCount === bootOwnerKeys.length
        && progress.requirementsUnresolvedOwnerCount === 0) {
        const snapshot = sandbox.snapshot();
        const cohort = bootCohortState({
          snapshot,
          bootPosition,
          bootAtMs,
          bootOwnerKeys,
        });
        if (cohort.complete) {
          bootFillMetrics = cohort.fill;
          return snapshot;
        }
      }
      if (process.env.KANININGEN_DEBUG_PRODUCTION_HARNESS === '1'
        && advancedFrames % 300 === 0) {
        process.stderr.write(`[production-harness-boot-fill] ${JSON.stringify({
          advancedFrames,
          wallElapsedMs: Date.now() - wallStartedAt,
          expected: progress.expectedOwnerCount,
          coarse: progress.coarseDrawableCount,
          resolved: progress.requirementsResolvedOwnerCount,
        })}\n`);
      }
      if (advancedFrames === maximumFrames) {
        const snapshot = sandbox.snapshot();
        const cohort = bootCohortState({
          snapshot,
          bootPosition,
          bootAtMs,
          bootOwnerKeys,
        });
        throw new Error(`immutable boot Expected cohort did not reach CoarseDrawable: ${
          JSON.stringify({
            expectedOwnerCount: cohort.expectedOwnerCount,
            presentOwnerCount: cohort.presentOwnerCount,
            coarseDrawableOwnerCount: cohort.coarseDrawableOwnerCount,
            requirementsUnresolvedOwnerCount:
              snapshot.visualContinuity?.coarseComponentMetrics
                ?.requirementsUnresolvedOwnerCount ?? null,
            absentOwnerKeys: cohort.absentOwnerKeys.slice(0, 12),
            coarseMissingOwnerKeys: cohort.coarseMissingOwnerKeys.slice(0, 12),
            staticObjectStreaming: snapshot.staticObjectStreaming ?? null,
          })}`);
      }
      const batch = Math.min(interval, maximumFrames - advancedFrames);
      for (let frame = 0; frame < batch; frame += 1) {
        await advanceFrame({ hostDelayMs });
      }
      advancedFrames += batch;
    }
    throw new Error('immutable boot Expected cohort wait ended unexpectedly');
  }

  async function waitForStrictCoarseFill({
    maximumFrames = 1_200,
    hostDelayMs = 2,
    checkIntervalFrames = 30,
    requireVisualRequiredEqualsExpected = false,
    message = 'visual Expected cohort did not finish strict aggregate coarse fill',
  } = {}) {
    const interval = Number.isSafeInteger(checkIntervalFrames) && checkIntervalFrames > 0
      ? checkIntervalFrames : 30;
    for (let advancedFrames = 0; advancedFrames <= maximumFrames;) {
      const progress = sandbox.visualContinuityProgress();
      const currentReceiptComplete = ['terrain', 'structure', 'forest'].every(component => (
        progress.currentReceiptMissingCount[component] === 0
      ));
      const candidate = progress.expectedOwnerCount > 0
        && progress.expectedOwnerCount === progress.visualExpectedOwnerCount
        && (!requireVisualRequiredEqualsExpected
          || progress.visualExpectedOwnerCount === progress.visualRequiredOwnerCount)
        && progress.coarseDrawableCount === progress.expectedOwnerCount
        && progress.requirementsUnresolvedOwnerCount === 0
        && currentReceiptComplete;
      if (candidate) {
        const snapshot = sandbox.snapshot();
        const continuity = snapshot.visualContinuity;
        const components = continuity?.coarseComponentMetrics;
        const exact = continuity?.expectedOwnerCount > 0
          && continuity.expectedOwnerCount
            === snapshot.staticObjectStreaming.visualExpectedOwnerCount
          && (!requireVisualRequiredEqualsExpected
            || snapshot.staticObjectStreaming.visualExpectedOwnerCount
              === snapshot.staticObjectStreaming.visualRequiredOwnerCount)
          && continuity.coarseDrawableCount === continuity.expectedOwnerCount
          && components?.requirementsUnresolvedOwnerCount === 0
          && ['terrain', 'structure', 'forest'].every(component => (
            components?.[component]?.missingCount === 0
              && continuity.currentReceiptCoarseComponentMetrics?.[component]?.missingCount === 0
          ));
        if (exact) return snapshot;
      }
      if (advancedFrames === maximumFrames) {
        const snapshot = sandbox.snapshot();
        throw new Error(`${message}: ${JSON.stringify({
          progress,
          staticVisual: {
            required: snapshot.staticObjectStreaming?.visualRequiredOwnerCount ?? null,
            expected: snapshot.staticObjectStreaming?.visualExpectedOwnerCount ?? null,
          },
          currentReceipt: snapshot.visualContinuity
            ?.currentReceiptCoarseComponentMetrics ?? null,
        })}`);
      }
      const batch = Math.min(interval, maximumFrames - advancedFrames);
      for (let frame = 0; frame < batch; frame += 1) {
        await advanceFrame({ hostDelayMs });
      }
      advancedFrames += batch;
    }
    throw new Error(`${message}: wait ended unexpectedly`);
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
    waitForBootCohortCoarse,
    waitForStrictCoarseFill,
    bootCohort: Object.freeze({ expectedOwnerCount: bootOwnerKeys.length }),
    snapshot: () => sandbox.snapshot(),
    logicalPlayerPosition: () => Object.freeze({
      x: Number(sandbox.logicalPlayer.x),
      z: Number(sandbox.logicalPlayer.z),
    }),
    gpuMirrorSnapshot: (options = {}) => environment.renderer()?.gpuMirrorSnapshot(
      environment.scene(), options,
    ) ?? Object.freeze([]),
    treeFrameMetrics: () => {
      const snapshot = sandbox.snapshot();
      return completedTreeFrameMetrics({
        scene: environment.scene(),
        renderer: environment.renderer(),
        expectedStableIds: (snapshot.visualContinuity?.owners ?? [])
          .filter(owner => owner.state !== 'Retiring')
          .flatMap(owner => owner.requiredForestStableIds ?? []),
      });
    },
    resetReleaseGateObservation() {
      const snapshot = sandbox.snapshot();
      const receipt = snapshot.visualContinuity?.lastReceiptPresentation ?? {};
      treeObservationBaseline = Object.freeze({
        completedFrameCount: snapshot.visualContinuity?.renderFrames?.completedFrameCount ?? 0,
        zeroPresenterFrameCount: receipt.treeZeroPresenterFrameCount ?? 0,
        duplicatePresenterFrameCount: receipt.treeDuplicatePresenterFrameCount ?? 0,
        duplicateCoarsePresenterFrameCount:
          receipt.treeDuplicateCoarsePresenterFrameCount ?? 0,
        terrainDisappearanceFrameCount:
          snapshot.visualContinuity?.currentReceiptCoarseComponentMetrics
            ?.terrain?.disappearanceFrameCount ?? 0,
        structureDisappearanceFrameCount:
          snapshot.visualContinuity?.currentReceiptCoarseComponentMetrics
            ?.structure?.disappearanceFrameCount ?? 0,
        forestDisappearanceFrameCount:
          snapshot.visualContinuity?.currentReceiptCoarseComponentMetrics
            ?.forest?.disappearanceFrameCount ?? 0,
      });
    },
    releaseGateMetrics: () => {
      const snapshot = sandbox.snapshot();
      const detailedTreeFrame = completedTreeFrameMetrics({
        scene: environment.scene(),
        renderer: environment.renderer(),
        expectedStableIds: (snapshot.visualContinuity?.owners ?? [])
          .filter(owner => owner.state !== 'Retiring')
          .flatMap(owner => owner.requiredForestStableIds ?? []),
      });
      return buildReleaseGateMetrics({
        snapshot,
        bootPosition,
        bootAtMs,
        bootOwnerKeys,
        nowMs: scheduler.clock(),
        treeObservationBaseline,
        detailedTreeFrame,
        bootFillMetrics,
      });
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      releaseAll();
      try { await sandbox.shutdown(); }
      finally { environment.restore(); }
    },
  });
}
