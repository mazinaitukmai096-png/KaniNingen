import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const KANI_PERFORMANCE_CAPTURE_SCHEMA = 'kani-performance-capture-2';
export const KANI_PERFORMANCE_SUMMARY_SCHEMA = 'kani-performance-summary-2';
export const KANI_CONTROLLED_SPRINT_SCENARIOS = Object.freeze([
  'steady-state',
  'max-sprint-straight',
  'max-sprint-diagonal',
  'max-sprint-90-turn',
  'max-sprint-reversal',
  'max-sprint-cold-entry',
  'max-sprint-warm-revisit',
]);
export const KANI_CONTROLLED_CAPTURE_PROTOCOL = Object.freeze({
  controlMode: 'input-driver',
  targetSpeedMetersPerSecond: 30,
  steadyTargetSpeedMetersPerSecond: 0,
  steadyMaximumSpeedMetersPerSecond: 0.05,
  actualSpeedToleranceRatio: 0.01,
  minimumWarmupMs: 10_000,
  minimumSampleMs: 60_000,
  runsPerComparisonRolePerScenario: 5,
});
export const KANI_PERFORMANCE_GATE = Object.freeze({
  frameP95MaximumMs: 33,
  frameP99MaximumMs: 50,
  frameMaximumMs: 100,
  framesOver50MaximumRatio: 0.005,
  framesOver100MaximumRatio: 0,
  chunkTransitionP95MaximumMs: 100,
  relativeNonRegressionMaximumRatio: 1.05,
  frameP50MaximumRegressionMs: 0.5,
  frameP99RequiredImprovementRatio: 0.7,
  framesOver20RequiredImprovementRatio: 0.5,
  framesOver50RequiredImprovementRatio: 0.2,
  onePercentLowRequiredImprovementRatio: 1.25,
});

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
    '  node tools/summarize-kani-performance-capture.mjs --matrix <baseline-dir> <candidate-dir> [output.gate.json]',
    '',
    'The full capture is left unchanged. A compact JSON containing the frame,',
    'render, Tree, owner, Worker, Terrain, GPU-upload, and draw-path metrics is written.',
    'Matrix mode requires the seven controlled scenarios with five baseline and five',
    'candidate capture-v2 files per scenario, and exits nonzero when the gate fails.',
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

function counterDeltas(before, after) {
  return {
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
  };
}

function normalizeEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') return null;
  return endpoint.diagnostics && typeof endpoint.diagnostics === 'object'
    ? summarizeSnapshot(endpoint) : endpoint;
}

function fallbackSample(after) {
  const frame = after?.browserFrame ?? after?.frame ?? null;
  if (!frame) return null;
  return Object.freeze({
    frame,
    onePercentLowFps: Number.isFinite(frame.p99) && frame.p99 > 0 ? 1_000 / frame.p99 : null,
    over20Ratio: null,
    over33Ratio: after?.over33Ratio ?? null,
    over50Ratio: after?.over50Ratio ?? after?.hitchRatio ?? null,
    over100Ratio: after?.over100Ratio ?? null,
    longTasks: Object.freeze({
      supported: null,
      count: after?.longTaskCount ?? null,
      max: after?.longTaskMaxMs ?? null,
      over100Count: null,
    }),
    memory: after?.memorySignals ?? null,
    visibilityChanges: Object.freeze([]),
    source: 'endpoint-trailing-window',
  });
}

function transitionP95(after) {
  return finiteNumber(
    after?.stages?.chunkTransition?.p95
      ?? after?.stageChunkTransition?.p95,
  );
}

function zeroCriterion(value) {
  const number = finiteNumber(value);
  return number === null ? null : number === 0;
}

function maximumCriterion(value, maximum) {
  const number = finiteNumber(value);
  return number === null ? null : number <= maximum;
}

function evaluateCriteria(criteria) {
  const values = Object.values(criteria);
  const failed = values.some(value => value === false);
  const pending = values.some(value => value === null);
  return Object.freeze({
    status: failed ? 'fail' : pending ? 'pending' : 'pass',
    pass: !failed && !pending,
  });
}

export function evaluateKaniPerformanceCapture({
  source,
  sample,
  after,
  observedCounterDeltas,
  exactFrameSample,
  validation,
} = {}) {
  const hiddenDuringSample = Array.isArray(sample?.visibilityChanges)
    ? sample.visibilityChanges.some(change => change?.visibilityState === 'hidden') : null;
  const coverage = after?.terrainCoverageDiagnostics ?? {};
  const criteria = Object.freeze({
    exactFrameSample: exactFrameSample === true ? true : null,
    captureStateValid: exactFrameSample === true
      ? validation?.applicable === true && validation?.valid === true : null,
    frameSamplesPresent: Number.isFinite(sample?.frame?.count)
      ? sample.frame.count > 0 : null,
    frameP95: maximumCriterion(sample?.frame?.p95, KANI_PERFORMANCE_GATE.frameP95MaximumMs),
    frameP99: maximumCriterion(sample?.frame?.p99, KANI_PERFORMANCE_GATE.frameP99MaximumMs),
    frameMaximum: maximumCriterion(sample?.frame?.max, KANI_PERFORMANCE_GATE.frameMaximumMs),
    framesOver50: maximumCriterion(
      sample?.over50Ratio,
      KANI_PERFORMANCE_GATE.framesOver50MaximumRatio,
    ),
    framesOver100: maximumCriterion(
      sample?.over100Ratio,
      KANI_PERFORMANCE_GATE.framesOver100MaximumRatio,
    ),
    chunkTransitionP95: maximumCriterion(
      transitionP95(after),
      KANI_PERFORMANCE_GATE.chunkTransitionP95MaximumMs,
    ),
    runtimeLoopAlive: after?.boot?.loopStarted === true && after?.boot?.status !== 'failed'
      ? true : after?.boot ? false : null,
    runtimeFrameFailures: zeroCriterion(observedCounterDeltas?.runtimeFrameFailureCount),
    longTasksOver100: zeroCriterion(sample?.longTasks?.over100Count),
    movementBlockedByTerrain: zeroCriterion(coverage.movementBlockedByTerrain),
    visualBlankFrames: zeroCriterion(coverage.visualBlankFrame),
    visualWorldCoverageMisses: zeroCriterion(coverage.visualWorldCoverageMiss),
    collisionCoverageMisses: zeroCriterion(coverage.collisionCoverageMiss),
    visibleDocument: hiddenDuringSample === null ? null : !hiddenDuringSample,
  });
  const outcome = evaluateCriteria(criteria);
  return Object.freeze({
    schemaVersion: 'kani-performance-single-run-gate-1',
    ...outcome,
    criteria,
    limits: KANI_PERFORMANCE_GATE,
    scenario: source?.scenario ?? null,
    runNumber: source?.runNumber ?? null,
    relativeGate: 'pending-five-run-comparison',
  });
}

export function summarizeKaniPerformanceCapture(capture, { fileName = null } = {}) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
    throw new TypeError('Performance capture root must be a JSON object');
  }
  const before = normalizeEndpoint(capture.before);
  const after = normalizeEndpoint(capture.after);
  const observedCounterDeltas = capture.counterDeltas ?? counterDeltas(before, after);
  const exactFrameSample = capture.schemaVersion === KANI_PERFORMANCE_CAPTURE_SCHEMA;
  const sample = capture.sample ?? fallbackSample(after);
  const source = Object.freeze({
    fileName,
    captureSchemaVersion: capture.schemaVersion ?? null,
    ...(capture.source && typeof capture.source === 'object' ? capture.source : {
      label: capture.label ?? null,
      startedAt: capture.startedAt ?? null,
      finishedAt: capture.finishedAt ?? null,
      measuredDurationMs: capture.measuredDurationMs ?? null,
      environment: capture.environment ?? null,
    }),
  });
  const acceptance = evaluateKaniPerformanceCapture({
    source,
    sample,
    after,
    observedCounterDeltas,
    exactFrameSample,
    validation: capture.validation ?? null,
  });
  return Object.freeze({
    schemaVersion: KANI_PERFORMANCE_SUMMARY_SCHEMA,
    source,
    protocol: Object.freeze({
      exactFrameSample,
      endpointPercentileSubtractionUsed: false,
      browserFrameGate: exactFrameSample ? acceptance.status : 'pending',
      actualStateValidated: exactFrameSample
        ? capture.validation?.valid === true : null,
    }),
    sample,
    before,
    after,
    counterDeltas: observedCounterDeltas,
    validation: capture.validation ?? null,
    acceptance,
  });
}

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function environmentIdentity(summary) {
  const source = summary?.source ?? {};
  return JSON.stringify({
    userAgent: source.userAgent ?? null,
    hardwareConcurrency: source.hardwareConcurrency ?? null,
    deviceMemoryGiB: source.deviceMemoryGiB ?? null,
    devicePixelRatio: source.devicePixelRatio ?? null,
    viewportWidth: source.viewportWidth ?? null,
    viewportHeight: source.viewportHeight ?? null,
    rendererIdentity: source.rendererIdentity ?? null,
    rendererHardwareAccelerated: source.rendererHardwareAccelerated ?? null,
  });
}

function workloadIdentity(summary) {
  const source = summary?.source ?? {};
  const before = summary?.before ?? {};
  return JSON.stringify({
    seed: source.worldSeed ?? source.seed ?? null,
    worldSeedHash: source.worldSeedHash ?? null,
    checkpoint: source.checkpoint ?? null,
    routeRevision: source.routeRevision ?? null,
    warmupMs: source.warmupMs ?? null,
    requestedDurationMs: source.requestedDurationMs ?? null,
    startX: before.player?.x ?? null,
    startZ: before.player?.z ?? null,
    cameraYaw: before.experience?.cameraYaw ?? null,
    renderDistance: before.experience?.renderDistance ?? null,
    quality: before.experience?.quality ?? source.quality ?? null,
    startOwnerKey: source.startOwnerKey ?? null,
    requiredVisitedOwnerKeys: source.requiredVisitedOwnerKeys ?? null,
    revisitOwnerKey: source.revisitOwnerKey ?? null,
    scaleStageId: before.scaleStageId ?? null,
  });
}

function controlledInputProof(summary) {
  const source = summary?.source ?? {};
  const control = summary?.sample?.control ?? {};
  const transitions = Array.isArray(control.inputTransitions)
    ? control.inputTransitions : [];
  const transitionPresent = (type, code) => transitions.some(event => (
    event?.type === type && event?.code === code
  ));
  const steady = source.scenario === 'steady-state';
  const target = steady
    ? KANI_CONTROLLED_CAPTURE_PROTOCOL.steadyTargetSpeedMetersPerSecond
    : KANI_CONTROLLED_CAPTURE_PROTOCOL.targetSpeedMetersPerSecond;
  const tolerance = steady
    ? KANI_CONTROLLED_CAPTURE_PROTOCOL.steadyMaximumSpeedMetersPerSecond
    : target * KANI_CONTROLLED_CAPTURE_PROTOCOL.actualSpeedToleranceRatio;
  const commandDuration = finiteNumber(control.commandDurationMs);
  const actualSpeed = finiteNumber(control.actualAverageSpeedMetersPerSecond);
  const requestedDuration = finiteNumber(source.requestedDurationMs);
  const beforeOwner = summary?.before?.runtimeCenter;
  const afterOwner = summary?.after?.runtimeCenter;
  const coldAreaWitness = source.scenario !== 'max-sprint-cold-entry' || (
    ['55,77', '58,71'].every(ownerKey => (
      source.requiredVisitedOwnerKeys?.includes?.(ownerKey)
        && source.visitedOwnerKeys?.includes?.(ownerKey)
    ))
      && Number.isSafeInteger(beforeOwner?.centerChunkX)
      && Number.isSafeInteger(beforeOwner?.centerChunkZ)
      && Number.isSafeInteger(afterOwner?.centerChunkX)
      && Number.isSafeInteger(afterOwner?.centerChunkZ)
      && (beforeOwner.centerChunkX !== afterOwner.centerChunkX
        || beforeOwner.centerChunkZ !== afterOwner.centerChunkZ)
  );
  const warmRevisitWitness = source.scenario !== 'max-sprint-warm-revisit' || (
    typeof source.revisitOwnerKey === 'string'
      && Array.isArray(source.visitedOwnerSequence)
      && source.visitedOwnerSequence.filter(key => key === source.revisitOwnerKey).length >= 2
  );
  const steadyWitness = !steady || (
    transitions.length === 0
      && Array.isArray(source.visitedOwnerSequence)
      && source.visitedOwnerSequence.length === 1
      && source.visitedOwnerSequence[0] === source.startOwnerKey
      && beforeOwner?.centerChunkX === afterOwner?.centerChunkX
      && beforeOwner?.centerChunkZ === afterOwner?.centerChunkZ
  );
  return source.controlMode === KANI_CONTROLLED_CAPTURE_PROTOCOL.controlMode
    && source.targetSpeedMetersPerSecond === target
    && (typeof source.seed === 'string' || Number.isSafeInteger(source.seed))
    && typeof source.checkpoint === 'string' && source.checkpoint.length > 0
    && typeof source.routeRevision === 'string' && source.routeRevision.length > 0
    && source.warmupMs >= KANI_CONTROLLED_CAPTURE_PROTOCOL.minimumWarmupMs
    && requestedDuration >= KANI_CONTROLLED_CAPTURE_PROTOCOL.minimumSampleMs
    && commandDuration !== null
    && commandDuration >= requestedDuration * 0.99
    && actualSpeed !== null
    && Math.abs(actualSpeed - target) <= tolerance
    && control.scenario === source.scenario
    && control.targetSpeedMetersPerSecond === target
    && control.frameCount > 0
    && finiteNumber(control.actualPathDistanceMeters) !== null
    && (steady || (
      transitionPresent('keydown', 'ShiftLeft')
        && transitionPresent('keydown', 'KeyW')
        && transitionPresent('keyup', 'ShiftLeft')
    ))
    && (source.scenario !== 'max-sprint-diagonal'
      || (transitionPresent('keydown', 'KeyD') && transitionPresent('keyup', 'KeyD')))
    && (source.scenario !== 'max-sprint-90-turn'
      || (transitionPresent('keyup', 'KeyW') && transitionPresent('keydown', 'KeyD')
        && transitionPresent('keyup', 'KeyD')))
    && (!['max-sprint-reversal', 'max-sprint-warm-revisit'].includes(source.scenario)
      || (transitionPresent('keyup', 'KeyW') && transitionPresent('keydown', 'KeyS')
        && transitionPresent('keyup', 'KeyS')))
    && summary?.before?.scaleStageId === 'MAX'
    && summary?.after?.scaleStageId === 'MAX'
    && summary?.before?.experience?.runPhase === 'playing'
    && summary?.before?.experience?.paused === false
    && summary?.after?.experience?.runPhase === 'playing'
    && summary?.after?.experience?.paused === false
    && summary?.validation?.applicable === true
    && summary?.validation?.valid === true
    && source.rendererHardwareAccelerated === true
    && coldAreaWitness
    && warmRevisitWitness
    && steadyWitness;
}

export function evaluateKaniPerformanceRunSet({ baselineSummaries, candidateSummaries } = {}) {
  if (!Array.isArray(baselineSummaries) || !Array.isArray(candidateSummaries)
    || baselineSummaries.length !== 5 || candidateSummaries.length !== 5) {
    throw new TypeError('exactly five baseline and five candidate summaries are required');
  }
  const all = [...baselineSummaries, ...candidateSummaries];
  const identities = new Set(all.map(environmentIdentity));
  const workloads = new Set(all.map(workloadIdentity));
  const scenarios = new Set(all.map(summary => summary?.source?.scenario ?? null));
  const expectedRunNumbers = '1,2,3,4,5';
  const runNumbers = summaries => [...summaries]
    .map(summary => summary?.source?.runNumber)
    .sort((left, right) => left - right)
    .join(',');
  const metric = (summaries, selector) => median(summaries.map(selector));
  const baseline = Object.freeze({
    frameP50Ms: metric(baselineSummaries, summary => summary?.sample?.frame?.p50),
    frameP95Ms: metric(baselineSummaries, summary => summary?.sample?.frame?.p95),
    frameP99Ms: metric(baselineSummaries, summary => summary?.sample?.frame?.p99),
    frameMaximumMs: metric(baselineSummaries, summary => summary?.sample?.frame?.max),
    framesOver20Ratio: metric(baselineSummaries, summary => summary?.sample?.over20Ratio),
    framesOver50Ratio: metric(baselineSummaries, summary => summary?.sample?.over50Ratio),
    framesOver100Ratio: metric(
      baselineSummaries,
      summary => summary?.sample?.over100Ratio,
    ),
    chunkTransitionP95Ms: metric(
      baselineSummaries,
      summary => transitionP95(summary?.after),
    ),
    onePercentLowFps: metric(
      baselineSummaries,
      summary => summary?.sample?.onePercentLowFps,
    ),
  });
  const candidate = Object.freeze({
    frameP50Ms: metric(candidateSummaries, summary => summary?.sample?.frame?.p50),
    frameP95Ms: metric(candidateSummaries, summary => summary?.sample?.frame?.p95),
    frameP99Ms: metric(candidateSummaries, summary => summary?.sample?.frame?.p99),
    frameMaximumMs: metric(candidateSummaries, summary => summary?.sample?.frame?.max),
    framesOver20Ratio: metric(candidateSummaries, summary => summary?.sample?.over20Ratio),
    framesOver50Ratio: metric(candidateSummaries, summary => summary?.sample?.over50Ratio),
    framesOver100Ratio: metric(
      candidateSummaries,
      summary => summary?.sample?.over100Ratio,
    ),
    chunkTransitionP95Ms: metric(
      candidateSummaries,
      summary => transitionP95(summary?.after),
    ),
    onePercentLowFps: metric(
      candidateSummaries,
      summary => summary?.sample?.onePercentLowFps,
    ),
  });
  const lowerNonRegression = (candidateValue, baselineValue) => {
    if (!Number.isFinite(candidateValue) || !Number.isFinite(baselineValue)) return null;
    if (baselineValue === 0) return candidateValue === 0;
    return candidateValue
      <= baselineValue * KANI_PERFORMANCE_GATE.relativeNonRegressionMaximumRatio;
  };
  const higherNonRegression = (candidateValue, baselineValue) => {
    if (!Number.isFinite(candidateValue) || !Number.isFinite(baselineValue)) return null;
    if (baselineValue === 0) return candidateValue >= 0;
    return candidateValue >= baselineValue
      / KANI_PERFORMANCE_GATE.relativeNonRegressionMaximumRatio;
  };
  const lowerImprovement = (candidateValue, baselineValue, maximumRatio) => {
    if (!Number.isFinite(candidateValue) || !Number.isFinite(baselineValue)) return null;
    if (baselineValue === 0) return candidateValue === 0;
    return candidateValue <= baselineValue * maximumRatio;
  };
  const higherImprovement = (candidateValue, baselineValue, minimumRatio) => {
    if (!Number.isFinite(candidateValue) || !Number.isFinite(baselineValue)) return null;
    if (baselineValue === 0) return candidateValue >= 0;
    return candidateValue >= baselineValue * minimumRatio;
  };
  const p50NonRegression = Number.isFinite(candidate.frameP50Ms)
    && Number.isFinite(baseline.frameP50Ms)
    ? candidate.frameP50Ms <= Math.max(
      baseline.frameP50Ms * KANI_PERFORMANCE_GATE.relativeNonRegressionMaximumRatio,
      baseline.frameP50Ms + KANI_PERFORMANCE_GATE.frameP50MaximumRegressionMs,
    ) : null;
  const baselineFloorReached = [
    maximumCriterion(baseline.frameP95Ms, KANI_PERFORMANCE_GATE.frameP95MaximumMs),
    maximumCriterion(baseline.frameP99Ms, KANI_PERFORMANCE_GATE.frameP99MaximumMs),
    maximumCriterion(baseline.frameMaximumMs, KANI_PERFORMANCE_GATE.frameMaximumMs),
    maximumCriterion(
      baseline.framesOver50Ratio,
      KANI_PERFORMANCE_GATE.framesOver50MaximumRatio,
    ),
    maximumCriterion(
      baseline.framesOver100Ratio,
      KANI_PERFORMANCE_GATE.framesOver100MaximumRatio,
    ),
  ].every(value => value === true);
  const conditionalLower = (candidateValue, baselineValue, improvementRatio) => (
    baselineFloorReached
      ? lowerNonRegression(candidateValue, baselineValue)
      : lowerImprovement(candidateValue, baselineValue, improvementRatio)
  );
  const conditionalHigher = (candidateValue, baselineValue, improvementRatio) => (
    baselineFloorReached
      ? higherNonRegression(candidateValue, baselineValue)
      : higherImprovement(candidateValue, baselineValue, improvementRatio)
  );
  const criteria = Object.freeze({
    fiveRunsComplete: true,
    runNumbersComplete: runNumbers(baselineSummaries) === expectedRunNumbers
      && runNumbers(candidateSummaries) === expectedRunNumbers,
    comparisonRolesCorrect: baselineSummaries.every(summary => (
      summary?.source?.comparisonRole === 'baseline'
    )) && candidateSummaries.every(summary => (
      summary?.source?.comparisonRole === 'candidate'
    )),
    matchingControlledScenario: scenarios.size === 1
      && KANI_CONTROLLED_SPRINT_SCENARIOS.includes([...scenarios][0]),
    controlledFormalWorkload: all.every(controlledInputProof),
    matchingEnvironment: identities.size === 1,
    matchingWorkload: workloads.size === 1,
    everyRunExact: all.every(summary => summary?.protocol?.exactFrameSample === true),
    noImmediateRunFailure: candidateSummaries.every(summary => {
      const immediateCriteria = summary?.acceptance?.criteria;
      return summary?.acceptance?.pass === true
        && immediateCriteria && typeof immediateCriteria === 'object'
        && Object.keys(immediateCriteria).length > 0
        && Object.values(immediateCriteria).every(value => value === true);
    }),
    frameP50Relative: p50NonRegression,
    frameP95Absolute: maximumCriterion(
      candidate.frameP95Ms,
      KANI_PERFORMANCE_GATE.frameP95MaximumMs,
    ),
    frameP95Relative: baselineFloorReached
      ? lowerNonRegression(candidate.frameP95Ms, baseline.frameP95Ms) : true,
    frameP99Absolute: maximumCriterion(
      candidate.frameP99Ms,
      KANI_PERFORMANCE_GATE.frameP99MaximumMs,
    ),
    frameP99Relative: conditionalLower(
      candidate.frameP99Ms,
      baseline.frameP99Ms,
      KANI_PERFORMANCE_GATE.frameP99RequiredImprovementRatio,
    ),
    frameMaximumAbsolute: maximumCriterion(
      candidate.frameMaximumMs,
      KANI_PERFORMANCE_GATE.frameMaximumMs,
    ),
    frameMaximumRelative: baselineFloorReached
      ? lowerNonRegression(candidate.frameMaximumMs, baseline.frameMaximumMs) : true,
    framesOver20Relative: conditionalLower(
      candidate.framesOver20Ratio,
      baseline.framesOver20Ratio,
      KANI_PERFORMANCE_GATE.framesOver20RequiredImprovementRatio,
    ),
    framesOver50Absolute: maximumCriterion(
      candidate.framesOver50Ratio,
      KANI_PERFORMANCE_GATE.framesOver50MaximumRatio,
    ),
    framesOver50Relative: conditionalLower(
      candidate.framesOver50Ratio,
      baseline.framesOver50Ratio,
      KANI_PERFORMANCE_GATE.framesOver50RequiredImprovementRatio,
    ),
    framesOver100Absolute: maximumCriterion(
      candidate.framesOver100Ratio,
      KANI_PERFORMANCE_GATE.framesOver100MaximumRatio,
    ),
    framesOver100Relative: baselineFloorReached
      ? lowerNonRegression(candidate.framesOver100Ratio, baseline.framesOver100Ratio) : true,
    chunkTransitionP95Absolute: maximumCriterion(
      candidate.chunkTransitionP95Ms,
      KANI_PERFORMANCE_GATE.chunkTransitionP95MaximumMs,
    ),
    chunkTransitionP95Relative: baselineFloorReached
      ? lowerNonRegression(candidate.chunkTransitionP95Ms, baseline.chunkTransitionP95Ms) : true,
    onePercentLowRelative: conditionalHigher(
      candidate.onePercentLowFps,
      baseline.onePercentLowFps,
      KANI_PERFORMANCE_GATE.onePercentLowRequiredImprovementRatio,
    ),
  });
  const outcome = evaluateCriteria(criteria);
  return Object.freeze({
    schemaVersion: 'kani-performance-five-run-gate-1',
    ...outcome,
    criteria,
    limits: KANI_PERFORMANCE_GATE,
    baselineFloorReached,
    medians: Object.freeze({ baseline, candidate }),
  });
}

export function evaluateKaniControlledScenarioMatrix({
  baselineSummaries,
  candidateSummaries,
} = {}) {
  if (!Array.isArray(baselineSummaries) || !Array.isArray(candidateSummaries)) {
    throw new TypeError('baselineSummaries and candidateSummaries must be arrays');
  }
  const recognized = new Set(KANI_CONTROLLED_SPRINT_SCENARIOS);
  const unknownScenarios = [...baselineSummaries, ...candidateSummaries]
    .map(summary => summary?.source?.scenario ?? null)
    .filter(scenario => !recognized.has(scenario));
  const scenarioGates = {};
  let requiredScenariosComplete = true;
  for (const scenario of KANI_CONTROLLED_SPRINT_SCENARIOS) {
    const baseline = baselineSummaries.filter(summary => summary?.source?.scenario === scenario);
    const candidate = candidateSummaries.filter(summary => summary?.source?.scenario === scenario);
    if (baseline.length !== 5 || candidate.length !== 5) {
      requiredScenariosComplete = false;
      scenarioGates[scenario] = Object.freeze({
        schemaVersion: 'kani-performance-five-run-gate-1',
        status: 'fail',
        pass: false,
        reason: 'exactly-five-baseline-and-candidate-runs-required',
        baselineRunCount: baseline.length,
        candidateRunCount: candidate.length,
      });
      continue;
    }
    scenarioGates[scenario] = evaluateKaniPerformanceRunSet({
      baselineSummaries: baseline,
      candidateSummaries: candidate,
    });
  }
  const criteria = Object.freeze({
    allRequiredScenariosPresent: requiredScenariosComplete,
    noUnknownScenarios: unknownScenarios.length === 0,
    exactlySeventyCaptures: baselineSummaries.length === 35
      && candidateSummaries.length === 35,
    everyScenarioPasses: Object.values(scenarioGates).every(gate => gate.pass === true),
  });
  const outcome = evaluateCriteria(criteria);
  return Object.freeze({
    schemaVersion: 'kani-performance-controlled-scenario-matrix-gate-1',
    ...outcome,
    criteria,
    requiredScenarios: KANI_CONTROLLED_SPRINT_SCENARIOS,
    runsPerComparisonRolePerScenario: 5,
    limits: KANI_PERFORMANCE_GATE,
    unknownScenarios: Object.freeze(unknownScenarios),
    scenarioGates: Object.freeze(scenarioGates),
  });
}

function readCaptureDirectory(directoryPath) {
  const directory = resolve(directoryPath);
  const files = readdirSync(directory)
    .filter(name => /^kani-performance-capture-.*\.json$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  const summaries = files.map(name => {
    const path = resolve(directory, name);
    const capture = JSON.parse(readFileSync(path, 'utf8'));
    if (capture?.schemaVersion !== KANI_PERFORMANCE_CAPTURE_SCHEMA) {
      throw new TypeError(`${path} is not a ${KANI_PERFORMANCE_CAPTURE_SCHEMA} capture`);
    }
    return summarizeKaniPerformanceCapture(capture, { fileName: name });
  });
  return Object.freeze({
    directory,
    files: Object.freeze(files),
    summaries: Object.freeze(summaries),
  });
}

function runMatrixCli(args) {
  if (args.length < 3 || args.length > 4) {
    usage();
    return 2;
  }
  let baseline;
  let candidate;
  try {
    baseline = readCaptureDirectory(args[1]);
    candidate = readCaptureDirectory(args[2]);
  } catch (error) {
    console.error(`Failed to read performance matrix: ${error?.message ?? error}`);
    return 2;
  }
  const gate = evaluateKaniControlledScenarioMatrix({
    baselineSummaries: baseline.summaries,
    candidateSummaries: candidate.summaries,
  });
  const result = Object.freeze({
    schemaVersion: 'kani-performance-controlled-scenario-matrix-result-1',
    generatedAt: new Date().toISOString(),
    baseline: Object.freeze({ directory: baseline.directory, files: baseline.files }),
    candidate: Object.freeze({ directory: candidate.directory, files: candidate.files }),
    gate,
  });
  const outputPath = resolve(args[3] ?? 'kani-performance-matrix-gate.json');
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(outputPath);
  console.log(JSON.stringify({ status: gate.status, pass: gate.pass }));
  return gate.pass ? 0 : 1;
}

function runCli(args) {
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return 0;
  }
  if (args[0] === '--matrix') return runMatrixCli(args);
  if (args.length < 1 || args.length > 2) {
    usage();
    return 2;
  }
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
    return 1;
  }
  let summary;
  try {
    summary = summarizeKaniPerformanceCapture(capture, { fileName: inputName });
  } catch (error) {
    console.error(`Failed to summarize performance capture: ${error?.message ?? error}`);
    return 1;
  }
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(outputPath);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2));
}
