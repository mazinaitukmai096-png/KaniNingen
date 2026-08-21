(async () => {
  const requestedDurationMs = Number(globalThis.__KANI_PERFORMANCE_CAPTURE_DURATION_MS);
  const durationMs = Number.isFinite(requestedDurationMs) && requestedDurationMs >= 0
    ? requestedDurationMs
    : 60_000;
  const requestedWarmupMs = Number(globalThis.__KANI_PERFORMANCE_CAPTURE_WARMUP_MS);
  const warmupMs = Number.isFinite(requestedWarmupMs) && requestedWarmupMs >= 0
    ? requestedWarmupMs
    : 10_000;
  const captureMetadata = globalThis.__KANI_PERFORMANCE_CAPTURE_METADATA;
  const metadata = captureMetadata && typeof captureMetadata === 'object'
    && !Array.isArray(captureMetadata) ? { ...captureMetadata } : {};
  const controlledSprintScenarios = new Set([
    'steady-state',
    'max-sprint-straight',
    'max-sprint-diagonal',
    'max-sprint-90-turn',
    'max-sprint-reversal',
    'max-sprint-cold-entry',
    'max-sprint-warm-revisit',
  ]);
  const controlledSprint = metadata.controlMode === 'input-driver';
  const steadyCapture = metadata.scenario === 'steady-state';
  if (controlledSprint && !controlledSprintScenarios.has(metadata.scenario)) {
    throw new RangeError('controlled capture requires a recognized MAX Sprint scenario');
  }
  if (controlledSprint && metadata.targetSpeedMetersPerSecond !== (steadyCapture ? 0 : 30)) {
    throw new RangeError(steadyCapture
      ? 'controlled steady-state capture requires exactly 0m/s'
      : 'controlled MAX Sprint capture requires exactly 30m/s');
  }
  if (controlledSprint && (!Number.isSafeInteger(metadata.runNumber)
    || metadata.runNumber < 1 || metadata.runNumber > 5)) {
    throw new RangeError('controlled MAX Sprint capture requires runNumber 1..5');
  }
  if (controlledSprint && !['baseline', 'candidate'].includes(metadata.comparisonRole)) {
    throw new RangeError('controlled capture requires comparisonRole baseline or candidate');
  }
  if (controlledSprint && !((typeof metadata.seed === 'string' && metadata.seed.length > 0)
    || Number.isSafeInteger(metadata.seed))) {
    throw new RangeError('controlled capture requires an explicit deterministic seed label');
  }
  if (controlledSprint && (typeof metadata.checkpoint !== 'string'
    || metadata.checkpoint.length === 0)) {
    throw new RangeError('controlled capture requires an explicit start checkpoint label');
  }
  if (controlledSprint && (typeof metadata.routeRevision !== 'string'
    || metadata.routeRevision.length === 0)) {
    throw new RangeError('controlled capture requires an explicit input route revision');
  }
  if (controlledSprint && (typeof metadata.worldSeedHash !== 'string'
    || metadata.worldSeedHash.length === 0)) {
    throw new RangeError('controlled capture requires the expected canonical worldSeedHash');
  }
  if (controlledSprint && (typeof metadata.startOwnerKey !== 'string'
    || !/^-?\d+,-?\d+$/.test(metadata.startOwnerKey))) {
    throw new RangeError('controlled capture requires the expected startOwnerKey');
  }
  if (controlledSprint && (!Number.isFinite(metadata.checkpointPosition?.x)
    || !Number.isFinite(metadata.checkpointPosition?.z)
    || !Number.isFinite(metadata.checkpointCameraYaw))) {
    throw new RangeError(
      'controlled capture requires finite checkpointPosition x/z and checkpointCameraYaw',
    );
  }
  if (controlledSprint && (typeof metadata.quality !== 'string'
    || metadata.quality.length === 0 || typeof metadata.renderDistance !== 'string'
    || metadata.renderDistance.length === 0)) {
    throw new RangeError('controlled capture requires expected quality and renderDistance');
  }
  if (controlledSprint && (!Number.isSafeInteger(metadata.viewportWidth)
    || metadata.viewportWidth <= 0 || !Number.isSafeInteger(metadata.viewportHeight)
    || metadata.viewportHeight <= 0 || !Number.isFinite(metadata.devicePixelRatio)
    || metadata.devicePixelRatio <= 0)) {
    throw new RangeError('controlled capture requires expected viewport and devicePixelRatio');
  }
  if (controlledSprint && (typeof metadata.rendererIdentity !== 'string'
    || metadata.rendererIdentity.length === 0)) {
    throw new RangeError('controlled capture requires expected rendererIdentity');
  }
  if (controlledSprint && (!Array.isArray(metadata.requiredVisitedOwnerKeys)
    || metadata.requiredVisitedOwnerKeys.some(key => (
      typeof key !== 'string' || !/^-?\d+,-?\d+$/.test(key)
    )))) {
    throw new RangeError('controlled capture requires valid requiredVisitedOwnerKeys');
  }
  const requiredColdWitnessOwnerKeys = Object.freeze(['55,77', '58,71']);
  if (controlledSprint && metadata.scenario === 'max-sprint-cold-entry'
    && !requiredColdWitnessOwnerKeys.every(key => metadata.requiredVisitedOwnerKeys.includes(key))) {
    throw new RangeError('cold-entry capture must require Road 55,77 and Building 58,71 witnesses');
  }
  if (controlledSprint && metadata.scenario === 'max-sprint-warm-revisit'
    && (typeof metadata.revisitOwnerKey !== 'string'
      || !/^-?\d+,-?\d+$/.test(metadata.revisitOwnerKey))) {
    throw new RangeError('warm-revisit capture requires the canonical revisitOwnerKey');
  }
  if (controlledSprint && warmupMs < 10_000) {
    throw new RangeError('controlled capture requires at least 10 seconds of warm-up');
  }
  if (controlledSprint && durationMs < 60_000) {
    throw new RangeError('controlled capture requires at least 60 seconds of sampling');
  }
  const sandbox = globalThis.__infiniteWorldSandbox;
  if (!sandbox || typeof sandbox.snapshot !== 'function') {
    throw new Error('KaniNingen sandbox is not ready. Start the game before running the capture.');
  }

  const statKeys = ['count', 'latest', 'p50', 'p95', 'p99', 'max', 'mean'];
  const presentationKeys = [
    'canonicalRecordCount',
    'canonicalTreeRecordCount',
    'visibleCanonicalTreeCount',
    'visibleCanonicalFullTreeCount',
    'visibleCanonicalForestInstanceCount',
    'visibleCanonicalAtmosphericInstanceCount',
    'visibleCanonicalFarTreeInstanceCount',
    'visibleCanonicalTreePartInstanceCount',
    'canonicalFarTreeTriangleCount',
    'canonicalFarTreeDrawCallEquivalent',
    'canonicalFarTreeMeshCount',
    'staticNaturalResidentOwnerCount',
    'staticNaturalPendingOwnerCount',
    'staticNaturalPersistentRecordCount',
    'staticNaturalCurrentPublishedOwnerCount',
    'staticTreeCanonicalRecordCount',
    'staticTreeInstanceSlotCount',
    'staticTreeResidentOwnerCount',
    'staticTreePendingOwnerCount',
    'staticTreePublishedOwnerCount',
    'staticTreeCurrentPublishedOwnerCount',
    'staticTreeBuildQueuedOwnerCount',
    'staticTreePublicationPendingOwnerCount',
    'staticTreeVisibilityMatrixInvalidationCount',
    'staticTreeMatrixUpdateCount',
    'staticTreeAttributeUpdateCount',
    'staticTreeBufferRangeUpdateCount',
    'staticTreeBufferUploadByteCount',
    'staticTreeCompactionMoveCount',
    'staticTreeOwnerBuildCount',
    'staticTreeOwnerReuseCount',
    'staticTreeMaximumSliceMs',
    'staticTreeMaximumVisibilitySliceMs',
    'distantPersistentMatrixUpdateCount',
    'distantPersistentBufferUpdateCount',
    'distantPersistentUploadByteCount',
    'distantPersistentMaximumSliceMs',
    'terrainGenerationCpuMs',
    'terrainGenerationWallMs',
    'terrainGenerationYieldWaitMs',
    'terrainSliceCount',
    'terrainSliceCpuMs',
    'terrainSliceMaxMs',
    'terrainSliceP95Ms',
    'terrainDeadlineMissCount',
    'terrainDeadlineMissMaxMs',
  ];

  const pick = (source, keys) => {
    if (!source || typeof source !== 'object') return null;
    return Object.fromEntries(keys
      .filter(key => source[key] !== undefined)
      .map(key => [key, source[key]]));
  };
  const stats = source => pick(source, statKeys);
  const summarizeStatsMap = (source, keys) => {
    if (!source || typeof source !== 'object') return null;
    return Object.fromEntries(keys
      .filter(key => source[key] && typeof source[key] === 'object')
      .map(key => [key, stats(source[key])]));
  };
  const summarizePath = path => path && typeof path === 'object' ? {
    pathId: path.pathId ?? null,
    rootNames: Array.isArray(path.rootNames) ? path.rootNames : [],
    rootCount: path.rootCount ?? null,
    meshes: Array.isArray(path.meshes) ? path.meshes.map(mesh => pick(mesh, [
      'name', 'materialName', 'count', 'visible', 'mode',
    ])) : [],
    meshCount: path.meshCount ?? null,
    instanceCount: path.instanceCount ?? null,
    ownerCount: path.ownerCount ?? null,
    stableIdCount: path.stableIdCount ?? null,
    matrixUpdateCount: path.matrixUpdateCount ?? null,
    bufferUpdateCount: path.bufferUpdateCount ?? null,
    visibilityChangeCount: path.visibilityChangeCount ?? null,
    disposeCount: path.disposeCount ?? null,
    active: path.active ?? null,
    hidden: path.hidden ?? null,
  } : null;
  const summarizeSnapshot = snapshot => {
    const diagnostics = snapshot?.diagnostics ?? {};
    const browser = diagnostics.browserFrameAttribution ?? {};
    const stages = diagnostics.stages ?? {};
    const work = diagnostics.work ?? {};
    const visual = snapshot?.visualContinuity ?? {};
    const audit = snapshot?.treePathAudit ?? {};
    const runtimeFrameFailures = Array.isArray(diagnostics.events)
      ? diagnostics.events.filter(event => event?.type === 'runtime-frame-failed') : [];
    return {
      capturedAt: new Date().toISOString(),
      boot: pick(snapshot?.boot, ['status', 'stage', 'loopStarted', 'bootError']),
      runtimeFrameFailureCount: runtimeFrameFailures.length,
      latestRuntimeFrameFailure: runtimeFrameFailures.at(-1) ?? null,
      player: snapshot?.spatial?.playerLogical ?? null,
      scaleStageId: snapshot?.gameplay?.state?.activeScaleStageId ?? null,
      experience: snapshot?.experience ? {
        mode: snapshot.experience.mode ?? null,
        runPhase: snapshot.experience.runPhase ?? null,
        paused: snapshot.experience.paused ?? null,
        cameraYaw: snapshot.experience.camera?.yaw ?? null,
        quality: snapshot.experience.settings?.quality ?? null,
        renderDistance: snapshot.experience.settings?.renderDistance ?? null,
      } : null,
      worldIdentity: {
        worldSeed: snapshot?.gameplay?.state?.worldSeed
          ?? sandbox.generator?.worldSeed ?? null,
        worldSeedHash: snapshot?.gameplay?.state?.worldSeedHash
          ?? sandbox.generator?.worldSeedHash ?? null,
        runtimeBuildIdentity: snapshot?.runtimeBuildIdentity ?? null,
      },
      runtimeCenter: pick(snapshot?.runtime, [
        'centerChunkX', 'centerChunkZ', 'transitionCount', 'activeDataCount',
      ]),
      renderDistanceConsistency: snapshot?.renderDistanceConsistency ? {
        requestedPreset: snapshot.renderDistanceConsistency.requestedPreset ?? null,
        appliedPreset: snapshot.renderDistanceConsistency.appliedPreset ?? null,
        publicationPending: snapshot.renderDistanceConsistency.publicationPending ?? null,
        mixed: snapshot.renderDistanceConsistency.mixed ?? null,
        requestedMismatch: snapshot.renderDistanceConsistency.requestedMismatch ?? null,
        presets: snapshot.renderDistanceConsistency.presets ?? null,
      } : null,
      renderInfo: pick(snapshot?.renderInfo, [
        'drawCalls', 'instances', 'triangles', 'geometries', 'textures',
        'canvasWidth', 'canvasHeight',
      ]),
      sceneObjectCount: snapshot?.sceneObjectCount ?? null,
      frame: stats(diagnostics.frame),
      hitchRatio: diagnostics.hitchRatio ?? null,
      hitchCount: Array.isArray(diagnostics.hitches) ? diagnostics.hitches.length : null,
      longTaskCount: Array.isArray(diagnostics.longTasks) ? diagnostics.longTasks.length : null,
      browserFrame: stats(browser.frame),
      browserCallback: stats(browser.callback),
      over33Ratio: browser.over33Ratio ?? null,
      over50Ratio: browser.over50Ratio ?? null,
      over100Ratio: browser.over100Ratio ?? null,
      gpuOrCompositorWait: browser.gpuOrCompositorWait ?? null,
      memorySignals: browser.memorySignals ?? null,
      terrainReadyGate: browser.terrainReadyGate ?? null,
      terrainCoverageDiagnostics: pick(snapshot?.terrainCoverageDiagnostics, [
        'movementBlockedByTerrain', 'terrainFallbackFrame', 'maximumGenerationLagChunks',
        'preparedMissCount', 'visualBlankFrame', 'visualWorldCoverageMiss',
        'collisionCoverageMiss',
      ]),
      stages: {
        render: stats(stages.render),
        distantUpdate: stats(stages['distant-update']),
        distantSync: stats(stages['distant-sync']),
        gameplayUpdate: stats(stages['gameplay-update']),
        chunkTransition: stats(stages['chunk-transition']),
      },
      work: {
        persistentNatural: summarizeStatsMap(work['persistent-natural-frame'], [
          'calls', 'admittedOwners', 'publishedOwners', 'builtOwners', 'disposedOwners',
          'residentOwners', 'pendingPages', 'pendingPublications', 'disposeBacklog',
          'compactionMoves', 'visibilityMatrixInvalidations', 'matrixUpdates',
          'attributeUpdates', 'bufferRangeUpdates', 'bufferUploadBytes',
          'visibilityMs', 'visibilityQueueBefore', 'visibilityQueueAfter',
          'visibilityObjectsProcessed', 'composeMs', 'disposeMs', 'buildMs',
          'buildMaximumSliceMs', 'totalMs',
        ]),
        runtimeHandoff: summarizeStatsMap(work['runtime-presentation-handoff'], [
          'calls', 'durationMs', 'meshUpdates', 'matrixUpdates', 'bufferUpdates',
          'uploadBytes', 'localTerrainHandoffs', 'distantAdmissions',
          'distantUploadBytes',
        ]),
        staticAdmission: summarizeStatsMap(work['static-natural-ready-admission'], [
          'calls', 'admittedOwners', 'admissionLimit', 'readyPageBacklog',
          'readyRequiredOwners', 'missingRequiredOwners', 'requestBacklog',
        ]),
      },
      presentation: pick(snapshot?.presentation, presentationKeys),
      staticObjectStreaming: pick(snapshot?.staticObjectStreaming, [
        'requiredOwnerCount', 'visualRequiredOwnerCount', 'visualExpectedOwnerCount',
        'readyOwnerCount', 'readyPageQueueCount', 'queuedCount',
        'pendingAdmissionCount', 'inFlightCount', 'backlog',
        'maximumPendingTaskAgeMs', 'oldestPendingTaskAgeMs', 'counts',
      ]),
      ownerGeneration: pick(snapshot?.ownerGeneration, [
        'queuedCount', 'inFlightCount', 'backlog', 'maximumBacklog', 'counts',
      ]),
      visualContinuity: {
        ...pick(visual, [
          'expectedOwnerCount', 'coarseDrawableCount', 'detailDrawableCount',
          'deadlineMissCount', 'maxDeadlineMissMs', 'oldestMissingAgeMs',
        ]),
        receiptScanMetrics: pick(visual.receiptScanMetrics, [
          'canonicalCoarseTreeSlotScanCount',
          'canonicalCoarseTreeSlotScanEarlyOutCount',
        ]),
      },
      treePathAudit: {
        treeStaticStreamActivated: audit.treeStaticStreamActivated ?? null,
        treeStaticStreamSuspended: audit.treeStaticStreamSuspended ?? null,
        near: summarizePath(audit.near),
        distant: Array.isArray(audit.distant) ? audit.distant.map(summarizePath) : [],
      },
    };
  };
  const finite = value => Number.isFinite(value) ? value : null;
  const delta = (after, before) => {
    const a = finite(after);
    const b = finite(before);
    return a === null || b === null ? null : a - b;
  };
  const counterDeltas = (before, after) => ({
    recordedFrameCount: delta(after?.frame?.count, before?.frame?.count),
    runtimeFrameFailureCount: delta(
      after?.runtimeFrameFailureCount,
      before?.runtimeFrameFailureCount,
    ),
    staticTreeMatrixUpdates: delta(
      after?.presentation?.staticTreeMatrixUpdateCount,
      before?.presentation?.staticTreeMatrixUpdateCount,
    ),
    staticTreeBufferUpdates: delta(
      after?.presentation?.staticTreeBufferRangeUpdateCount,
      before?.presentation?.staticTreeBufferRangeUpdateCount,
    ),
    staticTreeBufferUploadBytes: delta(
      after?.presentation?.staticTreeBufferUploadByteCount,
      before?.presentation?.staticTreeBufferUploadByteCount,
    ),
    distantPersistentMatrixUpdates: delta(
      after?.presentation?.distantPersistentMatrixUpdateCount,
      before?.presentation?.distantPersistentMatrixUpdateCount,
    ),
    distantPersistentBufferUpdates: delta(
      after?.presentation?.distantPersistentBufferUpdateCount,
      before?.presentation?.distantPersistentBufferUpdateCount,
    ),
    distantPersistentUploadBytes: delta(
      after?.presentation?.distantPersistentUploadByteCount,
      before?.presentation?.distantPersistentUploadByteCount,
    ),
    terrainSliceCount: delta(
      after?.presentation?.terrainSliceCount,
      before?.presentation?.terrainSliceCount,
    ),
  });
  const percentile = (ordered, fraction) => ordered.length === 0 ? 0 : ordered[
    Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1))
  ];
  const distribution = values => {
    if (values.length === 0) {
      return { count: 0, latest: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
    }
    const ordered = [...values].sort((left, right) => left - right);
    return {
      count: values.length,
      latest: values.at(-1),
      p50: percentile(ordered, 0.5),
      p95: percentile(ordered, 0.95),
      p99: percentile(ordered, 0.99),
      max: ordered.at(-1),
      mean: ordered.reduce((sum, value) => sum + value, 0) / ordered.length,
    };
  };
  const ratioOver = (values, thresholdMs) => values.length === 0
    ? 0 : values.filter(value => value > thresholdMs).length / values.length;
  const readHeapBytes = () => {
    const value = globalThis.performance?.memory?.usedJSHeapSize;
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const summarizeMemory = samples => {
    const usable = samples.filter(sample => Number.isFinite(sample.usedJSHeapSize));
    let allocationSpikeCount = 0;
    let garbageCollectionDropCount = 0;
    for (let index = 1; index < usable.length; index += 1) {
      const change = usable[index].usedJSHeapSize - usable[index - 1].usedJSHeapSize;
      allocationSpikeCount += Number(change >= 2 * 1024 * 1024);
      garbageCollectionDropCount += Number(change <= -2 * 1024 * 1024);
    }
    const first = usable[0] ?? null;
    const last = usable.at(-1) ?? null;
    const elapsedMinutes = first && last
      ? Math.max(0, last.atMs - first.atMs) / 60_000 : 0;
    const heapDeltaBytes = first && last
      ? last.usedJSHeapSize - first.usedJSHeapSize : null;
    return {
      source: globalThis.performance?.memory ? 'performance.memory' : 'unavailable',
      sampleCount: usable.length,
      heapStartBytes: first?.usedJSHeapSize ?? null,
      heapEndBytes: last?.usedJSHeapSize ?? null,
      heapDeltaBytes,
      heapSlopeBytesPerMinute: heapDeltaBytes !== null && elapsedMinutes > 0
        ? heapDeltaBytes / elapsedMinutes : null,
      allocationSpikeCount,
      garbageCollectionDropCount,
      samples: usable,
    };
  };
  const canonicalOwnerAxis = value => {
    if (!Number.isFinite(value)) return null;
    const scaled = value / 16;
    return Number.isInteger(scaled) ? scaled - 1 : Math.floor(scaled);
  };
  const canonicalOwnerAt = (x, z) => {
    const chunkX = canonicalOwnerAxis(x);
    const chunkZ = canonicalOwnerAxis(z);
    return Number.isSafeInteger(chunkX) && Number.isSafeInteger(chunkZ)
      ? { chunkX, chunkZ, key: `${chunkX},${chunkZ}` } : null;
  };
  const readRendererIdentity = () => {
    const canvases = [...(globalThis.document?.querySelectorAll?.('canvas') ?? [])];
    let gl = null;
    for (const canvas of canvases) {
      gl = canvas.getContext?.('webgl2') ?? canvas.getContext?.('webgl') ?? null;
      if (gl) break;
    }
    if (!gl) return {
      supported: false,
      vendor: null,
      renderer: null,
      unmaskedVendor: null,
      unmaskedRenderer: null,
      identity: null,
      hardwareAccelerated: false,
    };
    const extension = gl.getExtension?.('WEBGL_debug_renderer_info') ?? null;
    const vendor = gl.getParameter?.(gl.VENDOR) ?? null;
    const renderer = gl.getParameter?.(gl.RENDERER) ?? null;
    const unmaskedVendor = extension
      ? gl.getParameter?.(extension.UNMASKED_VENDOR_WEBGL) ?? null : null;
    const unmaskedRenderer = extension
      ? gl.getParameter?.(extension.UNMASKED_RENDERER_WEBGL) ?? null : null;
    const identity = [unmaskedVendor ?? vendor, unmaskedRenderer ?? renderer]
      .map(value => String(value ?? '').trim()).join(' | ');
    const software = /swiftshader|llvmpipe|lavapipe|software|microsoft basic render/i
      .test(identity);
    return {
      supported: true,
      vendor,
      renderer,
      unmaskedVendor,
      unmaskedRenderer,
      identity,
      hardwareAccelerated: typeof unmaskedRenderer === 'string'
        && unmaskedRenderer.length > 0 && !software,
    };
  };

  if (warmupMs > 0) {
    console.info(`KaniNingen performance warm-up started (${warmupMs / 1_000} seconds).`);
    await new Promise(resolve => setTimeout(resolve, warmupMs));
  }

  const rendererIdentity = readRendererIdentity();
  let raw = sandbox.snapshot();
  const before = summarizeSnapshot(raw);
  raw = null;
  const startedAt = new Date().toISOString();
  const sampleStartedAtMs = globalThis.performance?.now?.() ?? Date.now();
  const frameIntervals = [];
  const longTasks = [];
  const memorySamples = [];
  const visibilityChanges = [];
  const controlledStart = controlledSprint ? {
    x: sandbox.logicalPlayer.x,
    z: sandbox.logicalPlayer.z,
  } : null;
  const controlledStartOwner = controlledSprint
    ? canonicalOwnerAt(controlledStart.x, controlledStart.z) : null;
  const visitedOwnerKeys = new Set(controlledStartOwner ? [controlledStartOwner.key] : []);
  const visitedOwnerSequence = controlledStartOwner ? [controlledStartOwner.key] : [];
  let controlledLastOwnerX = controlledStartOwner?.chunkX ?? null;
  let controlledLastOwnerZ = controlledStartOwner?.chunkZ ?? null;
  const controlledInputTransitions = [];
  const activeControlKeys = new Set();
  let controlledPathDistanceMeters = 0;
  let controlledFrameCount = 0;
  let controlledLastX = controlledStart?.x ?? null;
  let controlledLastZ = controlledStart?.z ?? null;
  let controlledReverseIssued = false;
  let controlPressedAtMs = null;
  let controlReleasedAtMs = null;
  let priorFrameTimestamp = null;
  let animationFrameId = null;
  let memoryTimer = null;
  const recordMemory = () => memorySamples.push({
    atMs: (globalThis.performance?.now?.() ?? Date.now()) - sampleStartedAtMs,
    usedJSHeapSize: readHeapBytes(),
  });
  const keyboardKey = code => ({
    KeyW: 'w', KeyD: 'd', KeyS: 's', ShiftLeft: 'Shift',
  })[code] ?? code;
  const dispatchControlKey = (type, code) => {
    if (typeof globalThis.KeyboardEvent !== 'function'
      || typeof globalThis.dispatchEvent !== 'function') {
      throw new Error('controlled input capture requires Browser KeyboardEvent dispatch');
    }
    globalThis.dispatchEvent(new globalThis.KeyboardEvent(type, {
      code,
      key: keyboardKey(code),
      bubbles: true,
      cancelable: true,
      repeat: false,
    }));
    controlledInputTransitions.push({
      atMs: (globalThis.performance?.now?.() ?? Date.now()) - sampleStartedAtMs,
      type,
      code,
    });
    if (type === 'keydown') activeControlKeys.add(code);
    else activeControlKeys.delete(code);
  };
  const startInputControl = () => {
    if (!controlledSprint) return;
    controlPressedAtMs = globalThis.performance?.now?.() ?? Date.now();
    if (steadyCapture) return;
    dispatchControlKey('keydown', 'ShiftLeft');
    dispatchControlKey('keydown', 'KeyW');
    if (metadata.scenario === 'max-sprint-diagonal') {
      dispatchControlKey('keydown', 'KeyD');
    }
  };
  const releaseInputControl = () => {
    if (!controlledSprint || controlReleasedAtMs !== null) return;
    for (const code of [...activeControlKeys]) dispatchControlKey('keyup', code);
    controlReleasedAtMs = globalThis.performance?.now?.() ?? Date.now();
  };
  const observeControlledPlayer = () => {
    if (!controlledSprint) return;
    const x = sandbox.logicalPlayer.x;
    const z = sandbox.logicalPlayer.z;
    if (Number.isFinite(x) && Number.isFinite(z)
      && Number.isFinite(controlledLastX) && Number.isFinite(controlledLastZ)) {
      controlledPathDistanceMeters += Math.hypot(x - controlledLastX, z - controlledLastZ);
    }
    controlledLastX = x;
    controlledLastZ = z;
    const owner = canonicalOwnerAt(x, z);
    if (owner && (owner.chunkX !== controlledLastOwnerX
      || owner.chunkZ !== controlledLastOwnerZ)) {
      controlledLastOwnerX = owner.chunkX;
      controlledLastOwnerZ = owner.chunkZ;
      visitedOwnerKeys.add(owner.key);
      visitedOwnerSequence.push(owner.key);
    }
    controlledFrameCount += 1;
  };
  const recordFrame = timestampMs => {
    observeControlledPlayer();
    if (priorFrameTimestamp !== null) {
      const intervalMs = Math.max(0, timestampMs - priorFrameTimestamp);
      frameIntervals.push(intervalMs);
    }
    if (controlledSprint && metadata.scenario === 'max-sprint-90-turn'
      && !controlledReverseIssued && timestampMs - sampleStartedAtMs >= durationMs / 2) {
      dispatchControlKey('keyup', 'KeyW');
      dispatchControlKey('keydown', 'KeyD');
      controlledReverseIssued = true;
    }
    if (controlledSprint
      && ['max-sprint-reversal', 'max-sprint-warm-revisit'].includes(metadata.scenario)
      && !controlledReverseIssued && timestampMs - sampleStartedAtMs >= durationMs / 2) {
      dispatchControlKey('keyup', 'KeyW');
      dispatchControlKey('keydown', 'KeyS');
      controlledReverseIssued = true;
    }
    priorFrameTimestamp = timestampMs;
    animationFrameId = globalThis.requestAnimationFrame(recordFrame);
  };
  const recordVisibility = () => visibilityChanges.push({
    atMs: (globalThis.performance?.now?.() ?? Date.now()) - sampleStartedAtMs,
    visibilityState: globalThis.document?.visibilityState ?? null,
  });
  const consumeLongTaskEntries = entries => {
    for (const entry of entries) {
      if (longTasks.length >= 2_048) break;
      longTasks.push({
        startTime: Number(entry.startTime ?? 0),
        durationMs: Number(entry.duration ?? 0),
      });
    }
  };
  let longTaskObserver = null;
  if (typeof globalThis.PerformanceObserver === 'function') {
    try {
      longTaskObserver = new globalThis.PerformanceObserver(list => (
        consumeLongTaskEntries(list.getEntries())
      ));
      longTaskObserver.observe({ type: 'longtask', buffered: false });
    } catch {
      longTaskObserver = null;
    }
  }
  recordMemory();
  recordVisibility();
  globalThis.document?.addEventListener?.('visibilitychange', recordVisibility);
  const previousCaptureActive = globalThis.__KANI_PERFORMANCE_CAPTURE_ACTIVE;
  globalThis.__KANI_PERFORMANCE_CAPTURE_ACTIVE = true;
  try {
    startInputControl();
    animationFrameId = globalThis.requestAnimationFrame(recordFrame);
    if (durationMs > 0) memoryTimer = globalThis.setInterval(recordMemory, 1_000);
    console.info(`KaniNingen performance sample started (${durationMs / 1_000} seconds).`);
    await new Promise(resolve => setTimeout(resolve, durationMs));
  } finally {
    observeControlledPlayer();
    releaseInputControl();
    if (animationFrameId !== null) globalThis.cancelAnimationFrame(animationFrameId);
    if (memoryTimer !== null) globalThis.clearInterval(memoryTimer);
    consumeLongTaskEntries(longTaskObserver?.takeRecords?.() ?? []);
    longTaskObserver?.disconnect?.();
    globalThis.document?.removeEventListener?.('visibilitychange', recordVisibility);
    if (previousCaptureActive === undefined) {
      delete globalThis.__KANI_PERFORMANCE_CAPTURE_ACTIVE;
    } else globalThis.__KANI_PERFORMANCE_CAPTURE_ACTIVE = previousCaptureActive;
  }
  recordMemory();

  raw = sandbox.snapshot();
  const after = summarizeSnapshot(raw);
  raw = null;
  const finishedAt = new Date().toISOString();
  const measuredDurationMs = Math.max(
    0,
    (globalThis.performance?.now?.() ?? Date.now()) - sampleStartedAtMs,
  );
  const frame = distribution(frameIntervals);
  const longTaskDurations = longTasks.map(entry => entry.durationMs)
    .filter(Number.isFinite);
  const scenario = String(metadata.scenario ?? 'unspecified');
  const runNumber = Number.isSafeInteger(metadata.runNumber) ? metadata.runNumber : null;
  const expectedState = {
    worldSeed: metadata.seed ?? null,
    worldSeedHash: metadata.worldSeedHash ?? null,
    checkpoint: metadata.checkpoint ?? null,
    checkpointPosition: metadata.checkpointPosition ?? null,
    checkpointCameraYaw: metadata.checkpointCameraYaw ?? null,
    checkpointToleranceMeters: Number.isFinite(metadata.checkpointToleranceMeters)
      ? metadata.checkpointToleranceMeters : 0.05,
    startOwnerKey: metadata.startOwnerKey ?? null,
    quality: metadata.quality ?? null,
    renderDistance: metadata.renderDistance ?? null,
    viewportWidth: metadata.viewportWidth ?? null,
    viewportHeight: metadata.viewportHeight ?? null,
    devicePixelRatio: metadata.devicePixelRatio ?? null,
    rendererIdentity: metadata.rendererIdentity ?? null,
    hardwareAccelerated: true,
    requiredVisitedOwnerKeys: Array.isArray(metadata.requiredVisitedOwnerKeys)
      ? [...new Set(metadata.requiredVisitedOwnerKeys)].sort((left, right) => (
        left.localeCompare(right)
      )) : [],
    revisitOwnerKey: metadata.revisitOwnerKey ?? null,
  };
  const actualState = {
    worldSeed: before?.worldIdentity?.worldSeed ?? null,
    worldSeedHash: before?.worldIdentity?.worldSeedHash ?? null,
    worldSeedAfter: after?.worldIdentity?.worldSeed ?? null,
    worldSeedHashAfter: after?.worldIdentity?.worldSeedHash ?? null,
    start: controlledStart,
    startOwnerKey: controlledStartOwner?.key ?? null,
    startRuntimeCenterKey: Number.isSafeInteger(before?.runtimeCenter?.centerChunkX)
      && Number.isSafeInteger(before?.runtimeCenter?.centerChunkZ)
      ? `${before.runtimeCenter.centerChunkX},${before.runtimeCenter.centerChunkZ}` : null,
    endOwnerKey: canonicalOwnerAt(
      sandbox.logicalPlayer.x,
      sandbox.logicalPlayer.z,
    )?.key ?? null,
    qualityBefore: before?.experience?.quality ?? null,
    qualityAfter: after?.experience?.quality ?? null,
    renderDistanceBefore: before?.experience?.renderDistance ?? null,
    renderDistanceAfter: after?.experience?.renderDistance ?? null,
    renderDistanceConsistencyBefore: before?.renderDistanceConsistency ?? null,
    renderDistanceConsistencyAfter: after?.renderDistanceConsistency ?? null,
    viewportWidth: globalThis.innerWidth ?? null,
    viewportHeight: globalThis.innerHeight ?? null,
    devicePixelRatio: globalThis.devicePixelRatio ?? null,
    renderer: rendererIdentity,
    cameraYawBefore: before?.experience?.cameraYaw ?? null,
    canvasWidthBefore: before?.renderInfo?.canvasWidth ?? null,
    canvasHeightBefore: before?.renderInfo?.canvasHeight ?? null,
    visitedOwnerKeys: [...visitedOwnerKeys],
    visitedOwnerSequence: [...visitedOwnerSequence],
  };
  const validationIssues = [];
  const expectEqual = (field, expected, actual) => {
    if (Object.is(expected, actual)) return;
    validationIssues.push({ field, expected, actual });
  };
  if (controlledSprint) {
    expectEqual('worldSeed', String(expectedState.worldSeed), String(actualState.worldSeed));
    expectEqual('worldSeedHash', expectedState.worldSeedHash, actualState.worldSeedHash);
    expectEqual('worldSeedAfter', String(expectedState.worldSeed), String(actualState.worldSeedAfter));
    expectEqual('worldSeedHashAfter', expectedState.worldSeedHash, actualState.worldSeedHashAfter);
    expectEqual('startOwnerKey', expectedState.startOwnerKey, actualState.startOwnerKey);
    expectEqual(
      'startRuntimeCenterKey',
      expectedState.startOwnerKey,
      actualState.startRuntimeCenterKey,
    );
    const checkpointDistanceMeters = Number.isFinite(actualState.start?.x)
      && Number.isFinite(actualState.start?.z)
      ? Math.hypot(
        actualState.start.x - expectedState.checkpointPosition.x,
        actualState.start.z - expectedState.checkpointPosition.z,
      ) : Number.POSITIVE_INFINITY;
    if (!(checkpointDistanceMeters <= expectedState.checkpointToleranceMeters)) {
      validationIssues.push({
        field: 'checkpointPosition',
        expected: expectedState.checkpointPosition,
        actual: actualState.start,
        toleranceMeters: expectedState.checkpointToleranceMeters,
        distanceMeters: checkpointDistanceMeters,
      });
    }
    expectEqual(
      'checkpointCameraYaw',
      expectedState.checkpointCameraYaw,
      actualState.cameraYawBefore,
    );
    expectEqual('qualityBefore', expectedState.quality, actualState.qualityBefore);
    expectEqual('qualityAfter', expectedState.quality, actualState.qualityAfter);
    expectEqual(
      'renderDistanceBefore',
      expectedState.renderDistance,
      actualState.renderDistanceBefore,
    );
    expectEqual(
      'renderDistanceAfter',
      expectedState.renderDistance,
      actualState.renderDistanceAfter,
    );
    for (const [phase, consistency] of [
      ['before', actualState.renderDistanceConsistencyBefore],
      ['after', actualState.renderDistanceConsistencyAfter],
    ]) {
      expectEqual(`renderDistanceConsistency.${phase}.requestedPreset`,
        expectedState.renderDistance, consistency?.requestedPreset ?? null);
      expectEqual(`renderDistanceConsistency.${phase}.appliedPreset`,
        expectedState.renderDistance, consistency?.appliedPreset ?? null);
      expectEqual(`renderDistanceConsistency.${phase}.publicationPending`,
        false, consistency?.publicationPending ?? null);
      expectEqual(`renderDistanceConsistency.${phase}.mixed`, false, consistency?.mixed ?? null);
      expectEqual(`renderDistanceConsistency.${phase}.requestedMismatch`,
        false, consistency?.requestedMismatch ?? null);
      for (const [name, preset] of Object.entries(consistency?.presets ?? {})) {
        if (preset !== null) expectEqual(
          `renderDistanceConsistency.${phase}.presets.${name}`,
          expectedState.renderDistance,
          preset,
        );
      }
    }
    expectEqual('viewportWidth', expectedState.viewportWidth, actualState.viewportWidth);
    expectEqual('viewportHeight', expectedState.viewportHeight, actualState.viewportHeight);
    expectEqual(
      'devicePixelRatio',
      expectedState.devicePixelRatio,
      actualState.devicePixelRatio,
    );
    expectEqual(
      'renderer.canvasWidth',
      Math.round(expectedState.viewportWidth * expectedState.devicePixelRatio),
      actualState.canvasWidthBefore,
    );
    expectEqual(
      'renderer.canvasHeight',
      Math.round(expectedState.viewportHeight * expectedState.devicePixelRatio),
      actualState.canvasHeightBefore,
    );
    expectEqual(
      'rendererIdentity',
      expectedState.rendererIdentity,
      actualState.renderer.identity,
    );
    expectEqual('renderer.hardwareAccelerated', true, actualState.renderer.hardwareAccelerated);
    const visited = new Set(actualState.visitedOwnerKeys);
    for (const ownerKey of expectedState.requiredVisitedOwnerKeys) {
      if (!visited.has(ownerKey)) validationIssues.push({
        field: `visitedOwnerKeys.${ownerKey}`,
        expected: true,
        actual: false,
      });
    }
    if (scenario === 'max-sprint-warm-revisit') {
      const revisitCount = actualState.visitedOwnerSequence.filter(
        ownerKey => ownerKey === expectedState.revisitOwnerKey,
      ).length;
      if (revisitCount < 2) validationIssues.push({
        field: `revisitOwnerKey.${expectedState.revisitOwnerKey}`,
        expected: 'visited-at-least-twice',
        actual: revisitCount,
      });
    }
  }
  const captureValidation = {
    schemaVersion: 'kani-performance-capture-state-validation-1',
    applicable: controlledSprint,
    valid: validationIssues.length === 0,
    expected: expectedState,
    actual: actualState,
    issues: validationIssues,
  };
  const result = {
    schemaVersion: 'kani-performance-capture-2',
    source: {
      label: String(metadata.label ?? `${scenario}-run-${runNumber ?? 'unassigned'}`),
      scenario,
      runNumber,
      comparisonRole: metadata.comparisonRole ?? null,
      controlMode: metadata.controlMode ?? 'manual',
      targetSpeedMetersPerSecond: metadata.targetSpeedMetersPerSecond ?? null,
      routeRevision: metadata.routeRevision ?? null,
      checkpoint: metadata.checkpoint ?? null,
      seed: metadata.seed ?? null,
      worldSeed: actualState.worldSeed,
      worldSeedHash: actualState.worldSeedHash,
      startOwnerKey: actualState.startOwnerKey,
      quality: actualState.qualityBefore,
      renderDistance: actualState.renderDistanceBefore,
      rendererIdentity: actualState.renderer.identity,
      rendererHardwareAccelerated: actualState.renderer.hardwareAccelerated,
      visitedOwnerKeys: actualState.visitedOwnerKeys,
      visitedOwnerSequence: actualState.visitedOwnerSequence,
      requiredVisitedOwnerKeys: expectedState.requiredVisitedOwnerKeys,
      revisitOwnerKey: expectedState.revisitOwnerKey,
      warmupMs,
      requestedDurationMs: durationMs,
      startedAt,
      finishedAt,
      measuredDurationMs,
      pageUrl: globalThis.location?.href ?? null,
      userAgent: globalThis.navigator?.userAgent ?? null,
      hardwareConcurrency: globalThis.navigator?.hardwareConcurrency ?? null,
      deviceMemoryGiB: globalThis.navigator?.deviceMemory ?? null,
      devicePixelRatio: globalThis.devicePixelRatio ?? null,
      viewportWidth: globalThis.innerWidth ?? null,
      viewportHeight: globalThis.innerHeight ?? null,
      visibilityState: globalThis.document?.visibilityState ?? null,
    },
    sample: {
      frame,
      onePercentLowFps: frame.p99 > 0 ? 1_000 / frame.p99 : 0,
      over20Ratio: ratioOver(frameIntervals, 20),
      over33Ratio: ratioOver(frameIntervals, 33),
      over50Ratio: ratioOver(frameIntervals, 50),
      over100Ratio: ratioOver(frameIntervals, 100),
      worstFrameIntervalsMs: [...frameIntervals]
        .sort((left, right) => right - left).slice(0, 20),
      longTasks: {
        supported: longTaskObserver !== null,
        ...distribution(longTaskDurations),
        over100Count: longTaskDurations.filter(value => value > 100).length,
        records: longTasks,
      },
      memory: summarizeMemory(memorySamples),
      visibilityChanges,
      control: controlledSprint ? {
        scenario,
        targetSpeedMetersPerSecond: metadata.targetSpeedMetersPerSecond,
        frameCount: controlledFrameCount,
        commandDurationMs: Math.max(0, controlReleasedAtMs - controlPressedAtMs),
        actualPathDistanceMeters: controlledPathDistanceMeters,
        actualAverageSpeedMetersPerSecond: controlReleasedAtMs > controlPressedAtMs
          ? controlledPathDistanceMeters
            / ((controlReleasedAtMs - controlPressedAtMs) / 1_000) : 0,
        expectedDistanceMeters: metadata.targetSpeedMetersPerSecond
          * Math.max(0, controlReleasedAtMs - controlPressedAtMs) / 1_000,
        netDisplacementMeters: Math.hypot(
          sandbox.logicalPlayer.x - controlledStart.x,
          sandbox.logicalPlayer.z - controlledStart.z,
        ),
        inputTransitions: controlledInputTransitions,
        start: controlledStart,
        end: {
          x: sandbox.logicalPlayer.x,
          z: sandbox.logicalPlayer.z,
        },
      } : null,
    },
    before,
    after,
    counterDeltas: counterDeltas(before, after),
    validation: captureValidation,
  };
  const stamp = finishedAt.replaceAll(':', '-').replaceAll('.', '-');
  const safeScenario = scenario.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '')
    || 'unspecified';
  const fileName = `kani-performance-capture-${safeScenario}-run-${
    runNumber ?? 'unassigned'}-${stamp}.json`;
  const blob = new Blob([`${JSON.stringify(result, null, 2)}\n`], {
    type: 'application/json',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  console.info(`KaniNingen performance capture finished: ${fileName}`, result);
  return result;
})().catch(error => {
  console.error('KaniNingen compact performance capture failed.', error);
  throw error;
});
