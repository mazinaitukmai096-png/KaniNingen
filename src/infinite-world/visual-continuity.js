export const VISUAL_CONTINUITY_SCHEMA = 'visual-continuity-owner-1';
export const VISUAL_CONTINUITY_REGISTRY_SCHEMA = 'visual-continuity-registry-1';
export const RENDER_FRAME_RECEIPT_SCHEMA = 'render-frame-receipt-1';
export const GPU_ATTRIBUTE_MIRROR_SCHEMA = 'gpu-attribute-mirror-1';

export const VISUAL_CONTINUITY_STATE = Object.freeze({
  EXPECTED: 'Expected',
  COARSE_DRAWABLE: 'CoarseDrawable',
  DETAIL_DRAWABLE: 'DetailDrawable',
  RETIRING: 'Retiring',
});

export const VISUAL_PIPELINE_STAGE = Object.freeze({
  REQUEST: 'request',
  WORKER_START: 'workerStart',
  WORKER_COMPLETE: 'workerComplete',
  RESOURCE_READY: 'resourceReady',
  VISUAL_WORK_START: 'visualWorkStart',
  GPU_UPLOAD: 'gpuUpload',
  ACTUAL_DRAWABLE: 'actualDrawable',
});

const FRAME_TOKEN = Symbol('render-frame-token');
const FRAME_RECEIPT = Symbol('render-frame-receipt');
const FRAME_SCENE = Symbol('render-frame-scene');
const PIPELINE_TIME_FIELD = Object.freeze({
  [VISUAL_PIPELINE_STAGE.REQUEST]: 'requestAt',
  [VISUAL_PIPELINE_STAGE.WORKER_START]: 'workerStartAt',
  [VISUAL_PIPELINE_STAGE.WORKER_COMPLETE]: 'workerCompleteAt',
  [VISUAL_PIPELINE_STAGE.RESOURCE_READY]: 'resourceReadyAt',
  [VISUAL_PIPELINE_STAGE.VISUAL_WORK_START]: 'visualWorkStartedAt',
  [VISUAL_PIPELINE_STAGE.GPU_UPLOAD]: 'gpuUploadedAt',
  [VISUAL_PIPELINE_STAGE.ACTUAL_DRAWABLE]: 'lastActualDrawAt',
});

const defaultClock = () => globalThis.performance?.now?.() ?? Date.now();

function finiteTime(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

function ownerIdentity(ownerKey) {
  if (typeof ownerKey !== 'string' || !ownerKey) {
    throw new TypeError('visual ownerKey must be a non-empty string');
  }
  return ownerKey;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * ratio))];
}

function attributeVersion(attribute) {
  return Number.isSafeInteger(attribute?.version) && attribute.version >= 0
    ? attribute.version : 0;
}

function attributeArray(attribute) {
  if (ArrayBuffer.isView(attribute) || Array.isArray(attribute)) return attribute;
  const value = attribute?.array ?? attribute?.values ?? null;
  return ArrayBuffer.isView(value) || Array.isArray(value) ? value : null;
}

function attributeUpdateRanges(attribute, length) {
  const ranges = Array.isArray(attribute?.updateRanges) && attribute.updateRanges.length > 0
    ? attribute.updateRanges
    : Number.isFinite(attribute?.updateRange?.count) && attribute.updateRange.count >= 0
      ? [attribute.updateRange]
      : null;
  if (!ranges) return Object.freeze([{ offset: 0, count: length }]);
  return Object.freeze(ranges.map(range => {
    const offset = Math.max(0, Math.min(length, Math.trunc(range.start ?? range.offset ?? 0)));
    const rawCount = Math.trunc(range.count ?? 0);
    const count = rawCount < 0 ? length - offset : Math.max(0, Math.min(length - offset, rawCount));
    return Object.freeze({ offset, count });
  }));
}

function visitSceneObject(root, visitor) {
  if (!root) return;
  visitor(root);
  for (const child of root.children ?? []) visitSceneObject(child, visitor);
}

function drawableAttributes(mesh) {
  return Object.freeze([
    ...Object.values(mesh?.geometry?.attributes ?? {}),
    ...(mesh?.geometry?.index ? [mesh.geometry.index] : []),
    ...(mesh?.instanceMatrix ? [mesh.instanceMatrix] : []),
    ...(mesh?.instanceColor ? [mesh.instanceColor] : []),
  ].filter(Boolean));
}

function canonicalOwnerKey(record) {
  const coordinate = record?.owningChunkCoordinate;
  return Number.isSafeInteger(coordinate?.x) && Number.isSafeInteger(coordinate?.z)
    ? `${coordinate.x},${coordinate.z}` : null;
}

function inheritedChunkOwnerKey(object) {
  for (let current = object; current; current = current.parent) {
    const key = current.userData?.chunkKey ?? current.userData?.visualOwnerKey ?? null;
    if (typeof key === 'string' && key) return key;
  }
  return null;
}

/**
 * A test renderer can use this mirror to model Three r160 uploads. CPU writes
 * are copied only at renderer-frame completion and only after the attribute's
 * version/needsUpdate contract exposes them.
 */
export function createGpuAttributeMirror() {
  const mirrored = new WeakMap();
  let frameCount = 0;
  let attributeUploadCount = 0;
  let componentUploadCount = 0;

  const uploadAttribute = attribute => {
    const source = attributeArray(attribute);
    if (!source) return false;
    const version = attributeVersion(attribute);
    let target = mirrored.get(attribute);
    const initial = !target || target.values.length !== source.length;
    const dirty = initial || target.version !== version || attribute.needsUpdate === true;
    if (!dirty) return false;
    if (initial) {
      target = {
        values: new source.constructor(source.length),
        version: -1,
        uploadedAtFrame: 0,
      };
    }
    const ranges = initial
      ? Object.freeze([{ offset: 0, count: source.length }])
      : attributeUpdateRanges(attribute, source.length);
    for (const { offset, count } of ranges) {
      for (let index = offset; index < offset + count; index += 1) {
        target.values[index] = source[index];
      }
      componentUploadCount += count;
    }
    target.version = version;
    target.uploadedAtFrame = frameCount;
    mirrored.set(attribute, target);
    attributeUploadCount += 1;
    return true;
  };

  const uploadFrame = ({ scene = null } = {}) => {
    frameCount += 1;
    const visited = new Set();
    visitSceneObject(scene, object => {
      for (const attribute of drawableAttributes(object)) {
        if (visited.has(attribute)) continue;
        visited.add(attribute);
        uploadAttribute(attribute);
      }
    });
    return Object.freeze({ frameCount, visitedAttributeCount: visited.size });
  };

  const matches = attribute => {
    const source = attributeArray(attribute);
    const target = mirrored.get(attribute);
    if (!source || !target || target.values.length !== source.length
      || target.version !== attributeVersion(attribute)) return false;
    for (let index = 0; index < source.length; index += 1) {
      if (!Object.is(target.values[index], source[index])) return false;
    }
    return true;
  };

  return Object.freeze({
    schemaVersion: GPU_ATTRIBUTE_MIRROR_SCHEMA,
    uploadFrame,
    uploadAttribute,
    matches,
    read: attribute => {
      const target = mirrored.get(attribute);
      return target ? Object.freeze(Array.from(target.values)) : null;
    },
    snapshot: () => Object.freeze({
      schemaVersion: GPU_ATTRIBUTE_MIRROR_SCHEMA,
      frameCount,
      attributeUploadCount,
      componentUploadCount,
    }),
  });
}

/**
 * Produces an opaque receipt only after a renderer frame has completed. The
 * receipt is intentionally not forgeable with a plain object in a unit test.
 */
export function createRenderFrameAcknowledger({
  clock = defaultClock,
  gpuMirror = null,
} = {}) {
  if (typeof clock !== 'function') throw new TypeError('render frame clock is required');
  if (gpuMirror !== null && typeof gpuMirror.uploadFrame !== 'function') {
    throw new TypeError('gpuMirror must implement uploadFrame');
  }
  let sequence = 0;
  let active = null;
  let completedFrameCount = 0;

  const beginFrame = ({ frameSequence = ++sequence } = {}) => {
    if (!Number.isSafeInteger(frameSequence) || frameSequence < 1) {
      throw new RangeError('render frameSequence must be a positive safe integer');
    }
    if (active) throw new Error('a render frame is already active');
    sequence = Math.max(sequence, frameSequence);
    active = Object.freeze({
      [FRAME_TOKEN]: true,
      frameSequence,
      startedAtMs: finiteTime(Number(clock()), 'render frame start'),
    });
    return active;
  };

  const completeFrame = (token, { scene = null, renderer = null } = {}) => {
    if (token !== active || token?.[FRAME_TOKEN] !== true) {
      throw new Error('render frame token is not active');
    }
    const completedAtMs = finiteTime(Number(clock()), 'render frame completion');
    const gpuFrame = gpuMirror?.uploadFrame({ scene, renderer, frameSequence: token.frameSequence })
      ?? null;
    active = null;
    completedFrameCount += 1;
    return Object.freeze({
      [FRAME_RECEIPT]: true,
      schemaVersion: RENDER_FRAME_RECEIPT_SCHEMA,
      frameSequence: token.frameSequence,
      startedAtMs: token.startedAtMs,
      completedAtMs,
      rendererFrameCompleted: true,
      [FRAME_SCENE]: scene,
      gpuMirror,
      gpuFrame,
    });
  };

  const abortFrame = token => {
    if (token !== active || token?.[FRAME_TOKEN] !== true) return false;
    active = null;
    return true;
  };

  return Object.freeze({
    beginFrame,
    completeFrame,
    abortFrame,
    snapshot: () => Object.freeze({
      active: active !== null,
      completedFrameCount,
      lastSequence: sequence,
    }),
  });
}

export function isCompletedRenderFrameReceipt(value) {
  return value?.[FRAME_RECEIPT] === true
    && value.schemaVersion === RENDER_FRAME_RECEIPT_SCHEMA
    && value.rendererFrameCompleted === true
    && Number.isFinite(value.completedAtMs);
}

function objectBelongsToCompletedFrame(object, receipt) {
  const scene = receipt?.[FRAME_SCENE] ?? null;
  if (!scene) return false;
  for (let current = object; current; current = current.parent) {
    if (current === scene) return true;
  }
  return false;
}

function matrixElements(matrix) {
  const values = matrix?.elements ?? matrix ?? null;
  return ArrayBuffer.isView(values) || Array.isArray(values) ? values : null;
}

function matrixOffsetElements(attribute, slot) {
  const values = attributeArray(attribute);
  const offset = slot * 16;
  return values && Number.isSafeInteger(slot) && slot >= 0 && values.length >= offset + 16
    ? values.subarray?.(offset, offset + 16) ?? values.slice(offset, offset + 16)
    : null;
}

export function isValidDrawableMatrix(matrix) {
  const values = matrixElements(matrix);
  return values !== null && values.length >= 16
    && Array.from(values).slice(0, 16).every(Number.isFinite);
}

function objectWorldVisible(object) {
  for (let current = object; current; current = current.parent) {
    if (current.visible === false) return false;
  }
  return true;
}

function effectiveMaterialOpacity(material) {
  const values = Array.isArray(material) ? material : [material];
  if (values.length === 0 || values.every(value => !value)) return 0;
  return Math.max(...values.filter(Boolean).map(value => (
    value.visible === false ? 0 : Number.isFinite(value.opacity) ? value.opacity : 1
  )));
}

export function isDrawableInCompletedFrame({
  mesh,
  receipt,
  matrix = mesh?.matrixWorld ?? mesh?.matrix,
  effectiveOpacity = null,
  requiredAttributes = null,
} = {}) {
  if (!isCompletedRenderFrameReceipt(receipt) || !mesh
    || !objectBelongsToCompletedFrame(mesh, receipt) || !objectWorldVisible(mesh)) return false;
  if (!mesh.geometry || !isValidDrawableMatrix(matrix)) return false;
  if (Number.isFinite(mesh.count) && mesh.count <= 0) return false;
  const opacity = effectiveOpacity ?? effectiveMaterialOpacity(mesh.material);
  if (!Number.isFinite(opacity) || opacity <= 0) return false;
  const attributes = requiredAttributes ?? drawableAttributes(mesh);
  if (attributes.some(attribute => !attributeArray(attribute))) return false;
  if (receipt.gpuMirror && attributes.some(attribute => !receipt.gpuMirror.matches(attribute))) {
    return false;
  }
  return true;
}

export function hasDrawableInCompletedFrame({ root, receipt, predicate = () => true } = {}) {
  if (!root || typeof predicate !== 'function') return false;
  let found = false;
  visitSceneObject(root, object => {
    if (!found && predicate(object) && isDrawableInCompletedFrame({ mesh: object, receipt })) {
      found = true;
    }
  });
  return found;
}

function frozenOwnerRecord(record, nowMs) {
  const deadlineMissMs = record.deadlineAtMs === null ? 0 : Math.max(
    0,
    (record.coarseDrawableAt ?? nowMs) - record.deadlineAtMs,
  );
  return Object.freeze({
    schemaVersion: VISUAL_CONTINUITY_SCHEMA,
    ownerKey: record.ownerKey,
    state: record.state,
    expectedAt: record.expectedAt,
    firstPossibleVisibleAt: record.firstPossibleVisibleAt,
    coarseDrawableAt: record.coarseDrawableAt,
    detailDrawableAt: record.detailDrawableAt,
    retiringAt: record.retiringAt,
    lastActualDrawAt: record.lastActualDrawAt,
    deadlineAtMs: record.deadlineAtMs,
    deadlineMiss: deadlineMissMs > 0,
    deadlineMissMs,
    requestAt: record.requestAt,
    workerStartAt: record.workerStartAt,
    workerCompleteAt: record.workerCompleteAt,
    resourceReadyAt: record.resourceReadyAt,
    visualWorkStartedAt: record.visualWorkStartedAt,
    gpuUploadedAt: record.gpuUploadedAt,
    resourceKind: record.resourceKind,
    required: record.required,
    sequence: record.sequence,
    subscriberIdentity: record.subscriberIdentity,
    canonicalStableIds: Object.freeze([...record.canonicalStableIds].sort()),
    coarseRepresentationAvailableAt: record.coarseRepresentationAvailableAt,
    detailRepresentationAvailableAt: record.detailRepresentationAvailableAt,
    nearRepresentationAvailableAt: record.nearRepresentationAvailableAt,
  });
}

/**
 * ResourceResident is deliberately not a state here. Cache/page/compose/
 * publication readiness may be recorded, but only a renderer receipt can move
 * an Expected owner to a Drawable state.
 */
export function createVisualContinuityRegistry({
  clock = defaultClock,
  onTransition = null,
} = {}) {
  if (typeof clock !== 'function') throw new TypeError('visual continuity clock is required');
  if (onTransition !== null && typeof onTransition !== 'function') {
    throw new TypeError('onTransition must be a function');
  }
  const records = new Map();
  let sequence = 0;

  const now = () => finiteTime(Number(clock()), 'visual continuity clock');
  const emit = (type, record) => {
    if (!onTransition) return;
    try { onTransition(Object.freeze({ type, record: frozenOwnerRecord(record, now()) })); } catch {
      // Visual diagnostics must never control production lifecycle.
    }
  };
  const get = ownerKey => records.get(ownerIdentity(ownerKey)) ?? null;
  const expect = ({
    ownerKey,
    expectedAt = now(),
    firstPossibleVisibleAt = expectedAt,
    deadlineAtMs = firstPossibleVisibleAt,
    resourceKind = null,
    required = true,
    subscriberIdentity = null,
    canonicalStableIds = [],
  } = {}) => {
    const key = ownerIdentity(ownerKey);
    const expected = finiteTime(expectedAt, 'expectedAt');
    const firstPossible = finiteTime(firstPossibleVisibleAt, 'firstPossibleVisibleAt');
    const deadline = finiteTime(deadlineAtMs, 'deadlineAtMs', { nullable: true });
    let record = records.get(key);
    if (!record || record.state === VISUAL_CONTINUITY_STATE.RETIRING) {
      record = {
        ownerKey: key,
        state: VISUAL_CONTINUITY_STATE.EXPECTED,
        expectedAt: expected,
        firstPossibleVisibleAt: firstPossible,
        coarseDrawableAt: null,
        detailDrawableAt: null,
        retiringAt: null,
        lastActualDrawAt: null,
        deadlineAtMs: deadline,
        requestAt: null,
        workerStartAt: null,
        workerCompleteAt: null,
        resourceReadyAt: null,
        visualWorkStartedAt: null,
        gpuUploadedAt: null,
        resourceKind,
        required: required === true,
        sequence: ++sequence,
        subscriberIdentity,
        canonicalStableIds: new Set(canonicalStableIds),
        coarseRepresentationAvailableAt: null,
        detailRepresentationAvailableAt: null,
        nearRepresentationAvailableAt: null,
      };
      records.set(key, record);
      emit('expected', record);
    } else {
      record.expectedAt = Math.min(record.expectedAt, expected);
      record.firstPossibleVisibleAt = Math.min(record.firstPossibleVisibleAt, firstPossible);
      if (deadline !== null) {
        record.deadlineAtMs = record.deadlineAtMs === null
          ? deadline : Math.min(record.deadlineAtMs, deadline);
      }
      record.required ||= required === true;
      record.resourceKind ??= resourceKind;
      record.subscriberIdentity ??= subscriberIdentity;
      for (const stableId of canonicalStableIds) record.canonicalStableIds.add(stableId);
    }
    return frozenOwnerRecord(record, now());
  };

  const recordPipelineStage = ({ ownerKey, stage, at = now() } = {}) => {
    const record = get(ownerKey);
    if (!record) throw new Error(`visual owner is not Expected: ${ownerKey}`);
    const field = PIPELINE_TIME_FIELD[stage];
    if (!field) throw new RangeError(`unknown visual pipeline stage: ${stage}`);
    const timestamp = finiteTime(at, `${stage} at`);
    record[field] = record[field] === null ? timestamp : Math.min(record[field], timestamp);
    emit(stage, record);
    return frozenOwnerRecord(record, now());
  };

  const acknowledgeDrawable = ({
    ownerKey,
    level = 'coarse',
    receipt,
    drawable,
  } = {}) => {
    const record = get(ownerKey);
    if (!record || record.state === VISUAL_CONTINUITY_STATE.RETIRING) return false;
    if (level !== 'coarse' && level !== 'detail') {
      throw new RangeError('drawable level must be coarse or detail');
    }
    if (!isDrawableInCompletedFrame({ ...drawable, receipt })) return false;
    const timestamp = receipt.completedAtMs;
    if (level === 'detail') {
      record.coarseDrawableAt ??= timestamp;
      record.detailDrawableAt ??= timestamp;
      record.state = VISUAL_CONTINUITY_STATE.DETAIL_DRAWABLE;
    } else if (record.state !== VISUAL_CONTINUITY_STATE.DETAIL_DRAWABLE) {
      record.coarseDrawableAt ??= timestamp;
      record.state = VISUAL_CONTINUITY_STATE.COARSE_DRAWABLE;
    }
    record.lastActualDrawAt = timestamp;
    record.visualWorkStartedAt ??= timestamp;
    record.gpuUploadedAt ??= timestamp;
    emit('actual-drawable', record);
    return true;
  };

  const markRepresentationAvailable = ({ ownerKey, representation, at = now() } = {}) => {
    const record = get(ownerKey);
    if (!record) throw new Error(`visual owner is not Expected: ${ownerKey}`);
    const field = {
      coarse: 'coarseRepresentationAvailableAt',
      detail: 'detailRepresentationAvailableAt',
      near: 'nearRepresentationAvailableAt',
    }[representation];
    if (!field) throw new RangeError('representation must be coarse, detail, or near');
    const timestamp = finiteTime(at, `${representation} representation availability`);
    record[field] ??= timestamp;
    emit(`${representation}-available`, record);
    return frozenOwnerRecord(record, now());
  };

  const addCanonicalIdentities = ({ ownerKey, stableIds = [] } = {}) => {
    const record = get(ownerKey);
    if (!record) throw new Error(`visual owner is not Expected: ${ownerKey}`);
    for (const stableId of stableIds) {
      if (typeof stableId !== 'string' || !stableId) {
        throw new TypeError('canonical Stable IDs must be non-empty strings');
      }
      record.canonicalStableIds.add(stableId);
    }
    return frozenOwnerRecord(record, now());
  };

  const acknowledgeScene = ({ receipt, scene } = {}) => {
    if (!isCompletedRenderFrameReceipt(receipt)) return 0;
    let acknowledged = 0;
    const seen = new Set();
    visitSceneObject(scene, mesh => {
      if (!mesh?.geometry || !mesh?.material) return;
      const canonicalObjects = mesh.userData?.canonicalObjects ?? [];
      const opacities = mesh.userData?.canonicalOpacities ?? [];
      const coarseOwners = new Map();
      for (let slot = 0; slot < canonicalObjects.length; slot += 1) {
        const record = canonicalObjects[slot];
        const ownerKey = canonicalOwnerKey(record);
        if (!ownerKey || !records.has(ownerKey)) continue;
        const opacity = Number.isFinite(opacities[slot]) ? opacities[slot] : 1;
        if (opacity <= 0) continue;
        const instanceMatrix = matrixOffsetElements(mesh.instanceMatrix, slot);
        if (mesh.instanceMatrix && !isValidDrawableMatrix(instanceMatrix)) continue;
        const current = coarseOwners.get(ownerKey) ?? {
          opacity: 0,
          stableIds: [],
          matrix: instanceMatrix ?? mesh.matrixWorld ?? mesh.matrix,
        };
        current.opacity = Math.max(current.opacity, opacity);
        if (typeof record?.stableId === 'string') current.stableIds.push(record.stableId);
        coarseOwners.set(ownerKey, current);
      }
      for (const [ownerKey, value] of coarseOwners) {
        const key = `coarse\n${ownerKey}`;
        if (seen.has(key)) continue;
        if (value.stableIds.length > 0) addCanonicalIdentities({ ownerKey, stableIds: value.stableIds });
        if (acknowledgeDrawable({
          ownerKey,
          level: 'coarse',
          receipt,
          drawable: {
            mesh,
            effectiveOpacity: value.opacity,
            matrix: value.matrix,
          },
        })) {
          seen.add(key);
          acknowledged += 1;
        }
      }

      if (canonicalObjects.length > 0) return;
      const ownerKey = inheritedChunkOwnerKey(mesh);
      const key = `detail\n${ownerKey}`;
      if (!ownerKey || !records.has(ownerKey)) return;

      // Near Natural is a representation of the same canonical owner/Stable
      // IDs, not another lifecycle. Record it only after its actual instanced
      // slots have participated in this completed renderer frame.
      const nearStableIds = new Set(mesh.userData?.treeStableIds ?? []);
      const featureStableIds = mesh.userData?.featureStableIds ?? [];
      const drawableNearStableIds = [];
      const slotCount = Math.min(
        Number.isSafeInteger(mesh.count) ? mesh.count : featureStableIds.length,
        featureStableIds.length,
      );
      for (let slot = 0; slot < slotCount; slot += 1) {
        const stableId = featureStableIds[slot];
        if (!nearStableIds.has(stableId)) continue;
        const matrix = matrixOffsetElements(mesh.instanceMatrix, slot);
        if (!isValidDrawableMatrix(matrix)) continue;
        if (isDrawableInCompletedFrame({ mesh, receipt, matrix })) {
          drawableNearStableIds.push(stableId);
        }
      }
      if (drawableNearStableIds.length > 0) {
        addCanonicalIdentities({ ownerKey, stableIds: drawableNearStableIds });
        if (records.get(ownerKey).nearRepresentationAvailableAt === null) {
          markRepresentationAvailable({
            ownerKey,
            representation: 'near',
            at: receipt.completedAtMs,
          });
        }
      }

      if (seen.has(key)) return;
      if (acknowledgeDrawable({
        ownerKey,
        level: 'detail',
        receipt,
        drawable: { mesh, matrix: mesh.matrixWorld ?? mesh.matrix },
      })) {
        seen.add(key);
        acknowledged += 1;
      }
    });
    return acknowledged;
  };

  const retire = ({ ownerKey, at = now() } = {}) => {
    const record = get(ownerKey);
    if (!record) return false;
    record.retiringAt ??= finiteTime(at, 'retiringAt');
    record.state = VISUAL_CONTINUITY_STATE.RETIRING;
    emit('retiring', record);
    return true;
  };

  const pruneRetired = ({ maximumRecords = 4096 } = {}) => {
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 0) {
      throw new RangeError('maximumRecords must be a non-negative safe integer');
    }
    if (records.size <= maximumRecords) return 0;
    let removed = 0;
    const candidates = [...records.values()]
      .filter(record => record.state === VISUAL_CONTINUITY_STATE.RETIRING)
      .sort((left, right) => (left.retiringAt ?? 0) - (right.retiringAt ?? 0)
        || left.sequence - right.sequence);
    for (const record of candidates) {
      if (records.size <= maximumRecords) break;
      records.delete(record.ownerKey);
      removed += 1;
    }
    return removed;
  };

  const snapshot = ({ at = now() } = {}) => {
    const timestamp = finiteTime(at, 'snapshot at');
    const owners = [...records.values()].map(record => frozenOwnerRecord(record, timestamp));
    const expected = owners.filter(owner => owner.state !== VISUAL_CONTINUITY_STATE.RETIRING);
    const missing = expected.filter(owner => owner.coarseDrawableAt === null);
    const coarse = expected.filter(owner => owner.coarseDrawableAt !== null);
    const detail = expected.filter(owner => owner.detailDrawableAt !== null);
    const latencyPopulation = expected.map(owner => Math.max(
      0,
      (owner.coarseDrawableAt ?? timestamp) - owner.expectedAt,
    ));
    const queueAges = missing.filter(owner => owner.visualWorkStartedAt === null).map(owner => (
      Math.max(0, timestamp - (owner.requestAt ?? owner.expectedAt))
    ));
    return Object.freeze({
      schemaVersion: VISUAL_CONTINUITY_REGISTRY_SCHEMA,
      expectedOwnerCount: expected.length,
      coarseDrawableCount: coarse.length,
      detailDrawableCount: detail.length,
      deadlineMissCount: expected.filter(owner => owner.deadlineMiss).length,
      oldestMissingAgeMs: missing.length === 0 ? 0 : Math.max(
        ...missing.map(owner => timestamp - owner.expectedAt),
      ),
      maxDeadlineMissMs: expected.length === 0 ? 0 : Math.max(
        ...expected.map(owner => owner.deadlineMissMs),
      ),
      queueAgeMs: queueAges.length === 0 ? 0 : Math.max(...queueAges),
      actualDrawableLatencyMs: Object.freeze({
        count: latencyPopulation.length,
        p50: percentile(latencyPopulation, 0.5),
        p95: percentile(latencyPopulation, 0.95),
        max: latencyPopulation.length === 0 ? 0 : Math.max(...latencyPopulation),
        includesMissingOwners: true,
      }),
      owners: Object.freeze(owners.sort((left, right) => left.sequence - right.sequence)),
    });
  };

  return Object.freeze({
    expect,
    get: ownerKey => {
      const record = get(ownerKey);
      return record ? frozenOwnerRecord(record, now()) : null;
    },
    recordPipelineStage,
    markRepresentationAvailable,
    addCanonicalIdentities,
    acknowledgeDrawable,
    acknowledgeScene,
    retire,
    pruneRetired,
    deleteRetired: ownerKey => {
      const record = get(ownerKey);
      return record?.state === VISUAL_CONTINUITY_STATE.RETIRING
        ? records.delete(record.ownerKey) : false;
    },
    snapshot,
    clear: () => records.clear(),
  });
}

/** Foundation primitive for applying the old-until-new-drawable barrier uniformly. */
export function createDrawableReplacementBarrier({
  visualRegistry,
  disposeDrawable = drawable => drawable?.dispose?.(),
} = {}) {
  if (typeof visualRegistry?.acknowledgeDrawable !== 'function') {
    throw new TypeError('visualRegistry is required');
  }
  if (typeof disposeDrawable !== 'function') throw new TypeError('disposeDrawable is required');
  const retained = new Map();
  return Object.freeze({
    retain({ ownerKey, drawable } = {}) {
      retained.set(ownerIdentity(ownerKey), drawable);
      return true;
    },
    acknowledgeReplacement({ ownerKey, level = 'detail', receipt, drawable } = {}) {
      const key = ownerIdentity(ownerKey);
      if (!visualRegistry.acknowledgeDrawable({ ownerKey: key, level, receipt, drawable })) {
        return false;
      }
      const previous = retained.get(key);
      if (previous) disposeDrawable(previous);
      retained.delete(key);
      return true;
    },
    release(ownerKey) {
      const key = ownerIdentity(ownerKey);
      const drawable = retained.get(key);
      if (!drawable) return false;
      disposeDrawable(drawable);
      retained.delete(key);
      return true;
    },
    snapshot: () => Object.freeze({
      retainedOwnerCount: retained.size,
      retainedOwnerKeys: Object.freeze([...retained.keys()]),
    }),
  });
}
