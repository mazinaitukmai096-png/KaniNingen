(async () => {
  const requestedDurationMs = Number(globalThis.__KANI_PERFORMANCE_CAPTURE_DURATION_MS);
  const durationMs = Number.isFinite(requestedDurationMs) && requestedDurationMs >= 0
    ? requestedDurationMs
    : 45_000;
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
    return {
      capturedAt: new Date().toISOString(),
      player: snapshot?.spatial?.playerLogical ?? null,
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
  const deltas = (before, after) => ({
    frameCount: delta(after?.frame?.count, before?.frame?.count),
    frameP50Ms: delta(after?.frame?.p50, before?.frame?.p50),
    frameP95Ms: delta(after?.frame?.p95, before?.frame?.p95),
    renderP50Ms: delta(after?.stages?.render?.p50, before?.stages?.render?.p50),
    renderP95Ms: delta(after?.stages?.render?.p95, before?.stages?.render?.p95),
    drawCalls: delta(after?.renderInfo?.drawCalls, before?.renderInfo?.drawCalls),
    rendererTriangles: delta(after?.renderInfo?.triangles, before?.renderInfo?.triangles),
    canonicalTreeRecords: delta(
      after?.presentation?.staticTreeCanonicalRecordCount,
      before?.presentation?.staticTreeCanonicalRecordCount,
    ),
    persistentTreeInstanceSlots: delta(
      after?.presentation?.staticTreeInstanceSlotCount,
      before?.presentation?.staticTreeInstanceSlotCount,
    ),
  });

  const startedAt = new Date().toISOString();
  let raw = sandbox.snapshot();
  const before = summarizeSnapshot(raw);
  raw = null;
  console.info(`KaniNingen compact performance capture started (${durationMs / 1_000} seconds).`);
  await new Promise(resolve => setTimeout(resolve, durationMs));
  raw = sandbox.snapshot();
  const after = summarizeSnapshot(raw);
  raw = null;
  const finishedAt = new Date().toISOString();
  const result = {
    schemaVersion: 'kani-performance-summary-1',
    source: {
      label: 'all-distance-low-poly-tree-after',
      startedAt,
      finishedAt,
      measuredDurationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      pageUrl: globalThis.location?.href ?? null,
      userAgent: globalThis.navigator?.userAgent ?? null,
      hardwareConcurrency: globalThis.navigator?.hardwareConcurrency ?? null,
      deviceMemoryGiB: globalThis.navigator?.deviceMemory ?? null,
      devicePixelRatio: globalThis.devicePixelRatio ?? null,
      viewportWidth: globalThis.innerWidth ?? null,
      viewportHeight: globalThis.innerHeight ?? null,
    },
    before,
    after,
    deltas: deltas(before, after),
  };
  const stamp = finishedAt.replaceAll(':', '-').replaceAll('.', '-');
  const fileName = `kani-performance-summary-${stamp}.json`;
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
  console.info(`KaniNingen compact performance capture finished: ${fileName}`, result);
  return result;
})().catch(error => {
  console.error('KaniNingen compact performance capture failed.', error);
  throw error;
});
