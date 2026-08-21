import { isCompletedRenderFrameReceipt } from './visual-continuity.js';

export const DEFAULT_STREAMING_UPLOAD_BUDGET_BYTES = 512 * 1024;
export const DEFAULT_STREAMING_OWNER_ADMISSION_LIMIT = 1;

function finiteNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireOwnerKey(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('upload ownerKey must be a non-empty string');
  }
  return value;
}

function attributeArray(attribute) {
  if (ArrayBuffer.isView(attribute) || Array.isArray(attribute)) return attribute;
  const values = attribute?.array ?? attribute?.values ?? null;
  return ArrayBuffer.isView(values) || Array.isArray(values) ? values : null;
}

function attributeVersion(attribute) {
  return Number.isSafeInteger(attribute?.version) && attribute.version >= 0
    ? attribute.version : 0;
}

function installRendererUploadProbe(attribute, onUpload) {
  if (!attribute || typeof onUpload !== 'function') return null;
  const previous = typeof attribute.onUploadCallback === 'function'
    ? attribute.onUploadCallback : null;
  const callback = function projectedUploadStagingProbe(...args) {
    onUpload(attributeVersion(attribute));
    return previous?.apply(this, args);
  };
  try {
    if (typeof attribute.onUpload === 'function') attribute.onUpload(callback);
    else {
      if (!Object.isExtensible(attribute)) return null;
      attribute.onUploadCallback = callback;
    }
  } catch {
    return null;
  }
  return () => {
    if (attribute.onUploadCallback !== callback) return;
    if (typeof attribute.onUpload === 'function') {
      attribute.onUpload(previous ?? function noProjectedUploadStagingCallback() {});
    } else attribute.onUploadCallback = previous ?? function noProjectedUploadStagingCallback() {};
  };
}

function estimatedArrayBytes(values, { index = false } = {}) {
  if (!values) return 0;
  if (ArrayBuffer.isView(values)) return values.byteLength;
  if (!Array.isArray(values)) return 0;
  if (!index) return values.length * 4;
  let maximum = 0;
  for (const value of values) {
    if (Number.isFinite(value)) maximum = Math.max(maximum, value);
  }
  return values.length * (maximum <= 0xffff ? 2 : 4);
}

function materialIdentity(material, fallbackIndex) {
  if (!material) return `material:${fallbackIndex}:none`;
  let programKey = null;
  try {
    programKey = typeof material.customProgramCacheKey === 'function'
      ? material.customProgramCacheKey() : null;
  } catch {
    programKey = null;
  }
  return String(programKey
    ?? material.uuid
    ?? material.type
    ?? material.name
    ?? material.constructor?.name
    ?? `material:${fallbackIndex}`);
}

function visitDrawables(root, visitor) {
  if (!root) return;
  if (root.geometry || root.material || root.instanceMatrix || root.instanceColor) visitor(root);
  for (const child of root.children ?? []) visitDrawables(child, visitor);
}

export function projectedUploadDrawableObjects(root) {
  const drawables = [];
  visitDrawables(root, drawable => drawables.push(drawable));
  return Object.freeze(drawables);
}

function freezeBucket({
  bucketIndex,
  byteLength,
  drawableIndices,
  meshNames,
  resourceKeys,
  oversized,
}) {
  return Object.freeze({
    bucketIndex,
    byteLength,
    drawableCount: drawableIndices.length,
    drawableIndices: Object.freeze([...drawableIndices]),
    meshNames: Object.freeze([...meshNames]),
    resourceKeys: Object.freeze([...resourceKeys]),
    oversized,
  });
}

/**
 * Describes the resources that can be uploaded by the first draw of one staged
 * Near owner. The manifest contains metadata only; canonical records and scene
 * ownership stay on the projected owner.
 */
export function createProjectedUploadManifest({
  ownerKey,
  generation = 0,
  root,
  ownedGeometries = null,
  residentResourceProofs = [],
  budgetBytes = DEFAULT_STREAMING_UPLOAD_BUDGET_BYTES,
} = {}) {
  requireOwnerKey(ownerKey);
  finiteNonNegativeInteger(generation, 'upload generation');
  positiveInteger(budgetBytes, 'upload budgetBytes');
  if (!root) throw new TypeError('projected upload root is required');
  if (ownedGeometries !== null && typeof ownedGeometries?.[Symbol.iterator] !== 'function') {
    throw new TypeError('ownedGeometries must be an iterable when provided');
  }
  if (!Array.isArray(residentResourceProofs)) {
    throw new TypeError('residentResourceProofs must be an array');
  }
  const frozenResidentResourceProofs = Object.freeze(residentResourceProofs.map(proof => {
    if (!proof || typeof proof !== 'object'
      || typeof proof.ownerKey !== 'string' || !proof.ownerKey
      || typeof proof.resourceKind !== 'string' || !proof.resourceKind
      || !Number.isSafeInteger(proof.frameSequence) || proof.frameSequence < 1) {
      throw new TypeError('resident resource proof requires ownerKey, resourceKind, and frameSequence');
    }
    return Object.freeze({
      ownerKey: proof.ownerKey,
      resourceKind: proof.resourceKind,
      frameSequence: proof.frameSequence,
      completedAtMs: Number.isFinite(proof.completedAtMs) ? proof.completedAtMs : null,
    });
  }));
  const ownerGeometrySet = ownedGeometries === null ? null : new Set(ownedGeometries);

  const seenGeometries = new Set();
  const seenAttributes = new Set();
  const programKeys = new Set();
  const drawables = [];
  const uploadTargets = [];
  let attributeBytes = 0;
  let indexBytes = 0;
  let instanceBytes = 0;
  let referencedSharedAttributeBytes = 0;
  let referencedSharedIndexBytes = 0;
  let ownedGeometryCount = 0;
  let referencedSharedGeometryCount = 0;

  for (const mesh of projectedUploadDrawableObjects(root)) {
    const drawableIndex = drawables.length;
    const resourceKeys = [];
    let byteLength = 0;
    const geometry = mesh.geometry ?? null;
    if (geometry && !seenGeometries.has(geometry)) {
      seenGeometries.add(geometry);
      const ownerOwned = ownerGeometrySet === null || ownerGeometrySet.has(geometry);
      if (ownerOwned) ownedGeometryCount += 1;
      else referencedSharedGeometryCount += 1;
      for (const [name, attribute] of Object.entries(geometry.attributes ?? {})) {
        if (!attribute || seenAttributes.has(attribute)) continue;
        seenAttributes.add(attribute);
        const bytes = estimatedArrayBytes(attributeArray(attribute));
        if (ownerOwned) {
          const resourceKey = `geometry:${seenGeometries.size - 1}:attribute:${name}`;
          attributeBytes += bytes;
          byteLength += bytes;
          resourceKeys.push(resourceKey);
          if (bytes > 0) uploadTargets.push(Object.freeze({
            resourceKey,
            drawableIndex,
            resourceKind: 'geometry-attribute',
            byteLength: bytes,
            attribute,
          }));
        } else referencedSharedAttributeBytes += bytes;
      }
      if (geometry.index && !seenAttributes.has(geometry.index)) {
        seenAttributes.add(geometry.index);
        const bytes = estimatedArrayBytes(attributeArray(geometry.index), { index: true });
        if (ownerOwned) {
          const resourceKey = `geometry:${seenGeometries.size - 1}:index`;
          indexBytes += bytes;
          byteLength += bytes;
          resourceKeys.push(resourceKey);
          if (bytes > 0) uploadTargets.push(Object.freeze({
            resourceKey,
            drawableIndex,
            resourceKind: 'geometry-index',
            byteLength: bytes,
            attribute: geometry.index,
          }));
        } else referencedSharedIndexBytes += bytes;
      }
    }
    for (const [name, attribute] of [
      ['instanceMatrix', mesh.instanceMatrix],
      ['instanceColor', mesh.instanceColor],
    ]) {
      if (!attribute || seenAttributes.has(attribute)) continue;
      seenAttributes.add(attribute);
      const bytes = estimatedArrayBytes(attributeArray(attribute));
      const resourceKey = `drawable:${drawableIndex}:${name}`;
      instanceBytes += bytes;
      byteLength += bytes;
      resourceKeys.push(resourceKey);
      if (bytes > 0) uploadTargets.push(Object.freeze({
        resourceKey,
        drawableIndex,
        resourceKind: name,
        byteLength: bytes,
        attribute,
      }));
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (material) programKeys.add(materialIdentity(material, programKeys.size));
    }
    drawables.push(Object.freeze({
      drawableIndex,
      meshName: typeof mesh.name === 'string' ? mesh.name : '',
      byteLength,
      resourceKeys: Object.freeze(resourceKeys),
    }));
  }

  const buckets = [];
  let pending = null;
  const flush = () => {
    if (!pending) return;
    buckets.push(freezeBucket({
      ...pending,
      bucketIndex: buckets.length,
      oversized: pending.byteLength > budgetBytes,
    }));
    pending = null;
  };
  for (const drawable of drawables) {
    // A zero-byte drawable references a resource proven resident by an earlier
    // renderer receipt (or a shared immutable asset). It remains represented in
    // mesh/program diagnostics but has no upload work for the detached stager.
    if (drawable.byteLength === 0) continue;
    if (pending && pending.byteLength + drawable.byteLength > budgetBytes) flush();
    if (!pending) {
      pending = {
        byteLength: 0,
        drawableIndices: [],
        meshNames: [],
        resourceKeys: [],
      };
    }
    pending.byteLength += drawable.byteLength;
    pending.drawableIndices.push(drawable.drawableIndex);
    pending.meshNames.push(drawable.meshName);
    pending.resourceKeys.push(...drawable.resourceKeys);
    if (pending.byteLength >= budgetBytes) flush();
  }
  flush();

  const uploadBytes = attributeBytes + indexBytes + instanceBytes;
  return Object.freeze({
    schemaVersion: 'projected-upload-manifest-1',
    ownerKey,
    generation,
    meshCount: drawables.length,
    geometryCount: seenGeometries.size,
    ownedGeometryCount,
    referencedSharedGeometryCount,
    attributeBytes,
    indexBytes,
    instanceBytes,
    uploadBytes,
    referencedSharedAttributeBytes,
    referencedSharedIndexBytes,
    referencedSharedBytes: referencedSharedAttributeBytes + referencedSharedIndexBytes,
    uploadTargetCount: uploadTargets.length,
    uploadTargets: Object.freeze(uploadTargets),
    residentResourceProofs: frozenResidentResourceProofs,
    programKeys: Object.freeze([...programKeys].sort()),
    resourceBuckets: Object.freeze(buckets),
    oversized: uploadBytes > budgetBytes,
  });
}

function validateManifest(manifest, ownerKey, generation) {
  if (!Object.isFrozen(manifest)
    || manifest?.schemaVersion !== 'projected-upload-manifest-1') {
    throw new TypeError('an immutable ProjectedUploadManifest is required');
  }
  if (manifest.ownerKey !== ownerKey) {
    throw new Error(`upload manifest owner mismatch: ${ownerKey}:${manifest.ownerKey}`);
  }
  if (manifest.generation !== generation) {
    throw new Error(
      `upload manifest generation mismatch: ${ownerKey}:${generation}:${manifest.generation}`,
    );
  }
  finiteNonNegativeInteger(manifest.uploadBytes, 'manifest uploadBytes');
  if (!Array.isArray(manifest.resourceBuckets) || !Object.isFrozen(manifest.resourceBuckets)) {
    throw new TypeError('manifest resourceBuckets must be immutable');
  }
  const bucketResourceKeys = [];
  for (const [bucketIndex, bucket] of manifest.resourceBuckets.entries()) {
    if (!Object.isFrozen(bucket)) throw new TypeError('manifest resource bucket must be immutable');
    if (bucket.bucketIndex !== bucketIndex
      || !Array.isArray(bucket.drawableIndices) || !Object.isFrozen(bucket.drawableIndices)
      || !Array.isArray(bucket.resourceKeys) || !Object.isFrozen(bucket.resourceKeys)) {
      throw new Error(`manifest resource bucket identity is invalid: ${ownerKey}:${bucketIndex}`);
    }
    finiteNonNegativeInteger(bucket.byteLength, 'manifest bucket byteLength');
    bucketResourceKeys.push(...bucket.resourceKeys);
  }
  if (!Array.isArray(manifest.uploadTargets) || !Object.isFrozen(manifest.uploadTargets)
    || manifest.uploadTargets.some(target => !Object.isFrozen(target))) {
    throw new TypeError('manifest uploadTargets must be immutable');
  }
  const targetAttributes = new Set();
  const targetBytesByResourceKey = new Map();
  const targetDrawableByResourceKey = new Map();
  let targetBytes = 0;
  for (const target of manifest.uploadTargets) {
    if (typeof target.resourceKey !== 'string' || !target.resourceKey
      || typeof target.resourceKind !== 'string' || !target.resourceKind
      || !Number.isSafeInteger(target.drawableIndex) || target.drawableIndex < 0
      || !target.attribute) {
      throw new TypeError('manifest upload target identity is invalid');
    }
    positiveInteger(target.byteLength, 'manifest upload target byteLength');
    if (targetAttributes.has(target.attribute)) {
      throw new Error(`manifest upload target is duplicated: ${target.resourceKey}`);
    }
    if (targetBytesByResourceKey.has(target.resourceKey)) {
      throw new Error(`manifest upload target resource key is duplicated: ${target.resourceKey}`);
    }
    targetAttributes.add(target.attribute);
    targetBytesByResourceKey.set(target.resourceKey, target.byteLength);
    targetDrawableByResourceKey.set(target.resourceKey, target.drawableIndex);
    targetBytes += target.byteLength;
  }
  if (manifest.uploadTargetCount !== manifest.uploadTargets.length
    || targetBytes !== manifest.uploadBytes) {
    throw new Error(`manifest upload target accounting mismatch: ${ownerKey}`);
  }
  const bucketBytes = manifest.resourceBuckets.reduce(
    (sum, bucket) => sum + bucket.byteLength, 0,
  );
  if (bucketBytes !== manifest.uploadBytes) {
    throw new Error(`manifest resource bucket accounting mismatch: ${ownerKey}`);
  }
  const targetResourceKeys = manifest.uploadTargets.map(target => target.resourceKey).sort();
  bucketResourceKeys.sort();
  if (targetResourceKeys.length !== bucketResourceKeys.length
    || targetResourceKeys.some((key, index) => key !== bucketResourceKeys[index])) {
    throw new Error(`manifest resource bucket membership mismatch: ${ownerKey}`);
  }
  const seenBucketResourceKeys = new Set();
  for (const bucket of manifest.resourceBuckets) {
    const drawableIndices = new Set(bucket.drawableIndices);
    let resourceBytes = 0;
    for (const resourceKey of bucket.resourceKeys) {
      if (seenBucketResourceKeys.has(resourceKey)) {
        throw new Error(`manifest resource bucket duplicates target: ${ownerKey}:${resourceKey}`);
      }
      seenBucketResourceKeys.add(resourceKey);
      const bytes = targetBytesByResourceKey.get(resourceKey);
      const drawableIndex = targetDrawableByResourceKey.get(resourceKey);
      if (bytes === undefined || !drawableIndices.has(drawableIndex)) {
        throw new Error(`manifest resource bucket target identity is invalid: ${ownerKey}:${resourceKey}`);
      }
      resourceBytes += bytes;
    }
    if (resourceBytes !== bucket.byteLength) {
      throw new Error(
        `manifest resource bucket target accounting mismatch: ${ownerKey}:${bucket.bucketIndex}`,
      );
    }
  }
  if (!Array.isArray(manifest.residentResourceProofs)
    || !Object.isFrozen(manifest.residentResourceProofs)
    || manifest.residentResourceProofs.some(proof => !Object.isFrozen(proof))) {
    throw new TypeError('manifest residentResourceProofs must be immutable');
  }
  return manifest;
}

/**
 * Serializes Near publication against completed renderer receipts. Every
 * owner-owned upload target is staged before publication. Aggregate oversized
 * owners make finite progress through deterministic bounded buckets and publish
 * atomically; one physically indivisible over-budget bucket is rejected.
 */
export class RenderUploadAdmissionController {
  constructor({
    budgetBytes = DEFAULT_STREAMING_UPLOAD_BUDGET_BYTES,
    ownerLimitPerFrame = DEFAULT_STREAMING_OWNER_ADMISSION_LIMIT,
    clock = () => globalThis.performance?.now?.() ?? Date.now(),
  } = {}) {
    this.budgetBytes = positiveInteger(budgetBytes, 'upload budgetBytes');
    this.ownerLimitPerFrame = positiveInteger(ownerLimitPerFrame, 'ownerLimitPerFrame');
    if (typeof clock !== 'function') throw new TypeError('upload admission clock is required');
    this.clock = clock;
    this.queue = [];
    this.activeJob = null;
    this.processing = false;
    this.awaitingReceipt = false;
    this.pendingPublicationReceipt = null;
    this.frameSequence = 0;
    this.frameBytes = 0;
    this.frameOwnerAdmissions = 0;
    this.lastReceiptAtMs = null;
    this.disposed = false;
    this.shutdownReason = null;
    this.counts = {
      requested: 0,
      published: 0,
      stagedBuckets: 0,
      stagedBytes: 0,
      receipts: 0,
      ignoredReceipts: 0,
      unprovenPublicationReceipts: 0,
      cancelled: 0,
      failures: 0,
      oversizedOwners: 0,
      oversizedBuckets: 0,
      overBudgetManifestRejects: 0,
      maximumFrameBytes: 0,
      maximumQueueDepth: 0,
    };
  }

  admit({
    ownerKey,
    generation = 0,
    manifest,
    stageBucket = null,
    publish,
    isCurrent = () => true,
    receiptProvesPublication,
  } = {}) {
    if (this.disposed) return Promise.reject(new Error('render upload admission is shut down'));
    requireOwnerKey(ownerKey);
    finiteNonNegativeInteger(generation, 'upload generation');
    validateManifest(manifest, ownerKey, generation);
    if (typeof publish !== 'function') throw new TypeError('upload publish callback is required');
    if (stageBucket !== null && typeof stageBucket !== 'function') {
      throw new TypeError('stageBucket must be a function when provided');
    }
    if (typeof isCurrent !== 'function') throw new TypeError('isCurrent must be a function');
    if (typeof receiptProvesPublication !== 'function') {
      throw new TypeError('receiptProvesPublication must be a function');
    }
    if (manifest.resourceBuckets.length > 0 && stageBucket === null) {
      throw new Error(`upload owner requires pre-publication resource staging: ${ownerKey}`);
    }
    const overBudgetBucket = manifest.resourceBuckets.find(
      bucket => bucket.byteLength > this.budgetBytes,
    );
    if (overBudgetBucket) {
      this.counts.failures += 1;
      this.counts.overBudgetManifestRejects += 1;
      return Promise.reject(new Error(
        `upload resource exceeds per-frame budget: ${ownerKey}`
          + `:${overBudgetBucket.bucketIndex}:${overBudgetBucket.byteLength}`
          + `:${this.budgetBytes}`,
      ));
    }
    let resolveJob;
    let rejectJob;
    const promise = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job = {
      ownerKey,
      generation,
      manifest,
      stageBucket,
      publish,
      isCurrent,
      receiptProvesPublication,
      nextBucketIndex: 0,
      stagedBytes: 0,
      enqueuedAtMs: Number(this.clock()),
      resolve: resolveJob,
      reject: rejectJob,
      cancelled: false,
      settled: false,
    };
    this.queue.push(job);
    this.counts.requested += 1;
    this.counts.maximumQueueDepth = Math.max(this.counts.maximumQueueDepth, this.queue.length);
    void this.#pump();
    return promise;
  }

  #settleJob(job, { value, error } = {}) {
    if (job.settled) return;
    job.settled = true;
    if (this.queue[0] === job) this.queue.shift();
    else this.queue = this.queue.filter(candidate => candidate !== job);
    if (this.activeJob === job) this.activeJob = null;
    if (error) job.reject(error);
    else job.resolve(value);
  }

  #cancelReason(job) {
    if (job.settled) {
      return new Error(`render upload admission already settled: ${job.ownerKey}:${job.generation}`);
    }
    if (this.disposed) {
      return this.shutdownReason ?? new Error('render upload admission is shut down');
    }
    if (job.cancelled) {
      return new Error(`render upload admission cancelled: ${job.ownerKey}:${job.generation}`);
    }
    try {
      if (job.isCurrent() !== true) {
        return new Error(`render upload admission cancelled: ${job.ownerKey}:${job.generation}`);
      }
    } catch (error) {
      return error;
    }
    return null;
  }

  #cancelJob(job, reason) {
    if (job.settled) return false;
    if (this.pendingPublicationReceipt === job) {
      this.pendingPublicationReceipt = null;
      this.awaitingReceipt = false;
    }
    this.counts.cancelled += 1;
    this.#settleJob(job, { error: reason });
    return true;
  }

  async #pump() {
    if (this.processing || this.awaitingReceipt || this.disposed) return;
    this.processing = true;
    try {
      while (!this.awaitingReceipt && !this.disposed && this.queue.length > 0) {
        const job = this.queue[0];
        this.activeJob = job;
        const initialCancelReason = this.#cancelReason(job);
        if (initialCancelReason) {
          this.#cancelJob(job, initialCancelReason);
          continue;
        }

        const buckets = job.manifest.resourceBuckets;
        if (job.nextBucketIndex < buckets.length) {
          let stagedThisFrame = 0;
          while (job.nextBucketIndex < buckets.length) {
            const bucket = buckets[job.nextBucketIndex];
            const remaining = this.budgetBytes - this.frameBytes;
            if (stagedThisFrame > 0 && bucket.byteLength > remaining) break;
            if (stagedThisFrame === 0 && this.frameBytes > 0 && bucket.byteLength > remaining) break;
            await job.stageBucket(Object.freeze({
              ownerKey: job.ownerKey,
              generation: job.generation,
              manifest: job.manifest,
              bucket,
            }));
            const stagedCancelReason = this.#cancelReason(job);
            if (stagedCancelReason) {
              this.#cancelJob(job, stagedCancelReason);
              break;
            }
            job.nextBucketIndex += 1;
            job.stagedBytes += bucket.byteLength;
            this.frameBytes += bucket.byteLength;
            stagedThisFrame += 1;
            this.counts.stagedBuckets += 1;
            this.counts.stagedBytes += bucket.byteLength;
            this.counts.maximumFrameBytes = Math.max(
              this.counts.maximumFrameBytes,
              this.frameBytes,
            );
            if (this.frameBytes >= this.budgetBytes) break;
          }
          if (job.settled || this.disposed) continue;
          if (job.nextBucketIndex < buckets.length) {
            this.awaitingReceipt = true;
            break;
          }
        }

        if (this.frameOwnerAdmissions >= this.ownerLimitPerFrame) {
          this.awaitingReceipt = true;
          break;
        }
        const publishCancelReason = this.#cancelReason(job);
        if (publishCancelReason) {
          this.#cancelJob(job, publishCancelReason);
          continue;
        }
        if (job.stagedBytes !== job.manifest.uploadBytes) {
          throw new Error(
            `upload owner publication preceded complete resource staging: ${job.ownerKey}`,
          );
        }
        await job.publish(Object.freeze({
          ownerKey: job.ownerKey,
          generation: job.generation,
          manifest: job.manifest,
          staged: job.stagedBytes > 0,
          stagedBytes: job.stagedBytes,
        }));
        // publish may itself be asynchronous. Cancellation after it starts must
        // reject the admission so the enclosing runtime transaction rolls the
        // publication back instead of manufacturing a resource receipt.
        const publishedCancelReason = this.#cancelReason(job);
        if (publishedCancelReason) {
          this.#cancelJob(job, publishedCancelReason);
          continue;
        }
        this.frameOwnerAdmissions += 1;
        if (job.manifest.oversized) this.counts.oversizedOwners += 1;
        this.counts.published += 1;
        job.publication = Object.freeze({
          ownerKey: job.ownerKey,
          generation: job.generation,
          publishedAfterFrameSequence: this.frameSequence,
          manifest: job.manifest,
          staged: job.stagedBytes > 0,
        });
        this.pendingPublicationReceipt = job;
        this.awaitingReceipt = true;
      }
    } catch (error) {
      this.counts.failures += 1;
      const failed = this.activeJob ?? this.queue[0] ?? null;
      if (failed) this.#settleJob(failed, { error });
    } finally {
      this.processing = false;
      if (!this.awaitingReceipt && !this.disposed && this.queue.length > 0) {
        void this.#pump();
      }
    }
  }

  acknowledgeRenderReceipt(receipt) {
    if (!isCompletedRenderFrameReceipt(receipt)) return false;
    if (receipt.frameSequence <= this.frameSequence) {
      this.counts.ignoredReceipts += 1;
      return false;
    }
    this.frameSequence = receipt.frameSequence;
    this.lastReceiptAtMs = receipt.completedAtMs;
    this.frameBytes = 0;
    this.frameOwnerAdmissions = 0;
    const relevant = this.awaitingReceipt || this.pendingPublicationReceipt !== null
      || this.queue.length > 0;
    if (!relevant) {
      this.counts.ignoredReceipts += 1;
      return false;
    }
    this.awaitingReceipt = false;
    this.counts.receipts += 1;
    if (this.pendingPublicationReceipt) {
      const published = this.pendingPublicationReceipt;
      const receiptCancelReason = this.#cancelReason(published);
      if (receiptCancelReason) {
        this.#cancelJob(published, receiptCancelReason);
        void this.#pump();
        return false;
      }
      let proven = false;
      try {
        proven = published.receiptProvesPublication(receipt) === true;
      } catch (error) {
        this.counts.failures += 1;
        this.pendingPublicationReceipt = null;
        this.#settleJob(published, { error });
        void this.#pump();
        return false;
      }
      if (!proven) {
        this.counts.unprovenPublicationReceipts += 1;
        this.awaitingReceipt = true;
        return false;
      }
      this.pendingPublicationReceipt = null;
      this.#settleJob(published, {
        value: Object.freeze({
          ...published.publication,
          frameSequence: receipt.frameSequence,
          uploadCompleteReceipt: receipt,
        }),
      });
    }
    void this.#pump();
    return true;
  }

  cancel({ ownerKey = null, generation = null } = {}) {
    let cancelled = 0;
    for (const job of [...this.queue]) {
      if (ownerKey !== null && job.ownerKey !== ownerKey) continue;
      if (generation !== null && job.generation !== generation) continue;
      job.cancelled = true;
      if (job !== this.activeJob || !this.processing) {
        this.#cancelJob(job, new Error(
          `render upload admission cancelled: ${job.ownerKey}:${job.generation}`,
        ));
      }
      cancelled += 1;
    }
    if (!this.processing) void this.#pump();
    return cancelled;
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: 'render-upload-admission-snapshot-1',
      budgetBytes: this.budgetBytes,
      ownerLimitPerFrame: this.ownerLimitPerFrame,
      frameSequence: this.frameSequence,
      frameBytes: this.frameBytes,
      frameOwnerAdmissions: this.frameOwnerAdmissions,
      awaitingReceipt: this.awaitingReceipt,
      queueDepth: this.queue.length,
      activeOwnerKey: this.activeJob?.ownerKey ?? null,
      activeGeneration: this.activeJob?.generation ?? null,
      pendingPublicationOwnerKey: this.pendingPublicationReceipt?.ownerKey ?? null,
      lastReceiptAtMs: this.lastReceiptAtMs,
      counts: Object.freeze({ ...this.counts }),
    });
  }

  shutdown(reason = new Error('render upload admission shut down')) {
    if (this.disposed) return false;
    this.disposed = true;
    this.shutdownReason = reason instanceof Error ? reason : new Error(String(reason));
    const inCallback = this.processing ? this.activeJob : null;
    for (const job of [...this.queue]) {
      job.cancelled = true;
      // Do not reject an active async stage/publish callback ahead of its
      // cancellation recheck. The caller (the runtime transaction) must not
      // begin rollback while that callback can still mutate publication state.
      if (job === inCallback) continue;
      this.#settleJob(job, { error: this.shutdownReason });
    }
    if (!inCallback) this.activeJob = null;
    if (this.pendingPublicationReceipt !== inCallback) {
      this.pendingPublicationReceipt = null;
    }
    this.awaitingReceipt = false;
    return true;
  }
}

export function createRenderUploadAdmissionController(options) {
  return new RenderUploadAdmissionController(options);
}

/**
 * Uploads one deterministic manifest bucket through a private 1x1 render
 * target before owner publication. Ordinarily the projected root is detached.
 * A not-yet-drawn provisional Terrain is the same canonical Mesh already held
 * by the world scene; it is moved synchronously for the private render and
 * restored to its exact parent/index before this function returns. No event
 * loop boundary or alternate world object is introduced.
 */
export function createThreeProjectedUploadStager({ THREE, renderer, gpuMirror = null } = {}) {
  if (typeof THREE?.Scene !== 'function'
    || typeof THREE?.OrthographicCamera !== 'function'
    || typeof THREE?.WebGLRenderTarget !== 'function') {
    throw new TypeError('THREE Scene, OrthographicCamera, and WebGLRenderTarget are required');
  }
  if (typeof renderer?.render !== 'function'
    || typeof renderer?.setRenderTarget !== 'function'
    || typeof renderer?.getRenderTarget !== 'function') {
    throw new TypeError('a WebGL renderer with render-target support is required');
  }
  if (gpuMirror !== null && typeof gpuMirror?.recordExternalUpload !== 'function') {
    throw new TypeError('gpuMirror.recordExternalUpload is required when gpuMirror is provided');
  }
  const stagingScene = new THREE.Scene();
  stagingScene.name = 'near-owner-upload-staging-scene';
  const stagingCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  stagingCamera.name = 'near-owner-upload-staging-camera';
  stagingCamera.position?.set?.(0, 0, 1);
  if (stagingCamera.layers && 'mask' in stagingCamera.layers) {
    stagingCamera.layers.mask = 0xffffffff;
  }
  const stagingTarget = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
  });
  stagingTarget.texture.name = 'near-owner-upload-staging-target';
  let disposed = false;
  const counts = {
    stagedBuckets: 0,
    stagedBytes: 0,
    maximumBucketBytes: 0,
    rendererUploadProofs: 0,
    rendererUploadProofFailures: 0,
    failures: 0,
  };

  const stage = ({ projected, manifest, bucket } = {}) => {
    if (disposed) throw new Error('projected upload stager is disposed');
    const root = projected?.group ?? null;
    if (!root || typeof root.traverse !== 'function') {
      throw new TypeError('projected owner group with traverse is required');
    }
    if (manifest !== projected.uploadManifest
      || manifest?.ownerKey !== projected.key
      || !bucket || bucket !== manifest.resourceBuckets?.[bucket.bucketIndex]
      || !Array.isArray(bucket.drawableIndices)) {
      throw new TypeError('immutable upload manifest bucket is required');
    }
    const selectedIndices = new Set(bucket.drawableIndices);
    const rootDrawables = projectedUploadDrawableObjects(root);
    const drawables = projected.uploadManifestDrawableObjects ?? rootDrawables;
    if (!Array.isArray(drawables) || drawables.length !== manifest.meshCount) {
      throw new Error(`projected upload drawable membership mismatch: ${projected.key}`);
    }
    const drawableOwnsAttribute = (drawable, attribute) => [
      ...Object.values(drawable?.geometry?.attributes ?? {}),
      drawable?.geometry?.index,
      drawable?.instanceMatrix,
      drawable?.instanceColor,
    ].some(candidate => candidate === attribute);
    for (const target of manifest.uploadTargets) {
      if (!drawableOwnsAttribute(drawables[target.drawableIndex], target.attribute)) {
        throw new Error(`projected upload target changed before staging: ${target.resourceKey}`);
      }
    }
    const bucketTargets = manifest.uploadTargets.filter(target => (
      selectedIndices.has(target.drawableIndex)
    ));
    const rendererUploadVersions = new Map();
    const uploadProbeRestores = [];
    if (gpuMirror) {
      for (const target of bucketTargets) {
        const restore = installRendererUploadProbe(target.attribute, version => {
          rendererUploadVersions.set(target.attribute, version);
        });
        if (restore) uploadProbeRestores.push(restore);
      }
    }
    const nodes = [];
    root.traverse(node => {
      nodes.push(node);
    });
    for (const index of selectedIndices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= drawables.length) {
        throw new RangeError(`upload manifest drawable index is out of range: ${index}`);
      }
    }
    const directStaging = [...selectedIndices].some(
      index => drawables[index] !== rootDrawables[index],
    );
    if (!directStaging && root.parent !== null && root.parent !== undefined) {
      throw new Error(`projected upload owner must remain detached: ${projected?.key ?? 'unknown'}`);
    }
    const stagedNodes = directStaging
      ? [...selectedIndices].map(index => drawables[index]) : nodes;
    const nodeState = stagedNodes.map((node, order) => Object.freeze({
      node,
      order,
      visible: node.visible,
      frustumCulled: node.frustumCulled,
      parent: directStaging ? node.parent ?? null : null,
      parentIndex: directStaging ? (node.parent?.children?.indexOf(node) ?? -1) : -1,
    }));
    const previousRenderTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace?.() ?? 0;
    const previousMipmapLevel = renderer.getActiveMipmapLevel?.() ?? 0;
    const previousXrEnabled = renderer.xr?.enabled;
    let stageError = null;
    try {
      for (const { node } of nodeState) node.visible = true;
      if (directStaging) {
        for (const state of nodeState) state.parent?.remove?.(state.node);
        for (const { node } of nodeState) {
          node.frustumCulled = false;
          stagingScene.add(node);
        }
      } else {
        for (const [index, drawable] of rootDrawables.entries()) {
          drawable.visible = selectedIndices.has(index);
          if (drawable.visible) drawable.frustumCulled = false;
        }
        stagingScene.add(root);
      }
      if (renderer.xr && typeof previousXrEnabled === 'boolean') renderer.xr.enabled = false;
      renderer.setRenderTarget(stagingTarget);
      renderer.render(stagingScene, stagingCamera);
    } catch (error) {
      stageError = error;
    }
    try {
      if (directStaging) {
        for (const { node } of nodeState) stagingScene.remove(node);
        for (const state of [...nodeState].sort((left, right) => left.order - right.order)) {
          if (!state.parent) continue;
          state.parent.add(state.node);
          const children = state.parent.children;
          const appendedIndex = children?.indexOf?.(state.node) ?? -1;
          if (Array.isArray(children) && state.parentIndex >= 0
            && appendedIndex >= 0 && appendedIndex !== state.parentIndex) {
            children.splice(appendedIndex, 1);
            children.splice(Math.min(state.parentIndex, children.length), 0, state.node);
          }
        }
      } else {
        stagingScene.remove(root);
      }
      for (const state of nodeState) {
        state.node.visible = state.visible;
        state.node.frustumCulled = state.frustumCulled;
      }
      if (renderer.xr && typeof previousXrEnabled === 'boolean') {
        renderer.xr.enabled = previousXrEnabled;
      }
      renderer.setRenderTarget(previousRenderTarget, previousCubeFace, previousMipmapLevel);
    } catch (restoreError) {
      stageError = stageError
        ? new AggregateError([stageError, restoreError], 'upload staging and hierarchy restore failed')
        : restoreError;
    }
    for (const restore of uploadProbeRestores) {
      try { restore(); } catch (restoreError) {
        stageError = stageError
          ? new AggregateError([stageError, restoreError], 'upload staging and probe restore failed')
          : restoreError;
      }
    }
    if (!stageError && gpuMirror) {
      for (const target of bucketTargets) {
        const version = attributeVersion(target.attribute);
        const alreadyProven = gpuMirror.residentVersion?.(target.attribute) === version
          && gpuMirror.matches?.(target.attribute) === true;
        if (!alreadyProven && rendererUploadVersions.get(target.attribute) !== version) {
          counts.rendererUploadProofFailures += 1;
          stageError = new Error(
            `private upload render did not prove target upload: ${projected.key}:${target.resourceKey}`,
          );
          break;
        }
        if (!alreadyProven) {
          gpuMirror.recordExternalUpload({
            object: drawables[target.drawableIndex],
            attribute: target.attribute,
            version,
          });
          counts.rendererUploadProofs += 1;
        }
      }
    }
    if (stageError) {
      counts.failures += 1;
      throw stageError;
    }
    const stagedBytes = finiteNonNegativeInteger(
      bucket.byteLength,
      'staged bucket byteLength',
    );
    counts.stagedBuckets += 1;
    counts.stagedBytes += stagedBytes;
    counts.maximumBucketBytes = Math.max(counts.maximumBucketBytes, stagedBytes);
    const uploadStagingProof = projected.uploadStagingProof?.manifest === manifest
      ? projected.uploadStagingProof
      : { manifest, bucketIndices: new Set() };
    uploadStagingProof.bucketIndices.add(bucket.bucketIndex);
    projected.uploadStagingProof = uploadStagingProof;
    return Object.freeze({
      ownerKey: projected.key,
      generation: manifest.generation,
      bucketIndex: bucket.bucketIndex,
      byteLength: stagedBytes,
      drawableCount: selectedIndices.size,
    });
  };

  return Object.freeze({
    stage,
    snapshot: () => Object.freeze({
      schemaVersion: 'projected-upload-stager-snapshot-1',
      disposed,
      ...counts,
    }),
    dispose() {
      if (disposed) return false;
      disposed = true;
      stagingScene.clear?.();
      stagingTarget.dispose?.();
      return true;
    },
  });
}
