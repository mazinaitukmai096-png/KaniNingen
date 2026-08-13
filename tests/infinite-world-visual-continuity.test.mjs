import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VISUAL_CONTINUITY_STATE,
  VISUAL_PIPELINE_STAGE,
  createDrawableReplacementBarrier,
  createGpuAttributeMirror,
  createRenderFrameAcknowledger,
  createVisualContinuityRegistry,
  isDrawableInCompletedFrame,
} from '../src/infinite-world/visual-continuity.js';

function createAttribute(values, itemSize = 1) {
  let dirty = false;
  return {
    array: new Float32Array(values),
    itemSize,
    version: 0,
    updateRanges: [],
    get needsUpdate() { return dirty; },
    set needsUpdate(value) {
      dirty = value === true;
      if (dirty) this.version += 1;
    },
    clearUpdateRanges() { this.updateRanges.length = 0; },
    addUpdateRange(start, count) { this.updateRanges.push({ start, count }); },
  };
}

function identityMatrix() {
  return { elements: new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]) };
}

function createDrawable(attribute = createAttribute([1, 2, 3], 1)) {
  const mesh = {
    visible: true,
    geometry: { attributes: { density: attribute } },
    material: { opacity: 1, visible: true },
    matrixWorld: identityMatrix(),
    children: [],
    parent: null,
  };
  const scene = { children: [mesh] };
  mesh.parent = scene;
  return { mesh, scene, attribute };
}

test('Resource ready never promotes an Expected owner to Drawable', () => {
  let now = 10;
  const registry = createVisualContinuityRegistry({ clock: () => now });
  registry.expect({
    ownerKey: '0,0',
    expectedAt: 10,
    firstPossibleVisibleAt: 12,
    deadlineAtMs: 20,
    resourceKind: 'presentation',
  });
  now = 14;
  registry.recordPipelineStage({
    ownerKey: '0,0',
    stage: VISUAL_PIPELINE_STAGE.RESOURCE_READY,
  });
  const owner = registry.get('0,0');
  assert.equal(owner.state, VISUAL_CONTINUITY_STATE.EXPECTED);
  assert.equal(owner.resourceReadyAt, 14);
  assert.equal(owner.coarseDrawableAt, null);
});

test('only an opaque completed renderer receipt can acknowledge a drawable', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const drawable = createDrawable();
  registry.expect({ ownerKey: '1,0', deadlineAtMs: 16 });

  assert.equal(registry.acknowledgeDrawable({
    ownerKey: '1,0',
    receipt: { rendererFrameCompleted: true, completedAtMs: 1 },
    drawable: { mesh: drawable.mesh },
  }), false, 'a manual mark cannot forge renderer completion');

  const token = frames.beginFrame({ frameSequence: 1 });
  now = 16;
  const receipt = frames.completeFrame(token, { scene: drawable.scene });
  const unattached = createDrawable().mesh;
  assert.equal(registry.acknowledgeDrawable({
    ownerKey: '1,0',
    receipt,
    drawable: { mesh: unattached },
  }), false, 'a receipt from an unrelated scene cannot acknowledge an unattached mesh');
  assert.equal(registry.acknowledgeDrawable({
    ownerKey: '1,0',
    receipt,
    drawable: { mesh: drawable.mesh },
  }), true);
  assert.equal(registry.get('1,0').state, VISUAL_CONTINUITY_STATE.COARSE_DRAWABLE);
  assert.equal(registry.get('1,0').lastActualDrawAt, 16);
  assert.equal(registry.get('1,0').visualWorkStartedAt, 16);
});

test('visibility, opacity, matrix, and GPU state are all required for Drawable', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const drawable = createDrawable();
  let token = frames.beginFrame({ frameSequence: 1 });
  now = 1;
  let receipt = frames.completeFrame(token, { scene: drawable.scene });
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), true);

  drawable.mesh.visible = false;
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), false);
  drawable.mesh.visible = true;
  drawable.mesh.material.opacity = 0;
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), false);
  drawable.mesh.material.opacity = 1;
  drawable.mesh.matrixWorld.elements[3] = Number.NaN;
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), false);
  drawable.mesh.matrixWorld.elements[3] = 0;

  drawable.attribute.array[0] = 99;
  token = frames.beginFrame({ frameSequence: 2 });
  now = 2;
  receipt = frames.completeFrame(token, { scene: drawable.scene });
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), false,
    'an unmarked CPU write cannot masquerade as a GPU upload');
  drawable.attribute.clearUpdateRanges();
  drawable.attribute.addUpdateRange(0, 1);
  drawable.attribute.needsUpdate = true;
  token = frames.beginFrame({ frameSequence: 3 });
  now = 3;
  receipt = frames.completeFrame(token, { scene: drawable.scene });
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), true);
});

test('deadline metrics include owners that have never drawn', () => {
  let now = 0;
  const registry = createVisualContinuityRegistry({ clock: () => now });
  registry.expect({ ownerKey: 'missing', expectedAt: 0, deadlineAtMs: 5 });
  registry.expect({ ownerKey: 'also-missing', expectedAt: 2, deadlineAtMs: 8 });
  registry.recordPipelineStage({ ownerKey: 'missing', stage: VISUAL_PIPELINE_STAGE.REQUEST, at: 1 });
  now = 20;
  const snapshot = registry.snapshot();
  assert.equal(snapshot.expectedOwnerCount, 2);
  assert.equal(snapshot.coarseDrawableCount, 0);
  assert.equal(snapshot.deadlineMissCount, 2);
  assert.equal(snapshot.oldestMissingAgeMs, 20);
  assert.equal(snapshot.maxDeadlineMissMs, 15);
  assert.equal(snapshot.queueAgeMs, 19);
  assert.equal(snapshot.actualDrawableLatencyMs.count, 2);
  assert.equal(snapshot.actualDrawableLatencyMs.includesMissingOwners, true);
  assert.equal(snapshot.actualDrawableLatencyMs.p95 > 0, true);
});

test('retired visual records are bounded without deleting active Expected owners', () => {
  const registry = createVisualContinuityRegistry({ clock: () => 10 });
  registry.expect({ ownerKey: 'active', expectedAt: 0 });
  for (let index = 0; index < 5; index += 1) {
    const ownerKey = `retired:${index}`;
    registry.expect({ ownerKey, expectedAt: index });
    registry.retire({ ownerKey, at: index + 1 });
  }
  assert.equal(registry.pruneRetired({ maximumRecords: 3 }), 3);
  const snapshot = registry.snapshot();
  assert.equal(snapshot.owners.length, 3);
  assert.notEqual(registry.get('active'), null);
  assert.equal(snapshot.expectedOwnerCount, 1);
});

test('scene acknowledgment rejects a canonical instance whose slot matrix is invalid', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const drawable = createDrawable();
  drawable.mesh.count = 1;
  drawable.mesh.instanceMatrix = createAttribute(new Float32Array(16), 16);
  drawable.mesh.instanceMatrix.array[0] = Number.NaN;
  drawable.mesh.userData = {
    canonicalObjects: [{
      stableId: 'natural:invalid',
      owningChunkCoordinate: { x: 2, z: 3 },
    }],
    canonicalOpacities: [1],
  };
  registry.expect({ ownerKey: '2,3', expectedAt: 0 });
  const token = frames.beginFrame({ frameSequence: 1 });
  now = 1;
  const receipt = frames.completeFrame(token, { scene: drawable.scene });
  assert.equal(registry.acknowledgeScene({ receipt, scene: drawable.scene }), 0);
  assert.equal(registry.get('2,3').state, VISUAL_CONTINUITY_STATE.EXPECTED);
});

test('a completed Near Natural draw updates the same owner record and canonical Stable ID', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const drawable = createDrawable();
  const ownerGroup = {
    visible: true,
    userData: { chunkKey: '4,5' },
    children: [drawable.mesh],
    parent: drawable.scene,
  };
  drawable.scene.children = [ownerGroup];
  drawable.mesh.parent = ownerGroup;
  drawable.mesh.count = 1;
  drawable.mesh.instanceMatrix = createAttribute(identityMatrix().elements, 16);
  drawable.mesh.userData = {
    featureStableIds: ['natural:shared-stable-id'],
    treeStableIds: ['natural:shared-stable-id'],
  };
  registry.expect({
    ownerKey: '4,5',
    expectedAt: 0,
    canonicalStableIds: ['natural:shared-stable-id'],
  });

  const token = frames.beginFrame({ frameSequence: 1 });
  now = 8;
  const receipt = frames.completeFrame(token, { scene: drawable.scene });
  assert.equal(registry.acknowledgeScene({ receipt, scene: drawable.scene }), 1);

  const owner = registry.get('4,5');
  assert.equal(owner.nearRepresentationAvailableAt, 8);
  assert.equal(owner.detailDrawableAt, 8);
  assert.deepEqual(owner.canonicalStableIds, ['natural:shared-stable-id']);
});

test('generic replacement barrier retains the old drawable until the new one actually draws', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const disposed = [];
  const barrier = createDrawableReplacementBarrier({
    visualRegistry: registry,
    disposeDrawable: value => disposed.push(value.id),
  });
  const drawable = createDrawable();
  registry.expect({ ownerKey: 'road:0,0', deadlineAtMs: 10 });
  barrier.retain({ ownerKey: 'road:0,0', drawable: { id: 'old-road' } });
  assert.equal(barrier.acknowledgeReplacement({
    ownerKey: 'road:0,0',
    receipt: {},
    drawable: { mesh: drawable.mesh },
  }), false);
  assert.deepEqual(disposed, []);

  const token = frames.beginFrame({ frameSequence: 1 });
  now = 10;
  const receipt = frames.completeFrame(token, { scene: drawable.scene });
  assert.equal(barrier.acknowledgeReplacement({
    ownerKey: 'road:0,0',
    receipt,
    drawable: { mesh: drawable.mesh },
  }), true);
  assert.deepEqual(disposed, ['old-road']);
  assert.equal(barrier.snapshot().retainedOwnerCount, 0);
});

test('GPU mirror stays equal across new slot, reuse, pool recycle, and reversal updates', () => {
  const density = createAttribute([0.1, 0.2, 0.3, 0.4]);
  const drawable = createDrawable(density);
  const gpuMirror = createGpuAttributeMirror();
  let now = 0;
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const render = frameSequence => {
    const token = frames.beginFrame({ frameSequence });
    now += 1;
    frames.completeFrame(token, { scene: drawable.scene });
    assert.deepEqual(gpuMirror.read(density), Array.from(density.array));
  };

  render(1); // new slots
  density.array[1] = 0.8; // reused slot
  density.clearUpdateRanges();
  density.addUpdateRange(1, 1);
  density.needsUpdate = true;
  render(2);
  density.array.set([0.4, 0.3, 0.2, 0.1]); // pool recycle
  density.clearUpdateRanges();
  density.addUpdateRange(0, 4);
  density.needsUpdate = true;
  render(3);
  [density.array[0], density.array[3]] = [density.array[3], density.array[0]]; // reversal
  density.clearUpdateRanges();
  density.addUpdateRange(0, 1);
  density.addUpdateRange(3, 1);
  density.needsUpdate = true;
  render(4);
});
