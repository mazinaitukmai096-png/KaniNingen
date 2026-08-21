const DEFAULT_PRE_FRAME_CAPACITY = 30;
const DEFAULT_POST_FRAME_CAPACITY = 30;
const DEFAULT_INCIDENT_CAPACITY = 4;
const ID_SAMPLE_LIMIT = 64;

export const WEBGL_RENDER_DIAGNOSTIC_MODE = Object.freeze({
  OFF: 'off',
  LIGHT: 'light',
  DEEP_ATTRIBUTION: 'deep-attribution',
});

function resolveDiagnosticMode(mode, enabled) {
  const resolved = mode ?? (enabled === true
    ? WEBGL_RENDER_DIAGNOSTIC_MODE.DEEP_ATTRIBUTION
    : WEBGL_RENDER_DIAGNOSTIC_MODE.OFF);
  if (!Object.values(WEBGL_RENDER_DIAGNOSTIC_MODE).includes(resolved)) {
    throw new RangeError('WebGL render diagnostic mode must be off, light, or deep-attribution');
  }
  return resolved;
}

function errorSummary(stage, error) {
  return Object.freeze({
    stage,
    name: String(error?.name ?? 'Error'),
    message: String(error?.message ?? error),
  });
}

function bufferViewBytes(value, sourceOffset = 0, sourceLength = null) {
  if (Number.isFinite(value)) return Math.max(0, Number(value));
  if (value instanceof ArrayBuffer) {
    const offsetBytes = Math.max(0, Number(sourceOffset) || 0);
    const availableBytes = Math.max(0, value.byteLength - offsetBytes);
    return sourceLength === null || sourceLength === undefined || sourceLength === 0
      ? availableBytes : Math.min(availableBytes, Math.max(0, Number(sourceLength) || 0));
  }
  if (!ArrayBuffer.isView(value)) return Number(value?.byteLength ?? 0);
  const bytesPerElement = Number(value.BYTES_PER_ELEMENT ?? 1);
  const offsetElements = Math.max(0, Number(sourceOffset) || 0);
  const availableElements = Math.max(0, (value.byteLength / bytesPerElement) - offsetElements);
  const selectedElements = sourceLength === null || sourceLength === undefined || sourceLength === 0
    ? availableElements : Math.min(availableElements, Math.max(0, Number(sourceLength) || 0));
  return selectedElements * bytesPerElement;
}

function uploadedByteLength(methodName, args) {
  if (methodName === 'bufferSubData') {
    return bufferViewBytes(args[2], args[3] ?? 0, args[4] ?? null);
  }
  return bufferViewBytes(args[1], args[3] ?? 0, args[4] ?? null);
}

function boundedUnique(values, limit = ID_SAMPLE_LIMIT) {
  const result = [];
  const seen = new Set();
  for (const value of values ?? []) {
    if (value === null || value === undefined || value === '' || seen.has(value)) continue;
    seen.add(value);
    if (result.length < limit) result.push(value);
  }
  return Object.freeze({
    values: Object.freeze(result),
    totalCount: seen.size,
    truncated: seen.size > result.length,
  });
}

function freezeFrame(frame) {
  return Object.freeze({
    ...frame,
    anomalyCodes: Object.freeze([...(frame.anomalyCodes ?? [])]),
  });
}

export function createWebGLRenderIncidentRing({
  preFrameCapacity = DEFAULT_PRE_FRAME_CAPACITY,
  postFrameCapacity = DEFAULT_POST_FRAME_CAPACITY,
  incidentCapacity = DEFAULT_INCIDENT_CAPACITY,
} = {}) {
  for (const [name, value] of Object.entries({
    preFrameCapacity, postFrameCapacity, incidentCapacity,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  const preFrames = [];
  const incidents = [];
  let pendingIncident = null;
  let latest = null;

  const finishPendingIncident = () => {
    if (!pendingIncident) return;
    incidents.push(Object.freeze({
      triggerFrameSequence: pendingIncident.triggerFrameSequence,
      triggerTimeMs: pendingIncident.triggerTimeMs,
      anomalyCodes: Object.freeze([...pendingIncident.anomalyCodes].sort()),
      canvasScreenshot: pendingIncident.canvasScreenshot,
      frames: Object.freeze([...pendingIncident.frames]),
    }));
    while (incidents.length > incidentCapacity) incidents.shift();
    pendingIncident = null;
  };

  return Object.freeze({
    record(frame, { captureScreenshot = null } = {}) {
      const frozen = freezeFrame(frame);
      latest = frozen;
      if (pendingIncident) {
        pendingIncident.frames.push(frozen);
        for (const code of frozen.anomalyCodes) pendingIncident.anomalyCodes.add(code);
        pendingIncident.remainingPostFrames -= 1;
        if (pendingIncident.remainingPostFrames <= 0) finishPendingIncident();
      } else if (frozen.anomalyCodes.length > 0) {
        let canvasScreenshot = null;
        if (typeof captureScreenshot === 'function') {
          try {
            canvasScreenshot = captureScreenshot();
          } catch (error) {
            canvasScreenshot = Object.freeze({
              mimeType: 'image/png',
              dataUrl: null,
              error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
            });
          }
        }
        pendingIncident = {
          triggerFrameSequence: frozen.frameSequence,
          triggerTimeMs: frozen.timeMs,
          anomalyCodes: new Set(frozen.anomalyCodes),
          canvasScreenshot,
          frames: [...preFrames, frozen],
          remainingPostFrames: postFrameCapacity,
        };
      }
      preFrames.push(frozen);
      while (preFrames.length > preFrameCapacity) preFrames.shift();
      return frozen;
    },
    reset() {
      preFrames.length = 0;
      incidents.length = 0;
      pendingIncident = null;
      latest = null;
    },
    snapshot() {
      const pending = pendingIncident ? Object.freeze({
        triggerFrameSequence: pendingIncident.triggerFrameSequence,
        triggerTimeMs: pendingIncident.triggerTimeMs,
        anomalyCodes: Object.freeze([...pendingIncident.anomalyCodes].sort()),
        canvasScreenshot: pendingIncident.canvasScreenshot,
        frames: Object.freeze([...pendingIncident.frames]),
        remainingPostFrames: pendingIncident.remainingPostFrames,
      }) : null;
      const canvasScreenshot = pending?.canvasScreenshot
        ?? incidents.at(-1)?.canvasScreenshot ?? null;
      return Object.freeze({
        latest,
        incidents: Object.freeze([...incidents]),
        pendingIncident: pending,
        canvasScreenshot,
        preFrameCapacity,
        postFrameCapacity,
        incidentCapacity,
      });
    },
  });
}

function vectorSnapshot(value) {
  if (!value) return null;
  return Object.freeze({
    x: Number(value.x ?? 0),
    y: Number(value.y ?? 0),
    z: Number(value.z ?? 0),
  });
}

function matrixSnapshot(matrix) {
  if (!matrix?.elements || matrix.elements.length < 16) return null;
  return Object.freeze(Array.from(matrix.elements, Number));
}

function boxSnapshot(box) {
  if (!box) return null;
  return Object.freeze({ min: vectorSnapshot(box.min), max: vectorSnapshot(box.max) });
}

function sphereSnapshot(sphere) {
  if (!sphere) return null;
  return Object.freeze({ center: vectorSnapshot(sphere.center), radius: Number(sphere.radius) });
}

function objectIdentity(object) {
  if (!object) return null;
  return object.uuid ?? `${object.type ?? object.constructor?.name ?? 'Object'}:${object.id ?? object.name ?? 'unknown'}`;
}

function materialIdentity(material) {
  if (!material) return null;
  return Object.freeze({
    identity: objectIdentity(material),
    name: material.name || null,
    type: material.type ?? material.constructor?.name ?? null,
    transparent: material.transparent === true,
    opacity: Number.isFinite(material.opacity) ? material.opacity : null,
    visible: material.visible !== false,
  });
}

function materialSnapshots(material) {
  return Object.freeze((Array.isArray(material) ? material : [material])
    .filter(Boolean).map(materialIdentity));
}

function inheritedUserDataValues(object, key) {
  const values = [];
  for (let current = object; current; current = current.parent) {
    const value = current.userData?.[key];
    if (Array.isArray(value)) values.push(...value);
    else if (value !== null && value !== undefined) values.push(value);
  }
  return values;
}

function meshOwnerKeys(mesh) {
  return boundedUnique([
    ...inheritedUserDataValues(mesh, 'ownerKeys'),
    ...inheritedUserDataValues(mesh, 'visibleOwnerKeys'),
    ...inheritedUserDataValues(mesh, 'chunkKey'),
    ...inheritedUserDataValues(mesh, 'ownerKey'),
  ]);
}

function meshStableIds(mesh) {
  return boundedUnique([
    ...inheritedUserDataValues(mesh, 'canonicalStableIds'),
    ...inheritedUserDataValues(mesh, 'featureStableIds'),
    ...inheritedUserDataValues(mesh, 'treeStableIds'),
    ...inheritedUserDataValues(mesh, 'stableId'),
  ]);
}

function hasAncestorNamed(mesh, name) {
  for (let current = mesh; current; current = current.parent) {
    if (current.name === name) return true;
  }
  return false;
}

function meshDomain(mesh) {
  if (hasAncestorNamed(mesh, 'w1a-render-root')) return 'near';
  if (hasAncestorNamed(mesh, 'w8-scene-owned-distant-world')) return 'distant';
  if (hasAncestorNamed(mesh, 'w8-persistent-static-natural-pages')) return 'persistent-natural';
  if (hasAncestorNamed(mesh, 'w6-gameplay-root')) return 'gameplay';
  return 'scene';
}

function classifyMesh(mesh) {
  const name = String(mesh?.name ?? '').toLowerCase();
  if (name === 'w1a-terrain' || name === 'w2-natural-terrain') return 'terrain-near';
  if (name === 'w8-midground-outer-sixteen-terrain') return 'terrain-distant';
  if (name === 'w8-seeded-macro-terrain-clipmap') return 'terrain-clipmap';
  const canonicalObjects = mesh?.userData?.canonicalObjects ?? [];
  const buildingData = canonicalObjects.some(value => (
    value?.featureType === 'settlement-building'
      || value?.buildingType !== undefined
      || value?.type === 'building'
  ));
  if (buildingData || /building|house|tower|church|school|barn|factory/.test(name)) {
    return 'building';
  }
  const naturalMaterial = (Array.isArray(mesh?.material) ? mesh.material : [mesh?.material])
    .some(material => material?.userData?.naturalLodKind);
  if (naturalMaterial || mesh?.userData?.treePathId
      || /natural|tree|bush|grass|rock|flower|forest/.test(name)) return 'natural';
  return null;
}

function rootRole(object) {
  switch (object?.name) {
    case 'w1a-render-root': return 'near-terrain-building-root';
    case 'w8-scene-owned-distant-world': return 'distant-world-root';
    case 'w8-persistent-static-natural-pages': return 'persistent-natural-root';
    case 'w6-gameplay-root': return 'collision-gameplay-root';
    case 'w7-core-combat-root': return 'combat-root';
    default:
      if (/^w8-local-terrain-coverage-epoch-/.test(object?.name ?? '')) {
        return 'distant-local-terrain-root';
      }
      return null;
  }
}

function visibleInHierarchy(object) {
  for (let current = object; current; current = current.parent) {
    if (current.visible === false) return false;
  }
  return true;
}

function renderable(object) {
  return object?.isMesh === true || object?.isLine === true
    || object?.isPoints === true || object?.isSprite === true;
}

function rendererInfoSnapshot(renderer) {
  const info = renderer?.info ?? {};
  return Object.freeze({
    render: Object.freeze({
      calls: Number(info.render?.calls ?? 0),
      triangles: Number(info.render?.triangles ?? 0),
      points: Number(info.render?.points ?? 0),
      lines: Number(info.render?.lines ?? 0),
      frame: Number(info.render?.frame ?? info.frame ?? 0),
    }),
    memory: Object.freeze({
      geometries: Number(info.memory?.geometries ?? 0),
      textures: Number(info.memory?.textures ?? 0),
    }),
    programs: Array.isArray(info.programs) ? info.programs.length : null,
  });
}

function attributeSnapshot(readGpuVersion, observedGpuVersions, name, attribute) {
  if (!attribute) return null;
  const gpuVersion = readGpuVersion(attribute);
  const observedGpuVersion = observedGpuVersions.get(attribute);
  return Object.freeze({
    name,
    identity: objectIdentity(attribute),
    itemSize: Number(attribute.itemSize ?? 0),
    count: Number(attribute.count ?? 0),
    logicalVersion: Number.isFinite(attribute.version) ? attribute.version : null,
    gpuVersion: Number.isFinite(gpuVersion) ? gpuVersion
      : Number.isFinite(observedGpuVersion) ? observedGpuVersion : null,
    usage: Number.isFinite(attribute.usage) ? attribute.usage : null,
  });
}

function attributeSnapshots(readGpuVersion, observedGpuVersions, mesh) {
  const entries = [];
  if (mesh.instanceMatrix) entries.push(['instanceMatrix', mesh.instanceMatrix]);
  if (mesh.instanceColor) entries.push(['instanceColor', mesh.instanceColor]);
  for (const [name, attribute] of Object.entries(mesh.geometry?.attributes ?? {})) {
    if (!entries.some(entry => entry[1] === attribute)) entries.push([name, attribute]);
  }
  return Object.freeze(Object.fromEntries(entries.map(([name, attribute]) => (
    [name, attributeSnapshot(readGpuVersion, observedGpuVersions, name, attribute)]
  ))));
}

function isMatrixWorldConsistent(THREE, object, epsilon = 1e-5) {
  if (!object?.parent?.matrixWorld || !object.matrix || !object.matrixWorld
      || typeof THREE?.Matrix4 !== 'function') return null;
  const expected = new THREE.Matrix4().multiplyMatrices(object.parent.matrixWorld, object.matrix);
  const actual = object.matrixWorld.elements;
  return expected.elements.every((value, index) => Math.abs(value - actual[index]) <= epsilon);
}

function frustumState(THREE, camera) {
  if (typeof THREE?.Matrix4 !== 'function' || typeof THREE?.Frustum !== 'function'
      || !camera?.projectionMatrix || !camera?.matrixWorldInverse) return null;
  const projectionView = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  const frustum = new THREE.Frustum().setFromProjectionMatrix(projectionView);
  return {
    frustum,
    snapshot: Object.freeze(frustum.planes.map(plane => Object.freeze({
      normal: vectorSnapshot(plane.normal),
      constant: Number(plane.constant),
    }))),
  };
}

function captureCanvas(canvas) {
  if (typeof canvas?.toDataURL !== 'function') {
    return Object.freeze({ mimeType: 'image/png', dataUrl: null, error: 'canvas.toDataURL unavailable' });
  }
  const dataUrl = canvas.toDataURL('image/png');
  return Object.freeze({
    mimeType: 'image/png',
    width: Number(canvas.width ?? 0),
    height: Number(canvas.height ?? 0),
    dataUrl,
    byteLengthApproximate: Math.max(0, Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)),
    error: null,
  });
}

export function createWebGLRenderDiagnostics({
  enabled = false,
  mode = null,
  THREE,
  renderer,
  scene,
  camera,
  canvas = renderer?.domElement,
  buildIdentity = null,
  clock = () => globalThis.performance?.now?.() ?? Date.now(),
  ring = createWebGLRenderIncidentRing(),
  forceFirstIncident = false,
  publishProof = null,
  sampleIntervalMs = 1_000,
  captureFirstFrame = true,
  onObserverError = null,
} = {}) {
  if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 0) {
    throw new TypeError('sampleIntervalMs must be non-negative');
  }
  if (onObserverError !== null && typeof onObserverError !== 'function') {
    throw new TypeError('onObserverError must be a function or null');
  }
  const diagnosticMode = resolveDiagnosticMode(mode, enabled);
  const supported = renderer?.isWebGLRenderer === true
    && scene?.isScene === true
    && camera?.isCamera === true
    && typeof scene.traverse === 'function';
  const active = diagnosticMode === WEBGL_RENDER_DIAGNOSTIC_MODE.DEEP_ATTRIBUTION
    && supported;
  let previousAttributeVersions = new WeakMap();
  let observedGpuVersions = new WeakMap();
  let captureCount = 0;
  let latestRendererInfo = null;
  let latestSceneDrawState = null;
  let latestMeshDrawState = null;
  let lastCaptureStartedAtMs = Number.NEGATIVE_INFINITY;
  let skippedFrameCount = 0;
  let pendingCaptureReason = null;
  let hookInstallFailureCount = 0;
  let frustumIntersectionFailureCount = 0;
  let observerErrorCount = 0;
  let observerLastError = null;
  let proofPublisherQuarantined = false;
  let rendererAttributeLookupQuarantined = false;
  let uploadHookQuarantined = false;
  let frustumProbeQuarantined = false;
  let deepCaptureQuarantined = false;

  const reportObserverError = (stage, error) => {
    observerErrorCount += 1;
    observerLastError = errorSummary(stage, error);
    if (typeof onObserverError === 'function') {
      try {
        onObserverError(Object.freeze({
          subsystem: 'webgl-render-diagnostics',
          ...observerLastError,
        }));
      } catch (callbackError) {
        observerErrorCount += 1;
        observerLastError = errorSummary('observer-error-reporter', callbackError);
      }
    }
  };

  const selectCaptureReason = (context, nowMs) => {
    if (context?.forceDeepAttribution === true) return 'manual';
    if (context?.hitch === true || context?.longTask === true) return 'hitch';
    if (pendingCaptureReason) return pendingCaptureReason;
    if (captureCount === 0 && forceFirstIncident) return 'forced-incident';
    if (captureCount === 0 && captureFirstFrame) return 'first-draw';
    if (nowMs - lastCaptureStartedAtMs >= sampleIntervalMs) return 'cadence';
    return null;
  };

  const readGpuVersion = attribute => {
    if (rendererAttributeLookupQuarantined) return null;
    try {
      return renderer.attributes?.get?.(attribute)?.version ?? null;
    } catch (error) {
      rendererAttributeLookupQuarantined = true;
      reportObserverError('renderer-attribute-lookup', error);
      return null;
    }
  };

  const restoreCaptureHooks = capture => {
    if (!capture || capture.restored === true) return;
    capture.restored = true;
    let firstError = null;
    for (let index = capture.restorers.length - 1; index >= 0; index -= 1) {
      try {
        capture.restorers[index]();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };

  const beginFrame = context => {
    if (!active) return null;
    if (deepCaptureQuarantined) {
      skippedFrameCount += 1;
      return null;
    }
    const startedAtMs = Number(clock());
    const captureReason = selectCaptureReason(context, startedAtMs);
    if (!captureReason) {
      skippedFrameCount += 1;
      return null;
    }
    pendingCaptureReason = null;
    lastCaptureStartedAtMs = startedAtMs;
    const drawn = new Map();
    const gpuUploads = new Map();
    const preRenderLogicalState = new Map();
    const restorers = [];
    const frameGpuUploads = {
      calls: 0,
      bytes: 0,
      unattributedCalls: 0,
      unattributedBytes: 0,
    };
    let currentDrawObject = null;
    let webglContext = null;
    try {
      webglContext = renderer.getContext?.();
      for (const methodName of uploadHookQuarantined ? [] : ['bufferData', 'bufferSubData']) {
        const original = webglContext?.[methodName];
        if (typeof original !== 'function') continue;
        const wrapped = function webglDiagnosticBufferUpload(...args) {
          const bytes = uploadedByteLength(methodName, args);
          frameGpuUploads.calls += 1;
          frameGpuUploads.bytes += bytes;
          if (currentDrawObject) {
            const current = gpuUploads.get(currentDrawObject) ?? { calls: 0, bytes: 0 };
            current.calls += 1;
            current.bytes += bytes;
            gpuUploads.set(currentDrawObject, current);
          } else {
            // Three uploads BufferAttributes before Object3D.onBeforeRender.
            // Preserve exact frame totals without falsely attributing those
            // calls to whichever object happened to draw previously.
            frameGpuUploads.unattributedCalls += 1;
            frameGpuUploads.unattributedBytes += bytes;
          }
          return original.apply(this, args);
        };
        webglContext[methodName] = wrapped;
        restorers.push(() => { webglContext[methodName] = original; });
      }
    } catch (error) {
      // Some WebGL implementations expose non-writable context methods. Attribute
      // versions remain available when WebGLRenderer exposes its attribute cache.
      uploadHookQuarantined = true;
      hookInstallFailureCount += 1;
      reportObserverError('webgl-upload-hook-install', error);
      const partialCapture = { restorers, restored: false };
      try { restoreCaptureHooks(partialCapture); } catch (restoreError) {
        reportObserverError('webgl-upload-hook-rollback', restoreError);
      }
      restorers.length = 0;
    }
    try {
      scene.traverse(object => {
        if (!renderable(object)) return;
        const role = classifyMesh(object);
        if (role) {
          preRenderLogicalState.set(object, Object.freeze({
            role,
            visible: object.visible !== false,
            visibleInHierarchy: visibleInHierarchy(object),
            count: object.isInstancedMesh === true ? Number(object.count ?? 0) : 1,
            instanceMatrixVersion: Number.isFinite(object.instanceMatrix?.version)
              ? object.instanceMatrix.version : null,
            instanceColorVersion: Number.isFinite(object.instanceColor?.version)
              ? object.instanceColor.version : null,
            matrixWorld: matrixSnapshot(object.matrixWorld),
            ownerKeys: meshOwnerKeys(object),
            stableIds: meshStableIds(object),
          }));
        }
        const previousBeforeRender = object.onBeforeRender;
        const previousAfterRender = object.onAfterRender;
        object.onBeforeRender = function webglDiagnosticDrawHook(
          renderInstance, renderScene, renderCamera, geometry, material, group,
        ) {
          currentDrawObject = object;
          const record = drawn.get(object) ?? {
            totalDrawCount: 0,
            mainDrawCount: 0,
            shadowDrawCount: 0,
            materialIds: new Set(),
          };
          record.totalDrawCount += 1;
          if (renderCamera === camera) record.mainDrawCount += 1;
          else record.shadowDrawCount += 1;
          record.materialIds.add(objectIdentity(material));
          drawn.set(object, record);
          if (typeof previousBeforeRender === 'function') {
            previousBeforeRender.call(
              this, renderInstance, renderScene, renderCamera, geometry, material, group,
            );
          }
        };
        object.onAfterRender = function webglDiagnosticAfterDrawHook(...args) {
          try {
            if (typeof previousAfterRender === 'function') previousAfterRender.apply(this, args);
          } finally {
            currentDrawObject = null;
          }
        };
        restorers.push(() => {
          object.onBeforeRender = previousBeforeRender;
          object.onAfterRender = previousAfterRender;
        });
      });
    } catch (error) {
      const capture = { restorers, restored: false };
      try { restoreCaptureHooks(capture); } catch (restoreError) {
        reportObserverError('draw-hook-rollback', restoreError);
      }
      deepCaptureQuarantined = true;
      reportObserverError('scene-traversal', error);
      return null;
    }
    captureCount += 1;
    return {
      context,
      captureReason,
      webglContext,
      drawn,
      gpuUploads,
      frameGpuUploads,
      preRenderLogicalState,
      restorers,
      restored: false,
      startedAtMs,
    };
  };

  const finishFrame = capture => {
    if (!active || !capture) return null;
    try {
      restoreCaptureHooks(capture);
    } catch (error) {
      reportObserverError('draw-hook-restore', error);
    }
    const frameContext = capture.context ?? {};
    let currentFrustum = null;
    if (!frustumProbeQuarantined) {
      try {
        currentFrustum = frustumState(THREE, camera);
      } catch (error) {
        frustumProbeQuarantined = true;
        frustumIntersectionFailureCount += 1;
        reportObserverError('frustum-state', error);
      }
    }
    const roots = [];
    const meshStates = [];
    const drawnOwnerKeys = [];
    const drawnStableIds = [];
    const stableDrawBuckets = new Map();
    const anomalyCodes = new Set();
    let allRenderableDrawCount = 0;
    let staleBuildingMatrixCount = 0;
    const roleDrawCounts = {
      'terrain-near': 0,
      'terrain-distant': 0,
      'terrain-clipmap': 0,
      building: 0,
      natural: 0,
    };

    try {
      scene.traverse(object => {
      const role = rootRole(object);
      if (role) {
        roots.push(Object.freeze({
          role,
          identity: objectIdentity(object),
          name: object.name || null,
          visible: object.visible !== false,
          visibleInHierarchy: visibleInHierarchy(object),
          childrenCount: object.children?.length ?? 0,
          matrixWorld: matrixSnapshot(object.matrixWorld),
          matrixWorldConsistent: isMatrixWorldConsistent(THREE, object),
          transitionGeneration: object.userData?.transitionGeneration ?? null,
          renderOriginRevision: object.userData?.lastRenderOriginRevision ?? null,
        }));
      }
      if (!renderable(object)) return;
      const draw = capture.drawn.get(object) ?? {
        totalDrawCount: 0, mainDrawCount: 0, shadowDrawCount: 0, materialIds: new Set(),
      };
      allRenderableDrawCount += draw.mainDrawCount;
      const meshRole = classifyMesh(object);
      if (!meshRole) return;
      const owners = meshOwnerKeys(object);
      const stableIds = meshStableIds(object);
      const upload = capture.gpuUploads.get(object) ?? { calls: 0, bytes: 0 };
      if (upload.calls > 0) {
        for (const attribute of [
          object.instanceMatrix,
          object.instanceColor,
          ...Object.values(object.geometry?.attributes ?? {}),
        ]) {
          if (attribute && Number.isFinite(attribute.version)) {
            observedGpuVersions.set(attribute, attribute.version);
          }
        }
      }
      const attributes = attributeSnapshots(readGpuVersion, observedGpuVersions, object);
      let frustumIntersects = null;
      if (object.frustumCulled === false) frustumIntersects = true;
      else if (!frustumProbeQuarantined && currentFrustum?.frustum
        && typeof currentFrustum.frustum.intersectsObject === 'function') {
        try {
          frustumIntersects = currentFrustum.frustum.intersectsObject(object);
        } catch (error) {
          frustumIntersects = null;
          frustumProbeQuarantined = true;
          frustumIntersectionFailureCount += 1;
          reportObserverError('frustum-intersection', error);
        }
      }
      const logicalVisible = visibleInHierarchy(object);
      const count = object.isInstancedMesh === true ? Number(object.count ?? 0) : 1;
      const domain = meshDomain(object);
      roleDrawCounts[meshRole] += draw.mainDrawCount;
      if (draw.mainDrawCount > 0) {
        drawnOwnerKeys.push(...owners.values);
        drawnStableIds.push(...stableIds.values);
        for (const stableId of meshRole === 'building' ? stableIds.values : []) {
          const bucket = stableDrawBuckets.get(stableId) ?? new Map();
          for (const materialId of draw.materialIds) {
            bucket.set(`${domain}:${materialId}`, { domain, materialId });
          }
          stableDrawBuckets.set(stableId, bucket);
        }
      }
      let staleGpuAttribute = false;
      const staleGpuAttributeNames = [];
      for (const attribute of Object.values(attributes)) {
        if (!attribute) continue;
        const source = attribute.name === 'instanceMatrix' ? object.instanceMatrix
          : attribute.name === 'instanceColor' ? object.instanceColor
            : object.geometry?.attributes?.[attribute.name];
        if (!source) continue;
        const previous = previousAttributeVersions.get(source);
        const logicalVersionIncreased = previous && attribute.logicalVersion !== null
          && previous.logicalVersion !== null
          && attribute.logicalVersion > previous.logicalVersion;
        const gpuVersionDidNotAdvance = previous && attribute.gpuVersion !== null
          && previous.gpuVersion !== null
          && attribute.gpuVersion <= previous.gpuVersion;
        if (logicalVisible && count > 0 && frustumIntersects === true
            && draw.mainDrawCount > 0 && logicalVersionIncreased && gpuVersionDidNotAdvance) {
          staleGpuAttribute = true;
          staleGpuAttributeNames.push(attribute.name);
        }
        previousAttributeVersions.set(source, {
          logicalVersion: attribute.logicalVersion,
          gpuVersion: attribute.gpuVersion,
        });
      }
      if (staleGpuAttribute) anomalyCodes.add(`gpu-attribute-stale:${objectIdentity(object)}`);
      if (staleGpuAttribute && meshRole === 'building') staleBuildingMatrixCount += 1;
      if (logicalVisible && count > 0 && frustumIntersects === true && draw.mainDrawCount === 0) {
        anomalyCodes.add(`eligible-instanced-not-drawn:${meshRole}:${objectIdentity(object)}`);
      }
      const matrixWorldConsistent = isMatrixWorldConsistent(THREE, object);
      if (matrixWorldConsistent === false) {
        anomalyCodes.add(`matrix-world-mismatch:${meshRole}:${objectIdentity(object)}`);
      }
      meshStates.push(Object.freeze({
        role: meshRole,
        domain,
        identity: objectIdentity(object),
        name: object.name || null,
        visible: object.visible !== false,
        visibleInHierarchy: logicalVisible,
        frustumCulled: object.frustumCulled !== false,
        frustumIntersects,
        geometry: Object.freeze({
          identity: objectIdentity(object.geometry),
          name: object.geometry?.name || null,
          type: object.geometry?.type ?? object.geometry?.constructor?.name ?? null,
          boundingSphere: sphereSnapshot(object.geometry?.boundingSphere),
          boundingBox: boxSnapshot(object.geometry?.boundingBox),
        }),
        boundingSphere: sphereSnapshot(object.boundingSphere),
        boundingBox: boxSnapshot(object.boundingBox),
        materials: materialSnapshots(object.material),
        count,
        instanceMatrixVersion: attributes.instanceMatrix?.logicalVersion ?? null,
        instanceMatrixGpuVersion: attributes.instanceMatrix?.gpuVersion ?? null,
        instanceColorVersion: attributes.instanceColor?.logicalVersion ?? null,
        instanceColorGpuVersion: attributes.instanceColor?.gpuVersion ?? null,
        attributes,
        ownerKeys: owners,
        stableIds,
        matrixWorld: matrixSnapshot(object.matrixWorld),
        matrixWorldConsistent,
        preRenderLogicalState: capture.preRenderLogicalState.get(object) ?? null,
        actualDrawCount: draw.mainDrawCount,
        shadowDrawCount: draw.shadowDrawCount,
        gpuBufferUploadCount: upload.calls,
        gpuBufferUploadBytes: upload.bytes,
        staleGpuAttribute,
        staleGpuAttributeNames: Object.freeze(staleGpuAttributeNames),
        drawnMaterialIdentities: Object.freeze([...draw.materialIds]),
      }));
      });
    } catch (error) {
      deepCaptureQuarantined = true;
      reportObserverError('scene-traversal-finish', error);
      return null;
    }

    const terrainStates = meshStates.filter(state => state.role.startsWith('terrain-'));
    const visibleTerrain = terrainStates.filter(state => state.visibleInHierarchy);
    const terrainDrawCount = roleDrawCounts['terrain-near']
      + roleDrawCounts['terrain-distant'] + roleDrawCounts['terrain-clipmap'];
    if (frameContext.worldExpected === true && visibleTerrain.length > 0
        && visibleTerrain.every(state => state.frustumCulled && state.frustumIntersects === false)) {
      anomalyCodes.add('all-logical-terrain-frustum-rejected');
    }
    if (frameContext.worldExpected === true
        && roleDrawCounts['terrain-near'] === 0
        && roleDrawCounts['terrain-distant'] === 0
        && roleDrawCounts['terrain-clipmap'] === 0) {
      anomalyCodes.add('all-terrain-presentations-undrawn');
    }
    const currentOwnerKey = frameContext.currentOwnerKey ?? null;
    if (frameContext.worldExpected === true && currentOwnerKey) {
      const currentTerrain = meshStates.filter(state => state.role === 'terrain-near'
        && state.ownerKeys.values.includes(currentOwnerKey));
      if (currentTerrain.length > 0 && currentTerrain.some(state => state.frustumIntersects === true)
          && currentTerrain.every(state => state.actualDrawCount === 0)) {
        anomalyCodes.add(`current-terrain-owner-undrawn:${currentOwnerKey}`);
      }
    }
    if (frameContext.worldExpected === true && terrainDrawCount === 0
        && (roleDrawCounts.building > 0 || roleDrawCounts.natural > 0)) {
      anomalyCodes.add('building-or-natural-drawn-without-terrain');
    }
    if (terrainDrawCount > 0 && staleBuildingMatrixCount > 0) {
      anomalyCodes.add('terrain-drawn-with-stale-building-matrix');
    }
    for (const [stableId, buckets] of stableDrawBuckets) {
      const domains = new Set([...buckets.values()].map(value => value.domain));
      if (domains.size > 1 && buckets.size > 1) {
        anomalyCodes.add(`stable-id-cross-domain-material-draw:${stableId}`);
      }
    }

    const rendererInfo = rendererInfoSnapshot(renderer);
    if (allRenderableDrawCount > 0 && rendererInfo.render.calls === 0) {
      anomalyCodes.add('draw-hooks-with-zero-renderer-calls');
    }
    if (frameContext.worldExpected === true && rendererInfo.render.calls > 0
        && allRenderableDrawCount === 0) {
      anomalyCodes.add('renderer-calls-without-main-draw-hooks');
    }
    if (forceFirstIncident === true && captureCount === 1) {
      anomalyCodes.add('diagnostic-forced-incident');
    }

    const allDuplicateDraws = [...stableDrawBuckets.entries()].map(([stableId, buckets]) => ({
      stableId,
      buckets: [...buckets.values()],
    })).filter(entry => entry.buckets.length > 1);
    const duplicateDraws = allDuplicateDraws.slice(0, ID_SAMPLE_LIMIT);
    const frame = Object.freeze({
      schemaVersion: 'webgl-render-frame-diagnostic-1',
      buildIdentity,
      captureReason: capture.captureReason,
      frameSequence: frameContext.frameSequence ?? null,
      timeMs: Number(clock()),
      transitionGeneration: frameContext.transitionGeneration ?? null,
      renderOriginRevision: frameContext.renderOriginRevision ?? null,
      playerLogicalPosition: frameContext.playerLogicalPosition ?? null,
      rendererInfo,
      gpuBufferUploadCount: capture.frameGpuUploads.calls,
      gpuBufferUploadBytes: capture.frameGpuUploads.bytes,
      unattributedGpuBufferUploadCount: capture.frameGpuUploads.unattributedCalls,
      unattributedGpuBufferUploadBytes: capture.frameGpuUploads.unattributedBytes,
      camera: Object.freeze({
        identity: objectIdentity(camera),
        matrixWorld: matrixSnapshot(camera.matrixWorld),
        projectionMatrix: matrixSnapshot(camera.projectionMatrix),
        matrixWorldInverse: matrixSnapshot(camera.matrixWorldInverse),
      }),
      frustum: currentFrustum?.snapshot ?? null,
      sceneDrawState: Object.freeze({
        sceneIdentity: objectIdentity(scene),
        sceneChildrenCount: scene.children?.length ?? 0,
        roots: Object.freeze(roots),
        allRenderableMainDrawCount: allRenderableDrawCount,
        roleDrawCounts: Object.freeze({ ...roleDrawCounts }),
        drawnOwnerKeys: boundedUnique(drawnOwnerKeys),
        drawnStableIds: boundedUnique(drawnStableIds),
        duplicateDrawnStableIdsAcrossMaterialBuckets: Object.freeze(duplicateDraws),
        duplicateDrawnStableIdCount: allDuplicateDraws.length,
        duplicateDrawnStableIdsTruncated: allDuplicateDraws.length > duplicateDraws.length,
      }),
      meshDrawState: Object.freeze(meshStates),
      anomalyCodes: Object.freeze([...anomalyCodes].sort()),
      captureDurationMs: Math.max(0, Number(clock()) - capture.startedAtMs),
    });
    ring.record(frame, { captureScreenshot: () => captureCanvas(canvas) });
    latestRendererInfo = rendererInfo;
    latestSceneDrawState = frame.sceneDrawState;
    latestMeshDrawState = frame.meshDrawState;
    if (!proofPublisherQuarantined && typeof publishProof === 'function'
        && (captureCount === 1 || frame.anomalyCodes.length > 0)) {
      try {
        publishProof(frame, ring.snapshot());
      } catch (error) {
        proofPublisherQuarantined = true;
        reportObserverError('proof-publisher', error);
      }
    }
    return frame;
  };

  return Object.freeze({
    enabled: active,
    mode: diagnosticMode,
    supported,
    beginFrame,
    finishFrame,
    requestCapture(reason = 'manual') {
      if (!active) return false;
      pendingCaptureReason = String(reason || 'manual');
      return true;
    },
    reset() {
      ring.reset();
      previousAttributeVersions = new WeakMap();
      observedGpuVersions = new WeakMap();
      captureCount = 0;
      latestRendererInfo = null;
      latestSceneDrawState = null;
      latestMeshDrawState = null;
      lastCaptureStartedAtMs = Number.NEGATIVE_INFINITY;
      skippedFrameCount = 0;
      pendingCaptureReason = null;
    },
    snapshot() {
      const ringSnapshot = ring.snapshot();
      return Object.freeze({
        schemaVersion: 'webgl-render-diagnostics-1',
        buildIdentity,
        mode: diagnosticMode,
        enabled: active,
        supported,
        realWebGLRenderer: renderer?.isWebGLRenderer === true,
        captureCount,
        skippedFrameCount,
        sampleIntervalMs,
        lastCaptureStartedAtMs: Number.isFinite(lastCaptureStartedAtMs)
          ? lastCaptureStartedAtMs : null,
        pendingCaptureReason,
        hookInstallFailureCount,
        frustumIntersectionFailureCount,
        observerErrorCount,
        observerLastError,
        proofPublisherQuarantined,
        rendererAttributeLookupQuarantined,
        uploadHookQuarantined,
        frustumProbeQuarantined,
        deepCaptureQuarantined,
        latest: ringSnapshot.latest,
        incidents: ringSnapshot.incidents,
        pendingIncident: ringSnapshot.pendingIncident,
        rendererInfo: latestRendererInfo,
        sceneDrawState: latestSceneDrawState,
        meshDrawState: latestMeshDrawState,
        canvasScreenshot: ringSnapshot.canvasScreenshot,
      });
    },
  });
}
