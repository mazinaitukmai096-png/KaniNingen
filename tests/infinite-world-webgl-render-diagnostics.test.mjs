import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWebGLRenderDiagnostics,
  createWebGLRenderIncidentRing,
  WEBGL_RENDER_DIAGNOSTIC_MODE,
} from '../src/infinite-world/webgl-render-diagnostics.js';

function createDeepDiagnosticHarness({
  frustumIntersects = true,
  publishProof = null,
  onObserverError = null,
  sampleIntervalMs = 1_000,
} = {}) {
  let now = 0;
  let traversals = 0;
  let traversalFailure = null;
  let gpuVersion = 0;
  const identity = () => Object.freeze({
    elements: Object.freeze([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]),
  });
  class Matrix4 {
    constructor() { this.elements = [...identity().elements]; }
    multiplyMatrices() { return this; }
  }
  class Frustum {
    constructor() { this.planes = []; }
    setFromProjectionMatrix() { return this; }
    intersectsObject(object) { return object.testFrustumIntersects; }
  }
  const camera = {
    isCamera: true,
    uuid: 'camera',
    projectionMatrix: identity(),
    matrixWorldInverse: identity(),
    matrixWorld: identity(),
  };
  const instanceMatrix = {
    uuid: 'instance-matrix',
    itemSize: 16,
    count: 1,
    version: 0,
  };
  const material = { uuid: 'building-material', visible: true, opacity: 1 };
  const mesh = {
    isMesh: true,
    isInstancedMesh: true,
    uuid: 'building-mesh',
    name: 'settlement-building',
    visible: true,
    count: 1,
    frustumCulled: true,
    testFrustumIntersects: frustumIntersects,
    instanceMatrix,
    geometry: { uuid: 'building-geometry', attributes: {} },
    material,
    userData: { stableId: 'settlement-v1:test:building:00' },
    parent: null,
    matrixWorld: identity(),
  };
  const scene = {
    isScene: true,
    uuid: 'scene',
    children: [mesh],
    traverse(visitor) {
      traversals += 1;
      if (traversalFailure) throw traversalFailure;
      visitor(this);
      visitor(mesh);
    },
  };
  const uploads = [];
  const webglContext = {
    bufferData(...args) { uploads.push({ method: 'bufferData', args }); },
    bufferSubData(...args) { uploads.push({ method: 'bufferSubData', args }); },
  };
  const originalBufferData = webglContext.bufferData;
  const originalBufferSubData = webglContext.bufferSubData;
  const renderer = {
    isWebGLRenderer: true,
    domElement: {},
    info: {
      render: { calls: 1, triangles: 2, points: 0, lines: 0, frame: 1 },
      memory: { geometries: 1, textures: 0 },
      programs: [],
    },
    attributes: { get: () => ({ version: gpuVersion }) },
    getContext: () => webglContext,
  };
  const diagnostics = createWebGLRenderDiagnostics({
    enabled: true,
    THREE: { Matrix4, Frustum },
    renderer,
    scene,
    camera,
    clock: () => now,
    sampleIntervalMs,
    publishProof,
    onObserverError,
  });
  const capture = ({
    draw = true,
    upload = null,
    uploadBeforeDraw = false,
    context = {},
  } = {}) => {
    const token = diagnostics.beginFrame(context);
    if (!token) return null;
    if (uploadBeforeDraw) upload?.(webglContext);
    if (draw) {
      mesh.onBeforeRender(renderer, scene, camera, mesh.geometry, material, null);
      if (!uploadBeforeDraw) upload?.(webglContext);
      mesh.onAfterRender(renderer, scene, camera, mesh.geometry, material, null);
    }
    const frame = diagnostics.finishFrame(token);
    assert.equal(webglContext.bufferData, originalBufferData);
    assert.equal(webglContext.bufferSubData, originalBufferSubData);
    return frame;
  };
  return Object.freeze({
    diagnostics,
    capture,
    mesh,
    instanceMatrix,
    renderer,
    webglContext,
    uploads,
    traversals: () => traversals,
    failTraversal: error => { traversalFailure = error; },
    advance: milliseconds => { now += milliseconds; },
    setGpuVersion: version => { gpuVersion = version; },
  });
}

test('WebGL incident ring retains exactly thirty frames before and after an anomaly', () => {
  const ring = createWebGLRenderIncidentRing({
    preFrameCapacity: 30,
    postFrameCapacity: 30,
    incidentCapacity: 4,
  });
  let screenshotCaptures = 0;
  for (let frameSequence = 1; frameSequence <= 70; frameSequence += 1) {
    ring.record({
      frameSequence,
      timeMs: frameSequence * 10,
      anomalyCodes: frameSequence === 35 ? ['all-terrain-presentations-undrawn'] : [],
    }, {
      captureScreenshot() {
        screenshotCaptures += 1;
        return Object.freeze({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' });
      },
    });
  }
  const snapshot = ring.snapshot();
  assert.equal(snapshot.pendingIncident, null);
  assert.equal(snapshot.incidents.length, 1);
  assert.equal(snapshot.incidents[0].frames.length, 61);
  assert.deepEqual(snapshot.incidents[0].frames.map(frame => frame.frameSequence),
    Array.from({ length: 61 }, (_, index) => index + 5));
  assert.equal(snapshot.incidents[0].triggerFrameSequence, 35);
  assert.equal(snapshot.incidents[0].canvasScreenshot.dataUrl, 'data:image/png;base64,AAAA');
  assert.equal(snapshot.canvasScreenshot, snapshot.incidents[0].canvasScreenshot);
  assert.equal(screenshotCaptures, 1, 'a PNG is captured only for the incident trigger');
});

test('disabled or non-WebGL diagnostics never traverse Scene or install draw hooks', () => {
  let traversals = 0;
  const scene = {
    isScene: true,
    traverse() { traversals += 1; },
  };
  const camera = { isCamera: true };
  const renderer = { isWebGLRenderer: true, domElement: {} };
  const disabled = createWebGLRenderDiagnostics({
    enabled: false,
    THREE: {},
    renderer,
    scene,
    camera,
  });
  assert.equal(disabled.supported, true);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.mode, WEBGL_RENDER_DIAGNOSTIC_MODE.OFF);
  assert.equal(disabled.beginFrame({ frameSequence: 1 }), null);
  assert.equal(disabled.snapshot().captureCount, 0);
  assert.equal(traversals, 0);

  const fakeRenderer = createWebGLRenderDiagnostics({
    enabled: true,
    THREE: {},
    renderer: { isWebGLRenderer: false },
    scene,
    camera,
  });
  assert.equal(fakeRenderer.supported, false);
  assert.equal(fakeRenderer.enabled, false);
  assert.equal(fakeRenderer.beginFrame({ frameSequence: 2 }), null);
  assert.equal(traversals, 0);

  const light = createWebGLRenderDiagnostics({
    mode: WEBGL_RENDER_DIAGNOSTIC_MODE.LIGHT,
    THREE: {},
    renderer,
    scene,
    camera,
  });
  assert.equal(light.supported, true);
  assert.equal(light.enabled, false);
  assert.equal(light.mode, WEBGL_RENDER_DIAGNOSTIC_MODE.LIGHT);
  assert.equal(light.beginFrame({ frameSequence: 3 }), null);
  assert.equal(traversals, 0);
});

test('deep attribution captures first draw, manual/hitch requests, and at most one cadence sample per second', () => {
  const harness = createDeepDiagnosticHarness();
  assert.equal(harness.capture()?.captureReason, 'first-draw');
  harness.advance(16);
  assert.equal(harness.capture(), null);
  assert.equal(harness.diagnostics.requestCapture('manual-proof'), true);
  assert.equal(harness.capture()?.captureReason, 'manual-proof');
  harness.advance(500);
  assert.equal(harness.capture(), null);
  harness.advance(500);
  assert.equal(harness.capture()?.captureReason, 'cadence');
  harness.advance(1);
  assert.equal(harness.capture({ context: { hitch: true } })?.captureReason, 'hitch');
  const snapshot = harness.diagnostics.snapshot();
  assert.equal(snapshot.mode, WEBGL_RENDER_DIAGNOSTIC_MODE.DEEP_ATTRIBUTION);
  assert.equal(snapshot.captureCount, 4);
  assert.equal(snapshot.skippedFrameCount, 2);
  assert.equal(snapshot.sampleIntervalMs, 1_000);
  assert.equal(harness.traversals(), 8, 'two Scene traversals occur only for each admitted deep sample');
});

test('stale GPU attributes require visible, frustum-intersecting, actually drawn logical updates', () => {
  const scenario = ({ visible = true, intersects = true, draw = true }) => {
    const harness = createDeepDiagnosticHarness({ frustumIntersects: intersects });
    harness.capture();
    harness.mesh.visible = visible;
    harness.instanceMatrix.version = 1;
    harness.diagnostics.requestCapture('stale-check');
    const frame = harness.capture({ draw });
    const staleCodes = frame.anomalyCodes.filter(code => code.startsWith('gpu-attribute-stale:'));
    return { frame, staleCodes };
  };
  assert.deepEqual(scenario({ visible: false }).staleCodes, []);
  assert.deepEqual(scenario({ intersects: false }).staleCodes, []);
  assert.deepEqual(scenario({ draw: false }).staleCodes, []);
  const drawn = scenario({});
  assert.deepEqual(drawn.staleCodes, ['gpu-attribute-stale:building-mesh']);
  assert.equal(drawn.frame.meshDrawState[0].staleGpuAttribute, true);
  assert.deepEqual(drawn.frame.meshDrawState[0].staleGpuAttributeNames, ['instanceMatrix']);
});

test('WebGL2 partial buffer uploads count only the selected source range', () => {
  const harness = createDeepDiagnosticHarness();
  const source = new Float32Array(10);
  const frame = harness.capture({
    upload(context) {
      context.bufferSubData(0x8892, 0, source, 2, 3);
      context.bufferData(0x8892, source, 0x88E4, 4, 2);
    },
  });
  const building = frame.meshDrawState[0];
  assert.equal(building.gpuBufferUploadCount, 2);
  assert.equal(building.gpuBufferUploadBytes, 20,
    '3 Float32 elements plus 2 Float32 elements are uploaded');
  assert.equal(frame.gpuBufferUploadCount, 2);
  assert.equal(frame.gpuBufferUploadBytes, 20);
  assert.equal(frame.unattributedGpuBufferUploadCount, 0);
  assert.equal(harness.uploads.length, 2, 'wrapped calls still reach the original WebGL methods');
});

test('WebGL2 explicit zero sourceLength retains the specified remainder semantics', () => {
  const harness = createDeepDiagnosticHarness();
  const source = new Float32Array(10);
  const frame = harness.capture({
    upload(context) {
      context.bufferSubData(0x8892, 0, source, 2, 0);
      context.bufferData(0x8892, source, 0x88E4, 4, 0);
    },
  });
  assert.equal(frame.gpuBufferUploadCount, 2);
  assert.equal(frame.gpuBufferUploadBytes, 56,
    'zero sourceLength means the remaining 8 plus 6 Float32 elements');
  assert.equal(frame.meshDrawState[0].gpuBufferUploadBytes, 56);
});

test('Three upload-before-onBeforeRender order is counted in unconditional frame totals only', () => {
  const harness = createDeepDiagnosticHarness();
  const source = new Float32Array(10);
  const frame = harness.capture({
    uploadBeforeDraw: true,
    upload(context) {
      context.bufferData(0x8892, source, 0x88E4);
      context.bufferSubData(0x8892, 0, source, 2, 3);
    },
  });
  assert.equal(frame.gpuBufferUploadCount, 2);
  assert.equal(frame.gpuBufferUploadBytes, 52);
  assert.equal(frame.unattributedGpuBufferUploadCount, 2);
  assert.equal(frame.unattributedGpuBufferUploadBytes, 52);
  assert.equal(frame.meshDrawState[0].gpuBufferUploadCount, 0,
    'pre-draw uploads must not be assigned to a guessed object');
  assert.equal(frame.meshDrawState[0].actualDrawCount, 1);
});

test('deep scene traversal failure is reported once, quarantined, and remains live for 600 frames', () => {
  const faults = [];
  const harness = createDeepDiagnosticHarness({
    sampleIntervalMs: 0,
    onObserverError: fault => faults.push(fault),
  });
  harness.failTraversal(new Error('injected deep traversal failure'));
  for (let frame = 0; frame < 600; frame += 1) {
    assert.doesNotThrow(() => {
      assert.equal(harness.diagnostics.beginFrame({ frameSequence: frame + 1 }), null);
    });
  }
  const snapshot = harness.diagnostics.snapshot();
  assert.equal(snapshot.deepCaptureQuarantined, true);
  assert.equal(snapshot.captureCount, 0);
  assert.equal(snapshot.skippedFrameCount, 599);
  assert.equal(snapshot.observerErrorCount, 1);
  assert.equal(snapshot.observerLastError.stage, 'scene-traversal');
  assert.equal(faults.length, 1);
  assert.equal(faults[0].subsystem, 'webgl-render-diagnostics');
  assert.equal(faults[0].stage, 'scene-traversal');
});

test('proof publisher failures are surfaced and quarantined without disabling safety capture', () => {
  const faults = [];
  let proofCalls = 0;
  const harness = createDeepDiagnosticHarness({
    publishProof() {
      proofCalls += 1;
      throw new Error('proof sink unavailable');
    },
    onObserverError: fault => faults.push(fault),
  });
  const first = harness.capture();
  assert.ok(first);
  harness.instanceMatrix.version = 1;
  harness.diagnostics.requestCapture('second');
  const second = harness.capture();
  assert.ok(second.anomalyCodes.some(code => code.startsWith('gpu-attribute-stale:')),
    'the second frame would normally request proof publication');
  const snapshot = harness.diagnostics.snapshot();
  assert.equal(proofCalls, 1);
  assert.equal(snapshot.proofPublisherQuarantined, true);
  assert.equal(snapshot.observerErrorCount, 1);
  assert.match(snapshot.observerLastError.message, /proof sink unavailable/);
  assert.equal(snapshot.captureCount, 2, 'observer quarantine does not remove continuity diagnostics');
  assert.equal(faults.length, 1);
});
