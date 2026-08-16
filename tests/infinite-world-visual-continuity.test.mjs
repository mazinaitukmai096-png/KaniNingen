import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VISUAL_CONTINUITY_STATE,
  VISUAL_PIPELINE_STAGE,
  createDrawableReplacementBarrier,
  createGpuAttributeMirror,
  createRenderFrameAcknowledger,
  createRendererGpuAttributeMirror,
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
    onUploadCallback() {},
    onUpload(callback) { this.onUploadCallback = callback; return this; },
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

function identityMatrices(count) {
  const values = new Float32Array(count * 16);
  for (let slot = 0; slot < count; slot += 1) {
    values.set(identityMatrix().elements, slot * 16);
  }
  return values;
}

function markTerrain(mesh, band = 'high') {
  mesh.geometry.attributes.position ??= createAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 0, 1,
  ], 3);
  mesh.geometry.attributes.color ??= createAttribute([
    0.2, 0.4, 0.2,
    0.3, 0.5, 0.3,
    0.4, 0.6, 0.4,
  ], 3);
  mesh.geometry.index ??= createAttribute([0, 1, 2], 1);
  mesh.userData = {
    ...(mesh.userData ?? {}),
    logicalTerrainSurface: true,
    terrainLodBand: band,
  };
  if (band === 'low') {
    mesh.userData.innerCellBoundaryMeters = 40;
    mesh.userData.outerCellBoundaryMeters = 352;
  }
  return mesh;
}

const lowTerrainCoverage = ownerKeys => ({
  ownerKeys,
  lowAnnulus: {
    centerWorldX: 0,
    centerWorldZ: 0,
    innerBoundaryMeters: 40,
    outerBoundaryMeters: 352,
  },
});

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

test('progress snapshot reports lifecycle counts without owner evidence arrays', () => {
  let now = 10;
  const registry = createVisualContinuityRegistry({ clock: () => now });
  registry.expect({ ownerKey: '0,0', deadlineAtMs: 15 });
  registry.expect({ ownerKey: '1,0', deadlineAtMs: null });
  registry.resolveCoarseRequirements({
    ownerKey: '0,0',
    summary: { terrainRequired: true },
  });
  now = 20;
  assert.deepEqual(registry.progressSnapshot(), {
    schemaVersion: 'visual-continuity-progress-1',
    expectedOwnerCount: 2,
    coarseDrawableCount: 0,
    detailDrawableCount: 0,
    requirementsResolvedOwnerCount: 1,
    requirementsUnresolvedOwnerCount: 1,
    deadlineMissCount: 1,
    currentReceiptMissingCount: {
      terrain: 0,
      structure: 0,
      forest: 0,
    },
  });
  registry.retire({ ownerKey: '0,0' });
  assert.equal(registry.progressSnapshot().expectedOwnerCount, 1);
});

test('only an opaque completed renderer receipt can acknowledge a drawable', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const drawable = createDrawable();
  markTerrain(drawable.mesh);
  registry.expect({ ownerKey: '1,0', deadlineAtMs: 16 });
  registry.resolveCoarseRequirements({
    ownerKey: '1,0',
    summary: { terrainRequired: true, structureStableIds: [], forestStableIds: [] },
  });

  assert.equal(registry.acknowledgeDrawable({
    ownerKey: '1,0',
    component: 'terrain',
    receipt: { rendererFrameCompleted: true, completedAtMs: 1 },
    drawable: { mesh: drawable.mesh },
  }), false, 'a manual mark cannot forge renderer completion');

  const token = frames.beginFrame({ frameSequence: 1 });
  now = 16;
  const receipt = frames.completeFrame(token, { scene: drawable.scene });
  const unattached = createDrawable().mesh;
  assert.equal(registry.acknowledgeDrawable({
    ownerKey: '1,0',
    component: 'terrain',
    receipt,
    drawable: { mesh: unattached },
  }), false, 'a receipt from an unrelated scene cannot acknowledge an unattached mesh');
  assert.equal(registry.acknowledgeDrawable({
    ownerKey: '1,0',
    component: 'terrain',
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
  drawable.mesh.matrixWorld.elements[0] = 0;
  drawable.mesh.matrixWorld.elements[5] = 0;
  drawable.mesh.matrixWorld.elements[10] = 0;
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), false,
    'a zero-scale matrix participates in a draw call but produces no drawable geometry');
  drawable.mesh.matrixWorld = identityMatrix();

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

test('renderer GPU shadow commits only ranges accepted by a completed renderer upload', () => {
  let now = 0;
  const attribute = createAttribute([1, 2], 1);
  const drawable = createDrawable(attribute);
  const gpuRecords = new WeakMap();
  let rendererUploads = true;
  const renderer = {
    attributes: { get: value => gpuRecords.get(value) ?? null },
    render() {
      if (!rendererUploads) return;
      gpuRecords.set(attribute, { version: attribute.version });
      attribute.clearUpdateRanges();
    },
  };
  const gpuMirror = createRendererGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });

  let token = frames.beginFrame({ frameSequence: 1, scene: drawable.scene });
  renderer.render();
  now = 1;
  let receipt = frames.completeFrame(token, { scene: drawable.scene, renderer });
  assert.deepEqual(Array.from(gpuMirror.read(attribute)), [1, 2]);
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), true);

  attribute.array.set([10, 20]);
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, 1);
  attribute.needsUpdate = true;
  token = frames.beginFrame({ frameSequence: 2, scene: drawable.scene });
  renderer.render();
  now = 2;
  receipt = frames.completeFrame(token, { scene: drawable.scene, renderer });
  assert.deepEqual(Array.from(gpuMirror.read(attribute)), [10, 2],
    'the shadow must not infer the omitted second component from CPU memory');
  assert.equal(gpuMirror.matches(attribute), false);
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), false,
    'a version match cannot prove equality when a dirty component was omitted');

  attribute.clearUpdateRanges();
  attribute.addUpdateRange(1, 1);
  attribute.needsUpdate = true;
  token = frames.beginFrame({ frameSequence: 3, scene: drawable.scene });
  rendererUploads = false;
  renderer.render();
  now = 3;
  receipt = frames.completeFrame(token, { scene: drawable.scene, renderer });
  assert.deepEqual(Array.from(gpuMirror.read(attribute)), [10, 2],
    'a completed frame cannot commit a range whose GPU version stayed old');
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), false);

  token = frames.beginFrame({ frameSequence: 4, scene: drawable.scene });
  rendererUploads = true;
  renderer.render();
  now = 4;
  receipt = frames.completeFrame(token, { scene: drawable.scene, renderer });
  assert.deepEqual(Array.from(gpuMirror.read(attribute)), [10, 20]);
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), true);
});

test('renderer GPU shadow uses the Three r160 upload callback when WebGLAttributes is private', () => {
  let now = 0;
  const attribute = createAttribute([1, 2], 1);
  const drawable = createDrawable(attribute);
  let rendererUploads = true;
  const renderer = {
    render() {
      if (!rendererUploads) return;
      attribute.onUploadCallback();
      attribute.clearUpdateRanges();
    },
  };
  const gpuMirror = createRendererGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });

  let token = frames.beginFrame({ frameSequence: 1, scene: drawable.scene });
  renderer.render();
  now = 1;
  let receipt = frames.completeFrame(token, { scene: drawable.scene, renderer });
  assert.deepEqual(Array.from(gpuMirror.read(attribute)), [1, 2]);
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), true);

  attribute.array[0] = 9;
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, 1);
  attribute.needsUpdate = true;
  token = frames.beginFrame({ frameSequence: 2, scene: drawable.scene });
  rendererUploads = false;
  renderer.render();
  now = 2;
  receipt = frames.completeFrame(token, { scene: drawable.scene, renderer });
  assert.deepEqual(Array.from(gpuMirror.read(attribute)), [1, 2],
    'CPU changes cannot commit when the renderer never calls the upload callback');
  assert.equal(isDrawableInCompletedFrame({ mesh: drawable.mesh, receipt }), false);

  token = frames.beginFrame({ frameSequence: 3, scene: drawable.scene });
  rendererUploads = true;
  renderer.render();
  now = 3;
  receipt = frames.completeFrame(token, { scene: drawable.scene, renderer });
  assert.deepEqual(Array.from(gpuMirror.read(attribute)), [9, 2]);
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
  assert.equal(snapshot.coarseComponentMetrics.requirementsUnresolvedOwnerCount, 2);
  assert.equal(snapshot.coarseComponentMetrics.terrain.requiredCount, 2);
  assert.equal(snapshot.coarseComponentMetrics.terrain.drawableCount, 0);
  assert.equal(snapshot.coarseComponentMetrics.terrain.deadlineMissCount, 2);
  assert.equal(snapshot.coarseComponentMetrics.terrain.actualDrawableLatencyMs.count, 2);
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
      objectType: 'tree',
      owningChunkCoordinate: { x: 2, z: 3 },
    }],
    canonicalOpacities: [1],
  };
  registry.expect({ ownerKey: '2,3', expectedAt: 0 });
  registry.resolveCoarseRequirements({
    ownerKey: '2,3',
    summary: { structureStableIds: [], forestStableIds: ['natural:invalid'] },
  });
  const terrain = createDrawable();
  markTerrain(terrain.mesh, 'medium');
  terrain.mesh.userData.visibleOwnerKeys = ['2,3'];
  drawable.scene.children.push(terrain.mesh);
  terrain.mesh.parent = drawable.scene;
  const token = frames.beginFrame({ frameSequence: 1 });
  now = 1;
  const receipt = frames.completeFrame(token, { scene: drawable.scene });
  assert.equal(registry.acknowledgeScene({
    receipt,
    scene: drawable.scene,
    terrainCoverageOwnerKeys: new Set(['2,3']),
  }), 1);
  assert.equal(registry.get('2,3').state, VISUAL_CONTINUITY_STATE.EXPECTED);
  assert.deepEqual(registry.get('2,3').drawnForestStableIds, []);
});

test('receipt metrics distinguish two coarse presenters from a Near/coarse handoff overlap', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const terrain = createDrawable().mesh;
  markTerrain(terrain, 'medium');
  terrain.userData.visibleOwnerKeys = ['4,5'];
  const makeTree = () => {
    const mesh = createDrawable().mesh;
    mesh.count = 1;
    mesh.instanceMatrix = createAttribute(identityMatrices(1), 16);
    mesh.userData = {
      canonicalObjects: [{
        stableId: 'tree:duplicated-coarse',
        owner: '4,5',
        objectType: 'tree',
      }],
      canonicalOpacities: [1],
    };
    return mesh;
  };
  const first = makeTree();
  const second = makeTree();
  const scene = { children: [terrain, first, second] };
  for (const mesh of scene.children) mesh.parent = scene;
  registry.expect({ ownerKey: '4,5', expectedAt: 0 });
  registry.resolveCoarseRequirements({
    ownerKey: '4,5',
    structureStableIds: [],
    forestStableIds: ['tree:duplicated-coarse'],
  });
  const token = frames.beginFrame({ frameSequence: 1 });
  now = 1;
  const receipt = frames.completeFrame(token, { scene });
  registry.acknowledgeScene({
    receipt,
    scene,
    terrainCoverageOwnerKeys: new Set(['4,5']),
  });
  const presentation = registry.snapshot().lastReceiptPresentation;
  assert.equal(presentation.treeDuplicatePresenterCount, 0,
    'two coarse meshes are not a Near/coarse handoff overlap');
  assert.equal(presentation.treeDuplicateCoarsePresenterCount, 1);
  assert.deepEqual(presentation.treeDuplicateCoarseStableIds, ['tree:duplicated-coarse']);
  assert.equal(presentation.treeDuplicateCoarsePresenterFrameCount, 1);
});

test('owner CoarseDrawable waits for receipt-proven Terrain and every declared structure and forest ID', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const terrain = createDrawable().mesh;
  markTerrain(terrain, 'low');
  const canonical = createDrawable().mesh;
  canonical.count = 5;
  canonical.instanceMatrix = createAttribute(identityMatrices(5), 16);
  canonical.userData = {
    canonicalObjects: [
      { stableId: 'building:required', owner: '10,20', objectType: 'building' },
      { stableId: 'road:required', owner: '10,20', featureType: 'settlement-road' },
      { stableId: 'tree:required', owner: '10,20', objectType: 'tree' },
      { stableId: 'rock:detail-only', owner: '10,20', objectType: 'rock' },
      { stableId: 'shrub:detail-only', owner: '10,20', objectType: 'shrub' },
    ],
    canonicalOpacities: [1, 1, 0, 1, 1],
  };
  const detail = createDrawable().mesh;
  detail.count = 1;
  detail.instanceMatrix = createAttribute(identityMatrices(1), 16);
  detail.userData = {
    featureStableIds: ['tree:required'],
    treeStableIds: ['tree:required'],
  };
  const scene = { children: [] };
  const ownerGroup = {
    visible: true,
    userData: { chunkKey: '10,20' },
    children: [detail],
    parent: scene,
  };
  detail.parent = ownerGroup;
  for (const mesh of [terrain, canonical]) mesh.parent = scene;
  scene.children.push(terrain, canonical, ownerGroup);

  registry.expect({ ownerKey: '10,20', expectedAt: 0, deadlineAtMs: 1.5 });
  const resolved = registry.resolveCoarseRequirements({
    ownerKey: '10,20',
    summary: {
      terrainRequired: true,
      structureStableIds: ['building:required', 'road:required'],
      forestStableIds: ['tree:required'],
    },
  });
  assert.equal(resolved.forestRequired, true);
  assert.equal(resolved.coarseRequirementsComplete, false);

  let token = frames.beginFrame({ frameSequence: 1 });
  now = 1;
  let receipt = frames.completeFrame(token, { scene });
  assert.equal(registry.acknowledgeScene({
    receipt,
    scene,
    terrainCoverage: lowTerrainCoverage(['10,20']),
  }), 5, 'Terrain, two structures, the declared Near Tree, and detail are acknowledged');
  let owner = registry.get('10,20');
  assert.equal(owner.state, VISUAL_CONTINUITY_STATE.DETAIL_DRAWABLE);
  assert.equal(owner.terrainDrawableAt, 1);
  assert.deepEqual(owner.drawnStructureStableIds, [
    'building:required',
    'road:required',
  ]);
  assert.deepEqual(owner.drawnForestStableIds, ['tree:required']);
  assert.equal(owner.pendingDetailDrawableAt, 1);
  assert.equal(owner.coarseDrawableAt, 1);
  assert.equal(owner.detailDrawableAt, 1,
    'the same declared Stable ID may prove forest through its completed Near draw');
  assert.deepEqual(owner.canonicalStableIds, [
    'building:required',
    'road:required',
    'tree:required',
  ], 'generic Rock/Shrub slots cannot become coarse canonical requirements');

  canonical.userData.canonicalOpacities[2] = 1;
  token = frames.beginFrame({ frameSequence: 2 });
  now = 2;
  receipt = frames.completeFrame(token, { scene });
  registry.acknowledgeScene({
    receipt,
    scene,
    terrainCoverage: lowTerrainCoverage(['10,20']),
  });
  owner = registry.get('10,20');
  assert.equal(owner.coarseRequirementsComplete, true);
  assert.equal(owner.coarseDrawableAt, 1);
  assert.equal(owner.detailDrawableAt, 1,
    'the pending detail receipt completes automatically after aggregate coarse');
  assert.equal(owner.state, VISUAL_CONTINUITY_STATE.DETAIL_DRAWABLE);
  assert.deepEqual(owner.forestComponentDraws, [{
    stableId: 'tree:required',
    actualDrawableAt: 1,
    gpuUploadedAt: 1,
    rendererFrameSequence: 1,
  }]);

  const metrics = registry.snapshot().coarseComponentMetrics;
  assert.equal(metrics.requirementsResolvedOwnerCount, 1);
  assert.equal(metrics.requirementsUnresolvedOwnerCount, 0);
  assert.deepEqual({
    required: metrics.terrain.requiredCount,
    drawn: metrics.terrain.drawableCount,
    missed: metrics.terrain.deadlineMissCount,
  }, { required: 1, drawn: 1, missed: 0 });
  assert.deepEqual({
    required: metrics.structure.requiredCount,
    drawn: metrics.structure.drawableCount,
    missed: metrics.structure.deadlineMissCount,
  }, { required: 2, drawn: 2, missed: 0 });
  assert.deepEqual({
    required: metrics.forest.requiredCount,
    drawn: metrics.forest.drawableCount,
    missed: metrics.forest.deadlineMissCount,
  }, { required: 1, drawn: 1, missed: 0 });
  assert.equal(metrics.forest.actualDrawableLatencyMs.max, 1);
  assert.equal(metrics.forest.actualDrawableLatencyMs.includesMissingComponents, true);
  assert.deepEqual(registry.snapshot().lastReceiptPresentation, {
    rendererFrameSequence: 2,
    completedAtMs: 2,
    actualComponentDrawCount: 5,
    acknowledgedOwnerKeys: ['10,20'],
    treePresenterCount: 2,
    treePresenterStableIds: ['tree:required'],
    treeZeroPresenterRequiredCount: 0,
    treeDuplicatePresenterCount: 1,
    treeDuplicateStableIds: ['tree:required'],
    treeDuplicateCoarsePresenterCount: 0,
    treeDuplicateCoarseStableIds: [],
    treeZeroPresenterFrameCount: 0,
    treeDuplicatePresenterFrameCount: 1,
    treeDuplicateCoarsePresenterFrameCount: 0,
    currentReceiptCoarseComponentMetrics: {
      rendererFrameSequence: 2,
      completedAtMs: 2,
      requirementsResolvedOwnerCount: 1,
      requirementsUnresolvedOwnerCount: 0,
      terrain: {
        requiredCount: 1,
        drawableCount: 1,
        missingCount: 0,
        missingOwnerKeys: [],
        disappearanceCount: 0,
        disappearanceOwnerKeys: [],
        disappearanceFrameCount: 0,
      },
      structure: {
        requiredCount: 2,
        drawableCount: 2,
        missingCount: 0,
        missingStableIds: [],
        missingRequirements: [],
        disappearanceCount: 0,
        disappearanceStableIds: [],
        disappearanceRequirements: [],
        disappearanceFrameCount: 0,
      },
      forest: {
        requiredCount: 1,
        drawableCount: 1,
        missingCount: 0,
        missingStableIds: [],
        missingRequirements: [],
        disappearanceCount: 0,
        disappearanceStableIds: [],
        disappearanceRequirements: [],
        disappearanceFrameCount: 0,
      },
    },
    scanErrorCount: 0,
  });

  canonical.userData.canonicalOpacities[2] = 0;
  ownerGroup.visible = false;
  token = frames.beginFrame({ frameSequence: 3 });
  now = 3;
  receipt = frames.completeFrame(token, { scene });
  registry.acknowledgeScene({
    receipt,
    scene,
    terrainCoverage: lowTerrainCoverage(['10,20']),
  });
  assert.equal(registry.snapshot().lastReceiptPresentation.treeZeroPresenterRequiredCount, 1,
    'a previously receipt-proven required Tree is a real zero-presenter discontinuity');
  assert.equal(registry.snapshot().lastReceiptPresentation.treeZeroPresenterFrameCount, 1);
});

test('Tree zero-presenter history ends when its visual owner retires', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const ownerKey = '19,39';
  const stableId = 'tree:contract-reentry';
  const canonical = createDrawable().mesh;
  canonical.count = 1;
  canonical.instanceMatrix = createAttribute(identityMatrices(1), 16);
  canonical.userData = {
    canonicalObjects: [{ stableId, owner: ownerKey, objectType: 'tree' }],
    canonicalOpacities: [1],
  };
  const scene = { children: [canonical] };
  canonical.parent = scene;
  const expectOwner = () => {
    registry.expect({ ownerKey, expectedAt: now });
    registry.resolveCoarseRequirements({
      ownerKey,
      structureStableIds: [],
      forestStableIds: [stableId],
    });
  };
  const render = frameSequence => {
    const token = frames.beginFrame({ frameSequence });
    const receipt = frames.completeFrame(token, { scene });
    registry.acknowledgeScene({ receipt, scene });
    return registry.snapshot().lastReceiptPresentation;
  };

  expectOwner();
  now = 1;
  assert.equal(render(1).treeZeroPresenterRequiredCount, 0);
  registry.retire({ ownerKey, at: 2 });
  canonical.userData.canonicalOpacities[0] = 0;
  now = 2;
  assert.equal(render(2).treeZeroPresenterRequiredCount, 0);

  expectOwner();
  now = 3;
  assert.equal(render(3).treeZeroPresenterRequiredCount, 0,
    'a new Expected contract does not inherit the retired contract presenter history');
  canonical.userData.canonicalOpacities[0] = 1;
  now = 4;
  assert.equal(render(4).treeZeroPresenterRequiredCount, 0);
  canonical.userData.canonicalOpacities[0] = 0;
  now = 5;
  assert.equal(render(5).treeZeroPresenterRequiredCount, 1,
    'the same current contract still detects a real post-receipt disappearance');
});

test('current receipt detects vanished coarse components without reversing lifecycle history', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const ownerKey = '30,40';
  const terrain = createDrawable().mesh;
  markTerrain(terrain, 'high');
  terrain.userData.visibleOwnerKeys = [ownerKey];
  terrain.visible = false;
  const canonical = createDrawable().mesh;
  canonical.count = 2;
  canonical.instanceMatrix = createAttribute(identityMatrices(2), 16);
  canonical.userData = {
    canonicalObjects: [
      { stableId: 'building:continuity', owner: ownerKey, objectType: 'building' },
      { stableId: 'tree:continuity', owner: ownerKey, objectType: 'tree' },
    ],
    canonicalOpacities: [0, 0],
  };
  const externalRoad = createDrawable().mesh;
  const scene = { children: [terrain, canonical, externalRoad] };
  for (const mesh of scene.children) mesh.parent = scene;
  registry.expect({ ownerKey, expectedAt: 0 });
  registry.resolveCoarseRequirements({
    ownerKey,
    structureStableIds: ['building:continuity', 'road:continuity'],
    forestStableIds: ['tree:continuity'],
  });

  let token = frames.beginFrame({ frameSequence: 1 });
  now = 1;
  let receipt = frames.completeFrame(token, { scene });
  registry.acknowledgeScene({ receipt, scene, terrainCoverageOwnerKeys: [ownerKey] });
  let current = registry.snapshot().currentReceiptCoarseComponentMetrics;
  assert.deepEqual([
    current.terrain.missingCount,
    current.structure.missingCount,
    current.forest.missingCount,
  ], [1, 2, 1], 'initial coarse fill is reported as currently missing');
  assert.deepEqual([
    current.terrain.disappearanceFrameCount,
    current.structure.disappearanceFrameCount,
    current.forest.disappearanceFrameCount,
  ], [0, 0, 0], 'initial fill is not mislabeled as a disappearance');

  terrain.visible = true;
  canonical.userData.canonicalOpacities = [1, 1];
  token = frames.beginFrame({ frameSequence: 2 });
  now = 2;
  receipt = frames.completeFrame(token, { scene });
  assert.equal(registry.acknowledgeCoarseComponent({
    ownerKey,
    component: 'structure',
    stableIds: ['road:continuity'],
    receipt,
    drawable: { mesh: externalRoad },
  }), true, 'same-receipt external Road evidence is accepted before scene acknowledgement');
  registry.acknowledgeScene({ receipt, scene, terrainCoverageOwnerKeys: [ownerKey] });
  current = registry.snapshot().currentReceiptCoarseComponentMetrics;
  assert.deepEqual([
    current.terrain.missingCount,
    current.structure.missingCount,
    current.forest.missingCount,
  ], [0, 0, 0], 'external and scene evidence are merged for the completed receipt');
  const completedOwner = registry.get(ownerKey);
  assert.equal(completedOwner.state, VISUAL_CONTINUITY_STATE.COARSE_DRAWABLE);
  assert.equal(completedOwner.coarseDrawableAt, 2);

  terrain.visible = false;
  canonical.userData.canonicalOpacities = [0, 0];
  token = frames.beginFrame({ frameSequence: 3 });
  now = 3;
  receipt = frames.completeFrame(token, { scene });
  registry.acknowledgeScene({ receipt, scene, terrainCoverageOwnerKeys: [ownerKey] });
  const snapshot = registry.snapshot();
  current = snapshot.currentReceiptCoarseComponentMetrics;
  assert.strictEqual(
    current,
    snapshot.lastReceiptPresentation.currentReceiptCoarseComponentMetrics,
  );
  assert.deepEqual(current.terrain, {
    requiredCount: 1,
    drawableCount: 0,
    missingCount: 1,
    missingOwnerKeys: [ownerKey],
    disappearanceCount: 1,
    disappearanceOwnerKeys: [ownerKey],
    disappearanceFrameCount: 1,
  });
  assert.deepEqual(current.structure, {
    requiredCount: 2,
    drawableCount: 0,
    missingCount: 2,
    missingStableIds: ['building:continuity', 'road:continuity'],
    missingRequirements: [
      { ownerKey, stableId: 'building:continuity' },
      { ownerKey, stableId: 'road:continuity' },
    ],
    disappearanceCount: 2,
    disappearanceStableIds: ['building:continuity', 'road:continuity'],
    disappearanceRequirements: [
      { ownerKey, stableId: 'building:continuity' },
      { ownerKey, stableId: 'road:continuity' },
    ],
    disappearanceFrameCount: 1,
  });
  assert.deepEqual(current.forest, {
    requiredCount: 1,
    drawableCount: 0,
    missingCount: 1,
    missingStableIds: ['tree:continuity'],
    missingRequirements: [{ ownerKey, stableId: 'tree:continuity' }],
    disappearanceCount: 1,
    disappearanceStableIds: ['tree:continuity'],
    disappearanceRequirements: [{ ownerKey, stableId: 'tree:continuity' }],
    disappearanceFrameCount: 1,
  });
  assert.deepEqual(registry.get(ownerKey), {
    ...completedOwner,
    lastActualDrawAt: 2,
  }, 'historical lifecycle and completed component evidence remain monotonic');
});

test('only valid High, Medium, and Low Terrain coverage can complete a Terrain-only owner', () => {
  for (const [index, band] of ['high', 'medium', 'low'].entries()) {
    let now = 0;
    const gpuMirror = createGpuAttributeMirror();
    const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
    const registry = createVisualContinuityRegistry({ clock: () => now });
    const drawable = createDrawable();
    markTerrain(drawable.mesh, band);
    const ownerKey = `${index + 10},0`;
    if (band !== 'low') drawable.mesh.userData.visibleOwnerKeys = [ownerKey];
    registry.expect({ ownerKey, expectedAt: 0 });
    registry.resolveCoarseRequirements({
      ownerKey,
      structureStableIds: [],
      forestStableIds: [],
    });
    const token = frames.beginFrame({ frameSequence: 1 });
    now = 1;
    const receipt = frames.completeFrame(token, { scene: drawable.scene });
    assert.equal(registry.acknowledgeScene({
      receipt,
      scene: drawable.scene,
      terrainCoverage: band === 'low' ? lowTerrainCoverage([ownerKey]) : {
        ownerKeys: [ownerKey],
      },
    }), 1, band);
    assert.equal(registry.get(ownerKey).state, VISUAL_CONTINUITY_STATE.COARSE_DRAWABLE, band);
    assert.equal(registry.get(ownerKey).forestRequired, false, band);
  }

  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const invalid = createDrawable();
  markTerrain(invalid.mesh, 'ultra');
  registry.expect({ ownerKey: 'invalid-terrain' });
  registry.resolveCoarseRequirements({
    ownerKey: 'invalid-terrain', structureStableIds: [], forestStableIds: [],
  });
  const token = frames.beginFrame({ frameSequence: 1 });
  now = 1;
  const receipt = frames.completeFrame(token, { scene: invalid.scene });
  assert.equal(registry.acknowledgeScene({
    receipt, scene: invalid.scene, terrainCoverageOwnerKeys: ['invalid-terrain'],
  }), 0);
  assert.equal(registry.get('invalid-terrain').state, VISUAL_CONTINUITY_STATE.EXPECTED);
});

test('Low Terrain proves only owner AABBs inside its annulus and unions with inner Terrain', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  for (const ownerKey of ['0,0', '10,0']) {
    registry.expect({ ownerKey, expectedAt: 0 });
    registry.resolveCoarseRequirements({
      ownerKey, structureStableIds: [], forestStableIds: [],
    });
  }
  const low = createDrawable();
  markTerrain(low.mesh, 'low');
  let token = frames.beginFrame({ frameSequence: 1 });
  now = 1;
  let receipt = frames.completeFrame(token, { scene: low.scene });
  assert.equal(registry.acknowledgeScene({
    receipt,
    scene: low.scene,
    terrainCoverage: lowTerrainCoverage(['0,0', '10,0']),
  }), 1);
  assert.equal(registry.get('0,0').state, VISUAL_CONTINUITY_STATE.EXPECTED,
    'the central owner lies in the clipmap hole and needs High/Medium proof');
  assert.equal(registry.get('10,0').state, VISUAL_CONTINUITY_STATE.COARSE_DRAWABLE);

  const high = createDrawable();
  markTerrain(high.mesh, 'high');
  high.mesh.userData.visibleOwnerKeys = ['0,0'];
  low.scene.children.push(high.mesh);
  high.mesh.parent = low.scene;
  token = frames.beginFrame({ frameSequence: 2 });
  now = 2;
  receipt = frames.completeFrame(token, { scene: low.scene });
  registry.acknowledgeScene({
    receipt,
    scene: low.scene,
    terrainCoverage: lowTerrainCoverage(['0,0', '10,0']),
  });
  assert.equal(registry.get('0,0').state, VISUAL_CONTINUITY_STATE.COARSE_DRAWABLE,
    'the High plus Low receipt union completes the inner and outer owners');
});

test('Terrain receipt rejects invalid GPU position, zero color, and invalid topology', () => {
  const cases = [
    ['position', mesh => { mesh.geometry.attributes.position.array[0] = Number.NaN; }],
    ['color', mesh => { mesh.geometry.attributes.color.array.fill(0); }],
    ['index', mesh => { mesh.geometry.index.array.set([0, 0, 2]); }],
  ];
  for (const [label, invalidate] of cases) {
    let now = 0;
    const gpuMirror = createGpuAttributeMirror();
    const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
    const registry = createVisualContinuityRegistry({ clock: () => now });
    const terrain = createDrawable();
    markTerrain(terrain.mesh, 'high');
    terrain.mesh.userData.visibleOwnerKeys = ['0,0'];
    invalidate(terrain.mesh);
    registry.expect({ ownerKey: '0,0' });
    registry.resolveCoarseRequirements({
      ownerKey: '0,0', structureStableIds: [], forestStableIds: [],
    });
    const token = frames.beginFrame({ frameSequence: 1 });
    now = 1;
    const receipt = frames.completeFrame(token, { scene: terrain.scene });
    assert.equal(registry.acknowledgeScene({
      receipt,
      scene: terrain.scene,
      terrainCoverage: { ownerKeys: ['0,0'] },
    }), 0, label);
    assert.equal(registry.get('0,0').state, VISUAL_CONTINUITY_STATE.EXPECTED, label);
  }
});

test('forest proof evaluates GPU anchor distance, entry, exit, and reveal opacity per slot', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const terrain = createDrawable().mesh;
  markTerrain(terrain, 'high');
  terrain.userData.visibleOwnerKeys = ['shader-owner'];
  const forest = createDrawable().mesh;
  forest.count = 1;
  forest.instanceMatrix = createAttribute(identityMatrices(1), 16);
  const anchor = createAttribute([0, 0], 2);
  const reveal = createAttribute([1]);
  forest.geometry.attributes.w8NaturalAnchorXZ = anchor;
  forest.geometry.attributes.w8NaturalInitialReveal = reveal;
  forest.userData = {
    canonicalObjects: [{ stableId: 'tree:shader', owner: 'shader-owner', objectType: 'tree' }],
    canonicalOpacities: [1],
    canonicalCoarseTreeSubmission: true,
    canonicalVisualRevision: 1,
  };
  const uniforms = {
    w8NaturalPlayerLocalXZ: { value: { x: 0, y: 0 } },
    w8NaturalUnitsPerMeter: { value: 1 },
    w8NaturalEnterStart: { value: 10 },
    w8NaturalEnterEnd: { value: 20 },
    w8NaturalExitStart: { value: 40 },
    w8NaturalExitEnd: { value: 50 },
    w8NaturalReveal: { value: 0 },
  };
  forest.material.userData = {
    naturalLodMode: 'far',
    naturalLodKind: 'tree',
    canonicalCoarseTree: true,
    naturalLodUniforms: uniforms,
  };
  const scene = { children: [terrain, forest] };
  terrain.parent = scene;
  forest.parent = scene;
  registry.expect({ ownerKey: 'shader-owner', expectedAt: 0 });
  registry.resolveCoarseRequirements({
    ownerKey: 'shader-owner', structureStableIds: [], forestStableIds: ['tree:shader'],
  });

  const draw = frameSequence => {
    const token = frames.beginFrame({ frameSequence });
    now = frameSequence;
    const receipt = frames.completeFrame(token, { scene });
    registry.acknowledgeScene({
      receipt, scene, terrainCoverage: { ownerKeys: ['shader-owner'] },
    });
  };
  const upload = attribute => {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, attribute.array.length);
    attribute.needsUpdate = true;
  };

  draw(1);
  assert.deepEqual(registry.get('shader-owner').drawnForestStableIds, [],
    'a Tree before the shader entry must not be mistaken for a coarse draw');
  anchor.array[0] = 100;
  upload(anchor);
  draw(2);
  assert.deepEqual(registry.get('shader-owner').drawnForestStableIds, [],
    'a Tree beyond the shader exit is still not drawable');
  anchor.array[0] = 30;
  upload(anchor);
  reveal.array[0] = 0;
  upload(reveal);
  draw(3);
  assert.deepEqual(registry.get('shader-owner').drawnForestStableIds, [],
    'zero stream reveal must not satisfy forest existence');
  reveal.array[0] = 1;
  upload(reveal);
  draw(4);
  const owner = registry.get('shader-owner');
  assert.deepEqual(owner.drawnForestStableIds, ['tree:shader']);
  assert.equal(owner.coarseDrawableAt, 4);
  assert.equal(owner.state, VISUAL_CONTINUITY_STATE.COARSE_DRAWABLE);
  const scanAfterProof = registry.snapshot().receiptScanMetrics;
  draw(5);
  const scanAfterUnchangedReceipt = registry.snapshot().receiptScanMetrics;
  assert.equal(
    scanAfterUnchangedReceipt.canonicalCoarseTreeSlotScanCount,
    scanAfterProof.canonicalCoarseTreeSlotScanCount,
    'an unchanged completed receipt reuses strict GPU-proven coarse Tree slots',
  );
  assert.equal(
    scanAfterUnchangedReceipt.canonicalCoarseTreeSlotScanEarlyOutCount,
    scanAfterProof.canonicalCoarseTreeSlotScanEarlyOutCount + 1,
  );
});

test('prewarmed Forest receipt cache re-evaluates player uniforms without a full slot rescan', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const terrain = createDrawable().mesh;
  markTerrain(terrain, 'high');
  terrain.userData.visibleOwnerKeys = ['approach-owner'];
  const forest = createDrawable().mesh;
  forest.count = 1;
  forest.instanceMatrix = createAttribute(identityMatrices(1), 16);
  forest.geometry.attributes.w8NaturalAnchorXZ = createAttribute([100, 0], 2);
  forest.geometry.attributes.w8NaturalInitialReveal = createAttribute([1]);
  forest.userData = {
    canonicalObjects: [{ stableId: 'tree:approach', owner: 'approach-owner', objectType: 'tree' }],
    canonicalOpacities: [1],
    canonicalCoarseTreeSubmission: true,
    canonicalVisualRevision: 1,
  };
  const uniforms = {
    w8NaturalPlayerLocalXZ: { value: { x: 0, y: 0 } },
    w8NaturalUnitsPerMeter: { value: 1 },
    w8NaturalEnterStart: { value: -1 },
    w8NaturalEnterEnd: { value: 0 },
    w8NaturalExitStart: { value: 40 },
    w8NaturalExitEnd: { value: 50 },
    w8NaturalReveal: { value: 1 },
  };
  forest.material.userData = {
    naturalLodMode: 'far',
    naturalLodKind: 'tree',
    canonicalCoarseTree: true,
    naturalLodUniforms: uniforms,
  };
  const scene = { children: [terrain, forest] };
  terrain.parent = scene;
  forest.parent = scene;
  registry.expect({ ownerKey: 'approach-owner', expectedAt: 0 });
  registry.resolveCoarseRequirements({
    ownerKey: 'approach-owner',
    structureStableIds: [],
    forestStableIds: ['tree:approach'],
  });
  const draw = frameSequence => {
    const token = frames.beginFrame({ frameSequence });
    now = frameSequence;
    const receipt = frames.completeFrame(token, { scene });
    registry.acknowledgeScene({
      receipt, scene, terrainCoverage: { ownerKeys: ['approach-owner'] },
    });
  };

  draw(1);
  assert.deepEqual(registry.get('approach-owner').drawnForestStableIds, []);
  const beforeApproach = registry.snapshot().receiptScanMetrics;
  uniforms.w8NaturalPlayerLocalXZ.value.x = 60;
  draw(2);
  const approached = registry.get('approach-owner');
  assert.deepEqual(approached.drawnForestStableIds, ['tree:approach']);
  assert.equal(approached.coarseDrawableAt, 2);
  const afterApproach = registry.snapshot().receiptScanMetrics;
  assert.equal(afterApproach.canonicalCoarseTreeSlotScanCount,
    beforeApproach.canonicalCoarseTreeSlotScanCount,
  'uniform-only approach must inspect cached required slots, not rescan canonical Trees');
  assert.equal(afterApproach.canonicalCoarseTreeSlotScanEarlyOutCount,
    beforeApproach.canonicalCoarseTreeSlotScanEarlyOutCount + 1);
});

test('Structure handoff opacity must be renderer-uploaded before it proves coarse existence', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const terrain = createDrawable().mesh;
  markTerrain(terrain, 'high');
  terrain.userData.visibleOwnerKeys = ['handoff-owner'];
  const structure = createDrawable().mesh;
  structure.count = 1;
  structure.instanceMatrix = createAttribute(identityMatrices(1), 16);
  const handoffOpacity = createAttribute([0]);
  structure.geometry.attributes.w8LocalHandoffOpacity = handoffOpacity;
  structure.userData = {
    canonicalObjects: [{
      stableId: 'building:handoff', owner: 'handoff-owner', objectType: 'building',
    }],
    canonicalOpacities: [1],
  };
  const scene = { children: [terrain, structure] };
  terrain.parent = scene;
  structure.parent = scene;
  registry.expect({ ownerKey: 'handoff-owner', expectedAt: 0 });
  registry.resolveCoarseRequirements({
    ownerKey: 'handoff-owner',
    structureStableIds: ['building:handoff'],
    forestStableIds: [],
  });

  const draw = frameSequence => {
    const token = frames.beginFrame({ frameSequence });
    now = frameSequence;
    const receipt = frames.completeFrame(token, { scene });
    registry.acknowledgeScene({
      receipt, scene, terrainCoverage: { ownerKeys: ['handoff-owner'] },
    });
  };
  draw(1);
  assert.deepEqual(registry.get('handoff-owner').drawnStructureStableIds, [],
    'diagnostic canonical opacity cannot override zero GPU handoff opacity');

  handoffOpacity.array[0] = 1;
  draw(2);
  assert.deepEqual(registry.get('handoff-owner').drawnStructureStableIds, [],
    'a CPU mutation without an attribute upload is not renderer evidence');

  handoffOpacity.addUpdateRange(0, 1);
  handoffOpacity.needsUpdate = true;
  draw(3);
  const owner = registry.get('handoff-owner');
  assert.deepEqual(owner.drawnStructureStableIds, ['building:handoff']);
  assert.equal(owner.coarseDrawableAt, 3);
  assert.deepEqual(owner.structureComponentDraws, [{
    stableId: 'building:handoff',
    actualDrawableAt: 3,
    gpuUploadedAt: 3,
    rendererFrameSequence: 3,
  }]);
});

test('authoritative destruction excludes declared IDs without forging a drawable receipt', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const terrain = createDrawable();
  markTerrain(terrain.mesh, 'high');
  registry.expect({ ownerKey: 'destroyed-owner', expectedAt: 0 });
  registry.resolveCoarseRequirements({
    ownerKey: 'destroyed-owner',
    structureStableIds: ['building:destroyed'],
    forestStableIds: ['tree:destroyed'],
  });
  const token = frames.beginFrame({ frameSequence: 1 });
  now = 1;
  const receipt = frames.completeFrame(token, { scene: terrain.scene });
  assert.equal(registry.acknowledgeCoarseComponent({
    ownerKey: 'destroyed-owner', component: 'terrain', receipt,
    drawable: { mesh: terrain.mesh },
  }), true);
  assert.equal(registry.get('destroyed-owner').state, VISUAL_CONTINUITY_STATE.EXPECTED);

  now = 2;
  registry.excludeDestroyedStableIds({
    ownerKey: 'destroyed-owner', stableIds: ['building:destroyed'],
  });
  assert.equal(registry.get('destroyed-owner').state, VISUAL_CONTINUITY_STATE.EXPECTED);
  now = 3;
  const owner = registry.excludeDestroyedStableIds({
    ownerKey: 'destroyed-owner', stableIds: ['tree:destroyed'],
  });
  assert.equal(owner.state, VISUAL_CONTINUITY_STATE.COARSE_DRAWABLE);
  assert.equal(owner.coarseDrawableAt, 3,
    'exclusion time, not the older Terrain draw, gates completion');
  assert.deepEqual(owner.requiredStructureStableIds, []);
  assert.deepEqual(owner.requiredForestStableIds, []);
  assert.deepEqual(owner.destroyedStableIdsExcludedFromCoarse, [
    'building:destroyed',
    'tree:destroyed',
  ]);
  assert.deepEqual(owner.destroyedRequirementExclusions, [
    { stableId: 'building:destroyed', excludedAt: 2 },
    { stableId: 'tree:destroyed', excludedAt: 3 },
  ]);
  assert.deepEqual(owner.canonicalStableIds, [
    'building:destroyed',
    'tree:destroyed',
  ], 'destruction removes a requirement, not its canonical identity');
  assert.deepEqual(owner.drawnStructureStableIds, []);
  assert.deepEqual(owner.drawnForestStableIds, []);

  registry.clear();
  registry.expect({ ownerKey: 'destroyed-owner', expectedAt: 4 });
  const restored = registry.resolveCoarseRequirements({
    ownerKey: 'destroyed-owner',
    structureStableIds: ['building:destroyed'],
    forestStableIds: ['tree:destroyed'],
    at: 4,
  });
  assert.equal(restored.state, VISUAL_CONTINUITY_STATE.EXPECTED);
  assert.deepEqual(restored.requiredStructureStableIds, ['building:destroyed']);
  assert.deepEqual(restored.requiredForestStableIds, ['tree:destroyed']);
  assert.deepEqual(restored.destroyedStableIdsExcludedFromCoarse, [],
    'a replacement gameplay state rebuilds requirements for restored identities');
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
  registry.resolveCoarseRequirements({
    ownerKey: '4,5',
    summary: { structureStableIds: [], forestStableIds: [] },
  });

  const token = frames.beginFrame({ frameSequence: 1 });
  now = 8;
  const receipt = frames.completeFrame(token, { scene: drawable.scene });
  assert.equal(registry.acknowledgeScene({ receipt, scene: drawable.scene }), 1);

  const owner = registry.get('4,5');
  assert.equal(owner.nearRepresentationAvailableAt, 8);
  assert.equal(owner.pendingDetailDrawableAt, 8);
  assert.equal(owner.detailDrawableAt, null);
  assert.equal(owner.state, VISUAL_CONTINUITY_STATE.EXPECTED);
  assert.deepEqual(owner.canonicalStableIds, ['natural:shared-stable-id']);

  const terrain = createDrawable();
  markTerrain(terrain.mesh, 'high');
  const terrainToken = frames.beginFrame({ frameSequence: 2 });
  now = 9;
  const terrainReceipt = frames.completeFrame(terrainToken, { scene: terrain.scene });
  assert.equal(registry.acknowledgeCoarseComponent({
    ownerKey: '4,5',
    component: 'terrain',
    receipt: terrainReceipt,
    drawable: { mesh: terrain.mesh },
  }), true);
  const completed = registry.get('4,5');
  assert.equal(completed.coarseDrawableAt, 9);
  assert.equal(completed.detailDrawableAt, 9);
  assert.equal(completed.state, VISUAL_CONTINUITY_STATE.DETAIL_DRAWABLE);
});

test('completed Near Building and Road slots satisfy their declared Structure IDs', () => {
  let now = 0;
  const gpuMirror = createGpuAttributeMirror();
  const frames = createRenderFrameAcknowledger({ clock: () => now, gpuMirror });
  const registry = createVisualContinuityRegistry({ clock: () => now });
  const detail = createDrawable();
  detail.mesh.count = 2;
  detail.mesh.instanceMatrix = createAttribute(identityMatrices(2), 16);
  detail.mesh.userData = {
    featureStableIds: ['building:near', 'road:near'],
    treeStableIds: [],
  };
  const ownerGroup = {
    visible: true,
    userData: { chunkKey: '6,7' },
    children: [detail.mesh],
    parent: detail.scene,
  };
  detail.scene.children = [ownerGroup];
  detail.mesh.parent = ownerGroup;
  const terrain = createDrawable().mesh;
  markTerrain(terrain, 'high');
  terrain.userData.visibleOwnerKeys = ['6,7'];
  terrain.parent = detail.scene;
  detail.scene.children.push(terrain);
  registry.expect({ ownerKey: '6,7', expectedAt: 0 });
  registry.resolveCoarseRequirements({
    ownerKey: '6,7',
    structureStableIds: ['building:near', 'road:near'],
    forestStableIds: [],
  });

  detail.mesh.material.opacity = 0;
  let token = frames.beginFrame({ frameSequence: 1 });
  now = 1;
  let receipt = frames.completeFrame(token, { scene: detail.scene });
  registry.acknowledgeScene({
    receipt, scene: detail.scene, terrainCoverage: { ownerKeys: ['6,7'] },
  });
  assert.deepEqual(registry.get('6,7').drawnStructureStableIds, []);

  detail.mesh.material.opacity = 1;
  token = frames.beginFrame({ frameSequence: 2 });
  now = 2;
  receipt = frames.completeFrame(token, { scene: detail.scene });
  assert.equal(registry.acknowledgeScene({
    receipt, scene: detail.scene, terrainCoverage: { ownerKeys: ['6,7'] },
  }), 4, 'two Structure components, detail, and Terrain are receipt-proven');
  const owner = registry.get('6,7');
  assert.deepEqual(owner.drawnStructureStableIds, ['building:near', 'road:near']);
  assert.equal(owner.coarseDrawableAt, 2);
  assert.equal(owner.detailDrawableAt, 2);
  assert.equal(owner.state, VISUAL_CONTINUITY_STATE.DETAIL_DRAWABLE);
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
  registry.resolveCoarseRequirements({
    ownerKey: 'road:0,0', structureStableIds: [], forestStableIds: [],
  });
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
  }), false, 'a pending detail receipt cannot release coarse before aggregate coarse exists');
  assert.deepEqual(disposed, []);
  assert.equal(barrier.snapshot().retainedOwnerCount, 1);
  assert.equal(registry.acknowledgeCoarseComponent({
    ownerKey: 'road:0,0',
    component: 'terrain',
    receipt,
    drawable: { mesh: drawable.mesh },
  }), true);
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
