import { LOGICAL_CHUNK_SIZE_METERS } from './chunk-coordinates.js';

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

function rendererAttributeRecord(renderer, attribute) {
  try {
    return renderer?.attributes?.get?.(attribute) ?? null;
  } catch {
    return null;
  }
}

function rendererAttributeVersion(renderer, attribute) {
  const version = rendererAttributeRecord(renderer, attribute)?.version;
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}

function installAttributeUploadProbe(attribute, probe) {
  if (!attribute || typeof probe !== 'function') return null;
  const previous = typeof attribute.onUploadCallback === 'function'
    ? attribute.onUploadCallback : null;
  // Three r160 keeps WebGLAttributes private, but BufferAttribute's documented
  // upload callback runs after bufferData/bufferSubData. Chain it for the one
  // render frame being observed, then restore the original callback.
  const callback = function rendererGpuMirrorUploadProbe(...args) {
    probe(attributeVersion(attribute));
    return previous?.apply(this, args);
  };
  try {
    if (typeof attribute.onUpload === 'function') attribute.onUpload(callback);
    else {
      // Some test/adapter attributes are intentionally frozen and expose the
      // renderer's public upload-version record instead. They cannot host a
      // callback probe, but completeFrame can still confirm that path.
      if (!Object.isExtensible(attribute)) return null;
      attribute.onUploadCallback = callback;
    }
  } catch {
    return null;
  }
  return () => {
    if (attribute.onUploadCallback === callback) {
      if (typeof attribute.onUpload === 'function') {
        attribute.onUpload(previous ?? function noRendererUploadCallback() {});
      } else attribute.onUploadCallback = previous ?? function noRendererUploadCallback() {};
    }
  };
}

function canonicalOwnerKey(record) {
  const coordinate = record?.owningChunkCoordinate;
  if (Number.isSafeInteger(coordinate?.x) && Number.isSafeInteger(coordinate?.z)) {
    return `${coordinate.x},${coordinate.z}`;
  }
  const compactOwner = record?.owner ?? record?.ownerKey ?? null;
  if (typeof compactOwner === 'string' && compactOwner) return compactOwner;
  return Number.isSafeInteger(compactOwner?.x) && Number.isSafeInteger(compactOwner?.z)
    ? `${compactOwner.x},${compactOwner.z}` : null;
}

function stableIdFrom(value) {
  return typeof value === 'string' ? value : value?.stableId;
}

function stableIdSet(values, label) {
  if (values === null || values === undefined) return new Set();
  if (typeof values === 'string' || typeof values?.[Symbol.iterator] !== 'function') {
    throw new TypeError(`${label} must be an iterable of Stable IDs`);
  }
  const stableIds = new Set();
  for (const value of values) {
    const stableId = stableIdFrom(value);
    if (typeof stableId !== 'string' || !stableId) {
      throw new TypeError(`${label} must contain non-empty Stable IDs`);
    }
    stableIds.add(stableId);
  }
  return stableIds;
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function isCanonicalStructure(record) {
  return record?.objectType === 'building'
    || record?.objectType === 'road'
    || record?.featureType === 'settlement-building'
    || record?.featureType === 'settlement-road';
}

function isCanonicalForestTree(record) {
  return record?.objectType === 'tree'
    || record?.featureType === 'tree'
    || record?.canonicalType === 'tree'
    || record?.presentation?.objectType === 'tree';
}

function terrainLodBand(mesh) {
  if (mesh?.userData?.logicalTerrainSurface !== true) return null;
  const band = String(mesh.userData?.terrainLodBand ?? '').toLowerCase();
  return band === 'high' || band === 'medium' || band === 'low' ? band : null;
}

function ownerKeySet(values, label) {
  if (values === null || values === undefined) return null;
  const source = typeof values === 'string' ? [values] : values;
  if (typeof source?.[Symbol.iterator] !== 'function') {
    throw new TypeError(`${label} must be an iterable of owner keys`);
  }
  const result = new Set();
  for (const value of source) result.add(ownerIdentity(value));
  return result;
}

function embeddedTerrainOwnerKeys(mesh) {
  const visible = mesh?.userData?.visibleOwnerKeys;
  const owners = visible && typeof visible[Symbol.iterator] === 'function'
    ? visible : mesh?.userData?.ownerKeys;
  if (!owners || typeof owners[Symbol.iterator] !== 'function') return new Set();
  return new Set([...owners].filter(value => typeof value === 'string' && value));
}

function numericArray(values) {
  return ArrayBuffer.isView(values) || Array.isArray(values) ? values : null;
}

const terrainGpuGeometryValidationCache = new WeakMap();

function validTerrainGpuGeometry(mesh, receipt) {
  const positionAttribute = mesh?.geometry?.attributes?.position;
  const colorAttribute = mesh?.geometry?.attributes?.color;
  const indexAttribute = mesh?.geometry?.index;
  if (!positionAttribute || !colorAttribute || !indexAttribute) return false;
  const position = numericArray(gpuPreferredAttributeArray(positionAttribute, receipt));
  const color = numericArray(gpuPreferredAttributeArray(colorAttribute, receipt));
  const index = numericArray(gpuPreferredAttributeArray(indexAttribute, receipt));
  const cacheKey = mesh.geometry;
  const cached = terrainGpuGeometryValidationCache.get(cacheKey);
  const cacheMatches = cached?.gpuMirror === receipt.gpuMirror
    && cached.positionAttribute === positionAttribute
    && cached.colorAttribute === colorAttribute
    && cached.indexAttribute === indexAttribute
    && cached.positionVersion === positionAttribute.version
    && cached.colorVersion === colorAttribute.version
    && cached.indexVersion === indexAttribute.version
    && cached.positionLength === position?.length
    && cached.colorLength === color?.length
    && cached.indexLength === index?.length;
  let validContent = cacheMatches ? cached.validContent : false;
  if (!cacheMatches) {
    validContent = Boolean(position && color && index && position.length >= 9
      && position.length % 3 === 0 && color.length === position.length
      && index.length >= 3 && index.length % 3 === 0);
    for (const values of validContent ? [position, color, index] : []) {
      for (let offset = 0; offset < values.length; offset += 1) {
        if (!Number.isFinite(values[offset])) {
          validContent = false;
          break;
        }
      }
      if (!validContent) break;
    }
    const vertexCount = validContent ? position.length / 3 : 0;
    for (let offset = 0; validContent && offset < color.length; offset += 3) {
      if (color[offset] === 0 && color[offset + 1] === 0 && color[offset + 2] === 0) {
        validContent = false;
      }
    }
    let nonDegenerateTriangle = false;
    for (let offset = 0; validContent && offset < index.length; offset += 3) {
      const a = Number(index[offset]);
      const b = Number(index[offset + 1]);
      const c = Number(index[offset + 2]);
      if (![a, b, c].every(value => Number.isSafeInteger(value)
        && value >= 0 && value < vertexCount) || a === b || b === c || a === c) {
        validContent = false;
        break;
      }
      const ax = position[a * 3]; const ay = position[a * 3 + 1]; const az = position[a * 3 + 2];
      const abx = position[b * 3] - ax; const aby = position[b * 3 + 1] - ay;
      const abz = position[b * 3 + 2] - az;
      const acx = position[c * 3] - ax; const acy = position[c * 3 + 1] - ay;
      const acz = position[c * 3 + 2] - az;
      const crossX = aby * acz - abz * acy;
      const crossY = abz * acx - abx * acz;
      const crossZ = abx * acy - aby * acx;
      nonDegenerateTriangle ||= Math.hypot(crossX, crossY, crossZ) > Number.EPSILON;
    }
    validContent &&= nonDegenerateTriangle;
    terrainGpuGeometryValidationCache.set(cacheKey, {
      gpuMirror: receipt.gpuMirror,
      positionAttribute,
      colorAttribute,
      indexAttribute,
      positionVersion: positionAttribute.version,
      colorVersion: colorAttribute.version,
      indexVersion: indexAttribute.version,
      positionLength: position?.length ?? null,
      colorLength: color?.length ?? null,
      indexLength: index?.length ?? null,
      validContent,
    });
  }
  return validContent && isDrawableInCompletedFrame({
    mesh,
    receipt,
    requiredAttributes: [positionAttribute, colorAttribute, indexAttribute],
  });
}

function normalizedLowTerrainAnnulus(value, mesh) {
  if (!value || typeof value !== 'object') return null;
  const centerWorldX = Number(value.centerWorldX);
  const centerWorldZ = Number(value.centerWorldZ);
  const innerBoundaryMeters = Number(value.innerBoundaryMeters);
  const outerBoundaryMeters = Number(value.outerBoundaryMeters);
  if (![centerWorldX, centerWorldZ, innerBoundaryMeters, outerBoundaryMeters]
    .every(Number.isFinite) || innerBoundaryMeters < 0
    || outerBoundaryMeters <= innerBoundaryMeters) return null;
  if (Number(mesh?.userData?.innerCellBoundaryMeters) !== innerBoundaryMeters
    || Number(mesh?.userData?.outerCellBoundaryMeters) !== outerBoundaryMeters) return null;
  return Object.freeze({ centerWorldX, centerWorldZ, innerBoundaryMeters, outerBoundaryMeters });
}

function ownerAabbInsideLowTerrainAnnulus(ownerKey, annulus) {
  const coordinates = String(ownerKey).split(',');
  if (coordinates.length !== 2) return false;
  const chunkX = Number(coordinates[0]);
  const chunkZ = Number(coordinates[1]);
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) return false;
  const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const maximumX = minimumX + LOGICAL_CHUNK_SIZE_METERS;
  const maximumZ = minimumZ + LOGICAL_CHUNK_SIZE_METERS;
  const outerMinimumX = annulus.centerWorldX - annulus.outerBoundaryMeters;
  const outerMaximumX = annulus.centerWorldX + annulus.outerBoundaryMeters;
  const outerMinimumZ = annulus.centerWorldZ - annulus.outerBoundaryMeters;
  const outerMaximumZ = annulus.centerWorldZ + annulus.outerBoundaryMeters;
  const insideOuter = minimumX >= outerMinimumX && maximumX <= outerMaximumX
    && minimumZ >= outerMinimumZ && maximumZ <= outerMaximumZ;
  const innerMinimumX = annulus.centerWorldX - annulus.innerBoundaryMeters;
  const innerMaximumX = annulus.centerWorldX + annulus.innerBoundaryMeters;
  const innerMinimumZ = annulus.centerWorldZ - annulus.innerBoundaryMeters;
  const innerMaximumZ = annulus.centerWorldZ + annulus.innerBoundaryMeters;
  const outsideInnerHole = maximumX <= innerMinimumX || minimumX >= innerMaximumX
    || maximumZ <= innerMinimumZ || minimumZ >= innerMaximumZ;
  return insideOuter && outsideInnerHole;
}

function gpuPreferredAttributeArray(attribute, receipt) {
  return receipt?.gpuMirror?.read?.(attribute) ?? attributeArray(attribute);
}

function attributeSlotComponent(attribute, slot, component, receipt) {
  const values = gpuPreferredAttributeArray(attribute, receipt);
  const itemSize = Number.isSafeInteger(attribute?.itemSize) && attribute.itemSize > 0
    ? attribute.itemSize : 1;
  const index = slot * itemSize + component;
  return values && index >= 0 && index < values.length ? Number(values[index]) : Number.NaN;
}

function naturalLodMaterials(material) {
  const materials = Array.isArray(material) ? material : [material];
  return materials.filter(value => value?.userData?.naturalLodUniforms);
}

function uniformNumber(uniforms, name) {
  return Number(uniforms?.[name]?.value);
}

function smoothstep(edge0, edge1, value) {
  if (![edge0, edge1, value].every(Number.isFinite)) return Number.NaN;
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const progress = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return progress * progress * (3 - 2 * progress);
}

function forestShaderOpacity(mesh, slot, receipt) {
  const materials = naturalLodMaterials(mesh?.material);
  if (materials.length === 0) return 1;

  const anchorAttribute = mesh?.geometry?.attributes?.w8NaturalAnchorXZ;
  const revealAttribute = mesh?.geometry?.attributes?.w8NaturalInitialReveal;
  if (!anchorAttribute || !revealAttribute) return 0;
  const anchorX = attributeSlotComponent(anchorAttribute, slot, 0, receipt);
  const anchorZ = attributeSlotComponent(anchorAttribute, slot, 1, receipt);
  const initialReveal = attributeSlotComponent(revealAttribute, slot, 0, receipt);
  if (![anchorX, anchorZ, initialReveal].every(Number.isFinite)) return 0;

  let maximumOpacity = 0;
  for (const material of materials) {
    const uniforms = material.userData.naturalLodUniforms;
    const player = uniforms.w8NaturalPlayerLocalXZ?.value;
    const playerX = Number(player?.x);
    const playerZ = Number(player?.y ?? player?.z);
    const unitsPerMeter = uniformNumber(uniforms, 'w8NaturalUnitsPerMeter');
    const enterStart = uniformNumber(uniforms, 'w8NaturalEnterStart');
    const enterEnd = uniformNumber(uniforms, 'w8NaturalEnterEnd');
    const exitStart = uniformNumber(uniforms, 'w8NaturalExitStart');
    const exitEnd = uniformNumber(uniforms, 'w8NaturalExitEnd');
    const reveal = uniformNumber(uniforms, 'w8NaturalReveal');
    if (![playerX, playerZ, unitsPerMeter, enterStart, enterEnd,
      exitStart, exitEnd, reveal].every(Number.isFinite) || unitsPerMeter <= 0) continue;

    const distanceMeters = Math.hypot(anchorX - playerX, anchorZ - playerZ) / unitsPerMeter;
    const mode = material.userData.naturalLodMode;
    const coarseMidTree = material.userData.canonicalCoarseTree === true && mode === 'forest';
    const entryOpacity = mode === 'full' || coarseMidTree
      ? 1 : smoothstep(enterStart, enterEnd, distanceMeters);
    const exitOpacity = 1 - smoothstep(exitStart, exitEnd, distanceMeters);
    const streamReveal = Math.max(Math.max(0, Math.min(1, initialReveal)), reveal);
    const handoffOpacity = initialReveal >= -0.5 ? 1 : 0;
    const shaderOpacity = entryOpacity * exitOpacity * streamReveal * handoffOpacity;
    if (Number.isFinite(shaderOpacity)) maximumOpacity = Math.max(maximumOpacity, shaderOpacity);
  }
  return maximumOpacity;
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
 * Shadows the renderer upload boundary without depending on an implementation
 * detail such as WebGLAttributes exposing the contents of a GPU buffer. Dirty
 * CPU ranges are captured before render, then become readable only when the
 * completed renderer reports the same uploaded attribute version.
 */
export function createRendererGpuAttributeMirror() {
  const mirrored = new WeakMap();
  let pendingFrame = null;
  let frameCount = 0;
  let attributeUploadCount = 0;
  let componentUploadCount = 0;

  const activeAttributeLength = (object, attribute, sourceLength) => {
    const count = Number.isSafeInteger(object?.count) && object.count >= 0
      ? object.count : null;
    if (count === null) return sourceLength;
    if (object.instanceMatrix === attribute) return Math.min(sourceLength, count * 16);
    if (object.instanceColor === attribute) {
      return Math.min(sourceLength, count * (attribute.itemSize ?? 3));
    }
    if (attribute?.isInstancedBufferAttribute === true
      || attribute?.constructor?.name === 'InstancedBufferAttribute') {
      return Math.min(sourceLength, count * (attribute.itemSize ?? 1));
    }
    return sourceLength;
  };

  const captureFrame = ({ scene = null, frameSequence = null } = {}) => {
    if (pendingFrame) throw new Error('a renderer GPU mirror frame is already pending');
    const captures = [];
    const observed = new Map();
    visitSceneObject(scene, object => {
      for (const attribute of drawableAttributes(object)) {
        const source = attributeArray(attribute);
        if (!source) continue;
        const activeLength = activeAttributeLength(object, attribute, source.length);
        const previous = observed.get(attribute);
        if (previous) {
          previous.activeLength = Math.max(previous.activeLength, activeLength);
          continue;
        }
        observed.set(attribute, { source, activeLength });
      }
    });
    for (const [attribute, observation] of observed) {
        const { source, activeLength } = observation;
        const version = attributeVersion(attribute);
        const target = mirrored.get(attribute);
        const initial = !target || target.values.length !== source.length;
        if (initial || target.version !== version || attribute.needsUpdate === true) {
          let uploadedVersion = null;
          const restoreUploadProbe = installAttributeUploadProbe(
            attribute,
            value => { uploadedVersion = value; },
          );
          const ranges = initial
            ? Object.freeze([{ offset: 0, count: source.length }])
            : attributeUpdateRanges(attribute, source.length);
          captures.push(Object.freeze({
            attribute,
            version,
            length: source.length,
            activeLength,
            sourceConstructor: source.constructor,
            uploadedVersion: () => uploadedVersion,
            restoreUploadProbe,
            ranges: Object.freeze(ranges.map(({ offset, count }) => Object.freeze({
              offset,
              count,
              values: typeof source.slice === 'function'
                ? source.slice(offset, offset + count)
                : Array.from(source).slice(offset, offset + count),
            }))),
          }));
        }
    }
    pendingFrame = Object.freeze({
      frameSequence,
      captures: Object.freeze(captures),
      activeLengths: Object.freeze([...observed].map(([attribute, value]) => (
        Object.freeze({ attribute, activeLength: value.activeLength })
      ))),
    });
    return Object.freeze({
      frameSequence,
      visitedAttributeCount: observed.size,
      capturedAttributeCount: captures.length,
    });
  };

  const completeFrame = ({ renderer = null, frameSequence = null } = {}) => {
    if (!pendingFrame || (frameSequence !== null
      && pendingFrame.frameSequence !== null
      && frameSequence !== pendingFrame.frameSequence)) {
      throw new Error('renderer GPU mirror frame is not pending');
    }
    frameCount += 1;
    let committedAttributeCount = 0;
    let rejectedAttributeCount = 0;
    for (const capture of pendingFrame.captures) {
      const uploadedVersion = rendererAttributeVersion(renderer, capture.attribute)
        ?? capture.uploadedVersion();
      capture.restoreUploadProbe?.();
      if (uploadedVersion !== capture.version) {
        rejectedAttributeCount += 1;
        continue;
      }
      let target = mirrored.get(capture.attribute);
      if (!target || target.values.length !== capture.length) {
        target = {
          values: new capture.sourceConstructor(capture.length),
          version: -1,
          uploadedAtFrame: 0,
          activeLength: 0,
          matchedAtFrame: -1,
          matchResult: false,
        };
      }
      for (const { offset, count, values } of capture.ranges) {
        if (typeof target.values.set === 'function') target.values.set(values, offset);
        else {
          for (let index = 0; index < count; index += 1) {
            target.values[offset + index] = values[index];
          }
        }
        componentUploadCount += count;
      }
      target.version = capture.version;
      target.uploadedAtFrame = frameCount;
      target.activeLength = capture.activeLength;
      target.matchedAtFrame = -1;
      target.matchResult = false;
      mirrored.set(capture.attribute, target);
      committedAttributeCount += 1;
      attributeUploadCount += 1;
    }
    for (const { attribute, activeLength } of pendingFrame.activeLengths) {
      const target = mirrored.get(attribute);
      if (!target) continue;
      const uploadedVersion = rendererAttributeVersion(renderer, attribute);
      // Unchanged attributes do not invoke onUploadCallback again. A prior
      // renderer-confirmed shadow remains valid while its CPU version is the
      // same; a changed version always has a capture and must be confirmed above.
      if (uploadedVersion !== null && uploadedVersion !== target.version) continue;
      if (attributeVersion(attribute) !== target.version) continue;
      if (target.activeLength !== activeLength) {
        target.activeLength = activeLength;
        target.matchedAtFrame = -1;
      }
    }
    const capturedAttributeCount = pendingFrame.captures.length;
    pendingFrame = null;
    return Object.freeze({
      frameCount,
      capturedAttributeCount,
      committedAttributeCount,
      rejectedAttributeCount,
    });
  };

  const abortFrame = () => {
    if (!pendingFrame) return false;
    for (const capture of pendingFrame.captures) capture.restoreUploadProbe?.();
    pendingFrame = null;
    return true;
  };

  const matches = attribute => {
    const source = attributeArray(attribute);
    const target = mirrored.get(attribute);
    if (!source || !target || target.values.length !== source.length
      || target.version !== attributeVersion(attribute)) return false;
    if (target.matchedAtFrame === frameCount) return target.matchResult;
    let equal = true;
    // Instanced attributes reserve the maximum pool capacity, while WebGL
    // submits only the dense [0, mesh.count) prefix. Comparing unused capacity
    // turned receipt acknowledgement back into a multi-million-component full
    // scan on every ordinary frame. The captured active length is the exact
    // renderer-visible domain; non-instanced geometry still compares in full.
    const comparedLength = Math.min(source.length, target.activeLength ?? source.length);
    for (let index = 0; index < comparedLength; index += 1) {
      if (!Object.is(target.values[index], source[index])) {
        equal = false;
        break;
      }
    }
    target.matchedAtFrame = frameCount;
    target.matchResult = equal;
    return equal;
  };

  return Object.freeze({
    schemaVersion: GPU_ATTRIBUTE_MIRROR_SCHEMA,
    captureFrame,
    completeFrame,
    abortFrame,
    matches,
    read: attribute => {
      const target = mirrored.get(attribute);
      return target?.values ?? null;
    },
    snapshot: () => Object.freeze({
      schemaVersion: GPU_ATTRIBUTE_MIRROR_SCHEMA,
      frameCount,
      pending: pendingFrame !== null,
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
  const stagedGpuMirror = gpuMirror !== null
    && typeof gpuMirror.captureFrame === 'function'
    && typeof gpuMirror.completeFrame === 'function';
  if (gpuMirror !== null && !stagedGpuMirror && typeof gpuMirror.uploadFrame !== 'function') {
    throw new TypeError('gpuMirror must implement uploadFrame or captureFrame/completeFrame');
  }
  let sequence = 0;
  let active = null;
  let completedFrameCount = 0;

  const beginFrame = ({ frameSequence = ++sequence, scene = null } = {}) => {
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
    if (stagedGpuMirror) {
      try {
        gpuMirror.captureFrame({ scene, frameSequence });
      } catch (error) {
        active = null;
        throw error;
      }
    }
    return active;
  };

  const completeFrame = (token, { scene = null, renderer = null } = {}) => {
    if (token !== active || token?.[FRAME_TOKEN] !== true) {
      throw new Error('render frame token is not active');
    }
    const completedAtMs = finiteTime(Number(clock()), 'render frame completion');
    const gpuFrame = stagedGpuMirror
      ? gpuMirror.completeFrame({ scene, renderer, frameSequence: token.frameSequence })
      : gpuMirror?.uploadFrame({ scene, renderer, frameSequence: token.frameSequence }) ?? null;
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
    if (stagedGpuMirror) gpuMirror.abortFrame?.({ frameSequence: token.frameSequence });
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
  if (values === null || values.length < 16
    || !Array.from(values).slice(0, 16).every(Number.isFinite)) return false;
  // A finite but zero-scale instance reaches the draw call while producing no
  // visible fragments. It therefore cannot be renderer evidence for a visual
  // component.
  return Math.hypot(values[0], values[1], values[2]) > Number.EPSILON
    && Math.hypot(values[4], values[5], values[6]) > Number.EPSILON
    && Math.hypot(values[8], values[9], values[10]) > Number.EPSILON;
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

function requiredComponentComplete(requiredStableIds, drawnAtByStableId) {
  return [...requiredStableIds].every(stableId => drawnAtByStableId.has(stableId));
}

function requiredComponentCompletedAt(requiredStableIds, drawnAtByStableId) {
  if (requiredStableIds.size === 0
    || !requiredComponentComplete(requiredStableIds, drawnAtByStableId)) return null;
  return Math.max(...[...requiredStableIds].map(stableId => drawnAtByStableId.get(stableId)));
}

function coarseRequirementsComplete(record) {
  return record.coarseRequirementsResolvedAt !== null
    && (!record.terrainRequired || record.terrainDrawableAt !== null)
    && requiredComponentComplete(
      record.requiredStructureStableIds,
      record.structureDrawnAtByStableId,
    )
    && requiredComponentComplete(
      record.requiredForestStableIds,
      record.forestDrawnAtByStableId,
    );
}

function componentSnapshotMetric(samples, nowMs) {
  const drawn = samples.filter(sample => sample.actualDrawableAt !== null);
  const missing = samples.filter(sample => sample.actualDrawableAt === null);
  const latencies = samples.map(sample => Math.max(
    0,
    (sample.actualDrawableAt ?? nowMs) - sample.expectedAt,
  ));
  const misses = samples.map(sample => sample.deadlineAtMs === null ? 0 : Math.max(
    0,
    (sample.actualDrawableAt ?? nowMs) - sample.deadlineAtMs,
  ));
  return Object.freeze({
    requiredCount: samples.length,
    requiredOwnerCount: new Set(samples.map(sample => sample.ownerKey)).size,
    drawableCount: drawn.length,
    drawableOwnerCount: new Set(drawn.map(sample => sample.ownerKey)).size,
    missingCount: missing.length,
    deadlineMissCount: misses.filter(value => value > 0).length,
    oldestMissingAgeMs: missing.length === 0 ? 0 : Math.max(
      ...missing.map(sample => nowMs - sample.expectedAt),
    ),
    maxDeadlineMissMs: misses.length === 0 ? 0 : Math.max(...misses),
    actualDrawableLatencyMs: Object.freeze({
      count: latencies.length,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length === 0 ? 0 : Math.max(...latencies),
      includesMissingComponents: true,
    }),
  });
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
    coarseRequirementsResolvedAt: record.coarseRequirementsResolvedAt,
    coarseRequirementsComplete: coarseRequirementsComplete(record),
    terrainRequired: record.terrainRequired,
    forestRequired: record.requiredForestStableIds.size > 0,
    requiredStructureStableIds: Object.freeze([...record.requiredStructureStableIds].sort()),
    requiredForestStableIds: Object.freeze([...record.requiredForestStableIds].sort()),
    destroyedStableIdsExcludedFromCoarse: Object.freeze([
      ...record.destroyedExcludedCoarseStableIds,
    ].sort()),
    destroyedRequirementExclusions: Object.freeze([
      ...record.destroyedExcludedCoarseStableIds,
    ].sort().map(stableId => Object.freeze({
      stableId,
      excludedAt: record.destroyedStableIds.get(stableId),
    }))),
    terrainDrawableAt: record.terrainDrawableAt,
    terrainComponentDraw: record.terrainComponentDraw === null ? null : Object.freeze({
      ...record.terrainComponentDraw,
    }),
    structureCoarseDrawableAt: requiredComponentCompletedAt(
      record.requiredStructureStableIds,
      record.structureDrawnAtByStableId,
    ),
    forestCoarseDrawableAt: requiredComponentCompletedAt(
      record.requiredForestStableIds,
      record.forestDrawnAtByStableId,
    ),
    drawnStructureStableIds: Object.freeze([...record.requiredStructureStableIds]
      .filter(stableId => record.structureDrawnAtByStableId.has(stableId)).sort()),
    drawnForestStableIds: Object.freeze([...record.requiredForestStableIds]
      .filter(stableId => record.forestDrawnAtByStableId.has(stableId)).sort()),
    structureComponentDraws: Object.freeze([...record.structureDrawnAtByStableId]
      .filter(([stableId]) => record.requiredStructureStableIds.has(stableId))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([stableId, actualDrawableAt]) => Object.freeze({
        stableId,
        actualDrawableAt,
        gpuUploadedAt: record.structureDrawEvidenceByStableId.get(stableId)?.gpuUploadedAt
          ?? actualDrawableAt,
        rendererFrameSequence: record.structureDrawEvidenceByStableId
          .get(stableId)?.rendererFrameSequence ?? null,
      }))),
    forestComponentDraws: Object.freeze([...record.forestDrawnAtByStableId]
      .filter(([stableId]) => record.requiredForestStableIds.has(stableId))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([stableId, actualDrawableAt]) => Object.freeze({
        stableId,
        actualDrawableAt,
        gpuUploadedAt: record.forestDrawEvidenceByStableId.get(stableId)?.gpuUploadedAt
          ?? actualDrawableAt,
        rendererFrameSequence: record.forestDrawEvidenceByStableId
          .get(stableId)?.rendererFrameSequence ?? null,
      }))),
    pendingDetailDrawableAt: record.pendingDetailDrawableAt,
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
  let coarseRequirementRevision = 0;
  const canonicalCoarseTreeReceiptCache = new WeakMap();
  let canonicalCoarseTreeSlotScanCount = 0;
  let canonicalCoarseTreeSlotScanEarlyOutCount = 0;
  const treeEverPresentedStableIds = new Set();
  let treeZeroPresenterFrameCount = 0;
  let treeDuplicatePresenterFrameCount = 0;
  let treeDuplicateCoarsePresenterFrameCount = 0;
  let terrainDisappearanceFrameCount = 0;
  let structureDisappearanceFrameCount = 0;
  let forestDisappearanceFrameCount = 0;
  let coarseComponentEvidenceByReceipt = new WeakMap();
  const emptyCurrentReceiptCoarseComponentMetrics = () => {
    const emptyTerrain = Object.freeze({
      requiredCount: 0,
      drawableCount: 0,
      missingCount: 0,
      missingOwnerKeys: Object.freeze([]),
      disappearanceCount: 0,
      disappearanceOwnerKeys: Object.freeze([]),
      disappearanceFrameCount: 0,
    });
    const emptyStableIdComponent = () => Object.freeze({
      requiredCount: 0,
      drawableCount: 0,
      missingCount: 0,
      missingStableIds: Object.freeze([]),
      missingRequirements: Object.freeze([]),
      disappearanceCount: 0,
      disappearanceStableIds: Object.freeze([]),
      disappearanceRequirements: Object.freeze([]),
      disappearanceFrameCount: 0,
    });
    return Object.freeze({
      rendererFrameSequence: null,
      completedAtMs: null,
      requirementsResolvedOwnerCount: 0,
      requirementsUnresolvedOwnerCount: 0,
      terrain: emptyTerrain,
      structure: emptyStableIdComponent(),
      forest: emptyStableIdComponent(),
    });
  };
  let lastReceiptPresentation = Object.freeze({
    rendererFrameSequence: null,
    completedAtMs: null,
    actualComponentDrawCount: 0,
    acknowledgedOwnerKeys: Object.freeze([]),
    treePresenterCount: 0,
    treePresenterStableIds: Object.freeze([]),
    treeZeroPresenterRequiredCount: 0,
    treeDuplicatePresenterCount: 0,
    treeDuplicateStableIds: Object.freeze([]),
    treeDuplicateCoarsePresenterCount: 0,
    treeDuplicateCoarseStableIds: Object.freeze([]),
    treeZeroPresenterFrameCount: 0,
    treeDuplicatePresenterFrameCount: 0,
    treeDuplicateCoarsePresenterFrameCount: 0,
    currentReceiptCoarseComponentMetrics: emptyCurrentReceiptCoarseComponentMetrics(),
    scanErrorCount: 0,
  });

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
        coarseRequirementsResolvedAt: null,
        terrainRequired: true,
        requiredStructureStableIds: new Set(),
        requiredForestStableIds: new Set(),
        destroyedStableIds: new Map(),
        destroyedExcludedCoarseStableIds: new Set(),
        terrainDrawableAt: null,
        terrainComponentDraw: null,
        structureDrawnAtByStableId: new Map(),
        structureDrawEvidenceByStableId: new Map(),
        forestDrawnAtByStableId: new Map(),
        forestDrawEvidenceByStableId: new Map(),
        pendingDetailDrawableAt: null,
        coarseRepresentationAvailableAt: null,
        detailRepresentationAvailableAt: null,
        nearRepresentationAvailableAt: null,
      };
      records.set(key, record);
      coarseRequirementRevision += 1;
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

  const promoteWhenCoarseComplete = record => {
    if (record.coarseDrawableAt !== null || !coarseRequirementsComplete(record)) return false;
    const componentDrawTimes = [
      ...(record.terrainRequired ? [record.terrainDrawableAt] : []),
      ...[...record.requiredStructureStableIds]
        .map(stableId => record.structureDrawnAtByStableId.get(stableId)),
      ...[...record.requiredForestStableIds]
        .map(stableId => record.forestDrawnAtByStableId.get(stableId)),
      ...[...record.destroyedExcludedCoarseStableIds]
        .map(stableId => record.destroyedStableIds.get(stableId)),
    ].filter(Number.isFinite);
    if (componentDrawTimes.length === 0) return false;
    record.coarseDrawableAt = Math.max(...componentDrawTimes);
    record.state = VISUAL_CONTINUITY_STATE.COARSE_DRAWABLE;
    emit('coarse-drawable', record);
    if (record.pendingDetailDrawableAt !== null) {
      record.detailDrawableAt = Math.max(
        record.coarseDrawableAt,
        record.pendingDetailDrawableAt,
      );
      record.state = VISUAL_CONTINUITY_STATE.DETAIL_DRAWABLE;
      emit('detail-drawable', record);
    }
    return true;
  };

  const resolveCoarseRequirements = (options = {}) => {
    const { ownerKey, summary = {}, at = now() } = options;
    const record = get(ownerKey);
    if (!record || record.state === VISUAL_CONTINUITY_STATE.RETIRING) {
      throw new Error(`visual owner is not Expected: ${ownerKey}`);
    }
    if (!summary || typeof summary !== 'object') {
      throw new TypeError('coarse requirement summary must be an object');
    }
    const terrainRequired = options.terrainRequired ?? summary.terrainRequired ?? true;
    if (terrainRequired !== true) {
      throw new RangeError('Terrain is required by the coarse visual contract');
    }
    const structureStableIds = stableIdSet(
      options.structureStableIds
        ?? summary.structureStableIds
        ?? summary.requiredStructureStableIds
        ?? summary.structures
        ?? [],
      'coarse structureStableIds',
    );
    const forestStableIds = stableIdSet(
      options.forestStableIds
        ?? summary.forestStableIds
        ?? summary.selectedForestStableIds
        ?? summary.requiredForestStableIds
        ?? summary.forest
        ?? [],
      'coarse forestStableIds',
    );
    const destroyedDeclaredStableIds = new Set([
      ...structureStableIds,
      ...forestStableIds,
    ].filter(stableId => record.destroyedStableIds.has(stableId)));
    for (const stableId of destroyedDeclaredStableIds) {
      structureStableIds.delete(stableId);
      forestStableIds.delete(stableId);
    }
    const timestamp = finiteTime(at, 'coarse requirements resolved at');
    if (record.coarseRequirementsResolvedAt !== null) {
      if (!setsEqual(record.requiredStructureStableIds, structureStableIds)
        || !setsEqual(record.requiredForestStableIds, forestStableIds)) {
        throw new Error(`coarse requirements already resolved for visual owner: ${ownerKey}`);
      }
      return frozenOwnerRecord(record, now());
    }
    record.coarseRequirementsResolvedAt = timestamp;
    coarseRequirementRevision += 1;
    record.terrainRequired = true;
    record.requiredStructureStableIds = structureStableIds;
    record.requiredForestStableIds = forestStableIds;
    for (const stableId of destroyedDeclaredStableIds) {
      record.destroyedExcludedCoarseStableIds.add(stableId);
    }
    for (const stableId of structureStableIds) record.canonicalStableIds.add(stableId);
    for (const stableId of forestStableIds) record.canonicalStableIds.add(stableId);
    for (const stableId of destroyedDeclaredStableIds) record.canonicalStableIds.add(stableId);
    emit('coarse-requirements-resolved', record);
    promoteWhenCoarseComplete(record);
    return frozenOwnerRecord(record, now());
  };

  // Destruction is authoritative gameplay state, not drawable evidence. Keep
  // it as an explicit requirement-domain update so an absent destroyed object
  // cannot strand its owner and cannot be mistaken for a renderer receipt.
  const excludeDestroyedStableIds = ({ ownerKey, stableIds = [], at = now() } = {}) => {
    const record = get(ownerKey);
    if (!record || record.state === VISUAL_CONTINUITY_STATE.RETIRING) return false;
    const excludedAt = finiteTime(at, 'destroyed requirement exclusion at');
    const destroyedStableIds = stableIdSet(stableIds, 'destroyed Stable IDs');
    if (destroyedStableIds.size === 0) return frozenOwnerRecord(record, now());
    let changed = false;
    for (const stableId of destroyedStableIds) {
      const previous = record.destroyedStableIds.get(stableId);
      record.destroyedStableIds.set(stableId, Math.min(previous ?? excludedAt, excludedAt));
      if (record.coarseRequirementsResolvedAt === null) continue;
      const structureDeclared = record.requiredStructureStableIds.delete(stableId);
      const forestDeclared = record.requiredForestStableIds.delete(stableId);
      const declared = structureDeclared || forestDeclared;
      if (!declared && !record.destroyedExcludedCoarseStableIds.has(stableId)) continue;
      record.destroyedExcludedCoarseStableIds.add(stableId);
      changed ||= declared;
    }
    if (changed) emit('destroyed-requirements-excluded', record);
    if (changed) coarseRequirementRevision += 1;
    promoteWhenCoarseComplete(record);
    return frozenOwnerRecord(record, now());
  };

  const coarseComponentReceiptEvidence = receipt => {
    let evidence = coarseComponentEvidenceByReceipt.get(receipt);
    if (evidence) return evidence;
    evidence = {
      terrainOwnerKeys: new Set(),
      structureStableIdsByOwner: new Map(),
      forestStableIdsByOwner: new Map(),
    };
    coarseComponentEvidenceByReceipt.set(receipt, evidence);
    return evidence;
  };

  const rememberCoarseComponentReceiptEvidence = ({
    record,
    component,
    stableIds,
    receipt,
  }) => {
    const evidence = coarseComponentReceiptEvidence(receipt);
    if (component === 'terrain') {
      evidence.terrainOwnerKeys.add(record.ownerKey);
      return;
    }
    const byOwner = component === 'structure'
      ? evidence.structureStableIdsByOwner : evidence.forestStableIdsByOwner;
    let ownerStableIds = byOwner.get(record.ownerKey);
    if (!ownerStableIds) {
      ownerStableIds = new Set();
      byOwner.set(record.ownerKey, ownerStableIds);
    }
    for (const stableId of stableIds) ownerStableIds.add(stableId);
  };

  const finalizeCurrentReceiptCoarseComponentMetrics = (receipt, evidence) => {
    const activeRecords = [...records.values()]
      .filter(record => record.state !== VISUAL_CONTINUITY_STATE.RETIRING);
    const resolvedRecords = activeRecords
      .filter(record => record.coarseRequirementsResolvedAt !== null);
    // Current missing includes owners still in their initial fill. The
    // cumulative counter advances only when that same requirement has already
    // crossed an earlier completed receipt, which makes the miss a real
    // presentation disappearance without reversing the owner's lifecycle.
    const missingTerrainRecords = resolvedRecords.filter(record => (
      record.terrainRequired && !evidence.terrainOwnerKeys.has(record.ownerKey)
    ));
    const terrainDisappearances = missingTerrainRecords
      .filter(record => record.terrainDrawableAt !== null);
    if (terrainDisappearances.length > 0) terrainDisappearanceFrameCount += 1;

    const stableIdComponentMetric = (component, frameCount) => {
      const requiredStableIdsField = component === 'structure'
        ? 'requiredStructureStableIds' : 'requiredForestStableIds';
      const drawnStableIdsField = component === 'structure'
        ? 'structureDrawnAtByStableId' : 'forestDrawnAtByStableId';
      const presentedByOwner = component === 'structure'
        ? evidence.structureStableIdsByOwner : evidence.forestStableIdsByOwner;
      const missing = resolvedRecords.flatMap(record => (
        [...record[requiredStableIdsField]]
          .filter(stableId => !presentedByOwner.get(record.ownerKey)?.has(stableId))
          .map(stableId => ({ record, ownerKey: record.ownerKey, stableId }))
      )).sort((left, right) => left.ownerKey.localeCompare(right.ownerKey)
        || left.stableId.localeCompare(right.stableId));
      const disappearances = missing.filter(({ record, stableId }) => (
        record[drawnStableIdsField].has(stableId)
      ));
      const freezeRequirements = requirements => Object.freeze(requirements.map(
        ({ ownerKey, stableId }) => Object.freeze({ ownerKey, stableId }),
      ));
      const requiredCount = resolvedRecords.reduce(
        (count, record) => count + record[requiredStableIdsField].size,
        0,
      );
      return Object.freeze({
        requiredCount,
        drawableCount: requiredCount - missing.length,
        missingCount: missing.length,
        missingStableIds: Object.freeze(missing.map(({ stableId }) => stableId)),
        missingRequirements: freezeRequirements(missing),
        disappearanceCount: disappearances.length,
        disappearanceStableIds: Object.freeze(
          disappearances.map(({ stableId }) => stableId),
        ),
        disappearanceRequirements: freezeRequirements(disappearances),
        disappearanceFrameCount: frameCount,
      });
    };

    const structureMissingBefore = resolvedRecords.some(record => (
      [...record.requiredStructureStableIds].some(stableId => (
        !evidence.structureStableIdsByOwner.get(record.ownerKey)?.has(stableId)
        && record.structureDrawnAtByStableId.has(stableId)
      ))
    ));
    const forestMissingBefore = resolvedRecords.some(record => (
      [...record.requiredForestStableIds].some(stableId => (
        !evidence.forestStableIdsByOwner.get(record.ownerKey)?.has(stableId)
        && record.forestDrawnAtByStableId.has(stableId)
      ))
    ));
    if (structureMissingBefore) structureDisappearanceFrameCount += 1;
    if (forestMissingBefore) forestDisappearanceFrameCount += 1;

    const missingTerrainOwnerKeys = Object.freeze(
      missingTerrainRecords.map(record => record.ownerKey).sort(),
    );
    const disappearanceOwnerKeys = Object.freeze(
      terrainDisappearances.map(record => record.ownerKey).sort(),
    );
    return Object.freeze({
      rendererFrameSequence: receipt.frameSequence,
      completedAtMs: receipt.completedAtMs,
      requirementsResolvedOwnerCount: resolvedRecords.length,
      requirementsUnresolvedOwnerCount: activeRecords.length - resolvedRecords.length,
      terrain: Object.freeze({
        requiredCount: resolvedRecords.filter(record => record.terrainRequired).length,
        drawableCount: resolvedRecords.filter(record => (
          record.terrainRequired && evidence.terrainOwnerKeys.has(record.ownerKey)
        )).length,
        missingCount: missingTerrainRecords.length,
        missingOwnerKeys: missingTerrainOwnerKeys,
        disappearanceCount: terrainDisappearances.length,
        disappearanceOwnerKeys,
        disappearanceFrameCount: terrainDisappearanceFrameCount,
      }),
      structure: stableIdComponentMetric(
        'structure',
        structureDisappearanceFrameCount,
      ),
      forest: stableIdComponentMetric('forest', forestDisappearanceFrameCount),
    });
  };

  const acknowledgeCoarseComponent = ({
    ownerKey,
    component,
    stableIds = [],
    receipt,
    drawable,
  } = {}) => {
    const record = get(ownerKey);
    if (!record || record.state === VISUAL_CONTINUITY_STATE.RETIRING) return false;
    const normalizedComponent = {
      terrain: 'terrain',
      structure: 'structure',
      structures: 'structure',
      forest: 'forest',
      tree: 'forest',
    }[component];
    if (!normalizedComponent) {
      throw new RangeError('coarse component must be terrain, structure, or forest');
    }
    const componentStableIds = normalizedComponent === 'terrain'
      ? new Set() : stableIdSet(stableIds, `${normalizedComponent} drawable Stable IDs`);
    if (normalizedComponent !== 'terrain' && componentStableIds.size === 0) return false;
    if (normalizedComponent !== 'terrain') {
      if (record.coarseRequirementsResolvedAt === null) return false;
      const requiredStableIds = normalizedComponent === 'structure'
        ? record.requiredStructureStableIds : record.requiredForestStableIds;
      for (const stableId of [...componentStableIds]) {
        if (!requiredStableIds.has(stableId)) componentStableIds.delete(stableId);
      }
      if (componentStableIds.size === 0) return false;
    }
    if (!isDrawableInCompletedFrame({ ...drawable, receipt })) return false;
    const timestamp = receipt.completedAtMs;
    const evidence = Object.freeze({
      actualDrawableAt: timestamp,
      gpuUploadedAt: timestamp,
      rendererFrameSequence: receipt.frameSequence,
    });
    rememberCoarseComponentReceiptEvidence({
      record,
      component: normalizedComponent,
      stableIds: componentStableIds,
      receipt,
    });
    if (normalizedComponent === 'terrain') {
      record.terrainDrawableAt ??= timestamp;
      record.terrainComponentDraw ??= Object.freeze({
        ...evidence,
        terrainLodBand: terrainLodBand(drawable?.mesh),
      });
    } else {
      const target = normalizedComponent === 'structure'
        ? record.structureDrawnAtByStableId : record.forestDrawnAtByStableId;
      const targetEvidence = normalizedComponent === 'structure'
        ? record.structureDrawEvidenceByStableId : record.forestDrawEvidenceByStableId;
      for (const stableId of componentStableIds) {
        const previous = target.get(stableId);
        target.set(stableId, Math.min(previous ?? timestamp, timestamp));
        if (previous === undefined || timestamp < previous) targetEvidence.set(stableId, evidence);
      }
    }
    record.lastActualDrawAt = Math.max(record.lastActualDrawAt ?? timestamp, timestamp);
    record.visualWorkStartedAt ??= timestamp;
    record.gpuUploadedAt ??= timestamp;
    emit(`${normalizedComponent}-actual-drawable`, record);
    promoteWhenCoarseComplete(record);
    return true;
  };

  const acknowledgeDrawable = ({
    ownerKey,
    level = 'coarse',
    receipt,
    drawable,
    component = null,
    stableIds = [],
  } = {}) => {
    const record = get(ownerKey);
    if (!record || record.state === VISUAL_CONTINUITY_STATE.RETIRING) return false;
    if (level !== 'coarse' && level !== 'detail') {
      throw new RangeError('drawable level must be coarse or detail');
    }
    if (level === 'coarse') {
      const resolvedComponent = component
        ?? (terrainLodBand(drawable?.mesh) ? 'terrain' : null);
      if (!resolvedComponent) return false;
      return acknowledgeCoarseComponent({
        ownerKey,
        component: resolvedComponent,
        stableIds,
        receipt,
        drawable,
      });
    }
    if (!isDrawableInCompletedFrame({ ...drawable, receipt })) return false;
    const timestamp = receipt.completedAtMs;
    record.pendingDetailDrawableAt = Math.min(record.pendingDetailDrawableAt ?? timestamp, timestamp);
    if (record.coarseDrawableAt !== null) {
      record.detailDrawableAt ??= Math.max(record.coarseDrawableAt, timestamp);
      record.state = VISUAL_CONTINUITY_STATE.DETAIL_DRAWABLE;
    }
    record.lastActualDrawAt = Math.max(record.lastActualDrawAt ?? timestamp, timestamp);
    record.visualWorkStartedAt ??= timestamp;
    record.gpuUploadedAt ??= timestamp;
    emit('detail-actual-drawable', record);
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

  const coarseTreeReceiptCacheSignature = mesh => Object.freeze({
    requirementRevision: coarseRequirementRevision,
    visualRevision: mesh?.userData?.canonicalVisualRevision ?? null,
    count: mesh?.count ?? null,
    canonicalObjects: mesh?.userData?.canonicalObjects ?? null,
    canonicalOpacities: mesh?.userData?.canonicalOpacities ?? null,
    materialOpacity: effectiveMaterialOpacity(mesh?.material),
    attributeVersions: Object.freeze(drawableAttributes(mesh).map(attribute => (
      attributeVersion(attribute)
    ))),
  });

  const coarseTreeReceiptCacheMatches = (cached, signature) => Boolean(cached
    && cached.signature.requirementRevision === signature.requirementRevision
    && cached.signature.visualRevision === signature.visualRevision
    && cached.signature.count === signature.count
    && cached.signature.canonicalObjects === signature.canonicalObjects
    && cached.signature.canonicalOpacities === signature.canonicalOpacities
    && cached.signature.materialOpacity === signature.materialOpacity
    && cached.signature.attributeVersions.length === signature.attributeVersions.length
    && cached.signature.attributeVersions.every((version, index) => (
      version === signature.attributeVersions[index]
    )));

  const acknowledgeScene = ({
    receipt,
    scene,
    terrainCoverage = null,
    terrainCoverageOwnerKeys = null,
  } = {}) => {
    if (!isCompletedRenderFrameReceipt(receipt)) return 0;
    const receiptCoarseComponentEvidence = coarseComponentReceiptEvidence(receipt);
    const explicitTerrainOwners = ownerKeySet(
      terrainCoverage?.ownerKeys ?? terrainCoverageOwnerKeys,
      'terrainCoverageOwnerKeys',
    );
    let acknowledged = 0;
    const seen = new Set();
    const acknowledgedOwnerKeys = new Set();
    const coarseTreePresenterStableIds = new Set();
    const coarseTreePresenterOccurrences = new Map();
    const nearTreePresenterStableIds = new Set();
    let scanErrorCount = 0;
    visitSceneObject(scene, mesh => {
      try {
      if (!mesh?.geometry || !mesh?.material) return;
      const terrainBand = terrainLodBand(mesh);
      if (terrainBand) {
        if (!validTerrainGpuGeometry(mesh, receipt)) return;
        const embeddedOwners = embeddedTerrainOwnerKeys(mesh);
        const inheritedOwner = inheritedChunkOwnerKey(mesh);
        if (inheritedOwner) embeddedOwners.add(inheritedOwner);
        const lowAnnulus = terrainBand === 'low'
          ? normalizedLowTerrainAnnulus(terrainCoverage?.lowAnnulus, mesh) : null;
        // High/Medium prove only embedded owners. Low has a real central hole,
        // so an explicit candidate owner is accepted only when its complete
        // logical AABB lies inside the receipt-proven clipmap annulus.
        const coveredOwners = terrainBand === 'low'
          ? new Set([...(explicitTerrainOwners ?? [])].filter(ownerKey => (
            lowAnnulus && ownerAabbInsideLowTerrainAnnulus(ownerKey, lowAnnulus)
          )))
          : new Set([...embeddedOwners].filter(ownerKey => (
            explicitTerrainOwners === null || explicitTerrainOwners.has(ownerKey)
          )));
        for (const ownerKey of coveredOwners) {
          if (!records.has(ownerKey)) continue;
          const key = `terrain\n${ownerKey}`;
          if (seen.has(key)) continue;
          if (acknowledgeCoarseComponent({
            ownerKey,
            component: 'terrain',
            receipt,
            drawable: { mesh, matrix: mesh.matrixWorld ?? mesh.matrix },
          })) {
            seen.add(key);
            acknowledgedOwnerKeys.add(ownerKey);
            acknowledged += 1;
          }
        }
      }

      const canonicalObjects = mesh.userData?.canonicalObjects ?? [];
      const opacities = mesh.userData?.canonicalOpacities ?? [];
      const cacheableCoarseTreeMesh =
        mesh.userData?.canonicalCoarseTreeSubmission === true;
      const coarseTreeCacheSignature = cacheableCoarseTreeMesh
        ? coarseTreeReceiptCacheSignature(mesh) : null;
      const cachedCoarseTreeReceipt = cacheableCoarseTreeMesh
        ? canonicalCoarseTreeReceiptCache.get(mesh) : null;
      if (cacheableCoarseTreeMesh
        && coarseTreeReceiptCacheMatches(
          cachedCoarseTreeReceipt,
          coarseTreeCacheSignature,
        )
        && isDrawableInCompletedFrame({ mesh, receipt })) {
        canonicalCoarseTreeSlotScanEarlyOutCount += 1;
        for (const value of cachedCoarseTreeReceipt.coarseSlots) {
          // Player position is a shader uniform, not a BufferAttribute version.
          // Re-evaluate only the cached declared Forest slots so a prewarmed
          // silhouette can become drawable on approach without rescanning every
          // canonical Tree or waiting for unrelated CPU visibility dirt.
          const opacity = value.component === 'forest'
            ? (Number.isFinite(opacities[value.slot]) ? opacities[value.slot] : 1)
              * effectiveMaterialOpacity(mesh.material)
              * forestShaderOpacity(mesh, value.slot, receipt)
            : value.opacity;
          if (!(opacity > 0)) continue;
          if (value.component === 'forest') {
            coarseTreePresenterStableIds.add(value.stableId);
            coarseTreePresenterOccurrences.set(
              value.stableId,
              (coarseTreePresenterOccurrences.get(value.stableId) ?? 0) + 1,
            );
          }
          const key = `${value.componentKey}\n${value.stableId}`;
          if (seen.has(key)) continue;
          if (!acknowledgeCoarseComponent({
            ownerKey: value.ownerKey,
            component: value.component,
            stableIds: [value.stableId],
            receipt,
            drawable: {
              mesh,
              effectiveOpacity: opacity,
              matrix: value.matrix,
            },
          })) continue;
          seen.add(key);
          acknowledgedOwnerKeys.add(value.ownerKey);
          acknowledged += 1;
          addCanonicalIdentities({ ownerKey: value.ownerKey, stableIds: [value.stableId] });
        }
        return;
      }
      const handoffOpacityAttribute = mesh.geometry?.getAttribute?.('w8LocalHandoffOpacity')
        ?? mesh.geometry?.attributes?.w8LocalHandoffOpacity
        ?? null;
      const gpuHandoffOpacities = handoffOpacityAttribute
        ? gpuPreferredAttributeArray(handoffOpacityAttribute, receipt) : null;
      const coarseSlots = [];
      const canonicalSlotCount = Math.min(
        canonicalObjects.length,
        Number.isSafeInteger(mesh.count) ? mesh.count : canonicalObjects.length,
      );
      for (let slot = 0; slot < canonicalSlotCount; slot += 1) {
        if (cacheableCoarseTreeMesh) canonicalCoarseTreeSlotScanCount += 1;
        const canonicalRecord = canonicalObjects[slot];
        const ownerKey = canonicalOwnerKey(canonicalRecord);
        if (!ownerKey || !records.has(ownerKey)) continue;
        const ownerRecord = records.get(ownerKey);
        const stableId = stableIdFrom(canonicalRecord);
        const component = isCanonicalStructure(canonicalRecord)
          && ownerRecord.requiredStructureStableIds.has(stableId)
          ? 'structure'
          : isCanonicalForestTree(canonicalRecord)
            && ownerRecord.requiredForestStableIds.has(stableId)
            ? 'forest'
            : null;
        // Rocks, shrubs, grass, unclassified canonical slots, and undeclared
        // IDs are detail-only and cannot satisfy coarse world existence.
        if (!component) continue;
        // Structure handoff opacity is shader input. Once the attribute exists,
        // its renderer-side mirror—not the diagnostic CPU array—is authoritative.
        const declaredOpacity = component === 'structure' && handoffOpacityAttribute
          ? Number(gpuHandoffOpacities?.[slot] ?? 0)
          : (Number.isFinite(opacities[slot]) ? opacities[slot] : 1);
        const opacity = declaredOpacity * effectiveMaterialOpacity(mesh.material)
          * (component === 'forest' ? forestShaderOpacity(mesh, slot, receipt) : 1);
        if (opacity <= 0 && !(cacheableCoarseTreeMesh && component === 'forest')) continue;
        const instanceMatrix = matrixOffsetElements(mesh.instanceMatrix, slot);
        if (mesh.instanceMatrix && !isValidDrawableMatrix(instanceMatrix)) continue;
        const componentKey = `${component}\n${ownerKey}`;
        coarseSlots.push({
          ownerKey,
          component,
          componentKey,
          slot,
          opacity,
          stableId,
          matrix: instanceMatrix ?? mesh.matrixWorld ?? mesh.matrix,
        });
      }
      const cacheableCoarseSlots = [];
      for (const value of coarseSlots) {
        if (cacheableCoarseTreeMesh) cacheableCoarseSlots.push(value);
        if (!(value.opacity > 0)) continue;
        if (value.component === 'forest') {
          coarseTreePresenterStableIds.add(value.stableId);
          coarseTreePresenterOccurrences.set(
            value.stableId,
            (coarseTreePresenterOccurrences.get(value.stableId) ?? 0) + 1,
          );
        }
        const key = `${value.componentKey}\n${value.stableId}`;
        if (seen.has(key)) continue;
        if (!acknowledgeCoarseComponent({
          ownerKey: value.ownerKey,
          component: value.component,
          stableIds: [value.stableId],
          receipt,
          drawable: {
            mesh,
            effectiveOpacity: value.opacity,
            matrix: value.matrix,
          },
        })) continue;
        seen.add(key);
        acknowledgedOwnerKeys.add(value.ownerKey);
        acknowledged += 1;
        addCanonicalIdentities({ ownerKey: value.ownerKey, stableIds: [value.stableId] });
      }
      if (cacheableCoarseTreeMesh
        && isDrawableInCompletedFrame({ mesh, receipt })) {
        canonicalCoarseTreeReceiptCache.set(mesh, Object.freeze({
          signature: coarseTreeCacheSignature,
          coarseSlots: Object.freeze(cacheableCoarseSlots),
        }));
      }

      if (canonicalObjects.length > 0 || terrainBand) return;
      const ownerKey = inheritedChunkOwnerKey(mesh);
      const key = `detail\n${ownerKey}`;
      if (!ownerKey || !records.has(ownerKey)) return;

      // Near content is a representation of the same canonical owner/Stable
      // IDs, not another lifecycle. A declared Tree/Structure slot can prove
      // the matching coarse component after its real Near draw; this prevents
      // a takeover from stranding the owner after coarse has yielded the ID.
      const nearStableIds = new Set(mesh.userData?.treeStableIds ?? []);
      const featureStableIds = mesh.userData?.featureStableIds ?? [];
      const drawableNearStableIds = [];
      const ownerRecord = records.get(ownerKey);
      const slotCount = Math.min(
        Number.isSafeInteger(mesh.count) ? mesh.count : featureStableIds.length,
        featureStableIds.length,
      );
      for (let slot = 0; slot < slotCount; slot += 1) {
        const stableId = featureStableIds[slot];
        if (typeof stableId !== 'string' || !stableId) continue;
        const matrix = matrixOffsetElements(mesh.instanceMatrix, slot);
        if (!isValidDrawableMatrix(matrix)) continue;
        if (!isDrawableInCompletedFrame({ mesh, receipt, matrix })) continue;
        const nearTree = nearStableIds.has(stableId);
        if (nearTree) nearTreePresenterStableIds.add(stableId);
        const component = nearTree && ownerRecord.requiredForestStableIds.has(stableId)
          ? 'forest'
          : ownerRecord.requiredStructureStableIds.has(stableId)
            ? 'structure'
            : null;
        if (nearTree || component) drawableNearStableIds.push(stableId);
        if (!component) continue;
        const componentKey = `${component}\n${ownerKey}\n${stableId}`;
        if (seen.has(componentKey)) continue;
        if (!acknowledgeCoarseComponent({
          ownerKey,
          component,
          stableIds: [stableId],
          receipt,
          drawable: { mesh, matrix },
        })) continue;
        seen.add(componentKey);
        acknowledgedOwnerKeys.add(ownerKey);
        acknowledged += 1;
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
        acknowledgedOwnerKeys.add(ownerKey);
        acknowledged += 1;
      }
      } catch {
        // One malformed observational mesh must not prevent valid Terrain or
        // canonical presenters elsewhere in the completed frame from being
        // acknowledged.
        scanErrorCount += 1;
      }
    });
    const requiredForestStableIds = new Set([...records.values()]
      .filter(record => record.state !== VISUAL_CONTINUITY_STATE.RETIRING
        && record.coarseRequirementsResolvedAt !== null)
      .flatMap(record => [...record.requiredForestStableIds]));
    const treePresenterStableIds = new Set([
      ...coarseTreePresenterStableIds,
      ...nearTreePresenterStableIds,
    ]);
    const duplicateStableIds = [...coarseTreePresenterStableIds]
      .filter(stableId => nearTreePresenterStableIds.has(stableId)).sort();
    const duplicateCoarseStableIds = [...coarseTreePresenterOccurrences]
      .filter(([, count]) => count > 1)
      .map(([stableId]) => stableId)
      .sort();
    // A not-yet-drawn requirement is a coarse-fill miss, not a continuity
    // disappearance. Zero-presenter frames begin only after the same Stable ID
    // has crossed an actual completed renderer receipt in the current Expected
    // contract. Retiring an owner ends that contract; a later velocity-corridor
    // re-entry must not inherit an old presentation while it is still outside
    // the drawable distance domain.
    for (const stableId of [...treeEverPresentedStableIds]) {
      if (!requiredForestStableIds.has(stableId)) {
        treeEverPresentedStableIds.delete(stableId);
      }
    }
    const zeroPresenterStableIds = [...requiredForestStableIds].filter(stableId => (
      treeEverPresentedStableIds.has(stableId) && !treePresenterStableIds.has(stableId)
    ));
    if (zeroPresenterStableIds.length > 0) treeZeroPresenterFrameCount += 1;
    if (duplicateStableIds.length > 0) treeDuplicatePresenterFrameCount += 1;
    if (duplicateCoarseStableIds.length > 0) treeDuplicateCoarsePresenterFrameCount += 1;
    for (const stableId of treePresenterStableIds) {
      if (requiredForestStableIds.has(stableId)) {
        treeEverPresentedStableIds.add(stableId);
      }
    }
    const currentReceiptCoarseComponentMetrics =
      finalizeCurrentReceiptCoarseComponentMetrics(receipt, receiptCoarseComponentEvidence);
    coarseComponentEvidenceByReceipt.delete(receipt);
    lastReceiptPresentation = Object.freeze({
      rendererFrameSequence: receipt.frameSequence,
      completedAtMs: receipt.completedAtMs,
      actualComponentDrawCount: acknowledged,
      acknowledgedOwnerKeys: Object.freeze([...acknowledgedOwnerKeys].sort()),
      treePresenterCount: treePresenterStableIds.size + duplicateStableIds.length,
      treePresenterStableIds: Object.freeze([...treePresenterStableIds].sort()),
      treeZeroPresenterRequiredCount: zeroPresenterStableIds.length,
      treeDuplicatePresenterCount: duplicateStableIds.length,
      treeDuplicateStableIds: Object.freeze(duplicateStableIds),
      treeDuplicateCoarsePresenterCount: duplicateCoarseStableIds.length,
      treeDuplicateCoarseStableIds: Object.freeze(duplicateCoarseStableIds),
      treeZeroPresenterFrameCount,
      treeDuplicatePresenterFrameCount,
      treeDuplicateCoarsePresenterFrameCount,
      currentReceiptCoarseComponentMetrics,
      scanErrorCount,
    });
    return acknowledged;
  };

  const retire = ({ ownerKey, at = now() } = {}) => {
    const record = get(ownerKey);
    if (!record) return false;
    record.retiringAt ??= finiteTime(at, 'retiringAt');
    record.state = VISUAL_CONTINUITY_STATE.RETIRING;
    coarseRequirementRevision += 1;
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
    const activeRecords = [...records.values()]
      .filter(record => record.state !== VISUAL_CONTINUITY_STATE.RETIRING);
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
    const terrainSamples = activeRecords.filter(record => record.terrainRequired).map(record => ({
      ownerKey: record.ownerKey,
      expectedAt: record.expectedAt,
      deadlineAtMs: record.deadlineAtMs,
      actualDrawableAt: record.terrainDrawableAt,
    }));
    const structureSamples = activeRecords.flatMap(record => (
      [...record.requiredStructureStableIds].map(stableId => ({
        ownerKey: record.ownerKey,
        stableId,
        expectedAt: record.expectedAt,
        deadlineAtMs: record.deadlineAtMs,
        actualDrawableAt: record.structureDrawnAtByStableId.get(stableId) ?? null,
      }))
    ));
    const forestSamples = activeRecords.flatMap(record => (
      [...record.requiredForestStableIds].map(stableId => ({
        ownerKey: record.ownerKey,
        stableId,
        expectedAt: record.expectedAt,
        deadlineAtMs: record.deadlineAtMs,
        actualDrawableAt: record.forestDrawnAtByStableId.get(stableId) ?? null,
      }))
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
      coarseComponentMetrics: Object.freeze({
        requirementsResolvedOwnerCount: activeRecords.filter(
          record => record.coarseRequirementsResolvedAt !== null,
        ).length,
        requirementsUnresolvedOwnerCount: activeRecords.filter(
          record => record.coarseRequirementsResolvedAt === null,
        ).length,
        terrain: componentSnapshotMetric(terrainSamples, timestamp),
        structure: componentSnapshotMetric(structureSamples, timestamp),
        forest: componentSnapshotMetric(forestSamples, timestamp),
      }),
      receiptScanMetrics: Object.freeze({
        canonicalCoarseTreeSlotScanCount,
        canonicalCoarseTreeSlotScanEarlyOutCount,
      }),
      currentReceiptCoarseComponentMetrics:
        lastReceiptPresentation.currentReceiptCoarseComponentMetrics,
      lastReceiptPresentation,
      owners: Object.freeze(owners.sort((left, right) => left.sequence - right.sequence)),
    });
  };

  // Hot-path polling must not materialize every owner's Stable-ID and receipt
  // evidence arrays. This scalar view preserves the exact lifecycle counts;
  // callers still take one full snapshot before accepting a completed cohort.
  const progressSnapshot = ({ at = now() } = {}) => {
    const timestamp = finiteTime(at, 'progress snapshot at');
    let expectedOwnerCount = 0;
    let coarseDrawableCount = 0;
    let detailDrawableCount = 0;
    let requirementsResolvedOwnerCount = 0;
    let deadlineMissCount = 0;
    for (const record of records.values()) {
      if (record.state === VISUAL_CONTINUITY_STATE.RETIRING) continue;
      expectedOwnerCount += 1;
      if (record.coarseRequirementsResolvedAt !== null) {
        requirementsResolvedOwnerCount += 1;
      }
      if (record.coarseDrawableAt !== null) coarseDrawableCount += 1;
      if (record.detailDrawableAt !== null) detailDrawableCount += 1;
      if (record.deadlineAtMs !== null
        && (record.coarseDrawableAt ?? timestamp) > record.deadlineAtMs) {
        deadlineMissCount += 1;
      }
    }
    return Object.freeze({
      schemaVersion: 'visual-continuity-progress-1',
      expectedOwnerCount,
      coarseDrawableCount,
      detailDrawableCount,
      requirementsResolvedOwnerCount,
      requirementsUnresolvedOwnerCount:
        expectedOwnerCount - requirementsResolvedOwnerCount,
      deadlineMissCount,
      currentReceiptMissingCount: Object.freeze({
        terrain: lastReceiptPresentation.currentReceiptCoarseComponentMetrics
          .terrain.missingCount,
        structure: lastReceiptPresentation.currentReceiptCoarseComponentMetrics
          .structure.missingCount,
        forest: lastReceiptPresentation.currentReceiptCoarseComponentMetrics
          .forest.missingCount,
      }),
    });
  };

  return Object.freeze({
    expect,
    get: ownerKey => {
      const record = get(ownerKey);
      return record ? frozenOwnerRecord(record, now()) : null;
    },
    recordPipelineStage,
    resolveCoarseRequirements,
    excludeDestroyedStableIds,
    markRepresentationAvailable,
    addCanonicalIdentities,
    acknowledgeCoarseComponent,
    acknowledgeDrawable,
    acknowledgeScene,
    retire,
    pruneRetired,
    deleteRetired: ownerKey => {
      const record = get(ownerKey);
      return record?.state === VISUAL_CONTINUITY_STATE.RETIRING
        ? records.delete(record.ownerKey) : false;
    },
    progressSnapshot,
    snapshot,
    clear: () => {
      records.clear();
      coarseRequirementRevision += 1;
      canonicalCoarseTreeSlotScanCount = 0;
      canonicalCoarseTreeSlotScanEarlyOutCount = 0;
      treeEverPresentedStableIds.clear();
      treeZeroPresenterFrameCount = 0;
      treeDuplicatePresenterFrameCount = 0;
      treeDuplicateCoarsePresenterFrameCount = 0;
      terrainDisappearanceFrameCount = 0;
      structureDisappearanceFrameCount = 0;
      forestDisappearanceFrameCount = 0;
      coarseComponentEvidenceByReceipt = new WeakMap();
      lastReceiptPresentation = Object.freeze({
        rendererFrameSequence: null,
        completedAtMs: null,
        actualComponentDrawCount: 0,
        acknowledgedOwnerKeys: Object.freeze([]),
        treePresenterCount: 0,
        treePresenterStableIds: Object.freeze([]),
        treeZeroPresenterRequiredCount: 0,
        treeDuplicatePresenterCount: 0,
        treeDuplicateStableIds: Object.freeze([]),
        treeDuplicateCoarsePresenterCount: 0,
        treeDuplicateCoarseStableIds: Object.freeze([]),
        treeZeroPresenterFrameCount: 0,
        treeDuplicatePresenterFrameCount: 0,
        treeDuplicateCoarsePresenterFrameCount: 0,
        currentReceiptCoarseComponentMetrics: emptyCurrentReceiptCoarseComponentMetrics(),
        scanErrorCount: 0,
      });
    },
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
    acknowledgeReplacement({
      ownerKey,
      level = 'detail',
      receipt,
      drawable,
      component = null,
      stableIds = [],
    } = {}) {
      const key = ownerIdentity(ownerKey);
      if (!visualRegistry.acknowledgeDrawable({
        ownerKey: key,
        level,
        receipt,
        drawable,
        component,
        stableIds,
      })) {
        return false;
      }
      const owner = visualRegistry.get?.(key) ?? null;
      if ((level === 'detail' && owner?.detailDrawableAt === null)
        || (level === 'coarse' && owner?.coarseDrawableAt === null)) return false;
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
