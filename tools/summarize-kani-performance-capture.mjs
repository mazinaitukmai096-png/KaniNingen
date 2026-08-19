import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';

const STAT_KEYS = Object.freeze(['count', 'latest', 'p50', 'p95', 'p99', 'max', 'mean']);
const RENDER_INFO_KEYS = Object.freeze([
  'drawCalls', 'instances', 'triangles', 'geometries', 'textures',
  'canvasWidth', 'canvasHeight',
]);
const PRESENTATION_KEYS = Object.freeze([
  'canonicalRecordCount',
  'canonicalTreeRecordCount',
  'visibleCanonicalTreeCount',
  'visibleCanonicalFullTreeCount',
  'visibleCanonicalSilhouetteTreeCount',
  'visibleCanonicalUltraTreeCount',
  'visibleCanonicalForestInstanceCount',
  'visibleCanonicalAtmosphericInstanceCount',
  'visibleCanonicalFarTreeInstanceCount',
  'visibleCanonicalTreePartInstanceCount',
  'naturalLodMeshCount',
  'naturalLodVisibleMeshCount',
  'naturalLodInstanceCapacity',
  'naturalLodVisibleInstanceCount',
  'canonicalFarTreeTriangleCount',
  'canonicalFarTreeDrawCallEquivalent',
  'canonicalFarTreeMeshCount',
  'canonicalFarTreeInstanceCapacity',
  'canonicalFarTreeVisibleInstanceCount',
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
]);
const STATIC_KEYS = Object.freeze([
  'requiredOwnerCount',
  'visualRequiredOwnerCount',
  'visualExpectedOwnerCount',
  'readyOwnerCount',
  'readyPageQueueCount',
  'queuedCount',
  'pendingAdmissionCount',
  'inFlightCount',
  'backlog',
  'maximumPendingTaskAgeMs',
  'oldestPendingTaskAgeMs',
  'counts',
]);
const OWNER_KEYS = Object.freeze([
  'queuedCount', 'inFlightCount', 'backlog', 'maximumBacklog', 'counts',
]);
const VISUAL_KEYS = Object.freeze([
  'expectedOwnerCount',
  'coarseDrawableCount',
  'detailDrawableCount',
  'deadlineMissCount',
  'maxDeadlineMissMs',
  'oldestMissingAgeMs',
]);
const WORK_METRIC_KEYS = Object.freeze({
  'persistent-natural-frame': Object.freeze([
    'calls', 'admittedOwners', 'publishedOwners', 'builtOwners', 'disposedOwners',
    'residentOwners', 'pendingPages', 'pendingPublications', 'disposeBacklog',
    'compactionMoves', 'visibilityMatrixInvalidations', 'matrixUpdates',
    'attributeUpdates', 'bufferRangeUpdates', 'bufferUploadBytes',
    'visibilityMs', 'visibilityQueueBefore', 'visibilityQueueAfter',
    'visibilityObjectsProcessed', 'composeMs', 'disposeMs', 'buildMs',
    'buildMaximumSliceMs', 'totalMs',
  ]),
  'runtime-presentation-handoff': Object.freeze([
    'calls', 'durationMs', 'meshUpdates', 'matrixUpdates', 'bufferUpdates',
    'uploadBytes', 'localTerrainHandoffs', 'distantAdmissions',
    'distantUploadBytes',
  ]),
  'static-natural-ready-admission': Object.freeze([
    'calls', 'admittedOwners', 'admissionLimit', 'readyPageBacklog',
    'readyRequiredOwners', 'missingRequiredOwners', 'requestBacklog',
  ]),
  'local-terrain-build': Object.freeze([
    'calls', 'owners', 'newOwners', 'reusedOwners', 'disposedOwners',
    'buildMs', 'totalMs',
  ]),
});

function usage() {
  console.log([
    'Usage:',
    '  node tools/summarize-kani-performance-capture.mjs <capture.json> [output.summary.json]',
    '',
    'The full capture is left unchanged. A compact JSON containing the frame,',
    'render, Tree, owner, Worker, Terrain, GPU-upload, and draw-path metrics is written.',
  ].join('\n'));
}

function pick(source, keys) {
  if (!source || typeof source !== 'object') return null;
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function stats(source) {
  return pick(source, STAT_KEYS);
}

function maxDuration(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  let maximum = null;
  for (const record of records) {
    const value = Number(record?.durationMs ?? record?.duration ?? record?.totalMs);
    if (Number.isFinite(value)) maximum = maximum === null ? value : Math.max(maximum, value);
  }
  return maximum;
}

function summarizeStatsMap(source, metricKeys) {
  if (!source || typeof source !== 'object') return null;
  const result = {};
  for (const key of metricKeys) {
    const value = stats(source[key]);
    if (value && Object.keys(value).length > 0) result[key] = value;
  }
  return result;
}

function summarizeTreePath(path) {
  if (!path || typeof path !== 'object') return null;
  return {
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
    publicationSources: Array.isArray(path.publicationSources) ? path.publicationSources : [],
  };
}

function summarizeTreeAudit(audit) {
  if (!audit || typeof audit !== 'object') return null;
  return {
    treeStaticStreamActivated: audit.treeStaticStreamActivated ?? null,
    treeStaticStreamSuspended: audit.treeStaticStreamSuspended ?? null,
    activationTimeline: pick(audit.activationTimeline, [
      'bootStartedAtMs',
      'firstShadowPlanGeneratedAtMs',
      'firstDistantTreeVisibleAtMs',
      'firstDistantTreeVisibleInstanceCount',
      'staticStreamActivatedAtMs',
      'firstRequiredOwnerRequestAtMs',
      'firstReadyOwnerAtMs',
      'firstPersistentTreePublishAtMs',
      'firstPersistentTreeDrawAtMs',
      'activationSource',
      'activationRunPhase',
      'activationPaused',
    ]),
    near: summarizeTreePath(audit.near),
    distant: Array.isArray(audit.distant) ? audit.distant.map(summarizeTreePath) : [],
  };
}

function summarizeVisual(visual) {
  if (!visual || typeof visual !== 'object') return null;
  return {
    ...pick(visual, VISUAL_KEYS),
    receiptScanMetrics: pick(visual.receiptScanMetrics, [
      'canonicalCoarseTreeSlotScanCount',
      'canonicalCoarseTreeSlotScanEarlyOutCount',
    ]),
    coarseComponentMetrics: visual.coarseComponentMetrics ?? null,
    currentReceiptCoarseComponentMetrics: visual.currentReceiptCoarseComponentMetrics ?? null,
  };
}

function summarizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const diagnostics = snapshot.diagnostics ?? {};
  const browser = diagnostics.browserFrameAttribution ?? {};
  const stages = diagnostics.stages ?? {};
  const work = diagnostics.work ?? {};
  const player = snapshot.spatial?.playerLogical
    ?? snapshot.presentation?.playerLogical
    ?? snapshot.runtime?.playerLogical
    ?? null;
  return {
    capturedAt: snapshot.capturedAt ?? null,
    player,
    renderInfo: pick(snapshot.renderInfo, RENDER_INFO_KEYS),
    sceneObjectCount: snapshot.sceneObjectCount ?? null,
    frame: stats(diagnostics.frame),
    hitchRatio: diagnostics.hitchRatio ?? null,
    hitchCount: Array.isArray(diagnostics.hitches) ? diagnostics.hitches.length : null,
    hitchMaxMs: maxDuration(diagnostics.hitches),
    longTaskCount: Array.isArray(diagnostics.longTasks) ? diagnostics.longTasks.length : null,
    longTaskMaxMs: maxDuration(diagnostics.longTasks),
    browserFrame: stats(browser.frame),
    browserCallback: stats(browser.callback),
    over33Ratio: browser.over33Ratio ?? null,
    over50Ratio: browser.over50Ratio ?? null,
    over100Ratio: browser.over100Ratio ?? null,
    gpuOrCompositorWait: browser.gpuOrCompositorWait ?? null,
    memorySignals: browser.memorySignals ?? null,
    terrainReadyGate: browser.terrainReadyGate ?? null,
    stageRender: stats(stages.render),
    stageDistantUpdate: stats(stages['distant-update']),
    stageDistantSync: stats(stages['distant-sync']),
    stageGameplayUpdate: stats(stages['gameplay-update']),
    stageChunkTransition: stats(stages['chunk-transition']),
    workPersistentNatural: summarizeStatsMap(
      work['persistent-natural-frame'],
      WORK_METRIC_KEYS['persistent-natural-frame'],
    ),
    workRuntimeHandoff: summarizeStatsMap(
      work['runtime-presentation-handoff'],
      WORK_METRIC_KEYS['runtime-presentation-handoff'],
    ),
    workStaticAdmission: summarizeStatsMap(
      work['static-natural-ready-admission'],
      WORK_METRIC_KEYS['static-natural-ready-admission'],
    ),
    workTerrainBuild: summarizeStatsMap(
      work['local-terrain-build'],
      WORK_METRIC_KEYS['local-terrain-build'],
    ),
    presentation: pick(snapshot.presentation, PRESENTATION_KEYS),
    staticObjectStreaming: pick(snapshot.staticObjectStreaming, STATIC_KEYS),
    ownerGeneration: pick(snapshot.ownerGeneration, OWNER_KEYS),
    visualContinuity: summarizeVisual(snapshot.visualContinuity),
    treePathAudit: summarizeTreeAudit(snapshot.treePathAudit),
  };
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function delta(after, before) {
  const left = finiteNumber(after);
  const right = finiteNumber(before);
  return left === null || right === null ? null : left - right;
}

function coreDeltas(before, after) {
  return {
    frameCount: delta(after?.frame?.count, before?.frame?.count),
    frameP50Ms: delta(after?.frame?.p50, before?.frame?.p50),
    frameP95Ms: delta(after?.frame?.p95, before?.frame?.p95),
    renderP50Ms: delta(after?.stageRender?.p50, before?.stageRender?.p50),
    renderP95Ms: delta(after?.stageRender?.p95, before?.stageRender?.p95),
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
    canonicalFarTreeTriangles: delta(
      after?.presentation?.canonicalFarTreeTriangleCount,
      before?.presentation?.canonicalFarTreeTriangleCount,
    ),
    staticTreeBufferUploadBytes: delta(
      after?.presentation?.staticTreeBufferUploadByteCount,
      before?.presentation?.staticTreeBufferUploadByteCount,
    ),
  };
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}
if (args.length < 1 || args.length > 2) {
  usage();
  process.exitCode = 2;
} else {
  const inputPath = resolve(args[0]);
  const inputName = basename(inputPath);
  const extension = extname(inputName);
  const stem = extension.length > 0 ? inputName.slice(0, -extension.length) : inputName;
  const outputPath = resolve(args[1] ?? `${dirname(inputPath)}/${stem}.summary.json`);

  let capture;
  try {
    capture = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (error) {
    console.error(`Failed to read performance capture: ${error?.message ?? error}`);
    process.exit(1);
  }
  if (!capture || typeof capture !== 'object') {
    console.error('Performance capture root must be a JSON object.');
    process.exit(1);
  }

  const before = summarizeSnapshot(capture.before);
  const after = summarizeSnapshot(capture.after);
  const summary = {
    schemaVersion: 'kani-performance-summary-1',
    source: {
      fileName: inputName,
      captureSchemaVersion: capture.schemaVersion ?? null,
      label: capture.label ?? null,
      startedAt: capture.startedAt ?? null,
      finishedAt: capture.finishedAt ?? null,
      measuredDurationMs: capture.measuredDurationMs ?? null,
      environment: capture.environment ?? null,
    },
    before,
    after,
    deltas: coreDeltas(before, after),
  };

  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(outputPath);
}
