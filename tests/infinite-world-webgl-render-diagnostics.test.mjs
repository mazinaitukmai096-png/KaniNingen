import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWebGLRenderDiagnostics,
  createWebGLRenderIncidentRing,
} from '../src/infinite-world/webgl-render-diagnostics.js';

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
});
