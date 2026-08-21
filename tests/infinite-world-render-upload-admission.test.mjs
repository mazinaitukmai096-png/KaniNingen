import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProjectedUploadManifest,
  createRenderUploadAdmissionController,
  createThreeProjectedUploadStager,
} from '../src/infinite-world/render-upload-admission.js';
import { createRenderFrameAcknowledger } from '../src/infinite-world/visual-continuity.js';

function drawable({ name, attributeBytes = 0, indexValues = null, instanceBytes = 0 } = {}) {
  const attributes = attributeBytes > 0
    ? { position: { array: new Uint8Array(attributeBytes) } } : {};
  return {
    name,
    geometry: {
      attributes,
      index: indexValues ? { array: indexValues } : null,
    },
    material: { type: 'TestMaterial' },
    instanceMatrix: instanceBytes > 0 ? { array: new Uint8Array(instanceBytes) } : null,
    children: [],
  };
}

function rootWith(...children) {
  return { children };
}

function receiptFactory() {
  let now = 0;
  const frames = createRenderFrameAcknowledger({ clock: () => ++now });
  let frameSequence = 0;
  return () => {
    const token = frames.beginFrame({ frameSequence: ++frameSequence });
    return frames.completeFrame(token);
  };
}

async function flushAdmission() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('ProjectedUploadManifest is immutable and counts unique geometry, index, and instance bytes', () => {
  const sharedGeometry = {
    attributes: {
      position: { array: new Float32Array(12) },
      color: { array: new Uint8Array(16) },
    },
    index: { array: [0, 1, 2, 2, 3, 0] },
  };
  const first = drawable({ name: 'first', instanceBytes: 64 });
  const second = drawable({ name: 'second', instanceBytes: 128 });
  first.geometry = sharedGeometry;
  second.geometry = sharedGeometry;
  const manifest = createProjectedUploadManifest({
    ownerKey: '1,2',
    generation: 7,
    root: rootWith(first, second),
    budgetBytes: 128,
  });

  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.resourceBuckets), true);
  assert.equal(manifest.meshCount, 2);
  assert.equal(manifest.geometryCount, 1);
  assert.equal(manifest.attributeBytes, 64);
  assert.equal(manifest.indexBytes, 12);
  assert.equal(manifest.instanceBytes, 192);
  assert.equal(manifest.uploadBytes, 268);
  assert.equal(manifest.uploadTargetCount, 5);
  assert.equal(Object.isFrozen(manifest.uploadTargets), true);
  assert.ok(manifest.uploadTargets.every(Object.isFrozen));
  assert.equal(manifest.uploadTargets.reduce((sum, target) => sum + target.byteLength, 0),
    manifest.uploadBytes);
  assert.equal(manifest.oversized, true);
  assert.ok(manifest.resourceBuckets.length >= 2);
  assert.ok(manifest.resourceBuckets.every(Object.isFrozen));
  assert.deepEqual(manifest.programKeys, ['TestMaterial']);

  const sharedReferenceManifest = createProjectedUploadManifest({
    ownerKey: '1,2',
    generation: 8,
    root: rootWith(first, second),
    ownedGeometries: [],
    budgetBytes: 256,
  });
  assert.equal(sharedReferenceManifest.ownedGeometryCount, 0);
  assert.equal(sharedReferenceManifest.referencedSharedGeometryCount, 1);
  assert.equal(sharedReferenceManifest.attributeBytes, 0);
  assert.equal(sharedReferenceManifest.indexBytes, 0);
  assert.equal(sharedReferenceManifest.instanceBytes, 192);
  assert.equal(sharedReferenceManifest.uploadBytes, 192,
    'admission counts owner instance buffers but not already-resident shared geometry');
  assert.equal(sharedReferenceManifest.referencedSharedBytes, 76);
});

test('admission publishes at most one ordinary owner per completed render receipt', async () => {
  const admission = createRenderUploadAdmissionController({ budgetBytes: 100 });
  const receipt = receiptFactory();
  const published = [];
  const requests = ['0,0', '1,0', '2,0'].map((ownerKey, generation) => {
    const manifest = createProjectedUploadManifest({
      ownerKey,
      generation,
      root: rootWith(drawable({ name: ownerKey, instanceBytes: 80 })),
      budgetBytes: 100,
    });
    return admission.admit({
      ownerKey,
      generation,
      manifest,
      stageBucket() {},
      publish: () => { published.push(ownerKey); },
      receiptProvesPublication: () => true,
    });
  });
  await flushAdmission();
  assert.deepEqual(published, ['0,0']);

  assert.equal(admission.acknowledgeRenderReceipt(receipt()), true);
  await flushAdmission();
  assert.deepEqual(published, ['0,0', '1,0']);

  assert.equal(admission.acknowledgeRenderReceipt(receipt()), true);
  await flushAdmission();
  assert.deepEqual(published, ['0,0', '1,0', '2,0']);
  assert.equal(admission.acknowledgeRenderReceipt(receipt()), true);
  await flushAdmission();
  await Promise.all(requests);
  const snapshot = admission.snapshot();
  assert.equal(snapshot.counts.published, 3);
  assert.equal(snapshot.counts.stagedBuckets, 3,
    'ordinary owners pre-upload their complete resource bucket before publication');
  assert.equal(snapshot.counts.maximumFrameBytes, 80);
  assert.equal(snapshot.queueDepth, 0);
  admission.shutdown();
});

test('oversized owner stages bounded resource buckets across receipts and publishes atomically', async () => {
  const admission = createRenderUploadAdmissionController({ budgetBytes: 100 });
  const receipt = receiptFactory();
  const manifest = createProjectedUploadManifest({
    ownerKey: '8,9',
    generation: 4,
    root: rootWith(
      drawable({ name: 'terrain', instanceBytes: 80 }),
      drawable({ name: 'buildings', instanceBytes: 80 }),
      drawable({ name: 'roads', instanceBytes: 80 }),
    ),
    budgetBytes: 100,
  });
  const staged = [];
  const published = [];
  const completed = admission.admit({
    ownerKey: '8,9',
    generation: 4,
    manifest,
    stageBucket: ({ bucket }) => { staged.push(bucket.bucketIndex); },
    publish: ({ stagedBytes }) => { published.push(stagedBytes); },
    receiptProvesPublication: () => true,
  });

  await flushAdmission();
  assert.deepEqual(staged, [0]);
  assert.deepEqual(published, [], 'partial staged resources must never publish the owner');
  admission.acknowledgeRenderReceipt(receipt());
  await flushAdmission();
  assert.deepEqual(staged, [0, 1]);
  assert.deepEqual(published, []);
  admission.acknowledgeRenderReceipt(receipt());
  await flushAdmission();
  assert.deepEqual(staged, [0, 1, 2]);
  assert.deepEqual(published, [240]);
  admission.acknowledgeRenderReceipt(receipt());
  await flushAdmission();
  const result = await completed;
  assert.equal(result.staged, true);
  assert.equal(result.ownerKey, '8,9');
  const snapshot = admission.snapshot();
  assert.equal(snapshot.counts.stagedBuckets, 3);
  assert.equal(snapshot.counts.oversizedOwners, 1);
  assert.equal(snapshot.counts.maximumFrameBytes, 80);
  admission.shutdown();
});

test('one indivisible oversized resource is rejected before staging while the next owner progresses', async () => {
  const admission = createRenderUploadAdmissionController({ budgetBytes: 100 });
  const overBudgetManifest = createProjectedUploadManifest({
    ownerKey: '11,12',
    root: rootWith(drawable({ name: 'large-terrain', attributeBytes: 160 })),
    budgetBytes: 100,
  });
  const normalManifest = createProjectedUploadManifest({
    ownerKey: '12,12',
    generation: 1,
    root: rootWith(drawable({ name: 'bounded-owner', instanceBytes: 80 })),
    budgetBytes: 100,
  });
  let overBudgetStaged = 0;
  let overBudgetPublished = 0;
  let normalStaged = 0;
  let normalPublished = 0;
  const rejected = assert.rejects(admission.admit({
    ownerKey: '11,12',
    manifest: overBudgetManifest,
    stageBucket: () => { overBudgetStaged += 1; },
    publish: () => { overBudgetPublished += 1; },
    receiptProvesPublication: () => true,
  }), /upload resource exceeds per-frame budget: 11,12:0:160:100/);
  const completed = admission.admit({
    ownerKey: '12,12',
    generation: 1,
    manifest: normalManifest,
    stageBucket: () => { normalStaged += 1; },
    publish: () => { normalPublished += 1; },
    receiptProvesPublication: () => true,
  });
  await flushAdmission();
  await rejected;
  assert.equal(overBudgetStaged, 0);
  assert.equal(overBudgetPublished, 0);
  assert.equal(normalStaged, 1);
  assert.equal(normalPublished, 1);
  admission.acknowledgeRenderReceipt(receiptFactory()());
  await completed;
  const snapshot = admission.snapshot();
  assert.equal(snapshot.counts.overBudgetManifestRejects, 1);
  assert.equal(snapshot.counts.requested, 1,
    'the invalid owner is rejected before queue/accounting mutation');
  assert.equal(snapshot.counts.oversizedBuckets, 0);
  assert.equal(snapshot.counts.maximumFrameBytes, 80);
  assert.equal(snapshot.counts.maximumFrameBytes <= snapshot.budgetBytes, true);
  assert.equal(snapshot.queueDepth, 0);
  admission.shutdown();
});

test('staging failure rejects only the failed owner and leaves no phantom publication', async () => {
  const admission = createRenderUploadAdmissionController({ budgetBytes: 100 });
  const manifest = createProjectedUploadManifest({
    ownerKey: '13,14',
    root: rootWith(
      drawable({ name: 'first', instanceBytes: 80 }),
      drawable({ name: 'second', instanceBytes: 80 }),
    ),
    budgetBytes: 100,
  });
  let published = false;
  await assert.rejects(admission.admit({
    ownerKey: '13,14',
    manifest,
    stageBucket: () => { throw new Error('injected staging failure'); },
    publish: () => { published = true; },
    receiptProvesPublication: () => true,
  }), /injected staging failure/);
  assert.equal(published, false);
  assert.equal(admission.snapshot().queueDepth, 0);
  assert.equal(admission.snapshot().counts.failures, 1);
  admission.shutdown();
});

test('admission rejects a manifest from another generation before queue mutation', async () => {
  const admission = createRenderUploadAdmissionController({ budgetBytes: 100 });
  const manifest = createProjectedUploadManifest({
    ownerKey: '21,22',
    generation: 3,
    root: rootWith(drawable({ name: 'generation-three', instanceBytes: 80 })),
    budgetBytes: 100,
  });

  await assert.rejects(Promise.resolve().then(() => admission.admit({
    ownerKey: '21,22',
    generation: 4,
    manifest,
    publish() {},
    receiptProvesPublication: () => true,
  })), /manifest generation mismatch: 21,22:4:3/);
  assert.equal(admission.snapshot().queueDepth, 0);
  assert.equal(admission.snapshot().counts.requested, 0);
  admission.shutdown();
});

test('admission rejects forged per-bucket byte accounting before queue mutation', () => {
  const admission = createRenderUploadAdmissionController({ budgetBytes: 200 });
  const source = createProjectedUploadManifest({
    ownerKey: '22,23',
    generation: 4,
    root: rootWith(
      drawable({ name: 'accounting-a', attributeBytes: 80 }),
      drawable({ name: 'accounting-b', attributeBytes: 80 }),
    ),
    budgetBytes: 100,
  });
  const forgedBuckets = Object.freeze(source.resourceBuckets.map((bucket, index) => Object.freeze({
    ...bucket,
    byteLength: index === 0 ? 60 : 100,
  })));
  const forged = Object.freeze({ ...source, resourceBuckets: forgedBuckets });
  assert.throws(() => admission.admit({
    ownerKey: '22,23',
    generation: 4,
    manifest: forged,
    stageBucket() {},
    publish() {},
    receiptProvesPublication: () => true,
  }), /resource bucket target accounting mismatch: 22,23:0/);
  assert.equal(admission.snapshot().queueDepth, 0);
  assert.equal(admission.snapshot().counts.requested, 0);
  admission.shutdown();
});

test('opaque completed receipts cannot acknowledge a publication without owner resource proof', async () => {
  const admission = createRenderUploadAdmissionController({ budgetBytes: 100 });
  const receipt = receiptFactory();
  const manifest = createProjectedUploadManifest({
    ownerKey: '23,24',
    generation: 5,
    root: rootWith(drawable({ name: 'proof-required', instanceBytes: 80 })),
    budgetBytes: 100,
  });
  const provenReceipts = new WeakSet();
  let settled = false;
  const completed = admission.admit({
    ownerKey: '23,24',
    generation: 5,
    manifest,
    stageBucket() {},
    publish() {},
    receiptProvesPublication: candidate => provenReceipts.has(candidate),
  }).finally(() => { settled = true; });
  await flushAdmission();

  const unproven = receipt();
  assert.equal(admission.acknowledgeRenderReceipt(unproven), false);
  await flushAdmission();
  assert.equal(settled, false);
  assert.equal(admission.snapshot().pendingPublicationOwnerKey, '23,24');

  const proven = receipt();
  provenReceipts.add(proven);
  assert.equal(admission.acknowledgeRenderReceipt(proven), true);
  const result = await completed;
  assert.equal(result.uploadCompleteReceipt, proven);
  assert.equal(admission.snapshot().counts.unprovenPublicationReceipts, 1);
  admission.shutdown();
});

test('cancel during asynchronous staging never publishes or mutates counters after cancellation', async () => {
  const admission = createRenderUploadAdmissionController({ budgetBytes: 100 });
  const manifest = createProjectedUploadManifest({
    ownerKey: '25,26',
    generation: 6,
    root: rootWith(
      drawable({ name: 'async-staging-a', attributeBytes: 80 }),
      drawable({ name: 'async-staging-b', attributeBytes: 80 }),
    ),
    budgetBytes: 100,
  });
  let releaseStage;
  const stageGate = new Promise(resolve => { releaseStage = resolve; });
  let publishCount = 0;
  const completed = admission.admit({
    ownerKey: '25,26',
    generation: 6,
    manifest,
    stageBucket: async () => stageGate,
    publish: () => { publishCount += 1; },
    receiptProvesPublication: () => true,
  });
  await flushAdmission();
  assert.equal(admission.cancel({ ownerKey: '25,26', generation: 6 }), 1);
  releaseStage();
  await assert.rejects(completed, /render upload admission cancelled: 25,26:6/);
  await flushAdmission();
  const snapshot = admission.snapshot();
  assert.equal(publishCount, 0);
  assert.equal(snapshot.queueDepth, 0);
  assert.equal(snapshot.awaitingReceipt, false);
  assert.equal(snapshot.pendingPublicationOwnerKey, null);
  assert.equal(snapshot.counts.stagedBuckets, 0);
  assert.equal(snapshot.counts.published, 0);
  admission.shutdown();
});

test('shutdown during asynchronous staging cannot resurrect publication state', async () => {
  const admission = createRenderUploadAdmissionController({ budgetBytes: 100 });
  const manifest = createProjectedUploadManifest({
    ownerKey: '27,28',
    generation: 7,
    root: rootWith(
      drawable({ name: 'async-shutdown-a', attributeBytes: 80 }),
      drawable({ name: 'async-shutdown-b', attributeBytes: 80 }),
    ),
    budgetBytes: 100,
  });
  let releaseStage;
  const stageGate = new Promise(resolve => { releaseStage = resolve; });
  let publishCount = 0;
  const completed = admission.admit({
    ownerKey: '27,28',
    generation: 7,
    manifest,
    stageBucket: async () => stageGate,
    publish: () => { publishCount += 1; },
    receiptProvesPublication: () => true,
  });
  await flushAdmission();
  let settled = false;
  void completed.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  assert.equal(admission.shutdown(), true);
  await flushAdmission();
  assert.equal(settled, false,
    'shutdown waits for the active stage callback to reach its cancellation checkpoint');
  releaseStage();
  await assert.rejects(completed, /render upload admission shut down/);
  await flushAdmission();
  const snapshot = admission.snapshot();
  assert.equal(publishCount, 0);
  assert.equal(snapshot.queueDepth, 0);
  assert.equal(snapshot.awaitingReceipt, false);
  assert.equal(snapshot.pendingPublicationOwnerKey, null);
  assert.equal(snapshot.counts.stagedBuckets, 0);
  assert.equal(snapshot.counts.published, 0);
});

test('shutdown waits for an active asynchronous publish before rejecting its transaction', async () => {
  const admission = createRenderUploadAdmissionController({ budgetBytes: 100 });
  const manifest = createProjectedUploadManifest({
    ownerKey: '28,29',
    generation: 71,
    root: rootWith(drawable({ name: 'async-publish-shutdown', attributeBytes: 80 })),
    budgetBytes: 100,
  });
  let publishStartedResolve;
  let releasePublish;
  const publishStarted = new Promise(resolve => { publishStartedResolve = resolve; });
  const publishGate = new Promise(resolve => { releasePublish = resolve; });
  let publishCompleted = false;
  const completed = admission.admit({
    ownerKey: '28,29',
    generation: 71,
    manifest,
    stageBucket() {},
    async publish() {
      publishStartedResolve();
      await publishGate;
      publishCompleted = true;
    },
    receiptProvesPublication: () => true,
  });
  await publishStarted;
  let settled = false;
  void completed.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  assert.equal(admission.shutdown(), true);
  await flushAdmission();
  assert.equal(settled, false,
    'runtime rollback cannot start while the active publish callback can still mutate state');
  releasePublish();
  await assert.rejects(completed, /render upload admission shut down/);
  assert.equal(publishCompleted, true);
  const snapshot = admission.snapshot();
  assert.equal(snapshot.queueDepth, 0);
  assert.equal(snapshot.pendingPublicationOwnerKey, null);
  assert.equal(snapshot.counts.published, 0,
    'a post-publish shutdown checkpoint prevents receipt state from being manufactured');
});

test('cancel while publication awaits its owner receipt rejects immediately and does not accept a later draw', async () => {
  const admission = createRenderUploadAdmissionController({ budgetBytes: 100 });
  const manifest = createProjectedUploadManifest({
    ownerKey: '29,30',
    generation: 8,
    root: rootWith(drawable({ name: 'receipt-cancel', instanceBytes: 80 })),
    budgetBytes: 100,
  });
  let published = 0;
  const completed = admission.admit({
    ownerKey: '29,30',
    generation: 8,
    manifest,
    stageBucket() {},
    publish: () => { published += 1; },
    receiptProvesPublication: () => true,
  });
  await flushAdmission();
  assert.equal(admission.snapshot().pendingPublicationOwnerKey, '29,30');
  assert.equal(admission.cancel({ ownerKey: '29,30', generation: 8 }), 1);
  await assert.rejects(completed, /render upload admission cancelled: 29,30:8/);
  assert.equal(published, 1, 'the runtime transaction owns rollback after publication');
  const receipt = receiptFactory()();
  assert.equal(admission.acknowledgeRenderReceipt(receipt), false);
  assert.equal(admission.snapshot().pendingPublicationOwnerKey, null);
  assert.equal(admission.snapshot().awaitingReceipt, false);
  admission.shutdown();
});

test('Three upload stager renders only the selected detached bucket and restores all state', () => {
  class Node {
    constructor() {
      this.children = [];
      this.parent = null;
      this.visible = true;
      this.frustumCulled = true;
      this.position = { set() {} };
    }

    add(child) {
      child.parent?.remove?.(child);
      this.children.push(child);
      child.parent = this;
    }

    remove(child) {
      this.children = this.children.filter(candidate => candidate !== child);
      if (child.parent === this) child.parent = null;
    }

    clear() {
      for (const child of [...this.children]) this.remove(child);
    }

    traverse(visitor) {
      visitor(this);
      for (const child of this.children) child.traverse(visitor);
    }
  }
  class Scene extends Node {
    constructor() {
      super();
      this.isScene = true;
    }
  }
  class OrthographicCamera extends Node {
    constructor() {
      super();
      this.layers = { mask: 1 };
    }
  }
  class WebGLRenderTarget {
    constructor() {
      this.texture = {};
      this.disposed = false;
    }

    dispose() { this.disposed = true; }
  }
  const rendered = [];
  const worldTarget = { name: 'world-target' };
  const renderer = {
    xr: { enabled: true },
    target: worldTarget,
    getRenderTarget() { return this.target; },
    getActiveCubeFace() { return 2; },
    getActiveMipmapLevel() { return 3; },
    setRenderTarget(target, face = 0, level = 0) {
      this.target = target;
      this.face = face;
      this.level = level;
    },
    render(scene) {
      rendered.push(scene.children[0].children.map(child => child.visible));
      assert.equal(this.xr.enabled, false);
    },
  };
  const root = new Node();
  const first = new Node();
  first.geometry = { attributes: { position: { array: new Uint8Array(80) } } };
  first.visible = false;
  const second = new Node();
  second.geometry = { attributes: { position: { array: new Uint8Array(80) } } };
  second.visible = true;
  root.add(first);
  root.add(second);
  const manifest = createProjectedUploadManifest({
    ownerKey: '4,5',
    root,
    budgetBytes: 100,
  });
  const projected = { key: '4,5', group: root, uploadManifest: manifest };
  const stager = createThreeProjectedUploadStager({
    THREE: { Scene, OrthographicCamera, WebGLRenderTarget },
    renderer,
  });
  const result = stager.stage({
    projected,
    manifest,
    bucket: manifest.resourceBuckets[0],
  });

  assert.deepEqual(rendered, [[true, false]]);
  assert.equal(root.parent, null);
  assert.equal(first.visible, false);
  assert.equal(first.frustumCulled, true);
  assert.equal(second.visible, true);
  assert.equal(renderer.target, worldTarget);
  assert.equal(renderer.face, 2);
  assert.equal(renderer.level, 3);
  assert.equal(renderer.xr.enabled, true);
  assert.deepEqual(result, {
    ownerKey: '4,5', generation: 0, bucketIndex: 0, byteLength: 80, drawableCount: 1,
  });
  assert.equal(projected.uploadStagingProof.manifest, manifest);
  assert.deepEqual([...projected.uploadStagingProof.bucketIndices], [0]);
  assert.equal(stager.snapshot().stagedBuckets, 1);
  assert.equal(stager.dispose(), true);
  assert.equal(stager.dispose(), false);
});
