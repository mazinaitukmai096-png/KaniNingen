(async () => {
  const requestedDurationMs = Number(globalThis.__KANI_ROAD_CAPTURE_DURATION_MS);
  const durationMs = Number.isFinite(requestedDurationMs) && requestedDurationMs >= 1_000
    ? requestedDurationMs
    : 45_000;
  const requestedSampleIntervalMs = Number(globalThis.__KANI_ROAD_CAPTURE_SAMPLE_INTERVAL_MS);
  const sampleIntervalMs = Number.isFinite(requestedSampleIntervalMs)
    && requestedSampleIntervalMs >= 100
    ? requestedSampleIntervalMs
    : 500;
  const sandbox = globalThis.__infiniteWorldSandbox;
  if (!sandbox || typeof sandbox.roadLifecycleDiagnosticSnapshot !== 'function') {
    throw new Error('KaniNingen Road lifecycle diagnostic is not available. Open the diagnostic URL first.');
  }

  const readDiagnostic = ({ includeHistory = false } = {}) => (
    sandbox.roadLifecycleDiagnosticSnapshot({ includeRecords: true, includeHistory })
  );
  const before = readDiagnostic({ includeHistory: true });
  if (before?.enabled !== true) {
    throw new Error('roadLifecycleDiagnostic=1 is required in the page URL.');
  }

  const finite = value => Number.isFinite(value) ? value : null;
  const uniqueSorted = values => [...new Set(values)].sort((left, right) => (
    String(left).localeCompare(String(right))
  ));
  const difference = (left, right) => {
    const rightSet = new Set(right ?? []);
    return uniqueSorted((left ?? []).filter(value => !rightSet.has(value)));
  };
  const summarizeLifecycle = lifecycle => lifecycle ? {
    syncEpoch: lifecycle.syncEpoch ?? null,
    transitionGeneration: lifecycle.transitionGeneration ?? null,
    status: lifecycle.status ?? null,
    startedAtMs: finite(lifecycle.startedAtMs),
    queryPlannedAtMs: finite(lifecycle.queryPlannedAtMs),
    queryReadyAtMs: finite(lifecycle.queryReadyAtMs),
    registeredAtMs: finite(lifecycle.registeredAtMs),
    publicationQueuedAtMs: finite(lifecycle.publicationQueuedAtMs),
    publishedAtMs: finite(lifecycle.publishedAtMs),
    firstDrawAtMs: finite(lifecycle.firstDrawAtMs),
    cancelledAtMs: finite(lifecycle.cancelledAtMs),
    playerX: finite(lifecycle.playerX),
    playerZ: finite(lifecycle.playerZ),
    roadVisibilityMeters: finite(lifecycle.roadVisibilityMeters),
    roadQueryRadius: finite(lifecycle.roadQueryRadius),
    plannedRoadOwnerKeys: lifecycle.plannedRoadOwnerKeys ?? [],
    completedRoadOwnerKeys: lifecycle.completedRoadOwnerKeys ?? [],
    registeredRoadOwnerKeys: lifecycle.registeredRoadOwnerKeys ?? [],
    publishedRoadOwnerKeys: lifecycle.publishedRoadOwnerKeys ?? [],
    firstDrawRoadOwnerKeys: lifecycle.firstDrawRoadOwnerKeys ?? [],
    roadOwnerLoadEvents: lifecycle.roadOwnerLoadEvents ?? [],
    cacheHitCount: lifecycle.cacheHitCount ?? 0,
    cacheMissCount: lifecycle.cacheMissCount ?? 0,
    loadedRoadRecordCount: lifecycle.loadedRoadRecordCount ?? 0,
    registeredRoadRecordCount: lifecycle.registeredRoadRecordCount ?? 0,
    publishedRoadRecordCount: lifecycle.publishedRoadRecordCount ?? 0,
    firstDrawRoadRecordCount: lifecycle.firstDrawRoadRecordCount ?? 0,
    cancellationReason: lifecycle.cancellationReason ?? null,
  } : null;
  const analyzeLifecycle = lifecycle => ({
    syncEpoch: lifecycle.syncEpoch,
    status: lifecycle.status,
    plannedNotCompletedOwnerKeys: difference(
      lifecycle.plannedRoadOwnerKeys,
      lifecycle.completedRoadOwnerKeys,
    ),
    completedNotRegisteredOwnerKeys: difference(
      lifecycle.completedRoadOwnerKeys,
      lifecycle.registeredRoadOwnerKeys,
    ),
    registeredNotPublishedOwnerKeys: difference(
      lifecycle.registeredRoadOwnerKeys,
      lifecycle.publishedRoadOwnerKeys,
    ),
    publishedNotFirstDrawOwnerKeys: lifecycle.firstDrawAtMs === null
      ? [...(lifecycle.publishedRoadOwnerKeys ?? [])] : [],
    durationsMs: {
      requestToQueryReady: lifecycle.queryReadyAtMs !== null
        ? lifecycle.queryReadyAtMs - lifecycle.startedAtMs : null,
      queryReadyToRegistered: lifecycle.registeredAtMs !== null
        && lifecycle.queryReadyAtMs !== null
        ? lifecycle.registeredAtMs - lifecycle.queryReadyAtMs : null,
      registeredToPublished: lifecycle.publishedAtMs !== null
        && lifecycle.registeredAtMs !== null
        ? lifecycle.publishedAtMs - lifecycle.registeredAtMs : null,
      publishedToFirstDraw: lifecycle.firstDrawAtMs !== null
        && lifecycle.publishedAtMs !== null
        ? lifecycle.firstDrawAtMs - lifecycle.publishedAtMs : null,
    },
  });

  const startedAt = new Date().toISOString();
  const startedAtPerformanceMs = performance.now();
  const baselineStatusByEpoch = new Map(
    (before.history ?? []).map(lifecycle => [lifecycle.syncEpoch, lifecycle.status]),
  );
  const stateByStableId = new Map();
  const transitions = [];
  const samples = [];

  const captureSample = () => {
    const diagnostic = readDiagnostic();
    const elapsedMs = performance.now() - startedAtPerformanceMs;
    samples.push({
      elapsedMs,
      player: diagnostic.player ?? null,
      latestSyncEpoch: diagnostic.latest?.syncEpoch ?? null,
      latestStatus: diagnostic.latest?.status ?? null,
      plannedRoadOwnerCount: diagnostic.latest?.plannedRoadOwnerKeys?.length ?? null,
      completedRoadOwnerCount: diagnostic.latest?.completedRoadOwnerKeys?.length ?? null,
      registeredRoadOwnerCount: diagnostic.latest?.registeredRoadOwnerKeys?.length ?? null,
      publishedRoadOwnerCount: diagnostic.latest?.publishedRoadOwnerKeys?.length ?? null,
      loadedRoadRecordCount: diagnostic.latest?.loadedRoadRecordCount ?? null,
      registeredRoadRecordCount: diagnostic.registeredRoadRecordCount ?? null,
      drawableRoadRecordCount: diagnostic.drawableRoadRecordCount ?? null,
      midpointCullGapCandidateCount: diagnostic.midpointCullGapCandidateCount ?? null,
      hiddenWithinSegmentRangeCount: diagnostic.hiddenWithinSegmentRangeCount ?? null,
    });
    for (const record of diagnostic.records ?? []) {
      const next = {
        ownerKey: record.ownerKey ?? null,
        visibleLod: record.visibleLod ?? null,
        drawable: record.drawable === true,
        midpointCullGapCandidate: record.midpointCullGapCandidate === true,
        midpointDistanceMeters: finite(record.midpointDistanceMeters),
        segmentDistanceMeters: finite(record.segmentDistanceMeters),
      };
      const previous = stateByStableId.get(record.stableId);
      if (!previous) {
        stateByStableId.set(record.stableId, next);
        continue;
      }
      if (previous.visibleLod !== next.visibleLod
        || previous.drawable !== next.drawable
        || previous.midpointCullGapCandidate !== next.midpointCullGapCandidate) {
        transitions.push({
          elapsedMs,
          stableId: record.stableId,
          ownerKey: record.ownerKey ?? null,
          from: previous,
          to: next,
        });
        stateByStableId.set(record.stableId, next);
      }
    }
    return diagnostic;
  };

  console.info(
    `KaniNingen Road lifecycle capture started (${durationMs / 1_000} seconds). `
      + 'Move toward a visibly broken magenta Road while the capture is running.',
  );
  let after = captureSample();
  while (performance.now() - startedAtPerformanceMs < durationMs) {
    const remainingMs = durationMs - (performance.now() - startedAtPerformanceMs);
    await new Promise(resolve => setTimeout(resolve, Math.min(sampleIntervalMs, remainingMs)));
    after = captureSample();
  }
  after = readDiagnostic({ includeHistory: true });

  const relevantHistory = (after.history ?? []).filter(lifecycle => (
    lifecycle.startedAtMs >= startedAtPerformanceMs - 1
      || baselineStatusByEpoch.get(lifecycle.syncEpoch) !== lifecycle.status
  )).map(summarizeLifecycle);
  const lifecycleAnalysis = relevantHistory.map(analyzeLifecycle);
  const finalGapCandidates = (after.records ?? [])
    .filter(record => record.midpointCullGapCandidate)
    .sort((left, right) => left.segmentDistanceMeters - right.segmentDistanceMeters)
    .slice(0, 128);
  const finalHiddenWithinRange = (after.records ?? [])
    .filter(record => record.segmentDistanceMeters <= after.roadVisibilityMeters
      && record.visibleLod === 'hidden')
    .sort((left, right) => left.segmentDistanceMeters - right.segmentDistanceMeters)
    .slice(0, 128);
  const aggregate = {
    syncCount: relevantHistory.length,
    cancelledSyncCount: relevantHistory.filter(value => value.status === 'cancelled').length,
    plannedNotCompletedOwnerCount: uniqueSorted(lifecycleAnalysis.flatMap(
      value => value.plannedNotCompletedOwnerKeys,
    )).length,
    completedNotRegisteredOwnerCount: uniqueSorted(lifecycleAnalysis.flatMap(
      value => value.completedNotRegisteredOwnerKeys,
    )).length,
    registeredNotPublishedOwnerCount: uniqueSorted(lifecycleAnalysis.flatMap(
      value => value.registeredNotPublishedOwnerKeys,
    )).length,
    publishedWithoutFirstDrawSyncCount: lifecycleAnalysis.filter(
      value => value.publishedNotFirstDrawOwnerKeys.length > 0,
    ).length,
    midpointCullGapCandidateCountAtEnd: after.midpointCullGapCandidateCount ?? 0,
    hiddenWithinSegmentRangeCountAtEnd: after.hiddenWithinSegmentRangeCount ?? 0,
    visibilityTransitionsObserved: transitions.length,
    hiddenToVisibleTransitionsObserved: transitions.filter(value => (
      value.from.visibleLod === 'hidden' && value.to.visibleLod !== 'hidden'
    )).length,
  };
  const inferredPrimaryCause = aggregate.midpointCullGapCandidateCountAtEnd > 0
    || transitions.some(value => value.from.midpointCullGapCandidate
      && value.from.visibleLod === 'hidden' && value.to.visibleLod !== 'hidden')
    ? 'road-midpoint-distance-culling'
    : aggregate.plannedNotCompletedOwnerCount > 0
      ? 'road-owner-request-or-generation-delay'
      : aggregate.completedNotRegisteredOwnerCount > 0
        ? 'road-registration-delay'
        : aggregate.registeredNotPublishedOwnerCount > 0
          ? 'road-publication-delay'
          : aggregate.publishedWithoutFirstDrawSyncCount > 0
            ? 'road-first-draw-delay'
            : 'not-determined';

  const finishedAt = new Date().toISOString();
  const result = {
    schemaVersion: 'kani-road-lifecycle-capture-1',
    source: {
      startedAt,
      finishedAt,
      measuredDurationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      sampleIntervalMs,
      pageUrl: globalThis.location?.href ?? null,
      userAgent: globalThis.navigator?.userAgent ?? null,
      viewportWidth: globalThis.innerWidth ?? null,
      viewportHeight: globalThis.innerHeight ?? null,
    },
    conclusion: {
      inferredPrimaryCause,
      inferenceOnly: true,
      aggregate,
    },
    before: {
      player: before.player ?? null,
      roadVisibilityMeters: before.roadVisibilityMeters ?? null,
      latest: summarizeLifecycle(before.latest),
      registeredRoadRecordCount: before.registeredRoadRecordCount ?? null,
      drawableRoadRecordCount: before.drawableRoadRecordCount ?? null,
      midpointCullGapCandidateCount: before.midpointCullGapCandidateCount ?? null,
      hiddenWithinSegmentRangeCount: before.hiddenWithinSegmentRangeCount ?? null,
    },
    after: {
      player: after.player ?? null,
      roadVisibilityMeters: after.roadVisibilityMeters ?? null,
      latest: summarizeLifecycle(after.latest),
      registeredRoadRecordCount: after.registeredRoadRecordCount ?? null,
      drawableRoadRecordCount: after.drawableRoadRecordCount ?? null,
      midpointCullGapCandidateCount: after.midpointCullGapCandidateCount ?? null,
      hiddenWithinSegmentRangeCount: after.hiddenWithinSegmentRangeCount ?? null,
      recordsTruncated: after.recordsTruncated ?? null,
    },
    lifecycleHistory: relevantHistory,
    lifecycleAnalysis,
    samples,
    visibilityTransitions: transitions.slice(0, 512),
    finalMidpointCullGapCandidates: finalGapCandidates,
    finalHiddenWithinSegmentRange: finalHiddenWithinRange,
  };

  const stamp = finishedAt.replaceAll(':', '-').replaceAll('.', '-');
  const fileName = `kani-road-lifecycle-${stamp}.json`;
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
  console.info(`KaniNingen Road lifecycle capture finished: ${fileName}`, result);
  return result;
})().catch(error => {
  console.error('KaniNingen Road lifecycle capture failed.', error);
  throw error;
});
